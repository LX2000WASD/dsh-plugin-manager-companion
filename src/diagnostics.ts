/**
 * 诊断引擎 — 对本地 DSH 环境做五层只读分析（环境控制台的核心）。
 *
 * 归属：A 类·重写（旧 src/analyze.ts 只作**检测清单**意图参考，未复制任何代码）。
 * 旧实现参考：dsh-web-plugin-manager/src/analyze.ts（检测哪些问题）、
 *   src/installFlow.ts#qualityIssues（安装前质量门的检查面）。
 *   旧扫描器是"正则 + 手工剥注释"：被注释掉的 new Service(ctx, 'x') 会被算成真实注册（误报），
 *   字符串里的 from 'x' 会被算成 import，正则字面量里的双斜杠会把整行代码当注释吞掉（漏报）。
 *   本模块改为**逐字符词法扫描**：只在代码位置识别 import/export/require 关键字与调用实参，
 *   注释与字符串字面量在词法阶段就被跳过，行号由扫描器直接给出，不做事后回找。
 * 官方复用：@deepseek-ai/dsh-app-boot 的 loadProfileDirectory / composeEntries
 *   （patch 层栈与合并语义的唯一权威口径）、@deepseek-ai/dsh-host-plugin-inventory
 *   （运行时 fiber 事实，经 official.ts 的 readRuntimeInventory 降级封装）、
 *   Node 的 createRequire 真实解析（只用于判定"能解析"；判定"不能解析"走文件与 exports 探测）。
 *
 * 解析根（2026-09-19 修复的误报根因）：一个 profile 只装自己的依赖，官方包（@deepseek-ai/*）
 *   与 bundle 本体都不在 profile 的 node_modules 里，它们由**安装锚点**提供。只按
 *   profile 目录解析会把官方包的每一行都判成孤儿（实测干净环境 163 条 orphan-row 全部是误报）。
 *   因此解析根纳入 ctx.get('profileContext').installAnchor，口径与官方 profile.ts 的
 *   packageDirFromAnchor 一致：createRequire(anchor).resolve.paths(name)，先 realpath 锚点
 *   （pnpm 的 bin shim 路径不是安装目录的兄弟目录，不 realpath 会一个包都解析不到）。
 *   锚点拿不到时退回 profile 解析并在 skipped 里如实说明，绝不静默当成"包不存在"。
 * 前提检查：旧实现的前提是"官方只有只读清单，所以诊断必须自己扫 patch 文本、自己猜绑定关系"。
 *   0.1.6 之后该前提消失：官方提供 composeEntries（与 boot 同一次 applyEntryPatches 调用）与
 *   readPluginInventory。自己再实现一遍 patch 合并只会与官方漂移，因此事实来源是
 *   **官方优先、静态兜底、缺失记 skipped**，绝不假装健康。
 *
 * 五层，逐层独立可跳过（能力缺失时写入 report.skipped 并给原因）：
 *   L1 dependency  — import 图 × package.json 声明 × loader 提供项
 *   L2 composition — patch 层栈的行 id / 禁用 / 孤立行（只读，保留原始行号）
 *   L3 runtime     — loader fiber 相位 + 源码注册名冲突
 *   L4 consistency — 官方 inventory × 本地 manifest
 *   L5 ecosystem   — 市场索引（默认关闭；本模块只留最小骨架，索引归市场模块）
 *
 * 本模块不写任何文件、不调 pnpm、不注册服务。
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync, type Dirent } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { profilesRoot, readEnvironmentManifest, type EnvironmentManifest } from './paths.ts'
import { readRuntimeInventory } from './official.ts'
import type { CompanionConfig, DiagnosticsConfig } from './settings.ts'
import type {
  DiagnosticEvidence, DiagnosticFix, DiagnosticGroup, DiagnosticIssue, DiagnosticLayer, DiagnosticReport, DiagnosticScopeCount,
  DiagnosticSeverity, DiagnosticSkip, EnvironmentInfo,
} from './types.ts'

/** 传给官方装载函数（loadProfileDirectory / loadOptionalPatches）的诊断前缀。 */
const DIAG_BIN = 'dsh-plugin-manager-companion'

/** 五层的固定顺序：只在"环境级能力缺失废掉全部五层"这种跳过里用得到。 */
const ALL_LAYERS: readonly DiagnosticLayer[] = ['dependency', 'composition', 'runtime', 'consistency', 'ecosystem']

/** 单包源码扫描的硬上限（质量门要覆盖整条加载链，所以给得宽）。超出即标注 truncated。 */
const SCAN_MAX_FILES_PER_PACKAGE = 400

/** 诊断时每个包的扫描预算（比硬上限小：诊断要扫很多包，不能把响应拖到不可用）。 */
const L1_PACKAGE_FILE_BUDGET = 60

/** 相对 import 的 BFS 深度上限，防止畸形依赖图把扫描拖死。 */
const SCAN_MAX_DEPTH = 10

/** 一次诊断里所有包扫描共享的文件预算，防止几十个包把响应拖到不可用。 */
const SCAN_FILE_BUDGET = 1200

/** 依赖闭包 BFS（只读 manifest）的包数上限。 */
const CLOSURE_MAX_PACKAGES = 400

/**
 * 安装锚点 → Node 解析根（每个锚点只算一次；诊断会解析上百个说明符）。
 *
 * 锚点拿不到的包**不进**这张表，调用方据此区分"没有锚点"与"锚点里没有这个包"。
 */
const installPathCache = new Map<string, readonly string[]>()

/**
 * 官方包里允许作为**普通 dependencies** 声明的那几个。
 *
 * 理由（沿用前身仓库审计结论，此处只记录事实）：这两个包的模块身份不敏感——
 * schemastery 的校验错误走 Symbol.for('ValidationError') 全局符号，schema 本身是纯闭包；
 * cosmokit 是无模块级可变状态的工具集。其余 @deepseek-ai/* 一旦以普通依赖落进 profile，
 * pnpm 会装出第二份拷贝，loader 从 profile 目录解析官方行时就会用到它，
 * 唯一符号与类身份随之分裂，运行时报 "Cannot read properties of undefined" 这类错。
 */
export const OFFICIAL_DEP_ALLOWED: ReadonlySet<string> = new Set([
  '@deepseek-ai/schemastery',
  '@deepseek-ai/cosmokit',
])

/** loader / 平台直接提供、无需声明的精确说明符（含其子路径）。 */
const LOADER_PROVIDED_EXACT: readonly string[] = [
  'cordis',
  '@deepseek-ai/cordis',
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react-dom/client',
  '@deepseek-ai/dsh-client-web-react',
]

/** 按前缀族提供的说明符：客户端平台表与 cordis 插件族整族由平台提供。 */
const LOADER_PROVIDED_PREFIX: readonly string[] = [
  '@deepseek-ai/dsh-client-',
  '@deepseek-ai/cordis-plugin-',
]

/**
 * 说明符是否由 loader / 平台提供（不需要在包里声明）。
 * @param spec - 裸说明符。
 * @returns 是否由平台提供。
 */
export function isLoaderProvided(spec: string): boolean {
  for (const name of LOADER_PROVIDED_EXACT) {
    if (spec === name || spec.startsWith(name + '/')) return true
  }
  return LOADER_PROVIDED_PREFIX.some(prefix => spec.startsWith(prefix))
}

/**
 * 本模块会产出的修复动作标识（host 端据此分派，是闭集）。
 *
 * wire 契约见 src/types.ts 的 DiagnosticFix.action（那里是 string）；
 * host 的 switch 应当覆盖全部取值。
 */
export type DiagnosticFixAction =
  | 'remove-duplicate-row'
  | 'enable-row'
  | 'remove-official-copy'
  | 'remove-row'
  | 'install-provider'
  | 'install-dependency'
  | 'disable-row'

/** 一条依赖边：consumer 的源码 import 到了 provider。 */
interface DependencyEdge {
  readonly from: string
  readonly to: string
  readonly spec: string
  readonly file: string
  readonly line: number
}

/** 一次源码扫描给出的命名注册点。 */
export interface RegistrationHit {
  readonly name: string
  readonly file: string
  readonly line: number
}

/** import / require / re-export 的一处说明符。 */
export interface ScannedImport {
  readonly spec: string
  readonly file: string
  readonly line: number
  readonly kind: 'static' | 'dynamic' | 're-export' | 'require'
}

/** 一个包完整扫描的结果。 */
export interface PackageScan {
  readonly imports: readonly ScannedImport[]
  readonly services: readonly RegistrationHit[]
  readonly injects: readonly RegistrationHit[]
  readonly tools: readonly RegistrationHit[]
  readonly sections: readonly RegistrationHit[]
  readonly routes: readonly RegistrationHit[]
  readonly entryFiles: readonly string[]
  readonly filesScanned: number
  /** 命中上限时为 true（结果不完整，调用方必须如实标注）。 */
  readonly truncated: boolean
  /** 无法扫描时的原因（没有入口、manifest 不可读等）。 */
  readonly reason?: string
}

// ── 对外入口 ────────────────────────────────────────────────────────────

/**
 * 诊断目标环境：EnvironmentInfo 加上可选的安装锚点。
 *
 * 锚点不是"环境的事实"而是**启动这次诊断的 dsh 安装**的事实，所以调用方可以在环境对象上
 * 原样透传（EnvironmentInfo 兼容这个类型）；不传时引擎自己从 ctx.get('profileContext') 取。
 * 两种来源都没有时按"没有锚点"处理并记 skipped，绝不静默当成"包不存在"。
 */
export interface DiagnosticTargetEnvironment extends EnvironmentInfo {
  /** 启动这次诊断的 dsh 安装的 package.json 绝对路径（官方 ProfileContext.installAnchor）。 */
  readonly installAnchor?: string
}

/**
 * 对一个环境做完整诊断。
 *
 * 五层依次执行，任何一层失败只影响它自己：该层的失败原因写进 report.skipped，
 * 其余层照常产出。函数本身不抛错——诊断工具把异常抛给 UI 只能得到白屏。
 *
 * @param ctx - host 上下文；只用 ctx.get()（官方能力探测）与 ctx.logger。
 * @param env - 被诊断环境（EnvironmentInfo，来自环境列表）。
 * @param config - 本插件配置；同时接受 CompanionConfig 与单独的 diagnostics 段。
 * @returns 报告：分层问题数 + 按 code/作用域聚合的组 + 逐条问题清单 + 跳过项。
 */
export async function analyzeEnvironment(
  ctx: Context,
  env: DiagnosticTargetEnvironment,
  config: CompanionConfig | DiagnosticsConfig,
): Promise<DiagnosticReport> {
  const diagnostics = normalizeDiagnosticsConfig(config)
  const issues: DiagnosticIssue[] = []
  const skipped: DiagnosticSkip[] = []
  const usedIds = new Set<string>()

  if (!existsSync(env.dir)) {
    // 环境目录不存在：五层都没有输入（不是"查过且没问题"，每层都必须显示成没查）。
    skipped.push({
      check: 'environment-dir',
      layers: [...ALL_LAYERS],
      reason: '环境目录不存在：' + env.dir,
    })
  }

  // 解析根要安装锚点：调用方透传优先，其次问官方 profileContext（launcher 一定会提供它）。
  // 锚点的语义是"当前进程所属的 dsh 安装"（官方 ProfileContext 同理）：它的模块根排在
  // profile 自己的 node_modules **之后**，所以诊断别的 profile 时，那个 profile 装了什么
  // 仍然优先命中，锚点只补上安装侧提供的那部分（官方包、bundle 本体）。
  const installAnchor = env.installAnchor ?? readInstallAnchor(ctx)
  const facts = collectStaticFacts({ ...env, installAnchor }, diagnostics, skipped)
  const composition = await readComposition(ctx, env, facts)
  skipped.push(...composition.skips)

  let runtime: RuntimeFacts
  try {
    runtime = await readRuntimeInventory(ctx)
  } catch (error) {
    runtime = { entries: [], agentPresets: undefined, source: 'unavailable', reason: messageOf(error) }
  }
  if (runtime.source === 'unavailable') {
    // 没有 Loader：runtime 与 consistency 两层都真的没跑（两层的实现都按 source==='unavailable' 早退）。
    // 只标一层会把另一层画成 0 = "查过且没问题"，那正是这个字段要防的误读。
    skipped.push({
      check: 'runtime-inventory',
      layers: ['runtime', 'consistency'],
      reason: '运行时事实不可用（Loader 服务缺失，或官方投影与 Loader 直读都失败）：'
        + (runtime.reason ?? '原因未知'),
    })
  }

  const layers: readonly {
    readonly layer: DiagnosticLayer
    readonly run: () => DiagnosticIssue[]
  }[] = [
    { layer: 'dependency', run: () => dependencyLayer(env, facts, composition) },
    { layer: 'composition', run: () => compositionLayer(env, facts, composition, skipped) },
    { layer: 'runtime', run: () => runtimeLayer(env, facts, composition, runtime) },
    { layer: 'consistency', run: () => consistencyLayer(env, facts, composition, runtime) },
    { layer: 'ecosystem', run: () => ecosystemLayer() },
  ]

  for (const entry of layers) {
    if (!layerEnabled(diagnostics, entry.layer)) {
      skipped.push({
        check: entry.layer + '-layer',
        // 整层没查：带上层归属，UI 才能把这一格画成「没查」而不是 0。
        layers: [entry.layer],
        reason: '配置里关闭了该层（settings.diagnostics.' + entry.layer + '）',
      })
      continue
    }
    try {
      issues.push(...entry.run())
    } catch (error) {
      // 单层内部异常：如实登记为"这次没查成"，不让其余层的结论被吞掉。
      // 这同样是整层没查：layers 必须设上，否则 UI 会把它画成 0（=查过且没问题）。
      // 抛错的是这一层，就只标这一层——不替别的层下结论。
      skipped.push({
        check: entry.layer + '-layer',
        layers: [entry.layer],
        reason: '该层执行失败：' + messageOf(error),
      })
    }
  }

  // 启动阻断根因（从官方异常文本解析出来的一等公民）并入报告：
  // 它们与其余发现一起进计数、一起进分组，UI 不必再去 skip.reason 里翻长文本。
  // 去重：重复 id / 孤立行在纯文本路径下已经产出更细的 duplicate-row-id / orphan-row（带文件与行号），
  // 这里就不再把同一条事实报第二遍；没有更细版本时才由启动阻断自己出场。
  const reportedIds = new Set(issues.map(issue => issue.id))
  const coveredByRawCheck = (boot: DiagnosticIssue): boolean => {
    const id = String(boot.subjects[0] ?? '')
    return boot.code === 'boot-blocker-row'
      ? issues.some(issue => issue.code === 'duplicate-row-id' && issue.subjects.includes(id))
      : false
  }
  for (const boot of composition.bootIssues) {
    if (reportedIds.has(boot.id) || coveredByRawCheck(boot)) continue
    reportedIds.add(boot.id)
    issues.push(boot)
  }

  if (diagnostics.ecosystem && issues.every(issue => issue.layer !== 'ecosystem')) {
    skipped.push({
      check: 'ecosystem-index',
      reason: '生态层骨架：市场索引（更新可用、已知风险）由市场模块提供，本模块不做网络请求，'
        + '因此这一层当前没有可判定的事实。',
    })
  }


  // 噪声治理：同一 code 的发现按「作用域 + 严重级别」归组，让 163 条同类命中也能被人读懂。
  // 逐条发现一条不少（证据与行号仍在 issues 里），groups 只提供可折叠的计数与来源说明。
  const withIds = issues.map(issue => ({ ...issue, id: uniqueId(issue.id, usedIds) }))
  const report: DiagnosticReport = {
    environment: env.name,
    generatedAt: new Date().toISOString(),
    counts: countByLayer(issues),
    issues: withIds,
    groups: buildGroups(withIds),
    skipped,
  }
  return report
}

// 聚合组的类型是**共享契约**（src/types.ts 的 DiagnosticGroup）：客户端要按它折叠，
// 所以它必须与报告一起上线。这里只做再导出，保持本模块公开面不变。
export type { DiagnosticGroup } from './types.ts'

/**
 * 组键：层级 + 类别 + 严重级别 + 作用域（同一个 code 落在不同包里是不同的问题）。
 * @param issue - 一条发现。
 * @returns 稳定组键。
 */
export function groupKeyOf(issue: DiagnosticIssue): string {
  const scope = (issue as { readonly scope?: string }).scope ?? '(no-scope)'
  return issue.layer + ':' + issue.code + ':' + issue.severity + ':' + scope
}

/**
 * 按组键聚合发现；组按问题数降序、同数按组键升序，结果确定性可测。
 * @param issues - 逐条发现（在报告里已带唯一 id）。
 * @returns 组列表；每组给出计数、归属包计数与样例标题。
 */
export function buildGroups(issues: readonly DiagnosticIssue[]): DiagnosticGroup[] {
  const buckets = new Map<string, DiagnosticIssue[]>()
  for (const issue of issues) {
    const key = groupKeyOf(issue)
    const list = buckets.get(key) ?? []
    list.push(issue)
    buckets.set(key, list)
  }
  const groups: DiagnosticGroup[] = []
  for (const [key, list] of buckets) {
    const first = list[0]
    if (first === undefined) continue
    const counters = new Map<string, number>()
    for (const issue of list) {
      const scope = (issue as { readonly scope?: string }).scope
      if (scope === undefined) continue
      counters.set(scope, (counters.get(scope) ?? 0) + 1)
    }
    groups.push({
      key,
      layer: first.layer,
      code: first.code,
      severity: first.severity,
      count: list.length,
      scopes: [...counters].map(([scope, count]) => ({ scope, count })),
      subjects: [...new Set(list.flatMap(issue => issue.subjects))].slice(0, 50),
      ...(first.title.length > 0 ? { exampleTitle: first.title } : {}),
    })
  }
  groups.sort((left, right) => right.count - left.count || left.key.localeCompare(right.key))
  return groups
}

/**
 * 官方 ProfileContext 的安装锚点（launcher 之外的上下文没有它）。
 * @param ctx - host 上下文。
 * @returns package.json 绝对路径；拿不到时 undefined。
 */
export function readInstallAnchor(ctx: Context): string | undefined {
  try {
    const profileContext = ctx.get('profileContext') as { readonly installAnchor?: string } | undefined
    const anchor = profileContext?.installAnchor
    return typeof anchor === 'string' && anchor.length > 0 ? anchor : undefined
  } catch {
    // ctx.get 在服务缺失时可能抛错：拿不到锚点按 undefined 处理，由调用方记 skipped。
    return undefined
  }
}

/**
 * 这份 manifest 里有哪些派生字段读不出来（按字段表达，闭集见 types.ts 的 ManifestField）。
 *
 * 存在的理由：官方若改了 dsh.profile.bundles 的名字/位置，或把 dependencies 写成数组
 * （Object.keys(['a']) === ['0']，会读出一个名叫 "0" 的依赖），读取器读出来都是空值。
 * 若不作声，诊断会把"我不知道"说成"这个环境没有层栈 / 没有依赖"——典型的假阴性。
 * 放在组合层：受影响的正是"层栈相关"的结论（bundle 声明、层栈与运行时对照），
 * 依赖层与运行时层照常出结论，不会因此被连带跳过。
 *
 * @param facts - 静态事实（含 manifest）。
 * @returns 一条跳过项；manifest 全部读得出来时 undefined。
 */
function manifestUnknownSkip(facts: StaticFacts): DiagnosticSkip | undefined {
  const manifest = facts.manifest
  const fields = manifest.unknownFields ?? []
  if (fields.length === 0) return undefined
  return {
    check: 'manifest-unknown',
    reason: '这个环境的 package.json 有读不出来的字段（' + fields.join('、') + '）：'
      + (manifest.unknownReason ?? '原因未知')
      + '。与这些字段相关的结论（bundle 声明、层栈与运行时对照、依赖清单对照）本次**没有判断**，'
      + '不要把它们当成"确实为空"。'
  }
}

/** 该层是否被配置启用。 */
function layerEnabled(config: DiagnosticsConfig, layer: DiagnosticLayer): boolean {
  return config[layer] !== false
}

/** 把 CompanionConfig 与单独的 DiagnosticsConfig 归一为同一份诊断配置。 */
function normalizeDiagnosticsConfig(config: CompanionConfig | DiagnosticsConfig): DiagnosticsConfig {
  return (config as Partial<CompanionConfig>).diagnostics ?? (config as DiagnosticsConfig)
}

/** 分层计数。 */
function countByLayer(issues: readonly DiagnosticIssue[]): Readonly<Record<DiagnosticLayer, number>> {
  const counts: Record<DiagnosticLayer, number> = {
    dependency: 0, composition: 0, runtime: 0, consistency: 0, ecosystem: 0,
  }
  for (const issue of issues) counts[issue.layer] += 1
  return counts
}

/** 报告内唯一 id：同码同主体的发现按出现顺序加后缀。 */
function uniqueId(candidate: string, used: Set<string>): string {
  if (!used.has(candidate)) {
    used.add(candidate)
    return candidate
  }
  let index = 2
  while (used.has(candidate + '#' + index)) index += 1
  const id = candidate + '#' + index
  used.add(id)
  return id
}

// ── 共享静态事实 ────────────────────────────────────────────────────────

/** 诊断期间共享的静态事实（一次收集，五层共用；避免同一份文件被反复扫描）。 */
interface StaticFacts {
  readonly envDir: string
  readonly manifest: EnvironmentManifest
  readonly profileModules: string
  readonly fallbackModules: string
  readonly profileNames: ReadonlySet<string>
  readonly fallbackNames: ReadonlySet<string>
  /** 包名 → 已安装目录（profile 层优先，其次共享兜底层）。 */
  readonly packageDirs: ReadonlyMap<string, string>
  /** 包名 → 扫描结果（只含被扫描到的包）。 */
  readonly scans: ReadonlyMap<string, PackageScan>
  /** 包名 → 自身 manifest。 */
  readonly manifests: ReadonlyMap<string, Record<string, unknown>>
  readonly edges: readonly DependencyEdge[]
  /** 启动这个环境的 dsh 安装锚点（package.json 绝对路径）；launcher 未提供时省略。 */
  readonly installAnchor?: string
  /** 解析得到的安装侧 node_modules 根（锚点不可用或解析不到时为 null）。 */
  readonly installRoots: readonly string[] | null
  /** 因预算或上限未扫描的包名。 */
  readonly unscanned: readonly string[]
}

/** 收集静态事实：manifest、两层 node_modules、包扫描、依赖边。 */
function collectStaticFacts(
  env: DiagnosticTargetEnvironment,
  config: DiagnosticsConfig,
  skipped: DiagnosticSkip[],
): StaticFacts {
  const envDir = env.dir
  const manifest = readEnvironmentManifest(envDir)
  const profileModules = join(envDir, 'node_modules')
  const fallbackModules = join(dirname(resolve(envDir)), 'node_modules')
  const profileNames = listInstalledNames(profileModules)
  const fallbackNames = fallbackModules === profileModules
    ? new Set<string>()
    : listInstalledNames(fallbackModules)

  // 解析根 = profile 层 + 共享兜底层 + **安装锚点**（官方包由安装侧提供，profile 里没有它们）。
  const installRoots = installAnchorRoots(env.installAnchor)
  if (installRoots === null) {
    skipped.push({
      check: 'install-anchor',
      reason: env.installAnchor === undefined
        ? '没有安装锚点（launcher 的 profileContext 不可用，环境对象也没带 installAnchor）：'
          + '本次只按 profile 与共享兜底层解析，由安装侧提供的官方包会被判成不存在——'
          + '这类结论不可信，别拿它当缺包证据。'
        : '启动这个环境的 dsh 安装锚点读不到或解析不出模块根（' + env.installAnchor + '）：'
          + '本次只按 profile 与共享兜底层解析，由安装侧提供的官方包会被判成不存在。',
    })
  }
  const roots = moduleRoots(envDir, env.installAnchor)
  const declared = [...new Set([...manifest.dependencies, ...manifest.bundles])]
  const packageDirs = new Map<string, string>()
  const manifests = new Map<string, Record<string, unknown>>()
  for (const name of declared) {
    const dir = findInstalledDir(roots, name)
    if (dir === undefined) continue
    packageDirs.set(name, dir)
    const raw = readJsonFile(join(dir, 'package.json'))
    if (raw !== undefined) manifests.set(name, raw)
  }

  const scans = new Map<string, PackageScan>()
  const unscanned: string[] = []
  // 源码扫描只服务这三层；三层都关掉时不做任何文件读取（省一次无意义的全量扫描）。
  const scanning = config.dependency || config.runtime || config.consistency
  let budget = SCAN_FILE_BUDGET
  for (const [name, dir] of scanning ? packageDirs : []) {
    // 官方本体（非 profile 本地拷贝）由安装方维护，逐文件扫描它们的成本远大于收益：
    // 只扫 profile 自己装进来的包，以及官方 scope 的 profile 本地拷贝（重复安装已在 L1 报出）。
    if (name.startsWith('@deepseek-ai/') && !profileNames.has(name)) continue
    const scan = scanPackage(dir, manifests.get(name) ?? {}, Math.min(budget, L1_PACKAGE_FILE_BUDGET))
    budget -= scan.filesScanned
    scans.set(name, scan)
    if (budget <= 0) {
      unscanned.push(...[...packageDirs.keys()].filter(candidate => !scans.has(candidate)))
      break
    }
  }
  if (unscanned.length > 0) {
    skipped.push({
      check: 'dependency-scan',
      reason: '源码扫描预算（共 ' + SCAN_FILE_BUDGET + ' 个文件）用尽，以下包只做了 manifest 级检查：'
        + unscanned.join('、'),
    })
  }

  const edges: DependencyEdge[] = []
  for (const [from, scan] of scans) {
    for (const hit of scan.imports) {
      const provider = providerOf(hit.spec, packageDirs)
      if (provider === undefined || provider === from) continue
      edges.push({ from, to: provider, spec: hit.spec, file: hit.file, line: hit.line })
    }
  }

  return {
    envDir, manifest, profileModules, fallbackModules, profileNames, fallbackNames,
    installAnchor: env.installAnchor, installRoots,
    packageDirs, scans, manifests, edges, unscanned,
  }
}

// ── L1 依赖层 ───────────────────────────────────────────────────────────

/** L1：import 图 × 声明 × loader 提供项。 */
function dependencyLayer(
  env: EnvironmentInfo,
  facts: StaticFacts,
  composition: CompositionFacts,
): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = []
  const envDir = facts.envDir
  const manifestPath = join(envDir, 'package.json')
  const manifestText = readTextFile(manifestPath)

  if (facts.manifest.broken !== undefined) {
    issues.push(makeIssue({
      layer: 'dependency',
      severity: 'report-only',
      code: 'broken-manifest',
      title: '环境 manifest 无法解析',
      detail: '该环境的 package.json 读取失败（' + facts.manifest.broken + '），'
        + '依赖声明全部读不到：以它启动的 profile 会在 boot 阶段直接失败。',
      subjects: [env.name],
      scope: env.name.length > 0 ? env.name : undefined,
      evidence: [{ kind: 'file', at: 'package.json', note: '解析失败的 manifest' }],
      id: 'broken-manifest',
    }))
  }

  // official-duplicate：官方包同时存在于 profile 层与共享兜底层。
  for (const name of facts.profileNames) {
    if (!name.startsWith('@deepseek-ai/')) continue
    if (!facts.fallbackNames.has(name)) continue
    if (OFFICIAL_DEP_ALLOWED.has(name)) continue
    const owners = [
      ...(declaresRegularDependency(facts.manifest.raw, name)
        ? [env.name + '（环境自身的 package.json）']
        : []),
      ...[...facts.manifests.entries()]
        .filter(([, manifest]) => declaresRegularDependency(manifest, name))
        .map(([owner]) => owner),
    ]
    issues.push(makeIssue({
      layer: 'dependency',
      severity: 'safe-fix',
      code: 'official-duplicate',
      title: '官方包 ' + name + ' 在 profile 里多出一份拷贝',
      detail: name + ' 同时存在于 ' + facts.profileModules + ' 与 ' + facts.fallbackModules + '（安装兜底层）。'
        + (owners.length > 0 ? '它被 ' + owners.join('、') + ' 声明为普通依赖，pnpm 因此装出了第二份。' : '')
        + 'loader 从 profile 目录解析官方行时会用到这一份，模块身份（唯一符号与类）与安装侧分裂，'
        + '运行时报 "Cannot read properties of undefined" 这类错。正确做法是改成 peerDependencies'
        + '（peer 由共享兜底层满足），并删掉 profile 里的这份拷贝。',
      subjects: [name, ...owners],
      scope: name,
      evidence: [
        {
          kind: 'file',
          at: relativeTo(envDir, join(facts.profileModules, name, 'package.json')),
          note: 'profile 层的拷贝',
        },
        {
          kind: 'file',
          at: relativeTo(envDir, join(facts.fallbackModules, name, 'package.json')),
          note: '共享兜底层的同一包',
        },
      ],
      fix: {
        action: 'remove-official-copy',
        target: name,
        summary: '从 profile 移除重复的官方包拷贝 ' + name + '，并把声明改为 peerDependencies',
      },
      id: 'official-duplicate:' + name,
    }))
  }

  for (const name of [...new Set([...facts.manifest.dependencies, ...facts.manifest.bundles])]) {
    const dir = facts.packageDirs.get(name)
    if (dir === undefined) {
      const line = manifestText === undefined ? undefined : jsonKeyLine(manifestText, 'dependencies', name)
      issues.push(makeIssue({
        layer: 'dependency',
        severity: 'confirm-fix',
        code: 'undeclared-dependency',
        title: '声明了但没装：' + name,
        detail: 'package.json 声明了 ' + name + '，但 profile 的 node_modules 与共享兜底层都找不到它。'
          + '任何 import 它的行都会在启动时 ERR_MODULE_NOT_FOUND，并带走整个 profile。',
        subjects: [name],
        scope: name,
        evidence: [{
          kind: 'file',
          at: line === undefined ? 'package.json' : 'package.json:' + line,
          note: '声明位置',
        }],
        fix: {
          action: 'install-dependency',
          target: name,
          summary: '重新安装 ' + name + '（走官方安装通道），或从 package.json 删掉这条声明',
        },
        id: 'undeclared-dependency:' + name,
      }))
      continue
    }
    const scan = facts.scans.get(name)
    if (scan === undefined || scan.reason !== undefined) continue
    const manifest = facts.manifests.get(name) ?? {}
    for (const hit of scan.imports) {
      const spec = hit.spec
      if (isBuiltin(spec) || isLoaderProvided(spec) || spec.startsWith('cordis:')) continue
      if (declaresSpecifier(manifest, spec, name)) continue
      const provider = providerOf(spec, facts.packageDirs)
      const at = relativeTo(envDir, hit.file) + ':' + hit.line
      if (provider === undefined) {
        issues.push(makeIssue({
          layer: 'dependency',
          severity: 'confirm-fix',
          code: 'missing-import',
          title: name + ' 导入了未声明的 ' + spec + '，且环境里没有提供者',
          detail: name + ' 在 ' + at + ' 导入 ' + spec + '，但它既没有在该包的 dependencies/peerDependencies 里声明，'
            + 'profile 里也没有任何包提供它。这一行在挂载时必然 ERR_MODULE_NOT_FOUND。'
            + unmountedNote(composition, name),
          subjects: [name, spec],
          scope: name,
          evidence: [{ kind: 'file', at, note: '缺失的 import 位置' }],
          fix: {
            action: 'install-provider',
            target: spec,
            summary: '安装并提供 ' + spec + '，或移除 ' + at + ' 的这处 import',
          },
          id: 'missing-import:' + name + '>' + spec,
        }))
      } else {
        issues.push(makeIssue({
          layer: 'dependency',
          severity: 'report-only',
          code: 'implicit-dependency',
          title: name + ' 使用了未声明的 ' + spec,
          detail: name + ' 在 ' + at + ' 导入 ' + spec + '：它没有声明该依赖，但 ' + provider
            + ' 恰好装在环境里（传递依赖或 hoisted 布局）。这种"能跑但没写清楚"的依赖会在依赖树变化时突然炸掉。',
          subjects: [name, spec, provider],
          scope: name,
          evidence: [{ kind: 'file', at, note: '未声明的 import 位置' }],
          id: 'implicit-dependency:' + name + '>' + spec,
        }))
      }
    }
    issues.push(...peerIssues(name, manifest, facts))
  }
  return issues
}

/** 一个包的 peerDependencies 与本环境实际安装版本的对照。 */
function peerIssues(name: string, manifest: Record<string, unknown>, facts: StaticFacts): DiagnosticIssue[] {
  const peers = asRecord(manifest['peerDependencies'])
  if (peers === undefined) return []
  const issues: DiagnosticIssue[] = []
  const dir = facts.packageDirs.get(name)
  const manifestPath = dir === undefined ? name : relativeTo(facts.envDir, join(dir, 'package.json'))
  const text = dir === undefined ? undefined : readTextFile(join(dir, 'package.json'))
  for (const [peer, range] of Object.entries(peers)) {
    if (typeof range !== 'string') continue
    const line = text === undefined ? undefined : jsonKeyLine(text, 'peerDependencies', peer)
    const at = line === undefined ? manifestPath : manifestPath + ':' + line
    const peerDir = findInstalledDir(moduleRoots(facts.envDir, facts.installAnchor), peer)
    if (peerDir === undefined) {
      issues.push(makeIssue({
        layer: 'dependency',
        severity: 'report-only',
        code: 'missing-peer',
        title: name + ' 的 peer ' + peer + ' 未安装',
        detail: name + ' 声明 peerDependencies.' + peer + '，但环境里找不到它。'
          + 'peer 由共享兜底层满足，缺失时该包的运行期契约无法保证。',
        subjects: [name, peer],
        scope: name,
        evidence: [{ kind: 'file', at, note: 'peer 声明位置' }],
        id: 'missing-peer:' + name + '>' + peer,
      }))
      continue
    }
    const peerManifest = readJsonFile(join(peerDir, 'package.json'))
    const version = typeof peerManifest?.['version'] === 'string' ? peerManifest['version'] : undefined
    if (version === undefined) continue
    if (satisfiesRange(version, range)) continue
    issues.push(makeIssue({
      layer: 'dependency',
      severity: 'report-only',
      code: 'peer-mismatch',
      title: name + ' 要求 ' + peer + ' ' + range + '，实际装的 ' + version + ' 不满足',
      detail: 'peerDependencies 是运行期契约：版本不满足时官方契约可能已经变化，'
        + '失败点会出现在很远处（序列化、协议、单例假设）。此处只报告，不自动处理。',
      subjects: [name, peer],
      scope: name,
      evidence: [{ kind: 'file', at, note: 'peer 声明的来源包' }],
      id: 'peer-mismatch:' + name + '>' + peer,
    }))
  }
  return issues
}

/** 该包当前有没有启用中的 loader 行（用于降低"未挂载包"结论的紧迫度）。 */
function unmountedNote(composition: CompositionFacts, packageName: string): string {
  if (composition.rows.length === 0) return ''
  const rows = composition.rows.filter(row => packageNameOf(row.name) === packageName)
  if (rows.length === 0) return '（该包当前没有任何 loader 行，问题会在它被挂载后才暴露。）'
  if (rows.every(row => !row.enabled)) return '（该包当前的行都被禁用，问题会在重新启用后暴露。）'
  return ''
}

// ── L2 组合层 ───────────────────────────────────────────────────────────

/** patch 文件里一行的原始事实（行号只有读原始文本时才有）。 */
interface RawRow {
  readonly file: string
  readonly line: number
  readonly id?: string
  readonly name?: string
  /** 字面量 disabled 状态；条件表达式记 conditional（静态不可判定）。 */
  readonly disabled: 'true' | 'false' | 'conditional'
  /** 该行插入到哪个 group id 下（顶层 insert 为 undefined）。 */
  readonly group?: string
}

/** 官方合并后的一个 loader 行。 */
interface ComposedRow {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  readonly conditional: boolean
}

/**
 * 一条"启动阻断"的根因（从官方异常的原始文本里解析出来）。
 *
 * 为什么要有它：官方 loadProfileDirectory / composeEntries 抛出的异常文本本身就含根因
 * （如 cannot resolve profile bundle …、duplicate loader entry id: …），塞进 skip.reason 时
 * 界面只看到一段长文本；解析出来成为一条正式 issue 才能带三要素、走证据通道、被 UI 折叠。
 */
interface BootBlocker {
  readonly code: string
  /** 判定的严重级别：确实致命给 confirm-fix；判不定（例如锚点缺失）如实降级。 */
  readonly severity: DiagnosticSeverity
  readonly title: string
  readonly subjects: readonly string[]
  readonly evidence: readonly DiagnosticEvidence[]
  readonly detail: string
  /** 可复制的操作文本（与 issue.extra.operation 同口径）。 */
  readonly operation: string
  readonly id: string
}

/**
 * 从官方异常的原始文本里解析启动阻断根因（认不出就返回 undefined，不猜）。
 *
 * @param error - loadProfileDirectory / composeEntries 抛出的异常。
 * @param env - 被诊断环境。
 * @param anchorConsulted - 本次解析是否真的用过安装锚点（决定"解析不到"能不能断言致命）。
 * @returns 阻断根因；异常文本不是这两种时 undefined。
 */
function bootBlockerFromError(
  error: unknown,
  env: EnvironmentInfo,
  anchorConsulted: boolean,
): BootBlocker | undefined {
  const message = messageOf(error)
  const unresolved = /cannot resolve profile bundle\s+("[^"]+"|'[^']+')/.exec(message)
  const malformed = /profile bundle\s+("[^"]+"|'[^']+')\s+declares no dsh\.bundle/.exec(message)
  const restarted = '装好（或修好这一项）后**重启该环境**才会生效。'
  const unsure = '注意：本次解析**没有**用到安装锚点（拿不到或没给），所以本条只说明"这个 bundles 项装不上"，'
    + '不能据此断言这次启动一定失败——环境可能由别的 dsh 安装提供该包。'
  if (unresolved !== null) {
    const name = stripQuotes(unresolved[1] ?? '')
    return {
      code: 'unresolvable-bundle',
      severity: anchorConsulted ? 'confirm-fix' : 'report-only',
      title: '组合层启动被阻断：bundle ' + name + ' 解析不到',
      subjects: [name, env.name],
      evidence: [{ kind: 'official', at: 'loadProfileDirectory(env.dir)', note: truncatedNote(message) }],
      detail: 'dsh.profile.bundles 里的 ' + name + ' 既不在这个 profile 的 node_modules，也不在 dsh 安装的模块兜底层：'
        + '官方启动路径读 bundles 层栈时会直接抛 cannot resolve profile bundle，'
        + '**整个 profile 起不来**（不是某一层没查）。处置：装回这个 bundle（官方通道）或从 '
        + absoluteManifestPath(env) + ' 的 dsh.profile.bundles 里删掉这一项；' + restarted
        + (anchorConsulted ? '' : unsure),
      operation: '在 ' + absoluteManifestPath(env) + ' 的 dsh.profile.bundles 里装回 ' + name
        + '（或删掉这一项），然后重启该环境',
      id: 'unresolvable-bundle:' + name,
    }
  }
  if (malformed !== null) {
    const name = stripQuotes(malformed[1] ?? '')
    return {
      code: 'invalid-bundle',
      severity: 'confirm-fix',
      title: '组合层启动被阻断：bundle ' + name + ' 没有声明 patch 层',
      subjects: [name, env.name],
      evidence: [{ kind: 'official', at: 'loadProfileDirectory(env.dir)', note: truncatedNote(message) }],
      detail: 'dsh.profile.bundles 里的 ' + name + ' 的 package.json 没有 dsh.bundle.patch：'
        + '官方读这一层 patch 时会直接抛 declares no dsh.bundle，**整个 profile 起不来**。'
        + '处置：把 ' + absoluteManifestPath(env) + ' 的 dsh.profile.bundles 里这一项删掉，或改用真正带 bundle 声明的包；'
        + restarted,
      operation: '从 ' + absoluteManifestPath(env) + ' 的 dsh.profile.bundles 里删掉 ' + name + '，然后重启该环境',
      id: 'invalid-bundle:' + name,
    }
  }
  return undefined
}

/** 去掉异常文本里包裹包名的引号。 */
function stripQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1)
  }
  return trimmed
}

/** 环境 manifest 的绝对路径（证据里说明"改哪个文件"）。 */
function absoluteManifestPath(env: EnvironmentInfo): string {
  return join(env.dir, 'package.json')
}

/** 官方异常文本放进证据 note 时截断（证据要能读，不是把异常整段塞进去）。 */
function truncatedNote(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim()
  return flat.length > 240 ? flat.slice(0, 237) + '…' : flat
}
/** 组合层事实：官方合并结果 + 原始行号。 */
interface CompositionFacts {
  readonly rows: readonly ComposedRow[]
  readonly rawRows: readonly RawRow[]
  readonly skips: readonly DiagnosticSkip[]
  /** 官方组合口径抛出的启动阻断根因（解析后成为正式 issue；认不出时为空）。 */
  readonly bootIssues: readonly DiagnosticIssue[]
  /** 有效禁用状态是否可用（官方 app-boot 不可用时为 false）。 */
  readonly effectiveState: boolean
}

/**
 * 读组合层输入。
 *
 * 两个来源，各司其职：
 *  1. 官方 app-boot 的 loadProfileDirectory + composeEntries —— **有效**行集合与启停状态
 *     （最后一层写入胜出），这是 boot 真正挂载的东西，绝不由本模块重算；
 *  2. 直接读原始 patch 文本 —— 只为拿行号（官方返回值不带位置）与"行有没有写显式 id"。
 * 官方不可用时降级：纯文本能做的检查（重复 id、无 id、孤立行）照做，
 * 依赖有效禁用状态的检查记 skipped。
 */
async function readComposition(
  ctx: Context,
  env: EnvironmentInfo,
  facts: StaticFacts,
): Promise<CompositionFacts> {
  const skips: DiagnosticSkip[] = []
  const patchPath = join(env.dir, 'cordis.patch.yml')
  // 锚点只有一份来源：facts.installAnchor（analyzeEnvironment 已经按"调用方透传优先、其次官方
  // profileContext"算好了）。这里若自己再算一份，两处口径一旦不一致，"锚点是否参与过解析"
  // 这个判据就会失真，把致命判成不确定。
  const installAnchor = facts.installAnchor
  const rawRows: RawRow[] = []
  const bootIssues: DiagnosticIssue[] = []
  let layers: { readonly path: string; readonly patches: readonly unknown[] }[] | undefined
  let rows: readonly ComposedRow[] | undefined

  try {
    const boot = await import('@deepseek-ai/dsh-app-boot')
    const profile = boot.loadProfileDirectory(
      DIAG_BIN, env.dir, installAnchor ?? join(env.dir, 'package.json'), { userLayer: true },
    )
    layers = [
      ...profile.layers.map(layer => ({ path: layer.patchPath, patches: layer.patches as readonly unknown[] })),
      ...(profile.patches.length > 0
        ? [{ path: profile.patchPath, patches: profile.patches as readonly unknown[] }]
        : []),
    ]
    rows = boot.composeEntries([
      ...profile.layers.map(layer => layer.patches),
      ...(profile.patches.length > 0 ? [profile.patches] : []),
    ])
      .filter(entry => entry.group !== true)
      .map(entry => ({
        id: String(entry.id ?? ''),
        name: String(entry.name ?? ''),
        ...enablementOf(entry.disabled),
      }))
  } catch (error) {
    // 异常文本里可能就写着启动阻断的根因：解析出来成为一等公民 issue，而不是只留一段 skip.reason。
    // anchorConsulted 的判据：本次解析真的用到了安装锚点（没用到时不能断言"这次启动一定失败"）。
    const anchorConsulted = facts.installRoots !== null && installAnchor !== undefined
    const blocker = bootBlockerFromError(error, env, anchorConsulted)
    if (blocker !== undefined) bootIssues.push(toBootIssue(blocker))
    skips.push({
      check: 'composition-official',
      // 官方合成抛错 = 组合层这一次真的没查成（纯文本检查只是兜底的一部分），
      // 层计数格必须显示"没查"而不是 0——不然与"查过且干净"长得一样。
      layers: ['composition'],
      reason: '官方组合口径（dsh-app-boot 的 loadProfileDirectory/composeEntries）不可用，'
        + '只做纯文本检查，依赖禁用状态的检查已跳过：' + messageOf(error),
    })
  }

  const rawPaths = new Set<string>([patchPath, ...(layers ?? []).map(layer => layer.path)])
  if (layers === undefined) {
    for (const path of bundlePatchFiles(facts, env.dir)) rawPaths.add(path)
  }
  for (const path of rawPaths) {
    if (!existsSync(path)) continue
    rawRows.push(...locatePatchRows(path))
  }

  if (rows !== undefined) {
    // 合成路径同样可能带出启动阻断（同一 insert 列表内重复 id）。
    const composedBlocker = duplicateIdBootIssue(rows, env)
    if (composedBlocker !== undefined) bootIssues.push(composedBlocker)
  }

  return { rows: rows ?? [], rawRows, skips, bootIssues, effectiveState: rows !== undefined }
}

/** 把官方 disabled 值翻译成启停状态；条件表达式静态不可判定。 */
function enablementOf(disabled: unknown): { enabled: boolean; conditional: boolean } {
  if (disabled === true) return { enabled: false, conditional: false }
  if (isJsExpression(disabled)) return { enabled: true, conditional: true }
  return { enabled: true, conditional: false }
}

/** 官方 yaml 的条件节点（结构化克隆后仍是带 __jsExpr 的普通对象）。 */
function isJsExpression(value: unknown): boolean {
  return typeof value === 'object' && value !== null && '__jsExpr' in (value as Record<string, unknown>)
}

/** 从 profile 的 bundles 列表解析每个 bundle 的 patch 文件路径（只读兜底路径）。 */
function bundlePatchFiles(facts: StaticFacts, envDir: string): string[] {
  const files: string[] = []
  for (const bundle of facts.manifest.bundles) {
    const dir = facts.packageDirs.get(bundle)
      ?? findInstalledDir(moduleRoots(envDir, facts.installAnchor), bundle)
    if (dir === undefined) continue
    const manifest = facts.manifests.get(bundle) ?? readJsonFile(join(dir, 'package.json'))
    const declared = asRecord(asRecord(manifest?.['dsh'])?.['bundle'])?.['patch']
    if (typeof declared !== 'string') continue
    files.push(join(dir, declared))
  }
  return files
}

/**
 * 非致命但仍存在的 id 重名：同一个 id 出现在**不同的顶层 group 或不同 patch 文件**里。
 *
 * 实测（本机 0.1.6-alpha.2）：两处都启用时 profile 照常启动——官方 loader 的重复检查是
 * per-group 的（Group.update() 只扫自己那一份 insert 列表）。但按 id 定位的东西（官方启停开关、
 * 逐行配置、我们的 fix target）都会指向其中一行，另一行不可达，所以如实报、给建议，不给修复动作。
 *
 * @param env - 被诊断环境。
 * @param rows - 同一个 id 的全部原始行（按文件顺序、按列表分组后仍多于一处）。
 * @param facts - 静态事实（判断 patch 归属走哪条处置通道）。
 * @returns 一条 report-only 发现。
 */
function crossGroupDuplicateIssue(
  env: EnvironmentInfo,
  rows: readonly RawRow[],
  facts: StaticFacts,
): DiagnosticIssue {
  const id = rows[0]?.id ?? ''
  const places = [...new Set(rows.map(row => relativeTo(env.dir, row.file) + ':' + row.line))]
  const first = rows[0]
  return makeIssue({
    layer: 'composition',
    severity: 'report-only',
    code: 'duplicate-row-id-across-groups',
    title: '同一个行 id 出现在不同的 insert 列表里：' + id,
    detail: 'id ' + id + ' 在 ' + places.join('、') + ' 各出现一次，但它们不在同一个 insert 列表里，'
      + '因此不会触发官方 loader 的 duplicate loader entry id 检查——实测这种组合 profile 能正常启动。'
      + '仍然建议改掉：按 id 定位的操作（官方启停开关、逐行配置）只能命中其中一行，另一行不可达。'
      + '修法：给其中一行换一个 id，或删掉不再需要的那一行。'
      + (first === undefined ? '' : manualEditSteps(env, first, id, facts.packageDirs, true, 'either')),
    subjects: [id],
    scope: scopeOfPatchFile(env.name, env.dir, rows[0]?.file),
    evidence: rows.map(row => ({
      kind: 'file' as const,
      at: relativeTo(env.dir, row.file) + ':' + row.line,
      note: '第 ' + (rows.indexOf(row) + 1) + ' 处（name=' + (row.name ?? '未命名') + '）',
    })),
    id: 'duplicate-row-id-across-groups:' + id,
  })
}

/** L2：行 id 重复、被禁用依赖、孤立行、无显式 id 的行。 */
function compositionLayer(
  env: EnvironmentInfo,
  facts: StaticFacts,
  composition: CompositionFacts,
  skipped: DiagnosticSkip[],
): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = []
  // 输入事实先说清：manifest 读不懂时，"层栈为空"不是结论而是未知。
  const manifestUnknown = manifestUnknownSkip(facts)
  if (manifestUnknown !== undefined) skipped.push(manifestUnknown)

  // 1. duplicate-row-id：**同一个 insert 列表**里同一个显式 id 出现多次。
  //    官方 loader 的 Group.update() 只对自己那一份 insert 列表查重，命中即抛
  //    TypeError(duplicate loader entry id)，整个 profile 起不来（真机实测：exit=1，
  //    服务器从未开始监听）。所以判定的分组口径必须与那条 insert 列表对齐：按
  //    **patch 文件 + 顶层 group** 分组；把不同文件、不同 group 的同名行并成一组会误判为致命
  //    ——实测那种组合能正常启动，走 crossGroupDuplicateIssue 如实报。
  const byList = new Map<string, RawRow[]>()
  for (const row of composition.rawRows) {
    if (row.id === undefined) continue
    const key = row.file + '|' + (row.group ?? '') + '|' + row.id
    const list = byList.get(key) ?? []
    list.push(row)
    byList.set(key, list)
  }
  // 同一个 id **跨多个 insert 列表**：单独如实报（非致命，见 crossGroupDuplicateIssue）。
  //    只报跨列表的那种：同一个列表里的重复已经在下面按致命处理，两个都报会把一条问题说成两条。
  const spread = new Map<string, RawRow[][]>()
  for (const rows of byList.values()) {
    const id = rows[0]?.id ?? ''
    const lists = spread.get(id) ?? []
    lists.push([...rows])
    spread.set(id, lists)
  }
  for (const lists of spread.values()) {
    if (lists.length < 2) continue
    issues.push(crossGroupDuplicateIssue(env, lists.flat(), facts))
  }
  for (const rows of byList.values()) {
    if (rows.length < 2) continue
    const id = rows[0]?.id ?? ''
    const group = rows[0]?.group
    const first = rows[0]
    if (first === undefined) continue
    issues.push(makeIssue({
      layer: 'composition',
      // 不是 safe-fix：这条没有可自动执行的动作（我们不代写 patch），必须用户自己确认后再动手。
      severity: 'confirm-fix',
      code: 'duplicate-row-id',
      title: 'loader 行 id 重复：' + id,
      detail: 'id ' + id + ' 在' + (group === undefined ? '同一个 insert 列表里' : ' group ' + group + ' 下')
        + '出现了 ' + rows.length + ' 次，而官方 loader 的重复检查正是按这份 insert 列表做的：'
        + '挂载这一层时直接抛 TypeError（duplicate loader entry id: ' + id + '），'
        + '**整个 profile 起不来**——不是这一行加载失败，而是启动阶段就停在 plugin tree failed to load，'
        + 'HTTP 服务从未开始监听。保留第一处、删掉其余 ' + (rows.length - 1) + ' 处重复行即可恢复。'
        + manualEditSteps(env, first, id, facts.packageDirs, rowReachedComposition(composition, first)),
      subjects: [id, ...(group === undefined ? [] : [group])],
      extra: {
        operation: '删除 ' + relativeTo(env.dir, first.file) + ' 第 ' + first.line + ' 行起的 id=' + id
          + ' 的重复 insert 行，只保留第一处，然后重启该环境',
      },
      scope: scopeOfPatchFile(env.name, env.dir, rows[0]?.file),
      evidence: [
        ...rows.map((row, index) => ({
          kind: 'file' as const,
          at: relativeTo(env.dir, row.file) + ':' + row.line,
          note: '第 ' + (index + 1) + ' 次出现（name=' + (row.name ?? '未命名') + '）',
        })),
        {
          kind: 'official' as const,
          at: 'loader entry id "' + id + '"',
          note: '@deepseek-ai/cordis-plugin-loader 的 Group.update() 对同组重复 id 抛 TypeError，profile 启动失败',
        },
      ],
      fix: {
        action: 'remove-duplicate-row',
        target: id,
        summary: '这一层会让整个 profile 起不来；请手工保留第一处 id=' + id + '（'
          + first.file + ':' + first.line + '），删除其余 ' + (rows.length - 1)
          + ' 处后重启该环境（我们不代写 patch 文件）',
      },
      id: 'duplicate-row-id:' + id,
    }))
  }

  // 2. unaddressable-row：insert 行没写显式 id。
  //    loader 的 EntryTree.ensureId() 用 Math.random() 生成 8 位十六进制 id，
  //    每次挂载都不同 —— 任何按 id 定位的补丁或开关都无法稳定指向它。
  for (const row of composition.rawRows) {
    if (row.id !== undefined) continue
    const at = relativeTo(env.dir, row.file) + ':' + row.line
    issues.push(makeIssue({
      layer: 'composition',
      severity: 'report-only',
      code: 'unaddressable-row',
      title: 'insert 行没有显式 id（' + (row.name ?? '未命名') + '）',
      detail: '这一行只写了 name，loader 挂载时会用随机值补 id（EntryTree.ensureId：'
        + 'Math.random().toString(16) 后 8 位）。行本身能加载，但任何按 id 定位的操作'
        + '（官方启停开关、后续 patch、行级配置）都无法稳定指向它，重启一次就换了身份。'
        + '给这一行补一个显式 id 即可，没有副作用。',
      subjects: [row.name ?? '(anonymous)', at],
      scope: scopeOfPatchFile(env.name, env.dir, row.file),
      evidence: [{ kind: 'file', at, note: '缺少显式 id 的 insert 行' }],
      id: 'unaddressable-row:' + at,
    }))
  }

  // 3. orphan-row：insert 行的 name 解析不到任何模块。
  //    解析根包含安装锚点（official 同款 createRequire 口径）：官方包由安装侧提供，
  //    只看 profile 会把它们的每一行都误报成孤儿，所以结论必须说清**查过哪些根**。
  //    后果的写法有实测依据：一行解析不到不是这一行失败，而是整个 profile 起不来
  //    （探针实测 exit=1、停在 plugin tree failed to load、HTTP 服务从未监听；
  //    同一行若 disabled、或它所在的 group 被禁用，则照常启动——所以措辞写成条件式，不夸大）。
  for (const row of composition.rawRows) {
    const name = row.name
    if (name === undefined || name.length === 0) continue
    if (rowTargetResolves(env.dir, row.file, name, facts.installAnchor)) continue
    const rowId = row.id ?? name
    const at = relativeTo(env.dir, row.file) + ':' + row.line
    issues.push(makeIssue({
      layer: 'composition',
      severity: 'confirm-fix',
      code: 'orphan-row',
      title: 'insert 行的模块名解析不到：' + name,
      detail: 'patch 插入了 name=' + name + ' 的行，但该说明符在 ' + resolutionRootsNote(env.dir, facts)
        + ' 下都解析不到。后果不是这一行加载失败：只要这一行被启用（它的 group 也启用），'
        + '挂载时就是 ERR_MODULE_NOT_FOUND 直接打断 plugin tree，**整个 profile 起不来**'
        + '（真机实测：进程 exit=1，HTTP 服务从未开始监听；同一行写成 disabled，或它所在的 group 被禁用时'
        + ' profile 照常启动）。' + manualEditSteps(env, row, rowId, facts.packageDirs,
        rowReachedComposition(composition, row))
        + '另一条路是把包装进来（' + name + '），装好再重启该环境。',
      subjects: [name],
      scope: scopeOfPatchFile(env.name, env.dir, row.file),
      extra: {
        operation: '删除 ' + at + ' 的 insert 行（id=' + rowId + '）后重启该环境；或先安装 ' + name,
      },
      evidence: [{ kind: 'file', at, note: '解析不到的 insert 行（启用即致命）' }],
      fix: {
        action: 'remove-row',
        target: rowId,
        summary: '这一行会让整个 profile 起不来；请手工删除 ' + row.file + ':' + row.line
          + ' 的 id=' + rowId + ' 行后重启该环境（我们不代写 patch 文件）',
      },
      id: 'orphan-row:' + name,
    }))
  }

  // 4. disabled-dependency：被依赖的行被禁用（需要官方合并出的有效状态）。
  if (!composition.effectiveState) return issues
  const rowsByPackage = new Map<string, ComposedRow>()
  for (const row of composition.rows) {
    const pkg = packageNameOf(row.name)
    if (pkg === undefined || rowsByPackage.has(pkg)) continue
    rowsByPackage.set(pkg, row)
  }
  for (const edge of facts.edges) {
    const target = rowsByPackage.get(edge.to)
    if (target === undefined || target.enabled) continue
    const consumer = rowsByPackage.get(edge.from)
    if (consumer !== undefined && !consumer.enabled) continue
    const reason = target.conditional
      ? '它的 disabled 是条件表达式（静态判为"可能禁用"）'
      : '它的 loader 行被禁用'
    issues.push(makeIssue({
      layer: 'composition',
      severity: 'safe-fix',
      code: 'disabled-dependency',
      title: edge.from + ' 依赖的 ' + edge.to + ' 被禁用',
      detail: edge.from + ' 在 ' + relativeTo(env.dir, edge.file) + ':' + edge.line + ' 导入 ' + edge.spec
        + '，但 ' + edge.to + ' 的 loader 行（id=' + target.id + '）是禁用状态：' + reason + '。'
        + '消费者会卡在 pending（注入的服务永远不就绪）或在首次使用时失败。若这是误禁用，重新启用该行即可。',
      subjects: [edge.from, edge.to, target.id],
      scope: edge.from,
      evidence: [
        { kind: 'file', at: relativeTo(env.dir, edge.file) + ':' + edge.line, note: 'consumer 的 import 位置' },
        { kind: 'official', at: 'loader entry "' + target.id + '"', note: '该行在官方组合结果里是禁用的' },
      ],
      fix: {
        action: 'enable-row',
        target: target.id,
        summary: '重新启用 loader 行 ' + target.id + '（' + edge.to + '）',
      },
      id: 'disabled-dependency:' + edge.from + '>' + edge.to,
    }))
  }
  return issues
}

/**
 * 一个 patch 行里的模块名能否解析到。
 *
 * @param envDir - 环境目录（解析锚点）。
 * @param patchFile - 该行所在的 patch 文件（相对名按它的目录解析）。
 * @param name - 行里的模块名。
 * @param installAnchor - dsh 应用包的 package.json；官方包由安装侧提供，必须有它才解析得到。
 * @returns 能否解析到。
 */
function rowTargetResolves(
  envDir: string,
  patchFile: string,
  name: string,
  installAnchor?: string,
): boolean {
  if (name.startsWith('cordis:')) return true
  if (name.startsWith('file:')) {
    try {
      return existsSync(fileURLToPath(name))
    } catch {
      return false
    }
  }
  if (name.startsWith('.')) return existsSync(resolve(dirname(patchFile), name))
  if (isAbsolute(name)) return existsSync(name)
  return specifierResolves(envDir, name, installAnchor)
}

/**
 * 原始文本里的 insert 行定位。
 *
 * 这不是 YAML 解析器：语义一律取官方返回值（见 readComposition），
 * 这里只负责"哪一行、有没有显式 id、字面量上写没写 disabled"。
 * 做法是按 insert 键的列号推出行缩进，再把该缩进上的列表条目当作一行，
 * 因此不需要理解 YAML 的类型系统，也不会被条件表达式绊倒。
 *
 * @param file - patch 文件的绝对路径。
 * @returns 按文件顺序排列的原始行；文件不可读时为空数组。
 */
export function locatePatchRows(file: string): RawRow[] {
  const text = readTextFile(file)
  if (text === undefined) return []
  const lines = text.split('\n')
  const rows: RawRow[] = []
  let rowIndent: number | undefined
  let group: string | undefined
  let current: {
    line: number
    id?: string
    name?: string
    disabled: RawRow['disabled']
    sealed: boolean
  } | undefined

  const flush = (): void => {
    if (current === undefined) return
    rows.push({
      file, line: current.line, id: current.id, name: current.name,
      disabled: current.disabled, group,
    })
    current = undefined
  }

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? ''
    const indent = raw.length - raw.trimStart().length
    const body = raw.trim()
    if (body.length === 0 || body.startsWith('#')) continue

    // insert 块：由 insert 键的列号推出行缩进（"- insert:" 在 0 列时行为 4 列缩进）。
    if (/^(\s*)(?:-\s+)?insert:\s*$/.test(raw)) {
      flush()
      if (indent === 0) group = undefined
      rowIndent = raw.indexOf('insert:') + 2
      continue
    }
    // 顶层列表项：记录它的 id，作为其后 insert 块的 group 归属。
    if (indent === 0 && body.startsWith('- ')) {
      flush()
      rowIndent = undefined
      const idMatch = /^-\s+id:\s*(.+)$/.exec(body)
      group = idMatch === null ? undefined : unquote(idMatch[1] ?? '')
      continue
    }
    if (rowIndent === undefined) continue
    if (indent < rowIndent) {
      flush()
      rowIndent = undefined
      if (indent === 0) group = undefined
      continue
    }
    if (indent === rowIndent && body.startsWith('- ')) {
      flush()
      current = { line: index + 1, disabled: 'false', sealed: false }
      applyRowField(current, body.slice(2))
      continue
    }
    if (current !== undefined && indent > rowIndent && !current.sealed) {
      if (/^config:\s*/.test(body)) current.sealed = true
      else applyRowField(current, body)
    }
  }
  flush()
  return rows
}

/** 把一行 key: value 文本并入当前 insert 行。 */
function applyRowField(
  row: { id?: string; name?: string; disabled: RawRow['disabled'] },
  body: string,
): void {
  const match = /^(-?\s*)([A-Za-z_][\w-]*):\s*(.*)$/.exec(body)
  if (match === null) return
  const key = match[2] ?? ''
  const value = (match[3] ?? '').trim()
  if (value.length === 0 || value.startsWith('#') || value.startsWith('|') || value.startsWith('>')) return
  if (key === 'id' && row.id === undefined) row.id = unquote(value)
  else if (key === 'name' && row.name === undefined) row.name = unquote(value)
  else if (key === 'disabled') row.disabled = disabledLiteral(value)
}

/** YAML 标量里的 disabled 取值。 */
function disabledLiteral(value: string): RawRow['disabled'] {
  if (/^!!js\b/.test(value)) return 'conditional'
  if (/^true$/i.test(value)) return 'true'
  if (/^false$/i.test(value)) return 'false'
  return 'conditional'
}

/** 去掉包裹的引号与行尾注释。 */
function unquote(value: string): string {
  const trimmed = value.trim().replace(/\s+#.*$/, '')
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1)
  }
  return trimmed
}

// ── L3 运行时层 ─────────────────────────────────────────────────────────

/** L3：fiber 相位异常 + 注册名冲突。 */
function runtimeLayer(
  env: EnvironmentInfo,
  facts: StaticFacts,
  composition: CompositionFacts,
  runtime: RuntimeFacts,
): DiagnosticIssue[] {
  if (runtime.source === 'unavailable') return []
  const issues: DiagnosticIssue[] = []
  const live = new Set<string>()

  for (const entry of runtime.entries) {
    const moduleName = String(entry.moduleName ?? '')
    const rowId = String(entry.entryId ?? '')
    if (entry.enabled === false) continue
    if (entry.fiberPhase === 'failed') {
      issues.push(makeIssue({
        layer: 'runtime',
        severity: 'confirm-fix',
        code: 'failed-fiber',
        title: '加载失败：' + (moduleName || rowId),
        detail: moduleName + '（行 id=' + rowId + '）的 fiber 相位是 failed：它的 apply() 抛了错或 import 失败，'
          + '依赖它的行也无法完成装配。先看启动日志里的原始错误，判断是配置问题还是包本身的问题；'
          + '确认这一行确实不该加载时，禁用它是最快的恢复手段。',
        subjects: [moduleName, rowId],
        evidence: [
          {
            kind: 'runtime',
            at: 'loader entry "' + rowId + '"',
            note: 'fiber 相位 failed（moduleName=' + moduleName + '）',
          },
          runtime.source === 'official'
            ? { kind: 'official' as const, at: 'readPluginInventory()', note: '官方运行时投影' }
            : {
              kind: 'official' as const,
              at: 'ctx.loader.entries()',
              note: '官方投影不可用时的 Loader 直读结果',
            },
        ],
        fix: {
          action: 'disable-row',
          target: rowId,
          summary: '禁用加载失败的行 ' + rowId + '（' + moduleName + '），先让 profile 起得来',
        },
        id: 'failed-fiber:' + rowId,
      }))
      continue
    }
    if (entry.fiberPhase === 'pending') {
      const pkg = packageNameOf(moduleName)
      const injects = pkg === undefined ? [] : (facts.scans.get(pkg)?.injects ?? [])
      const missing = [...new Set(injects
        .map(hit => hit.name)
        .filter(service => !hasProvider(facts, composition, service)))]
      const disabledProvider = composition.rows.find(row => !row.enabled
        && missing.some(service =>
          (facts.scans.get(packageNameOf(row.name) ?? '')?.services ?? []).some(hit => hit.name === service)))
      const details = ['这一行的 fiber 长期停在 pending：它 inject 的服务从未变成可用。']
      if (missing.length > 0) details.push('缺的服务：' + missing.join('、') + '。')
      if (disabledProvider !== undefined) {
        details.push('其中至少一个服务由 ' + disabledProvider.name + ' 提供，'
          + '但它的 loader 行（id=' + disabledProvider.id + '）是禁用状态。')
      }
      issues.push(makeIssue({
        layer: 'runtime',
        severity: disabledProvider === undefined ? 'report-only' : 'confirm-fix',
        code: 'pending-fiber',
        title: '装配未完成（pending）：' + (moduleName || rowId),
        detail: details.join(''),
        subjects: [moduleName, rowId, ...missing],
        evidence: [{ kind: 'runtime', at: 'loader entry "' + rowId + '"', note: 'fiber 相位 pending' }],
        ...(disabledProvider === undefined ? {} : {
          fix: {
            action: 'enable-row' as const,
            target: disabledProvider.id,
            summary: '重新启用提供该服务的行 ' + disabledProvider.id + '（' + disabledProvider.name + '）',
          },
        }),
        id: 'pending-fiber:' + rowId,
      }))
      continue
    }
    if (entry.fiberPhase === 'active' && moduleName.length > 0) live.add(moduleName)
  }

  // 注册名冲突：只在**存活行**的包之间比对。
  // 官方依据：cordis 的 ctx.provide() 重名抛 service has been registered；
  // dsh-tools 的 register 与 systemPrompt.section 对同作用域重名抛错；
  // webserver.register 对同 kind+path 抛错。静态扫描只能给"疑似"，
  // 因此证据里同时给出源码行，让用户自己核实。
  const packages = new Set<string>()
  for (const moduleName of live) {
    const pkg = packageNameOf(moduleName)
    if (pkg !== undefined && facts.scans.has(pkg)) packages.add(pkg)
  }
  const families: readonly {
    readonly code: string
    readonly label: string
    readonly pick: (scan: PackageScan) => readonly RegistrationHit[]
  }[] = [
    { code: 'service-name-conflict', label: '服务名', pick: scan => scan.services },
    { code: 'tool-name-conflict', label: '工具名', pick: scan => scan.tools },
    { code: 'section-name-conflict', label: '提示词段落名', pick: scan => scan.sections },
    { code: 'route-conflict', label: 'HTTP 路由', pick: scan => scan.routes },
  ]
  for (const family of families) {
    const owners = new Map<string, { name: string; hit: RegistrationHit }[]>()
    for (const pkg of packages) {
      const scan = facts.scans.get(pkg)
      if (scan === undefined) continue
      for (const hit of family.pick(scan)) {
        const list = owners.get(hit.name) ?? []
        list.push({ name: pkg, hit })
        owners.set(hit.name, list)
      }
    }
    for (const [registered, list] of owners) {
      const distinct = [...new Map(list.map(item => [item.name, item])).values()]
      if (distinct.length < 2) continue
      const later = distinct[distinct.length - 1]
      if (later === undefined) continue
      issues.push(makeIssue({
        layer: 'runtime',
        severity: 'confirm-fix',
        code: family.code,
        title: family.label + '冲突：' + registered,
        detail: family.label + ' ' + registered + ' 被 ' + distinct.map(item => item.name).join(' 与 ')
          + ' 同时注册，且两者的 loader 行都处于存活状态。后注册的一方会失败或覆盖先注册的一方'
          + '（官方托管注册表对重名直接抛错）。这是**源码静态扫描**的结论：请先核对下面几处源码，'
          + '确认它们确实在同一作用域注册，再决定禁用哪一个。',
        subjects: [registered, ...distinct.map(item => item.name)],
        evidence: distinct.slice(0, 3).map(item => ({
          kind: 'file' as const,
          at: relativeTo(env.dir, item.hit.file) + ':' + item.hit.line,
          note: item.name + ' 注册 ' + registered,
        })),
        fix: {
          action: 'disable-row',
          target: rowIdOfPackage(composition, later.name),
          summary: '禁用后注册者 ' + later.name + ' 的行',
        },
        id: family.code + ':' + registered,
      }))
    }
  }
  return issues
}

/** 该服务名在当前环境里有没有任何注册点（存活或禁用的包都算"存在"）。 */
function hasProvider(facts: StaticFacts, composition: CompositionFacts, service: string): boolean {
  for (const scan of facts.scans.values()) {
    if (scan.services.some(hit => hit.name === service)) return true
  }
  for (const row of composition.rows) {
    const scan = facts.scans.get(packageNameOf(row.name) ?? '')
    if (scan?.services.some(hit => hit.name === service)) return true
  }
  return false
}

/** 一个包对应的 loader 行 id（找不到时退回包名）。 */
function rowIdOfPackage(composition: CompositionFacts, packageName: string): string {
  const row = composition.rows.find(candidate => packageNameOf(candidate.name) === packageName)
  if (row !== undefined) return row.id
  const raw = composition.rawRows.find(candidate =>
    candidate.name !== undefined && packageNameOf(candidate.name) === packageName)
  return raw?.id ?? packageName
}

// ── L4 一致性层 ─────────────────────────────────────────────────────────

/** L4：官方 inventory × 本地 manifest。 */
function consistencyLayer(
  env: EnvironmentInfo,
  facts: StaticFacts,
  composition: CompositionFacts,
  runtime: RuntimeFacts,
): DiagnosticIssue[] {
  if (runtime.source === 'unavailable') return []
  const issues: DiagnosticIssue[] = []
  const loaded = new Set<string>()
  for (const entry of runtime.entries) {
    const pkg = packageNameOf(String(entry.moduleName ?? ''))
    if (pkg !== undefined) loaded.add(pkg)
  }
  const manifestText = readTextFile(join(env.dir, 'package.json'))
  const closure = dependencyClosure(facts)

  // 1. declared-not-loaded：bundle 在 bundles 列表里，它的行却一行都不在 loader 树上。
  for (const bundle of facts.manifest.bundles) {
    const rows = composition.rows.filter(row => rowBelongsToBundle(facts, row, bundle))
    if (rows.length === 0) continue
    if (rows.some(row => loaded.has(packageNameOf(row.name) ?? ''))) continue
    const line = manifestText === undefined ? undefined : jsonValueLine(manifestText, bundle)
    issues.push(makeIssue({
      layer: 'consistency',
      severity: 'report-only',
      code: 'declared-not-loaded',
      title: 'bundle ' + bundle + ' 声明了，loader 树里却一行都没有',
      detail: 'dsh.profile.bundles 里的 ' + bundle + ' 会插入 ' + rows.length
        + ' 个 loader 行，但当前 loader 树里没有任何一行来自它：要么它这次没参与 boot，'
        + '要么它的行全被后续层改写掉了。',
      subjects: [bundle],
      evidence: [
        { kind: 'file', at: line === undefined ? 'package.json' : 'package.json:' + line, note: 'bundle 声明位置' },
        { kind: 'runtime', at: 'loader entries', note: '当前 loader 树里没有该 bundle 的行' },
      ],
      id: 'declared-not-loaded:' + bundle,
    }))
  }

  // 2. unmounted-dependency 与 3. loaded-not-declared：profile 本地包与 loader 树对照。
  for (const name of facts.manifest.dependencies) {
    const dir = facts.packageDirs.get(name)
    const manifest = facts.manifests.get(name)
    if (dir === undefined || manifest === undefined) continue
    const isBundle = asRecord(asRecord(manifest['dsh'])?.['bundle'])?.['patch'] !== undefined
      || facts.manifest.bundles.includes(name)
    if (isBundle) continue
    const line = manifestText === undefined ? undefined : jsonKeyLine(manifestText, 'dependencies', name)
    const at = line === undefined ? 'package.json' : 'package.json:' + line
    if (!loaded.has(name)) {
      if (!exportsPluginShape(facts.scans.get(name))) continue
      issues.push(makeIssue({
        layer: 'consistency',
        severity: 'report-only',
        code: 'unmounted-dependency',
        title: '装上了但没被挂载：' + name,
        detail: name + ' 的入口导出了插件形态（apply），但当前 loader 树里没有任何行指向它，'
          + '它对运行中的环境完全不起作用——这正是官方明文空白的补位点：'
          + '"loading plain plugin modules stays a file operation"。'
          + '要让它生效，需要为它加一个 loader 行（挂载行本身由官方安装通道或用户决定）。',
        subjects: [name],
        evidence: [
          { kind: 'file', at, note: '依赖声明位置' },
          { kind: 'runtime', at: 'loader entries', note: '没有指向该包的行' },
        ],
        id: 'unmounted-dependency:' + name,
      }))
      continue
    }
    if (!closure.has(name)) {
      issues.push(makeIssue({
        layer: 'consistency',
        severity: 'report-only',
        code: 'loaded-not-declared',
        title: '挂着但不在依赖闭包里：' + name,
        detail: name + ' 是当前 loader 树里的一行，但它不在 profile 声明依赖的闭包里'
          + '（手工放进 node_modules，或依赖已被移除而包还在）。依赖树上任何一次安装操作都可能把它清掉。',
        subjects: [name],
        evidence: [
          { kind: 'runtime', at: 'loader entry "' + rowIdOfPackage(composition, name) + '"', note: '该行存在' },
          { kind: 'file', at, note: '不在该声明与其闭包内' },
        ],
        id: 'loaded-not-declared:' + name,
      }))
    }
  }
  return issues
}

/**
 * 这一行有没有真的进到官方组合结果里（决定"照这里删"这句话能不能确定地说）。
 *
 * 行定位器是文本扫描（见 locatePatchRows）：判"同名同 id 的行确实在最终组合里"是可靠的，
 * 反过来（没找到）不能证明那一行不存在，只能说明我们无法确认——此时的指示要降一档语气。
 *
 * @param composition - 官方组合结果（不可用时它的 rows 为空数组）。
 * @param row - 文本扫描到的原始行。
 * @returns 组合结果里有没有匹配的行（无显式 id 时按 name 匹配）。
 */
function rowReachedComposition(composition: CompositionFacts, row: RawRow): boolean {
  return composition.rows.some(candidate => row.id === undefined
    ? candidate.name === row.name
    : candidate.id === row.id)
}

/** loader 行是否属于某个 bundle 提供的包。 */
function rowBelongsToBundle(facts: StaticFacts, row: ComposedRow, bundle: string): boolean {
  const pkg = packageNameOf(row.name)
  if (pkg === undefined) return false
  if (pkg === bundle) return true
  const declared = facts.manifests.get(bundle)
  return declared !== undefined && declaresDependency(declared, pkg)
}

/** 入口源码里是否出现插件形态（导出 apply 或缺省导出）。 */
function exportsPluginShape(scan: PackageScan | undefined): boolean {
  if (scan === undefined || scan.reason !== undefined) return false
  return scan.entryFiles.some(file => {
    const text = readTextFile(file)
    if (text === undefined) return false
    return /\bexport\s+(?:default\b|(?:async\s+)?function\s+apply\b|const\s+apply\b|\{[^}]*\bapply\b)/.test(text)
  })
}

/** 从 profile 的声明依赖出发做有界闭包（只读 manifest，不扫源码）。 */
function dependencyClosure(facts: StaticFacts): Set<string> {
  const roots = moduleRoots(facts.envDir, facts.installAnchor)
  const seen = new Set<string>(facts.manifest.bundles)
  const queue = [...facts.manifest.dependencies]
  while (queue.length > 0 && seen.size < CLOSURE_MAX_PACKAGES) {
    const name = queue.shift()
    if (name === undefined || seen.has(name)) continue
    seen.add(name)
    const dir = facts.packageDirs.get(name) ?? findInstalledDir(roots, name)
    if (dir === undefined) continue
    const manifest = facts.manifests.get(name) ?? readJsonFile(join(dir, 'package.json'))
    if (manifest === undefined) continue
    for (const dep of declaredNames(manifest)) if (!seen.has(dep)) queue.push(dep)
  }
  return seen
}

// ── L5 生态层（最小骨架）────────────────────────────────────────────────

/**
 * L5：市场索引的更新与风险信息。
 *
 * **只留骨架**：索引抓取、合并、缓存归市场模块（src/marketplace.ts 等），
 * 诊断引擎不重复实现数据源，也不在诊断路径上访问网络，因此这一层暂无可判定的事实，
 * 由 analyzeEnvironment 记入 report.skipped。将来市场模块把索引递进来时，更新与废弃检查挂在这里。
 *
 * @returns 恒为空数组（骨架）。
 */
function ecosystemLayer(): DiagnosticIssue[] {
  return []
}

// ── 源码扫描器（L1/L3 与质量门共用）─────────────────────────────────────

/** 词法记号。扫描器只在**代码位置**识别关键字，注释与字符串字面量不参与匹配。 */
interface Token {
  readonly kind: 'word' | 'string' | 'punct'
  readonly value: string
  readonly line: number
}

const WORD_START = /[A-Za-z_$]/
const WORD_CHAR = /[A-Za-z0-9_$]/
const BACKTICK = '\u0060'

/**
 * 极简词法扫描：切出 word / string / punct 三类记号，跳过注释。
 *
 * 与"正则剥注释"相比的两点改进：字符串字面量内部不会被当成代码
 * （"from 'x'" 不产生 import），注释里的 new Service(ctx, 'x') 不产生注册。
 * 已知不做的事：正则字面量不做完整识别（含双斜杠的正则可能被当成注释吞掉），
 * 模板字面量里的插值不求值。
 *
 * @param code - 源码文本。
 * @returns 按出现顺序排列的记号；行号从 1 起。
 */
export function tokenize(code: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  let line = 1
  const length = code.length
  while (index < length) {
    const char = code[index] ?? ''
    if (char === '\n') {
      line += 1
      index += 1
      continue
    }
    if (char === ' ' || char === '\t' || char === '\r') {
      index += 1
      continue
    }
    if (char === '/' && code[index + 1] === '/') {
      while (index < length && code[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && code[index + 1] === '*') {
      index += 2
      while (index < length && !(code[index] === '*' && code[index + 1] === '/')) {
        if (code[index] === '\n') line += 1
        index += 1
      }
      index += 2
      continue
    }
    if (char === '"' || char === "'") {
      const startLine = line
      let value = ''
      index += 1
      while (index < length) {
        const inner = code[index] ?? ''
        if (inner === '\\') {
          value += code[index + 1] ?? ''
          index += 2
          continue
        }
        if (inner === char) {
          index += 1
          break
        }
        if (inner === '\n') line += 1
        value += inner
        index += 1
      }
      tokens.push({ kind: 'string', value, line: startLine })
      continue
    }
    if (char === BACKTICK) {
      const startLine = line
      let value = ''
      let interpolated = false
      index += 1
      while (index < length) {
        const inner = code[index] ?? ''
        if (inner === '\\') {
          value += code[index + 1] ?? ''
          index += 2
          continue
        }
        if (inner === '$' && code[index + 1] === '{') interpolated = true
        if (inner === BACKTICK) {
          index += 1
          break
        }
        if (inner === '\n') line += 1
        value += inner
        index += 1
      }
      if (!interpolated) tokens.push({ kind: 'string', value, line: startLine })
      continue
    }
    if (WORD_START.test(char)) {
      let value = char
      index += 1
      while (index < length && WORD_CHAR.test(code[index] ?? '')) {
        value += code[index] ?? ''
        index += 1
      }
      tokens.push({ kind: 'word', value, line })
      continue
    }
    tokens.push({ kind: 'punct', value: char, line })
    index += 1
  }
  return tokens
}

/** 一份源码的扫描结果（说明符 + 命名注册，均带行号）。 */
export interface CodeScan {
  readonly imports: readonly {
    readonly spec: string
    readonly line: number
    readonly kind: ScannedImport['kind']
  }[]
  readonly services: readonly { readonly name: string; readonly line: number }[]
  readonly injects: readonly { readonly name: string; readonly line: number }[]
  readonly tools: readonly { readonly name: string; readonly line: number }[]
  readonly sections: readonly { readonly name: string; readonly line: number }[]
  readonly routes: readonly { readonly name: string; readonly line: number }[]
}

/**
 * 扫描一份 JS/TS 源码：静态与动态 import、re-export、require，
 * 以及服务、工具、提示词段落、HTTP 路由的命名注册点。
 *
 * @param code - 源码文本。
 * @returns 说明符与注册点，均带行号。
 */
export function scanCode(code: string): CodeScan {
  const tokens = tokenize(code)
  const imports: { spec: string; line: number; kind: ScannedImport['kind'] }[] = []
  const services: { name: string; line: number }[] = []
  const injects: { name: string; line: number }[] = []
  const tools: { name: string; line: number }[] = []
  const sections: { name: string; line: number }[] = []
  const routes: { name: string; line: number }[] = []

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === undefined || token.kind !== 'word') continue
    const next = tokens[i + 1]
    const prev1 = tokens[i - 1]
    const prev2 = tokens[i - 2]

    if (token.value === 'import' || token.value === 'export') {
      if (next?.kind === 'string') {
        imports.push({
          spec: next.value,
          line: next.line,
          kind: token.value === 'import' ? 'static' : 're-export',
        })
        continue
      }
      if (next?.kind === 'punct' && next.value === '(') {
        const arg = tokens[i + 2]
        if (arg?.kind === 'string') imports.push({ spec: arg.value, line: arg.line, kind: 'dynamic' })
        continue
      }
      if (next?.kind === 'punct' && next.value === '.') continue
      if (token.value === 'import' && next?.kind === 'word' && next.value === 'type') continue
      for (let k = i + 1; k < Math.min(tokens.length, i + 60); k += 1) {
        const cursor = tokens[k]
        if (cursor === undefined) break
        if (cursor.kind === 'punct' && cursor.value === ';') break
        if (cursor.kind === 'word' && (cursor.value === 'import' || cursor.value === 'export')) break
        if (cursor.kind === 'word' && cursor.value === 'from') {
          const source = tokens[k + 1]
          if (source?.kind === 'string') {
            imports.push({
              spec: source.value,
              line: source.line,
              kind: token.value === 'import' ? 'static' : 're-export',
            })
          }
          break
        }
      }
      continue
    }
    if (token.value === 'require' && next?.kind === 'punct' && next.value === '(') {
      const arg = tokens[i + 2]
      if (arg?.kind === 'string') imports.push({ spec: arg.value, line: arg.line, kind: 'require' })
      continue
    }

    if (token.value === 'Service' && prev1?.kind === 'word' && prev1.value === 'new') {
      const hit = firstStringArgument(tokens, i + 1)
      if (hit !== undefined) services.push(hit)
      continue
    }
    if (token.value === 'super' && next?.kind === 'punct' && next.value === '(') {
      const hit = firstStringArgument(tokens, i)
      if (hit !== undefined) services.push(hit)
      continue
    }
    if (token.value === 'provide' && prev1?.kind === 'punct' && prev1.value === '.'
      && next?.kind === 'punct' && next.value === '(') {
      const hit = firstStringArgument(tokens, i)
      if (hit !== undefined) services.push(hit)
      continue
    }
    if (token.value === 'inject' && next?.kind === 'punct' && (next.value === '=' || next.value === ':')) {
      const open = tokens[i + 2]
      if (open?.kind === 'punct' && open.value === '[') {
        for (let k = i + 3; k < Math.min(tokens.length, i + 40); k += 1) {
          const cursor = tokens[k]
          if (cursor === undefined) break
          if (cursor.kind === 'punct' && cursor.value === ']') break
          if (cursor.kind === 'string') injects.push({ name: cursor.value, line: cursor.line })
        }
      }
      continue
    }
    if (token.value === 'defineTool' && next?.kind === 'punct' && next.value === '(') {
      const hit = objectFieldString(tokens, i + 1, 'name')
      if (hit !== undefined) tools.push(hit)
      continue
    }
    if (token.value === 'register' && prev1?.kind === 'punct' && prev1.value === '.'
      && prev2 !== undefined && prev2.kind === 'word') {
      if (prev2.value === 'tools') {
        const hit = objectFieldString(tokens, i + 1, 'name')
        if (hit !== undefined) tools.push(hit)
        continue
      }
      if (prev2.value === 'webServer') {
        const hit = objectFieldString(tokens, i + 1, 'path')
        if (hit !== undefined) routes.push(hit)
        continue
      }
    }
    if (token.value === 'section' && prev1?.kind === 'punct' && prev1.value === '.'
      && prev2 !== undefined && prev2.kind === 'word' && prev2.value === 'systemPrompt') {
      const hit = objectFieldString(tokens, i + 1, 'name')
      if (hit !== undefined) sections.push(hit)
    }
  }
  return { imports, services, injects, tools, sections, routes }
}

/** 括号内的第一个字符串实参（new Service(ctx, 'x') / super(ctx, 'x') / ctx.provide('x')）。 */
function firstStringArgument(
  tokens: readonly Token[],
  keywordIndex: number,
): { readonly name: string; readonly line: number } | undefined {
  let depth = 0
  for (let k = keywordIndex; k < Math.min(tokens.length, keywordIndex + 40); k += 1) {
    const token = tokens[k]
    if (token === undefined) break
    if (token.kind === 'punct' && token.value === '(') depth += 1
    else if (token.kind === 'punct' && token.value === ')') {
      depth -= 1
      if (depth <= 0) return undefined
    } else if (token.kind === 'string' && depth === 1) {
      return { name: token.value, line: token.line }
    }
  }
  return undefined
}

/** 调用实参里的对象字段字符串（register({ name: 'x' })）。 */
function objectFieldString(
  tokens: readonly Token[],
  callIndex: number,
  field: string,
): { readonly name: string; readonly line: number } | undefined {
  let depth = 0
  for (let k = callIndex; k < Math.min(tokens.length, callIndex + 200); k += 1) {
    const token = tokens[k]
    if (token === undefined) break
    if (token.kind === 'punct' && (token.value === '(' || token.value === '{' || token.value === '[')) depth += 1
    else if (token.kind === 'punct' && (token.value === ')' || token.value === '}' || token.value === ']')) {
      depth -= 1
      if (depth <= 0) return undefined
    } else if (token.kind === 'word' && token.value === field && depth >= 1) {
      const colon = tokens[k + 1]
      const value = tokens[k + 2]
      if (colon?.kind === 'punct' && colon.value === ':' && value?.kind === 'string') {
        return { name: value.value, line: value.line }
      }
    }
  }
  return undefined
}

/**
 * 这条裸说明符看起来**可能**是一个真模块名吗（扫描器的输入过滤）。
 *
 * 为什么需要它：打包产物会把模板字面量拆成 "字面量 + ${…} 表达式"，字面量部分于是成了
 * **无插值的反引号字符串**，被词法器当成 string 记号收集，形如 " || token.value === "、
 * ") {\n  if (next?.kind === "。这些片段被当成说明符后，会给"这个包导入了不存在的依赖"这类
 * 结论提供假输入（实测：CLI 逃生口路径上 9 条假 missing-import）。
 *
 * 判据只做"合法裸说明符"的形状检查：首字符字母或数字，其余字母/数字/._-~/%@+ 或查询串，
 * 且不含空白与控制字符。npm 包名本来就不允许空白与这些符号，因此被丢弃的必然是打包碎片；
 * 相对路径与绝对路径走的是另外的分支（由调用方先判），本函数只作用于裸说明符。
 *
 * @param spec - 说明符。
 * @returns 是否可能是模块名（false 表示应当丢弃）。
 */
export function isPlausibleSpecifier(spec: string): boolean {
  if (spec.length === 0) return false
  return /^@?[a-z0-9][a-z0-9._\-~/@%+?=&:]*$/i.test(spec)
}
/**
 * 扫描一个已安装包：入口 → 相对 import 可达文件（有界 BFS）。
 *
 * @param pkgDir - 包目录绝对路径。
 * @param manifest - 该包 package.json 的解析结果。
 * @param maxFiles - 本次可用的文件预算（逐包递减，来自全局预算）。
 * @returns 扫描结果；没有可解析入口时给出 reason。
 */
export function scanPackage(
  pkgDir: string,
  manifest: Record<string, unknown>,
  maxFiles: number = SCAN_MAX_FILES_PER_PACKAGE,
): PackageScan {
  const entryFiles = packageEntryFiles(pkgDir, manifest)
  const imports: ScannedImport[] = []
  const services: RegistrationHit[] = []
  const injects: RegistrationHit[] = []
  const tools: RegistrationHit[] = []
  const sections: RegistrationHit[] = []
  const routes: RegistrationHit[] = []
  const base = {
    imports, services, injects, tools, sections, routes, entryFiles,
    filesScanned: 0, truncated: false,
  }
  if (entryFiles.length === 0) {
    return { ...base, reason: 'no resolvable entry file (exports/main/index.js)' }
  }

  const limit = Math.max(1, Math.min(maxFiles, SCAN_MAX_FILES_PER_PACKAGE))
  const seen = new Set<string>(entryFiles)
  const queue: { file: string; depth: number }[] = entryFiles.map(file => ({ file, depth: 0 }))
  let scanned = 0
  let truncated = false
  while (queue.length > 0) {
    if (scanned >= limit) {
      truncated = true
      break
    }
    const current = queue.shift()
    if (current === undefined) break
    scanned += 1
    const code = readTextFile(current.file)
    if (code === undefined) continue
    const result = scanCode(code)
    for (const hit of result.imports) {
      if (hit.spec.startsWith('.')) {
        if (current.depth >= SCAN_MAX_DEPTH) {
          truncated = true
          continue
        }
        const target = resolveRelativeFile(dirname(current.file), hit.spec)
        if (target === undefined || seen.has(target) || !isInside(pkgDir, target)) continue
        seen.add(target)
        queue.push({ file: target, depth: current.depth + 1 })
        continue
      }
      if (hit.spec.startsWith('/') || isBuiltin(hit.spec)) continue
      // 输入过滤（不是判定口径）：打包器会把模板字面量拆成 `${…}` 片段，字面量部分会变成
      // 无插值的反引号字符串被词法器当成 string 记号收集。含空白/控制字符的裸说明符在 Node 里
      // 本来就不可能解析（ERR_INVALID_MODULE_SPECIFIER），丢弃它们不会掩盖真依赖。
      if (!isPlausibleSpecifier(hit.spec)) continue
      imports.push({ spec: hit.spec, file: current.file, line: hit.line, kind: hit.kind })
    }
    for (const hit of result.services) services.push({ name: hit.name, file: current.file, line: hit.line })
    for (const hit of result.injects) injects.push({ name: hit.name, file: current.file, line: hit.line })
    for (const hit of result.tools) tools.push({ name: hit.name, file: current.file, line: hit.line })
    for (const hit of result.sections) sections.push({ name: hit.name, file: current.file, line: hit.line })
    for (const hit of result.routes) routes.push({ name: hit.name, file: current.file, line: hit.line })
  }
  return { ...base, filesScanned: scanned, truncated }
}

/**
 * 一个包声明的全部入口文件（exports 的每个子路径 + main + module）。
 *
 * 只取一个入口是历史缺陷：DSH 插件常同时带 host/client/worker 多个入口，
 * 未声明依赖若只出现在 exports["./server"] 指向的文件里，单入口检查会整条漏过，
 * 而挂载该子路径的行会让整个 profile 起不来。
 *
 * @param pkgDir - 包目录绝对路径。
 * @param manifest - 该包 package.json 的解析结果。
 * @returns 去重后仍存在的入口文件路径。
 */
export function packageEntryFiles(pkgDir: string, manifest: Record<string, unknown>): string[] {
  const candidates: string[] = []
  collectExportTargets(manifest['exports'], candidates)
  for (const key of ['main', 'module'] as const) {
    const value = manifest[key]
    if (typeof value === 'string') candidates.push(value)
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (candidate.length === 0 || !isScriptTarget(candidate)) continue
    const file = resolve(pkgDir, candidate)
    if (seen.has(file) || !isInside(pkgDir, file) || !existsSync(file)) continue
    try {
      if (!statSync(file).isFile()) continue
    } catch {
      continue
    }
    seen.add(file)
    out.push(file)
  }
  if (out.length === 0) {
    for (const fallback of ['index.js', 'index.mjs', 'index.cjs']) {
      const file = join(pkgDir, fallback)
      if (existsSync(file)) {
        out.push(file)
        break
      }
    }
  }
  return out
}

/** 递归收集 exports 节点里的字符串目标。 */
function collectExportTargets(node: unknown, out: string[]): void {
  if (typeof node === 'string') {
    out.push(node)
    return
  }
  if (node === null || typeof node !== 'object') return
  for (const value of Object.values(node as Record<string, unknown>)) collectExportTargets(value, out)
}

/** 只扫脚本目标：json/css/md/图片等资产里不可能有运行期 import。 */
function isScriptTarget(target: string): boolean {
  return !/\.(?:json|jsonc|css|md|markdown|txt|wasm|node|map|html?|svg|png|jpe?g|gif|ya?ml|toml|d\.ts)$/i.test(target)
}

/**
 * 按 Node 的解析顺序探测相对说明符指向的文件。
 * @param baseDir - 相对说明符的基准目录。
 * @param spec - 相对说明符。
 * @returns 命中文件的绝对路径；都不存在时 undefined。
 */
export function resolveRelativeFile(baseDir: string, spec: string): string | undefined {
  const base = resolve(baseDir, spec)
  for (const suffix of ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
    '/index.js', '/index.mjs', '/index.cjs', '/index.ts']) {
    const candidate = base + suffix
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    } catch {
      // 探测失败继续下一个后缀
    }
  }
  return undefined
}

// ── 解析与判定工具 ──────────────────────────────────────────────────────

/**
 * 安装锚点对应的 Node 解析根：**官方同款口径**。
 *
 * 官方 @deepseek-ai/dsh-app-boot/profile.ts 的 packageDirFromAnchor 从锚点走
 * createRequire(anchor).resolve.paths(packageName)，本函数取同一串搜索路径里
 * 以 node_modules 结尾的那些（Node 会按顺序往上走：包内 → 安装目录 → 祖先目录）。
 * 官方包里已经存在的路径不再重复放进来。
 *
 * 锚点必须先 realpath：pnpm 的 bin shim 指向全局安装目录下的一个符号链接，
 * 而 Node 用的是**字面路径**，不 realpath 时那条链上一个官方包都解析不到。
 *
 * @param installAnchor - dsh 应用包的 package.json 绝对路径（ProfileContext.installAnchor）。
 * @returns 解析根（按 Node 的查找顺序）；锚点缺失、读不到或解析不出节点时为 null。
 */
export function installAnchorRoots(installAnchor: string | undefined): string[] | null {
  if (installAnchor === undefined || installAnchor.length === 0) return null
  const cached = installPathCache.get(installAnchor)
  if (cached !== undefined) return cached.length === 0 ? null : [...cached]
  const roots: string[] = []
  try {
    const anchor = realpathSync(installAnchor)
    for (const searchPath of createRequire(anchor).resolve.paths('node_modules') ?? []) {
      if (searchPath.endsWith('node_modules') && !roots.includes(searchPath)) roots.push(searchPath)
    }
  } catch {
    // 锚点不可读或不是可解析的文件路径：如实返回 null，由调用方记 skipped。
  }
  installPathCache.set(installAnchor, roots)
  return roots.length === 0 ? null : roots
}

/**
 * 环境的模块解析顺序：profile 层 → 共享兜底层 → Harness home 的 profiles 兜底 → 安装锚点。
 *
 * 前三个是 profile 自己的依赖；安装锚点由**安装侧**提供（官方包、bundle 本体与它们携带的
 * 传递依赖都在这里），缺少它会把官方包的每一行都判成孤儿。
 *
 * @param envDir - 环境目录。
 * @param installAnchor - dsh 应用包的 package.json（可省略）。
 * @returns 去重后的解析根，按查找优先级排列。
 */
export function moduleRoots(envDir: string, installAnchor?: string): string[] {
  const roots = [join(envDir, 'node_modules')]
  const sibling = join(dirname(resolve(envDir)), 'node_modules')
  if (!roots.includes(sibling)) roots.push(sibling)
  const shared = join(profilesRoot(), 'node_modules')
  if (!roots.includes(shared)) roots.push(shared)
  for (const root of installAnchorRoots(installAnchor) ?? []) {
    if (!roots.includes(root)) roots.push(root)
  }
  return roots
}

/**
 * 一个包在某个环境里的安装目录（profile 层优先，其次共享兜底层，最后是安装锚点）。
 *
 * 质量门与诊断共用这一套解析顺序，避免两处口径漂移。
 *
 * @param envDir - 环境目录。
 * @param packageName - 包名。
 * @param installAnchor - dsh 应用包的 package.json；省略时只按 profile 侧解析。
 * @returns 包目录绝对路径；未安装时 undefined。
 */
export function installedPackageDir(
  envDir: string,
  packageName: string,
  installAnchor?: string,
): string | undefined {
  return findInstalledDir(moduleRoots(envDir, installAnchor), packageName)
}

/** 在解析根里找已安装的包目录（同时回传命中的解析根：调用方要用它作 Node 解析基准）。 */
function findInstalled(
  roots: readonly string[],
  name: string,
): { readonly dir: string; readonly root: string } | undefined {
  for (const root of roots) {
    const dir = join(root, name)
    if (existsSync(join(dir, 'package.json'))) return { dir, root }
  }
  return undefined
}

/** 在解析根里找已安装的包目录。 */
function findInstalledDir(roots: readonly string[], name: string): string | undefined {
  return findInstalled(roots, name)?.dir
}

/** 一个 node_modules 根里直接可见的包名（含 @scope/name）。 */
function listInstalledNames(root: string): Set<string> {
  const names = new Set<string>()
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return names
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (!entry.name.startsWith('@')) {
      names.add(entry.name)
      continue
    }
    try {
      for (const child of readdirSync(join(root, entry.name), { withFileTypes: true })) {
        if (!child.name.startsWith('.')) names.add(entry.name + '/' + child.name)
      }
    } catch {
      // 读不到 scope 目录就跳过它
    }
  }
  return names
}

/** 说明符的包名部分。 */
function packageNameOf(spec: string): string | undefined {
  if (spec.length === 0 || spec.startsWith('.') || spec.startsWith('/')) return undefined
  const parts = spec.split('/')
  if (spec.startsWith('@')) {
    if (parts.length < 2 || (parts[1] ?? '').length === 0) return undefined
    return parts[0] + '/' + parts[1]
  }
  return parts[0]
}

/** 在已安装表里按最长前缀找提供者。 */
function providerOf(spec: string, installed: ReadonlyMap<string, string>): string | undefined {
  const parts = spec.split('/')
  for (let take = parts.length; take >= 1; take -= 1) {
    const candidate = parts.slice(0, take).join('/')
    if (candidate.startsWith('@') && take === 1) continue
    if (installed.has(candidate)) return candidate
  }
  return undefined
}

/**
 * 一个说明符在当前环境里能否解析。
 *
 * 判定"能"用两把尺子（任一成立即可）：Node 的真实解析（createRequire）与
 * 文件/exports 探测；判定"不能"必须两者都不成立——这样 scoped 子路径不会被
 * 误判为可解析（前身仓库在这一点上有过 Critical 缺陷：只要 @scope/pkg 目录存在，
 * @scope/pkg 下的任意子路径都返回 true，最后一道兜底检查因此完全失效）。
 *
 * @param envDir - 环境目录（解析锚点）。
 * @param spec - 裸说明符或带子路径的说明符。
 * @param installAnchor - dsh 应用包的 package.json；省略时只按 profile 侧解析。
 * @returns 能否解析到模块。
 */
export function specifierResolves(envDir: string, spec: string, installAnchor?: string): boolean {
  if (isBuiltin(spec)) return true
  const pkgName = packageNameOf(spec)
  if (pkgName === undefined) return false
  const hit = findInstalled(moduleRoots(envDir, installAnchor), pkgName)
  if (hit === undefined) return false
  const dir = hit.dir
  const subpath = spec.slice(pkgName.length)
  if (subpath.length === 0) return true
  // 先按真实 Node 解析判真：它认得带 exports 子路径与条件导出的官方包。
  // 基准点取包自己的 package.json（包内 import 的真实解析起点，link / hoisted 布局都覆盖），
  // 再退到环境目录（走 profile / 共享兜底 / 安装锚点三层 node_modules）。
  if (resolvesFrom(join(dir, 'package.json'), spec)) return true
  if (resolvesFrom(join(envDir, 'package.json'), spec)) return true
  // 再走文件与 exports 探测（判"不能解析"必须两者都不成立）。
  const relativePath = subpath.replace(/^\/+/, '')
  if (resolveRelativeFile(dir, relativePath) !== undefined) return true
  const manifest = readJsonFile(join(dir, 'package.json'))
  const exportsField = manifest?.['exports']
  if (exportsField !== undefined) return exportsDeclaresSubpath(exportsField, './' + relativePath)
  return false
}

/** Node 能否从某个基准文件解析出说明符（解析失败只代表这一条路走不通）。 */
function resolvesFrom(base: string, spec: string): boolean {
  try {
    createRequire(base).resolve(spec)
    return true
  } catch {
    // conditional export 可能只给 import 条件，require 解析失败不代表不可用。
    return false
  }
}

/**
 * exports 是否声明了某个子路径（支持星号通配）。
 * @param exportsField - package.json 的 exports 字段。
 * @param key - 形如 "./sub" 的子路径键。
 * @returns 是否声明。
 */
export function exportsDeclaresSubpath(exportsField: unknown, key: string): boolean {
  if (typeof exportsField === 'string' || exportsField === null || typeof exportsField !== 'object') {
    return key === '.'
  }
  const record = exportsField as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length === 0 || !keys.every(candidate => candidate.startsWith('.'))) return key === '.'
  if (key in record) return true
  for (const pattern of keys) {
    const star = pattern.indexOf('*')
    if (star < 0) continue
    const prefix = pattern.slice(0, star)
    const suffix = pattern.slice(star + 1)
    if (key.startsWith(prefix) && key.endsWith(suffix) && key.length >= prefix.length + suffix.length) {
      return true
    }
  }
  return false
}

/** 说明符是否被某个包的声明覆盖（声明了 unpdf 即覆盖 unpdf/pdfjs）。 */
function declaresSpecifier(manifest: Record<string, unknown>, spec: string, selfName: string): boolean {
  if (spec === selfName || spec.startsWith(selfName + '/')) return true
  for (const name of declaredNames(manifest)) {
    if (spec === name || spec.startsWith(name + '/')) return true
  }
  return false
}

/** manifest 是否把这个包声明成**普通**依赖（dependencies / optionalDependencies）。 */
function declaresRegularDependency(manifest: Record<string, unknown>, name: string): boolean {
  for (const section of ['dependencies', 'optionalDependencies'] as const) {
    const record = asRecord(manifest[section])
    if (record !== undefined && name in record) return true
  }
  return false
}

/** manifest 的任一依赖段是否声明了这个包。 */
function declaresDependency(manifest: Record<string, unknown>, name: string): boolean {
  for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
    const record = asRecord(manifest[section])
    if (record !== undefined && name in record) return true
  }
  return false
}

/** manifest 声明的全部依赖名。 */
function declaredNames(manifest: Record<string, unknown>): string[] {
  const names = new Set<string>()
  for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
    const record = asRecord(manifest[section])
    if (record === undefined) continue
    for (const name of Object.keys(record)) names.add(name)
  }
  return [...names]
}

/**
 * 简化 semver：判断安装版本是否满足一个范围。
 *
 * 支持星号、=、^、~、>、>=、<、<=，空格或逗号连接的合取，以及 || 析取。
 * prerelease 只参与"基线相同"时的排序（不实现 semver 的 prerelease 全规则），
 * 因此不会把 0.1.6-alpha.2 这类官方版本误判为不满足。
 *
 * @param installed - 实际安装的版本。
 * @param range - 声明的要求范围。
 * @returns 是否满足。
 */
export function satisfiesRange(installed: string, range: string): boolean {
  const wanted = range.trim()
  if (wanted.length === 0 || wanted === '*' || wanted === 'x' || wanted === 'latest') return true
  return wanted.split('||').some(branch =>
    branch.trim().split(/[\s,]+/).filter(part => part.length > 0)
      .every(token => satisfiesToken(installed, token)))
}

/** 单个比较算子。 */
function satisfiesToken(installed: string, token: string): boolean {
  const match = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(token)
  if (match === null) return true
  const operator = match[1] ?? ''
  const requested = match[2] ?? ''
  if (/^[*x]$/.test(requested)) return true
  const target = parseVersion(requested)
  const actual = parseVersion(installed)
  if (target === undefined || actual === undefined) return true
  const order = compareParsed(actual, target)
  if (operator === '>=') return order >= 0
  if (operator === '<=') return order <= 0
  if (operator === '>') return order > 0
  if (operator === '<') return order < 0
  if (operator === '=') return order === 0
  if (operator === '~') {
    if (order < 0) return false
    return actual.major === target.major && actual.minor === target.minor
  }
  if (operator === '^') {
    if (order < 0) return false
    if (target.major > 0) return actual.major === target.major
    if (target.minor > 0) return actual.major === 0 && actual.minor === target.minor
    return actual.major === 0 && actual.minor === 0 && actual.patch === target.patch
  }
  if (/[*x]/.test(requested)) return order >= 0 && actual.major === target.major
  return order === 0
}

/** 版本号解析（缺省段补 0，prerelease 原样保留）。 */
function parseVersion(
  value: string,
): { major: number; minor: number; patch: number; prerelease: string } | undefined {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+](.*))?$/.exec(value.trim())
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? '0'),
    patch: Number(match[3] ?? '0'),
    prerelease: match[4] ?? '',
  }
}

/** 版本比较：数字段优先，prerelease 只在基线相同时参与（空 prerelease 更大）。 */
function compareParsed(
  left: { major: number; minor: number; patch: number; prerelease: string },
  right: { major: number; minor: number; patch: number; prerelease: string },
): number {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1
  if (left.prerelease === right.prerelease) return 0
  if (left.prerelease === '') return 1
  if (right.prerelease === '') return -1
  return left.prerelease < right.prerelease ? -1 : 1
}

/**
 * JSON 文本里某个键所在的行号（证据要能点回 package.json:12）。
 *
 * @param text - package.json 的原始文本。
 * @param section - 顶层段名（dependencies / peerDependencies）；传空串表示全文查找。
 * @param key - 段内的键。
 * @returns 1 起的行号；找不到时 undefined。
 */
export function jsonKeyLine(text: string, section: string, key: string): number | undefined {
  const lines = text.split('\n')
  const escaped = key.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&')
  const keyPattern = new RegExp('^\\s*"' + escaped + '"\\s*:')
  if (section !== '') {
    let inSection = false
    let depth = 0
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      if (!inSection && new RegExp('^\\s*"' + section + '"\\s*:').test(line)) {
        inSection = true
        depth = 0
        continue
      }
      if (!inSection) continue
      depth += (line.match(/[{[]/g) ?? []).length
      depth -= (line.match(/[}\]]/g) ?? []).length
      if (keyPattern.test(line)) return index + 1
      if (depth <= 0 && (line.includes('}') || line.includes(']'))) inSection = false
    }
  }
  for (let index = 0; index < lines.length; index += 1) {
    if (keyPattern.test(lines[index] ?? '')) return index + 1
  }
  return undefined
}

/** JSON 文本里某个字符串值所在的行号（数组项，如 dsh.profile.bundles 里的包名）。 */
function jsonValueLine(text: string, value: string): number | undefined {
  const escaped = value.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&')
  const pattern = new RegExp('"\\s*' + escaped + '\\s*"')
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index] ?? '')) return index + 1
  }
  return undefined
}

// ── 通用小工具 ──────────────────────────────────────────────────────────

/** 组装一条发现（分级处置的约束在此集中表达）。 */
function makeIssue(input: {
  readonly layer: DiagnosticLayer
  readonly severity: DiagnosticSeverity
  readonly code: string
  readonly title: string
  readonly detail: string
  readonly subjects: readonly string[]
  readonly evidence: readonly DiagnosticEvidence[]
  readonly fix?: DiagnosticFix
  readonly id: string
  /** 问题归属的包：客户端按它折叠成组的键（判不出来时省略）。 */
  readonly scope?: string
  /** 附加的机器可读事实（目前只有需要人工改 patch 时的可复制操作文本）。 */
  readonly extra?: { readonly operation?: string }
}): DiagnosticIssue {
  return {
    id: input.id,
    layer: input.layer,
    severity: input.severity,
    code: input.code,
    title: input.title,
    detail: input.detail,
    subjects: input.subjects.filter(subject => subject.length > 0),
    evidence: input.evidence,
    ...(input.fix === undefined ? {} : { fix: input.fix }),
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    ...(input.extra === undefined ? {} : { extra: input.extra }),
  }
}

/**
 * 这两类问题的处置主通道：改用户自己那份 cordis.patch.yml，还是动 bundle（官方通道）。
 *
 * 判据只有一条事实：patch 文件在不在这个 profile 的 dsh.profile.bundles 里——在，说明它随
 * bundle 升级被覆盖，改它只是临时救急；不在，它就是用户自己的补丁层，改了长期有效。
 *
 * @param envDir - 环境目录。
 * @param patchFile - patch 文件绝对路径。
 * @param bundleDirs - 各 bundle 的安装目录（来自 StaticFacts 的 packageDirs）。
 * @returns 主通道标签。
 */
function mainCaseOf(
  envDir: string,
  patchFile: string,
  bundleDirs: ReadonlyMap<string, string>,
): 'profile-patch' | 'bundle' {
  // 环境目录下、但不在 node_modules 里 = 用户自己那份 cordis.patch.yml：改它才算改到这个 profile 的组合。
  // envDir/node_modules 里的包（profile 本地装的 bundle、link 安装的插件）自带的 patch 一律算包自带，
  // 随包升级会被覆盖，长期处置要走官方通道。
  if (isInside(envDir, patchFile) && !isInside(join(envDir, 'node_modules'), patchFile)) return 'profile-patch'
  // 环境外、又归属某个已安装包（bundle 自带的那一层，或其它包里的 patch）：随包升级被覆盖，
  // 只能临时救急；长期处置要走官方通道。
  for (const dir of new Set(bundleDirs.values())) {
    if (isInside(dir, patchFile)) return 'bundle'
  }
  return 'bundle'
}

/**
 * 需要人工删行时的可照着做的三要素：文件路径、行 id、删完做什么。
 *
 * 为什么不给按钮：删除 patch 行要求改 cordis.patch.yml 的结构，官方只有行级启停、没有删行能力，
 * 我们自己写这个文件会引入两个写者并发改同一份组合（见 docs/CODE-POLICY 与 DESIGN 的写路径红线），
 * 所以这里只给位置与内容，由用户自己动手。
 *
 * @param env - 被诊断环境。
 * @param row - 要处理的那一行（文本扫描结果，带文件与行号）。
 * @param id - 该行的 id（无显式 id 时由调用方回退成 name）。
 * @param bundleDirs - 各 bundle 的安装目录（判断 patch 归属走哪条处置通道）。
 * @param applied - 这一行是否已在官方组合结果里确认到（决定指示是否降一档语气）。
 * @param edit - 怎么改：删除多余的重复行，还是给其中一行换掉 id（跨列表重名的场景）。
 * @returns 追加到 detail 末尾的处置说明。
 */
function manualEditSteps(
  env: EnvironmentInfo,
  row: RawRow,
  id: string,
  bundleDirs: ReadonlyMap<string, string>,
  applied: boolean,
  edit: 'delete' | 'rename' | 'either' = 'delete',
): string {
  const at = relativeTo(env.dir, row.file) + ':' + row.line
  const main = mainCaseOf(env.dir, row.file, bundleDirs)
  const steps = '【怎么修】要改的文件：' + row.file + '，问题行在第 '
    + row.line + ' 行起（报告里的 ' + at + ' 就是这一处）。要动的就是 id=' + id
    + ' 那一行（连同它缩进内的附属键：name、config 等）。' + (edit === 'delete'
      ? '删掉多余的那几行后保存。'
      : '给其中一行换一个不会撞的 id，或删掉不再需要的那一行，然后保存。')
    + '改完**重启该环境**（patch 只在启动时读，不重启不生效）。'
  const recovery = '如果这个环境已经起不来：用 dsh --profile ' + (env.name.length > 0 ? env.name : '<环境名>')
    + ' --patch <一份空 patch.yml> 先把它拉起来，再按上面的位置改。'
  const uncertain = applied
    ? ''
    : '（注意：本次没有在官方组合结果里确认到这个 id，可能这个 patch 层当前没生效——'
      + '请按报出的文件与行号自己核对一遍再动手。）'
  return steps + uncertain + (main === 'profile-patch'
    ? '这份 patch 就是这个环境自己的 cordis.patch.yml。' + recovery
    : '这个文件来自安装的包（bundle 自带的那一层，随包升级会被覆盖）：长期处置走官方通道——'
      + '在官方插件页的已安装列表里把对应的组合包取消勾选（或卸载），由官方改组合层栈，我们不代写；'
      + '只想先让环境起来，可以按上面的行号临时删掉那一行（重新安装或升级该包后会被放回）。' + recovery)
}

/**
 * 一条发现的「作用域」标签：环境级的问题用**环境名**，包级的问题用**包名**。
 *
 * 环境名的权威来源是**目录名**（官方 resolveProfileDir(\`dsh --profile <name>\`) 的入参；
 * loadProfileDirectory 返回的 Profile.name = basename(dir)）。profile manifest 里的 name 只是
 * 初始化时写进去的一个值，之后不同步——用户手工重命名环境目录后它还是旧值，拿它当环境身份
 * 就会出现「同一页两个名字」（auditor 真机验证）。所以：
 *   · patch 落在环境目录内、且不在它的 node_modules 下 → 用户自己那份 cordis.patch.yml → 环境名；
 *   · 其它情况（包自带的 patch）→ 该包自己的 package.json name。
 *
 * @param envName - 环境名（EnvironmentInfo.name，即目录名）。
 * @param envDir - 环境目录绝对路径。
 * @param file - patch 文件绝对路径；缺省时 undefined。
 * @returns 作用域标签；两边都判不出来时 undefined（调用方按环境名兜底）。
 */
function scopeOfPatchFile(envName: string, envDir: string, file: string | undefined): string | undefined {
  if (file === undefined) return envName.length > 0 ? envName : undefined
  const inProfilePatch = isInside(envDir, file) && !isInside(join(envDir, 'node_modules'), file)
  if (inProfilePatch) return envName.length > 0 ? envName : undefined
  return packageNameOfFile(file) ?? (envName.length > 0 ? envName : undefined)
}

/**
 * 把解析出的启动阻断根因变成一条正式发现。
 *
 * @param blocker - bootBlockerFromError 的结果。
 * @returns 一条发现（severity 与 evidence 都来自解析，不在这里改判定）。
 */
function toBootIssue(blocker: BootBlocker): DiagnosticIssue {
  return makeIssue({
    layer: 'composition',
    severity: blocker.severity,
    code: blocker.code,
    title: blocker.title,
    detail: blocker.detail,
    subjects: blocker.subjects,
    evidence: blocker.evidence,
    extra: { operation: blocker.operation },
    id: blocker.id,
  })
}

/**
 * 合成结果里的启动阻断：**同一个 insert 列表内**重复 id。
 *
 * 这条由官方 composeEntries 自己抛（duplicate loader entry id: <id>），所以它一定致命；
 * duplicate-row-id 只扫原始文本、官方不可用时也在跑，两者互相补位。
 *
 * @param rows - 官方合成出的行。
 * @param env - 被诊断环境。
 * @returns 重复 id 的发现；没有重复时 undefined。
 */
function duplicateIdBootIssue(rows: readonly ComposedRow[], env: EnvironmentInfo): DiagnosticIssue | undefined {
  const seen = new Set<string>()
  for (const row of rows) {
    if (row.id.length === 0) continue
    if (!seen.has(row.id)) {
      seen.add(row.id)
      continue
    }
    return makeIssue({
      layer: 'composition',
      severity: 'confirm-fix',
      code: 'boot-blocker-row',
      title: '组合层启动被阻断：同一个 insert 列表里重复的 id ' + row.id,
      detail: '官方 composeEntries 在这个组合上直接抛 TypeError（duplicate loader entry id: ' + row.id + '）：'
        + '**整个 profile 起不来**，启动阶段就停在 plugin tree failed to load，HTTP 服务从未开始监听。'
        + '删掉多余的重复行（只保留一处）后**重启该环境**才会生效。'
        + '这条结论来自官方组合口径本身；具体改哪个文件、删哪一行见同一次报告里的 duplicate-row-id。',
      subjects: [row.id, env.name],
      evidence: [{
        kind: 'official',
        at: 'composeEntries(profile layers)',
        note: '官方合成时对同一 insert 列表内的重复 id 抛 duplicate loader entry id: ' + row.id,
      }],
      extra: { operation: '删除 ' + row.id + ' 的重复 insert 行（只保留一处），然后重启该环境' },
      id: 'boot-blocker-row:' + row.id,
    })
  }
  return undefined
}
/**
 * patch 文件归属的包名：从它的目录起往上找最近的 package.json（包根），读那一个包的 name。
 *
 * @param file - patch 文件绝对路径。
 * @returns 包名；找不到时 undefined。
 */
function packageNameOfFile(file: string): string | undefined {
  let dir = dirname(file)
  for (let depth = 0; depth < 6; depth += 1) {
    const manifest = readJsonFile(join(dir, 'package.json'))
    const name = manifest?.['name']
    if (typeof name === 'string' && name.length > 0) return name
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** 本次解析真正查过的根（写进 detail：结论必须说清查过什么，用户才能判断可信度）。 */
function resolutionRootsNote(envDir: string, facts: StaticFacts): string {
  const labels = [
    relativeTo(envDir, join(facts.envDir, 'node_modules')),
    relativeTo(envDir, join(dirname(resolve(envDir)), 'node_modules')),
    'Harness home 的 profiles/node_modules',
  ]
  if (facts.installRoots !== null) labels.push('安装锚点提供的模块根（' + facts.installAnchor + '）')
  else labels.push('安装锚点（不可用，见 skipped 的 install-anchor）')
  return labels.join('、') + '、以及 patch 文件自身的相对路径'
}

/** 读文本文件；读不到时 undefined。 */
function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** 读 JSON 文件；不是对象时 undefined。 */
function readJsonFile(path: string): Record<string, unknown> | undefined {
  const text = readTextFile(path)
  if (text === undefined) return undefined
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** 取对象字段（非对象返回 undefined）。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** 路径是否在目录内（含目录自身）。 */
function isInside(dir: string, candidate: string): boolean {
  const base = resolve(dir)
  const target = resolve(candidate)
  return target === base || target.startsWith(base + '/')
}

/** 相对路径（不在目录内时返回绝对路径）。 */
function relativeTo(base: string, file: string): string {
  const rel = relative(base, file)
  return rel.length === 0 || rel.startsWith('..') ? file : rel
}

/** 错误消息。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 运行时事实（official.ts 的 readRuntimeInventory 返回值）。 */
type RuntimeFacts = Awaited<ReturnType<typeof readRuntimeInventory>>

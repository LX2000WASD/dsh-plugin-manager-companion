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

import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { profilesRoot, readEnvironmentManifest, type EnvironmentManifest } from './paths.ts'
import { readRuntimeInventory } from './official.ts'
import type { CompanionConfig, DiagnosticsConfig } from './settings.ts'
import type {
  DiagnosticEvidence, DiagnosticFix, DiagnosticIssue, DiagnosticLayer, DiagnosticReport,
  DiagnosticSeverity, DiagnosticSkip, EnvironmentInfo,
} from './types.ts'

/** 传给官方装载函数（loadProfileDirectory / loadOptionalPatches）的诊断前缀。 */
const DIAG_BIN = 'dsh-plugin-manager-companion'

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
 * 对一个环境做完整诊断。
 *
 * 五层依次执行，任何一层失败只影响它自己：该层的失败原因写进 report.skipped，
 * 其余层照常产出。函数本身不抛错——诊断工具把异常抛给 UI 只能得到白屏。
 *
 * @param ctx - host 上下文；只用 ctx.get()（官方能力探测）与 ctx.logger。
 * @param env - 被诊断环境（EnvironmentInfo，来自环境列表）。
 * @param config - 本插件配置；同时接受 CompanionConfig 与单独的 diagnostics 段。
 * @returns 报告：分层问题数 + 问题清单 + 跳过项。
 */
export async function analyzeEnvironment(
  ctx: Context,
  env: EnvironmentInfo,
  config: CompanionConfig | DiagnosticsConfig,
): Promise<DiagnosticReport> {
  const diagnostics = normalizeDiagnosticsConfig(config)
  const issues: DiagnosticIssue[] = []
  const skipped: DiagnosticSkip[] = []
  const usedIds = new Set<string>()

  if (!existsSync(env.dir)) {
    skipped.push({ check: 'environment-dir', reason: '环境目录不存在：' + env.dir })
  }

  const facts = collectStaticFacts(env, diagnostics, skipped)
  const composition = await readComposition(ctx, env, facts)
  skipped.push(...composition.skips)

  let runtime: RuntimeFacts
  try {
    runtime = await readRuntimeInventory(ctx)
  } catch (error) {
    runtime = { entries: [], agentPresets: undefined, source: 'unavailable', reason: messageOf(error) }
  }
  if (runtime.source === 'unavailable') {
    skipped.push({
      check: 'runtime-inventory',
      reason: '运行时事实不可用（Loader 服务缺失，或官方投影与 Loader 直读都失败）：'
        + (runtime.reason ?? '原因未知'),
    })
  }

  const layers: readonly {
    readonly layer: DiagnosticLayer
    readonly run: () => DiagnosticIssue[]
  }[] = [
    { layer: 'dependency', run: () => dependencyLayer(env, facts, composition) },
    { layer: 'composition', run: () => compositionLayer(env, facts, composition) },
    { layer: 'runtime', run: () => runtimeLayer(env, facts, composition, runtime) },
    { layer: 'consistency', run: () => consistencyLayer(env, facts, composition, runtime) },
    { layer: 'ecosystem', run: () => ecosystemLayer() },
  ]

  for (const entry of layers) {
    if (!layerEnabled(diagnostics, entry.layer)) {
      skipped.push({
        check: entry.layer + '-layer',
        reason: '配置里关闭了该层（settings.diagnostics.' + entry.layer + '）',
      })
      continue
    }
    try {
      issues.push(...entry.run())
    } catch (error) {
      // 单层内部异常：如实登记为"这次没查成"，不让其余四层的结论被吞掉。
      skipped.push({ check: entry.layer + '-layer', reason: '该层执行失败：' + messageOf(error) })
    }
  }

  // L5 只留骨架：索引抓取归市场模块，本模块不在诊断路径上访问网络。
  if (diagnostics.ecosystem && issues.every(issue => issue.layer !== 'ecosystem')) {
    skipped.push({
      check: 'ecosystem-index',
      reason: '生态层骨架：市场索引（更新可用、已知风险）由市场模块提供，本模块不做网络请求，'
        + '因此这一层当前没有可判定的事实。',
    })
  }

  return {
    environment: env.name,
    generatedAt: new Date().toISOString(),
    counts: countByLayer(issues),
    issues: issues.map(issue => ({ ...issue, id: uniqueId(issue.id, usedIds) })),
    skipped,
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
  /** 因预算或上限未扫描的包名。 */
  readonly unscanned: readonly string[]
}

/** 收集静态事实：manifest、两层 node_modules、包扫描、依赖边。 */
function collectStaticFacts(
  env: EnvironmentInfo,
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

  const roots = moduleRoots(envDir)
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
    const peerDir = findInstalledDir(moduleRoots(facts.envDir), peer)
    if (peerDir === undefined) {
      issues.push(makeIssue({
        layer: 'dependency',
        severity: 'report-only',
        code: 'missing-peer',
        title: name + ' 的 peer ' + peer + ' 未安装',
        detail: name + ' 声明 peerDependencies.' + peer + '，但环境里找不到它。'
          + 'peer 由共享兜底层满足，缺失时该包的运行期契约无法保证。',
        subjects: [name, peer],
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

/** 组合层事实：官方合并结果 + 原始行号。 */
interface CompositionFacts {
  readonly rows: readonly ComposedRow[]
  readonly rawRows: readonly RawRow[]
  readonly skips: readonly DiagnosticSkip[]
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
  const profileContext = ctx.get('profileContext') as { readonly installAnchor?: string } | undefined
  const installAnchor = profileContext?.installAnchor
  const rawRows: RawRow[] = []
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
    skips.push({
      check: 'composition-official',
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

  return { rows: rows ?? [], rawRows, skips, effectiveState: rows !== undefined }
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
    const dir = facts.packageDirs.get(bundle) ?? findInstalledDir(moduleRoots(envDir), bundle)
    if (dir === undefined) continue
    const manifest = facts.manifests.get(bundle) ?? readJsonFile(join(dir, 'package.json'))
    const declared = asRecord(asRecord(manifest?.['dsh'])?.['bundle'])?.['patch']
    if (typeof declared !== 'string') continue
    files.push(join(dir, declared))
  }
  return files
}

/** L2：行 id 重复、被禁用依赖、孤立行、无显式 id 的行。 */
function compositionLayer(
  env: EnvironmentInfo,
  facts: StaticFacts,
  composition: CompositionFacts,
): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = []

  // 1. duplicate-row-id：同一 group 路径下同一个显式 id 出现多次。
  //    官方 loader 的 Group.update() 对同一组内的重复 id 直接抛
  //    TypeError("duplicate loader entry id: <id>")，整个 profile 起不来。
  const byGroup = new Map<string, RawRow[]>()
  for (const row of composition.rawRows) {
    if (row.id === undefined) continue
    const key = (row.group ?? '') + '|' + row.id
    const list = byGroup.get(key) ?? []
    list.push(row)
    byGroup.set(key, list)
  }
  for (const rows of byGroup.values()) {
    if (rows.length < 2) continue
    const id = rows[0]?.id ?? ''
    const group = rows[0]?.group
    issues.push(makeIssue({
      layer: 'composition',
      severity: 'safe-fix',
      code: 'duplicate-row-id',
      title: 'loader 行 id 重复：' + id,
      detail: 'id ' + id + ' 在' + (group === undefined ? '同一个 insert 列表里' : ' group ' + group + ' 下')
        + '出现了 ' + rows.length + ' 次。官方 loader 挂载时对同组重复 id 直接抛 '
        + 'duplicate loader entry id，**整个 profile 无法启动**。保留一行、删掉其余重复行即可恢复；'
        + '两行内容不同时先确认要保留哪一份配置。',
      subjects: [id, ...(group === undefined ? [] : [group])],
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
        summary: '保留第一处 id ' + id + ' 的行，删除其余 ' + (rows.length - 1) + ' 处重复行',
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
      evidence: [{ kind: 'file', at, note: '缺少显式 id 的 insert 行' }],
      id: 'unaddressable-row:' + at,
    }))
  }

  // 3. orphan-row：insert 行的 name 解析不到任何模块。
  for (const row of composition.rawRows) {
    const name = row.name
    if (name === undefined || name.length === 0) continue
    if (rowTargetResolves(env.dir, row.file, name)) continue
    issues.push(makeIssue({
      layer: 'composition',
      severity: 'confirm-fix',
      code: 'orphan-row',
      title: 'insert 行的模块名解析不到：' + name,
      detail: 'patch 插入了 name=' + name + ' 的行，但该说明符在 profile 的 node_modules、'
        + '共享兜底层与相对路径下都解析不到。挂载时 ERR_MODULE_NOT_FOUND 会让这一行失败。'
        + '两种修法：把包装进来，或删掉这一行。',
      subjects: [name],
      evidence: [{ kind: 'file', at: relativeTo(env.dir, row.file) + ':' + row.line, note: '解析不到的 insert 行' }],
      fix: {
        action: 'remove-row',
        target: row.id ?? name,
        summary: '删掉 name=' + name + ' 的 insert 行，或先安装 ' + name,
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

/** 一个 patch 行里的模块名能否解析到。 */
function rowTargetResolves(envDir: string, patchFile: string, name: string): boolean {
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
  return specifierResolves(envDir, name)
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
  const roots = moduleRoots(facts.envDir)
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

/** 环境的模块解析根（profile 层优先，其次共享兜底层与 Harness home 的 profiles 兜底）。 */
function moduleRoots(envDir: string): string[] {
  const roots = [join(envDir, 'node_modules')]
  const sibling = join(dirname(resolve(envDir)), 'node_modules')
  if (sibling !== roots[0]) roots.push(sibling)
  const shared = join(profilesRoot(), 'node_modules')
  if (!roots.includes(shared)) roots.push(shared)
  return roots
}

/**
 * 一个包在某个环境里的安装目录（profile 层优先，其次共享兜底层与 Harness home 的 profiles 兜底）。
 *
 * 质量门与诊断共用这一套解析顺序，避免两处口径漂移。
 *
 * @param envDir - 环境目录。
 * @param packageName - 包名。
 * @returns 包目录绝对路径；未安装时 undefined。
 */
export function installedPackageDir(envDir: string, packageName: string): string | undefined {
  return findInstalledDir(moduleRoots(envDir), packageName)
}

/** 在解析根里找已安装的包目录。 */
function findInstalledDir(roots: readonly string[], name: string): string | undefined {
  for (const root of roots) {
    const dir = join(root, name)
    if (existsSync(join(dir, 'package.json'))) return dir
  }
  return undefined
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
 * @returns 能否解析到模块。
 */
export function specifierResolves(envDir: string, spec: string): boolean {
  if (isBuiltin(spec)) return true
  const pkgName = packageNameOf(spec)
  if (pkgName === undefined) return false
  const dir = findInstalledDir(moduleRoots(envDir), pkgName)
  if (dir === undefined) return false
  const subpath = spec.slice(pkgName.length)
  if (subpath.length === 0) return true
  try {
    createRequire(join(envDir, 'package.json')).resolve(spec)
    return true
  } catch {
    // conditional export 可能只给 import 条件，require 解析失败不代表不可用：继续探测。
  }
  const relativePath = subpath.replace(/^\/+/, '')
  if (resolveRelativeFile(dir, relativePath) !== undefined) return true
  const manifest = readJsonFile(join(dir, 'package.json'))
  const exportsField = manifest?.['exports']
  if (exportsField !== undefined) return exportsDeclaresSubpath(exportsField, './' + relativePath)
  return false
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
  }
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

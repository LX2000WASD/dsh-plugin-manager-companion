/**
 * 客户端共享层 — 自有 REST 调用面、状态控制器与官方插件页 slot 契约的镜像。
 *
 * 归属：A 类·重写（旧仓库 src/client/api.ts 与 store.ts 只作意图参考，未复制代码）。
 * 旧实现参考：dsh-web-plugin-manager/src/client/*（理解"客户端要读什么、什么时候刷新"的意图）。
 * 官方复用：@deepseek-ai/dsh-client-store 的 createSnapshotStore（状态容器）、
 *   @deepseek-ai/dsh-client-ui-slots 的 ComposedProps/EntryKeyOf（组件 props 的组合别名）、
 *   @deepseek-ai/dsh-client-ui-settings/client 的 ctx.settingsScope（配置读写，不碰 YAML）。
 * 前提检查：旧实现自带 27 个 op 的客户端 SDK + 乐观更新 + 自建 job 轮询。0.1.6 之后
 *   官方能力（插件启停/安装/清单）客户端直连官方 Remote，本插件的自有能力按
 *   docs/REST-CONTRACT.md 走 /api2/companion；乐观更新被取消（变更必须等 job 落定）。
 *
 * 四条纪律：
 *   1. 变更类请求不带 AbortSignal（中止只杀传输，会留下"改了但没反馈"的状态），
 *      只有加载类请求可以带。
 *   2. 组件不订阅任何外部源：控制器持有 SnapshotStore，经 inject 的 hooks 隔间
 *      合成 use<Name> 选择器 Hook。
 *   3. 这一层不认识 React，也不认识 ctx；它只做数据与动作。
 *   4. **外来数据在这里归一**：REST 与官方 settings 的返回值先过 wire.ts 的归一函数，
 *      再进 SnapshotStore。组件因此可以按类型直接读字段——这一步是实测驱动的：不归一
 *      时，一个缺字段的载荷会让官方 SlotErrorBoundary 把整个 settings.section 渲染成空 div。
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { relativeTime, type RelativeTimeUnit, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComposedProps, EntryKeyOf, SlotMap, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import { securityLabelKey, statusLabelKey, typeLabelKey, type MarketLabelKey } from '../marketView.ts'
import type { OfficialCapabilities } from '../official.ts'
import type { MarketTagKind } from '../tags.ts'
import type { CompanionConfig } from '../settings.ts'
import type {
  DiagnosticGroup, DiagnosticIssue, DiagnosticLayer, DiagnosticReport, DiagnosticSeverity, EnvironmentBackup,
  EnvironmentBackupDiff, EnvironmentInfo, EnvironmentResult, GatedInstallResult,
  InstalledKind, KindListResult, MarketItemKind, MarketplaceResult,
} from '../types.ts'
import { NS, type CompanionLocaleKey } from './locales.ts'
import {
  normalizeAbout, normalizeBackup, normalizeBackupDiff, normalizeCapabilities, normalizeConfig,
  normalizeEnvironmentResult, normalizeEnvironments, normalizeGatedInstall, normalizeKindList,
  normalizeMarketplace, normalizeReport, normalizeTrialCleanup, normalizeTrialDisclosure,
  normalizeTrialEnvironments, normalizeUpgradeAction, normalizeUpgradeCheck, normalizeUpgradeRollback,
  type AboutFactsView, type ClientConfig, type TrialDisclosureView, type TrialEnvironmentsView,
  type TrialOutcomeView, type UpgradeCheckView,
} from './wire.ts'
import { canaryVerdict, upgradeOutcome, type UpgradeOutcomeKind } from '../upgradeView.ts'

/**
 * 官方 settings 服务上本插件的命名空间。
 *
 * 与 host 侧 src/settings.ts 的 SETTINGS_NAMESPACE 必须一致；这里刻意不 import 那个
 * 模块的值：它是一个 host 模块（值会拉进 schemastery 与整套 host 代码），客户端只
 * 认这个字符串。改名时必须两处同改（settings.ts 的 schema 注册会拒绝未知命名空间）。
 */
export const SETTINGS_NAMESPACE = 'plugin-manager-companion'

// ── 自有 REST 契约（docs/REST-CONTRACT.md）───────────────────────────────

/** 自有 REST 的路由前缀（host 侧 src/rest.ts 的 ROUTE_PREFIX）。 */
export const REST_PREFIX = '/api2/companion'

/**
 * REST 调用失败。code 是稳定机器码（见 REST-CONTRACT 的错误码表），
 * message 面向用户，可直接展示。
 */
export class CompanionError extends Error {
  /**
   * @param code - 稳定机器码。
   * @param message - 面向用户的说明。
   */
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'CompanionError'
  }
}

/** host 的响应信封（镜像 src/rest.ts 的 Envelope<T>）。 */
type Envelope<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** job 状态（镜像 src/rest.ts 的 JobRegistry.status 返回值）。 */
interface JobStatus<T> {
  readonly done: boolean
  readonly result?: T
  readonly error?: string
  readonly missing?: true
}

/**
 * 调用一个自有 op。
 *
 * @param op - 操作名。
 * @param body - 请求体（JSON-safe）。
 * @param signal - 仅加载类请求可传；变更类一律不传。
 * @returns 信封里的 value。
 * @throws {CompanionError} 信封为失败，或 HTTP 层失败时。
 */
export async function callOp<T>(op: string, body: unknown = {}, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${REST_PREFIX}/${op}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      // 同源相对路径：不拼绝对 URL（REST-CONTRACT 的客户端安全注意）。
      credentials: 'same-origin',
      ...signal === undefined ? {} : { signal },
    })
  } catch (error) {
    throw new CompanionError('transport', error instanceof Error ? error.message : String(error))
  }
  if (response.status === 429) {
    throw new CompanionError('busy', 'too many operations in flight; wait for one to finish')
  }
  let envelope: Envelope<T>
  try {
    envelope = await response.json() as Envelope<T>
  } catch (error) {
    throw new CompanionError('bad-json', error instanceof Error ? error.message : String(error))
  }
  if (!envelope.ok) throw new CompanionError(envelope.error.code, envelope.error.message)
  return envelope.value
}

/** 轮询节奏：前 1.5 秒每 250ms（首屏快），之后每 1.5 秒（长期不轰炸）。 */
const POLL_FAST_MS = 250
const POLL_FAST_WINDOW_MS = 1500
const POLL_SLOW_MS = 1500

/** 可注入的等待实现，测试可替换。 */
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new CompanionError('aborted', 'request aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new CompanionError('aborted', 'request aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

/**
 * 跑一个被 job 化的长操作：POST 拿 jobId，再轮询 job 直到落定。
 *
 * 为什么必须等：变更类操作在服务端推进，HTTP 超时与服务端状态会脱节；乐观更新
 * 会让 UI 显示一个并未发生的成功（REST-CONTRACT 明确禁止）。
 *
 * @param op - 操作名。
 * @param body - 请求体。
 * @param signal - 加载类长操作可传，用于中止轮询。
 * @returns job 的最终结果。
 * @throws {CompanionError} job 失败、结果丢失或轮询被中止时。
 */
export async function runJob<T>(op: string, body: unknown = {}, signal?: AbortSignal): Promise<T> {
  const started = await callOp<{ jobId?: string } | string | T>(op, body, signal)
  const jobId = jobIdOf(started)
  // 契约把长操作 job 化（REST-CONTRACT 声明的信封是 `{ jobId }`），但也容忍 host 把长操作
  // 实现成同步返回：**认得出 job id 才轮询**，否则那个值就是结果。这样"host 先同步实现、
  // 以后改 job"不需要客户端改代码。
  if (jobId === undefined) return started as T
  const startedAt = Date.now()
  for (;;) {
    const status = await callOp<JobStatus<T>>('job', { id: jobId }, signal)
    if (status.missing === true) throw new CompanionError('job-missing', `job ${jobId} expired before it settled`)
    if (status.done) {
      if (status.error !== undefined) throw new CompanionError('operation-failed', status.error)
      return status.result as T
    }
    await sleep(Date.now() - startedAt < POLL_FAST_WINDOW_MS ? POLL_FAST_MS : POLL_SLOW_MS, signal)
  }
}

/**
 * 认出一个 op 返回值里的 job id。
 *
 * 两种形状都认：
 *   - `{ jobId }`：docs/REST-CONTRACT.md 声明的信封；
 *   - **裸 id 字符串**：host 侧 JobRegistry.start() 实际返回的形状（实测 2026-09-19：
 *     它直接返回 `string`，op 信封里的 value 就是 `"mu7d…-1"`）。
 *
 * 认错的代价是实测过的：把裸 id 当成结果用，`report.counts` 是 undefined，HealthPanel 在
 * `report.counts[layer]` 上抛 TypeError，官方 SlotErrorBoundary 把整个 settings.section
 * 渲染成一个空 div —— 用户看到的就是"点开环境控制台一片空白"。
 *
 * 只认这两种形状，且本插件的长操作结果都是对象（诊断报告 / 操作结果信封），所以
 * "字符串即 job id"没有歧义。
 *
 * @param value - op 的返回值。
 * @returns job id；该值本身就是结果时 undefined。
 */
function jobIdOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined
  if (value === null || typeof value !== 'object') return undefined
  const candidate = (value as { jobId?: unknown }).jobId
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined
}

/** 本插件诊断的修复 op。
 *
 * 契约缺口：docs/REST-CONTRACT.md 的操作表还没有这个 op，而 src/types.ts 的
 * DiagnosticFix 明确写了"host 端据此分派"。这里先按 DiagnosticFix 的字段调用，
 * op 名集中在这一个常量里，等 Lead 定稿后改名只动这一行。 */
const FIX_OP = 'fix'

// ── 官方插件页 slot 契约（镜像官方声明）──────────────────────────────────

/**
 * 官方 `plugins.*` 配置面的 owner props（镜像官方
 * packages/client/ui-plugin-manager/src/client/slot-contract.ts 的
 * PluginConfigViewProps；官方包不在本仓库的安装集里，所以这里按逐字镜像声明）。
 *
 * 漂移风险：官方若改这个契约，必须同步这里——注册面本身是编译期检查的，
 * 运行期由官方页面渲染，类型对不上就是渲染出错的第一个信号。
 */
export interface PluginConfigViewProps {
  /** summary 只渲染标题下的一句话；page 渲染带自己保存控件的表单。 */
  readonly view: 'summary' | 'page'
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** 官方插件页的官方插件卡片（list）。 */
    'plugins.item': { kind: 'list'; scope: 'root'; owner: PluginConfigViewProps }
    /** 一个组合包自己的配置，key 是包名（keyed）。 */
    'plugins.bundle.config': { kind: 'keyed'; scope: 'root'; owner: PluginConfigViewProps }
    /** 一行自己的配置，key 是 `<包名>#<行 id>`（keyed）。 */
    'plugins.row.config': { kind: 'keyed'; scope: 'root'; owner: PluginConfigViewProps }
  }
}

/**
 * 一个本插件注册项的完整组件 props：官方组合别名 + 本插件字典命名空间的 t 座位。
 * 直接用官方 ComposedProps，绝不手写派生成员（packages/client/AGENTS.md 的 slot 纪律）。
 */
export type CompanionSlotProps<K extends keyof SlotMap & string, I extends object> =
  ComposedProps<K, EntryKeyOf<K>, never, undefined, I, never, typeof NS>

// ── 纯函数映射（B 类：参考旧实现的意图后重写）────────────────────────────

/** 诊断层的展示顺序与字典键。 */
export const LAYER_ORDER: readonly DiagnosticLayer[] = [
  'dependency', 'composition', 'runtime', 'consistency', 'ecosystem',
]

/** 层 → 字典键。 */
export const LAYER_LABEL: Readonly<Record<DiagnosticLayer, CompanionLocaleKey>> = {
  dependency: 'health.layer.dependency',
  composition: 'health.layer.composition',
  runtime: 'health.layer.runtime',
  consistency: 'health.layer.consistency',
  ecosystem: 'health.layer.ecosystem',
}

/** 诊断层 → 配置表单里的标签键（与体检页的层名分开：一处是报告，一处是开关）。 */
export const DIAGNOSTIC_LABEL: Readonly<Record<DiagnosticLayer, CompanionLocaleKey>> = {
  dependency: 'config.diagnostics.dependency',
  composition: 'config.diagnostics.composition',
  runtime: 'config.diagnostics.runtime',
  consistency: 'config.diagnostics.consistency',
  ecosystem: 'config.diagnostics.ecosystem',
}

/** 处置等级 → 字典键。 */
export const SEVERITY_LABEL: Readonly<Record<DiagnosticSeverity, CompanionLocaleKey>> = {
  'safe-fix': 'severity.safe-fix',
  'confirm-fix': 'severity.confirm-fix',
  'report-only': 'severity.report-only',
}

/** 处置等级 → Tag 色调（可自动修复是好消息，只报告才是需要读者注意的）。 */
export const SEVERITY_TONE: Readonly<Record<DiagnosticSeverity, TagTone>> = {
  'safe-fix': 'info',
  'confirm-fix': 'warning',
  'report-only': 'danger',
}

/** 市场条目类型 → 字典键。 */
export const KIND_LABEL: Readonly<Record<MarketItemKind, CompanionLocaleKey>> = {
  'cordis-plugin': 'market.kind.cordis-plugin',
  'skill': 'market.kind.skill',
  'agent-preset': 'market.kind.agent-preset',
  'unknown': 'market.kind.unknown',
}

/**
 * 市场纯函数模块给出的字典键 → 本插件字典键。
 *
 * 市场管道（src/marketView.ts）只产出**键名**，文案归字典所有；这里做一次映射，
 * 类型上要求 MarketLabelKey 全集，少一个键就编译失败。
 */
export const MARKET_LABEL: Readonly<Record<MarketLabelKey, CompanionLocaleKey>> = {
  sortStars: 'market.sort.stars',
  sortTrending: 'market.sort.trending',
  sortAz: 'market.sort.az',
  sortUpdated: 'market.sort.updated',
  sortCategory: 'market.sort.category',
  sortAsc: 'market.sort.asc',
  sortDesc: 'market.sort.desc',
  filterCategory: 'market.filterCategory',
  typeCordisPlugin: 'market.type.cordis-plugin',
  typeSkill: 'market.type.skill',
  typeAgentPreset: 'market.type.agent-preset',
  statusVerified: 'market.status.verified',
  statusArchived: 'market.status.archived',
  statusPending: 'market.status.pending',
  securityLow: 'market.security.low',
  securityMedium: 'market.security.medium',
  securityHigh: 'market.security.high',
  securityUnknown: 'market.security.unknown',
}

/**
 * 健康分：满分 100，按最严重的处置等级扣分。
 *
 * 旧实现按问题条数线性扣分，一个 C 级问题就能把分数打到 0，读数失去意义；
 * 这里改成按等级加权——可自动修复扣 5、需确认扣 10、只报告扣 20，下限 0。
 *
 * @param issues - 报告里的发现。
 * @returns 0..100 的整数。
 */
export function healthScore(issues: readonly DiagnosticIssue[]): number {
  let penalty = 0
  for (const issue of issues) {
    penalty += issue.severity === 'safe-fix' ? 5 : issue.severity === 'confirm-fix' ? 10 : 20
  }
  return Math.max(0, 100 - penalty)
}

/** 相对时间的桶 → 字典键（词条归字典所有，分桶由官方 relativeTime 给出）。 */
export const RELATIVE_LABEL: Readonly<Record<RelativeTimeUnit, CompanionLocaleKey>> = {
  now: 'time.now',
  minutes: 'time.minutes',
  hours: 'time.hours',
  days: 'time.days',
  months: 'time.months',
  years: 'time.years',
}

/**
 * 把 ISO 时间渲染成"刚刚 / 5 分钟前…"。
 *
 * 分桶用官方 relativeTime（两个界面说同一时刻必须用同一个桶），词条来自本插件字典。
 * now 取调用时刻：这是展示函数，不参与纯计算，也不需要 uSES 语义。
 *
 * @param t - 本插件字典的翻译函数。
 * @param iso - ISO 8601 时间串；无法解析时原样返回。
 * @returns 已本地化的相对时间文本。
 */
export function formatRelative(t: TranslateNS<typeof NS>, iso: string): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return iso
  const bucket = relativeTime(at, Date.now())
  return t(RELATIVE_LABEL[bucket.unit], { n: bucket.n })
}

/**
 * 一个层值 → 字典键。
 *
 * 报告来自外部（host），所以层值可能是本客户端不认识的字符串；此时返回 undefined，
 * 由组件回退成显示原始 id。直接 `t(LAYER_LABEL[layer])` 会把未知值渲染成 undefined。
 *
 * @param layer - 报告里的层值。
 * @returns 字典键；未知层值时 undefined。
 */
export function layerLabelKey(layer: string): CompanionLocaleKey | undefined {
  return (LAYER_LABEL as Readonly<Record<string, CompanionLocaleKey | undefined>>)[layer]
}

/**
 * 处置等级 → 字典键。
 * @param severity - 报告里的等级值。
 * @returns 字典键；未知等级时 undefined。
 */
export function severityLabelKey(severity: string): CompanionLocaleKey | undefined {
  return (SEVERITY_LABEL as Readonly<Record<string, CompanionLocaleKey | undefined>>)[severity]
}

/**
 * 处置等级 → Tag 色调。
 * @param severity - 报告里的等级值。
 * @returns 色调；未知等级按"需注意"显示（绝不把未知降级成好色调）。
 */
export function severityToneOf(severity: string): TagTone {
  return (SEVERITY_TONE as Readonly<Record<string, TagTone | undefined>>)[severity] ?? 'warning'
}

/**
 * 证据类型 → 展示用标识。
 * @param kind - 证据里的类型值。
 * @returns 展示标识；未知类型原样显示（技术标识不做翻译）。
 */
export function evidenceKindOf(kind: string): string {
  return (EVIDENCE_KIND as Readonly<Record<string, string | undefined>>)[kind] ?? kind
}

/**
 * 一条发现是否属于某个分组。
 *
 * 判据只用 wire 上真实存在的字段（层 / 类别 / 等级 + 作用域清单），**不重算 host 的组键格式**：
 * 键是实现细节，而"这一组包含哪些发现"必须能从契约字段推出来。发现自身没有 scope 时按
 * 空串对待（与 host 的"无法归属即空串"一致）；组没有作用域清单时，层+类别+等级相同即同组。
 *
 * @param issue - 一条发现。
 * @param group - 报告里的一个分组。
 * @returns 属于该组时为 true。
 */
export function issueInGroup(issue: DiagnosticIssue, group: DiagnosticGroup): boolean {
  if (issue.layer !== group.layer || issue.code !== group.code || issue.severity !== group.severity) return false
  if (group.scopes.length === 0) return true
  const scope = issue.scope ?? ''
  return group.scopes.some(entry => entry.scope === scope)
}

/** 证据类型 → 展示用前缀（不做翻译：文件/运行时/官方是技术标识）。 */
export const EVIDENCE_KIND: Readonly<Record<'file' | 'runtime' | 'official', string>> = {
  file: 'file',
  runtime: 'runtime',
  official: 'official',
}

// ── 状态控制器 ───────────────────────────────────────────────────────────

/**
 * 体检子页的状态。
 *
 * 字段刻意**不是** readonly：这是 SnapshotStore 的 draft，控制器通过 update 就地改它。
 */
export interface HealthState {
  report: DiagnosticReport | undefined
  running: boolean
  error: string | undefined
  /** 客户端自己判定的失败（载荷残缺等）；文案归字典，控制层只给键。 */
  errorKey?: CompanionLocaleKey
  /**
   * 当前这条失败**来自哪个动作**：诊断还是修复。
   *
   * 为什么必须是显式字段：靠"notice 写过没有"这种间接线索归因时不成立——修复走 callOp 抛异常
   * 的那条路径只写 error、不写 notice，界面于是把"修复失败"说成"体检失败"（真机实测的 P1）。
   * 写入规则：谁写下当前这条失败，谁就写这里；它描述的失败被清掉时同步清成 undefined。
   */
  failureFrom?: 'diagnose' | 'fix' | undefined
  /**
   * 诊断目标环境名；undefined 表示当前环境。
   *
   * 为什么保留 undefined 而不是在控制器里解析成当前环境名：控制器不认识 profile 列表
   * （那是 host 的事实）。界面把"用户选的就是当前环境"折回 undefined，语义只有两个：
   * "当前环境"与"某个具名环境"。
   */
  target: string | undefined
  /** 正在执行修复的 issue id。 */
  fixingId: string | undefined
  /** 最近一次修复的输出。 */
  notice: string | undefined
  /** 官方能力探针：哪里能力缺失要如实告诉用户，而不是把缺失伪装成健康。 */
  capabilities: OfficialCapabilities | undefined
}

/** 体检子页的注入面：hooks 隔间合成 useHealth 选择器 Hook。 */
export interface HealthFace {
  hooks: { health: SnapshotStore<HealthState> }
  /** 跑一次全量（或指定层）诊断。 */
  diagnose(layers?: readonly DiagnosticLayer[]): void
  /** 执行一条发现的修复动作。 */
  fix(issue: DiagnosticIssue): void
  /**
   * 切换诊断目标环境；undefined 表示当前环境。
   *
   * 切换会**立刻丢弃**上一份报告（报告属于某个环境，跨环境复用它的展开状态与修复按钮
   * 就是事故），并立即重跑诊断；在途的那次响应按代号作废。
   */
  setDiagnosticTarget(environment: string | undefined): void
}

/** 体检控制器：持有报告状态，动作全部走自有 REST。 */
export class HealthController {
  private readonly store: SnapshotStore<HealthState>
  /**
   * 诊断代号：每次目标切换或重新诊断自增。
   *
   * 用途唯一——作废在途的响应。用户在诊断跑到一半时切了环境，旧环境的报告绝不能
   * 落进新目标的状态里（那会让"报告属于哪个环境"变成一个谎言）。
   */
  private generation = 0
  /**
   * 诊断与修复**各记各的失败**：诊断成功只清自己写下的那条，修复失败不会被顺手抹掉
   * （与 client-dev 在 task-18 修的 ReadFailureLedger 同一思路——读的成功不该清掉操作的失败）。
   */
  private readonly diagnoseFailure = new ReadFailureLedger()
  private readonly fixFailure = new ReadFailureLedger()

  constructor() {
    this.store = createSnapshotStore<HealthState>({
      report: undefined, running: false, error: undefined, failureFrom: undefined, fixingId: undefined,
      notice: undefined, capabilities: undefined, target: undefined,
    })
  }

  /** 供注册项使用的注入面。 */
  inject(): HealthFace {
    return {
      hooks: { health: this.store },
      diagnose: (layers) => { void this.diagnose(layers) },
      fix: (issue) => { void this.fix(issue) },
      setDiagnosticTarget: (environment) => { this.setTarget(environment) },
    }
  }

  /**
   * 切换诊断目标环境。
   * @param environment - 目标环境名；undefined 表示当前环境。
   */
  setTarget(environment: string | undefined): void {
    const next = environment === undefined || environment === '' ? undefined : environment
    if (this.store.getSnapshot().target === next) return
    this.generation += 1
    this.store.update((draft) => {
      draft.target = next
      draft.report = undefined
      draft.fixingId = undefined
      draft.notice = undefined
      // 只清诊断自己写下的失败：切目标不该抹掉"上一次修复失败"这条事实。
      if (this.diagnoseFailure.clearOwn(draft)) draft.failureFrom = undefined
    })
    void this.diagnose()
  }

  /**
   * 跑一次诊断（用户动作）。
   *
   * 会清掉上一条**动作结果**（notice）：用户主动体检即"处置"了上一次动作留下的提示。
   * @param layers - 只诊断这些层；省略即按配置全量。
   */
  async diagnose(layers?: readonly DiagnosticLayer[]): Promise<void> {
    await this.runDiagnosis(layers, { keepNotice: false })
  }

  /**
   * 修复之后的自动刷新：报告必须更新，但修复的结果提示要留着。
   *
   * 为什么不能直接用 diagnose()：那是"用户主动体检"，开头会清 notice；而这条 notice 是用户
   * 刚点的那个修复动作的产物（成功与失败都一样），在同一个 0ms 内被清掉等于用户什么都没看到
   * （真机实测时间线：+0ms 写 notice → +0ms 被自动刷新清掉）。
   */
  private async refreshAfterFix(): Promise<void> {
    await this.runDiagnosis(undefined, { keepNotice: true })
  }

  /**
   * 诊断主体：两条入口（用户体检 / 修复后的自动刷新）只差"要不要保留上一条动作结果"。
   * @param layers - 只诊断这些层；省略即按配置全量。
   * @param options - keepNotice 为真时保留上一条动作结果（修复的产物）。
   */
  private async runDiagnosis(
    layers: readonly DiagnosticLayer[] | undefined,
    options: { readonly keepNotice: boolean },
  ): Promise<void> {
    const generation = ++this.generation
    const target = this.store.getSnapshot().target
    this.store.update((draft) => {
      draft.running = true
      // 只清**诊断自己**上一次写下的失败：修复失败要留在页面上（它是操作的事实，不是这次读的结果）。
      if (this.diagnoseFailure.clearOwn(draft)) draft.failureFrom = undefined
      if (!options.keepNotice) draft.notice = undefined
    })
    try {
      // 目标环境由 host 决定语义：省略即当前环境；指定的环境不存在时 host 返回
      // operation-failed（绝不悄悄退回当前环境），界面据此如实报错。
      const raw = await runJob<unknown>('diagnose', {
        ...layers === undefined ? {} : { layers },
        ...target === undefined ? {} : { environment: target },
      })
      if (generation !== this.generation) return
      const report = normalizeReport(raw, LAYER_ORDER)
      if (report === undefined) {
        // 载荷不可用时不渲染半个报告：如实报"失败"，页面照常可读（绝不空白）。
        this.store.update((draft) => {
          draft.running = false
          draft.errorKey = this.diagnoseFailure.record('error.incompletePayload')
          draft.failureFrom = 'diagnose'
        })
        return
      }
      this.store.update((draft) => { draft.report = report; draft.running = false })
      // 顺带读一次官方能力探针：报告里的 skipped 已说明缺口，这里给出更直接的一句话。
      // 读不到就保持 undefined（不伪造"能力齐全"），失败原因由报告承担。
      try {
        const info = await callOp<{ capabilities?: unknown }>('capabilities', {})
        if (generation !== this.generation) return
        const capabilities = normalizeCapabilities(info.capabilities)
        if (capabilities !== undefined) this.store.update((draft) => { draft.capabilities = capabilities })
      } catch {
        // 探针本身失败不是体检失败：报告已经生成了。
      }
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((draft) => {
        draft.running = false
        draft.error = this.diagnoseFailure.record(error instanceof Error ? error.message : String(error))
        draft.failureFrom = 'diagnose'
      })
    }
  }

  /**
   * 执行一条修复动作。
   * @param issue - 带 fix 的发现。
   */
  async fix(issue: DiagnosticIssue): Promise<void> {
    // 不变式：修复只在"目标是当前环境"时被界面渲染出来（官方写通道只覆盖当前环境，
    // 见 ConsolePage 的 HealthPanel）。控制器不重复判断——它拿不到 profile 事实。
    const action = issue.fix
    if (action === undefined) return
    // 开跑时只清**上一条修复失败**（用户重新发起修复=处置完成）；诊断失败不是这次动作写的，留着。
    this.store.update((draft) => {
      draft.fixingId = issue.id
      if (this.fixFailure.clearOwn(draft)) draft.failureFrom = undefined
      draft.notice = undefined
    })
    try {
      // 结果必须归一：形状不符时 normalizeEnvironmentResult 给出 ok=false + 明确 code，
      // 否则 result.output/code 都是 undefined，失败会被静默吞掉（页面上什么都不显示）。
      const result = normalizeEnvironmentResult(
        await runJob<unknown>(FIX_OP, { action: action.action, ...action.target === undefined ? {} : { target: action.target } }))
      this.store.update((draft) => {
        draft.fixingId = undefined
        draft.notice = result.output
        if (!result.ok) {
          draft.error = this.fixFailure.record(result.code ?? result.output)
          draft.failureFrom = 'fix'
        }
      })
      // 自动刷新而不是"用户体检"：报告要更新，但刚写的修复结果要留住（否则 0ms 内被清掉）。
      if (result.ok) await this.refreshAfterFix()
    } catch (error) {
      // 抛异常这条路径以前只写 error、不写 notice，界面据此把归因退回"体检失败"（真机 P1）。
      this.store.update((draft) => {
        draft.fixingId = undefined
        draft.error = this.fixFailure.record(error instanceof Error ? error.message : String(error))
        draft.failureFrom = 'fix'
      })
    }
  }
}

/** 环境子页的状态。 */
export interface EnvironmentsState {
  environments: readonly EnvironmentInfo[]
  loading: boolean
  /** 正在执行的操作名（用于按钮禁用与提示）。 */
  busy: string | undefined
  error: string | undefined
  /** 客户端自己判定的失败（载荷残缺、备份文件格式不对）；文案归字典。 */
  errorKey?: CompanionLocaleKey
  notice: string | undefined
  /** 已读入内存的备份文档。 */
  backup: EnvironmentBackup | undefined
  /** 最近一次差异对比结果。 */
  diff: EnvironmentBackupDiff | undefined
}

/** 环境子页的注入面。 */
export interface EnvironmentsFace {
  hooks: { environments: SnapshotStore<EnvironmentsState> }
  refreshEnvironments(): void
  /** 启动一个环境；background 为真时不占用前台终端。 */
  startEnvironment(name: string, background: boolean): void
  stopEnvironment(name: string): void
  createEnvironment(name: string, template?: string): void
  renameEnvironment(from: string, to: string): void
  removeEnvironment(name: string): void
  copyPlugins(from: string, to: string, names: readonly string[]): void
  /** 导出备份：结果同时下载成文件并留在状态里供对比。 */
  exportBackup(name: string): void
  /** 读入一个备份文件（浏览器 File，由 UI 的 file input 提供）。 */
  loadBackup(file: File): void
  /** 对比已读入的备份与目标环境。 */
  diffBackup(target: string): void
  /** 用已读入的备份恢复目标环境。 */
  restoreBackup(target: string): void
  /** 清掉上一次操作的通知与错误。 */
  dismissEnvironmentNotice(): void
}

/** 环境控制器。 */
export class EnvironmentsController {
  private readonly store: SnapshotStore<EnvironmentsState>
  /** "读列表"写下的失败；只有它能被下一次成功的读取清掉（见 ReadFailureLedger）。 */
  private readonly readFailure = new ReadFailureLedger()

  constructor() {
    this.store = createSnapshotStore<EnvironmentsState>({
      environments: [], loading: false, busy: undefined, error: undefined,
      notice: undefined, backup: undefined, diff: undefined,
    })
  }

  /** 供注册项使用的注入面。 */
  inject(): EnvironmentsFace {
    return {
      hooks: { environments: this.store },
      refreshEnvironments: () => { void this.refresh() },
      startEnvironment: (name, background) => { void this.act(`start ${name}`, () => callOp<unknown>('startEnvironment', { name, background })) },
      stopEnvironment: (name) => { void this.act(`stop ${name}`, () => callOp<unknown>('stopEnvironment', { name })) },
      createEnvironment: (name, template) => {
        void this.act(`create ${name}`, () => callOp<unknown>('createEnvironment', template === undefined || template === '' ? { name } : { name, template }))
      },
      renameEnvironment: (from, to) => { void this.act(`rename ${from}`, () => callOp<unknown>('renameEnvironment', { from, to })) },
      removeEnvironment: (name) => { void this.act(`remove ${name}`, () => callOp<unknown>('removeEnvironment', { name })) },
      copyPlugins: (from, to, names) => { void this.act(`copy ${from} → ${to}`, () => runJob<unknown>('copyPlugins', { from, to, names })) },
      exportBackup: (name) => { void this.exportBackup(name) },
      loadBackup: (file) => { void this.loadBackup(file) },
      diffBackup: (target) => { void this.diffBackup(target) },
      restoreBackup: (target) => { void this.restoreBackup(target) },
      dismissEnvironmentNotice: () => {
        this.store.update((draft) => { draft.notice = undefined; draft.error = undefined; draft.errorKey = undefined })
      },
    }
  }

  /**
   * 重新读环境列表。
   *
   * **只动 loading**：`notice` / `error` 描述的是"上一次操作"，刷新列表是另一回事，
   * 无权替操作宣布结果。这里曾经先清 error/errorKey，而 act() 是"先落结果、再 refresh"——
   * 于是写操作失败后马上被这一行抹掉，结果块的 exitCode 恒为 0、界面上呈现成"完成"
   * （真机复现：复制插件填一个不存在的包 → 结果块「完成」，输出却是失败文本）。
   *
   * 为什么不改成"把落定挪到 refresh 之后"：那要求每个新操作都记得排序，本 bug 正是
   * 这种调用顺序约定失效的产物；而"刷新列表不碰操作结果"是一条不依赖调用方记性的规则。
   * 失败态由操作自身清零（每个操作开始时清）与 dismissEnvironmentNotice 负责。
   */
  async refresh(): Promise<void> {
    this.store.update((draft) => { draft.loading = true })
    try {
      const environments = normalizeEnvironments(await callOp<unknown>('listEnvironments', {}))
      if (environments === undefined) {
        this.store.update((draft) => {
          draft.loading = false
          draft.errorKey = this.readFailure.record('error.incompletePayload')
        })
        return
      }
      this.store.update((draft) => {
        draft.environments = environments
        draft.loading = false
        this.readFailure.clearOwn(draft)
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.store.update((draft) => {
        draft.loading = false
        draft.error = this.readFailure.record(message)
      })
    }
  }

  /**
   * 跑一个变更类操作：写 busy → 执行 → 记结果 → 刷新列表。
   *
   * 变更一律不带 AbortSignal：中止只杀传输，服务端仍会推进。
   *
   * @param label - 操作标签，用于 UI 的忙碌提示。
   * @param task - 具体调用（返回值一律过归一，形状不对时如实报失败而不是当成功）。
   */
  private async act(label: string, task: () => Promise<unknown>): Promise<void> {
    this.store.update((draft) => {
      draft.busy = label
      draft.error = undefined
      draft.errorKey = undefined
      draft.notice = undefined
    })
    try {
      const result = normalizeEnvironmentResult(await task())
      this.store.update((draft) => {
        draft.busy = undefined
        draft.notice = result.output
        if (!result.ok) draft.error = result.code ?? result.output
      })
      await this.refresh()
    } catch (error) {
      this.store.update((draft) => {
        draft.busy = undefined
        draft.error = error instanceof Error ? error.message : String(error)
      })
    }
  }

  /**
   * 导出备份。
   * @param name - 被备份的环境名。
   */
  async exportBackup(name: string): Promise<void> {
    this.store.update((draft) => {
      draft.busy = `backup ${name}`
      draft.error = undefined
      draft.errorKey = undefined
      draft.notice = undefined
      draft.diff = undefined
    })
    try {
      const backup = normalizeBackup(await callOp<unknown>('backupExport', { name }))
      if (backup === undefined) {
        this.store.update((draft) => { draft.busy = undefined; draft.errorKey = 'error.incompletePayload' })
        return
      }
      this.store.update((draft) => { draft.busy = undefined; draft.backup = backup })
      downloadJson(`companion-${name}-${Date.now()}.json`, backup)
    } catch (error) {
      this.store.update((draft) => {
        draft.busy = undefined
        draft.error = error instanceof Error ? error.message : String(error)
      })
    }
  }

  /**
   * 读入备份文件。
   * @param file - 浏览器 File 对象。
   */
  async loadBackup(file: File): Promise<void> {
    // 读文件也是一次操作：起始先把上一次的结果块清掉，否则失败时结果块里留着的
    // 是**上一次**操作的输出（P6：导入无效备份时块里还是上一次的内容）。
    this.store.update((draft) => {
      draft.notice = undefined
      draft.error = undefined
      draft.errorKey = undefined
    })
    try {
      const text = await file.text()
      // 用户挑的文件可能根本不是备份（甚至是任意 JSON）：归一不过就拒绝，
      // 绝不把猜出来的对象交给"覆盖目标环境"的恢复流程。
      const backup = normalizeBackup(JSON.parse(text) as unknown)
      if (backup === undefined) {
        this.store.update((draft) => { draft.errorKey = 'env.backupInvalid'; draft.error = undefined })
        return
      }
      this.store.update((draft) => {
        draft.backup = backup
        draft.diff = undefined
        draft.error = undefined
        draft.errorKey = undefined
      })
    } catch (error) {
      this.store.update((draft) => {
        draft.errorKey = 'env.backupInvalid'
        draft.error = error instanceof Error ? error.message : String(error)
      })
    }
  }

  /**
   * 差异对比。
   * @param target - 目标环境名。
   */
  async diffBackup(target: string): Promise<void> {
    const backup = this.store.getSnapshot().backup
    if (backup === undefined) return
    this.store.update((draft) => {
      draft.busy = `diff ${target}`
      draft.error = undefined
      draft.errorKey = undefined
      draft.notice = undefined
    })
    try {
      const diff = normalizeBackupDiff(await callOp<unknown>('backupDiff', { backup, target }))
      if (diff === undefined) {
        this.store.update((draft) => { draft.busy = undefined; draft.errorKey = 'error.incompletePayload' })
        return
      }
      this.store.update((draft) => { draft.busy = undefined; draft.diff = diff })
    } catch (error) {
      this.store.update((draft) => {
        draft.busy = undefined
        draft.error = error instanceof Error ? error.message : String(error)
      })
    }
  }

  /**
   * 用已读入的备份恢复目标环境。
   * @param target - 目标环境名。
   */
  async restoreBackup(target: string): Promise<void> {
    const backup = this.store.getSnapshot().backup
    if (backup === undefined) return
    await this.act(`restore ${target}`, () => runJob<unknown>('backupRestore', { backup, target }))
    this.store.update((draft) => { draft.diff = undefined })
  }
}

/** 市场子页的状态。 */
export interface MarketplaceState {
  result: MarketplaceResult | undefined
  loading: boolean
  error: string | undefined
  /** 客户端自己判定的失败（索引载荷残缺）；文案归字典。 */
  errorKey?: CompanionLocaleKey
  query: string
  /** 选中的分类 id；空串表示全部。 */
  category: string
  /** 选中的类型；空串表示全部。 */
  kind: MarketItemKind | ''
  /** 正在安装的条目 repo。 */
  installing: string | undefined
  installError: string | undefined
  /** 质量门发现的问题（安装未通过时保留，供用户追责）。 */
  gateIssues: readonly string[]
  rolledBack: boolean
  /**
   * 这次安装的试装结论（质量门第二步）。undefined = 宿主没给这个字段，
   * 而不是"试装通过"——界面据此区分"没试装"与"试装通过"。
   */
  trial: TrialOutcomeView | undefined
}

/** 市场子页的注入面。 */
export interface MarketplaceFace {
  hooks: { marketplace: SnapshotStore<MarketplaceState> }
  loadMarketplace(refresh: boolean): void
  setMarketQuery(query: string): void
  setMarketCategory(category: string): void
  setMarketKind(kind: MarketItemKind | ''): void
  installMarketItem(item: MarketItemView): void
  dismissInstallNotice(): void
}

/** 市场条目在 UI 侧的稳定视图（只带渲染与安装需要的字段）。 */
export interface MarketItemView {
  readonly repo: string
  readonly name: string
  /**
   * 安装 spec —— **host 侧给的**（MarketItem.installSpec），客户端只负责原样转发。
   *
   * 不在这里拼字符串是有意的：官方 parseInstallSpec 只认 registry 名 / 绝对路径 / git URL /
   * tarball 四种形态，而市场条目的天然键是 owner/repo（不在其中，官方直接判 invalid-spec）。
   * 那套规则若在客户端再实现一份，索引字段一变就要改两处，且必然漂移。
   * 契约上可选：老载荷没有这个字段时不猜——送空串，由 host 的字段校验如实报错。
   */
  readonly installSpec?: string
}

/** 市场控制器。 */
export class MarketplaceController {
  private readonly store: SnapshotStore<MarketplaceState>
  /** "读索引"写下的失败；只有它能被下一次成功的读取清掉（见 ReadFailureLedger）。 */
  private readonly readFailure = new ReadFailureLedger()

  constructor() {
    this.store = createSnapshotStore<MarketplaceState>({
      result: undefined, loading: false, error: undefined, query: '', category: '', kind: '',
      installing: undefined, installError: undefined, gateIssues: [], rolledBack: false, trial: undefined,
    })
  }

  /** 供注册项使用的注入面。 */
  inject(): MarketplaceFace {
    return {
      hooks: { marketplace: this.store },
      loadMarketplace: (refresh) => { void this.load(refresh) },
      setMarketQuery: (query) => { this.store.update((draft) => { draft.query = query }) },
      setMarketCategory: (category) => { this.store.update((draft) => { draft.category = category }) },
      setMarketKind: (kind) => { this.store.update((draft) => { draft.kind = kind }) },
      installMarketItem: (item) => { void this.install(item) },
      dismissInstallNotice: () => {
        this.store.update((draft) => {
          draft.installError = undefined; draft.gateIssues = []; draft.rolledBack = false; draft.trial = undefined
        })
      },
    }
  }

  /**
   * 读市场索引。
   * @param refresh - 是否强制绕过缓存。
   */
  async load(refresh: boolean): Promise<void> {
    this.store.update((draft) => { draft.loading = true })
    try {
      const result = normalizeMarketplace(await callOp<unknown>('marketplace', { refresh }))
      if (result === undefined) {
        this.store.update((draft) => {
          draft.loading = false
          draft.errorKey = this.readFailure.record('error.incompletePayload')
        })
        return
      }
      this.store.update((draft) => {
        draft.result = result
        draft.loading = false
        this.readFailure.clearOwn(draft)
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.store.update((draft) => {
        draft.loading = false
        draft.error = this.readFailure.record(message)
      })
    }
  }

  /**
   * 经质量门安装一个市场条目。
   *
   * spec 由 host 决定（MarketItem.installSpec），本方法**只转发**；缺失时送空串，
   * 让 host 的字段校验给出可读错误，而不是在这里编一个 spec 出来。
   *
   * @param item - 要安装的条目。
   */
  async install(item: MarketItemView): Promise<void> {
    this.store.update((draft) => {
      draft.installing = item.repo
      draft.installError = undefined
      draft.gateIssues = []
      draft.rolledBack = false
      draft.trial = undefined
    })
    try {
      const result = normalizeGatedInstall(await runJob<unknown>('install', { spec: item.installSpec ?? '' }))
      this.store.update((draft) => {
        draft.installing = undefined
        draft.gateIssues = result.gateIssues
        draft.rolledBack = result.rolledBack === true
        draft.trial = result.trial
        if (!result.ok) draft.installError = result.output
      })
      await this.load(true)
    } catch (error) {
      this.store.update((draft) => {
        draft.installing = undefined
        draft.installError = error instanceof Error ? error.message : String(error)
      })
    }
  }
}

/** 技能与预设子页的状态。 */
export interface KindsState {
  records: readonly InstalledKind[]
  orphans: readonly string[]
  loading: boolean
  error: string | undefined
  /** 客户端自己判定的失败（载荷残缺）；文案归字典。 */
  errorKey?: CompanionLocaleKey
  busy: string | undefined
  notice: string | undefined
}

/** 技能与预设子页的注入面。 */
export interface KindsFace {
  hooks: { kinds: SnapshotStore<KindsState> }
  loadKinds(): void
  uninstallKind(repo: string): void
}

/** 技能与预设控制器。 */
export class KindsController {
  private readonly store: SnapshotStore<KindsState>
  /** "读记录"写下的失败；只有它能被下一次成功的读取清掉（见 ReadFailureLedger）。 */
  private readonly readFailure = new ReadFailureLedger()

  constructor() {
    this.store = createSnapshotStore<KindsState>({
      records: [], orphans: [], loading: false, error: undefined, busy: undefined, notice: undefined,
    })
  }

  /** 供注册项使用的注入面。 */
  inject(): KindsFace {
    return {
      hooks: { kinds: this.store },
      loadKinds: () => { void this.load() },
      uninstallKind: (repo) => { void this.uninstall(repo) },
    }
  }

  /** 读技能与预设记录。 */
  async load(): Promise<void> {
    this.store.update((draft) => { draft.loading = true })
    try {
      const result = normalizeKindList(await callOp<unknown>('listKinds', {}))
      if (result === undefined) {
        this.store.update((draft) => {
          draft.loading = false
          draft.errorKey = this.readFailure.record('error.incompletePayload')
        })
        return
      }
      this.store.update((draft) => {
        draft.records = result.records
        draft.orphans = result.orphans
        draft.loading = false
        this.readFailure.clearOwn(draft)
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.store.update((draft) => {
        draft.loading = false
        draft.error = this.readFailure.record(message)
      })
    }
  }

  /**
   * 卸载一个已安装的技能或预设。
   * @param repo - owner/repo。
   */
  async uninstall(repo: string): Promise<void> {
    // 同 health.fix：开跑时连 errorKey 一起清，避免上一轮的失败文案残留。
    this.store.update((draft) => {
      draft.busy = repo
      draft.error = undefined
      draft.errorKey = undefined
      draft.notice = undefined
    })
    try {
      const result = normalizeEnvironmentResult(await runJob<unknown>('uninstallKind', { repo }))
      this.store.update((draft) => {
        draft.busy = undefined
        draft.notice = result.output
        if (!result.ok) draft.error = result.code ?? result.output
      })
      await this.load()
    } catch (error) {
      this.store.update((draft) => {
        draft.busy = undefined
        draft.error = error instanceof Error ? error.message : String(error)
      })
    }
  }
}

/** 设置子页的状态：官方 settings 的镜像 + 本地草稿。 */
export interface ConfigState {
  status: 'loading' | 'ready' | 'unavailable'
  writable: boolean
  /** 官方已解析的当前值（原样保留：保存时的"前后对比"和写盘路径都以它为准）。 */
  value: CompanionConfig | undefined
  /**
   * 渲染用草稿：已过 wire 归一（缺字段按客户端默认值补齐）再叠加本地编辑。
   *
   * 类型是 {@link ClientConfig} 而不是 host 的 CompanionConfig：host 侧 `trial` 是可选字段，
   * 归一后它一定存在——组件因此不需要（也不许）在读取处替它兜默认值。
   */
  draft: ClientConfig | undefined
  /** 宿主给的文档缺字段（draft 里有默认值补出来的部分）——界面要如实说明。 */
  incomplete: boolean
  dirty: boolean
  saving: boolean
  failed: boolean
  saved: boolean
}

/** 设置子页的注入面。 */
export interface ConfigFace {
  hooks: { config: SnapshotStore<ConfigState> }
  /** 改一个字段（路径是命名空间内的嵌套路径）。 */
  editConfigField(path: readonly string[], value: unknown): void
  saveConfig(): void
  discardConfig(): void
}

/**
 * 读类动作的失败记账。
 *
 * 规则：**一次读取只清自己写下的那条失败**。两个方向都是实测教训：
 *   · 读的成功不得抹掉操作留下的失败——原先 refresh() 一上来就 `error = undefined`，而
 *     act() 是"先落结果、再 refresh"，于是写操作失败后结果块画成"完成"（真机复现）。
 *   · 但读取**自己**上一次的失败也不该永远留着——列表恢复正常了红字还挂着，那是假失败。
 */
class ReadFailureLedger {
  private last: string | undefined

  /**
   * 记下一次失败。
   * @param failure - 写进 state 的失败标识（错误消息或字典键）。
   * @returns 同一个标识，便于在 update 里直接赋值。
   */
  record<T extends string>(failure: T): T {
    this.last = failure
    return failure
  }

  /**
   * 读成功后清掉自己上一次写的失败（别人的失败原样留着）。
   * @param draft - 状态草案。
   * @returns 是否真的清掉了一条（调用方据此决定要不要清"当前失败来自谁"的归因）。
   */
  clearOwn(draft: { error?: string; errorKey?: string }): boolean {
    const last = this.last
    if (last === undefined) return false
    let cleared = false
    if (draft.error === last) { draft.error = undefined; cleared = true }
    if (draft.errorKey === last) { draft.errorKey = undefined; cleared = true }
    this.last = undefined
    return cleared
  }
}

/** 一次暂存的编辑。 */
interface StagedEdit {
  readonly key: string
  readonly path: readonly string[]
  readonly value: unknown
}

/** 设置控制器：草稿 + 一次保存写全部改动（与官方插件配置页同一交互模型）。 */
export class ConfigController {
  private readonly store: SnapshotStore<ConfigState>
  private staged: readonly StagedEdit[] = []

  /**
   * @param scope - 官方 settings 服务上本插件命名空间的句柄。
   */
  constructor(private readonly scope: SettingsScope<CompanionConfig>) {
    this.store = createSnapshotStore<ConfigState>({
      status: 'loading', writable: false, value: undefined, draft: undefined, incomplete: false,
      dirty: false, saving: false, failed: false, saved: false,
    })
    this.scope.subscribe(() => { this.publish() })
    this.publish()
  }

  /** 供注册项使用的注入面。 */
  inject(): ConfigFace {
    return {
      hooks: { config: this.store },
      editConfigField: (path, value) => { this.edit(path, value) },
      saveConfig: () => { void this.save() },
      discardConfig: () => { this.discard() },
    }
  }

  /** 把官方快照与本地草稿合成一份状态。 */
  private publish(): void {
    const snapshot = this.scope.getSnapshot()
    const value = snapshot.value
    // 归一在前、草稿在后：官方文档可能残缺（例如宿主只落了用户层），归一补齐默认值后
    // 再叠加用户的暂存编辑，渲染侧因此永远拿到完整字段。写盘仍只写用户改过的路径
    // （见 save()：逐条 set，按路径），补出来的字段不会被写回。
    const normalized = value === undefined ? undefined : normalizeConfig(value)
    const draft = normalized === undefined ? undefined : applyEdits(normalized.config, this.staged)
    this.store.update((state) => {
      state.status = snapshot.status
      state.writable = snapshot.writable
      state.value = value
      state.draft = draft
      state.incomplete = (normalized?.filled.length ?? 0) > 0
      state.dirty = this.staged.length > 0
      if (!state.saving) state.failed = false
    })
  }

  /**
   * 暂存一个字段编辑（不写盘；保存时才写）。
   * @param path - 命名空间内的路径。
   * @param value - 新值。
   */
  edit(path: readonly string[], value: unknown): void {
    const key = path.join('.')
    this.staged = [...this.staged.filter(edit => edit.key !== key), { key, path, value }]
    this.store.update((state) => { state.saved = false; state.failed = false })
    this.publish()
  }

  /** 丢弃所有暂存编辑。 */
  discard(): void {
    this.staged = []
    this.store.update((state) => { state.saved = false; state.failed = false })
    this.publish()
  }

  /** 保存全部暂存编辑（一次 mutate，天然共用同一个修订栅栏）。 */
  async save(): Promise<void> {
    const value = this.store.getSnapshot().value
    if (value === undefined || this.staged.length === 0) return
    const ops = this.staged.flatMap((edit): { op: 'set'; path: string[]; value: unknown }[] => {
      const before = readAtPath(value, edit.path)
      return JSON.stringify(before) === JSON.stringify(edit.value)
        ? []
        : [{ op: 'set', path: [...edit.path], value: edit.value }]
    })
    if (ops.length === 0) {
      this.staged = []
      this.store.update((state) => { state.dirty = false; state.saved = true })
      this.publish()
      return
    }
    this.store.update((state) => { state.saving = true; state.failed = false })
    try {
      await this.scope.mutate(ops as unknown as Parameters<SettingsScope<CompanionConfig>['mutate']>[0])
      this.staged = []
      this.store.update((state) => { state.saving = false; state.saved = true })
    } catch {
      // 官方 scope 自己会回读宿主状态（写失败即 recover），这里只如实标记。
      this.store.update((state) => { state.saving = false; state.failed = true })
    }
    this.publish()
  }
}

// ── 试装（质量门第二步）：披露事实 + 测试环境的管理面 ──────────────────────

/** 上一次试装环境变更的结果（结构化：界面按 kind 选文案，不把整句拼进状态）。 */
export interface TrialActionState {
  readonly kind: 'remove' | 'cleanup'
  readonly ok: boolean
  readonly removed: readonly string[]
  readonly output: string
  readonly code?: string
}

/** 「设置」子页里试装那一节的状态。 */
export interface TrialState {
  /** 披露事实（capabilities op 的 trialDisclosure）；undefined = 还没读到或读不到。 */
  disclosure: TrialDisclosureView | undefined
  /** 披露读不到的原因（宿主消息）。 */
  disclosureError: string | undefined
  /** 披露读不到的原因（我们自己的判定，文案归字典）。 */
  disclosureErrorKey?: CompanionLocaleKey
  /** 测试环境报告；undefined = 还没读到或读失败（界面据此显示加载中/失败，不显示"没有测试环境"）。 */
  report: TrialEnvironmentsView | undefined
  loading: boolean
  /** 正在执行的动作标签（与官方页一致的 动词+名字 形态）。 */
  busy: string | undefined
  /** 读列表自己写下的失败（只有它能被下一次成功的读取清掉）。 */
  error: string | undefined
  errorKey?: CompanionLocaleKey
  /** 上一次变更操作的结果（成功也留，直到用户处置）。 */
  action: TrialActionState | undefined
}

/** 试装管理面的注入面。 */
export interface TrialFace {
  hooks: { trial: SnapshotStore<TrialState> }
  loadTrial(): void
  removeTrialEnvironment(name: string): void
  cleanupTrialEnvironments(): void
}

/**
 * 试装控制器：读披露事实与测试环境列表，执行"删除一个"与"清理过期"。
 *
 * 披露事实走 capabilities op 而不是在客户端抄一份数字：数字与口径由 host 给；
 * 抄一份就会在下次实测后漂移，而漂移的是"用户以为自己承担了什么风险"。
 */
export class TrialController {
  private readonly store: SnapshotStore<TrialState>
  /** "读列表"写下的失败；只有它能被下一次成功的读取清掉（见 ReadFailureLedger）。 */
  private readonly readFailure = new ReadFailureLedger()

  constructor() {
    this.store = createSnapshotStore<TrialState>({
      disclosure: undefined, disclosureError: undefined, report: undefined,
      loading: false, busy: undefined, error: undefined, action: undefined,
    })
  }

  /** 供注册项使用的注入面。 */
  inject(): TrialFace {
    return {
      hooks: { trial: this.store },
      loadTrial: () => { void this.load() },
      removeTrialEnvironment: (name) => { void this.remove(name) },
      cleanupTrialEnvironments: () => { void this.cleanup() },
    }
  }

  /**
   * 读披露事实 + 测试环境列表。
   *
   * 只动 loading / 自己写下的读失败：action 描述的是"上一次操作"，刷新无权替它宣布结果
   * （task-18 的真机 P1：读操作清掉写操作的结果，失败就被渲染成完成）。披露读不到时也只记原因，
   * 不让整节变成不可用——用户仍能改配置，只是看不到"会发生什么"。
   */
  async load(): Promise<void> {
    this.store.update((draft) => { draft.loading = true })
    try {
      const info = await callOp<{ trialDisclosure?: unknown }>('capabilities', {})
      const disclosure = normalizeTrialDisclosure(info.trialDisclosure)
      this.store.update((draft) => {
        draft.disclosure = disclosure
        draft.disclosureError = undefined
        draft.disclosureErrorKey = disclosure === undefined ? 'error.incompletePayload' : undefined
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.store.update((draft) => {
        draft.disclosure = undefined
        draft.disclosureError = message
        draft.disclosureErrorKey = undefined
      })
    }
    try {
      const report = normalizeTrialEnvironments(await callOp<unknown>('trialEnvironments', {}))
      if (report === undefined) {
        this.store.update((draft) => {
          draft.loading = false
          draft.errorKey = this.readFailure.record('error.incompletePayload')
        })
        return
      }
      this.store.update((draft) => {
        draft.report = report
        draft.loading = false
        this.readFailure.clearOwn(draft)
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.store.update((draft) => {
        draft.loading = false
        draft.error = this.readFailure.record(message)
      })
    }
  }

  /**
   * 删除一个测试环境。
   * @param name - 测试环境名。
   */
  async remove(name: string): Promise<void> {
    await this.act('remove', 'remove ' + name, () => callOp<unknown>('trialRemove', { name }))
  }

  /** 清理过期的测试环境（走 job：可能跨多个目录）。 */
  async cleanup(): Promise<void> {
    await this.act('cleanup', 'cleanup', () => runJob<unknown>('trialCleanup', {}))
  }

  /**
   * 跑一个变更类操作：写 busy → 执行 → 落结果 → 刷新列表。
   *
   * 结果必须先落定再刷新：反过来会让刚写下的失败被 refresh 抹掉（task-18 的 P1 就是这个顺序）。
   *
   * @param kind - 操作种类（界面按它选文案）。
   * @param label - 忙碌提示用的标签。
   * @param task - 具体调用（返回值一律过归一，形状不对时如实报失败而不是当成功）。
   */
  private async act(kind: 'remove' | 'cleanup', label: string, task: () => Promise<unknown>): Promise<void> {
    this.store.update((draft) => {
      draft.busy = label
      draft.action = undefined
      draft.error = undefined
      draft.errorKey = undefined
    })
    try {
      const result = normalizeTrialCleanup(await task())
      this.store.update((draft) => {
        draft.busy = undefined
        draft.action = {
          kind,
          ok: result.ok,
          removed: result.removed,
          output: result.output,
          ...result.code === undefined ? {} : { code: result.code },
        }
        if (!result.ok) draft.error = result.code ?? result.output
      })
      await this.load()
    } catch (error) {
      this.store.update((draft) => {
        draft.busy = undefined
        draft.action = { kind, ok: false, removed: [], output: error instanceof Error ? error.message : String(error) }
      })
    }
  }
}


// ── 升级（档三）：检查缓存 + 官方插件页的升级行 + 一次升级的结果 ──────────────

/**
 * 升级那一块的状态。
 *
 * 三块事实各自独立，**不合并**：
 *   · check：最近一次 upgradeCheck 的结果（四态就在这里）；
 *   · busy：正在跑的包名（升级是长操作，界面据此禁用入口）；
 *   · action：最近一次升级/回滚的结果 —— 它必须活到用户处置为止，
 *     不能被任何一次刷新抹掉（task-18 的真机 P1：读操作清掉写操作的结果，失败被渲染成完成）。
 */
export interface UpgradeState {
  /** 检查结果；undefined = 还没查过（界面据此显示"还没检查"，不是"已是最新"）。 */
  check: UpgradeCheckView | undefined
  loading: boolean
  /** 读检查结果自己写下的失败（只有它能被下一次成功的读取清掉）。 */
  error: string | undefined
  /** 客户端自己判定的失败（载荷残缺）；文案归字典。 */
  errorKey?: CompanionLocaleKey
  /** 正在升级的包名。 */
  busy: string | undefined
  /** 最近一次升级的结果（成功也留，直到用户处置或下一次升级开始）。 */
  action: UpgradeActionResultState | undefined
  /** 最近一次回滚的结果。 */
  rollback: UpgradeRollbackResultState | undefined
}

/** 一次升级的结果（结构化：界面按 outcome 选文案，不把整句拼进状态）。 */
export interface UpgradeActionResultState {
  /** 诚实分类：done / rolled-back / failed / unverified（见 upgradeView.upgradeOutcome）。 */
  readonly outcome: UpgradeOutcomeKind
  readonly name: string
  readonly fromVersion: string | null
  readonly toVersion: string
  readonly ok: boolean
  readonly output: string
  readonly code?: string
  /** 金丝雀的读法：passed / failed / not-run / absent（没验证 ≠ 验证失败 ≠ 通过）。 */
  readonly canary: 'passed' | 'failed' | 'not-run' | 'absent'
  /** 没跑金丝雀的原因（ran===false 时才有）。 */
  readonly canaryNote?: string
  /**
   * 金丝雀的**完整结论原文**（含根因链）。
   *
   * 为什么必须带出来：顶层的 output 是"结论与后果"那一层，而用户追责要看的是
   * 根因链（例如 duplicate loader entry id）。丢掉它，界面只能说"没通过"，
   * 用户拿不到任何可查的东西——task-78/80 的验收明确要求根因链可见。
   */
  readonly canaryOutput?: string
  /** 金丝雀的激活证据：候选有没有真的进测试环境的层栈。 */
  readonly canaryActivated?: boolean
  readonly restartRequired: boolean
  readonly diskFacts: readonly string[]
  /**
   * 本次升级用的 spec（host 的官方 add 收到的那个）。
   *
   * 为什么结果态要带它：回滚入口就长在这个块里，而回滚需要它来判断"原来是不是本地来源"。
   * 缺了它，回滚会把 link: 装的包换成 registry 版本——那不是回滚，是换来源。
   */
  readonly spec?: string
}

/** 一次回滚的结果。 */
export interface UpgradeRollbackResultState {
  readonly name: string
  readonly ok: boolean
  readonly output: string
  readonly code?: string
  readonly fromVersion: string | null
  readonly toVersion: string
  /** 盘上核对是否一致；undefined = 读不出来（不是"不干净"）。 */
  readonly clean: boolean | undefined
  readonly diskFacts: readonly string[]
}

/** 升级动作的注入面（官方插件页的升级行与市场页卡片共用同一份）。 */
export interface UpgradeFace {
  hooks: { upgrade: SnapshotStore<UpgradeState> }
  /**
   * 进入即查：**同一会话内只发一次**（TTL / 开关 / 负缓存判定都在 host 侧，客户端不重复实现）。
   *
   * 为什么需要这个去重口："进入即查"的触发点在**渲染期**（官方插件页/市场页挂载时的 effect），
   * 而这两个面会被反复挂载。没有去重就会变成"每开一次页面出一趟网"，
   * 而 TTL 的语义是"距上次成功检查超过间隔才查"——去重的依据在 host，触发次数得由客户端收住。
   */
  ensureUpgrades(): void
  /** 手动检查（无视开关、TTL 与负缓存）；refresh=true 是用户点的重试。 */
  loadUpgrades(refresh: boolean): void
  /** 升级一个包到指定版本（长操作，走 job）。 */
  upgradePackage(name: string, version: string, spec?: string): void
  /** 回滚一个包到指定版本。 */
  rollbackPackage(name: string, version: string, spec?: string): void
  /** 处置（清掉）最近一次升级结果。 */
  dismissUpgradeNotice(): void
}

// ── 「关于 → 软件升级」的子页筛选（task-96）──────────────────────────────

/**
 * 本页只列"这套软件本身"的单元（DESIGN §5.5 的用户裁决）。
 *
 * 三类都在，但**第三方插件一律不出现在这一页**——它们的升级入口是官方插件页里该包自己的页面
 * 与市场页卡片。所以这里不能简单地"把 units 全画出来"，必须筛。
 *
 * 判据用 **host 已经分好的 `kind`**，不自己按包名猜：
 *   · `installation-provided` → ① 官方运行时（全局安装的那份）；
 *   · `profile-dependency`    → ② 官方自带实验包（与第三方在**同一类**里，靠包名分）；
 *   · `self`                  → ③ 本插件自身。
 * ②与第三方同 kind，所以还需要一条"是不是官方的"判据，见 {@link isOfficialPackage}。
 */
export const SOFTWARE_UNIT_KINDS: readonly string[] = ['installation-provided', 'profile-dependency', 'self']

/**
 * 一个包名是否属于官方（`@deepseek-ai/` 作用域）。
 *
 * 为什么用作用域而不是维护一张白名单：官方包名会随版本增删（`dsh-experimental-*` 尤其），
 * 白名单一过期就会**静默漏掉一个该显示的单元**；作用域是发布方自己定的、稳定的。
 * 与仓库既有判据同源（`src/diagnostics.ts` 的 `name.startsWith('@deepseek-ai/')`）。
 *
 * 注意：本插件自身（`dsh-plugin-manager-companion`）**不在**这个作用域里，
 * 但它必须显示——所以判据是"官方 或 本插件自身"，见 {@link isSoftwareUnit}。
 *
 * @param name - 包名。
 * @returns 是否官方作用域。
 */
export function isOfficialPackage(name: string): boolean {
  return name.startsWith('@deepseek-ai/')
}

/**
 * 一个升级单元是否属于"这套软件本身"（本页要显示的）。
 *
 * @param unit - 单元视图（只要有 name / kind 两个字段）。
 * @returns 是否显示在这一页。
 */
export function isSoftwareUnit(unit: { readonly name: string; readonly kind: string }): boolean {
  if (!SOFTWARE_UNIT_KINDS.includes(unit.kind)) return false
  return isOfficialPackage(unit.name) || unit.kind === 'self'
}

/**
 * 从全部单元里挑出本页要显示的，并按三类排好（① → ② → ③，类内按包名）。
 *
 * 为什么固定顺序：用户来这一页是依次看"官方运行时能不能升 / 实验包能不能升 / 我自己能不能升"，
 * 顺序随检查结果的返回次序变会让每次打开都长得不一样。
 *
 * @param units - 检查结果里的全部单元。
 * @returns 本页要显示的单元（已排序）。
 */
export function softwareUnits<T extends { readonly name: string; readonly kind: string }>(
  units: readonly T[],
): readonly T[] {
  const rank = (kind: string): number => SOFTWARE_UNIT_KINDS.indexOf(kind)
  return units
    .filter(isSoftwareUnit)
    .slice()
    .sort((left, right) => rank(left.kind) - rank(right.kind) || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
}

// ── 「关于」页（task-95）─────────────────────────────────────────────────

/** 「关于」页的状态。 */
export interface AboutState {
  /** 事实集合；undefined = 还没读到（界面显示"还没读到"，不是一张空表）。 */
  facts: AboutFactsView | undefined
  loading: boolean
  /** 读失败的原因（op 挂了）；文案归字典。 */
  error: string | undefined
  errorKey?: CompanionLocaleKey
}

/** 「关于」页的注入面。 */
export interface AboutFace {
  hooks: { about: SnapshotStore<AboutState> }
  /**
   * 读一次事实。
   *
   * 与升级面的"进入即查"不同，这里**不去重**：关于页读的是本地事实（无网络、无副作用），
   * 每次进入重读一遍反而更准（缓存年龄会随时间变、用户可能刚删了缓存文件）。
   * 去重那一套是为"出网"设计的，套在这里只会让数字变旧。
   *
   * @param refresh - 用户点的重试（与首次进入走同一条路，保留参数是为了接口一致）。
   */
  loadAbout(refresh: boolean): void
}

/**
 * 「关于」页的控制器。
 *
 * 与 UpgradeController 同一形状（store + 读失败账本），但**没有** busy / 动作结果——
 * 这一页纯读，没有任何写动作，所以不需要那些字段。
 */
export class AboutController {
  private readonly store: SnapshotStore<AboutState>
  /** "读事实"写下的失败；只有它能被下一次成功的读取清掉（见 ReadFailureLedger）。 */
  private readonly readFailure = new ReadFailureLedger()

  constructor() {
    this.store = createSnapshotStore<AboutState>({ facts: undefined, loading: false, error: undefined })
  }

  /** 供注册项使用的注入面。 */
  inject(): AboutFace {
    return {
      hooks: { about: this.store },
      loadAbout: (refresh) => { void this.load(refresh) },
    }
  }

  /** 当前快照。 */
  snapshot(): AboutState {
    return this.store.getSnapshot()
  }

  /**
   * 读一次事实。
   *
   * 只动 loading / 自己写下的读失败——与升级面同一条纪律：
   * 一次刷新无权替上一次的失败宣布结果。
   *
   * @param _refresh - 用户点的重试（本 op 无缓存，参数不影响读法）。
   */
  async load(_refresh: boolean): Promise<void> {
    this.store.update((draft) => { draft.loading = true })
    try {
      const facts = normalizeAbout(await callOp<unknown>('about', {}))
      if (facts === undefined) {
        this.store.update((draft) => {
          draft.loading = false
          draft.errorKey = this.readFailure.record('error.incompletePayload')
        })
        return
      }
      this.store.update((draft) => {
        draft.facts = facts
        draft.loading = false
        this.readFailure.clearOwn(draft)
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.store.update((draft) => {
        draft.loading = false
        draft.error = this.readFailure.record(message)
      })
    }
  }
}
/**
 * 市场页的注入面：市场自己的面 + 升级面。
 *
 * 为什么写成一个显式接口（而不是 `MarketplaceFace & UpgradeFace`）：两边的 hooks 记录
 * 用交叉类型表达时，官方 `PropsHooks` 的映射类型在交叉上**推导不出** useMarketplace /
 * useUpgrade 两个成员（实测编译报"Property 'useMarketplace' is missing"）。
 * 一个显式的 hooks 记录把两件事说清楚，也省掉一处会被读错的类型体操。
 */
export interface MarketplaceConsoleFace {
  hooks: {
    marketplace: SnapshotStore<MarketplaceState>
    upgrade: SnapshotStore<UpgradeState>
  }
  loadMarketplace(refresh: boolean): void
  setMarketQuery(query: string): void
  setMarketCategory(category: string): void
  setMarketKind(kind: MarketItemKind | ''): void
  installMarketItem(item: MarketItemView): void
  dismissInstallNotice(): void
  ensureUpgrades(): void
  loadUpgrades(refresh: boolean): void
  upgradePackage(name: string, version: string, spec?: string): void
  rollbackPackage(name: string, version: string, spec?: string): void
  dismissUpgradeNotice(): void
}

/**
 * 升级控制器。
 *
 * 两条纪律与其它控制器一致，另加一条本块特有的：
 *   · **不做乐观更新**：升级结果只由 job 的落定结果写入（REST-CONTRACT 明确禁止）；
 *   · **失败不吞**：载荷残缺记 errorKey，host 报错记 error，两者都不写进 action；
 *   · **升级成功后立刻重查**（版本事实过期了），但重查**不许**清掉刚写下的结果
 *     —— 顺序必须是"先落结果、再刷新"（task-18 的 P1 就是这个顺序）。
 */
export class UpgradeController {
  private readonly store: SnapshotStore<UpgradeState>
  /** "读检查结果"写下的失败；只有它能被下一次成功的读取清掉（见 ReadFailureLedger）。 */
  private readonly readFailure = new ReadFailureLedger()
  /** 进入即查是否已经发过（一次会话一次；见 ensureLoaded）。 */
  private kicked = false

  constructor() {
    this.store = createSnapshotStore<UpgradeState>({
      check: undefined, loading: false, error: undefined, busy: undefined, action: undefined, rollback: undefined,
    })
  }

  /** 供注册项使用的注入面。 */
  inject(): UpgradeFace {
    return {
      hooks: { upgrade: this.store },
      ensureUpgrades: () => { void this.ensureLoaded() },
      loadUpgrades: (refresh) => { void this.load(refresh) },
      upgradePackage: (name, version, spec) => { void this.upgrade(name, version, spec) },
      rollbackPackage: (name, version, spec) => { void this.rollback(name, version, spec) },
      dismissUpgradeNotice: () => {
        this.store.update((draft) => { draft.action = undefined; draft.rollback = undefined })
      },
    }
  }

  /** 当前快照（index.ts 的注册对账要读它）。 */
  snapshot(): UpgradeState {
    return this.store.getSnapshot()
  }

  /**
   * 进入即查的**去重口**：一次会话只发一次（见 {@link UpgradeFace.ensureUpgrades}）。
   *
   * 已经查过（成功或失败）就不再发；手动检查与台账变化走 {@link load}，绕过这个闸门。
   */
  async ensureLoaded(): Promise<void> {
    if (this.kicked) return
    this.kicked = true
    await this.load(false)
  }

  /**
   * 读一次升级检查结果。
   *
   * 只动 loading / 自己写下的读失败：action 描述的是"上一次操作"，刷新无权替它宣布结果。
   *
   * @param refresh - 手动检查（无视开关、TTL 与负缓存）。
   */
  async load(refresh: boolean): Promise<void> {
    this.store.update((draft) => { draft.loading = true })
    try {
      const result = normalizeUpgradeCheck(await callOp<unknown>('upgradeCheck', { refresh }))
      if (result === undefined) {
        this.store.update((draft) => {
          draft.loading = false
          draft.errorKey = this.readFailure.record('error.incompletePayload')
        })
        return
      }
      this.store.update((draft) => {
        draft.check = result
        draft.loading = false
        this.readFailure.clearOwn(draft)
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.store.update((draft) => {
        draft.loading = false
        draft.error = this.readFailure.record(message)
      })
    }
  }

  /**
   * 升级一个包（长操作：走 job + 轮询）。
   *
   * 结果落定后**先写 action，再重查**——顺序反过来，重查会清掉刚写下的失败。
   *
   * @param name - 包名。
   * @param version - 目标版本。
   * @param spec - 当前来源（host 据此判断"升级会改变来源"与回滚目标）。
   */
  async upgrade(name: string, version: string, spec?: string): Promise<void> {
    this.store.update((draft) => {
      draft.busy = name
      draft.action = undefined
      draft.rollback = undefined
      draft.error = undefined
      draft.errorKey = undefined
    })
    try {
      const raw = await runJob<unknown>('upgrade', {
        name, version, ...spec === undefined ? {} : { spec },
      })
      const result = normalizeUpgradeAction(raw)
      this.store.update((draft) => {
        draft.busy = undefined
        draft.action = {
          outcome: upgradeOutcome(result),
          name: result.name === '' ? name : result.name,
          fromVersion: result.fromVersion,
          toVersion: result.toVersion === '' ? version : result.toVersion,
          ok: result.ok,
          output: result.output,
          ...result.code === undefined ? {} : { code: result.code },
          canary: canaryVerdict(result.canary),
          ...result.canary?.skippedReason === undefined ? {} : { canaryNote: result.canary.skippedReason },
          ...result.canary?.output === undefined ? {} : { canaryOutput: result.canary.output },
          ...result.canary?.activated === undefined ? {} : { canaryActivated: result.canary.activated },
          restartRequired: result.restartRequired,
          diskFacts: result.diskFacts,
          // 本次用的 spec：回滚要用它判断"原来是不是本地来源"（引擎的 rollbackUpgrade 读它，
          // 是本地来源就装回那个来源，而不是装 registry 上的版本）。不带上它，
          // 回滚会把一个 link:/file: 装的包换成 registry 版本——那不是回滚，是换来源。
          ...result.spec.length === 0 ? {} : { spec: result.spec },
        }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.store.update((draft) => {
        draft.busy = undefined
        // 传输层/轮询失败也是失败：写进 action 的 outcome=failed，而不是只留一句 error
        // —— 否则界面会出现"什么都没说"的状态，与"成功"无从区分。
        draft.action = {
          outcome: 'failed', name, fromVersion: null, toVersion: version, ok: false,
          output: message, canary: 'absent', restartRequired: false, diskFacts: [],
        }
      })
    }
    // 版本事实过期了：重查一次（**在结果落定之后**）。
    await this.load(true)
  }

  /**
   * 回滚一个包到指定版本。
   *
   * @param name - 包名。
   * @param version - 回滚目标版本。
   * @param spec - 原来源（本地来源时回滚装回那个来源）。
   */
  async rollback(name: string, version: string, spec?: string): Promise<void> {
    this.store.update((draft) => {
      draft.busy = name
      draft.rollback = undefined
      draft.error = undefined
      draft.errorKey = undefined
    })
    try {
      const raw = await runJob<unknown>('upgradeRollback', {
        name, version, ...spec === undefined ? {} : { spec },
      })
      const result = normalizeUpgradeRollback(raw)
      this.store.update((draft) => {
        draft.busy = undefined
        draft.rollback = {
          name: result.name === '' ? name : result.name,
          ok: result.ok,
          output: result.output,
          ...result.code === undefined ? {} : { code: result.code },
          fromVersion: result.fromVersion,
          toVersion: result.toVersion === '' ? version : result.toVersion,
          clean: result.clean,
          diskFacts: result.diskFacts,
        }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.store.update((draft) => {
        draft.busy = undefined
        draft.rollback = {
          name, ok: false, output: message, fromVersion: null, toVersion: version,
          clean: undefined, diskFacts: [],
        }
      })
    }
    await this.load(true)
  }
}

/**
 * 把字节数格式化成紧凑文本。
 *
 * 单位是量纲不是文案，两种语言共用，因此不进字典。
 *
 * @param bytes - 字节数。
 * @returns 形如 12.3 MiB 的文本。
 */
export function formatBytes(bytes: number): string {
  const mib = bytes / (1024 * 1024)
  if (mib >= 1024) return (mib / 1024).toFixed(1) + ' GiB'
  if (mib >= 10) return mib.toFixed(0) + ' MiB'
  return mib.toFixed(1) + ' MiB'
}

/**
 * 环境控制台注册项的组合注入面：体检、环境、设置三块能力共用一个注册项
 * （一个入口 + 本地子页面，所以只声明一份 face）。
 *
 * 试装（质量门第二步）的字段与测试环境管理都在「设置」子页里，所以它的面也挂在这一份上。
 */
export type ConsoleFace = HealthFace & EnvironmentsFace & ConfigFace & TrialFace

/** 深拷贝一份配置（CompanionConfig 全是 JSON-safe 值）。 */
const cloneConfig = (value: ClientConfig): ClientConfig => structuredClone(value) as ClientConfig

/** 读一条嵌套路径的当前值。 */
function readAtPath(source: unknown, path: readonly string[]): unknown {
  let node: unknown = source
  for (const key of path) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

/** 在深拷贝上叠加全部暂存编辑。 */
function applyEdits(value: ClientConfig, staged: readonly StagedEdit[]): ClientConfig {
  const draft = cloneConfig(value) as unknown as Record<string, unknown>
  for (const edit of staged) {
    let node = draft
    for (const key of edit.path.slice(0, -1)) {
      const next = node[key]
      if (typeof next !== 'object' || next === null || Array.isArray(next)) node[key] = {}
      node = node[key] as Record<string, unknown>
    }
    const leaf = edit.path[edit.path.length - 1]
    if (leaf !== undefined) node[leaf] = edit.value
  }
  return draft as unknown as ClientConfig
}

/**
 * 把一份 JSON 触发成浏览器下载。
 *
 * 只在浏览器里执行：非浏览器渲染环境（测试）下 document 不存在，此时静默跳过——
 * 备份内容已留在状态里，UI 仍可对比与恢复。
 *
 * @param fileName - 建议的文件名。
 * @param payload - 要写进文件的内容。
 */
export function downloadJson(fileName: string, payload: unknown): void {
  if (typeof document === 'undefined') return
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}

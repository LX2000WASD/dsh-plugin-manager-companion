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
  normalizeBackup, normalizeBackupDiff, normalizeCapabilities, normalizeConfig,
  normalizeEnvironmentResult, normalizeEnvironments, normalizeGatedInstall, normalizeKindList,
  normalizeMarketplace, normalizeReport,
} from './wire.ts'

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
 * 一个市场标签的展示文案。
 *
 * 分类与主题是上游原始词（本地化只做"值 → 文案"，不做重排）；安装形态、策展状态与
 * 安全等级走 marketView 的键函数，未知等级折叠成"未知"而不是"低"。
 *
 * @param t - 本插件字典的翻译函数。
 * @param kind - 标签类别。
 * @param value - 标签原始值。
 * @returns 已本地化的标签文本。
 */
export function marketTagLabel(t: TranslateNS<typeof NS>, kind: MarketTagKind, value: string): string {
  switch (kind) {
    case 'type': return t(MARKET_LABEL[typeLabelKey(value)])
    case 'status': return t(MARKET_LABEL[statusLabelKey(value)])
    case 'security': return t(MARKET_LABEL[securityLabelKey(value)])
    default: return value
  }
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

  constructor() {
    this.store = createSnapshotStore<HealthState>({
      report: undefined, running: false, error: undefined, fixingId: undefined, notice: undefined,
      capabilities: undefined, target: undefined,
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
      draft.error = undefined
      draft.errorKey = undefined
    })
    void this.diagnose()
  }

  /**
   * 跑一次诊断。
   * @param layers - 只诊断这些层；省略即按配置全量。
   */
  async diagnose(layers?: readonly DiagnosticLayer[]): Promise<void> {
    const generation = ++this.generation
    const target = this.store.getSnapshot().target
    this.store.update((draft) => {
      draft.running = true
      draft.error = undefined
      draft.errorKey = undefined
      draft.notice = undefined
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
        this.store.update((draft) => { draft.running = false; draft.errorKey = 'error.incompletePayload' })
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
        draft.error = error instanceof Error ? error.message : String(error)
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
    this.store.update((draft) => { draft.fixingId = issue.id; draft.error = undefined })
    try {
      const result = await runJob<EnvironmentResult>(FIX_OP, { action: action.action, ...action.target === undefined ? {} : { target: action.target } })
      this.store.update((draft) => {
        draft.fixingId = undefined
        draft.notice = result.output
        if (!result.ok) draft.error = result.code ?? result.output
      })
      if (result.ok) await this.diagnose()
    } catch (error) {
      this.store.update((draft) => {
        draft.fixingId = undefined
        draft.error = error instanceof Error ? error.message : String(error)
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

  /** 重新读环境列表。 */
  async refresh(): Promise<void> {
    this.store.update((draft) => { draft.loading = true; draft.error = undefined; draft.errorKey = undefined })
    try {
      const environments = normalizeEnvironments(await callOp<unknown>('listEnvironments', {}))
      if (environments === undefined) {
        this.store.update((draft) => { draft.loading = false; draft.errorKey = 'error.incompletePayload' })
        return
      }
      this.store.update((draft) => { draft.environments = environments; draft.loading = false })
    } catch (error) {
      this.store.update((draft) => {
        draft.loading = false
        draft.error = error instanceof Error ? error.message : String(error)
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
    this.store.update((draft) => { draft.busy = `backup ${name}`; draft.error = undefined; draft.errorKey = undefined; draft.diff = undefined })
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
    this.store.update((draft) => { draft.busy = `diff ${target}`; draft.error = undefined; draft.errorKey = undefined })
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

/** 市场条目在 UI 侧的稳定视图（只带渲染需要的字段）。 */
export interface MarketItemView {
  readonly repo: string
  readonly name: string
}

/** 市场控制器。 */
export class MarketplaceController {
  private readonly store: SnapshotStore<MarketplaceState>

  constructor() {
    this.store = createSnapshotStore<MarketplaceState>({
      result: undefined, loading: false, error: undefined, query: '', category: '', kind: '',
      installing: undefined, installError: undefined, gateIssues: [], rolledBack: false,
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
        this.store.update((draft) => { draft.installError = undefined; draft.gateIssues = []; draft.rolledBack = false })
      },
    }
  }

  /**
   * 读市场索引。
   * @param refresh - 是否强制绕过缓存。
   */
  async load(refresh: boolean): Promise<void> {
    this.store.update((draft) => { draft.loading = true; draft.error = undefined; draft.errorKey = undefined })
    try {
      const result = normalizeMarketplace(await callOp<unknown>('marketplace', { refresh }))
      if (result === undefined) {
        this.store.update((draft) => { draft.loading = false; draft.errorKey = 'error.incompletePayload' })
        return
      }
      this.store.update((draft) => { draft.result = result; draft.loading = false })
    } catch (error) {
      this.store.update((draft) => {
        draft.loading = false
        draft.error = error instanceof Error ? error.message : String(error)
      })
    }
  }

  /**
   * 经质量门安装一个市场条目。
   * @param item - 要安装的条目。
   */
  async install(item: MarketItemView): Promise<void> {
    this.store.update((draft) => {
      draft.installing = item.repo
      draft.installError = undefined
      draft.gateIssues = []
      draft.rolledBack = false
    })
    try {
      const result = normalizeGatedInstall(await runJob<unknown>('install', { spec: item.repo }))
      this.store.update((draft) => {
        draft.installing = undefined
        draft.gateIssues = result.gateIssues
        draft.rolledBack = result.rolledBack === true
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
    this.store.update((draft) => { draft.loading = true; draft.error = undefined; draft.errorKey = undefined })
    try {
      const result = normalizeKindList(await callOp<unknown>('listKinds', {}))
      if (result === undefined) {
        this.store.update((draft) => { draft.loading = false; draft.errorKey = 'error.incompletePayload' })
        return
      }
      this.store.update((draft) => {
        draft.records = result.records
        draft.orphans = result.orphans
        draft.loading = false
      })
    } catch (error) {
      this.store.update((draft) => {
        draft.loading = false
        draft.error = error instanceof Error ? error.message : String(error)
      })
    }
  }

  /**
   * 卸载一个已安装的技能或预设。
   * @param repo - owner/repo。
   */
  async uninstall(repo: string): Promise<void> {
    this.store.update((draft) => { draft.busy = repo; draft.error = undefined; draft.notice = undefined })
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
  /** 渲染用草稿：已过 wire 归一（缺字段按客户端默认值补齐）再叠加本地编辑。 */
  draft: CompanionConfig | undefined
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

/**
 * 环境控制台注册项的组合注入面：体检、环境、设置三块能力共用一个注册项
 * （一个入口 + 本地子页面，所以只声明一份 face）。
 */
export type ConsoleFace = HealthFace & EnvironmentsFace & ConfigFace

/** 深拷贝一份配置（CompanionConfig 全是 JSON-safe 值）。 */
const cloneConfig = (value: CompanionConfig): CompanionConfig => structuredClone(value) as CompanionConfig

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
function applyEdits(value: CompanionConfig, staged: readonly StagedEdit[]): CompanionConfig {
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
  return draft as unknown as CompanionConfig
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

/**
 * 官方适配层：本插件与 DSH 官方能力之间的**唯一**接口。
 *
 * 归属：A 类·重写（新代码；旧仓库没有这一层，它直接自建了 REST + patch 写入）。
 * 官方复用：pluginManager 服务（当前环境写操作）、host-plugin-inventory
 *   （运行时事实）、app-boot 的 profile 读取与 operations 的 pnpm 通道。
 * 前提检查：旧仓库假设"官方只有只读清单，所以必须自建写路径"。0.1.6 之后
 *   该前提消失——官方提供了完整的当前环境写面。本层的职责就是让其余模块
 *   **不必知道**官方长什么样，同时把"官方不可用"如实降级而不是崩溃。
 *
 * 三条硬约束（写在类型与运行时里，不靠约定）：
 *   1. 当前环境的写操作只走官方 —— 本模块不实现任何文件写入。
 *   2. 服务名绝不用 'pluginManager' —— 官方已占用，同名注册会让整个
 *      profile 起不来（旧仓库实测踩过）。
 *   3. 任何官方能力缺失都降级为"能力不可用 + 原因"，绝不静默假装成功。
 */

import type { Context } from '@deepseek-ai/cordis'
import { configState } from './settings.ts'
import type {
  BundleInfo, ChangeResult, PluginEntryId, PluginInfo, PluginInventorySnapshot,
  PluginSpecInspection,
} from './types.ts'

/**
 * 官方能力的可用性快照。
 *
 * 设计意图：把"官方在不在、给不给这个能力"变成**可展示的事实**，而不是
 * 让调用方在一堆 try/catch 里猜。诊断页会把 unavailable 的原因直接呈现给
 * 用户（"这个环境没有装配官方插件管理器，以下检查已跳过"），而不是把
 * 缺失伪装成健康。
 */
export interface OfficialCapabilities {
  /** 当前环境是否由 dsh 以 profile 方式启动（决定 profileContext 是否存在）。 */
  readonly profileBacked: boolean
  /** 官方 pluginManager 服务是否可用（当前环境的管理能力）。 */
  readonly manager: boolean
  /** 官方 pluginInventory 是否可用（运行时事实）。 */
  readonly inventory: boolean
  /** 当前环境名；未知时为 null。 */
  readonly environmentName: string | null
  /** 缺失能力的说明，直接面向用户展示。 */
  readonly missing: readonly string[]
}

/**
 * 官方能力的探针。
 *
 * 为什么用 `ctx.get(name)` 而不是声明式 `inject`：
 * 官方 pluginManager 行在 base bundle 里带
 * `disabled: !!js "!ctx.get('profileContext')"`，即**没有 profile 时它不装配**。
 * 若我们声明式 inject 它，本插件会永远停在 PENDING 而不做任何事——用户看到
 * 一个"装了但没反应"的插件，且没有任何可读的错误。探针 + 降级让插件在
 * 任何宿主上都能加载并如实说明自己不能做什么。
 *
 * @param ctx - 本插件的 host 上下文。
 * @returns 当前可用能力；缺失原因在 `missing` 里逐条列出。
 */
export function probeOfficialCapabilities(ctx: Context): OfficialCapabilities {
  const missing: string[] = []
  const profileContext = ctx.get('profileContext')
  const profileBacked = profileContext !== undefined

  // 官方服务名是 'pluginManager'；我们只读它，绝不提供同名服务。
  const managerService = ctx.get('pluginManager')
  const manager = managerService !== undefined
  if (!manager) {
    missing.push(profileBacked
      ? '官方 pluginManager 服务未装配：本环境无法执行安装/启停（请确认 @deepseek-ai/dsh-plugin-manager 行未被禁用）'
      : '当前进程不是以 dsh profile 启动的，官方插件管理能力不适用')
  }

  const inventory = ctx.get('loader') !== undefined
  if (!inventory) missing.push('Loader 服务不可用：运行时事实类检查已跳过')

  // 配置面降级也要出现在这里：用户看到的是"我改的设置没生效"，必须能在同一处读到原因。
  const config = configState()
  if (!config.writable) missing.push('配置不可写（' + (config.detail ?? config.reason ?? '原因未知') + '）')

  return {
    profileBacked,
    manager,
    inventory,
    environmentName: profileBacked ? profileContext.name : null,
    missing,
  }
}

/**
 * 官方 pluginManager 服务的**结构式**视图。
 *
 * 类型面保留官方管理的完整可读面；**运行时校验**只覆盖我们真正调用的方法
 * （见 REQUIRED_MANAGER_METHODS）。两者刻意分开：
 *   · listPlugins / listBundles 在本仓库 0 处调用（2026-09-19 核过），所以不进必需清单——
 *     官方改它们时不该让我们报"能力不可用"（那是误报）；
 *   · 但它们留在类型面里，谁以后要用就有现成的类型，也不必现在顺手收紧类型面。
 *
 * 不 import 官方类：官方包是 peer，小版本之间可能有增减；结构式引用让"官方少了一个
 * 方法"变成一次运行时可读的降级，而不是调用点的 TypeError。
 */
interface OfficialManagerLike {
  listPlugins(): Promise<PluginInfo[]>
  listBundles(): Promise<BundleInfo[]>
  inspect(spec: string, signal?: AbortSignal): Promise<PluginSpecInspection>
  setPluginEnabled(id: PluginEntryId, enabled: boolean): Promise<ChangeResult>
  setBundleEnabled(name: string, enabled: boolean): Promise<ChangeResult>
  installBundle(spec: string, options?: {
    enabled?: boolean
    requestId?: string
    approvedBuilds?: readonly string[]
  }): Promise<ChangeResult>
  removeBundle(name: string): Promise<ChangeResult>
}

/** 官方能力调用失败的统一错误。 */
export class OfficialUnavailableError extends Error {
  /**
   * @param capability - 缺失的能力名（用于 UI 分组）。
   * @param reason - 面向用户的原因说明。
   */
  constructor(readonly capability: string, reason: string) {
    super(reason)
    this.name = 'OfficialUnavailableError'
  }
}

/**
 * 我们真正调用过的 pluginManager 方法（缺任何一个都让这项能力不可用）。
 *
 * 为什么是显式清单而不是"把接口上的方法全列一遍"：接口是契约面，方法清单是**实际使用**面。
 * 只有后者才能在官方改方法时给出准确的"我们用到的那一个不见了"，也不会因为官方增删
 * 我们没用的方法而误报。清单与 OfficialManagerLike 必须同步（下面有编译期校验）。
 */
const REQUIRED_MANAGER_METHODS = [
  'inspect', 'setPluginEnabled', 'setBundleEnabled', 'installBundle', 'removeBundle',
] as const satisfies readonly (keyof OfficialManagerLike)[]

/** 取该对象上名为 name 的成员是否可调用（含原型链上的方法）。 */
function isCallableMethod(service: object, name: string): boolean {
  let current: object | null = service
  while (current !== null) {
    const value = (current as Record<string, unknown>)[name]
    if (value !== undefined) return typeof value === 'function'
    current = Object.getPrototypeOf(current) as object | null
  }
  return false
}

/**
 * 取官方 pluginManager，缺失时抛出可读错误。
 *
 * 每个调用点都必须经过它——这样"官方不可用"永远以一个**具名错误**出现，
 * 而不是 `undefined.listBundles is not a function`。
 *
 * 两层校验：服务存在（ctx.get）与**我们用到的方法存在**。第二层是 2026-09-19 补的：
 * 官方改/删一个 Remote 方法时，用户原本看到调用点的 TypeError（读不懂）；现在得到的是
 * "缺哪个方法"+"所以这项能力不可用"。
 *
 * @param ctx - 本插件的 host 上下文。
 * @returns 官方管理器（结构式视图）。
 * @throws {OfficialUnavailableError} 官方管理器未装配，或缺少我们调用到的方法时。
 */
export function requireManager(ctx: Context): OfficialManagerLike {
  const service = ctx.get('pluginManager')
  if (service === undefined) {
    throw new OfficialUnavailableError('pluginManager', probeOfficialCapabilities(ctx).missing[0]
      ?? '官方 pluginManager 服务不可用')
  }
  const absent = REQUIRED_MANAGER_METHODS.filter(name => !isCallableMethod(service, name))
  if (absent.length > 0) {
    throw new OfficialUnavailableError('pluginManager',
      '官方 pluginManager 缺少我们用到的' + (absent.length > 1 ? '这些方法：' : '方法：') + absent.join('、')
      + '：说明官方依赖的接口与预期不一致（官方改过或删过这个方法），'
      + '因此"当前环境的插件管理"这项能力不可用——升级/回退 @deepseek-ai/dsh-plugin-manager，'
      + '或改用官方 CLI（dsh plugin）完成同一步操作。')
  }
  return service as unknown as OfficialManagerLike
}

/**
 * 读运行时事实。
 *
 * 优先走官方 `readPluginInventory`（它对 Loader 的投影有自己的一致性保证），
 * 拿不到时退回直接读 `ctx.loader.entries()`——用户明确要求"最大化利用能力，
 * 但同时保证不出错"，所以两条路都要有，且**降级是显式的**。
 *
 * 返回的 `source` 让诊断页能如实标注数据来源：官方投影口径与直接读 Loader
 * 口径在字段上一致，但前者会跳过 group 行，后者不会。
 *
 * @param ctx - 本插件的 host 上下文。
 * @returns 运行时条目与数据来源；两者都不可用时 `entries` 为空且给出原因。
 */
export async function readRuntimeInventory(ctx: Context): Promise<{
  readonly entries: PluginInventorySnapshot['entries']
  readonly agentPresets: PluginInventorySnapshot['agentPresets']
  readonly source: 'official' | 'loader' | 'unavailable'
  readonly reason?: string
}> {
  // 官方投影优先。
  try {
    const mod = await import('@deepseek-ai/dsh-host-plugin-inventory')
    const snapshot = await mod.readPluginInventory(ctx)
    return { entries: snapshot.entries, agentPresets: snapshot.agentPresets, source: 'official' }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    // 降级：直接读 Loader，拿得到就标注来源为 loader。
    const loader = ctx.get('loader') as { entries?: () => Iterable<unknown> } | undefined
    if (loader?.entries === undefined) {
      return { entries: [], agentPresets: undefined, source: 'unavailable', reason }
    }
    try {
      const entries: PluginInventorySnapshot['entries'][number][] = []
      for (const raw of loader.entries()) {
        const entry = raw as {
          id?: unknown
          disabled?: unknown
          options?: { group?: unknown; name?: unknown }
          fiber?: { state?: unknown }
        }
        if (entry.options?.group) continue
        entries.push({
          entryId: String(entry.id ?? '') as PluginInventorySnapshot['entries'][number]['entryId'],
          moduleName: String(entry.options?.name ?? ''),
          enabled: entry.disabled !== true,
          fiberPhase: fiberPhaseOf(entry.fiber?.state),
        })
      }
      return { entries, agentPresets: undefined, source: 'loader' }
    } catch (loaderError) {
      return {
        entries: [], agentPresets: undefined, source: 'unavailable',
        reason: reason + '; loader fallback failed: ' + (loaderError instanceof Error ? loaderError.message : String(loaderError)),
      }
    }
  }
}

/**
 * Cordis FiberState 到官方相位标签的映射。
 *
 * 数值取自 `@deepseek-ai/cordis` 的 `FiberState` 枚举（PENDING=0 …
 * UNLOADING=5）。旧仓库自己定义了一套映射且与本表不一致，是实际缺陷；
 * 这里逐项对齐官方 `plugin-inventory` 的 `FIBER_PHASE`。
 *
 * @param state - fiber.state 的原始数值；undefined 表示无存活 fiber。
 * @returns 官方相位标签，或 null。
 */
export function fiberPhaseOf(state: unknown): PluginInventorySnapshot['entries'][number]['fiberPhase'] {
  switch (state) {
    case 0: return 'pending'
    case 1: return 'loading'
    case 2: return 'active'
    case 3: return 'failed'
    case 4: return null          // DISPOSED
    case 5: return 'unloading'
    default: return null
  }
}

/**
 * 官方能力缺失时是否应该继续。
 *
 * 只读检查（诊断、盘点）在能力缺失时**继续**，但把缺失记进报告的 `skipped`；
 * 写操作必须**失败**，因为静默跳过写会让用户以为改了而实际没改。
 *
 * @param capabilities - 探针结果。
 * @returns 可执行的只读检查项与不可执行的原因。
 */
export function readOnlyAvailability(capabilities: OfficialCapabilities): {
  readonly canReadRuntime: boolean
  readonly reason?: string
} {
  return capabilities.inventory
    ? { canReadRuntime: true }
    : { canReadRuntime: false, reason: 'Loader 服务不可用，运行时检查无法执行' }
}

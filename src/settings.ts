/**
 * 本插件的配置面。
 *
 * 归属：A 类·重写（新代码；旧仓库把配置散在 profile 文件与 market 缓存里）。
 * 官方复用：ctx.settings（SettingsProvider）—— 注册一个命名空间，由官方负责
 *   校验、落盘、修订号与观察。
 * 前提检查：用户明确要求"无需手动编辑配置文件"。官方 settings 服务正是这条
 *   要求的原生实现；自己写 YAML 既违背要求也与官方并发写同一文件。
 *
 * 配置只描述**本插件自己的行为**，绝不描述环境状态：环境状态是事实，读出来
 * 即可，不该由用户配置。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** 本插件在官方 settings 里的命名空间（小写连字符，官方校验）。 */
export const SETTINGS_NAMESPACE = 'plugin-manager-companion'

/**
 * 诊断深度。用户要求"最大化利用能力，但同时保证不出错"，所以深度是**可选**的：
 * 环境不支持某一层时，该层自动跳过并在报告里标注，而不是让整次诊断失败。
 */
export interface DiagnosticsConfig {
  /** 依赖层（静态扫描 import 图）。 */
  readonly dependency: boolean
  /** 组合层（patch 层栈与行 id）。 */
  readonly composition: boolean
  /** 运行时层（loader fiber 相位、注册表冲突）。需要 Loader 服务。 */
  readonly runtime: boolean
  /** 一致性层（官方 inventory 与本地文件对照）。 */
  readonly consistency: boolean
  /** 生态层（市场索引的更新与风险）。需要网络。 */
  readonly ecosystem: boolean
}

/** 安装前质量门的配置。 */
export interface QualityGateConfig {
  /** 是否在安装前扫描。关闭后安装直接交给官方，不做前置校验。 */
  readonly enabled: boolean
  /**
   * 拦截强度。
   * - `block`：发现问题即回滚（默认）
   * - `warn`：只报告，仍完成安装
   */
  readonly mode: 'block' | 'warn'
  /**
   * 豁免的包名。用于质量门误伤的第三方包（其依赖声明方式超出规则能表达的
   * 范围）。加进来即跳过全部检查——这是用户显式承担风险的选择。
   */
  readonly allowlist: readonly string[]
}

/** 市场配置。 */
export interface MarketplaceConfig {
  /** 是否在设置页与市场页启用远程索引。关闭后市场页只显示已安装信息。 */
  readonly enabled: boolean
  /** 索引缓存有效期（分钟）。 */
  readonly cacheTtlMinutes: number
  /** 网络请求超时（毫秒）。 */
  readonly timeoutMs: number
  /**
   * 上游索引地址。默认取社区维护的 topic:dsh-plugin 全量索引。
   * 留空表示只用内置默认源。
   */
  readonly indexUrl: string
}

/** 本插件的完整配置。 */
export interface CompanionConfig {
  readonly diagnostics: DiagnosticsConfig
  readonly qualityGate: QualityGateConfig
  readonly marketplace: MarketplaceConfig
}

/** 默认配置：诊断全开、质量门拦截、市场启用。 */
export const DEFAULT_CONFIG: CompanionConfig = {
  diagnostics: {
    dependency: true,
    composition: true,
    runtime: true,
    consistency: true,
    // 生态层要联网，默认关闭——诊断页在用户显式开启后才访问网络。
    ecosystem: false,
  },
  qualityGate: { enabled: true, mode: 'block', allowlist: [] },
  marketplace: { enabled: true, cacheTtlMinutes: 1440, timeoutMs: 15_000, indexUrl: '' },
}

/**
 * 官方 settings 的 schema。
 *
 * `.default()` 逐项给出，使旧配置文件在新增字段后仍能解析；未知字段由
 * schemastery 丢弃，不会因为未来删字段而炸掉整份配置。
 */
export const ConfigSchema = z.object({
  diagnostics: z.object({
    dependency: z.boolean().default(true),
    composition: z.boolean().default(true),
    runtime: z.boolean().default(true),
    consistency: z.boolean().default(true),
    ecosystem: z.boolean().default(false),
  }).default({ ...DEFAULT_CONFIG.diagnostics }),
  qualityGate: z.object({
    enabled: z.boolean().default(true),
    mode: z.union([z.const('block'), z.const('warn')]).default('block'),
    allowlist: z.array(z.string()).default([]),
  }).default({
    enabled: DEFAULT_CONFIG.qualityGate.enabled,
    mode: DEFAULT_CONFIG.qualityGate.mode,
    allowlist: [...DEFAULT_CONFIG.qualityGate.allowlist],
  }),
  marketplace: z.object({
    enabled: z.boolean().default(true),
    cacheTtlMinutes: z.number().min(1).max(10_080).default(1440),
    timeoutMs: z.number().min(1_000).max(120_000).default(15_000),
    indexUrl: z.string().default(''),
  }).default({ ...DEFAULT_CONFIG.marketplace }),
})

/** 配置的读写句柄。 */
export interface ConfigHandle {
  /** 当前生效配置（官方已解析默认值与用户层）。 */
  current(): CompanionConfig
  /** 观察配置提交；返回取消订阅函数。 */
  watch(listener: (next: CompanionConfig) => void): () => void
  /**
   * 合并写入一个局部配置，由官方 settings 服务负责校验与落盘。
   *
   * 不提供"重置为默认"以外的整段替换：局部合并足以表达界面上所有开关，
   * 而整段替换会让界面漏掉一个字段就把它打回默认值。
   *
   * @param patch - 局部配置。
   * @returns 写入完成后的生效配置。
   */
  update(patch: Partial<CompanionConfig>): Promise<CompanionConfig>
}

/**
 * 注册本插件的 settings 命名空间。
 *
 * 官方 `register` 在命名空间已注册时**抛错**（同一进程内不允许两个所有者）。
 * 本插件可能在多个 profile 中被加载，但每个 host 进程只有一个 Cordis 根，
 * 所以冲突只会来自"同一个插件被装配两次"——那属于装配错误，让它响亮地失败
 * 比静默让后者覆盖前者更安全。
 *
 * @param ctx - 本插件的 host 上下文。
 * @returns 配置句柄；官方 settings 服务不可用时返回默认配置的只读句柄。
 */
/**
 * 官方 settings 服务尚不可用时的**只读**降级句柄。
 *
 * 为什么需要它：settings 服务可能**晚于**本插件装配（服务挂载顺序不保证），
 * 而配置句柄会被各模块长期持有。装配层先拿这个，等服务出现再换成真句柄。
 *
 * `update` 刻意**抛错**而不是静默返回默认值——静默丢写是最糟的失败形态：
 * 用户改了配置、界面回显成功、实际什么都没发生（实测踩过，见 CONTEXT.md）。
 *
 * @returns 只读句柄；任何写入尝试都抛出可读错误。
 */
export function fallbackConfigHandle(): ConfigHandle {
  return {
    current: () => DEFAULT_CONFIG,
    watch: () => () => {},
    update: () => Promise.reject(new Error(
      '配置服务（settings）尚未就绪；写入被拒绝而不是丢弃——请稍后重试',
    )),
  }
}

/**
 * 注册本插件的 settings 命名空间。
 *
 * **调用方必须保证 ctx 上 settings 已可用**（装配层用 ctx.inject(['settings'], …) 保证）。
 * 这里保留缺失分支只为防御：真的走到它说明装配层接线错了，此时给只读句柄并记日志，
 * 而不是让整个插件装配失败。
 *
 * @param ctx - settings 服务已就绪的上下文。
 * @returns 配置句柄。
 */
export function registerConfig(ctx: Context): ConfigHandle {
  const settings = ctx.get('settings')
  if (settings === undefined) {
    ctx.logger?.warn?.('plugin-manager-companion: settings 服务未就绪，配置降级为只读——装配层应改用 ctx.inject(["settings"])')
    return fallbackConfigHandle()
  }
  const scope = settings.register(SETTINGS_NAMESPACE, ConfigSchema)
  return {
    current: () => scope.get() as CompanionConfig,
    watch: (listener) => scope.watch((next: unknown) => { listener(next as CompanionConfig) }),
    update: async (patch) => {
      await scope.update(patch as object)
      return scope.get() as CompanionConfig
    },
  }
}

/**
 * dsh-plugin-manager-companion — 插件入口（装配骨架）。
 *
 * 归属：A 类·重写。
 * 官方复用：ctx.profileContext / ctx.pluginManager / ctx.settings。
 * 前提检查：旧仓库入口自建 27 个 REST op + job 系统 + patch 写入；那些前提在
 *   0.1.6 之后消失（官方提供完整当前环境写面），故本入口只做三件事：注册配置、
 *   探测官方能力、把能力交给各子模块。
 *
 * 硬约束：服务名绝不用 pluginManager（官方已占用，同名会让整个 profile 起不来）。
 */

import type { Context } from "@deepseek-ai/cordis"
import { probeOfficialCapabilities, type OfficialCapabilities } from "./official.ts"
import { registerConfig, type ConfigHandle } from "./settings.ts"

/** 本插件对外的服务名。绝不用 pluginManager —— 那是官方的。 */
export const SERVICE_NAME = "companion"

/** 插件配置的 schema，供宿主配置界面与校验使用。 */
export { ConfigSchema } from "./settings.ts"

/** Loader 行名，等于包名；cordis.patch.yml 必须用同一个 id。 */
export const name = "dsh-plugin-manager-companion"

/** 装配时必需的服务；官方能力用 get 探测，因此这里只列真正硬需要的。 */
export const inject = ["loader"]

/** 一次装配里我们持有的运行时状态。 */
interface CompanionRuntime {
  readonly capabilities: OfficialCapabilities
  readonly config: ConfigHandle
}

let runtime: CompanionRuntime | undefined

/**
 * 插件装配。
 *
 * 这个阶段只做必须有的事：注册配置命名空间、探测官方能力、把结果留给自己。
 * 各能力模块（诊断 / 环境 / 市场 / 技能）在各自的装配点接入，避免入口膨胀。
 *
 * @param ctx - host 上下文。
 */
export function apply(ctx: Context): void {
  const capabilities = probeOfficialCapabilities(ctx)
  const config = registerConfig(ctx)
  runtime = { capabilities, config }

  // 能力缺失如实记账，不假装健康：诊断页会把这些原因直接呈现给用户。
  for (const reason of capabilities.missing) {
    ctx.logger?.info?.(`plugin-manager-companion: ${reason}`)
  }

  ctx.effect(() => () => { runtime = undefined }, "companion: runtime")
}

/** 读取当前装配状态（诊断与 UI 用）。未装配时返回 undefined。 */
export function currentRuntime(): CompanionRuntime | undefined {
  return runtime
}

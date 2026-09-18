/**
 * dsh-plugin-manager-companion — 插件入口与 op 分派。
 *
 * 归属：A 类·重写（旧仓库入口 2358 行，把服务、路由、job、缓存闭包全塞在一起）。
 * 官方复用：ctx.profileContext / ctx.pluginManager（经 official.ts 探测）/ ctx.settings /
 *   ctx.webServer / ctx.tools / ctx.systemPrompt。
 * 前提检查：旧仓库入口自建 27 个 REST op + job 系统 + patch 写入，前提是"官方只有只读清单"。
 *   0.1.6 之后前提消失：**当前环境**的写操作全部交还官方 Remote；本入口只保留官方不覆盖的部分
 *   （深度诊断、跨环境管理、市场、技能与预设、质量门编排）。
 *
 * 硬约束：服务名绝不用 pluginManager（官方已占用，同名会让整个 profile 起不来）。
 */

import type { Context } from "@deepseek-ai/cordis"
import { analyzeEnvironment } from "./diagnostics.ts"
import { backupDiff, backupExport, backupRestore, copyPlugins, createEnvironment, listEnvironments, removeEnvironment, renameEnvironment, scanRuns, startEnvironment, stopEnvironment } from "./envManager.ts"
import { loadKindRecords, presetsRoot, pruneGhostRecords, removeKindDir, removeKindRecord, skillsRoot } from "./kinds.ts"
import { buildInstalledIndex, cachedMarketplace, invalidateInstalledIndex, registryItems } from "./marketplace.ts"
import { probeOfficialCapabilities, requireManager, type OfficialCapabilities } from "./official.ts"
import { environmentDir as pathEnvironmentDir, OUR_PACKAGE_NAME } from "./paths.ts"
import { inspectPackage } from "./qualityGate.ts"
import { applyFix } from "./fix.ts"
import { loadRegistryIndex } from "./registry.ts"
import { findPluginMatches } from "./match.ts"
import { registerGuard } from "./guard.ts"
import { registerCompanionTools } from "./tools.ts"
import { BODY_LIMIT_DEFAULT, JobRegistry, ROUTE_PREFIX, isJsonPost, isTrustedRequest, readJsonBody, sendJson, type Envelope } from "./rest.ts"
import { fallbackConfigHandle, registerConfig, type CompanionConfig, type ConfigHandle } from "./settings.ts"
import type { DiagnosticLayer, DiagnosticReport, EnvironmentInfo, EnvironmentResult, GatedInstallResult, KindListResult, MarketplaceResult } from "./types.ts"
import type { IncomingMessage, ServerResponse } from "node:http"

/** 本插件对外的服务名。绝不用 pluginManager —— 那是官方的。 */
export const SERVICE_NAME = "companion"

/** 插件配置的 schema，供宿主配置界面与校验使用。 */
export { ConfigSchema } from "./settings.ts"

/** Loader 行名，等于包名；cordis.patch.yml 必须用同一个 id。 */
export const name = OUR_PACKAGE_NAME

/** 装配时必需的服务；官方能力用 get 探测，因此这里只列真正硬需要的。 */
export const inject = ["loader"]

/** 一次装配持有的运行时状态。 */
interface CompanionRuntime {
  readonly capabilities: OfficialCapabilities
  readonly config: ConfigHandle
  readonly jobs: JobRegistry
}

let runtime: CompanionRuntime | undefined

/** 读取当前装配状态（诊断与 UI 用）。未装配时返回 undefined。 */
export function currentRuntime(): CompanionRuntime | undefined {
  return runtime
}

// ── 质量门编排 ────────────────────────────────────────────────────────────

/**
 * 受质量门保护的安装。
 *
 * 三步走，全部经官方通道，零竞态：
 *   1. inspect(spec) —— 官方读 spec 指向什么（拒绝非法/已装/非 bundle）
 *   2. installBundle(spec, { enabled: false }) —— 官方装但**不激活**
 *   3. 扫描已安装包（我们的质量门）
 *       合格 → setBundleEnabled(name, true) 激活
 *       不合格 → removeBundle(name) 回滚
 *
 * 为什么不需要"安装前钩子"：官方提供了 enabled:false 这个开关（官方 UI 自己就用它）。
 * 装上但不激活，等于把包放进隔离区，扫完再决定是否放行——比"先扫后装"更可靠，
 * 因为扫描对象真实存在于目标位置。
 *
 * @param ctx - host 上下文。
 * @param config - 本插件配置。
 * @param spec - 安装 spec（npm 名 / git 地址 / 本地路径 / tarball）。
 * @param environmentName - 目标环境名；undefined 表示当前环境。
 * @returns 结果；失败时输出里说明是官方拒绝、质量门拦截还是激活失败。
 */
export async function gatedInstall(
  ctx: Context, config: CompanionConfig, spec: string, environmentName?: string,
): Promise<GatedInstallResult> {
  const manager = requireManager(ctx)
  const inspected = await manager.inspect(spec)
  if (inspected.status === "refused") {
    return { ok: false, output: `拒绝安装：${inspected.problem} —— ${inspected.reason}`, gateIssues: [] }
  }
  const installed = await manager.installBundle(spec, { enabled: false })
  if (installed.application === "failed" || installed.bundle === undefined) {
    return {
      ok: false,
      output: `安装失败：${installed.error?.code ?? "unknown"}${installed.error?.diagnostic === undefined ? "" : " —— " + installed.error.diagnostic}`,
      gateIssues: [],
    }
  }
  const packageName = installed.bundle
  if (!config.qualityGate.enabled || config.qualityGate.allowlist.includes(packageName)) {
    await manager.setBundleEnabled(packageName, true)
    invalidateInstalledIndex(environmentName ?? "")
    return { ok: true, output: `已安装并启用 ${packageName}（质量门未启用）`, packageName, gateIssues: [] }
  }
  const targetName = environmentName ?? runtime?.capabilities.environmentName ?? ""
  let gate
  try {
    // 传 ctx：质量门据此拿官方 installAnchor 作为解析根。
    // 不传的话官方 peer 与 bundle 行会被判成缺包——实测踩过（173 条误报的同一根因）。
    gate = await inspectPackage(pathEnvironmentDir(targetName), packageName, config, ctx)
  } catch (error) {
    // 扫描本身失败时不放行：宁可回滚也不让未经校验的包留在环境里。
    await manager.removeBundle(packageName)
    return {
      ok: false,
      output: `质量门无法完成扫描，已回滚：${error instanceof Error ? error.message : String(error)}`,
      packageName, gateIssues: [], rolledBack: true,
    }
  }
  if (!gate.ok && config.qualityGate.mode === "block") {
    await manager.removeBundle(packageName)
    invalidateInstalledIndex(targetName)
    return {
      ok: false,
      output: `质量检查未通过，已回滚 ${packageName}：\n` + gate.issues.map(i => "  - " + i).join("\n"),
      packageName, gateIssues: gate.issues, rolledBack: true,
    }
  }
  await manager.setBundleEnabled(packageName, true)
  invalidateInstalledIndex(targetName)
  const warned = gate.issues.length === 0 ? "" : `（质量门有 ${gate.issues.length} 条提示，按 warn 模式放行）`
  return { ok: true, output: `已安装并启用 ${packageName}${warned}`, packageName, gateIssues: gate.issues }
}

// ── op 分派 ───────────────────────────────────────────────────────────────

/** op 分派需要的外部依赖（测试可注入替身）。 */
export interface OpDependencies {
  readonly ctx: Context
  readonly config: () => CompanionConfig
  readonly configUpdate: (patch: Partial<CompanionConfig>) => Promise<CompanionConfig>
  readonly capabilities: () => OfficialCapabilities
  readonly jobs: JobRegistry
}

/** 从请求体里取一个字符串字段，缺失即报错。 */
function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`字段 ${field} 必须是非空字符串`)
  }
  return value
}

/** 当前环境对象；取不到时 undefined。 */
function currentEnvironment(deps: OpDependencies): EnvironmentInfo | undefined {
  const name = deps.capabilities().environmentName
  if (name === null) return undefined
  return listEnvironments(deps.ctx).find(env => env.name === name)
}

/**
 * 诊断的分析目标。
 *
 * 诊断引擎要求一个真实的 EnvironmentInfo（它据此读 manifest 与 patch）。当前环境
 * 认不出来时给一个空壳：引擎会发现目录不存在并记一条 skipped，报告里如实写着
 * "无法确定当前环境"——而不是伪造一份看起来健康的报告。
 *
 * @param deps - 依赖。
 * @returns 分析目标。
 */
/**
 * 解析一次诊断的目标环境。
 *
 * 指定了名字就在环境列表里找它——找不到时**报错**而不是悄悄退回当前环境：
 * 用户以为在诊断 A 环境、实际诊断的是 B，是最糟的一类静默错误。
 *
 * @param deps - 依赖。
 * @param name - 请求的环境名；省略即当前环境。
 * @returns 诊断目标。
 * @throws {Error} 指定的环境不存在时。
 */
function targetEnvironment(deps: OpDependencies, name: string | undefined): EnvironmentInfo {
  if (name === undefined || name.length === 0) return analysisTarget(deps)
  const found = listEnvironments(deps.ctx).find(env => env.name === name)
  if (found === undefined) throw new Error(`环境不存在：${name}`)
  return found
}

function analysisTarget(deps: OpDependencies): EnvironmentInfo {
  return currentEnvironment(deps) ?? {
    name: "", dir: "", current: true, builtin: false,
    bundles: [], dependencies: [], runs: [],
  }
}

/**
 * 执行一个 op。
 *
 * 分派表刻意扁平：每个 op 一行到几行，复杂编排下沉到各模块（gatedInstall 是唯一例外，
 * 因为它跨官方 Remote 与我们的质量门，属于入口职责）。
 *
 * @param op - 操作名。
 * @param body - 请求体。
 * @param deps - 依赖。
 * @returns 响应信封。
 */
export async function handleOp(
  op: string, body: Record<string, unknown>, deps: OpDependencies,
): Promise<Envelope<unknown>> {
  try {
    const value = await dispatch(op, body, deps)
    return { ok: true, value }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = error instanceof Error && "capability" in error ? "official-unavailable" : "operation-failed"
    return { ok: false, error: { code, message } }
  }
}

async function dispatch(op: string, body: Record<string, unknown>, deps: OpDependencies): Promise<unknown> {
  const config = deps.config()
  // 长操作一律走这个包装：REST 契约规定首包是 `{ jobId }`，不是裸 id。
  // （裸 id 会让客户端把它当成结果——实测导致体检页把字符串当报告读，整页崩空白）
  const asJob = (task: () => Promise<unknown>): { readonly jobId: string } =>
    ({ jobId: deps.jobs.start(task) })
  switch (op) {
    case "capabilities":
      return { capabilities: deps.capabilities(), config }

    case "getConfig":
      return config

    case "setConfig": {
      const patch = body["patch"]
      if (typeof patch !== "object" || patch === null) throw new Error("字段 patch 必须是对象")
      return await deps.configUpdate(patch as Partial<CompanionConfig>)
    }

    case "diagnose": {
      // 诊断目标可指定环境：用户要的是"对当前环境做到极致，再用同一能力管理其他环境"。
      // 省略时诊断当前环境；指定时用同一引擎、同一配置，只是换一个 EnvironmentInfo。
      // 注意：官方 pluginManager Remote 只覆盖**当前**环境，所以对其他环境的写操作走 fix 的
      // needs-manual / operations 路径——诊断本身与作用域无关，可以放心跨环境。
      const requested = typeof body["environment"] === "string" ? body["environment"] : undefined
      return asJob(async () =>
        await analyzeEnvironment(deps.ctx, targetEnvironment(deps, requested), config))
    }

    case "install":
      return asJob(async () =>
        await gatedInstall(deps.ctx, config, requireString(body, "spec"),
          typeof body["environment"] === "string" ? body["environment"] : undefined))

    case "listEnvironments":
      return listEnvironments(deps.ctx)

    case "scanRuns":
      return Object.fromEntries(scanRuns())

    case "startEnvironment":
      return await startEnvironment(requireString(body, "name"), {})

    case "stopEnvironment":
      return await stopEnvironment(requireString(body, "name"))

    case "createEnvironment":
      return await createEnvironment(requireString(body, "name"),
        typeof body["template"] === "string" ? body["template"] : undefined)

    case "renameEnvironment":
      return await renameEnvironment(requireString(body, "from"), requireString(body, "to"))

    case "removeEnvironment":
      return await removeEnvironment(requireString(body, "name"))

    case "copyPlugins": {
      const names = body["names"]
      if (!Array.isArray(names)) throw new Error("字段 names 必须是数组")
      // 必须传 ctx：envManager 从 ctx.profileContext 取官方 installAnchor，
      // 拿不到锚点就拒绝跨环境包操作（拒绝猜路径是对的）。漏传的后果是**功能完全不可用**，
      // 实测踩过——见 docs/private/write-path-audit.md。
      return asJob(async () => await copyPlugins(
        requireString(body, "from"), requireString(body, "to"), names.map(String), { ctx: deps.ctx },
      ))
    }

    case "backupExport":
      return backupExport(requireString(body, "name"))

    case "backupDiff":
      return backupDiff(body["backup"] as never, requireString(body, "target"))

    case "backupRestore":
      // 同样必须传 ctx（见 copyPlugins 的注释）。注意这条自测容易漏过：
      // 差异为空时会**在取锚点之前**提前返回"没有需要恢复的内容"，所以只有真的
      // 有东西要恢复时才会暴露缺锚点。
      return asJob(async () =>
        await backupRestore(body["backup"] as never, requireString(body, "target"), { ctx: deps.ctx }))

    case "marketplace": {
      const marketConfig = config.marketplace
      const envName = deps.capabilities().environmentName ?? ""
      if (!marketConfig.enabled) {
        // 关闭市场时不联网：只回答"本环境装了什么"。
        return { items: [], generatedAt: new Date().toISOString(), cached: false, categories: {} }
      }
      const index = await loadRegistryIndex({
        refresh: body["refresh"] === true,
        timeoutMs: marketConfig.timeoutMs,
        ttlMs: marketConfig.cacheTtlMinutes * 60_000,
        indexUrl: marketConfig.indexUrl,
      })
      const result: MarketplaceResult = cachedMarketplace({
        profile: envName,
        items: registryItems(index.repos),
        generation: index.generation,
        installed: buildInstalledIndex(envName),
        generatedAt: index.generatedAt,
        cached: index.cached,
      })
      return result
    }

    case "listKinds": {
      await pruneGhostRecords()
      const records = await loadKindRecords()
      const result: KindListResult = {
        records: [...records.values()],
        orphans: [],
      }
      void skillsRoot()
      void presetsRoot()
      return result
    }

    case "uninstallKind":
      return asJob(async () => {
        const repo = requireString(body, "repo")
        const records = await loadKindRecords()
        const record = records.get(repo)
        if (record === undefined) return { ok: false, output: `没有安装记录：${repo}`, code: "not-found" }
        const root = record.kind === "skill" ? skillsRoot() : presetsRoot()
        for (const dir of [record.dir]) {
          if (dir.length > 0 && dir !== root) await removeKindDir(root, dir)
        }
        await removeKindRecord(repo)
        return { ok: true, output: `已卸载 ${record.kind} ${repo}` } as EnvironmentResult
      })

    case "fix": {
      const action = requireString(body, "action")
      const target = typeof body["target"] === "string" ? body["target"] : undefined
      return asJob(async () => await applyFix(action, target, {
        ctx: deps.ctx,
        environmentName: () => deps.capabilities().environmentName,
        install: async (spec) => await gatedInstall(deps.ctx, config, spec),
      }))
    }

    case "job":
      return deps.jobs.status(requireString(body, "id"))

    default:
      throw new Error(`未知操作：${op}`)
  }
}
// ── 装配 ──────────────────────────────────────────────────────────────────

/**
 * 注册自有 REST 路由。
 *
 * 官方能力（插件启停/安装/卸载/清单）**不在这里**——客户端直连官方 Remote。
 * 这里只暴露官方不覆盖的部分：诊断、环境管理、市场、技能与预设、配置。
 *
 * @param ctx - host 上下文。
 * @param deps - op 分派依赖。
 * @returns 路由 disposer 列表。
 */
export function registerRoutes(ctx: Context, deps: OpDependencies): (() => void)[] {
  const webServer = ctx.get("webServer") as { register(route: unknown): () => void } | undefined
  if (webServer === undefined || typeof webServer.register !== "function") {
    ctx.logger?.info?.("plugin-manager-companion: webServer 服务不可用，自有 REST 未注册（诊断与环境管理将无法从浏览器访问）")
    return []
  }
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isJsonPost(req)) {
      sendJson(res, 405, { ok: false, error: { code: "bad-request", message: "只接受 POST + application/json" } })
      return
    }
    const trusted = isTrustedRequest(req, { allowNonHttpCarrier: true })
    if (!trusted.ok) {
      sendJson(res, 403, { ok: false, error: { code: trusted.code, message: trusted.message } })
      return
    }
    const op = decodeURIComponent(req.url ?? "").slice(ROUTE_PREFIX.length + 1).split("?")[0] ?? ""
    const body = await readJsonBody<Record<string, unknown>>(req, BODY_LIMIT_DEFAULT)
    if (!body.ok) {
      sendJson(res, 400, { ok: false, error: { code: body.code, message: body.message } })
      return
    }
    const envelope = await handleOp(op, body.value, deps)
    sendJson(res, envelope.ok ? 200 : 400, envelope)
  }
  return [webServer.register({ kind: "prefix", path: ROUTE_PREFIX, handler })]
}

/**
 * 插件装配。
 *
 * 只做"必须有"的事：注册配置命名空间、探测官方能力、装 REST 路由与 agent 工具。
 * 各能力模块在各自的调用点被用到，不做无意义的预先初始化（诊断与市场都是按需触发）。
 *
 * @param ctx - host 上下文。
 */
export function apply(ctx: Context): void {
  const capabilities = probeOfficialCapabilities(ctx)
  const jobs = new JobRegistry()

  // 配置句柄先用只读降级版：settings 服务可能晚于本插件装配（挂载顺序不保证）。
  // 实测踩过 ctx.get("settings") 在 apply 时取不到就**永久降级**——descriptor 里永远
  // 不出现本命名空间、写入被静默丢弃。改用 ctx.inject 等服务就绪再注册。
  let config: ConfigHandle = fallbackConfigHandle()
  ctx.inject(['settings'], (settingsCtx: Context) => {
    settingsCtx.effect(() => {
      config = registerConfig(settingsCtx)
      return () => { config = fallbackConfigHandle() }
    }, 'plugin-manager-companion: settings namespace')
  })

  runtime = { capabilities, config, jobs }

  // 能力缺失如实记账，不假装健康：诊断页会把这些原因直接呈现给用户。
  for (const reason of capabilities.missing) {
    ctx.logger?.info?.(`plugin-manager-companion: ${reason}`)
  }

  const deps: OpDependencies = {
    ctx,
    config: () => config.current(),
    configUpdate: (patch) => config.update(patch),
    capabilities: () => probeOfficialCapabilities(ctx),
    jobs,
  }

  // REST 路由：webServer 是官方行，装配顺序不保证，用 inject 等待。
  ctx.inject(["webServer"], (webCtx: Context) => {
    webCtx.effect(() => {
      const disposers = registerRoutes(webCtx, deps)
      return () => { for (const dispose of disposers) dispose() }
    }, "plugin-manager-companion: routes")
  })

  // agent 工具：只 plugin_search + plugin_health（其余交还官方 plugin_manager）。
  ctx.inject(["tools"], (toolsCtx: Context) => {
    toolsCtx.effect(() => {
      const disposers = registerCompanionTools(toolsCtx, {
        market: async ({ refresh }) => {
          const envName = probeOfficialCapabilities(toolsCtx).environmentName ?? ""
          const marketConfig = config.current().marketplace
          if (!marketConfig.enabled) return { items: [], generatedAt: new Date().toISOString() }
          const index = await loadRegistryIndex({
            refresh, timeoutMs: marketConfig.timeoutMs,
            ttlMs: marketConfig.cacheTtlMinutes * 60_000, indexUrl: marketConfig.indexUrl,
          })
          const result = cachedMarketplace({
            profile: envName, items: registryItems(index.repos), generation: index.generation,
            installed: buildInstalledIndex(envName), generatedAt: index.generatedAt, cached: index.cached,
          })
          return { items: result.items as never, generatedAt: result.generatedAt, total: result.items.length }
        },
        // match.ts 的纯函数：排好序但不截断（条数钳制在 tools.ts 那一侧）。
        rank: (items, query) => findPluginMatches(items, query, items.length) as never,
        // 工具执行没有 Context，也未必有环境对象；两者都缺失时按"空目标"分析，
        // 引擎会如实记 skipped（工具侧绝不返回一个看起来健康的空报告）。
        analyze: async (rawCtx, env, cfg) => await analyzeEnvironment(
          (rawCtx ?? toolsCtx) as Context, env ?? analysisTarget(deps), cfg,
        ),
        environment: () => currentEnvironment(deps),
        config: () => config.current(),
      })
      const guardDisposer = registerGuard(toolsCtx)
      if (guardDisposer.guard !== null) disposers.push(guardDisposer.guard)
      if (guardDisposer.prompt !== null) disposers.push(guardDisposer.prompt)
      return () => { for (const dispose of disposers) dispose() }
    }, "plugin-manager-companion: agent tools")
  })

  ctx.effect(() => () => { runtime = undefined }, "plugin-manager-companion: runtime")
}


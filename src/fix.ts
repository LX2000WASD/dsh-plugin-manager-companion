/**
 * 分级修复：把诊断给出的 fix descriptor 变成实际动作。
 *
 * 归属：A 类·重写（旧仓库的 fixIssue/fixAll 在 index.ts 里，且直接写 patch 文件）。
 * 官方复用：pluginManager.setPluginEnabled（行级启停）、installBundle（装包）、
 *   saveManifest + withFileLock（声明改写）。
 * 前提检查：旧仓库有 A/B/C 三级修复，其中"删重复行"直接改 cordis.patch.yml。
 *   前提已变：官方现在拥有组合的写权，而它**没有**删行能力。我们不再自己写那个文件，
 *   改为如实回 needs-manual —— 见 applyFix 的 JSDoc。
 */

import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import type { Context } from "@deepseek-ai/cordis"
import { environmentDir } from "./paths.ts"
import { requireManager } from "./official.ts"
import type { CompanionConfig } from "./settings.ts"

/**
 * 一次修复的执行结果。
 *
 * `needs-manual` 不是失败：它是"这条修复没有官方通道，我们拒绝自己动手写 profile 组合"，
 * 并把精确到行的操作步骤交回用户。与"执行失败"分开报，用户才知道该做什么。
 */
export interface FixOutcome {
  readonly ok: boolean
  readonly action: string
  readonly target?: string
  /** executed = 已执行；needs-manual = 需用户手工；failed = 执行失败。 */
  readonly status: "executed" | "needs-manual" | "failed"
  readonly output: string
}

/**
 * 需要用户手工处理的两条：它们都要求改 cordis.patch.yml 的**结构**（删行）。
 *
 * 官方只有行级 setPluginEnabled（改某一行的 disabled），没有删行能力。我们自己写
 * 这个文件会引入"两个写者并发改同一份组合"——那正是本仓库要消除的事故形态。
 */
const MANUAL_ACTIONS: ReadonlySet<string> = new Set(["remove-duplicate-row", "remove-row"])

/** 安装类动作：它们是装包，走受质量门保护的安装。 */
const INSTALL_ACTIONS: ReadonlySet<string> = new Set(["install-provider", "install-dependency"])

/** applyFix 的依赖（由入口注入，避免 fix.ts 反向依赖 index.ts）。 */
export interface FixDependencies {
  readonly ctx: Context
  readonly environmentName: () => string | null
  /** 受质量门保护的安装；由入口提供（它需要 config 与官方 Remote 编排）。 */
  readonly install: (spec: string) => Promise<{ readonly ok: boolean; readonly output: string }>
}

/**
 * 执行一条诊断给出的修复。
 *
 * 三条路，按"官方有没有现成通道"划分：
 *   1. 行级启停 → 官方 setPluginEnabled（enable-row / disable-row）
 *   2. 装包 → 入口的 gatedInstall（install-provider / install-dependency）
 *   3. 删重复官方包拷贝 → 官方 withFileLock + 官方 saveManifest（remove-official-copy）
 *
 * @param action - 修复动作（诊断给出的闭集取值）。
 * @param target - 动作目标，语义随 action 不同。
 * @param deps - 依赖。
 * @returns 执行结果。
 */
export async function applyFix(
  action: string, target: string | undefined, deps: FixDependencies,
): Promise<FixOutcome> {
  if (MANUAL_ACTIONS.has(action)) return manualOutcome(action, target)
  if (INSTALL_ACTIONS.has(action)) {
    if (target === undefined) return failed(action, "缺少 target（要安装的 spec）")
    const result = await deps.install(target)
    return {
      ok: result.ok, action, target,
      status: result.ok ? "executed" : "failed", output: result.output,
    }
  }

  try {
    switch (action) {
      case "enable-row":
      case "disable-row": {
        if (target === undefined) return failed(action, "缺少 target（loader 行 id）")
        const manager = requireManager(deps.ctx)
        const enabled = action === "enable-row"
        const change = await manager.setPluginEnabled(target as never, enabled)
        if (change.application === "failed") {
          const code = change.error?.code ?? "unknown"
          const detail = change.error?.diagnostic ?? ""
          return failed(action, "执行失败：" + code + (detail === "" ? "" : " —— " + detail))
        }
        return {
          ok: true, action, target, status: "executed",
          output: "已" + (enabled ? "启用" : "禁用") + " " + target + restartNote(change.application),
        }
      }

      case "remove-official-copy":
        if (target === undefined) return failed(action, "缺少 target（包名）")
        return await removeOfficialCopy(target, deps)

      default:
        return { ok: false, action, status: "failed", output: "未知修复动作：" + action }
    }
  } catch (error) {
    return failed(action, error instanceof Error ? error.message : String(error), target)
  }
}

/** 应用结果里"要不要重启"的补充说明。 */
function restartNote(application: string): string {
  if (application === "restart-required") return "（需要重启环境才能生效）"
  if (application === "overridden") return "（改动已保存，但被更高层覆盖，当前不生效）"
  return ""
}

/** 构造一条 needs-manual 结果。 */
function manualOutcome(action: string, target: string | undefined): FixOutcome {
  const id = target ?? "（未知目标）"
  return {
    ok: false, action, ...(target === undefined ? {} : { target }), status: "needs-manual",
    output: [
      "这条修复要改 cordis.patch.yml 的结构，我们没有自己动手写这个文件。",
      "",
      "要修的是：" + action + "，目标 " + id,
      "请在诊断报告里展开这条问题的证据 —— 它给了 cordis.patch.yml 的具体行号；",
      "删掉多余那几行后保存即可，下一次启动生效。",
      "",
      "如果环境已经起不来：用 dsh --profile <name> --patch <空补丁.yml> 先拉起来，",
      "或者交给 agent 用官方 plugin_manager 工具处理。",
    ].join("\n"),
  }
}

/** 构造一条 failed 结果。 */
function failed(action: string, output: string, target?: string): FixOutcome {
  return { ok: false, action, ...(target === undefined ? {} : { target }), status: "failed", output }
}

/**
 * 删掉 profile 里重复的官方包拷贝，并把声明从 dependencies 挪到 peerDependencies。
 *
 * 为什么安全：重复拷贝才是模块身份分裂的根因（profile 里出现第二份官方包，loader 的
 * 最近优先解析会劫持官方行）。删掉后该包由共享 fallback 目录提供，与其它官方包共用一份。
 *
 * 两个写操作都在官方通道上：目录删除是普通文件系统操作（不是配置文件）；声明改写用
 * 官方 saveManifest，并取官方同款的文件锁（与 pluginManager 的写用同一把），因此不会
 * 与官方并发写 package.json 打架。
 *
 * @param packageName - 重复的官方包名。
 * @param deps - 依赖。
 * @returns 执行结果。
 */
async function removeOfficialCopy(packageName: string, deps: FixDependencies): Promise<FixOutcome> {
  const envName = deps.environmentName()
  if (envName === null) return failed("remove-official-copy", "无法确定当前环境", packageName)
  const dir = environmentDir(envName)
  const copy = join(dir, "node_modules", ...packageName.split("/"))
  const removed: string[] = []
  if (existsSync(copy)) {
    await rm(copy, { recursive: true, force: true })
    removed.push(copy)
  }

  const { withFileLock } = await import("@deepseek-ai/dsh-atomic-write")
  const { readProfileManifest } = await import("@deepseek-ai/dsh-app-boot")
  const { saveManifest } = await import("@deepseek-ai/dsh-plugin-manager/operations")
  await withFileLock(join(dir, "package.json"), async () => {
    const manifest = readProfileManifest("dsh", dir) as Record<string, unknown> & { dependencies?: Record<string, string> }
    const dependencies = { ...(manifest.dependencies ?? {}) }
    if (!Object.hasOwn(dependencies, packageName)) return
    delete dependencies[packageName]
    const peers = { ...((manifest["peerDependencies"] as Record<string, string> | undefined) ?? {}) }
    peers[packageName] = peers[packageName] ?? "*"
    await saveManifest(dir, { ...manifest, dependencies, peerDependencies: peers } as never)
  })

  const declared = removed.length === 0 ? "未发现重复拷贝（可能已被清理）" : "已删除 " + removed[0]!
  return {
    ok: true, action: "remove-official-copy", target: packageName, status: "executed",
    output: declared + "；声明已从 dependencies 移到 peerDependencies。重启环境后由共享目录提供同一份官方包。",
  }
}

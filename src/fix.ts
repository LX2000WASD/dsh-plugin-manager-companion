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

import { existsSync, unlinkSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import type { Context } from "@deepseek-ai/cordis"
import { dshHome, environmentDir } from "./paths.ts"
import { requireManager } from "./official.ts"
import { cleanupDanglingLinks, moduleFallbackDir, readModuleFallbackClosure, scanModuleFallback } from "./moduleFallback.ts"
import { readInstallAnchor } from "./diagnostics.ts"
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

/**
 * 装包类动作分两条通道，**不能合并**：
 *
 *   - install-provider：某个插件 import 了一个没被声明的包 → 要 `add` 它。
 *   - install-dependency：package.json **已经声明**了，但 node_modules 里没有 → 要修复安装。
 *
 * 为什么 install-dependency 不能走 `add`：官方 inspect 把「已声明」当作「已安装」
 * （already-installed 是官方 PluginInspectProblem 闭集里的取值），于是 `add` 必然被拒绝，
 * 输出「拒绝安装：already-installed」——与诊断结论直接矛盾，用户点多少次都不会成功
 * （write-auditor 真机验证发现，见 docs/private/write-path-audit.md §3·P3）。
 * 官方 `dsh plugin --profile X install` 是把参数转发给 pnpm 的官方通道，修复安装用它。
 */
const ADD_ACTIONS: ReadonlySet<string> = new Set(["install-provider"])

/** 修复安装类动作：声明齐全但 node_modules 缺失，走官方 install 通道。 */
const REPAIR_ACTIONS: ReadonlySet<string> = new Set(["install-dependency"])

/** applyFix 的依赖（由入口注入，避免 fix.ts 反向依赖 index.ts）。 */
export interface FixDependencies {
  readonly ctx: Context
  readonly environmentName: () => string | null
  /** 受质量门保护的安装（官方 add 通道）；由入口提供（它需要 config 与官方 Remote 编排）。 */
  readonly install: (spec: string) => Promise<{ readonly ok: boolean; readonly output: string }>
  /**
   * 修复安装（官方 install 通道）：把 profile **已声明**的依赖真正装进 node_modules。
   *
   * @param target - 包名（用于文案；官方 install 按 package.json 全量收敛）。
   * @returns 结果。
   */
  readonly repair: (target: string) => Promise<{ readonly ok: boolean; readonly output: string }>
}

/**
 * 执行一条诊断给出的修复。
 *
 * 三条路，按"官方有没有现成通道"划分：
 *   1. 行级启停 → 官方 setPluginEnabled（enable-row / disable-row）
 *   2. 装包 → 入口提供的通道：install-provider 走受质量门保护的 add，
 *      install-dependency 走官方 install（声明已在、只是没装，add 必被 already-installed 拒绝）
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
  if (ADD_ACTIONS.has(action) || REPAIR_ACTIONS.has(action)) {
    if (target === undefined) {
      return failed(action, ADD_ACTIONS.has(action) ? "缺少 target（要安装的 spec）" : "缺少 target（包名）")
    }
    const result = ADD_ACTIONS.has(action) ? await deps.install(target) : await deps.repair(target)
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

      case "remove-dangling-module-fallback-links":
        return await removeDanglingModuleFallbackLinks(deps)

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
 * 删掉依赖兜底目录（`$DSH_HOME/profiles/node_modules`）里的**断链**。
 *
 * 为什么这条修复自己动手删、而不找官方通道：官方**没有**清理这个目录的通道——
 * `healProfilesModuleFallback` 只增不删（判据 `entries.every(...)` 只问"该有的到位没"，
 * 写入路径只遍历 entries、无 readdir/unlink）。旧代际留下的断链因此永远不会自己消失。
 *
 * 安全边界（三条，代码里逐条落实）：
 * 1. **只删符号链接**：每条都 `lstatSync().isSymbolicLink()` 确认；绝不递归删目录。
 * 2. **只删断链**：删除前重新确认目标仍不存在（扫描到删除之间可能被别的进程动过）。
 * 3. **结果如实**：删了几条 / 跳过几条 / 为什么 / 哪几条失败，逐条写进 output。
 *
 * 这不是 profile 的组合写入，所以不需要官方文件锁：它不碰 package.json、不碰 cordis.patch.yml，
 * 删的只是共享兜底层里指向已消失目标的链接。
 *
 * @param deps - 修复依赖（需要 ctx 拿 DSH home 与安装锚点）。
 * @returns 执行结果。
 */
async function removeDanglingModuleFallbackLinks(deps: FixDependencies): Promise<FixOutcome> {
  const action = "remove-dangling-module-fallback-links"
  try {
    const home = dshHome()
    const dir = moduleFallbackDir(home)
    const envDir = environmentDir(deps.environmentName() ?? "")
    const anchor = readInstallAnchor(deps.ctx)
    const closure = await readModuleFallbackClosure(anchor, home)
    const scan = scanModuleFallback(dir, closure)
    if (!scan.scanned) {
      return {
        ok: false, action, status: "failed",
        output: "没有扫到可清理的依赖兜底目录（" + dir + "）："
          + (scan.exists ? "当前安装的依赖闭包算不出来（" + String(scan.closureReason ?? "原因未知") + "）" : "目录不存在"),
      }
    }
    // 注意：**没有断链也要往下走**——上一轮可能已经删完链接，但留下了空的 scope 目录。
    // 真机就是这个状态（Lead 执行过一次清理：516 条链接归零，剩 29 个空 @scope 目录）。
    // 早退会让那些空目录永远清不掉。
    const result = cleanupDanglingLinks(dir, scan, path => { unlinkSync(path) })
    const lines = [
      "依赖兜底目录：" + dir,
      "断链 " + String(scan.dangling.length) + " 条 → 已删 " + String(result.removed)
        + " 条，跳过 " + String(result.skipped) + " 条，失败 " + String(result.failed) + " 条",
    ]
    if (result.removedScopes.length > 0) {
      lines.push("变空的 scope 目录 → 已删 " + String(result.removedScopes.length) + " 个："
        + result.removedScopes.join("、"))
    } else if (result.scopeSkipReasons.length === 0) {
      lines.push("没有变空的 scope 目录")
    }
    if (result.scopeSkipReasons.length > 0) {
      lines.push("", "scope 目录未删：", ...result.scopeSkipReasons.map(r => "  - " + r))
    }
    if (result.skipReasons.length > 0) lines.push("", "跳过原因：", ...result.skipReasons.map(r => "  - " + r))
    if (result.failures.length > 0) lines.push("", "失败：", ...result.failures.map(r => "  - " + r))
    if (scan.stale.length > 0) {
      lines.push("", "完好但过时的 " + String(scan.stale.length) + " 条没有动（目标还在，按约定只报不删）")
    }
    void envDir
    return { ok: result.failed === 0, action, status: result.failed === 0 ? "executed" : "failed", output: lines.join(String.fromCharCode(10)) }
  } catch (error) {
    return failed(action, error instanceof Error ? error.message : String(error))
  }
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

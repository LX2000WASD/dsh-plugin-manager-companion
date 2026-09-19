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
import { DEFAULT_ENVIRONMENT_TEMPLATE, backupDiff, backupExport, backupRestore, cleanupTrialEnvironments, copyPlugins, createEnvironment, environmentFingerprint, environmentTemplates, listEnvironments, listTrialEnvironments, planTrialCleanup, processFacts, removeEnvironment, removeTrialEnvironment, renameEnvironment, repairDependencies, runTrialInstall, scanRuns, startEnvironment, stopEnvironment, trialEnvironmentName } from "./envManager.ts"
import type { SnapshotDepth, TrialConclusion, TrialInstallOptions, TrialInstallResult } from "./envManager.ts"
import { findOrphanKindDirs, kindDirsOf, loadKindRecords, presetsRoot, pruneGhostRecords, removeKindDir, removeKindRecord, skillsRoot } from "./kinds.ts"
import { buildInstalledIndex, cachedMarketplace, invalidateInstalledIndex, registryItems } from "./marketplace.ts"
import { probeOfficialCapabilities, requireManager, type OfficialCapabilities } from "./official.ts"
import { environmentDir as pathEnvironmentDir, OUR_PACKAGE_NAME, readEnvironmentManifest, sameEnvironment } from "./paths.ts"
import { inspectPackage } from "./qualityGate.ts"
import { applyFix } from "./fix.ts"
import { loadRegistryIndex } from "./registry.ts"
import { checkUpgrades, rollbackUpgrade, upgradePackage, type UpgradeActionInput, type UpgradeEngineDeps } from "./upgrade.ts"
import { findPluginMatches } from "./match.ts"
import { registerGuard } from "./guard.ts"
import { registerCompanionTools } from "./tools.ts"
import { BODY_LIMIT_DEFAULT, JobRegistry, ROUTE_PREFIX, isJsonPost, isTrustedRequest, readJsonBody, sendJson, type Envelope } from "./rest.ts"
import { TRIAL_DISCLOSURE, effectiveTrialConfig, fallbackConfigHandle, registerConfig, type CompanionConfig, type ConfigHandle, type TrialConfig } from "./settings.ts"
import type { BootVerdictKind, DiagnosticLayer, DiagnosticReport, EnvironmentInfo, EnvironmentResult, GatedInstallResult, GatedInstallTrial, KindListResult, MarketplaceResult, TrialCleanupResult, TrialEnvironmentInfo, TrialEnvironmentReport, TrialPolicyOutcome } from "./types.ts"
import type { IncomingMessage, ServerResponse } from "node:http"
import { existsSync, lstatSync, readdirSync, readlinkSync } from "node:fs"
import { join } from "node:path"

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
 * 当前环境目录：官方事实（profileContext.dir）优先。
 *
 * @param ctx - host 上下文。
 * @param fallbackDir - 拿不到官方 profileContext 时的回退目录。
 * @returns 环境目录。
 */
function currentProfileDir(ctx: Context, fallbackDir: string | null): string | null {
  const profileContext = ctx.get('profileContext') as { dir?: string } | undefined
  return profileContext?.dir ?? fallbackDir
}

/**
 * 环境目录；拿不到（名字为空、名字不安全）时返回 null —— 核对路径不允许抛异常。
 *
 * @param name - 环境名。
 * @returns 目录或 null。
 */
function environmentDirOrNull(name: string): string | null {
  try {
    return name.length === 0 ? null : pathEnvironmentDir(name)
  } catch {
    return null
  }
}

/**
 * 回滚动作自己的结局（官方 ChangeResult.application）。
 *
 * 官方 change() 把失败折进结果而不是抛异常，所以「调用过 removeBundle」不等于
 * 「回滚成功」——标题必须按官方回报的 application 写，不能默认成功。
 *
 * @param removed - 官方 removeBundle 的返回值。
 * @returns 标题片段。
 */
function rollbackHeadline(removed: { application?: string; error?: { code?: string; diagnostic?: string } }): string {
  if (removed.application !== 'failed') return '已回滚'
  return '回滚没有完成（' + removalFailureText(removed.error?.code) + '）'
}

/**
 * 官方移除失败码 → 人话。
 *
 * 用户要的是"发生了什么、我该怎么办"，不是官方内部码名（DESIGN §12.6）。
 * 码名本身仍留在结果对象的 error 字段里，需要排查时读得到；**文案里不再出现**。
 * 未知码保留原文——宁可给原始信息，也不编一个可能不对的解释。
 *
 * @param code - 官方错误码。
 * @returns 面向用户的说法。
 */
function removalFailureText(code: string | undefined): string {
  const known: Record<string, string> = {
    'not-removable': '官方不允许移除这个组合包',
    'management-required': '这个包由安装方管理，不能在环境里移除',
    'stop-profile': '环境正在运行，要先停掉它',
    'bundle-in-use': '这个包正在被使用',
    'not-bundle': '它不是组合包',
  }
  if (code === undefined || code.length === 0) return '官方没有给出原因'
  return known[code] ?? code
}

/**
 * 一次回滚之后的**磁盘真实状态**。
 *
 * 为什么不写死「已回滚，环境未被改动」：官方 removeBundle 走的是 pnpm remove，本机
 * 实测（官方 add 之后紧接官方 remove，两次 exitCode 都是 0）：
 *   - package.json 的 dependencies 与 dsh.profile.bundles 都被清干净；
 *   - <profile>/node_modules/<name> 这个 link:/file: 安装产生的**符号链接原地留下**。
 * 官方 installBundle 失败时也只恢复 RESTORED_FILES = package.json + pnpm-lock.yaml
 * （官方注释原话：downloaded files can stay），同样不碰 node_modules。
 * 官方没有清理这个链接的通道，我们也不 rm 不是自己创建的链接 —— 只能如实陈述。
 *
 * rolledBack 的取值因此收紧为「磁盘上确实没有留下痕迹」：有残留时返回 false，
 * 客户端据此不再弹「环境未被改动」。
 *
 * @param dir - 环境目录。
 * @param name - 包名。
 * @returns 状态行与「是否干净」。
 */
function rollbackState(dir: string | null, name: string): { lines: string[]; clean: boolean } {
  if (dir === null || !existsSync(join(dir, 'package.json'))) {
    return {
      lines: ['没能核对回滚结果：读不到这个环境的清单文件。'],
      clean: false,
    }
  }
  const manifest = readEnvironmentManifest(dir)
  if (manifest.broken !== undefined) {
    return {
      lines: ['没能核对回滚结果：环境的清单文件读不懂。'],
      clean: false,
    }
  }
  const declared = manifest.dependencies.includes(name)
  const layered = manifest.bundles.includes(name)
  // 依赖声明与层栈是**两件事**，各自说各自的状态（旧版把两者拼进一行，读起来是一句长定语）。
  const lines: string[] = []
  if (declared) lines.push('依赖声明还在。')
  if (layered) lines.push('它仍在环境启动时加载的列表里。')
  const entry = join(dir, 'node_modules', name)
  let leftover = false
  try {
    const stat = lstatSync(entry)
    leftover = true
    // 路径安装留下的链接：说清"文件还在、且我们不会替你删"，但不把目录名与箭头当句子主体。
    lines.push(stat.isSymbolicLink()
      ? '安装目录里还留着指向本地来源的链接（本次安装的残留），需要时可以手动删除。'
      : '安装目录里还留着它的文件（本次安装的残留），需要时可以手动删除。')
  } catch {
    // lstat 失败 = 没有残留，这是正常路径。
  }
  if (lines.length === 0) lines.push('依赖声明与加载列表都已回到原状，也没有留下安装残留。')
  return { lines, clean: !declared && !layered && !leftover }
}

// ── 试装（质量门第二步，DESIGN §5.2）─────────────────────────────────────

/**
 * 试装执行器（测试注入替身）。
 *
 * 为什么要留这个缝：试装会真起进程（headless 验证）。单测要证明的是"接进来了、策略生效了"，
 * 不能靠真的起一个 dsh 来证明——那是真机 e2e 的活。
 */
export type TrialRunner = (
  spec: string, realName: string, options: TrialInstallOptions,
) => Promise<TrialInstallResult>

/** gatedInstall 的可选注入。 */
export interface GatedInstallOptions {
  /** 试装执行器；省略时用真实的 runTrialInstall（会真装、真起进程）。 */
  readonly trial?: TrialRunner
}

/**
 * 四种结论各自的短标签（措辞与 §5.2 一一对应，不得混用）。
 *
 * 用法约定：这些短句直接拼进结果里，**不再套"试装未通过："之类的前缀**——
 * "无法试装（不算通过），已回滚 X" 比 "试装未通过（无法试装（不算通过）），已回滚 X" 可读得多。
 */
const TRIAL_LABEL: Record<TrialConclusion, string> = {
  "passed": "试装通过",
  "baseline-broken": "快照基线起不来（不是候选包的问题）",
  "candidate-broken": "候选包导致挂载失败",
  "cannot-trial": "无法试装（不算通过）",
}

/**
 * 验证启动失败是不是"端口绑不上"这类基础设施原因。
 *
 * 为什么必须单独认它（真机实测 2026-09-19）：含 web app 的环境在验证启动时（不给任务、
 * 不指定端口）会去绑 web-app 补丁里的默认端口 3080；GUI 正跑在那个端口上时必然
 * EADDRINUSE，整棵树因此挂不起来。把它照原样报成"基线起不来"是**错误的归因**——
 * 用户会以为自己的环境坏了（甚至去改环境），而真实原因与他和候选包都无关。
 *
 * 只在**基线**失败时降级：基线里没有候选包的任何代码，端口冲突只可能来自环境自身或外部进程。
 *
 * @param verdict - 一次挂载验证的判定（引擎的 BootVerdict 结构式视图）。
 * @returns 冲突地址（host:port）；不是端口冲突时 null。
 */
function bootPortConflict(verdict: { readonly kind: string; readonly reason?: string; readonly chain?: readonly string[] } | null): string | null {
  if (verdict === null || verdict.kind !== "failed") return null
  const text = [verdict.reason ?? "", ...(verdict.chain ?? [])].join("\n")
  if (!/EADDRINUSE|address already in use/i.test(text)) return null
  const hit = /address already in use[ :]*([0-9a-zA-Z.:\[\]_-]+)/i.exec(text)
  return hit === null ? "（错误里没写地址）" : hit[1]
}

/** 当前环境名（官方 profileContext 的 name）；读不到时为 null。 */
function currentEnvironmentName(ctx: Context): string | null {
  const profileContext = ctx.get("profileContext") as { name?: unknown } | undefined
  const name = profileContext?.name
  return typeof name === "string" && name.length > 0 ? name : null
}

/** 试装未通过时按设置决定处置（**两种模式都不把"无法试装"当成通过**）。 */
function trialPolicyFor(trial: TrialConfig, conclusion: TrialConclusion): { policy: TrialPolicyOutcome; policyNote: string } {
  if (conclusion === "passed") return { policy: "passed", policyNote: "试装通过" }
  if (trial.onFailure === "warn") {
    return { policy: "warned", policyNote: TRIAL_LABEL[conclusion] + "，按 warn 模式照常安装" }
  }
  return { policy: "blocked", policyNote: TRIAL_LABEL[conclusion] + "，按 block 模式未安装并已回滚" }
}

/**
 * 试装已开启但这次没执行时的摘要（质量门整体关闭 / 包在豁免名单里）。
 *
 * 结论写 cannot-trial、处置写 skipped：它**不是**通过。界面据此说"试装未执行"，
 * 而不是让用户以为这个包被验证过了。
 *
 * @param config - 本插件配置。
 * @param reason - 没执行的原因（面向用户）。
 * @returns 结论摘要。
 */
function trialSkipSummary(config: CompanionConfig, reason: string): GatedInstallTrial {
  return {
    conclusion: "cannot-trial", policy: "skipped", depth: undefined, escalated: false,
    baseline: null, candidate: null, elapsedMs: 0,
    output: "试装未执行：" + reason + "。这个包没有经过试装验证——它并没有通过试装。",
    policyNote: reason,
  }
}

/**
 * 本次试装要不要为"数量上限"停在门外（§5.3 的最多保留数；0 = 不限）。
 *
 * 上限的语义刻意做成**拒绝执行**而不是"删掉最旧的一个腾位"：删除只允许发生在两处
 * （用户自己点删除、或超过保留期的自动清理）。为了腾位而隐式删除，正是本仓库在
 * removeTrialEnvironment 里明确拒绝过的形态（"不做先停后删的隐式动作"）。
 *
 * @param realName - 真实环境名（测试环境由它派生）。
 * @param maxKept - 上限；0 = 不限。
 * @returns 超限时返回面向用户的说明；否则 null。
 */
function trialSlotBlocked(realName: string, maxKept: number): string | null {
  if (maxKept <= 0) return null
  const listed = listTrialEnvironments()
  const target = trialEnvironmentName(realName)
  const others = listed.candidates.filter(candidate => !sameEnvironment(candidate.name, target))
  if (others.length < maxKept) return null
  return "测试环境已经有 " + String(others.length) + " 个（你设的上限是 " + String(maxKept)
    + "）：先删掉不再需要的（每个测试环境都能单独删），或把上限调大。"
    + "试装不会为了腾位偷偷删掉任何一个测试环境。"
}

/**
 * 跑一次试装，并把它折成这次安装能用的结论摘要（§5.2 的受控对照四步在引擎里）。
 *
 * 三件事在接进来这一层做，因为它们都是**接入层的判断**，不是引擎的判断：
 *   1. 受控对照的"真实环境"必须是**包真正会落地的那个环境**。官方安装通道只作用于当前环境
 *      （ctx.pluginManager 就是当前 profile 的管理器），所以请求里指定了别的环境时，
 *      验证的环境与落地的环境不是同一个——这种结论毫无意义，如实报"无法试装"。
 *   2. 数量上限（§5.3）在起进程之前判，省掉一整轮无用的安装。
 *   3. 试装跑完后按保留期顺手清理过期测试环境（§5.4；可在设置里关）。
 *
 * 任何异常都折成 cannot-trial（**不算通过**），绝不让一次异常变成"静默放行"。
 *
 * @param ctx - host 上下文（引擎用它取官方安装锚点与 pnpm 通道）。
 * @param config - 本插件配置。
 * @param spec - 候选包 spec。
 * @param targetName - 调用方给的安装目标环境名（可能为空字符串 = 当前环境）。
 * @param runner - 试装执行器。
 * @returns 结论摘要。
 */
async function runTrialStep(
  ctx: Context, config: CompanionConfig, spec: string, targetName: string, runner: TrialRunner,
): Promise<GatedInstallTrial> {
  const trial = effectiveTrialConfig(config)
  /** 试装没跑起来时的摘要：一律 cannot-trial（占位字段为 null / 省略）。 */
  const cannotTrial = (reason: string): GatedInstallTrial => {
    const { policy, policyNote } = trialPolicyFor(trial, "cannot-trial")
    return {
      conclusion: "cannot-trial", policy, depth: undefined, escalated: false,
      baseline: null, candidate: null, elapsedMs: 0, output: "无法试装：" + reason, policyNote,
    }
  }
  const realName = currentEnvironmentName(ctx) ?? runtime?.capabilities.environmentName ?? ""
  if (realName.length === 0) {
    return cannotTrial("读不到当前是哪个环境，无法确定候选包会落进哪里，也就没有可以对照的快照源。")
  }
  if (targetName.length > 0 && !sameEnvironment(targetName, realName)) {
    return cannotTrial("这次安装的目标是 " + targetName + "，但官方安装通道只作用于当前环境 " + realName
      + "：试装验证的环境与包真正落地的环境必须是同一个，所以做不了受控对照。请在当前环境里安装，或改用跨环境通道（dshpmc）。")
  }
  const slot = trialSlotBlocked(realName, trial.maxKept)
  if (slot !== null) return cannotTrial(slot)

  let result: TrialInstallResult
  try {
    result = await runner(spec, realName, {
      ctx,
      depth: trial.depth,
      baseline: trial.baseline,
      allowNetwork: trial.allowNetwork,
      // 层栈事实取官方 listBundles（这台的插件管理器就是当前环境的管理器）。
      // 拿不到时引擎会自己回落到 manifest 并如实标注口径，不需要这里兜。
      listBundles: async () => (await requireManager(ctx).listBundles()).map(bundle => bundle.name),
    })
  } catch (error) {
    return cannotTrial("试装执行时出错：" + (error instanceof Error ? error.message : String(error)))
  }
  // 归因修正：基线挂载失败且原因是"端口绑不上"时，这不是环境坏了、也不是候选包的问题。
  // 照原样报 baseline-broken 会误导用户去修一个其实没坏的环境，所以降级为"无法试装"。
  let conclusion = result.conclusion
  let output = result.output
  const baselineConflict = bootPortConflict(result.baseline)
  const baselineUndetermined = result.baseline !== null && result.baseline.kind === "undetermined"
  if (baselineConflict !== null && conclusion !== "passed") {
    // 端口冲突这一支：**整段替换**引擎的结论叙述。
    // 为什么替换而不是"在前面加一句"：引擎那段会说"快照基线起不来 / 这个环境当前状态有问题"，
    // 而端口冲突下这两句都不成立（真机实测：GUI 占着 3080，验证启动必然撞上它）。
    conclusion = "cannot-trial"
    output = trialNarrative(result, [
      "无法试装：验证启动绑不上端口（" + baselineConflict + " 已被占用）。",
      "这不是候选包的问题，也不是环境坏了：含 web app 的环境在验证启动时（不给任务、不指定端口）"
        + "会去绑它自己的默认端口，而那个端口正被别的进程占着。占用者是谁需要你自己确认；"
        + "端口空出来之后，这次验证才有意义。",
    ])
  } else if (baselineUndetermined) {
    // 基线"判不出来"这一支同样替换：引擎会说"快照基线本身就起不来"，但那句话没被任何事实支持
    // （判不出来恰恰是"不知道"）。真机实测：含 web app 的环境在验证启动里以**服务形态常驻**，
    // 30s 超时后被杀、stderr 为空——既没挂载成功的凭证，也没有失败凭证。
    output = trialNarrative(result, [
      "无法试装：验证启动没有给出判定——它既没挂载成功，也没报挂载失败"
        + (result.baseline !== null && result.baseline.kind === "undetermined" ? "（" + result.baseline.reason + "）" : "") + "。",
      "这是验证形态给不出结论，不是候选包的问题，也不是环境坏了。",
    ])
  }
  // 候选启动失败时的端口冲突是**有歧义**的（可能是候选包自己要绑那个端口），
  // 所以结论不动，只把这条事实补进输出——让人能判断，而不是由我们替他下结论。
  const candidateConflict = bootPortConflict(result.candidate)
  if (candidateConflict !== null) {
    output += "\n注意：候选启动的失败形态是端口冲突（" + candidateConflict + " 已被占用）："
      + "可能是候选包自己要绑这个端口，也可能是与环境里已有进程冲突，需要人工判断。"
  }
  const { policy, policyNote } = trialPolicyFor(trial, conclusion)
  const cleanupNote = await maybeAutoCleanupTrialEnvironments(config)
  return {
    conclusion,
    policy,
    depth: result.depth,
    escalated: result.escalated,
    escalationReason: result.escalationReason,
    baseline: result.baseline?.kind ?? null,
    candidate: result.candidate?.kind ?? null,
    elapsedMs: result.elapsedMs,
    output: cleanupNote === null ? output : output + "\n" + cleanupNote,
    policyNote,
  }
}

/**
 * 试装没能给出结论时，用**接入层拿得到的结构化事实**拼一份结论叙述。
 *
 * 为什么不直接复用引擎的 output：引擎那一段会把"验证启动没跑起来"写成
 * "快照基线起不来 / 这个环境当前状态有问题"——在没有失败凭证的情况下那是**错误的归因**
 * （真机实测两例：GUI 占着 3080 导致的口冲突；以及含 web app 的环境以服务形态常驻、
 * 30s 超时被杀）。这里只用事实：判定说了什么、深度、耗时、原始根因链、构建指纹。
 *
 * @param result - 引擎给的试装结果（结构化事实）。
 * @param head - 这段结论自己要说清的话（面向用户）。
 * @returns 面向用户的结论叙述。
 */
function trialNarrative(result: TrialInstallResult, head: readonly string[]): string {
  const chain = result.baseline !== null && result.baseline.kind === "failed" ? result.baseline.chain : []
  const depthLine = "实际深度：" + String(result.depth)
    + (result.escalated ? "（由 shallow 升级：" + String(result.escalationReason) + "）" : "")
    + "｜验证耗时 " + String(result.elapsedMs) + "ms"
  const buildLine = "构建：md5=" + (result.build.artifactMd5 === null ? "不可读" : result.build.artifactMd5.slice(0, 12))
    + (result.build.gitHead === null ? "（读不到 git HEAD）" : " head=" + result.build.gitHead.slice(0, 12))
  return [
    ...head,
    depthLine,
    chain.length === 0 ? "" : "根因（验证启动的原始输出）：\n" + chain.join("\n"),
    buildLine,
  ].filter(line => line.length > 0).join("\n")
}

/**
 * 试装结束后顺手清理过期测试环境（§5.4；开关与天数在设置里）。
 *
 * 只删**超过保留期**且**没在运行**的（判定在引擎的清理计划里，删不动就如实记账）。
 * 没有任何过期项时返回 null——不做无意义的打扰。清理失败**不影响**本次安装结论。
 *
 * @param config - 本插件配置。
 * @returns 面向用户的一句清理结果；没有可清理项时为 null。
 */
async function maybeAutoCleanupTrialEnvironments(config: CompanionConfig): Promise<string | null> {
  const trial = effectiveTrialConfig(config)
  if (!trial.autoCleanup) return null
  try {
    const result: TrialCleanupResult = await cleanupTrialEnvironments({ retainDays: trial.retentionDays })
    if (result.removed.length === 0 && result.ok) return null
    return "测试环境自动清理：\n" + result.output
  } catch (error) {
    return "测试环境自动清理失败（不影响本次安装）：" + (error instanceof Error ? error.message : String(error))
  }
}

/** 目录占地的统计预算（超过就如实说"没统计完"，不让页面卡在一次遍历上）。 */
const USAGE_FILE_BUDGET = 20_000

/**
 * 目测一个目录的占地（apparent 字节合计 + 文件数 + 硬链接数）。
 *
 * 口径必须说清：这是 **st_size 的合计**，不是"独占磁盘"。pnpm 的 store 用硬链接，
 * 实测一个 12 MiB 的测试环境独占只有 36 KiB（1243/1247 个文件 nlink>1）——所以
 * sharedFiles 一起给出来，界面才能说清"看着大、实际不占"。
 * 符号链接只计链接本身、不跟进目标（跟进会把 store 里的内容重复算进来）。
 *
 * @param root - 目录。
 * @returns 统计结果；截断或读不到时 bytes 为 null 并给原因。
 */
function directoryUsage(root: string): { bytes: number | null; files: number; sharedFiles: number; reason?: string } {
  let bytes = 0
  let files = 0
  let sharedFiles = 0
  const stack = [root]
  try {
    while (stack.length > 0) {
      const dir = stack.pop() as string
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          stack.push(path)
          continue
        }
        if (files >= USAGE_FILE_BUDGET) {
          return { bytes: null, files, sharedFiles, reason: "目录里文件数超过 " + String(USAGE_FILE_BUDGET) + " 个，没统计完（避免拖住页面）" }
        }
        const stat = lstatSync(path)
        files += 1
        if (stat.isSymbolicLink()) continue
        bytes += stat.size
        if (stat.nlink > 1) sharedFiles += 1
      }
    }
  } catch (error) {
    return { bytes: null, files, sharedFiles, reason: "统计失败：" + (error instanceof Error ? error.message : String(error)) }
  }
  return { bytes, files, sharedFiles }
}

/**
 * 测试环境的快照清单是否仍与真实环境一致（§5.4 第二步的"比对"那一步，只读、不改）。
 *
 * 比的是三件套的**内容 hash**（package.json / pnpm-lock.yaml / cordis.patch.yml）：
 * 不一致只意味着"下次试装会重新物化"，不是错误，所以两态都如实给出。
 *
 * @param trialEnvName - 测试环境名。
 * @param ownerName - 归属的真实环境名。
 * @returns 是否一致；读不到时为 null。
 */
async function snapshotMatchesOwner(trialEnvName: string, ownerName: string): Promise<boolean | null> {
  try {
    const [snapshot, owner] = await Promise.all([
      environmentFingerprint(trialEnvName),
      environmentFingerprint(ownerName),
    ])
    return snapshot.manifestHash === owner.manifestHash
      && snapshot.lockfileHash === owner.lockfileHash
      && snapshot.patchHash === owner.patchHash
  } catch {
    return null
  }
}

/**
 * 测试环境的查询报告（op: trialEnvironments）。
 *
 * 纯读：这个 op **不删任何东西**（计划只作为 preview 给界面），删除只有两个入口——
 * 用户点单个删除（trialRemove）与显式/自动清理（trialCleanup）。
 *
 * @param config - 本插件配置（保留策略从这里读，界面不要自己拼默认值）。
 * @returns 报告。
 */
async function trialEnvironmentReport(config: CompanionConfig): Promise<TrialEnvironmentReport> {
  const trial = effectiveTrialConfig(config)
  const listed = listTrialEnvironments()
  const plan = planTrialCleanup(listed.candidates, { retainDays: trial.retentionDays })
  const notes: string[] = []
  if (!listed.factsReadable) {
    notes.push("进程事实读不到（" + String(listed.reason ?? "原因未知") + "）：运行状态按未知处理，"
      + "清理计划因此不会删任何东西（不在未知状态下动磁盘）。")
  }
  const now = Date.now()
  const environments: TrialEnvironmentInfo[] = []
  let bytes = 0
  let unknownBytes = 0
  let running = 0
  for (const candidate of listed.candidates) {
    const dir = pathEnvironmentDir(candidate.name)
    const ownerDir = environmentDirOrNull(candidate.owner)
    const ownerExists = ownerDir !== null && existsSync(join(ownerDir, "package.json"))
    const usage = directoryUsage(dir)
    if (usage.bytes === null) unknownBytes += 1
    else bytes += usage.bytes
    if (candidate.running) running += 1
    environments.push({
      name: candidate.name,
      owner: candidate.owner,
      ownerExists,
      dir,
      running: candidate.running,
      modifiedAtMs: candidate.modifiedAt,
      modifiedAt: new Date(candidate.modifiedAt).toISOString(),
      ageDays: Math.round((now - candidate.modifiedAt) / 86_400_000 * 10) / 10,
      bytes: usage.bytes,
      files: usage.files,
      sharedFiles: usage.sharedFiles,
      bytesReason: usage.reason,
      snapshotMatchesOwner: ownerExists ? await snapshotMatchesOwner(candidate.name, candidate.owner) : null,
    })
  }
  return {
    environments,
    factsReadable: listed.factsReadable,
    factsReason: listed.reason,
    totals: { count: environments.length, running, bytes, unknownBytes },
    retention: { days: trial.retentionDays, autoCleanup: trial.autoCleanup, maxKept: trial.maxKept },
    plan: { remove: [...plan.remove], keep: [...plan.keep] },
    overCap: trial.maxKept > 0 && environments.length >= trial.maxKept,
    notes,
  }
}

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
 * 试装（第二步，DESIGN §5.2）接在**静态快筛之后、真正放行之前**：一条路径，Web UI /
 * CLI / agent 工具三边同时生效。试装关闭时（默认）本函数的行为与没有它时逐条相同。
 *
 * 两处刻意的实现细节：
 *   · 质量门**整体**关闭或包在豁免名单里时，试装不执行——但会在输出里写明"试装未执行"，
 *     不让"我打开了开关却什么都没发生"变成一个看不见的洞。
 *   · 试装没通过时的处置由设置决定（默认不装），但**无论哪一档**，"无法试装"都不会被写成通过。
 *
 * @param ctx - host 上下文。
 * @param config - 本插件配置。
 * @param spec - 安装 spec（npm 名 / git 地址 / 本地路径 / tarball）。
 * @param environmentName - 目标环境名；undefined 表示当前环境。
 * @param options - 可选注入（试装执行器）。
 * @returns 结果；失败时输出里说明是官方拒绝、质量门拦截、试装未通过还是激活失败。
 */
export async function gatedInstall(
  ctx: Context, config: CompanionConfig, spec: string, environmentName?: string,
  options: GatedInstallOptions = {},
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
  const trialConfig = effectiveTrialConfig(config)
  if (!config.qualityGate.enabled || config.qualityGate.allowlist.includes(packageName)) {
    await manager.setBundleEnabled(packageName, true)
    invalidateInstalledIndex(environmentName ?? "")
    // 开关被打开却什么都没发生，必须说出来（否则用户以为试装保护着他）。
    const skippedTrial = trialConfig.enabled
      ? trialSkipSummary(config, config.qualityGate.enabled
        ? "包名在质量门豁免名单里（豁免 = 跳过全部检查）"
        : "质量门整体已关闭")
      : undefined
    return {
      ok: true,
      output: `已安装并启用 ${packageName}（质量门未启用）`
        + (skippedTrial === undefined ? "" : `（试装未执行：${skippedTrial.policyNote}）`),
      packageName, gateIssues: [],
      ...skippedTrial === undefined ? {} : { trial: skippedTrial },
    }
  }
  const targetName = environmentName ?? runtime?.capabilities.environmentName ?? ""
  let gate
  try {
    // 传 ctx：质量门据此拿官方 installAnchor 作为解析根。
    // 不传的话官方 peer 与 bundle 行会被判成缺包——实测踩过（173 条误报的同一根因）。
    gate = await inspectPackage(pathEnvironmentDir(targetName), packageName, config, ctx)
  } catch (error) {
    // 扫描本身失败时不放行：宁可回滚也不让未经校验的包留在环境里。
    const removed = await manager.removeBundle(packageName)
    const state = rollbackState(currentProfileDir(ctx, environmentDirOrNull(targetName)), packageName)
    return {
      ok: false,
      output: [
        '没有安装 ' + packageName + '：扫描没能完成。',
        rollbackHeadline(removed) + '。',
        '',
        '原因：' + (error instanceof Error ? error.message : String(error)),
        '',
        '环境现状：',
        ...state.lines.map(line => '  ' + line),
      ].join('\n'),
      packageName, gateIssues: [], rolledBack: state.clean,
    }
  }
  if (!gate.ok && config.qualityGate.mode === "block") {
    const removed = await manager.removeBundle(packageName)
    invalidateInstalledIndex(targetName)
    // 文案只陈述核对过的真实状态：manifest 与 node_modules 各说各的，不写「环境未被改动」。
    const state = rollbackState(currentProfileDir(ctx, environmentDirOrNull(targetName)), packageName)
    return {
      ok: false,
      output: [
        '没有安装 ' + packageName + '：质量检查未通过。',
        rollbackHeadline(removed) + '。',
        '',
        '发现的问题：',
        ...gate.issues.map(i => "  - " + i),
        '',
        '环境现状：',
        ...state.lines.map(line => '  ' + line),
      ].join('\n'),
      packageName, gateIssues: gate.issues, rolledBack: state.clean,
    }
  }
  // 第二步：试装（DESIGN §5.2）。只在静态快筛放行之后执行——第一步就挂掉的包没有必要起进程。
  const trial = trialConfig.enabled
    ? await runTrialStep(ctx, config, spec, targetName, options.trial ?? runTrialInstall)
    : undefined
  if (trial !== undefined && trial.policy === "blocked") {
    const removed = await manager.removeBundle(packageName)
    invalidateInstalledIndex(targetName)
    const state = rollbackState(currentProfileDir(ctx, environmentDirOrNull(targetName)), packageName)
    // 分层呈现（DESIGN §12.6）：第一行是结论与后果，细节降到下面。
    // 旧版把「结论 + 回滚状态 + 包名」用逗号拼成一行，再接一大段细节，同一件事说三遍；
    // 这里每层只回答一个问题——发生了什么 / 为什么 / 现在环境是什么样。
    return {
      ok: false,
      output: [
        '没有安装 ' + packageName + '：' + TRIAL_LABEL[trial.conclusion] + '。',
        rollbackHeadline(removed) + '。',
        '',
        trial.output,
        '',
        '环境现状：',
        ...state.lines.map(line => '  ' + line),
      ].join('\n'),
      packageName, gateIssues: gate.issues, rolledBack: state.clean, trial,
    }
  }
  await manager.setBundleEnabled(packageName, true)
  invalidateInstalledIndex(targetName)
  const warned = gate.issues.length === 0 ? "" : `（质量门有 ${gate.issues.length} 条提示，按 warn 模式放行）`
  const trialLine = trial === undefined ? "" : trial.policy === "warned"
    ? `（${TRIAL_LABEL[trial.conclusion]}，按 warn 模式照常安装 —— 它在验证启动里没通过，环境起不来时先移除它）`
    : `（${TRIAL_LABEL[trial.conclusion]}；实际深度 ${trial.depth ?? "未物化快照"}，耗时 ${trial.elapsedMs}ms）`
  return {
    ok: true, output: `已安装并启用 ${packageName}${warned}${trialLine}`,
    packageName, gateIssues: gate.issues,
    ...trial === undefined ? {} : { trial },
  }
}

// ── op 分派 ───────────────────────────────────────────────────────────────

/** op 分派需要的外部依赖（测试可注入替身）。 */
export interface OpDependencies {
  readonly ctx: Context
  readonly config: () => CompanionConfig
  readonly configUpdate: (patch: Partial<CompanionConfig>) => Promise<CompanionConfig>
  readonly capabilities: () => OfficialCapabilities
  readonly jobs: JobRegistry
  /** 试装执行器；省略时用真实的 runTrialInstall（会真装候选包并起进程）。 */
  readonly trial?: TrialRunner
  /** 升级引擎依赖（ctx / 官方运行器 / 试装执行器 / 抓取器 的注入缝）。 */
  readonly upgrade?: UpgradeEngineDeps
}

/** 把试装执行器折成 gatedInstall 的可选参数（没注入就不传）。 */
function gatedInstallOptions(deps: OpDependencies): GatedInstallOptions {
  return deps.trial === undefined ? {} : { trial: deps.trial }
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
  // 用 sameEnvironment 而不是逐字比较：大小写不敏感的文件系统上（Windows/macOS）WEB 与 web 是同一个环境。
  // 独立复验（platform-audit §10.8 N-02）在真 win32 上实测：以 --profile WEB 启动时，列表里 web 行的
  // current 已经是 true（新护栏算对了），但这里逐字比较返回 undefined → 报告降级成"无法确定当前环境"、
  // diagnose 传大小写变体会得到"环境不存在：WEB"。非破坏性，但属于本仓库最在意的"把存在的说成不存在"。
  return listEnvironments(deps.ctx).find(env => sameEnvironment(env.name, name))
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
  // 同上：用户给的是环境名，落点是目录，逐字比较在大小写不敏感的文件系统上会误判"不存在"。
  const found = listEnvironments(deps.ctx).find(env => sameEnvironment(env.name, name))
  if (found === undefined) throw new Error(`环境不存在：${name}`)
  return found
}

/**
 * 解析一次升级/回滚的入参（**在起 job 之前**调用）。
 *
 * 为什么必须提前：这些字段缺失是"当场能回答的请求错误"，而 job 的失败只体现在后续轮询里。
 * 放进 job 里，客户端会拿到 `ok:true + jobId`，然后异步等一个注定失败的任务——
 * 错误被包装成了"看起来开始了"。
 *
 * @param deps - op 依赖（取环境）。
 * @param body - 请求体。
 * @param config - 当前配置。
 * @returns 升级引擎的入参。
 * @throws {Error} name / version 缺失或不是非空字符串时。
 */
function upgradeInput(
  deps: OpDependencies, body: Record<string, unknown>, config: CompanionConfig,
): UpgradeActionInput {
  const requested = typeof body["environment"] === "string" ? body["environment"] : undefined
  return {
    environment: targetEnvironment(deps, requested).name,
    name: requireString(body, "name"),
    version: requireString(body, "version"),
    ...typeof body["spec"] === "string" ? { spec: body["spec"] } : {},
    config,
  }
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
      // trialDisclosure 放在这里而不是设置页自己的接口：它是**静态事实**（会执行第三方代码、
      // 内存峰值），任何时候都能回答，且客户端启动时已经会拉这个 op——设置页因此不必
      // 为了"告知"再发一次请求，也不会出现"列表读失败所以告知也没了"。
      return { capabilities: deps.capabilities(), config, trialDisclosure: TRIAL_DISCLOSURE }

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
          typeof body["environment"] === "string" ? body["environment"] : undefined,
          gatedInstallOptions(deps)))

    case "listEnvironments":
      return listEnvironments(deps.ctx)

    case "scanRuns":
      return Object.fromEntries(scanRuns())

    case "environmentTemplates": {
      // 模板清单 = 官方 PROFILE_TEMPLATES 的投影；默认模板由后端给，客户端不要自己猜
      // （客户端猜成 base-only 就会建出一个必然起不来的环境，实测踩过）。
      return { default: DEFAULT_ENVIRONMENT_TEMPLATE, templates: environmentTemplates() }
    }

    case "startEnvironment": {
      const name = requireString(body, "name")
      // background=true 走后台（客户端已有的意图，之前被丢掉，导致永远弹终端窗口）。
      const mode = body["background"] === true ? "background" : "terminal"
      // 必须传 ctx：envManager 用它取官方 installAnchor 判定 web 层；拿不到时如实降级为
      // 「无法预判，仍按就绪探测等待」，而不是拒绝。
      return await startEnvironment(name, { ctx: deps.ctx, mode })
    }

    case "stopEnvironment":
      return await stopEnvironment(requireString(body, "name"))

    case "upgradeCheck": {
      // 检查是**短操作**（缓存命中时零网络）；手动检查（refresh）可能出网，
      // 但总预算有上限（见 upgrade.ts 的 CHECK_BUDGET_MS），不 job 化以免前端要多一跳轮询。
      const requested = typeof body["environment"] === "string" ? body["environment"] : undefined
      const target = targetEnvironment(deps, requested)
      return await checkUpgrades({
        environment: target.name,
        config,
        ...body["refresh"] === true ? { refresh: true } : {},
        ...deps.upgrade ?? {},
      })
    }

    case "upgrade": {
      // 入参校验必须在**起 job 之前**：job 的失败只体现在后续 job op 的轮询结果里，
      // 而"少给一个字段"是当场就能回答的请求错误。放进 job 里会让客户端拿到 ok:true +
      // jobId，然后异步等一个注定失败的任务——错误变成了"看起来开始了"。
      const input = upgradeInput(deps, body, config)
      return asJob(async () => await upgradePackage({ ...input, ...deps.upgrade ?? {} }))
    }

    case "upgradeRollback": {
      // 同上：先校验再起 job。
      const input = upgradeInput(deps, body, config)
      return asJob(async () => await rollbackUpgrade({ ...input, ...deps.upgrade ?? {} }))
    }

    case "trialEnvironments":
      // 纯读：列出测试环境 + 清理计划预览 + 现在生效的保留策略。这个 op 不删任何东西。
      return await trialEnvironmentReport(config)

    case "trialRemove":
      // 删单个测试环境：走引擎的三重纪律（只删 <名>-dpmc / 运行中先拒 / 进程事实不可读就拒）。
      return await removeTrialEnvironment(requireString(body, "name"), { ctx: deps.ctx })

    case "trialCleanup":
      // 一键清理过期（长操作：可能删多个目录，含真实快照的 node_modules）。
      // 与"自动清理"共用引擎的同一个计划与同一个记账（<DSH_HOME>/dpmc-trial-cleanup.log）。
      return asJob(async () => {
        const trial = effectiveTrialConfig(config)
        const result: TrialCleanupResult = await cleanupTrialEnvironments({ retainDays: trial.retentionDays })
        return result
      })

    case "createEnvironment":
      // 省略 template 时由后端默认到官方 web 模板（能起得来），不是官方 base-only 默认。
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
        // source: 'disabled' 让界面能说"市场在当前配置下已关闭"，而不是画成"没有匹配的条目"。
        return {
          items: [], generatedAt: new Date().toISOString(), cached: false, categories: {},
          source: "disabled",
        }
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
        // 索引事实一路带到界面：不可用时要能说"这次没拿到索引"，而不是"没有匹配的条目"。
        source: index.source,
        stale: index.stale,
        notes: index.notes,
      })
      return result
    }

    case "listKinds": {
      await pruneGhostRecords()
      const records = await loadKindRecords()
      const result: KindListResult = {
        records: [...records.values()],
        orphans: await findOrphanKindDirs(),
      }
      return result
    }

    case "uninstallKind":
      return asJob(async () => {
        const repo = requireString(body, "repo")
        const records = await loadKindRecords()
        const record = records.get(repo)
        if (record === undefined) return { ok: false, output: `没有安装记录：${repo}`, code: "not-found" }
        const root = record.kind === "skill" ? skillsRoot() : presetsRoot()
        // 精确目录清单：多目录安装（记录体带 dirs）逐个清；旧记录退回 dir。越界目录由
        // kindDirsOf 过滤掉，因此不会出现"dir 恰好等于根就静默跳过"的残留。
        for (const dir of kindDirsOf(record, root)) await removeKindDir(root, dir)
        await removeKindRecord(repo)
        // 文案全中文：record.kind 的枚举值是 'skill' / 'agent-preset'，直接插进中文句子就是中英混排。
        const kindLabel = record.kind === "skill" ? "技能" : record.kind === "agent-preset" ? "预设" : "未知类型"
        return { ok: true, output: `已卸载${kindLabel} ${repo}` } as EnvironmentResult
      })

    case "fix": {
      const action = requireString(body, "action")
      const target = typeof body["target"] === "string" ? body["target"] : undefined
      return asJob(async () => await applyFix(action, target, {
        ctx: deps.ctx,
        environmentName: () => deps.capabilities().environmentName,
        // 修复里的安装与市场安装走**同一个** gatedInstall，因此质量门与试装三边一致；
        // 注入的试装执行器照旧透传，测试才能不动真进程。
        install: async (spec) => await gatedInstall(deps.ctx, config, spec, undefined, gatedInstallOptions(deps)),
        // install-dependency 走这条：声明已在、只是没装，官方 add 会以 already-installed 拒绝。
        repair: async (target) => await repairDependencies(target, { ctx: deps.ctx }),
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
    // 升级引擎要 ctx 才能拿官方 installAnchor 与试装锚点；其余依赖留空走真实实现。
    upgrade: { ctx },
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
            // 与 marketplace op 保持同一口径：少了这三个，会出现"工具说没有、页面说失败"的不一致。
            source: index.source, stale: index.stale, notes: index.notes,
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


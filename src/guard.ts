/**
 * 插件安装守卫：拦住 agent 走"裸命令"改插件状态，并把正确走法写进拒绝原因。
 *
 * 归属：A 类·重写（拦 agent 工具调用 + 注册常驻提示段；旧 src/guard.ts 仅作意图参考，未复制代码）。
 * 旧实现参考：dsh-web-plugin-manager/src/guard.ts（194 行：按 shell 段判定、
 *   positional 词提取处理 --profile X 与 --profile=X 两种写法、npm 变体覆盖、
 *   动词词边界避免误伤 install-assets 这类脚本名、denial reason 直接给正确命令）。
 * 官方复用：官方 plugin_manager agent 工具（boot/plugin-manager/src/tools.ts，动作枚举
 *   list_plugins / list_bundles / set_plugin / set_bundle / install_bundle / remove_bundle）
 *   是**当前环境**写操作的正确入口；ctx.tools.guard 是官方提供的单调守卫注册点
 *   （返回 string 即拒绝，没有 allow 结果，所以监听顺序无法把拒绝翻回放行）；
 *   ctx.systemPrompt.section 是官方提示段注册点。
 * 前提检查：旧实现引导到它自建的 plugin_install / plugin_uninstall / plugin_toggle
 *   工具——那些工具在本仓库被**删除**了（用户决定："agent 工具只留 plugin_search +
 *   健康检查，其余交还官方"）。所以这里的引导目标必须换成官方 plugin_manager；
 *   引导到一个不存在的工具会让模型反复重试（比不拦更糟）。
 *
 * 范围与边界（如实声明，不夸大）：
 *   - 守卫只作用于**本进程内的 agent 工具调用**（bash / run_code）。用户在终端
 *     手工执行的裸命令拦不住，也不该拦——那是用户自己的机器。
 *   - 守卫是单调拒绝：它不能给别的守卫已拒绝的调用"放行"，只能加一道拒绝。
 *   - 我们自己的 CLI（dshpmc）走的正是官方 runPluginCommand，与官方 plugin_manager
 *     同一条 pnpm 通道，因此不被拦；DshPmc 自身也不在拦截词表里。
 */

import type { Context } from '@deepseek-ai/cordis'

/** 一条工具执行的只读视图（结构式；不 import 官方内部类型，避免 peer 版本漂移）。 */
export interface GuardedExecution {
  /** 工具名（'bash' / 'run_code' / 其它）。 */
  readonly name: string
  /** 解析后的入参：bash 用 command，run_code 用 code。 */
  readonly arguments?: unknown
}

/** tools 服务里我们用到的那一个方法。 */
interface GuardHost {
  guard(guard: (execution: GuardedExecution) => string | undefined): () => void
}

/** systemPrompt 服务里我们用到的那一个方法。 */
interface PromptHost {
  section(section: { name: string; order: number; text: string }): () => void
}

/** 官方 CLI 的 plugin 子命令写动词。 */
const PLUGIN_WRITE_VERBS = new Set(['add', 'install', 'remove', 'rm', 'update', 'upgrade', 'uninstall', 'delete'])

/** 官方 CLI 的 plugin 子命令只读动词（显式列出，避免"不在写词表里就算只读"的默认放行）。 */
export const PLUGIN_READ_VERBS = new Set(['list', 'status', 'help', 'dump-config', 'view', 'ls'])

/** 包管理器变更动词（npm/yarn/bun/pnpm 家族）。 */
const PM_WRITE_VERBS = new Set(['add', 'install', 'i', 'remove', 'rm', 'uninstall', 'update', 'upgrade', 'link'])

/** 出现在命令里即视为"目标是 DSH 环境"的标记。 */
const PROFILE_DIR_MARKER = /profiles[\\/]|\.dsh|DSH_HOME/i

/**
 * 从一条命令段里取出"位置词"：去掉全局 flag 与其取值。
 *
 * 两种写法都要处理：--profile web（空格分隔，值是下一个词）与 --profile=web
 * （内联）。解析器允许全局 flag 出现在任意位置，所以 flag 在子命令之前也要能
 * 认出子命令——早先只匹配"子命令紧邻"的写法会漏掉 flag-first 的同一个变更。
 *
 * 取值槽只在下一个词自己不是子命令 plugin 时才吃掉它，否则 flag-first 的写法
 * 会把 plugin 当成 --profile 的值丢掉。
 *
 * @param segment - 一条命令段（已按 ; | & 换行切开）。
 * @returns 位置词序列。
 */
export function positionalWords(segment: string): string[] {
  // 命令行词：shell 标点（引号、括号、反引号、=、逗号）与空白同样分词，
  // 因此嵌在引号里或 run_code 表达式里的同一个命令仍然能被认出来。
  const tokens = segment.match(/[A-Za-z0-9_@.\/~-]+/g) ?? []
  const out: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (token.startsWith('-')) {
      if (token.includes('=')) continue
      const next = tokens[index + 1]
      if (next !== undefined && !next.startsWith('-') && next !== 'plugin') index += 1
      continue
    }
    out.push(token)
  }
  return out
}

/** 一个位置词是否指 dsh 可执行文件（裸名或任意路径结尾）。 */
function isDshWord(word: string): boolean {
  return word.split('/').pop() === 'dsh'
}

/**
 * 一条命令段是否用官方 CLI 改了插件状态。
 *
 * 形如：dsh [--profile X] plugin <写动词> …（任意 flag 顺序）。只读动词（list /
 * status / help / dump-config）放行：那不是变更，拦住它只会让模型无法诊断。
 *
 * @param segment - 一条命令段。
 * @returns 是否是官方 CLI 的插件变更。
 */
export function isDshPluginMutation(segment: string): boolean {
  const words = positionalWords(segment)
  for (let index = 0; index < words.length - 1; index += 1) {
    if (!isDshWord(words[index]!) || words[index + 1] !== 'plugin') continue
    const verbs = words.slice(index + 2)
    if (verbs.some(verb => PLUGIN_WRITE_VERBS.has(verb))) return true
    // 只读动词（含无动词的裸 'dsh plugin'）→ 不算变更。
    if (verbs.some(verb => PLUGIN_READ_VERBS.has(verb))) return false
    return false
  }
  return false
}

/**
 * 一条命令段是否用包管理器改了 DSH 环境里的依赖。
 *
 * 两个条件同时成立才算：出现包管理器 + 写动词，且同一段里出现环境目录标记
 * （profiles/、.dsh、DSH_HOME）。只在项目目录里跑 pnpm add 是正常开发行为，
 * 拦它属于误伤。
 *
 * 动词用词边界判定：npm run install-assets 不是变更（脚本名以 install- 开头），
 * 早先的 \binstall\b 会把它误判成变更。
 *
 * @param segment - 一条命令段。
 * @returns 是否是对环境目录的包管理器变更。
 */
export function isProfilePackageMutation(segment: string): boolean {
  if (!/\b(?:pnpm|npm|yarn|bun)\b/.test(segment)) return false
  if (!PROFILE_DIR_MARKER.test(segment)) return false
  const words = positionalWords(segment)
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!
    if (word === 'pnpm' || word === 'npm' || word === 'yarn' || word === 'bun') {
      const verbs = words.slice(index + 1)
      if (verbs.some(verb => PM_WRITE_VERBS.has(verb))) return true
    }
  }
  return false
}

/**
 * 整条命令是否属于被拦的裸变更。
 *
 * 逐段判定（; 换行 & | 切开）：只读调用出现在另一段里不能豁免真正的变更，
 * 环境目录标记出现在另一段里也不能牵连一条无关的包管理器命令。
 *
 * @param command - 完整的命令行或 run_code 源码。
 * @returns 是否应拒绝。
 */
export function isRawPluginMutation(command: string): boolean {
  for (const segment of command.split(/[;\n&|]+/)) {
    if (isDshPluginMutation(segment)) return true
    if (isProfilePackageMutation(segment)) return true
  }
  return false
}

/** 从一次工具执行里取出命令行文本；非 bash/run_code 返回 null。 */
function commandText(execution: GuardedExecution): string | null {
  if (execution.name !== 'bash' && execution.name !== 'run_code') return null
  const args = execution.arguments as { command?: unknown; code?: unknown } | undefined
  if (typeof args?.command === 'string') return args.command
  if (typeof args?.code === 'string') return args.code
  return null
}

/**
 * 拒绝原因：必须**可直接执行**。
 *
 * 只写"不要这么做"会让模型换个说法再试；写清"改用 X 的 Y 动作"才能一次纠正。
 * 引导目标是官方 plugin_manager 工具（当前环境）与我们自己的 dshpmc CLI
 * （跨环境 + 质量门 + 技能/预设直装），两者都是官方 pnpm 通道，不是自建写路径。
 */
export const DENIAL_REASON =
  'Blocked: raw plugin mutations bypass the protected flow. Use the plugin_manager tool instead: '
  + 'plugin_manager { action: "list_plugins" } to find an entry id, then '
  + 'action: "set_plugin" | "set_bundle" (with target + enabled) to enable/disable, '
  + 'action: "install_bundle" (target: package spec) to install, or '
  + 'action: "remove_bundle" (target: package name) to uninstall — those actions require '
  + 'danger-full-access permission or an approval, and the user must confirm the change. '
  + 'For a quality-gated install, cross-environment management, or skill/agent-preset installs, '
  + 'run the companion CLI instead: dshpmc install <spec> --profile <name>, '
  + 'dshpmc remove <name>, dshpmc update <name>, dshpmc uninstall-kind <owner/repo>. '
  + 'Do not run bare "dsh plugin add/remove/update" or pnpm add/remove against a profile directory.'

/**
 * 常驻提示段：在模型尝试裸命令之前就把规则说清楚。
 *
 * order 300 落在官方 SECTION_ORDERS 的 PERSONA_PREFIX(0) 与 PLAN_POLICY(500) 之间：
 * 属于"操作约束"，要排在策略文本之前。旧实现用了同一个位置。
 */
export const PLUGIN_RULE_SECTION = {
  name: 'plugin-manager-companion:install-rule',
  order: 300,
  text: 'To install, remove, enable, disable, or update DSH plugins in the current profile, use the '
    + 'plugin_manager tool (actions: list_plugins, list_bundles, set_plugin, set_bundle, install_bundle, '
    + 'remove_bundle). It requires danger-full-access permission or approval. For a quality-gated install, '
    + 'another profile, or skill / agent-preset installs, use the companion CLI: dshpmc install <spec>, '
    + 'dshpmc remove <name>, dshpmc update <name>, dshpmc uninstall-kind <owner/repo>. '
    + 'Never run bare "dsh plugin add/remove" or npm/yarn/bun/pnpm add/remove against a profile directory: '
    + 'that path skips the quality gate and can leave the profile unable to boot.',
}

/**
 * 创建守卫函数（每次装配一个实例）。
 * @returns 守卫：命中裸变更时返回拒绝原因，否则 undefined。
 */
export function createPluginGuard(): (execution: GuardedExecution) => string | undefined {
  return (execution) => {
    const command = commandText(execution)
    if (command === null) return undefined
    return isRawPluginMutation(command) ? DENIAL_REASON : undefined
  }
}

/**
 * 把守卫注册到 tools 服务。
 *
 * tools 服务缺失时返回 null 而不是抛错：插件必须能在任何宿主上加载，
 * 没有工具注册表的宿主里"没有守卫"是事实，由调用方决定要不要记账。
 *
 * @param ctx - host 上下文。
 * @returns 注销函数；tools 服务不可用时 null。
 */
export function registerPluginGuard(ctx: Context): (() => void) | null {
  const tools = ctx.get('tools') as GuardHost | undefined
  if (tools === undefined || typeof tools.guard !== 'function') return null
  return tools.guard(createPluginGuard())
}

/**
 * 注册常驻提示段。
 *
 * @param ctx - host 上下文。
 * @returns 注销函数；systemPrompt 服务不可用时 null。
 */
export function registerPluginRulePrompt(ctx: Context): (() => void) | null {
  const systemPrompt = ctx.get('systemPrompt') as PromptHost | undefined
  if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') return null
  return systemPrompt.section({ ...PLUGIN_RULE_SECTION })
}

/**
 * 同时注册守卫与提示段（装配入口用一次调用表达两件事）。
 *
 * @param ctx - host 上下文。
 * @returns 两个注销函数；服务缺失时对应项为 null。
 */
export function registerGuard(ctx: Context): { readonly guard: (() => void) | null; readonly prompt: (() => void) | null } {
  return { guard: registerPluginGuard(ctx), prompt: registerPluginRulePrompt(ctx) }
}

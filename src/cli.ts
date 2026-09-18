#!/usr/bin/env node
/**
 * dshpmc —— dsh-plugin-manager-companion 的命令行入口。
 *
 * 归属：A 类·重写（可执行入口；旧 src/cli.ts 仅作意图参考，未复制代码）。
 * 旧实现参考：dsh-web-plugin-manager/src/cli.ts（400 行：bin 名 dshpm、命令集合
 *   install/remove/update/mount/list/analyze/uninstall-kind、全局 flag
 *   --profile/--home/--env、ctx 可空时跳过 live 应用、git 源缺 env 时给出
 *   续装命令）。
 * 官方复用：**包操作全部走官方 @deepseek-ai/dsh-plugin-manager/operations 的
 *   runPluginCommand**——它自带 profile 写锁（withFileLock）、profile 初始化、
 *   输出落盘与 bundle 激活，与 dsh plugin 命令、官方 plugin_manager 工具是同一条
 *   pnpm 通道。安装锚点优先取官方 @deepseek-ai/dsh/profile-boot 的 INSTALL_ANCHOR。
 *   本文件不拼任何 pnpm 参数、不写 package.json、不碰 cordis.patch.yml。
 * 前提检查：旧实现的前提（必须在 profile 里跑 pnpm、必须自己维护 insert 行）已消失：
 *   0.1.6 的官方 operations 按 profile 参数化，所以"管理另一个环境"= 换一个
 *   profile 参数，不是自建第二条写路径。旧实现的 mount（自己往 patch 里写挂载行）
 *   被**删除**：官方 plugin_manager 的 set_plugin/set_bundle 才是挂载与启停的唯一
 *   入口，这里只做只读盘点并把正确动作报给用户。
 *
 * 退出码：0 成功；1 发现问题（analyze）/ 操作失败；2 用法或环境错误。
 * bin 名刻意用 dshpmc（旧包用 dshpm），两个包共存期间不会互相抢 bin。
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  dshHome, environmentDir, isBuiltinEnvironment, isSafeEnvironmentName, readEnvironmentManifest,
} from './paths.ts'
import { DEFAULT_CONFIG, type CompanionConfig } from './settings.ts'
import {
  addBlockedRepo, loadKindRecords, loadBlockedRepos, presetsRoot, removeKindDir, removeKindRecord,
  skillsRoot, type RepoKind,
} from './kinds.ts'
import {
  cleanupOwnedPresets, formatCleanupResult, pluginInstalledInOtherEnvironments,
} from './presets.ts'
import {
  formatMissingRequirements, isGitSource, isSensitiveEnvKey, scanRequirements,
} from './scan.ts'
import { filterAnswers, sessionKey, withInstallSession } from './installSession.ts'
import type { DiagnosticReport, EnvironmentInfo, InstalledKind } from './types.ts'

/** 官方 runPluginCommand 的入参形状（结构式，见下）。 */
export interface PluginOperationContext {
  readonly profile: string
  /** 显式环境目录；省略时官方自己解析。 */
  readonly dir?: string
  /** dsh 自身安装的 package.json 绝对路径。 */
  readonly installAnchor: string
  /** 调用方的工作目录（相对路径安装源按它解析）。 */
  readonly cwd: string
  /** Harness home。 */
  readonly home?: string
}

/** 官方包操作的执行策略。 */
export interface PluginOperationOptions {
  readonly execution: 'cli' | 'service'
  readonly outputBytes: number
  readonly lockWaitMs?: number
  readonly env?: Readonly<Record<string, string>>
  readonly onOutput?: (text: string, stream: 'stdout' | 'stderr') => void
}

/** 官方包操作的返回。 */
export interface PluginOperationResult {
  readonly exitCode: number | null
  readonly output: string
  /** 失败分类（官方 classifyInstallFailure 的结果），可能缺省。 */
  readonly kind?: string
  /** 官方写下的完整日志路径。 */
  readonly logPath?: string
}

/** 与官方 operations 对接的那一个函数。 */
export type RunPluginCommand = (
  context: PluginOperationContext,
  args: readonly string[],
  options: PluginOperationOptions,
) => Promise<PluginOperationResult>

/** CLI 的可注入依赖（测试用来替代真实 pnpm 与诊断引擎）。 */
export interface CliDependencies {
  /** 跑一次修复动作；由宿主注入（CLI 不 import 诊断引擎，见文件头说明）。 */
  readonly analyze?: (
    environmentName: string,
    config: CompanionConfig,
  ) => Promise<DiagnosticReport>
  /** 官方 runPluginCommand；缺省时 CLI 会动态 import 官方包，两条路都不通就报错。 */
  readonly runPluginCommand?: RunPluginCommand
  /** 安装锚点覆盖（宿主进程里应传 ctx.profileContext.installAnchor）。 */
  readonly installAnchor?: string
  /** 标准输出。 */
  readonly stdout?: (text: string) => void
  /** 标准错误。 */
  readonly stderr?: (text: string) => void
}

/** 解析后的全局 flag。 */
export interface CliOptions {
  readonly command: string
  /** 位置参数（命令之后的非 flag 词）。 */
  readonly args: readonly string[]
  readonly profile: string
  /** --home 覆盖；未给时 undefined。 */
  readonly home?: string
  /** --env KEY=value。 */
  readonly env: Readonly<Record<string, string>>
  readonly json: boolean
  /** 少数命令的支持项：marketplace 强制刷新等；也用于跳过确认类动作。 */
  readonly flags: ReadonlySet<string>
}

/** 默认 profile（与旧实现一致：web 是绝大多数用户的环境）。 */
export const DEFAULT_PROFILE = 'web'

/** 用法文本。 */
export const USAGE = [
  'dshpmc - companion CLI for the DSH plugin manager',
  '',
  'Usage: dshpmc <command> [options]',
  '',
  'Commands:',
  '  install <spec>            Install a package into a profile through the official protected flow',
  '  remove <name>             Remove an installed package from a profile',
  '  update <name>             Re-resolve a package to its newest version (add <name>@latest)',
  '  mount <name>              Report whether a declared dependency is mounted, and what to do (read-only)',
  '  list                      List the layer stack, dependencies and companion-installed skills/presets',
  '  analyze                   Run the deep environment health check (exit 1 when issues are found)',
  '  uninstall-kind <repo>     Remove a companion-installed skill or agent preset (owner/repo)',
  '  help                      Show this text',
  '  version                   Print the CLI version',
  '',
  'Options:',
  '  --profile <name>          Target profile (default: ' + DEFAULT_PROFILE + ')',
  '  --home <dir>              Override DSH_HOME for this invocation',
  '  --env KEY=value           Provide an environment variable the plugin needs (repeatable)',
  '  --json                    Machine-readable output where supported',
].join(String.fromCharCode(10))

/**
 * 解析 argv。
 *
 * 全局 flag 可以出现在命令前或命令后（与官方 CLI 的解析器一致），因此解析一遍
 * 就够，不需要位置状态机。未知 flag 也接受：CLI 是给工具与其他脚本调的，
 * 对未知 flag 报错只会让上游版本升级变脆。
 *
 * @param argv - 进程参数（不含 node 与脚本路径），也可以用完整 process.argv。
 * @returns 解析结果。
 * @throws 缺少命令名或 --env 形式非法时。
 */
export function parseArgs(argv: readonly string[]): CliOptions {
  const tokens = [...argv]
  // 传完整 process.argv 时丢掉 node 与脚本路径（两者都不以 - 开头，且是绝对路径）。
  if (tokens.length >= 2 && /[\\/]node(\.exe)?$/.test(tokens[0]!) && tokens[1]!.includes('cli')) tokens.splice(0, 2)
  const rest: string[] = []
  const env: Record<string, string> = {}
  const flags = new Set<string>()
  let profile = DEFAULT_PROFILE
  let home: string | undefined
  let json = false
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (token === '--profile') {
      const value = tokens[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error('--profile requires a value')
      profile = value
      index += 1
      continue
    }
    if (token.startsWith('--profile=')) {
      profile = token.slice('--profile='.length)
      continue
    }
    if (token === '--home') {
      const value = tokens[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error('--home requires a value')
      home = value
      index += 1
      continue
    }
    if (token.startsWith('--home=')) {
      home = token.slice('--home='.length)
      continue
    }
    if (token === '--env') {
      const value = tokens[index + 1]
      if (value === undefined || !value.includes('=')) throw new Error('--env requires KEY=value')
      const separator = value.indexOf('=')
      env[value.slice(0, separator)] = value.slice(separator + 1)
      index += 1
      continue
    }
    if (token.startsWith('--env=')) {
      const value = token.slice('--env='.length)
      if (!value.includes('=')) throw new Error('--env requires KEY=value')
      const separator = value.indexOf('=')
      env[value.slice(0, separator)] = value.slice(separator + 1)
      continue
    }
    if (token === '--json') {
      json = true
      continue
    }
    if (token.startsWith('--')) {
      flags.add(token.slice(2))
      continue
    }
    rest.push(token)
  }
  const command = rest.shift()
  if (command === undefined || command === '') throw new Error('missing command; run "dshpmc help"')
  if (!isSafeEnvironmentName(profile)) throw new Error('unsafe profile name: ' + JSON.stringify(profile))
  return { command, args: rest, profile, ...home === undefined ? {} : { home }, env, json, flags }
}

/** 环境目录（--home 覆盖时先改进程 DSH_HOME，让 paths/presets 与官方 operations 看到同一个 home）。 */
function prepareHome(options: CliOptions): void {
  if (options.home === undefined) return
  process.env['DSH_HOME'] = resolve(options.home)
}

/**
 * 解析官方 dsh 安装的 package.json 锚点。
 *
 * 三条路，按可靠性排序：
 *   1. 注入（宿主进程里应传 ctx.profileContext.installAnchor）；
 *   2. 官方 @deepseek-ai/dsh/profile-boot 的 INSTALL_ANCHOR（CLI 跑在装了 dsh 的
 *      profile 里时可用）；
 *   3. 从 CLI 自身位置向上找 node_modules/@deepseek-ai/dsh/package.json。
 * 三条都不通时**不猜**：返回 undefined，由调用方给出可执行的报错。
 *
 * @param injected - 注入的锚点。
 * @returns 锚点绝对路径；解析不出时 undefined。
 */
export async function resolveInstallAnchor(injected?: string): Promise<string | undefined> {
  // 空白注入按"没给"处理：调用方用一个空格表达"别用注入值"比传 undefined 更常见，
  // 当成锚点会让引擎拿一个空白路径去解析，而报错文本里只有一个空格，查不出原因。
  if (injected !== undefined && injected.trim() !== '') return injected
  try {
    // 说明符放在变量里：官方包是 peer（CLI 可能在没装它的环境里使用），
    // 字面量说明符会让 tsc 去解析一个不保证存在的模块并让构建失败；
    // 放在变量里解析失败会落到下面的 catch，正是我们要的行为。
    const specifier = '@deepseek-ai/dsh/profile-boot'
    const module = await import(specifier) as { INSTALL_ANCHOR?: unknown }
    if (typeof module.INSTALL_ANCHOR === 'string' && existsSync(module.INSTALL_ANCHOR)) return module.INSTALL_ANCHOR
  } catch {
    // 官方包不可解析（CLI 在 profile 之外跑）：继续找别的路。
  }
  const fromEnv = process.env['DSH_INSTALL_ANCHOR']
  if (fromEnv !== undefined && existsSync(fromEnv)) return fromEnv
  return findAnchorFrom(process.cwd())
}

/** 从给定目录向上找 node_modules/@deepseek-ai/dsh/package.json。 */
function findAnchorFrom(start: string): string | undefined {
  let current = resolve(start)
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(current, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    if (existsSync(candidate)) return candidate
    const parent = resolve(current, '..')
    if (parent === current) break
    current = parent
  }
  return undefined
}

/**
 * 取官方 runPluginCommand；注入优先，否则动态 import。
 *
 * 动态 import 而不是静态 import 的原因是构建顺序：静态 import 会让本文件的编译
 * 依赖官方子路径的解析结果，而 CLI 可能在官方包不可用的环境里构建/使用。
 * 解析失败不是一个崩溃点，而是一个可读的操作错误。
 *
 * @param injected - 注入的实现。
 * @returns 官方实现。
 * @throws 官方包不可解析时。
 */
export async function loadRunPluginCommand(injected?: RunPluginCommand): Promise<RunPluginCommand> {
  if (injected !== undefined) return injected
  try {
    const module = await import('@deepseek-ai/dsh-plugin-manager/operations') as { runPluginCommand?: unknown }
    if (typeof module.runPluginCommand !== 'function') {
      throw new Error('the official plugin-manager operations module exports no runPluginCommand')
    }
    return module.runPluginCommand as RunPluginCommand
  } catch (error) {
    throw new Error('cannot load the official plugin operations (runPluginCommand): '
      + (error instanceof Error ? error.message : String(error))
      + '. Run this command from a shell where dsh is installed, or run "dshpmc" through the profile copy of the companion.')
  }
}

/**
 * 跑一次受保护的包操作。
 *
 * git 源会先扫描仓库需要的环境变量（见 scan.ts），把缺失清单报给用户，
 * 并**只按扫描白名单**注入 --env 提供的值；子进程环境剔掉敏感键形态。
 * 本函数不拼 pnpm 参数——args 直接交给官方 runPluginCommand。
 *
 * @param options - 解析后的全局 flag。
 * @param args - 官方 pnpm 参数（如 ['add', spec]）。
 * @param deps - 注入的依赖。
 * @returns 退出码。
 */
async function runProtectedOperation(
  options: CliOptions,
  args: readonly string[],
  deps: CliDependencies,
  out: { stdout: (text: string) => void; stderr: (text: string) => void },
): Promise<number> {
  const installAnchor = await resolveInstallAnchor(deps.installAnchor)
  if (installAnchor === undefined) {
    out.stderr('dshpmc: cannot locate the dsh installation (its package.json). '
      + 'Run from an installed dsh, or set DSH_INSTALL_ANCHOR to that file.' + String.fromCharCode(10))
    return 2
  }
  const home = options.home === undefined ? dshHome() : resolve(options.home)
  let env: Record<string, string> = {}
  const spec = args[args.length - 1] ?? ''
  if (isGitSource(spec)) {
    // 会话键与 git 缓存目录由官方 clone 流程决定，这里只做"扫描 + 白名单校验"，
    // 不把 spec 当路径用——CLI 每次调用是新进程，没有会话可复用（见 installSession.ts）。
    const scanRoot = resolve(process.cwd(), spec.replace(/^git\+/i, '').replace(/#.*$/, ''))
    const report = existsSync(scanRoot)
      ? await scanRequirements(scanRoot)
      : undefined
    if (report === undefined) {
      // 远程 git 源在官方 pnpm 流程里才 clone，安装前没有可扫的目录。如实说明而不是假装扫过了：
      // 漏报的变量会在 pnpm 输出里以失败的形式出现。
      out.stdout('dshpmc: note: a remote git source cannot be pre-scanned before pnpm clones it. '
        + 'If this plugin needs credentials during install or build, pass them now: --env KEY=value.')
    }
    if (report !== undefined) {
      const provided = filterAnswers(report.requirements, options.env)
      const missing = formatMissingRequirements(report, provided)
      if (missing.length > 0) {
        out.stderr('dshpmc: the git source may need environment variables during install/build:' + String.fromCharCode(10))
        for (const name of missing) out.stderr('  - ' + name + String.fromCharCode(10))
        if (report.truncated) {
          out.stderr('  (scan limits reached: ' + report.truncatedReasons.join('; ')
            + ' — the list may be incomplete)' + String.fromCharCode(10))
        }
        out.stderr('Re-run the same command with --env KEY=value for each one, for example:' + String.fromCharCode(10))
        out.stderr('  dshpmc ' + options.command + ' ' + spec
          + ' --profile ' + options.profile
          + (missing.length === 0 ? '' : ' --env ' + (missing[0]!.split('  ')[0] ?? 'KEY') + '=...') + String.fromCharCode(10))
        return 1
      }
      env = provided
    }
  }
  const run = await loadRunPluginCommand(deps.runPluginCommand)
  // 官方在 execution: 'cli' 下继承终端环境（pnpm 需要用户的 PATH/nvm），因此
  // 敏感键不能靠 options.env 覆盖掉——它是在 process.env 之上合并的，删不掉。
  // 做法是：调用期间把这些键从 process.env 里摘掉，调用结束还原。CLI 一次调用
  // 只跑一个操作、且是单线程，窗口内没有别的读者；宿主进程不走这条路径。
  const answers = filterAnswers(Object.keys(env), env)
  const result = await withScrubbedEnvironment(async () => await run(
    {
      profile: options.profile,
      installAnchor,
      cwd: process.cwd(),
      home,
    },
    args,
    {
      execution: 'cli',
      outputBytes: 16384,
      lockWaitMs: 120_000,
      // 只注入用户显式提供的白名单键（scan.ts 的扫描结果），其余宿主键不被
      // 注入也不被改写——环境注入面由扫描结果决定，不由提交方的键名决定。
      env: answers,
      onOutput: (text, stream) => {
        if (stream === 'stdout') out.stdout(text)
        else out.stderr(text)
      },
    },
  ))
  if (result.exitCode === 127) {
    out.stderr('dshpmc: pnpm was not found; install pnpm and make it available on PATH.' + String.fromCharCode(10))
  }
  if (result.kind !== undefined) out.stderr('dshpmc: failure classified as ' + result.kind + String.fromCharCode(10))
  if (result.exitCode !== 0 && result.logPath !== undefined) {
    out.stderr('dshpmc: full log at ' + result.logPath + String.fromCharCode(10))
    if (isGitSource(spec)) {
      out.stderr('dshpmc: git-hosted plugins build on install via their prepare script; if pnpm printed an '
        + 'allowBuilds hint, approve the listed key in the profile pnpm-workspace.yaml and re-run.'
        + String.fromCharCode(10))
    }
  }
  return result.exitCode === null ? 1 : result.exitCode
}

/**
 * 在"摘掉敏感键"的环境里执行一段工作，结束后原样还原。
 *
 * 为什么需要它：官方 runPluginCommand 的 execution: 'cli' 模式继承终端环境（pnpm 要
 * 用用户的 PATH/nvm），options.env 是在 process.env 之上**合并**的，无法用它删掉键。
 * 而 git 源的插件会在 prepare/postinstall 里跑第三方代码，GITHUB_TOKEN 这类值不该
 * 顺路交出去。窗口只覆盖一次包操作；还原在 finally 里，失败也不会把宿主的变量吃掉。
 *
 * @param task - 要在净化环境里执行的工作。
 * @returns 工作结果。
 */
async function withScrubbedEnvironment<T>(task: () => Promise<T>): Promise<T> {
  const removed: Array<[string, string]> = []
  for (const key of Object.keys(process.env)) {
    if (!isSensitiveEnvKey(key)) continue
    const value = process.env[key]
    if (value === undefined) continue
    removed.push([key, value])
    delete process.env[key]
  }
  try {
    return await task()
  } finally {
    for (const [key, value] of removed) process.env[key] = value
  }
}

/** 一个安装记录的可读行。 */
function recordLine(key: string, record: InstalledKind): string {
  const where = record.dir === '' ? '(unknown location)' : record.dir
  return '- ' + key + ' [' + record.kind + '] -> ' + where + '  installed ' + record.installedAt
}

/** 列出环境事实 + 我们的安装记录（只读）。 */
async function runList(options: CliOptions, out: { stdout: (text: string) => void }): Promise<number> {
  const dir = environmentDir(options.profile)
  if (!existsSync(dir)) {
    out.stdout('profile "' + options.profile + '" is not installed at ' + dir + String.fromCharCode(10))
  } else {
    const manifest = readEnvironmentManifest(dir)
    out.stdout('profile: ' + options.profile
      + (isBuiltinEnvironment(options.profile) ? ' (builtin)' : '')
      + String.fromCharCode(10) + '  dir: ' + dir + String.fromCharCode(10))
    if (manifest.broken !== undefined) {
      out.stdout('  manifest unreadable: ' + manifest.broken + String.fromCharCode(10))
    }
    out.stdout('  bundle layers (' + String(manifest.bundles.length) + '):'
      + (manifest.bundles.length === 0 ? ' (none)' : '') + String.fromCharCode(10))
    for (const bundle of manifest.bundles) out.stdout('    - ' + bundle + String.fromCharCode(10))
    out.stdout('  dependencies (' + String(manifest.dependencies.length) + '):'
      + (manifest.dependencies.length === 0 ? ' (none)' : '') + String.fromCharCode(10))
    for (const dependency of manifest.dependencies) out.stdout('    - ' + dependency + String.fromCharCode(10))
  }
  const records = await loadKindRecords()
  out.stdout('companion-installed skills/presets (' + String(records.size) + '):' + String.fromCharCode(10))
  if (records.size === 0) out.stdout('  (none)' + String.fromCharCode(10))
  for (const [key, record] of records) out.stdout('  ' + recordLine(key, record) + String.fromCharCode(10))
  out.stdout('skill root: ' + skillsRoot() + String.fromCharCode(10))
  out.stdout('preset root: ' + presetsRoot() + String.fromCharCode(10))
  const blocked = await loadBlockedRepos()
  if (blocked.size > 0) {
    out.stdout('blocked repositories (' + String(blocked.size) + '): ' + [...blocked].sort().join(', ') + String.fromCharCode(10))
  }
  out.stdout("Note: mounting/enabling a plugin in the current profile is the official plugin_manager tool's job (action set_plugin / set_bundle). This CLI never edits cordis.patch.yml.")
  return 0
}

/**
 * mount：只读盘点一个依赖是否被挂载。
 *
 * 刻意**不做**挂载写入：挂载行属于 profile 组合，官方 plugin_manager 的
 * set_plugin/set_bundle 是唯一入口。这里的价值是把"声明了但没挂载"这件事查出来
 * 并给出可直接执行的下一步。
 */
async function runMount(options: CliOptions, out: { stdout: (text: string) => void; stderr: (text: string) => void }): Promise<number> {
  const name = options.args[0]
  if (name === undefined || name === '') {
    out.stderr('dshpmc mount: a package name is required' + String.fromCharCode(10))
    return 2
  }
  const dir = environmentDir(options.profile)
  if (!existsSync(dir)) {
    out.stderr('dshpmc mount: profile "' + options.profile + '" is not installed at ' + dir + String.fromCharCode(10))
    return 2
  }
  const manifest = readEnvironmentManifest(dir)
  const declared = manifest.dependencies.includes(name)
  const isLayer = manifest.bundles.includes(name)
  out.stdout('package: ' + name + String.fromCharCode(10))
  out.stdout('  declared in package.json: ' + (declared ? 'yes' : 'no') + String.fromCharCode(10))
  out.stdout('  in the bundle layer stack: ' + (isLayer ? 'yes' : 'no') + String.fromCharCode(10))
  if (!declared) {
    out.stdout('Install it first: dshpmc install ' + name + ' --profile ' + options.profile + String.fromCharCode(10))
    return 0
  }
  out.stdout(String.fromCharCode(10)
    + 'A declared dependency is not necessarily mounted. Check and mount it through the official manager:'
    + String.fromCharCode(10)
    + '  plugin_manager { action: "list_plugins" }              # find the entry id and its current state'
    + String.fromCharCode(10)
    + '  plugin_manager { action: "set_plugin", target: "<entry id>", enabled: true }'
    + String.fromCharCode(10)
    + '  plugin_manager { action: "set_bundle", target: "' + name + '", enabled: true }  # if it is a bundle'
    + String.fromCharCode(10)
    + '(those actions require danger-full-access permission or approval; the change affects every session '
    + 'in profile ' + options.profile + ')' + String.fromCharCode(10))
  return 0
}

/** 引擎模块的最小结构式视图：动态加载，加载失败也要能报出可读原因。 */
interface AnalyzerModule {
  analyzeEnvironment(ctx: unknown, env: Record<string, unknown>, config: CompanionConfig): Promise<DiagnosticReport>
}

/** 诊断目标：EnvironmentInfo 加上可选安装锚点（与 diagnostics.ts 的 DiagnosticTargetEnvironment 同形）。 */
type AnalyzeTarget = EnvironmentInfo & { readonly installAnchor?: string }

/**
 * 最小 host 上下文。
 *
 * 引擎对 ctx 只做两件事：ctx.get('profileContext') 取安装锚点、ctx.logger 记账。
 * CLI 进程里两样都没有：get 一律 undefined（引擎会把它记成"没有锚点"的 skipped，
 * 而不是当成"包不存在"），logger 用空实现。**不假装自己是宿主**。
 *
 * @returns 结构式最小上下文。
 */
export function minimalCliContext(): { get(name: string): undefined; logger: Record<string, () => void> } {
  const noop = (): void => {}
  return { get: () => undefined, logger: { debug: noop, info: noop, warn: noop, error: noop } }
}

/**
 * 动态加载诊断引擎。
 *
 * 刻意不用静态 import：CLI 要在引擎的官方依赖（app-boot / plugin-inventory 等）缺失时
 * 也能报出**可读的原因**，而不是让整个 bin 加载失败。说明符放在变量里，避免打包/编译期
 * 去解析一个不保证存在的模块。
 *
 * @returns 引擎模块或失败原因。
 */
export async function loadAnalyzer(): Promise<{ readonly analyzer?: AnalyzerModule; readonly reason?: string }> {
  try {
    const specifier = './diagnostics.js'
    const module = await import(specifier) as { analyzeEnvironment?: unknown }
    if (typeof module.analyzeEnvironment !== 'function') {
      return { reason: 'the diagnostics module exposes no analyzeEnvironment export' }
    }
    return { analyzer: module as unknown as AnalyzerModule }
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 由磁盘事实构造诊断目标（不依赖宿主）。
 *
 * @param name - 环境名。
 * @param installAnchor - 已解析的安装锚点；解析不出时不传（引擎会如实记 skipped）。
 * @returns 诊断目标。
 */
export function environmentTargetFor(name: string, installAnchor?: string): AnalyzeTarget {
  const dir = environmentDir(name)
  const manifest = readEnvironmentManifest(dir)
  return {
    name,
    dir,
    current: false,
    builtin: isBuiltinEnvironment(name),
    bundles: manifest.bundles,
    dependencies: manifest.dependencies,
    runs: [],
    ...installAnchor === undefined ? {} : { installAnchor },
  }
}

/**
 * 启动阶段硬失败的根因特征。
 *
 * 这三种"脏"会让 dsh 在启动阶段就退出：用户连界面都没有，诊断页也永远看不到。
 * CLI 是唯一的逃生口，所以这里把根因文本显式挑出来单独展示——即便它在报告里的
 * 身份只是"某层被跳过的原因"（官方 composeEntries / loadProfileDirectory 会抛错，
 * 引擎把抛错原因记进 skipped）。
 */
export const BOOT_BLOCKER_SIGNATURES: readonly string[] = [
  'duplicate loader entry id',
  'cannot resolve profile bundle',
  'ERR_MODULE_NOT_FOUND',
  'plugin tree failed to load',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
]

/**
 * 关键核对项：这些没跑完，就不能说"环境没问题"。
 *
 * 与"结构性不可用"分开：CLI 里没有活 Loader，运行时层（runtime）永远跳过，那是**已知且预期**
 * 的缺失（要显著告知，但不构成"有问题"）；而依赖/组合/一致性三层是只读磁盘就能跑的，
 * 它们跳过说明这次诊断并没有真正覆盖到"环境能不能起来"。
 */
export const CRITICAL_SKIP_CHECKS: readonly string[] = [
  'environment-dir', 'dependency-layer', 'composition-official', 'composition-layer', 'consistency-layer',
]

/** 一次诊断的完整判定：覆盖情况 + 根因 + 退出码语义。 */
export interface AnalyzeCoverage {
  /** 哪个层跑完了 / 跳过了 / 被配置关闭。 */
  readonly layers: readonly { readonly layer: string; readonly state: 'ran' | 'skipped' | 'disabled' }[]
  /** 关键核对项没完成的原因（人类可读）。 */
  readonly incomplete: readonly string[]
  /** 启动阶段硬失败的根因文本（可能来自 skipped.reason，而不只是 issues）。 */
  readonly blockers: readonly string[]
  /** 判定：发现问题 / 没跑完 / 干净。 */
  readonly verdict: 'issues' | 'incomplete' | 'clean'
  /** 退出码：0 干净；1 有问题或没跑完；2 用法/环境错误由调用方给。 */
  readonly code: number
}

/**
 * 一个 skipped 条目归属的层。
 *
 * 优先用引擎给的 `layers`（task-29 起 DiagnosticSkip 带复数层归属——单数表达不了
 * "一次能力缺失同时废掉两层"）；老引擎没有这个字段时退回按 check 名推断。
 *
 * @param skip - 跳过项。
 * @returns 层名列表。
 */
function layersOfSkip(skip: { readonly check: string; readonly layers?: unknown }): string[] {
  if (Array.isArray(skip.layers)) {
    return skip.layers.filter((layer): layer is string => typeof layer === 'string')
  }
  const named = ['dependency', 'composition', 'runtime', 'consistency', 'ecosystem']
    .filter(layer => skip.check === layer + '-layer' || skip.check.startsWith(layer + '-'))
  return named
}

/**
 * 这个跳过项是否让"环境没问题"这句话不能成立。
 *
 * 关键层是只读磁盘就能跑的三层（依赖/组合/一致性）：它们跳过说明这次诊断没有真正覆盖
 * "环境能不能起来"。运行时层在 CLI 里结构性不可用（没有活 Loader），要显著告知，但不构成结论。
 *
 * @param skip - 跳过项。
 * @returns 是否属于关键核对缺失。
 */
function isCriticalSkip(skip: { readonly check: string; readonly layers?: unknown }): boolean {
  if (CRITICAL_SKIP_CHECKS.includes(skip.check)) return true
  return layersOfSkip(skip).some(layer => CRITICAL_SKIP_CHECKS.includes(layer + '-layer'))
}

/** 文本里是否含启动阶段硬失败特征。 */
function blockerHit(text: string): string | undefined {
  for (const signature of BOOT_BLOCKER_SIGNATURES) {
    if (text.includes(signature)) return signature
  }
  return undefined
}

/**
 * 判定一次诊断的结果与退出码。
 *
 * 语义（刻意不让 issues=0 等于"健康"）：
 *   - 有问题 → 'issues' / 1；
 *   - 没问题但**关键核对项没跑完**（组合层读不出来、缺安装锚点）→ 'incomplete' / 1，
 *     由调用方在文案里说清楚"这次没能完成组合层核对"；
 *   - 只有关键项都跑完且没问题才是 'clean' / 0。
 *
 * @param report - 引擎报告。
 * @param notes - 调用方补充的事实（例如"没有安装锚点"）。
 * @returns 判定结果。
 */
export function judgeAnalyze(
  report: DiagnosticReport,
  notes: { readonly anchorMissing?: boolean; readonly disabledLayers?: readonly string[] } = {},
): AnalyzeCoverage {
  const blockers: string[] = []
  const pushBlocker = (text: string): void => {
    if (text === '' || blockerHit(text) === undefined) return
    if (!blockers.includes(text)) blockers.push(text)
  }
  for (const issue of report.issues) {
    pushBlocker(issue.title)
    pushBlocker(issue.detail)
    for (const evidence of issue.evidence) pushBlocker(evidence.at + ' — ' + evidence.note)
    if (issue.fix !== undefined) pushBlocker(issue.fix.summary)
  }
  for (const skip of report.skipped) pushBlocker(skip.reason)

  const incomplete: string[] = []
  for (const skip of report.skipped) {
    if (!isCriticalSkip(skip)) continue
    incomplete.push(skip.check + ': ' + skip.reason)
  }
  if (notes.anchorMissing === true) {
    incomplete.push('install-anchor: 没有安装锚点 → L1 dependency / L2 composition / L4 consistency 的模块解析缺安装侧根，本次结果不完整')
  }

  const disabled = new Set(notes.disabledLayers ?? [])
  const skippedLayers = new Set<string>()
  for (const skip of report.skipped) {
    for (const layer of layersOfSkip(skip)) skippedLayers.add(layer)
  }
  const layers = ['dependency', 'composition', 'runtime', 'consistency', 'ecosystem'].map(layer => ({
    layer,
    state: disabled.has(layer)
      ? 'disabled' as const
      : skippedLayers.has(layer) ? 'skipped' as const : 'ran' as const,
  }))

  const verdict: AnalyzeCoverage['verdict'] = report.issues.length > 0
    ? 'issues'
    : (incomplete.length > 0 || blockers.length > 0) ? 'incomplete' : 'clean'
  return { layers, incomplete, blockers, verdict, code: verdict === 'clean' ? 0 : 1 }
}

/**
 * analyze：跑诊断并打印。
 *
 * 两条路径：
 *   1. 宿主注入的 deps.analyze（Web 侧接线）优先——那条路径有自己的活 Loader；
 *   2. 没有注入时**自己加载引擎只读跑**：环境起不来（bundle 解析不到 / patch 行解析不到 /
 *      两行同 id）时界面上没有任何入口，CLI 是唯一的逃生口，所以这条路径必须真的能跑。
 *
 * @param options - 解析后的全局 flag。
 * @param deps - 注入依赖。
 * @param out - 输出 sink。
 * @returns 退出码：0 干净；1 有问题/没跑完；2 用法或环境错误。
 */
async function runAnalyze(options: CliOptions, deps: CliDependencies, out: { stdout: (text: string) => void; stderr: (text: string) => void }): Promise<number> {
  const nl = String.fromCharCode(10)
  let report: DiagnosticReport
  let anchorMissing = false
  let anchorPath: string | undefined
  if (deps.analyze !== undefined) {
    report = await deps.analyze(options.profile, DEFAULT_CONFIG)
  } else {
    const loaded = await loadAnalyzer()
    if (loaded.analyzer === undefined) {
      out.stderr('dshpmc analyze: cannot load the diagnostics engine (' + (loaded.reason ?? 'unknown reason') + ').' + nl
        + 'Install the companion package build (pnpm run build:host) or pass the host plugin path.' + nl)
      return 2
    }
    anchorPath = await resolveInstallAnchor(deps.installAnchor)
    anchorMissing = anchorPath === undefined
    const target = environmentTargetFor(options.profile, anchorPath)
    // 最小 ctx：没有活 Loader，运行时层会如实记 skipped（而不是假装查过）。
    report = await loaded.analyzer.analyzeEnvironment(minimalCliContext(), { ...target }, DEFAULT_CONFIG)
  }

  const disabledLayers = Object.entries(DEFAULT_CONFIG.diagnostics)
    .filter(([, enabled]) => enabled !== true)
    .map(([layer]) => layer)
  const judgement = judgeAnalyze(report, { anchorMissing, disabledLayers })
  const counts = Object.entries(report.counts).filter(([, count]) => count > 0)

  if (options.json) {
    out.stdout(JSON.stringify(report, undefined, 2) + nl)
    out.stderr('coverage: ' + judgement.layers.map(layer => layer.layer + '=' + layer.state).join(' ')
      + '  verdict: ' + judgement.verdict + nl)
    return judgement.code
  }

  out.stdout('environment: ' + report.environment + '   checked at ' + report.generatedAt + nl)
  out.stdout('  dir: ' + environmentDir(options.profile) + nl)
  out.stdout('  coverage: ' + judgement.layers.map(layer => layer.layer + '=' + layer.state).join(' ') + nl)
  out.stdout('  install anchor: ' + (anchorPath ?? (deps.analyze === undefined ? 'MISSING' : 'provided by the host')) + nl)
  out.stdout('issues: ' + String(report.issues.length)
    + (counts.length === 0 ? '' : ' (' + counts.map(([layer, count]) => layer + '=' + String(count)).join(', ') + ')')
    + nl)

  if (judgement.blockers.length > 0) {
    out.stdout(nl + '!!! boot-blocking root cause detected — this environment cannot start:' + nl)
    for (const blocker of judgement.blockers) out.stdout('  - ' + blocker + nl)
  }
  if (judgement.verdict === 'incomplete') {
    out.stdout(nl + 'INCOMPLETE: 这次没能完成关键核对——issues=0 **不代表环境健康**。' + nl)
    for (const reason of judgement.incomplete) out.stdout('  - ' + reason + nl)
    for (const blocker of judgement.blockers) {
      if (!judgement.incomplete.some(reason => reason.includes(blocker))) out.stdout('  - 未提升为问题的根因：' + blocker + nl)
    }
    out.stdout('  （把根因提升为正式问题属于诊断引擎的事；CLI 只负责如实展示。）' + nl)
  }

  for (const issue of report.issues) {
    out.stdout(nl + '[' + issue.severity + '] ' + issue.code + ': ' + issue.title + nl)
    out.stdout('  ' + issue.detail + nl)
    for (const evidence of issue.evidence) out.stdout('  at ' + evidence.at + ' — ' + evidence.note + nl)
    if (issue.fix !== undefined) out.stdout('  fix: ' + issue.fix.action + ' — ' + issue.fix.summary + nl)
  }
  for (const skip of report.skipped) out.stdout(nl + 'skipped: ' + skip.check + ' — ' + skip.reason + nl)
  return judgement.code
}


/** uninstall-kind：删除一次 skill/预设直装（含预设归属清理）。 */
async function runUninstallKind(options: CliOptions, out: { stdout: (text: string) => void; stderr: (text: string) => void }): Promise<number> {
  const repo = options.args[0]
  if (repo === undefined || repo === '') {
    out.stderr('dshpmc uninstall-kind: an owner/repo reference is required' + String.fromCharCode(10))
    return 2
  }
  const records = await loadKindRecords()
  const wanted = sessionKey(repo)
  const match = [...records.entries()].find(([key, record]) =>
    sessionKey(key) === wanted || sessionKey(record.repo) === wanted)
  if (match === undefined) {
    out.stderr('dshpmc uninstall-kind: no companion install record for ' + JSON.stringify(repo)
      + '. Known records: ' + ([...records.keys()].join(', ') || '(none)') + String.fromCharCode(10))
    return 2
  }
  const [key, record] = match
  if (record.kind === 'cordis-plugin') {
    out.stderr('dshpmc uninstall-kind: ' + key + ' is a cordis plugin, not a skill or preset. '
      + 'Remove it through the official manager: plugin_manager { action: "remove_bundle", target: "'
      + (record.repo || key) + '" }, or run dshpmc remove <package> --profile ' + options.profile
      + String.fromCharCode(10))
    return 2
  }
  if (record.kind === 'agent-preset') {
    const stillElsewhere = await pluginInstalledInOtherEnvironments(options.profile, record.repo)
    const result = await cleanupOwnedPresets(undefined, record.repo, { stillInstalledElsewhere: stillElsewhere })
    out.stdout(formatCleanupResult(record.repo, result) + String.fromCharCode(10))
    if (result.removed.length === 0 && result.skipped.length > 0) return 1
  } else {
    const root = skillsRoot()
    if (record.dir !== '' && record.dir !== root) {
      await removeKindDir(root, record.dir)
      out.stdout('removed skill ' + record.dir + String.fromCharCode(10))
    } else {
      out.stdout('skill "' + record.repo + '" was installed as a collection; individual directories under '
        + root + ' were not removed automatically. Remove the ones you no longer need, then re-run.'
        + String.fromCharCode(10))
      return 1
    }
  }
  await removeKindRecord(key)
  out.stdout('forgot install record ' + key + String.fromCharCode(10))
  return 0
}

/**
 * CLI 主入口。
 *
 * @param argv - 参数（不含 node 与脚本路径；传 process.argv.slice(2)）。
 * @param deps - 可注入依赖（测试/宿主用）。
 * @returns 退出码。
 */
export async function main(argv: readonly string[], deps: CliDependencies = {}): Promise<number> {
  const stdout = deps.stdout ?? ((text: string) => { process.stdout.write(text) })
  const stderr = deps.stderr ?? ((text: string) => { process.stderr.write(text) })
  let options: CliOptions
  try {
    options = parseArgs(argv)
  } catch (error) {
    stderr('dshpmc: ' + (error instanceof Error ? error.message : String(error)) + String.fromCharCode(10))
    return 2
  }
  prepareHome(options)
  try {
    switch (options.command) {
      case 'help':
      case '--help':
        stdout(USAGE + String.fromCharCode(10))
        return 0
      case 'version':
        stdout(await readVersion() + String.fromCharCode(10))
        return 0
      case 'install': {
        const spec = options.args[0]
        if (spec === undefined || spec === '' || spec.startsWith('-')) {
          stderr('dshpmc install: a package spec is required' + String.fromCharCode(10))
          return 2
        }
        const code = await withInstallSession(async () => await runProtectedOperation(options, ['add', spec], deps, { stdout, stderr }))
        if (code === 0) {
          stdout('dshpmc: installed ' + spec + ' into profile ' + options.profile
            + ' (' + (isGitSource(spec) ? 'git source' : 'registry/local source') + ')' + String.fromCharCode(10))
        }
        return code
      }
      case 'remove': {
        const name = options.args[0]
        if (name === undefined || name === '' || name.startsWith('-')) {
          stderr('dshpmc remove: a package name is required' + String.fromCharCode(10))
          return 2
        }
        return await withInstallSession(async () => await runProtectedOperation(options, ['remove', name], deps, { stdout, stderr }))
      }
      case 'update': {
        const name = options.args[0]
        if (name === undefined || name === '' || name.startsWith('-')) {
          stderr('dshpmc update: a package name is required' + String.fromCharCode(10))
          return 2
        }
        // 与旧实现同一条语义：重写 specifier 到 @latest（dsh plugin add 不带版本号
        // 不会升级已声明的范围）。
        const spec = /@[^/]+$/.test(name) ? name : name + '@latest'
        return await withInstallSession(async () => await runProtectedOperation(options, ['add', spec], deps, { stdout, stderr }))
      }
      case 'mount':
        return await runMount(options, { stdout, stderr })
      case 'list':
        return await runList(options, { stdout })
      case 'analyze':
        return await runAnalyze(options, deps, { stdout, stderr })
      case 'uninstall-kind':
        return await runUninstallKind(options, { stdout, stderr })
      case 'block':
      case 'unblock': {
        const repo = options.args[0]
        if (repo === undefined || repo === '') {
          stderr('dshpmc ' + options.command + ': an owner/repo reference is required' + String.fromCharCode(10))
          return 2
        }
        if (options.command === 'block') {
          const key = await addBlockedRepo(repo)
          stdout('blocked ' + key + String.fromCharCode(10))
        } else {
          const { removeBlockedRepo } = await import('./kinds.ts')
          const removed = await removeBlockedRepo(repo)
          stdout((removed ? 'unblocked ' : 'not blocked: ') + repo + String.fromCharCode(10))
        }
        return 0
      }
      default:
        stderr('dshpmc: unknown command ' + JSON.stringify(options.command) + String.fromCharCode(10) + USAGE + String.fromCharCode(10))
        return 2
    }
  } catch (error) {
    stderr('dshpmc: ' + (error instanceof Error ? error.message : String(error)) + String.fromCharCode(10))
    return 1
  }
}

/** 读本包版本（bin 在 dist/ 下，package.json 在上一层）。 */
async function readVersion(): Promise<string> {
  try {
    const { readFile } = await import('node:fs/promises')
    const here = fileURLToPath(new URL('../package.json', import.meta.url))
    const manifest = JSON.parse(await readFile(here, 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * 作为 bin 直接运行时的入口。
 *
 * 只有在被当作可执行文件跑时才设退出码（被 import 时 main 是普通函数）。
 */
const invokedPath = process.argv[1]
if (invokedPath !== undefined && /(?:^|[\\/])cli\.(?:js|ts|mjs)$/.test(invokedPath)) {
  const code = await main(process.argv.slice(2))
  process.exitCode = code
}

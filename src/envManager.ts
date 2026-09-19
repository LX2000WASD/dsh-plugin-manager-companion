/**
 * 环境管理引擎 — 列出/启停/创建/重命名/删除本地 DSH 环境，跨环境写插件，备份导出/差异/恢复。
 *
 * 归属：A 类·重写（旧仓库 src/profiles.ts 与 src/index.ts 的 createProfile /
 *   renameProfile / removeProfile / copyPlugins / backupExport / backupDiff /
 *   backupRestore 仅作意图参考，未复制代码）。
 * 旧实现参考：旧 src/profiles.ts（进程扫描、终端窗口、端口探测的意图）、
 *   旧 src/index.ts:227-1210（环境生命周期与备份四分类差异的意图）。
 * 官方复用：@deepseek-ai/dsh-app-boot（initProfile / PROFILE_TEMPLATES /
 *   DEFAULT_PROFILE_BUNDLES / readProfileManifest / writeProfileBundles）、
 *   @deepseek-ai/dsh-plugin-manager/operations（runPluginCommand —— 跨环境 pnpm 通道）、
 *   @deepseek-ai/dsh-atomic-write（withFileLock）、./paths.ts（路径、manifest、互斥队列）、
 *   ./official.ts（当前环境事实）。
 * 前提检查：旧实现的三条前提都已消失或已证伪 ——
 *   1. 「必须自己拼 bundle 模板 / 自己调 pnpm」：官方 PROFILE_TEMPLATES 与
 *      runPluginCommand 已覆盖，本模块不写 bundle 清单、不调 pnpm 二进制；
 *   2. 「当前环境靠 argv 猜」（旧 issue #1）：官方 profileContext 是权威事实，
 *      本模块只读它，拿不到就如实报告「未知」；
 *   3. 「pkill -f 'dsh --profile' 收尾」：会误杀命令行里恰好出现同一字符串的无关
 *      进程。本模块只按 pid 精确 kill，且在 kill 前用 /proc（或 ps）复核该 pid
 *      的命令行仍属于同名环境。
 *
 * 同一套引擎、作用域可切换：当前环境的写操作走官方 pluginManager 服务，其它环境走
 * 官方 operations —— 差别只是传给 runPluginCommand 的 profile 参数，不是两套实现。
 */

import { execFileSync, spawn } from 'node:child_process'
import {
  accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync,
  rmSync, statSync,
} from 'node:fs'
import { request as httpRequest } from 'node:http'
import { connect, createServer } from 'node:net'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import {
  DEFAULT_PROFILE_BUNDLES, initProfile, PROFILE_TEMPLATES, readProfileManifest, resolveBundleDir, writeProfileBundles,
} from '@deepseek-ai/dsh-app-boot'
import type { PackageOperationContext, PackageOperationOptions } from '@deepseek-ai/dsh-plugin-manager/operations'
import type { PackageResult } from '@deepseek-ai/dsh-plugin-manager/types'
import { probeOfficialCapabilities, type OfficialCapabilities } from './official.ts'
import {
  OUR_PACKAGE_NAME, detectCurrentEnvironmentName, dshHome, enqueueMutation, environmentDir,
  isBuiltinEnvironment, isSafeEnvironmentName, profilesRoot, readEnvironmentManifest, sameEnvironment,
} from './paths.ts'
import type {
  BackupFormat, BackupMissingEntry, EnvironmentBackup, EnvironmentBackupDiff,
  EnvironmentInfo, EnvironmentResult, EnvironmentRun,
} from './types.ts'

// ── 常量 ──────────────────────────────────────────────────────────────────

/**
 * 进程扫描结果的缓存有效期。
 *
 * 一次页面加载会连续触发列表与详情，每次都做一次全表扫描（Windows 上是
 * powershell CIM 查询，可达数秒）。运行状态变化频率低，3s 内共享一份扫描对读
 * 路径不可感知；启停的判定用 scanRunsNow 拿即时事实。
 */
export const SCAN_RUNS_TTL_MS = 3_000

/** 启动后等待端口就绪的上限。官方 web 面冷启动要解析整棵插件树，给足 30s。 */
export const START_READY_TIMEOUT_MS = 30_000

/** 收到 SIGTERM 后等待进程退出的上限。 */
export const STOP_TIMEOUT_MS = 5_000

/** 自动选端口时的起点（官方 web 默认端口的上方）。 */
export const DEFAULT_WEB_PORT = 3090

/** 就绪轮询间隔。 */
const READY_POLL_MS = 250

/** 单次 HTTP 就绪探测的超时。 */
const READY_HTTP_TIMEOUT_MS = 2_000

/**
 * 官方 web 层的判定依据之一：提供 web 服务的那个官方包。
 *
 * 这是一个官方包名，不是我们的 bundle/模板名单（模板与层栈一律从官方
 * PROFILE_TEMPLATES 派生）。证据：packages/bundle/web-app/package.json 依赖
 * @deepseek-ai/dsh-host-webserver；官方另外四个 app bundle（base / headless /
 * acp-app / sdk-app / sdk-minimal）都没有这个依赖。
 */
const WEB_SERVER_PACKAGE = '@deepseek-ai/dsh-host-webserver'

/**
 * 视为「实例已应答」的 HTTP 状态。
 *
 * 官方 browser-auth：未授权回 401、带 token 的根请求回 303 换 cookie、已授权回 200。
 * 404 是「这条路由还没注册上」，不是就绪 —— 实测 TCP 刚可连接时 GET / 正是 404。
 */
const READY_HTTP_STATUSES: readonly number[] = [200, 303, 401]

/**
 * 创建环境时的默认模板名。
 *
 * 官方 DEFAULT_PROFILE_BUNDLES 只有 @deepseek-ai/dsh-base（官方语义：故意最小，没有
 * 任何 app），用它建出来的环境**必然没有 web 服务**：实测 startEnvironment 拉起后
 * 干等 30s 报 timeout。官方 PROFILE_TEMPLATES.web 才是「建一个能访问的环境」的语义。
 * 取名字时按官方键校验，官方常量里没有这个键就 fail loud（不悄悄退化成 base-only）。
 */
export const DEFAULT_ENVIRONMENT_TEMPLATE = 'web'

/** 官方 pnpm 通道的默认输出上限与锁等待上限（与官方 CLI 同量级）。 */
const OPERATION_OUTPUT_BYTES = 64 * 1024
const OPERATION_LOCK_WAIT_MS = 120_000

// ── 错误与结果 ────────────────────────────────────────────────────────────

/**
 * 环境操作的稳定错误码。取值同时出现在 EnvironmentResult.code 与
 * EnvironmentError.code 上，UI 依此做本地化与按钮分派。
 */
export type EnvironmentErrorCode =
  /** 环境名不合法（路径穿越、Windows 保留名等）。 */
  | 'invalid-name'
  /** 环境不存在。 */
  | 'not-found'
  /** 环境已存在。 */
  | 'already-exists'
  /** 官方内置环境（web/headless），只读。 */
  | 'builtin'
  /** 当前进程正在运行的环境，不可停止/删除/重命名。 */
  | 'current'
  /** 环境已有运行实例。 */
  | 'running'
  /** 环境没有运行实例。 */
  | 'not-running'
  /** 环境的层栈里没有任何能提供 web 服务的层，启动它不会有网页可访问。 */
  | 'no-web-layer'
  /** 调用方显式指定的端口已经被监听：不猜「应答来自谁」，直接拒绝、不发起启动。 */
  | 'port-in-use'
  /** 未知的 bundle 模板名。 */
  | 'unknown-template'
  /** 不是由 dsh 以 profile 方式启动，官方跨环境通道拿不到 installAnchor。 */
  | 'no-profile-context'
  /** 官方 @deepseek-ai/dsh-plugin-manager/operations 子路径不可用。 */
  | 'official-unavailable'
  /** 官方包操作返回非零退出码。 */
  | 'package-operation-failed'
  /** 启动失败（含没有可用终端且后台启动也失败）。 */
  | 'launch-failed'
  /** 端口在超时上限内没有就绪。 */
  | 'timeout'
  /** SIGTERM 后进程仍在。 */
  | 'kill-timeout'
  /** 备份文档结构不合法。 */
  | 'unsafe-backup'
  /** 备份中存在不可恢复的条目（本地路径来源已消失）。 */
  | 'unrestorable'
  /** 参数为空（例如没有选中任何插件）。 */
  | 'empty-selection'
  /** 文件系统操作失败。 */
  | 'io-failed'

/** 带稳定错误码的环境操作异常。 */
export class EnvironmentError extends Error {
  /**
   * @param code - 稳定错误码，见 EnvironmentErrorCode。
   * @param message - 面向用户的原因说明。
   */
  constructor(readonly code: EnvironmentErrorCode, message: string) {
    super(message)
    this.name = 'EnvironmentError'
  }
}

function failure(code: EnvironmentErrorCode, output: string): EnvironmentResult {
  return { ok: false, code, output }
}

function success(output: string): EnvironmentResult {
  return { ok: true, output }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ── 进程事实 ──────────────────────────────────────────────────────────────

/** 一行进程表：pid + 命令行原文。 */
interface ProcessLine {
  readonly pid: number
  readonly command: string
}

/** 一次解析结果：命令行确实属于某个环境实例。 */
interface ParsedRun {
  readonly name: string
  readonly port: number | null
}

/** 读进程表的注入点，供测试替换（生产路径见 defaultProcessLines）。 */
export type ProcessLineReader = () => readonly string[]

/** scanRuns 的选项。 */
export interface ScanRunsOptions {
  /** 缓存有效期；默认 SCAN_RUNS_TTL_MS。 */
  readonly ttlMs?: number
  /** 时钟注入（测试）。 */
  readonly now?: () => number
  /** 进程表读取器注入（测试）。默认按平台选择 /proc、ps 或 powershell。 */
  readonly reader?: ProcessLineReader
  /** 绕过缓存强制重新扫描。 */
  readonly fresh?: boolean
}

let runCache: { readonly at: number; readonly value: ReadonlyMap<string, readonly EnvironmentRun[]> } | null = null

/** 丢弃进程扫描缓存。启停成功后调用，让下一次读取立刻看到变化。 */
export function resetRunCache(): void {
  runCache = null
}

/**
 * 扫描进程表，找出每个环境的运行实例与端口（带缓存）。
 *
 * @param options - 缓存与注入选项。
 * @returns 环境名到运行实例列表的映射；未运行的环境不出现在 map 里。
 */
export function scanRuns(options: ScanRunsOptions = {}): ReadonlyMap<string, readonly EnvironmentRun[]> {
  const now = options.now?.() ?? Date.now()
  const ttl = options.ttlMs ?? SCAN_RUNS_TTL_MS
  if (options.fresh !== true && runCache !== null && now - runCache.at < ttl) return runCache.value
  const value = scanRunsNow(options)
  runCache = { at: now, value }
  return value
}

/**
 * 立即扫描进程表，不经缓存。
 *
 * 启停的就绪与存活判定必须看到即时变化，否则刚起的实例会被 3s 陈旧缓存判成
 * 「没起」，stop 也会对着一个已经退出的 pid 空转。调用方在状态变化后用
 * resetRunCache 让读路径跟上。
 *
 * @param options - 注入选项。
 * @returns 环境名到运行实例列表的映射。
 */
export function scanRunsNow(options: ScanRunsOptions = {}): Map<string, readonly EnvironmentRun[]> {
  const lines = (options.reader ?? defaultProcessLines)()
  const out = new Map<string, EnvironmentRun[]>()
  for (const line of parseProcessLines(lines)) {
    const run = parseRun(line)
    if (run === null) continue
    const entry: EnvironmentRun = { pid: line.pid, port: run.port, command: line.command }
    const list = out.get(run.name)
    if (list === undefined) out.set(run.name, [entry])
    else list.push(entry)
  }
  return out
}

/** 把进程表输出切成 pid + 命令行。 */
function parseProcessLines(lines: readonly string[]): ProcessLine[] {
  const out: ProcessLine[] = []
  for (const line of lines) {
    const match = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line)
    if (match === null) continue
    const pid = Number(match[1])
    const command = match[2] ?? ''
    if (Number.isInteger(pid) && pid > 0 && command.length > 0) out.push({ pid, command })
  }
  return out
}

/** 一次性诊断命令：命令行里出现这些就不是常驻实例。 */
const ONE_SHOT_FLAGS = new Set(['--help', '-h', '--version', '-v', '--dump-config'])

/**
 * 判定一个 argv 片段是否为 dsh 的启动入口。
 *
 * 两种真实形态（本机实测 + 官方 apps/cli/src/args.ts）：
 *   - PATH shim：/…/bin/dsh web …
 *   - 入口脚本：node /…/node_modules/@deepseek-ai/dsh/lib/bin.js web …
 *     （源码启动则是 …/deepseek-harness/apps/cli/src/bin.ts）
 * 入口形态必须先正确，任意 node /srv/app/bin.js web 不能被当成实例 —— 否则 stop
 * 会对着一个无关进程发 SIGTERM。
 *
 * @param token - 命令行中的一个片段。
 * @returns 是否像 dsh 入口。
 */
function isDshEntry(token: string): boolean {
  const normalized = token.split('\\').join('/')
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  if (/^dsh(?:\.(?:cmd|exe|ps1|sh))?$/i.test(base)) return true
  if (!/^bin\.(?:js|ts|cjs|mjs)$/i.test(base)) return false
  return /dsh|deepseek-harness/i.test(normalized)
}

/**
 * 从入口之后的参数里取环境名。
 *
 * --profile NAME 优先（官方显式形式）；否则取第一个确实是本机 profile 目录的
 * 位置参数（dsh web 缩写形式）。存在性检查同时挡住把其它 flag 的取值（如
 * --patch foo.yml）当成环境名。
 *
 * @param rest - 入口之后的参数。
 * @returns 环境名；判不出时 null。
 */
function profileNameOf(rest: readonly string[]): string | null {
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? ''
    if (token === '--profile') return rest[index + 1] ?? null
    if (token.startsWith('--profile=')) return token.slice('--profile='.length)
  }
  for (const token of rest) {
    if (token.startsWith('-')) continue
    if (!isSafeEnvironmentName(token)) continue
    if (existsSync(environmentDir(token))) return token
  }
  return null
}

/** 取 --port N / --port=N。 */
function portOf(tokens: readonly string[]): number | null {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? ''
    const inline = /^--port=(\d+)$/.exec(token)
    if (inline !== null) return Number(inline[1])
    if (token === '--port') {
      const value = tokens[index + 1] ?? ''
      if (/^\d+$/.test(value)) return Number(value)
    }
  }
  return null
}

/**
 * 解析一行进程表。
 *
 * @param line - pid 与命令行。
 * @returns 环境名与端口；不属于任何环境实例时 null。
 */
function parseRun(line: ProcessLine): ParsedRun | null {
  const tokens = line.command.split(/\s+/).filter((token) => token.length > 0)
  let entry = -1
  for (let index = 0; index < tokens.length; index += 1) {
    if (isDshEntry(tokens[index] ?? '')) { entry = index; break }
  }
  if (entry < 0) return null
  const rest = tokens.slice(entry + 1)
  // dsh plugin --profile X add … 是一次性包操作：把它当实例会让 stop 在 pnpm 写
  // manifest 的中途杀掉它。诊断类命令同理。
  if (rest[0] === 'plugin') return null
  for (const token of rest) if (ONE_SHOT_FLAGS.has(token)) return null
  const name = profileNameOf(rest)
  if (name === null || !isSafeEnvironmentName(name)) return null
  if (!existsSync(environmentDir(name))) return null
  return { name, port: portOf(rest) }
}

/** Linux 快速路径：直接读 /proc，省掉一次 fork+exec（旧仓库实测 14.5ms 降到 2.5ms）。 */
function procProcessLines(): string[] | null {
  let entries: string[]
  try {
    entries = readdirSync('/proc')
  } catch {
    return null
  }
  const lines: string[] = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    let raw: string
    try {
      raw = readFileSync('/proc/' + entry + '/cmdline', 'utf8')
    } catch {
      // 进程在扫描中退出（ENOENT）或不可读（EACCES）：ps 也看不到它。
      continue
    }
    if (raw.length === 0) continue
    lines.push(entry + '\t' + raw.split('\0').join(' ').trim())
  }
  return lines
}

/** POSIX 降级路径：ps -eo pid=,args=。 */
function psProcessLines(): string[] {
  try {
    return execFileSync('ps', ['-eo', 'pid=,args='], {
      encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
    }).split('\n')
  } catch {
    return []
  }
}

/** Windows 路径：powershell CIM 查询进程表。 */
function windowsProcessLines(): string[] {
  try {
    const script = [
      'Get-CimInstance Win32_Process',
      "| Where-Object { $_.CommandLine -and $_.CommandLine -match 'dsh' }",
      '| ForEach-Object { $_.ProcessId.ToString() + [char]9 + $_.CommandLine }',
    ].join(' ')
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    }).split(/\r?\n/)
  } catch {
    return []
  }
}

/**
 * 默认进程表读取器。
 *
 * Linux 优先 /proc；没有 /proc 的平台（macOS、受限容器）退到 ps；Windows 走
 * powershell。三条路产出的都是同一套 pid 加命令行文本，解析逻辑只有一份。
 *
 * @returns 进程表行。
 */
function defaultProcessLines(): readonly string[] {
  if (process.platform === 'win32') return windowsProcessLines()
  return procProcessLines() ?? psProcessLines()
}

/**
 * 读某个 pid 的命令行。
 *
 * kill 前的复核用它：pid 可能已被回收，必须重新证明它仍是同名环境的实例。读不
 * 到时返回 null —— 调用方必须据此放弃 kill，而不是照杀不误。
 *
 * @param pid - 目标进程。
 * @returns 命令行原文；不可读时为 null。
 */
export function readProcessCommand(pid: number): string | null {
  if (process.platform !== 'win32') {
    try {
      const raw = readFileSync('/proc/' + pid + '/cmdline', 'utf8')
      const joined = raw.split('\0').join(' ').trim()
      if (joined.length > 0) return joined
    } catch {
      // 没有 /proc 或进程已退出：下面用 ps 再试一次。
    }
    try {
      const out = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 })
      const line = out.trim()
      return line.length > 0 ? line : null
    } catch {
      return null
    }
  }
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-CimInstance Win32_Process -Filter "ProcessId=' + pid + '").CommandLine'], {
      encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    })
    const line = out.trim()
    return line.length > 0 ? line : null
  } catch {
    return null
  }
}

/**
 * 廉价存活探针：signal 0 只在进程消失时抛 ESRCH；EPERM 说明进程还在（别人持有）。
 *
 * @param pid - 目标进程。
 * @returns 是否存活。
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// ── 当前环境事实 ──────────────────────────────────────────────────────────

/** 需要「当前环境」事实的操作的共享选项。 */
export interface CurrentEnvironmentOptions {
  /** host 上下文：当前环境从 ctx.profileContext 读（权威事实）。 */
  readonly ctx?: Context
  /** 覆盖当前环境判定（测试注入）。 */
  readonly current?: string | null
  /** 覆盖官方能力探测（测试注入）。 */
  readonly capabilities?: OfficialCapabilities
}

/**
 * 当前正在运行的环境名。
 *
 * 官方事实优先：ctx.profileContext.name（dsh 以 profile 方式启动时存在）。没有
 * ctx 时退到 argv 解析 —— 拿不到就返回 null，调用方必须把它当「未知」，不做任何
 * 破坏性推断。
 *
 * @param ctx - host 上下文；省略时走 argv 兜底。
 * @param capabilities - 已探测的官方能力（避免重复探测）。
 * @returns 环境名；未知时 null。
 */
function currentEnvironmentName(ctx?: Context, capabilities?: OfficialCapabilities): string | null {
  if (capabilities !== undefined) return capabilities.environmentName
  if (ctx !== undefined) {
    try {
      return probeOfficialCapabilities(ctx).environmentName
    } catch {
      // 探针只读可选服务；宿主异常时报「未知」，不猜。
      return null
    }
  }
  return detectCurrentEnvironmentName()
}

/** 解析一次操作的「当前环境」。 */
function resolveCurrent(options: CurrentEnvironmentOptions): string | null {
  return options.current !== undefined
    ? options.current
    : currentEnvironmentName(options.ctx, options.capabilities)
}

/**
 * 当前环境名（UI 与其它模块复用）。
 *
 * @param ctx - host 上下文。
 * @returns 环境名；未知时 null。
 */
export function currentEnvironment(ctx?: Context): string | null {
  return currentEnvironmentName(ctx)
}

// ── 环境列表 ──────────────────────────────────────────────────────────────

/** listEnvironments 的选项。 */
export interface ListEnvironmentsOptions extends CurrentEnvironmentOptions {
  /** 复用的进程扫描结果；省略时走 scanRuns 的缓存扫描。 */
  readonly runs?: ReadonlyMap<string, readonly EnvironmentRun[]>
}

/**
 * 列出 $DSH_HOME/profiles 下的环境及其只读事实。
 *
 * @param ctx - host 上下文；用于取官方认定的「当前环境」。
 * @param options - 注入选项。
 * @returns 按名称排序的环境列表。
 */
export function listEnvironments(ctx?: Context, options: ListEnvironmentsOptions = {}): EnvironmentInfo[] {
  const current = options.current !== undefined
    ? options.current
    : currentEnvironmentName(ctx ?? options.ctx, options.capabilities)
  const runs = options.runs ?? scanRuns()
  const out: EnvironmentInfo[] = []
  let entries: string[]
  try {
    entries = readdirSync(profilesRoot())
  } catch {
    // profiles 根还不存在：没有环境，不是错误。
    return out
  }
  for (const name of entries) {
    // node_modules 是安装时的共享回退位置，不是环境。
    if (name === 'node_modules' || !isSafeEnvironmentName(name)) continue
    const dir = environmentDir(name)
    if (!isDirectory(dir)) continue
    if (!existsSync(join(dir, 'package.json'))) continue
    const manifest = readEnvironmentManifest(dir)
    out.push({
      name,
      dir,
      current: name === current,
      builtin: isBuiltinEnvironment(name),
      bundles: manifest.bundles,
      // 读不懂 manifest 时**不能**让调用方把空数组当事实：把未知按字段如实带出去。
      ...(manifest.unknownFields === undefined ? {} : {
        unknownFields: manifest.unknownFields,
        ...(manifest.unknownReason === undefined ? {} : { unknownReason: manifest.unknownReason }),
        // 层栈是界面上唯一直接渲染的派生字段，给它一个派生谓词（等价于 includes('bundles')）。
        bundlesKnown: !manifest.unknownFields.includes('bundles'),
      }),
      dependencies: manifest.dependencies,
      runs: runs.get(name) ?? [],
    })
  }
  return out.sort((left, right) => left.name.localeCompare(right.name))
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** 官方 bundle 模板（创建环境时可选），直接来自官方 PROFILE_TEMPLATES。 */
export interface EnvironmentTemplate {
  readonly name: string
  readonly bundles: readonly string[]
}

/**
 * 可用的环境模板。
 *
 * @returns 官方模板名与它们的 bundle 清单（本仓库不维护任何 bundle 名单）。
 */
export function environmentTemplates(): readonly EnvironmentTemplate[] {
  return Object.entries(PROFILE_TEMPLATES).map(([name, template]) => ({ name, bundles: [...template.bundles] }))
}

/**
 * 官方 web 模板相对官方默认层栈多出来的那几层 —— 也就是「能提供 web 面」的包。
 *
 * 派生自官方常量（PROFILE_TEMPLATES / DEFAULT_PROFILE_BUNDLES）：官方改了模板，
 * 这里跟着变，不需要改代码，也不需要我们维护一份会漂移的名字表。
 *
 * @returns 官方 web app 层的包名；官方常量里没有该模板时返回空数组。
 */
export function officialWebAppBundles(): readonly string[] {
  const template = PROFILE_TEMPLATES[DEFAULT_ENVIRONMENT_TEMPLATE]
  if (template === undefined) return []
  return template.bundles.filter((name) => !DEFAULT_PROFILE_BUNDLES.includes(name))
}

/** 一个环境的 web 层判定。 */
export type WebLayerPresence = 'present' | 'absent' | 'unknown'

/**
 * 判断一个环境的层栈里有没有能提供 web 服务的层。
 *
 * 两条官方事实，先静态后动态：
 *   1. 层名出现在官方 web 模板的 app 层里（官方常量派生，覆盖官方模板建的层栈）；
 *   2. 逐层用官方 resolveBundleDir 找到包目录、读它的 manifest：依赖或 peer 里出现
 *      WEB_SERVER_PACKAGE 的层就是 web 层（这条能认出官方模板之外的 web bundle）。
 *
 * 只有「每一层都能解析、且都不满足上面两条」才敢说 absent —— 任何一层的事实拿不到
 * 就返回 unknown，调用方据此降级为「无法预判，仍按就绪探测等待」，绝不预判成 absent
 * 去拒绝一个可能能跑的环境。
 *
 * @param dir - 环境目录。
 * @param bundles - 该环境的 bundle 层栈。
 * @param installAnchor - 官方安装锚点；省略时用该环境自己的 manifest 作解析锚点（官方第二锚点）。
 * @returns 判定结果。
 */
export function environmentWebLayer(
  dir: string, bundles: readonly string[], installAnchor?: string,
): WebLayerPresence {
  // 层栈读不出来（manifest 损坏）：没有任何可依据的事实。
  if (bundles.length === 0) return 'unknown'
  const webApps = officialWebAppBundles()
  if (bundles.some((name) => webApps.includes(name))) return 'present'
  const anchor = installAnchor ?? join(dir, 'package.json')
  let allResolved = true
  for (const name of bundles) {
    let bundleDir: string
    try {
      bundleDir = resolveBundleDir(OUR_PACKAGE_NAME, name, anchor, dir)
    } catch {
      // 这一层装没装、装的是什么都读不到：不能拿它当证据。
      allResolved = false
      continue
    }
    try {
      const manifest = readProfileManifest(OUR_PACKAGE_NAME, bundleDir) as {
        dependencies?: Record<string, unknown>
        peerDependencies?: Record<string, unknown>
      }
      const declared = { ...manifest.dependencies, ...manifest.peerDependencies }
      if (Object.keys(declared).includes(WEB_SERVER_PACKAGE)) return 'present'
    } catch {
      allResolved = false
    }
  }
  return allResolved ? 'absent' : 'unknown'
}

// ── 创建 / 重命名 / 删除 ──────────────────────────────────────────────────

/** Windows 保留设备名：这些名字当目录会在写入时报原始 EINVAL。 */
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

/**
 * 环境名的完整校验（含平台的额外约束）。
 *
 * @param name - 待校验的环境名。
 * @returns 拒绝原因；合法时为 null。
 */
export function environmentNameProblem(name: string): string | null {
  if (!isSafeEnvironmentName(name)) {
    return '环境名不合法：' + JSON.stringify(name) + '（只允许字母、数字、.、_、-，且不能是 . 或 ..）'
  }
  if (process.platform === 'win32') {
    const base = name.replace(/\.+$/, '')
    if (WINDOWS_RESERVED.test(base) || /[\s.]$/.test(name)) return name + ' 是 Windows 保留名，无法作为目录'
  }
  return null
}

/**
 * 创建一个环境（骨架由官方 initProfile 写：manifest、空 patch 层、pnpm 设置）。
 *
 * 模板只接受官方 PROFILE_TEMPLATES 的名字；不存在的模板名是配置错误，直接失败，
 * 而不是悄悄换成别的 bundle 列表。
 *
 * 省略模板时用 DEFAULT_ENVIRONMENT_TEMPLATE（官方 web 模板），**不是**官方
 * DEFAULT_PROFILE_BUNDLES：后者只有 base、没有任何 app，建出来的环境必然起不来
 * （实测 startEnvironment 干等 30s 超时）。
 *
 * @param name - 新环境名。
 * @param template - 官方模板名；省略时用官方 web 模板。
 * @returns 操作结果。
 */
export async function createEnvironment(name: string, template?: string): Promise<EnvironmentResult> {
  const problem = environmentNameProblem(name)
  if (problem !== null) return failure('invalid-name', problem)
  if (isBuiltinEnvironment(name)) return failure('builtin', name + ' 是官方内置环境，不能重新创建')
  const wanted = template === undefined || template.length === 0 ? DEFAULT_ENVIRONMENT_TEMPLATE : template
  const selected = PROFILE_TEMPLATES[wanted]
  if (selected === undefined) {
    return failure('unknown-template', '未知模板 ' + JSON.stringify(wanted) + '；可用模板：'
      + Object.keys(PROFILE_TEMPLATES).join(', '))
  }
  const bundles = [...selected.bundles]
  const dir = environmentDir(name)
  if (existsSync(join(dir, 'package.json'))) {
    return failure('already-exists', '环境已存在：' + name + '（' + dir + '）')
  }
  return enqueueMutation(async () => {
    if (existsSync(join(dir, 'package.json'))) {
      return failure('already-exists', '环境已存在：' + name + '（' + dir + '）')
    }
    try {
      // 官方两参签名（0.1.6 起去掉了 patchReload）；已存在的文件不会被覆盖。
      initProfile(dir, bundles)
    } catch (error) {
      return failure('io-failed', '创建环境失败 ' + name + '（' + dir + '）：' + messageOf(error))
    }
    return success('已创建环境 ' + name + '\n目录：' + dir + '\nbundle 层栈：\n  ' + bundles.join('\n  '))
  })
}

/** renameEnvironment 的选项。 */
export type RenameEnvironmentOptions = CurrentEnvironmentOptions

/**
 * 重命名一个环境目录。拒绝内置环境、当前环境与运行中的环境。
 *
 * @param from - 原名。
 * @param to - 新名。
 * @param options - 当前环境事实。
 * @returns 操作结果。
 */
export async function renameEnvironment(
  from: string, to: string, options: RenameEnvironmentOptions = {},
): Promise<EnvironmentResult> {
  for (const name of [from, to]) {
    const problem = environmentNameProblem(name)
    if (problem !== null) return failure('invalid-name', problem)
    if (isBuiltinEnvironment(name)) return failure('builtin', name + ' 是官方内置环境，不能重命名')
  }
  const sourceDir = environmentDir(from)
  const targetDir = environmentDir(to)
  if (!existsSync(join(sourceDir, 'package.json'))) return failure('not-found', '环境不存在：' + from)
  if (existsSync(targetDir)) return failure('already-exists', '目标环境已存在：' + to)
  const current = resolveCurrent(options)
  if (current === from || current === to) {
    return failure('current', current + ' 是当前正在运行的环境，不能重命名')
  }
  // 改名不可逆：不拿 3s 陈旧缓存当依据，用即时扫描。
  const busy = scanRuns({ fresh: true }).get(from)
  if (busy !== undefined && busy.length > 0) {
    return failure('running', from + ' 正在运行（pid ' + busy.map((run) => run.pid).join(', ') + '），请先停止再重命名')
  }
  return enqueueMutation(async () => {
    try {
      await retryFs(() => renameSync(sourceDir, targetDir))
    } catch (error) {
      return failure('io-failed', '重命名失败 ' + from + ' -> ' + to + '：' + messageOf(error))
    }
    resetRunCache()
    return success('已重命名 ' + from + ' -> ' + to)
  })
}

/** removeEnvironment 的选项。 */
export type RemoveEnvironmentOptions = CurrentEnvironmentOptions

/**
 * 删除一个环境目录。拒绝内置环境、当前环境与运行中的环境。
 *
 * @param name - 环境名。
 * @param options - 当前环境事实。
 * @returns 操作结果。
 */
export async function removeEnvironment(
  name: string, options: RemoveEnvironmentOptions = {},
): Promise<EnvironmentResult> {
  const problem = environmentNameProblem(name)
  if (problem !== null) return failure('invalid-name', problem)
  if (isBuiltinEnvironment(name)) return failure('builtin', name + ' 是官方内置环境，不能删除')
  const dir = environmentDir(name)
  if (!existsSync(dir)) return failure('not-found', '环境不存在：' + name)
  const current = resolveCurrent(options)
  // 用 sameEnvironment 而不是 ===：大小写不敏感的文件系统上（Windows/macOS）`WEB` 与 `web`
  // 是同一个目录，逐字比较会让护栏被非规范大小写绕过——那一步的后果是不可逆的。
  if (sameEnvironment(current, name)) {
    return failure('current', name + ' 是当前正在运行的环境，不能删除（要删请先停止本进程）')
  }
  // 删除不可逆：不拿 3s 陈旧缓存当依据，用即时扫描。
  const busy = scanRuns({ fresh: true }).get(name)
  if (busy !== undefined && busy.length > 0) {
    return failure('running', name + ' 正在运行（pid ' + busy.map((run) => run.pid).join(', ') + '），请先停止再删除')
  }
  return enqueueMutation(async () => {
    try {
      await retryFs(() => rmSync(dir, { recursive: true, force: true }))
    } catch (error) {
      return failure('io-failed', '删除失败 ' + name + '：' + messageOf(error))
    }
    resetRunCache()
    return success('已删除环境 ' + name)
  })
}

// ── 启停 ──────────────────────────────────────────────────────────────────

/** 一次启动的目标描述。 */
export interface LaunchSpec {
  readonly profile: string
  readonly port: number
  readonly mode: 'terminal' | 'background'
  /** 要执行的可执行文件。 */
  readonly command: string
  readonly args: readonly string[]
  /** dsh 入口脚本绝对路径；走 PATH shim 时为 null。 */
  readonly entry: string | null
  /** 环境目录。 */
  readonly dir: string
  /** 面向用户的等价命令行（原样展示，不执行）。 */
  readonly display: string
}

/** 启动结果。 */
export interface LaunchOutcome {
  readonly ok: boolean
  readonly detail: string
  /** 实际采用的启动方式；没有可用终端时会从 terminal 降级为 background。 */
  readonly mode: 'terminal' | 'background'
  /** 终端模式实际用的终端名。 */
  readonly terminal?: string
  /** 后台模式捕获官方输出到的日志路径（里面有官方打印的带 token 地址）。 */
  readonly logPath?: string
}

/** startEnvironment 的选项。 */
export interface StartEnvironmentOptions {
  /** 启动方式；terminal 在当前平台没有可用终端时自动降级为后台。 */
  readonly mode?: 'terminal' | 'background'
  /** 指定端口；省略时从 portStart 起找一个空闲端口。 */
  readonly port?: number
  /** 自动选端口的起点；默认 DEFAULT_WEB_PORT。 */
  readonly portStart?: number
  /** 就绪上限；默认 START_READY_TIMEOUT_MS。 */
  readonly readyTimeoutMs?: number
  /** 追加给被启动应用的参数。 */
  readonly extraArgs?: readonly string[]
  /** host 上下文：用于取官方 installAnchor 判定 web 层。 */
  readonly ctx?: Context
  /** installAnchor 覆盖；省略时取 ctx.profileContext.installAnchor，再退到该环境自己的 manifest。 */
  readonly installAnchor?: string
  /** 启动器注入（测试）：替换终端/后台启动。 */
  readonly launch?: (spec: LaunchSpec) => Promise<LaunchOutcome>
  /** HTTP 就绪探测注入（测试）：返回状态码；null 表示没有应答。 */
  readonly probe?: (port: number) => Promise<number | null>
  /** 时钟注入（测试）。 */
  readonly now?: () => number
  /** 等待注入（测试）。 */
  readonly sleep?: (ms: number) => Promise<void>
}

/**
 * 启动一个环境的实例。
 *
 * 四道关，越靠前越便宜：
 *   1. 环境存在、不在运行中；
 *   2. **web 层预检**：层栈里没有任何 web 服务层就立刻拒绝（实测 base-only 环境要干等
 *      30s 才超时，用户拿到的是「端口未就绪」这种没法行动的信息）；
 *   3. 选空闲端口，按 mode 在终端窗口或后台启动；
 *   4. 等**官方 HTTP 端点应答**（不是等 TCP 可连接 —— 实测 TCP 通了那一刻 GET / 还是
 *      404，1000ms 后才是 401，提前报成功会把不可用的 url 交出去）。
 *
 * @param name - 环境名。
 * @param options - 启动选项。
 * @returns 操作结果；成功时 output 含实际启动方式与可用地址（带 token，见 startedMessage）。
 */
export async function startEnvironment(
  name: string, options: StartEnvironmentOptions = {},
): Promise<EnvironmentResult> {
  const problem = environmentNameProblem(name)
  if (problem !== null) return failure('invalid-name', problem)
  const dir = environmentDir(name)
  if (!existsSync(join(dir, 'package.json'))) return failure('not-found', '环境不存在：' + name)
  const running = scanRuns().get(name)
  if (running !== undefined && running.length > 0) {
    const ports = running.map((run) => run.port).filter((port): port is number => port !== null)
    return failure('running', name + ' 已经在运行'
      + (ports.length > 0 ? '（端口 ' + ports.join(', ') + '）' : '（pid ' + running.map((run) => run.pid).join(', ') + '）')
      + '，请先停止它')
  }
  // 层栈事实来自该环境自己的 manifest；web 层判定见 environmentWebLayer。
  const layers = readEnvironmentManifest(dir).bundles
  const installAnchor = options.installAnchor ?? profileContextOf(options.ctx)?.installAnchor
  if (environmentWebLayer(dir, layers, installAnchor) === 'absent') {
    return failure('no-web-layer', noWebLayerMessage(name, layers))
  }
  const start = options.portStart ?? DEFAULT_WEB_PORT
  const port = options.port ?? await findFreePort(start)
  if (port === null) return failure('io-failed', '从 ' + String(start) + ' 起的 200 个端口内没有空闲端口')
  // 显式端口是调用方指定的：已经被监听就根本不该进入「等就绪」流程 —— HTTP 探针
  // 无法判断应答来自谁，会把别人的实例当成我们刚启动的那个报 ok。
  if (options.port !== undefined && await tcpListening(port)) {
    return failure('port-in-use', '端口 ' + String(port) + ' 已经被监听：无法确认它会由本次启动的实例接管，'
      + '所以不发起启动。请换一个端口，或先停掉占用它的进程。')
  }
  const spec = launchSpec(name, dir, port, options)
  const outcome = await (options.launch ?? defaultLaunch)(spec)
  if (!outcome.ok) return failure('launch-failed', outcome.detail)
  const status = await waitForReady(port, options)
  if (status === null) {
    return failure('timeout', startTimeoutMessage(name, port, spec, outcome, options))
  }
  // 新实例立刻可见：丢弃陈旧缓存。
  resetRunCache()
  return success(startedMessage(name, port, status, spec, outcome))
}

/**
 * 没有 web 层时的可操作拒绝文案。
 *
 * 两个可选动作都是用户能立刻执行的，且包名来自官方常量（officialWebAppBundles），
 * 不是我们抄的名字表。
 *
 * @param name - 环境名。
 * @param layers - 该环境当前的 bundle 层栈。
 * @returns 面向用户的说明。
 */
function noWebLayerMessage(name: string, layers: readonly string[]): string {
  const suggestion = officialWebAppBundles()
  return name + ' 的 bundle 层栈里没有任何能提供 web 服务的层，启动它不会得到可访问的网页。\n'
    + '当前层栈：' + (layers.length === 0 ? '（空）' : layers.join(', ')) + '\n'
    + '请二选一：\n'
    + '  1. 在官方插件页给它启用 web 层（'
    + (suggestion.length === 0 ? '官方 web 模板里的 app 层' : suggestion.join(', ')) + '）；\n'
    + '  2. 用官方 web 模板重建一个环境。\n'
    + '本次没有发起启动（不占用端口、不弹窗口）。'
}

/**
 * 启动成功文案：启动方式、可用地址、日志都如实说明。
 *
 * 关键：**不带 token 的地址不是可点开的入口**。官方 browser-auth 会 401，正文让用户
 * 「reopen the URL printed by dsh web」。所以只有从官方输出里读到带 token 的地址时才
 * 把它作为可用地址给出；否则明确告诉用户去哪里拿。
 *
 * @param name - 环境名。
 * @param port - 实例端口。
 * @param status - 就绪时的 HTTP 状态码。
 * @param spec - 启动描述。
 * @param outcome - 启动结果。
 * @returns 面向用户的多行说明。
 */
function startedMessage(
  name: string, port: number, status: number, spec: LaunchSpec, outcome: LaunchOutcome,
): string {
  const lines = ['已启动 ' + name
    + '（启动方式：' + (outcome.mode === 'terminal' ? '终端窗口 ' + (outcome.terminal ?? '') : '后台') + '）'
    + '　官方 HTTP 已应答：GET / -> ' + String(status)]
  const authenticated = outcome.logPath === undefined ? null : authenticatedUrlFromLog(outcome.logPath)
  if (authenticated !== null) {
    lines.push('可用地址：' + authenticated)
  } else {
    lines.push('注意：http://127.0.0.1:' + String(port) + '/ 不带 token 会被官方 browser-auth 拒绝（401）。')
    lines.push(outcome.mode === 'terminal'
      ? '可用地址只在刚打开的终端窗口里由 dsh 打印（形如 dsh web: http://127.0.0.1:' + String(port) + '/?token=...），请从那里复制。'
      : '官方输出里没有读到带 token 的地址，请查看日志。')
  }
  if (outcome.logPath !== undefined) lines.push('日志：' + outcome.logPath)
  lines.push('命令：' + spec.display)
  return lines.join('\n')
}

/**
 * 启动超时文案：带上官方输出的尾巴。
 *
 * 不再是「请看启动窗口的输出」——终端模式下等于把用户推到看不见的窗口，后台模式下
 * 更没有窗口可看。日志尾巴是我们手上最具体的事实。
 *
 * @param name - 环境名。
 * @param port - 实例端口。
 * @param spec - 启动描述。
 * @param outcome - 启动结果。
 * @param options - 启动选项（取超时上限）。
 * @returns 面向用户的多行说明。
 */
function startTimeoutMessage(
  name: string, port: number, spec: LaunchSpec, outcome: LaunchOutcome, options: StartEnvironmentOptions,
): string {
  const lines = [name + ' 已启动，但 ' + String(options.readyTimeoutMs ?? START_READY_TIMEOUT_MS)
    + 'ms 内端口 ' + String(port) + ' 没有给出官方 web 应答（GET / 需要返回 200/303/401；404 不算就绪）。']
  if (outcome.logPath === undefined) {
    lines.push('请看刚打开的终端窗口里 dsh 的输出。')
  } else {
    const tail = tailOfLog(outcome.logPath, 20)
    lines.push('日志：' + outcome.logPath)
    lines.push(tail.length === 0 ? '（日志还是空的）' : tail.join('\n'))
  }
  lines.push('命令：' + spec.display)
  return lines.join('\n')
}

/** 组装一次启动：入口、参数与展示用命令行。 */
function launchSpec(name: string, dir: string, port: number, options: StartEnvironmentOptions): LaunchSpec {
  const entryPoint = dshEntryPoint()
  const args = [...entryPoint.args, '--profile', name, '--port', String(port), ...options.extraArgs ?? []]
  return {
    profile: name,
    port,
    mode: options.mode ?? 'terminal',
    command: entryPoint.command,
    args,
    entry: entryPoint.entry,
    dir,
    display: [entryPoint.command, ...args].join(' '),
  }
}

/**
 * 被启动实例的入口。
 *
 * 优先复用本进程自己所属的安装：process.argv[1] 就是当前 dsh 的入口脚本，node 是
 * process.execPath —— 同一个安装、同一个版本，不依赖 PATH（旧实现靠 PATH 找 dsh，
 * 在 nvm 未加载的终端里会失败）。
 *
 * @returns 命令、前置参数与入口脚本路径。
 */
function dshEntryPoint(): { command: string; args: readonly string[]; entry: string | null } {
  const entry = process.argv[1]
  if (entry !== undefined && /(?:^|[\\/])bin\.(?:js|cjs|mjs)$/.test(entry)
    && /[\\/]@deepseek-ai[\\/]dsh(?:[\\/]|$)/.test(entry)) {
    return { command: process.execPath, args: [entry], entry }
  }
  return { command: process.platform === 'win32' ? 'dsh.cmd' : 'dsh', args: [], entry: null }
}

/**
 * 等到官方 HTTP 端点应答为止。
 *
 * 判据只有一条：GET / 返回 READY_HTTP_STATUSES 里的状态。
 *
 * 为什么不看「TCP 可连接」——现场证据（本机实测，官方 web 模板环境）：
 *   首个 HTTP 应答 628ms，状态码 404（连接已通、路由还没注册）；
 *   首个官方就绪应答 838ms，状态码 401；
 *   404 窗口约 210ms：这 210ms 里 TCP 判据会报 ok，并把一个 404 的地址交给用户。
 * 就绪报出的时刻由实例决定，判据本身不拖慢启动：同一台机器上单次探测 0.6ms 拿到 401。
 *
 * @param port - 实例端口。
 * @param options - 启动选项（注入探测/时钟/等待与超时上限）。
 * @returns 就绪时的状态码；超时返回 null。
 */
async function waitForReady(port: number, options: StartEnvironmentOptions): Promise<number | null> {
  const probe = options.probe ?? httpStatus
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => { setTimeout(done, ms) }))
  const deadline = now() + (options.readyTimeoutMs ?? START_READY_TIMEOUT_MS)
  for (;;) {
    const status = await probe(port)
    if (status !== null && READY_HTTP_STATUSES.includes(status)) return status
    const left = deadline - now()
    if (left <= 0) return null
    await sleep(Math.min(READY_POLL_MS, left))
  }
}

/**
 * 对 GET / 发一次真实 HTTP 请求，返回状态码。
 *
 * 用 node:http 直接请求，不起探测服务、不跟随重定向（303 本身就是「已就绪」的证据）。
 *
 * @param port - 实例端口。
 * @returns 状态码；没有应答（连接被拒、超时）时 null。
 */
function httpStatus(port: number): Promise<number | null> {
  return new Promise((done) => {
    const request = httpRequest(
      { host: '127.0.0.1', port, path: '/', method: 'GET', timeout: READY_HTTP_TIMEOUT_MS },
      (response) => {
        const status = response.statusCode ?? null
        response.resume()
        done(status)
      },
    )
    // 被防火墙静默丢弃的连接会让 promise 永远不落地，就绪循环要给它上限。
    request.once('timeout', () => { request.destroy(); done(null) })
    request.once('error', () => done(null))
    request.end()
  })
}

/**
 * 端口是否已经被监听。
 *
 * 只在调用方显式指定端口时用于启动前的归属检查：TCP 一连上就说明有人占着它。
 * 这里刻意不做 HTTP 判断 —— 要回答的是「这个端口是不是空的」，不是「它是否已可用」。
 *
 * @param port - 目标端口。
 * @returns 已被监听时 true。
 */
function tcpListening(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect(port, '127.0.0.1')
    const settle = (listening: boolean): void => { socket.destroy(); done(listening) }
    // 防火墙静默丢弃的 SYN 会让 promise 永远不落地，给这次归属检查一个上限。
    socket.setTimeout(1_000, () => settle(false))
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
  })
}

/**
 * 后台启动的日志路径。
 *
 * 与官方 operations 的日志同构（<环境>/.plugin-manager/logs/...），放在环境目录里
 * 而不是 /tmp：环境删了日志跟着走，用户找得到。
 *
 * @param dir - 环境目录。
 * @param kind - 日志类别（start）。
 * @returns 日志文件的绝对路径。
 */
function operationLogPath(dir: string, kind: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return join(dir, '.plugin-manager', 'logs', kind + '-' + stamp + '.log')
}

/**
 * 从官方启动输出里取带 token 的可用地址。
 *
 * 官方 web-app 在 Loader 落定后打印 dsh web: http://127.0.0.1:<port>/?token=<token>，
 * 那是官方的就绪信号，token 就是本实例的入口凭据。后台模式这份输出由我们持有，所以
 * 能把真正点得开的地址交给用户；终端模式输出在窗口里，我们不去截它。
 *
 * 只取回环地址：官方同时会打印 LAN 地址，跨机地址不该出现在本机页面上。
 *
 * @param logPath - 捕获到的官方输出。
 * @returns 带 token 的回环地址；没读到 null。
 */
function authenticatedUrlFromLog(logPath: string): string | null {
  try {
    const text = readFileSync(logPath, 'utf8')
    const match = /https?:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/.exec(text)
    return match === null ? null : match[0]
  } catch {
    return null
  }
}

/**
 * 读日志尾部若干行，给失败文案用。
 *
 * 单行截断、总量截断：启动日志里可能有很长的堆栈，REST 响应不该被它撑爆。
 *
 * @param logPath - 日志文件。
 * @param lines - 取最后多少行。
 * @returns 尾部行；读不到时空数组。
 */
function tailOfLog(logPath: string, lines: number): string[] {
  try {
    const text = readFileSync(logPath, 'utf8')
    return text.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-lines)
      .map((line) => (line.length > 500 ? line.slice(0, 500) + '…' : line))
      // token 只允许出现在那份 0600 日志与 startEnvironment 的成功返回里：
      // 失败文案里的日志尾巴必须脱敏。
      .map((line) => line.replace(/token=[A-Za-z0-9_-]+/g, 'token=***'))
  } catch {
    return []
  }
}

/**
 * 后台启动用的参数：补 --no-open。
 *
 * 后台模式没有终端窗口可看，官方默认行为会在那台机器的桌面上弹出浏览器（实测弹过）。
 * 带 token 的地址我们交给用户在页面上自己点。
 *
 * @param spec - 启动描述。
 * @returns 加了 --no-open 的启动描述（已有则原样返回）。
 */
function backgroundSpec(spec: LaunchSpec): LaunchSpec {
  if (spec.args.includes('--no-open')) return spec
  const args = [...spec.args, '--no-open']
  return { ...spec, args, display: [spec.command, ...args].join(' ') }
}

/** 从 start 起找一个空闲端口。 */
async function findFreePort(start: number, span = 200): Promise<number | null> {
  for (let port = start; port < start + span; port += 1) {
    const free = await new Promise<boolean>((done) => {
      const server = createServer()
      server.once('error', () => done(false))
      server.listen(port, '127.0.0.1', () => server.close(() => done(true)))
    })
    if (free) return port
  }
  return null
}

/**
 * 默认启动器：终端窗口优先，没有可用终端就降级为后台。
 *
 * @param spec - 启动描述。
 * @returns 启动结果；mode 字段如实反映**实际**采用的启动方式。
 */
async function defaultLaunch(spec: LaunchSpec): Promise<LaunchOutcome> {
  if (spec.mode === 'terminal') {
    const terminal = openInTerminal(spec)
    if (terminal !== null) {
      return {
        ok: true, mode: 'terminal', terminal,
        detail: '已在 ' + terminal + ' 终端窗口中启动 —— 关闭该窗口即停止实例',
      }
    }
    return await spawnBackground(backgroundSpec(spec), '没有可用终端，已降级为后台启动')
  }
  return await spawnBackground(backgroundSpec(spec))
}

/**
 * 后台启动（detached + unref）。
 *
 * 官方输出重定向到环境目录下的日志：不是管道，而是把文件描述符 dup 给子进程 ——
 * 宿主进程退出后实例照旧写自己的日志，不会因为管道断开收到 EPIPE。日志里同时有官方
 * 打印的带 token 地址，所以后台模式能给出真正点得开的 URL。
 *
 * @param spec - 启动描述。
 * @param note - 附加说明（降级原因）。
 * @returns 启动结果。
 */
async function spawnBackground(spec: LaunchSpec, note?: string): Promise<LaunchOutcome> {
  const logPath = operationLogPath(spec.dir, 'start')
  let failure: string | null = null
  try {
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 })
    const fd = openSync(logPath, 'a', 0o600)
    try {
      const child = spawn(spec.command, [...spec.args], {
        cwd: process.cwd(), detached: true, stdio: ['ignore', fd, fd], windowsHide: true,
      })
      await new Promise<void>((settle) => {
        const timer = setTimeout(settle, 500)
        timer.unref()
        child.once('spawn', () => { clearTimeout(timer); settle() })
        child.once('error', (error) => { failure = messageOf(error); clearTimeout(timer); settle() })
      })
      child.unref()
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    failure = messageOf(error)
  }
  if (failure !== null) {
    return { ok: false, mode: 'background', logPath, detail: '无法启动：' + failure + '（命令：' + spec.display + '）' }
  }
  return {
    ok: true, mode: 'background', logPath,
    detail: '已在后台启动' + (note === undefined ? '' : '（' + note + '）'),
  }
}

/**
 * 在可见终端窗口里启动。
 *
 * 窗口让实例一直在用户眼前（关掉窗口就停掉实例），也是旧实现里用户最认可的交互。
 * POSIX 下优先切到 $TERMINAL。找不到终端返回 null，由调用方降级到后台。
 *
 * @param spec - 启动描述。
 * @returns 终端名；没有可用终端时 null。
 */
function openInTerminal(spec: LaunchSpec): string | null {
  const line = shellLine(spec)
  if (process.platform === 'darwin') {
    try {
      spawn('osascript', ['-e', 'tell application "Terminal" to do script "' + line.split('"').join('\\"') + '"'],
        { stdio: 'ignore' }).unref()
      return 'Terminal.app'
    } catch {
      return null
    }
  }
  if (process.platform === 'win32') {
    try {
      spawn('cmd', ['/c', 'start', '', 'cmd', '/k', spec.display], { stdio: 'ignore', windowsHide: true }).unref()
      return 'cmd'
    } catch {
      return null
    }
  }
  const configured = process.env.TERMINAL?.trim() ?? ''
  const candidates = [
    ...configured.length > 0 ? [configured.split(/\s+/)[0] ?? ''] : [],
    'x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm', 'kitty', 'alacritty', 'wezterm',
  ]
  for (const candidate of candidates) {
    if (candidate.length === 0) continue
    const resolved = whichSync(candidate)
    if (resolved === null) continue
    try {
      spawn(resolved, terminalArgv(basename(resolved), line), { stdio: 'ignore', windowsHide: true }).unref()
      return basename(resolved)
    } catch {
      // 换下一个模拟器。
    }
  }
  return null
}

/** 终端模拟器各自的「执行一条命令并保留窗口」参数。 */
function terminalArgv(bin: string, line: string): string[] {
  const body = ['bash', '-c', line + '; echo; read -r -p "Press Enter to close..."']
  switch (bin) {
    case 'gnome-terminal': return ['--', ...body]
    case 'wezterm': return ['start', '--', ...body]
    case 'konsole':
    case 'x-terminal-emulator':
    case 'xterm':
    case 'alacritty': return ['-e', ...body]
    default: return body
  }
}

/**
 * 终端里的命令行：把 node 与 dsh 所在目录前置到 PATH。
 *
 * 新开的终端可能没加载 nvm（node/dsh 找不到），也可能没有 pnpm —— 而环境里的官方
 * 插件管理器要调 pnpm。这里只保证我们已经知道的两个目录在前。
 *
 * @param spec - 启动描述。
 * @returns 可直接交给 shell 的一行命令。
 */
function shellLine(spec: LaunchSpec): string {
  const dirs = [dirname(process.execPath)]
  if (spec.entry !== null) dirs.push(dirname(spec.entry))
  const unique = [...new Set(dirs)]
  const path = unique.join(delimiter) + delimiter + '$PATH'
  return 'export PATH=' + JSON.stringify(path) + '; ' + [spec.command, ...spec.args].map(shellQuote).join(' ')
}

function shellQuote(part: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(part) ? part : JSON.stringify(part)
}

/** 在 PATH 里找一个可执行文件。 */
function whichSync(bin: string): string | null {
  if (bin.includes('/') || bin.includes('\\')) {
    try {
      accessSync(bin, constants.X_OK)
      return bin
    } catch {
      return null
    }
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir.length === 0) continue
    const candidate = join(dir, bin)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // 继续找下一个目录。
    }
  }
  return null
}

/** stopEnvironment 的选项。 */
export interface StopEnvironmentOptions extends CurrentEnvironmentOptions {
  /** 等待退出的上限；默认 STOP_TIMEOUT_MS。 */
  readonly timeoutMs?: number
  /** 注入时钟（测试）。 */
  readonly now?: () => number
  /** 注入等待（测试）。 */
  readonly sleep?: (ms: number) => Promise<void>
}

/**
 * 停止一个环境的实例 —— 只按 pid 精确 kill。
 *
 * 绝不 pkill -f "dsh --profile NAME"：那会连带杀掉命令行里恰好出现同一字符串的
 * 无关进程，也会杀掉同名的 pnpm 与一次性命令。这里的流程是：扫描，取同名环境的
 * pid，逐个用 readProcessCommand 复核该 pid 仍然是同一环境的实例，SIGTERM，轮询
 * 存活。
 *
 * @param name - 环境名。
 * @param options - 停止选项。
 * @returns 操作结果。
 */
export async function stopEnvironment(
  name: string, options: StopEnvironmentOptions = {},
): Promise<EnvironmentResult> {
  const problem = environmentNameProblem(name)
  if (problem !== null) return failure('invalid-name', problem)
  const dir = environmentDir(name)
  if (!existsSync(dir)) return failure('not-found', '环境不存在：' + name)
  const current = resolveCurrent(options)
  // 同上：这里是"别把自己杀掉"的护栏，被绕过等于杀死正在服务本页面的进程。
  if (sameEnvironment(current, name)) {
    return failure('current', name + ' 是当前正在运行的环境：在这里停止它等于结束本进程，请在它的终端里停止')
  }
  // 缓存先看（Windows 全表扫描可达数秒）；缓存里没有时用即时扫描复核一次，免得把
  // 刚起来的实例判成没起、或把刚停的实例当成还在跑。
  let runs = scanRuns().get(name) ?? []
  if (runs.length === 0) runs = scanRunsNow().get(name) ?? []
  if (runs.length === 0) return failure('not-running', name + ' 没有运行中的实例')

  const killed: number[] = []
  const skipped: string[] = []
  for (const run of runs) {
    if (run.pid === process.pid || run.pid === process.ppid) {
      skipped.push('pid ' + String(run.pid) + '（本进程/父进程）')
      continue
    }
    const command = readProcessCommand(run.pid)
    if (command === null) {
      skipped.push('pid ' + String(run.pid) + '（已退出）')
      continue
    }
    const parsed = parseRun({ pid: run.pid, command })
    if (parsed === null || parsed.name !== name) {
      skipped.push('pid ' + String(run.pid) + '（命令行已不属于 ' + name + '，拒绝 kill）')
      continue
    }
    try {
      process.kill(run.pid, 'SIGTERM')
      killed.push(run.pid)
    } catch (error) {
      skipped.push('pid ' + String(run.pid) + '（' + messageOf(error) + '）')
    }
  }
  if (killed.length === 0) {
    resetRunCache()
    return skipped.length > 0
      ? failure('not-running', name + ' 没有可停止的实例：' + skipped.join('；'))
      : failure('not-running', name + ' 没有运行中的实例')
  }
  const stillAlive = await waitForExit(killed, options)
  resetRunCache()
  const lines = ['已停止 ' + name + '（pid ' + killed.join(', ') + '）']
  if (skipped.length > 0) lines.push('未处理：' + skipped.join('；'))
  if (stillAlive.length > 0) {
    lines.push('仍在运行：pid ' + stillAlive.join(', ') + '（已发 SIGTERM，'
      + String(options.timeoutMs ?? STOP_TIMEOUT_MS) + 'ms 内未退出）')
    return failure('kill-timeout', lines.join('\n'))
  }
  return success(lines.join('\n'))
}

/**
 * 轮询等待进程退出。
 *
 * @param pids - 已收到 SIGTERM 的进程。
 * @param options - 时钟与上限。
 * @returns 仍在运行的 pid。
 */
async function waitForExit(pids: readonly number[], options: StopEnvironmentOptions): Promise<number[]> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => { setTimeout(done, ms) }))
  const deadline = now() + (options.timeoutMs ?? STOP_TIMEOUT_MS)
  for (;;) {
    const alive = pids.filter((pid) => pidAlive(pid))
    if (alive.length === 0) return []
    const left = deadline - now()
    if (left <= 0) return alive
    await sleep(Math.min(200, left))
  }
}

// ── 跨环境写路径（官方 operations，按 profile 参数化）──────────────────────

/** 官方包操作运行器。默认动态 import 官方子路径；测试可注入。 */
export type PluginCommandRunner = (
  context: PackageOperationContext, args: readonly string[], options: PackageOperationOptions,
) => Promise<PackageResult>

/** 跨环境写操作的共享选项。 */
export interface CrossEnvironmentOptions {
  /** host 上下文：installAnchor 从 ctx.profileContext 取。 */
  readonly ctx?: Context
  /** installAnchor 覆盖（测试，或应用自有 profile）。官方事实拿不到时必须显式给出。 */
  readonly installAnchor?: string
  /** 官方 operations 运行器覆盖（测试注入，避免真的跑 pnpm）。 */
  readonly runCommand?: PluginCommandRunner
  /** 输出回调（逐块）。 */
  readonly onOutput?: (text: string, stream: 'stdout' | 'stderr') => void
  /** 输出上限；默认 64KiB。 */
  readonly outputBytes?: number
  /** 官方 operations 的锁等待上限；默认 120s。 */
  readonly lockWaitMs?: number
}

/** profileContext 里本模块需要的字段。 */
interface ProfileContextLike {
  readonly name?: string
  readonly installAnchor?: string
  readonly cwd?: string
  readonly home?: string
}

function profileContextOf(ctx?: Context): ProfileContextLike | undefined {
  if (ctx === undefined) return undefined
  return ctx.get('profileContext') as ProfileContextLike | undefined
}

/**
 * 组装官方 operations 的调用参数。
 *
 * installAnchor 只认官方事实（ctx.profileContext.installAnchor，或调用方显式覆盖）。
 * 拿不到就抛确定性错误 —— 猜一个路径去写别人的环境是数据损坏级别的错误，宁可拒绝。
 *
 * @param profile - 目标环境名。
 * @param dir - 目标环境目录。
 * @param cwd - 相对 spec 的锚点目录。
 * @param options - 共享选项。
 * @returns 官方 operations 的 context。
 * @throws {EnvironmentError} installAnchor 不可得时（code 为 no-profile-context）。
 */
function operationContext(
  profile: string, dir: string, cwd: string, options: CrossEnvironmentOptions,
): PackageOperationContext {
  const context = profileContextOf(options.ctx)
  const installAnchor = options.installAnchor ?? context?.installAnchor
  if (installAnchor === undefined || installAnchor.length === 0) {
    throw new EnvironmentError('no-profile-context', '拿不到官方 installAnchor（ctx.profileContext.installAnchor）：'
      + '当前进程不是由 dsh 以 profile 方式启动的，跨环境包操作无法定位安装锚点。拒绝猜测路径。')
  }
  return {
    profile,
    dir,
    installAnchor,
    cwd,
    home: context?.home ?? dshHome(),
  }
}

/**
 * 取官方 operations 模块。
 *
 * @param options - 共享选项（可注入运行器）。
 * @returns 运行器。
 * @throws {EnvironmentError} 官方子路径不可用时（code 为 official-unavailable），不静默降级。
 */
async function officialRunner(options: CrossEnvironmentOptions): Promise<PluginCommandRunner> {
  if (options.runCommand !== undefined) return options.runCommand
  try {
    const module = await import('@deepseek-ai/dsh-plugin-manager/operations')
    return module.runPluginCommand as PluginCommandRunner
  } catch (error) {
    throw new EnvironmentError('official-unavailable',
      '官方 @deepseek-ai/dsh-plugin-manager/operations 不可用：' + messageOf(error))
  }
}

/**
 * 运行一次官方包操作。
 *
 * @param runner - 官方运行器。
 * @param context - profile 参数化的调用参数。
 * @param args - pnpm 参数。
 * @param options - 共享选项。
 * @returns 官方结果。
 */
async function runPackageOperation(
  runner: PluginCommandRunner, context: PackageOperationContext, args: readonly string[],
  options: CrossEnvironmentOptions,
): Promise<PackageResult> {
  return runner(context, args, {
    // 服务侧调用：官方会剥掉环境里的凭据并捕获输出（而不是把终端交给 pnpm）。
    execution: 'service',
    outputBytes: options.outputBytes ?? OPERATION_OUTPUT_BYTES,
    lockWaitMs: options.lockWaitMs ?? OPERATION_LOCK_WAIT_MS,
    ...options.onOutput === undefined ? {} : { onOutput: options.onOutput },
  })
}

/**
 * 修复安装：把当前 profile **已声明**的依赖真正装进 node_modules。
 *
 * 为什么不能走 add：官方 inspect 把「已声明」当作「已安装」（already-installed 是官方
 * PluginInspectProblem 闭集里的取值），于是对「声明了但没装」的包走 add 必被拒绝，
 * 修复输出「拒绝安装：already-installed」——与诊断结论直接矛盾，用户点多少次都不会成功
 * （write-auditor 真机验证发现，见 docs/private/write-path-audit.md §3·P3）。
 *
 * 官方 `dsh plugin --profile X install` 就是把参数转发给 pnpm 的官方通道（apps/cli/src/plugin.ts
 * 也走同一个 runPluginCommand），修复安装用它。
 *
 * @param target - 包名（只用于文案；官方 install 按 package.json 全量收敛）。
 * @param options - 共享选项。
 * @returns 结果；官方通道不可用或 pnpm 非零退出时如实报失败，不静默降级。
 */
export async function repairDependencies(
  target: string, options: CrossEnvironmentOptions = {},
): Promise<EnvironmentResult> {
  const context = profileContextOf(options.ctx)
  const profile = context?.name
  if (profile === undefined || profile.length === 0) {
    return failure('no-profile-context', '拿不到当前环境名（ctx.profileContext.name），无法修复安装')
  }
  const dir = environmentDir(profile)
  if (!existsSync(join(dir, 'package.json'))) return failure('not-found', '环境不存在：' + profile)
  try {
    const runner = await officialRunner(options)
    const result = await runPackageOperation(
      runner, operationContext(profile, dir, context?.cwd ?? dir, options), ['install'], options,
    )
    if (result.exitCode !== 0) {
      const tail = result.output.trim().split(/\r?\n/).filter((line) => line.length > 0).slice(-8).join('\n')
      return failure('package-operation-failed',
        '修复安装失败（官方 install 退出码 ' + String(result.exitCode) + '）：' + (tail === '' ? result.output.slice(-600) : '\n' + tail))
    }
    return success('已修复安装 ' + target + '（官方 install 通道，环境 ' + profile + '）')
  } catch (error) {
    if (error instanceof EnvironmentError) return failure(error.code, messageOf(error))
    return failure('io-failed', messageOf(error))
  }
}

/** 已解析的安装来源。 */
interface ResolvedSpec {
  /** 交给 pnpm 的 spec。 */
  readonly spec: string
  /** 本地路径来源时解析出的绝对路径；非本地来源为 null。 */
  readonly localPath: string | null
}

/** 拆出 link: / file: / 相对 / 绝对路径这类本地来源。 */
function localTarget(spec: string): { prefix: string; path: string } | null {
  const match = /^(?<prefix>link:|file:)?(?<path>\.{1,2}(?:[\\/].*)?|[\\/].*|[A-Za-z]:[\\/].*)$/.exec(spec)
  const groups = match?.groups
  if (groups?.path === undefined) return null
  return { prefix: groups.prefix ?? '', path: groups.path }
}

/**
 * 把 package.json 里记录的 spec 解析成可以在别处重装的 spec。
 *
 * 本地来源（link:/file:/相对/绝对路径）在 package.json 里是相对本环境目录记录的；
 * 跨环境重装必须解析成绝对路径，否则会指向新环境的邻居目录。本地路径已经不存在时
 * 返回 null —— 那是「不可恢复」，不是「缺失」。
 *
 * @param spec - manifest 里记录的依赖值。
 * @param baseDir - 记录该 spec 的环境目录。
 * @returns 解析结果；本地来源已消失时 null。
 */
function resolveInstallSpec(spec: string, baseDir: string): ResolvedSpec | null {
  const local = localTarget(spec)
  if (local === null) return { spec, localPath: null }
  const absolute = isAbsolute(local.path) ? local.path : resolve(baseDir, local.path)
  if (!existsSync(absolute)) return null
  return { spec: local.prefix + absolute, localPath: absolute }
}

/**
 * 把源环境里已装的插件装到目标环境。
 *
 * 与当前环境的写操作走官方 pluginManager 服务不同，这里是同一套官方 pnpm 通道加换
 * 一个 profile 参数：runPluginCommand({ profile, dir, installAnchor, cwd, home },
 * ['add', spec])。整批只占一次进程内互斥（分批会让并发的安装/删除插进条目之间，
 * 互相覆盖 manifest）。
 *
 * @param from - 源环境名。
 * @param to - 目标环境名。
 * @param names - 要复制的包名（按源 manifest 里记录的来源重装）。
 * @param options - 共享选项。
 * @returns 操作结果。
 */
export async function copyPlugins(
  from: string, to: string, names: readonly string[], options: CrossEnvironmentOptions = {},
): Promise<EnvironmentResult> {
  for (const name of [from, to]) {
    const problem = environmentNameProblem(name)
    if (problem !== null) return failure('invalid-name', problem)
  }
  const fromDir = environmentDir(from)
  const toDir = environmentDir(to)
  if (!existsSync(join(fromDir, 'package.json'))) return failure('not-found', '源环境不存在：' + from)
  if (!existsSync(join(toDir, 'package.json'))) return failure('not-found', '目标环境不存在：' + to)
  const selected = [...new Set(names)]
  if (selected.length === 0) return failure('empty-selection', '没有选中任何插件')
  const recorded = recordedDependencies(fromDir)
  let context: PackageOperationContext
  let runner: PluginCommandRunner
  try {
    // 先取 context 与 runner：能力缺失必须在动手之前失败。
    context = operationContext(to, toDir, fromDir, options)
    runner = await officialRunner(options)
  } catch (error) {
    return failure(error instanceof EnvironmentError ? error.code : 'official-unavailable', messageOf(error))
  }
  return enqueueMutation(async () => {
    const outputs: string[] = []
    let ok = true
    for (const name of selected) {
      const raw = recorded[name]
      const source = typeof raw === 'string' && raw.length > 0 ? raw : name
      const resolved = resolveInstallSpec(source, fromDir)
      if (resolved === null) {
        outputs.push('# ' + name + ' -> ' + to + '：跳过（本地来源已不存在：' + source + '）')
        ok = false
        continue
      }
      let result: PackageResult
      try {
        result = await runPackageOperation(runner, context, ['add', resolved.spec], options)
      } catch (error) {
        // 官方通道在 pnpm 成功之后的对账阶段也可能抛（例如依赖无法解析成 bundle）：
        // 一个条目失败不能带走整批，如实记账并继续。
        outputs.push('# ' + name + ' -> ' + to + '：失败\n' + messageOf(error))
        ok = false
        continue
      }
      outputs.push('# ' + name + ' -> ' + to + '：' + (result.exitCode === 0 ? 'ok' : '失败')
        + '\n' + result.output.trim())
      if (result.exitCode !== 0) ok = false
    }
    return ok
      ? { ok: true, output: outputs.join('\n\n') }
      : { ok: false, code: 'package-operation-failed' as const, output: outputs.join('\n\n') }
  })
}

/**
 * 读 manifest 里 包名到来源 spec 的记录。
 *
 * @param dir - 环境目录。
 * @returns 原始 dependencies 对象；没有时为空对象。
 */
function recordedDependencies(dir: string): Record<string, unknown> {
  const raw = readEnvironmentManifest(dir).raw
  const dependencies = raw['dependencies']
  return typeof dependencies === 'object' && dependencies !== null ? dependencies as Record<string, unknown> : {}
}

// ── 备份：导出 / 差异 / 恢复 ──────────────────────────────────────────────

/**
 * 备份文档格式标识（运行期常量）。
 *
 * 类型声明在 types.ts 的 BackupFormat（单一事实来源）；这里用类型断言把运行期值
 * 绑到那个字面量上 —— 改一处漏另一处会编译失败。
 */
export const BACKUP_FORMAT: BackupFormat = 'dsh-plugin-manager-companion/environment-backup'

/** 备份契约的再导出：类型唯一事实来源是 types.ts，本模块不重复定义。 */
export type { BackupMissingEntry, EnvironmentBackup, EnvironmentBackupDiff }

/**
 * 导出环境备份。
 *
 * @param name - 环境名。
 * @returns 备份文档。
 * @throws {EnvironmentError} 名称不合法或环境不存在时（code 为 invalid-name / not-found）。
 */
export function backupExport(name: string): EnvironmentBackup {
  const problem = environmentNameProblem(name)
  if (problem !== null) throw new EnvironmentError('invalid-name', problem)
  const dir = environmentDir(name)
  if (!existsSync(join(dir, 'package.json'))) throw new EnvironmentError('not-found', '环境不存在：' + name)
  const manifest = readEnvironmentManifest(dir)
  const dependencies: Record<string, string> = {}
  for (const [key, value] of Object.entries(recordedDependencies(dir))) {
    if (typeof value === 'string' && value.length > 0) dependencies[key] = value
  }
  return {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    environment: name,
    bundles: [...manifest.bundles],
    dependencies,
  }
}

/**
 * 校验一份来自外部的备份文档。
 *
 * 备份经文件或网络进入本进程，是持久化边界：形状必须在这里挡住，而不是让后面的
 * 循环抛 TypeError。
 *
 * @param value - 待校验的文档。
 * @returns 通过时为 null，否则为原因。
 */
function backupProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return '备份不是对象'
  const backup = value as Partial<EnvironmentBackup>
  if (backup.format !== BACKUP_FORMAT) return '备份格式标识不匹配（期望 ' + BACKUP_FORMAT + '）'
  if (backup.version !== 1) return '备份版本不支持：' + String(backup.version)
  if (typeof backup.environment !== 'string' || !isSafeEnvironmentName(backup.environment)) {
    return '备份里的环境名不合法：' + JSON.stringify(backup.environment)
  }
  if (!Array.isArray(backup.bundles) || backup.bundles.some((item) => typeof item !== 'string')) {
    return '备份的 bundles 不是字符串数组'
  }
  if (typeof backup.dependencies !== 'object' || backup.dependencies === null) return '备份的 dependencies 不是对象'
  for (const [key, spec] of Object.entries(backup.dependencies)) {
    if (/[\\/:]/.test(key)) return '依赖名不合法：' + JSON.stringify(key)
    if (typeof spec !== 'string') return '依赖 ' + key + ' 的来源不是字符串'
  }
  return null
}

/**
 * 对比备份与目标环境，分四类：缺失、已装、目标环境不存在、不可恢复。
 *
 * 恢复前必须先跑这一遍：差异既是用户确认的依据，也是恢复的输入（只装 missing）。
 *
 * @param backup - 备份文档。
 * @param target - 目标环境名。
 * @returns 差异。
 * @throws {EnvironmentError} 备份结构不合法（code 为 unsafe-backup）或目标名不合法时。
 */
export function backupDiff(backup: EnvironmentBackup, target: string): EnvironmentBackupDiff {
  const unsafe = backupProblem(backup)
  if (unsafe !== null) throw new EnvironmentError('unsafe-backup', unsafe)
  const problem = environmentNameProblem(target)
  if (problem !== null) throw new EnvironmentError('invalid-name', problem)
  const targetDir = environmentDir(target)
  if (!existsSync(join(targetDir, 'package.json'))) {
    return { ok: false, missing: [], already: [], missingProfiles: [target], unrestorable: [], bundlesMissing: [] }
  }
  const current = readEnvironmentManifest(targetDir)
  // readEnvironmentManifest 的 dependencies 已经是名字数组（不是对象）。
  const installed = new Set(current.dependencies)
  // 本地来源的相对路径记录在源环境目录里；源环境已不在时退到目标目录，免得把
  // 「环境被删了」误判成「本地包还在」。
  const backupDir = environmentDir(backup.environment)
  const baseDir = existsSync(backupDir) ? backupDir : targetDir
  const missing: BackupMissingEntry[] = []
  const already: string[] = []
  const unrestorable: string[] = []
  for (const [name, spec] of Object.entries(backup.dependencies)) {
    if (installed.has(name)) {
      already.push(name)
      continue
    }
    const resolved = resolveInstallSpec(spec, baseDir)
    if (resolved === null) {
      unrestorable.push(name + '（本地来源已不存在：' + spec + '）')
      continue
    }
    missing.push({ name, source: resolved.spec })
  }
  const bundlesMissing = backup.bundles.filter((bundle) => !current.bundles.includes(bundle))
  return { ok: unrestorable.length === 0, missing, already, missingProfiles: [], unrestorable, bundlesMissing }
}

/** backupRestore 的选项。 */
export interface RestoreEnvironmentOptions extends CrossEnvironmentOptions {
  /** 只算差异、不写入。 */
  readonly dryRun?: boolean
}

/**
 * 按备份恢复一个环境。
 *
 * 三步：先算差异（缺失/已装/目标不存在/不可恢复），再用官方 operations 逐条重装
 * 缺失依赖，最后在官方文件锁下补回备份的 bundle 层栈。整批只占一次进程内互斥。
 *
 * 锁的用法按官方意图：装包由 runPluginCommand 自己持锁（我们再套一层会自锁 —— 同一
 * 把 package.json.lock）；bundle 层栈的读-改-写由我们用 withFileLock 独占，避免与
 * 并发的安装互相覆盖。
 *
 * @param backup - 备份文档。
 * @param target - 目标环境名。
 * @param options - 恢复选项。
 * @returns 操作结果。
 */
export async function backupRestore(
  backup: EnvironmentBackup, target: string, options: RestoreEnvironmentOptions = {},
): Promise<EnvironmentResult> {
  let diff: EnvironmentBackupDiff
  try {
    diff = backupDiff(backup, target)
  } catch (error) {
    return failure(error instanceof EnvironmentError ? error.code : 'unsafe-backup', messageOf(error))
  }
  if (diff.missingProfiles.length > 0) {
    return failure('not-found', '目标环境不存在：' + diff.missingProfiles.join(', ')
      + '（本模块不代建环境，请先在环境列表里创建）')
  }
  const plan = describeDiff(diff)
  if (diff.missing.length === 0 && diff.bundlesMissing.length === 0) {
    return diff.unrestorable.length === 0
      ? success('没有需要恢复的内容\n' + plan)
      : failure('unrestorable', '没有需要恢复的内容，但存在不可恢复条目\n' + plan)
  }
  if (options.dryRun === true) return success('（演练）将执行：\n' + plan)
  const targetDir = environmentDir(target)
  let context: PackageOperationContext
  let runner: PluginCommandRunner
  try {
    context = operationContext(target, targetDir, targetDir, options)
    runner = await officialRunner(options)
  } catch (error) {
    return failure(error instanceof EnvironmentError ? error.code : 'official-unavailable', messageOf(error))
  }
  return enqueueMutation(async () => {
    const outputs: string[] = []
    let ok = diff.unrestorable.length === 0
    for (const entry of diff.missing) {
      let result: PackageResult
      try {
        result = await runPackageOperation(runner, context, ['add', entry.source], options)
      } catch (error) {
        // 同 copyPlugins：单个条目失败不带走整批。
        outputs.push('# ' + entry.name + '：失败\n' + messageOf(error))
        ok = false
        continue
      }
      outputs.push('# ' + entry.name + '：' + (result.exitCode === 0 ? '已恢复' : '失败')
        + '\n' + result.output.trim())
      if (result.exitCode !== 0) ok = false
    }
    let skippedBundles: readonly string[] = []
    if (diff.bundlesMissing.length > 0) {
      try {
        const restored = await restoreBundles(targetDir, backup.bundles, context.installAnchor)
        skippedBundles = restored.skipped
        outputs.push(restored.written === null
          ? '# bundle 层栈：没有可补回的层'
          : '# bundle 层栈：已补回 -> ' + restored.written)
        if (skippedBundles.length > 0) {
          outputs.push('# bundle 层栈：未补回 ' + skippedBundles.join(', ')
            + '（目标环境既解析不到、也不声明 dsh.bundle，照写会让 profile 下次启动失败）')
        }
      } catch (error) {
        outputs.push('# bundle 层栈：失败 ' + messageOf(error))
        ok = false
      }
    }
    if (skippedBundles.length > 0) ok = false
    if (diff.unrestorable.length > 0) outputs.push('不可恢复：\n  ' + diff.unrestorable.join('\n  '))
    if (ok) return { ok: true, output: outputs.join('\n\n') }
    return {
      ok: false,
      code: skippedBundles.length > 0 ? 'unrestorable' as const : 'package-operation-failed' as const,
      output: outputs.join('\n\n'),
    }
  })
}

/**
 * 把差异渲染成给用户看的计划文本。
 *
 * @param diff - 差异。
 * @returns 多行说明。
 */
function describeDiff(diff: EnvironmentBackupDiff): string {
  const lines = ['待重装 ' + String(diff.missing.length) + ' 项：'
    + (diff.missing.length === 0 ? '（无）' : '\n  ' + diff.missing.map((entry) => entry.name + ' <- ' + entry.source).join('\n  '))]
  lines.push('已装 ' + String(diff.already.length) + ' 项'
    + (diff.already.length > 0 ? '：' + diff.already.join(', ') : ''))
  if (diff.bundlesMissing.length > 0) lines.push('待补回 bundle：' + diff.bundlesMissing.join(', '))
  if (diff.unrestorable.length > 0) lines.push('不可恢复：\n  ' + diff.unrestorable.join('\n  '))
  return lines.join('\n')
}

/** 一次 bundle 层栈补回的结果。 */
interface BundleRestore {
  /** 写回后的层栈；无需改动时 null。 */
  readonly written: string | null
  /** 备份里有、但目标环境现在无法作为层启用的 bundle。 */
  readonly skipped: readonly string[]
}

/**
 * 把备份的 bundle 层栈并回目标环境（官方 writeProfileBundles，全程持文件锁）。
 *
 * 顺序以备份为准（层栈顺序决定 patch 应用顺序），目标环境多出来的 bundle 追加在
 * 末尾 —— 恢复是补回，不是裁剪用户现在的组合。
 *
 * 只写回「现在确实能启用」的层：用官方 bundleManifest 判定（能从安装锚点或环境
 * 目录解析出来，且声明了 dsh.bundle.patch）。备份里那些已经解析不到的层如果照写，
 * profile 下次启动会直接失败（官方 loadProfile 对「列了 bundle 却没有 dsh.bundle」
 * 是 fail loud），所以宁可少写并如实报告。
 *
 * 这里不用官方 sanitizeProfile：那是给「profile 起不来」的急救路径，会把用户的
 * cordis.patch.yml 移走；日常恢复不该动用户的补丁层。
 *
 * @param dir - 目标环境目录。
 * @param wanted - 备份里的 bundle 层栈。
 * @param installAnchor - 官方安装锚点（官方 bundle 解析的第一锚点）。
 * @returns 写回的层栈与跳过的 bundle。
 */
async function restoreBundles(dir: string, wanted: readonly string[], installAnchor: string): Promise<BundleRestore> {
  const installable = await officialBundlePredicate(installAnchor)
  return withFileLock(join(dir, 'package.json'), async () => {
    const manifest = readProfileManifest(OUR_PACKAGE_NAME, dir)
    const current = manifest.dsh?.profile?.bundles ?? []
    const skipped: string[] = []
    const additions: string[] = []
    for (const name of wanted) {
      if (current.includes(name) || additions.includes(name)) continue
      if (installable !== null && installable(name, dir)) additions.push(name)
      else skipped.push(name)
    }
    const desired = [...wanted.filter((name) => current.includes(name) || additions.includes(name)),
      ...current.filter((name) => !wanted.includes(name))]
    if (additions.length === 0) {
      return { written: null, skipped }
    }
    writeProfileBundles(dir, manifest, desired)
    return { written: desired.join(' -> '), skipped }
  }, { waitMs: OPERATION_LOCK_WAIT_MS })
}

/** 判定「某个包名现在能不能作为这个环境的 bundle 层启用」。 */
type BundlePredicate = (name: string, dir: string) => boolean

/**
 * 取官方 bundle 判定器。
 *
 * @param installAnchor - 官方安装锚点。
 * @returns 判定器；官方子路径不可用时 null（此时不写回任何新层，只报告）。
 */
async function officialBundlePredicate(installAnchor: string): Promise<BundlePredicate | null> {
  try {
    const module = await import('@deepseek-ai/dsh-plugin-manager/operations')
    return (name, dir) => {
      try {
        return module.bundleManifest(name, dir, installAnchor) !== undefined
      } catch {
        // 解析不出来：这个层现在启用会让 profile 起不来。
        return false
      }
    }
  } catch {
    return null
  }
}

/**
 * 目录类文件操作的重试。
 *
 * @param operation - 要执行的文件操作。
 * @param attempts - 尝试次数上限。
 */
async function retryFs(operation: () => void, attempts = 5): Promise<void> {
  const sleep = (ms: number): Promise<void> => new Promise((done) => { setTimeout(done, ms) })
  for (let attempt = 0; ; attempt += 1) {
    try {
      operation()
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      // Windows 上杀毒/索引会短暂占用目录，这几类错误重试有意义。
      const retryable = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY'
      if (!retryable || attempt >= attempts - 1) throw error
      await sleep(50 * (attempt + 1))
    }
  }
}

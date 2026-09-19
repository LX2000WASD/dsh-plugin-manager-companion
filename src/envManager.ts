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

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import {
  accessSync, appendFileSync, closeSync, constants, copyFileSync, existsSync, mkdirSync, openSync, readdirSync,
  readFileSync, renameSync,
  rmSync, statSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
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
  /** 进程事实读不到（powershell/ps 不可用等）：运行状态未知，拒绝在未知状态下做破坏性操作。 */
  | 'facts-unavailable'
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
  /** 快照做不到"只含源环境现在的清单"（删不掉上一次物化留下的 node_modules 等）。 */
  | 'snapshot-not-shallow'
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

let runCache: { readonly at: number; readonly facts: ProcessFacts } | null = null

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
  return processFacts(options).runs
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
/**
 * 一次进程事实读取的结果。
 *
 * `readable: false` 与「读到了、但一个实例都没在跑」是**两件事**（审计 W-19）：
 * 旧实现把失败折叠成空表，调用方只能看到「这台机器上没有实例」，于是把不知道说成了知道。
 * 不可读时调用方必须如实说「运行状态未知」，破坏性操作必须拒绝。
 */
export interface ProcessFacts {
  /** 环境名 → 运行实例；不可读时为空 Map（**不要据此判断「没在运行」**）。 */
  readonly runs: ReadonlyMap<string, readonly EnvironmentRun[]>
  /** 进程事实是否读到。 */
  readonly readable: boolean
  /** 不可读的原因（面向用户）。 */
  readonly reason?: string
}

/** 读一次进程事实（不经缓存，含可读性）。 */
function readProcessFacts(options: ScanRunsOptions): ProcessFacts {
  const read: ProcessLines = options.reader !== undefined
    ? { lines: options.reader() }
    : defaultProcessLines()
  if (read.reason !== undefined) return { runs: new Map(), readable: false, reason: read.reason }
  const out = new Map<string, EnvironmentRun[]>()
  for (const line of parseProcessLines(read.lines)) {
    const run = parseRun(line)
    if (run === null) continue
    const entry: EnvironmentRun = { pid: line.pid, port: run.port, command: line.command }
    const list = out.get(run.name)
    if (list === undefined) out.set(run.name, [entry])
    else list.push(entry)
  }
  return { runs: out, readable: true }
}

/**
 * 立即读取进程事实（含「读不到」这个状态），并写入缓存。
 *
 * @param options - 注入选项。
 * @returns 事实与可读性。
 */
export function processFactsNow(options: ScanRunsOptions = {}): ProcessFacts {
  return readProcessFacts(options)
}

/**
 * 读取进程事实（带缓存）。
 *
 * @param options - 缓存与注入选项。
 * @returns 事实与可读性。
 */
export function processFacts(options: ScanRunsOptions = {}): ProcessFacts {
  const now = options.now?.() ?? Date.now()
  const ttl = options.ttlMs ?? SCAN_RUNS_TTL_MS
  if (options.fresh !== true && runCache !== null && now - runCache.at < ttl) return runCache.facts
  const facts = readProcessFacts(options)
  runCache = { at: now, facts }
  return facts
}

/**
 * 立即扫描进程表，不经缓存（只要实例映射；可读性请用 processFactsNow）。
 *
 * @param options - 注入选项。
 * @returns 环境名到运行实例列表的映射。
 */
export function scanRunsNow(options: ScanRunsOptions = {}): Map<string, readonly EnvironmentRun[]> {
  return new Map(readProcessFacts(options).runs)
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

/**
 * 把命令行切成 argv 片段，尊重引号。
 *
 * 为什么必须尊重引号：Windows 会给含空格的参数加引号，而官方安装包默认就在
 * `C:\Program Files\nodejs`。按空白切词会把 `"C:\Program Files\…\bin.js"` 切成两段，
 * isDshEntry 拿到 `bin.js"` 就不匹配 → 正在运行的实例被判成「没在运行」（审计 W-03，
 * 已在真 win32 Node 上复现）。后果最重的一条是删除/改名前的「正在运行」护栏失效。
 *
 * 规则取 Windows 与 POSIX 的共同子集：引号内的空白不切分、引号本身剥掉、反斜杠不转义
 * （cmd 不用反斜杠转义引号；ps 输出里也少见转义）。
 *
 * @param command - 命令行原文。
 * @returns argv 片段。
 */
function tokenizeCommandLine(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (const char of command) {
    if (quote !== null) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") { quote = char; continue }
    if (/\s/.test(char)) {
      if (current.length > 0) { tokens.push(current); current = '' }
      continue
    }
    current += char
  }
  if (current.length > 0) tokens.push(current)
  return tokens
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
  // 引号已在分词阶段剥掉；这里再兜一次首尾引号，防止不平衡引号留下的残片。
  const unquoted = token.replace(/^["']|["']$/g, '')
  const normalized = unquoted.split('\\').join('/')
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
 * 取某个环境在这份进程扫描结果里的运行实例。
 *
 * map 的键来自命令行文本（大小写由那个进程自己决定），所以不能逐字查找：在大小写不
 * 敏感的文件系统上 `DEMO` 与 `demo` 是同一个环境（审计 W-01 的同族面）。判据统一走
 * paths.ts 的 sameEnvironment，别在各处自己写比较。
 *
 * @param runs - scanRuns / scanRunsNow 的结果。
 * @param name - 环境名（调用方给的原始大小写）。
 * @returns 运行实例列表；没有则空数组。
 */
function runsForName(
  runs: ReadonlyMap<string, readonly EnvironmentRun[]>, name: string,
): readonly EnvironmentRun[] {
  const direct = runs.get(name)
  if (direct !== undefined) return direct
  for (const [key, value] of runs) {
    if (sameEnvironment(key, name)) return value
  }
  return []
}

/**
 * 解析一行进程表。
 *
 * @param line - pid 与命令行。
 * @returns 环境名与端口；不属于任何环境实例时 null。
 */
function parseRun(line: ProcessLine): ParsedRun | null {
  const tokens = tokenizeCommandLine(line.command)
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

/** 一次进程表读取的结果：行，或「读不到 + 原因」。 */
interface ProcessLines {
  readonly lines: readonly string[]
  /** 读不到时的原因（面向用户）；读到时为 undefined。 */
  readonly reason?: string
}

/**
 * POSIX 降级路径：ps -eo pid=,args=。
 *
 * 与旧行为的差别（审计 W-19）：失败**不再折叠成空表**——空表和「这台机器上没有实例」
 * 在旧实现里完全不可区分，而调用方据此会说「未运行」。官方 process-inspector 的先例是
 * 对不支持的平台直接 throw：失败必须能被区分。
 */
function psProcessLines(): ProcessLines {
  try {
    return {
      lines: execFileSync('ps', ['-eo', 'pid=,args='], {
        encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
      }).split('\n'),
    }
  } catch (error) {
    return { lines: [], reason: 'ps 不可用（' + messageOf(error) + '）' }
  }
}

/**
 * Windows 路径：powershell CIM 查询进程表。
 *
 * 两处与旧行为不同：① 不再用 `-match 'dsh'` 预筛（审计 W-05：命令行里没写 dsh 的包装进程
 * 会被漏掉，而真正的判据是 parseRun；代价是输出更大、更慢，正确性优先）；
 * ② 失败带上原因（W-19），不返回空表。
 */
function windowsProcessLines(): ProcessLines {
  try {
    const script = [
      'Get-CimInstance Win32_Process',
      '| ForEach-Object { $_.ProcessId.ToString() + [char]9 + $_.CommandLine }',
    ].join(' ')
    return {
      lines: execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
      }).split(/\r?\n/),
    }
  } catch (error) {
    return { lines: [], reason: 'powershell CIM 不可用（' + messageOf(error) + '）：无法读取进程表' }
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
function defaultProcessLines(): ProcessLines {
  if (process.platform === 'win32') return windowsProcessLines()
  const proc = procProcessLines()
  // proc 返回 null 只表示「这台机器没有 /proc」，那是**降级**信号，不是失败；
  // 真正的失败（ps 也没有）由 psProcessLines 的 reason 带出来。
  return proc === null ? psProcessLines() : { lines: proc }
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
  /** 复用的进程事实（带可读性）；省略时自行读取。 */
  readonly facts?: ProcessFacts
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
  // 进程事实与 manifest 是两个来源（见 types.ts 的注释）：可读性要一并带出去，
  // 否则界面会把「读不到」渲染成「未运行」——那正是审计 W-19 的形态。
  const facts: ProcessFacts = options.facts
    ?? (options.runs === undefined ? processFacts() : { runs: options.runs, readable: true })
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
      // 这台机器上是否同一个目录（win32/darwin 大小写不敏感），不是字符串是否逐字相等。
      current: sameEnvironment(name, current),
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
      runs: runsForName(facts.runs, name),
      // 进程事实读不到时**不能**让调用方把空数组当「未运行」：把未知如实带出去。
      ...(facts.readable ? {} : {
        runsKnown: false,
        ...(facts.reason === undefined ? {} : { runsUnknownReason: facts.reason }),
      }),
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
    // 目录不写：环境卡片每一行都渲染 dir（ConsolePage 的环境行），这里是①（重复屏幕已有信息）。
    // 层栈名字必须留：卡片只显示「N 个组合包」计数，名字在别处看不见。
    return success('已创建环境 ' + name + '\nbundle 层栈：\n  ' + bundles.join('\n  '))
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
  // 源与目标在这台机器上是同一个目录（win32/darwin 大小写不敏感）→ 先说清楚，别落到含糊的 already-exists。
  if (sameEnvironment(from, to)) {
    return failure('invalid-name', from + ' 与 ' + to + ' 在这台机器上是同一个环境（文件系统大小写不敏感），无需重命名')
  }
  if (existsSync(targetDir)) return failure('already-exists', '目标环境已存在：' + to)
  const current = resolveCurrent(options)
  if (sameEnvironment(current, from) || sameEnvironment(current, to)) {
    return failure('current', current + ' 是当前正在运行的环境，不能重命名')
  }
  // 改名不可逆：不拿 3s 陈旧缓存当依据，用即时读取，并要求事实**可读**。
  const facts = processFacts({ fresh: true })
  if (!facts.readable) {
    return failure('facts-unavailable', from + ' 的运行状态未知：进程事实读不到（'
      + String(facts.reason) + '）。拒绝在未知状态下重命名环境。')
  }
  const busy = runsForName(facts.runs, from)
  if (busy.length > 0) {
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
  // 删除不可逆：不拿 3s 陈旧缓存当依据，用即时读取，并要求事实**可读**。
  const facts = processFacts({ fresh: true })
  if (!facts.readable) {
    return failure('facts-unavailable', name + ' 的运行状态未知：进程事实读不到（'
      + String(facts.reason) + '）。拒绝在未知状态下删除环境。')
  }
  const busy = runsForName(facts.runs, name)
  if (busy.length > 0) {
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
  /**
   * 是否需要经 shell 启动。
   *
   * Windows 上 PATH shim 是 `dsh.cmd`：Node ≥20.12 起 `spawn('x.cmd')` 不带 shell 会**抛 EINVAL**
   * （审计 W-07 已在真 win32 Node 上实测），所以这条回退路径必须显式声明要 shell；
   * 首选路径（process.execPath + bin.js）保持无 shell 的官方启动纪律。
   */
  readonly shell: boolean
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
  /**
   * 为什么最终是这个启动方式（降级原因）。
   *
   * 独立复验 N-03：`wt` 缺失 → 降级后台时，成功与失败两条文案都只说「启动方式：后台」，
   * 用户不知道**为什么**不是终端窗口。这是「用户即将做的动作的后果」类信息（DESIGN §12.2
   * 的保留清单），必须下发。
   */
  readonly reason?: string
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
  const facts = processFacts()
  // 不可读时**不**假装「没在运行」：照常允许启动（启动不是破坏性操作），但把事实如实带出去。
  const factsNote = facts.readable ? '' : '\n注意：进程表不可读（' + String(facts.reason) + '），本次未做重复实例检查。'
  const running = runsForName(facts.runs, name)
  if (running.length > 0) {
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
    // 中段是"为什么不发起启动"的原因（copy-dev 复核修正：删了用户不知道缘由），必须留。
    return failure('port-in-use', '端口 ' + String(port) + ' 已经被监听：无法确认它会由本次启动的实例接管，'
      + '所以不发起启动。请换一个端口，或先停掉占用它的进程。')
  }
  const spec = launchSpec(name, dir, port, options)
  let outcome = await (options.launch ?? defaultLaunch)(spec)
  if (!outcome.ok) return failure('launch-failed', outcome.detail)
  let status = await waitForReady(port, options)
  let retryNote = ''
  if (status === null && outcome.mode === 'terminal') {
    // 审计 W-09：终端窗口内的失败是**异步**的（窗口里的报错、没有 wt、无桌面会话），
    // spawn 不抛，所以第一段就绪失败不能当作结论。但也不能在「第一次其实起来了、只是慢」
    // 时再起一个（同端口会打架）—— 只在端口根本没人监听时才回退后台重试。
    if (!await tcpListening(port)) {
      // 走同一个启动器（可注入），只是换成后台形态 —— 这样调用方/测试只需要注入一次。
      const retrySpec = backgroundSpec({ ...spec, mode: 'background' })
      const fallback = await (options.launch ?? defaultLaunch)(retrySpec)
      retryNote = '\n终端窗口尝试 ' + String(options.readyTimeoutMs ?? START_READY_TIMEOUT_MS)
        + 'ms 未就绪，已改为后台启动重试。'
      if (!fallback.ok) return failure('launch-failed', fallback.detail + retryNote)
      outcome = fallback
      status = await waitForReady(port, options)
    }
  }
  if (status === null) {
    return failure('timeout', startTimeoutMessage(name, port, spec, outcome, options) + retryNote + factsNote)
  }
  // 新实例立刻可见：丢弃陈旧缓存。
  resetRunCache()
  // 回退过一次的话，成功文案也要说清楚（用户需要知道第一次为什么没成）。
  return success(startedMessage(name, port, status, spec, outcome) + retryNote + factsNote)
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
    + '本次没有发起启动。'
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
  // 回执（已启动 X）**必须留**：卡片上的运行标记是异步的（进程表扫描 + 3s 缓存，甚至可能显示"未知"），
  // 不能替代"你刚点的这一下成功了"这个即时事实（copy-dev 复核结论）。启动方式与降级原因同样必须留。
  const lines = ['已启动 ' + name
    + '（启动方式：' + (outcome.mode === 'terminal' ? '终端窗口 ' + (outcome.terminal ?? '') : '后台')
    + (outcome.reason === undefined ? '' : '；' + outcome.reason)
    + '）'
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
    + 'ms 内端口 ' + String(port) + ' 没有给出官方 web 应答（就绪判据：GET / 返回 200/303/401）。'
    + (outcome.reason === undefined ? '' : '\n启动方式：' + (outcome.mode === 'terminal' ? '终端窗口' : '后台') + '（' + outcome.reason + '）')]
  if (outcome.logPath === undefined) {
    lines.push('请看刚打开的终端窗口里 dsh 的输出。')
  } else {
    const tail = tailOfLog(outcome.logPath, 20)
    lines.push('日志：' + outcome.logPath)
    // 独立复验 N-04：系统本地化文本按控制台代码页写入，按 utf8 读会出替换字符；
    // 那就如实标注，别让乱码冒充可读信息。
    if (tail.undecodable) lines.push('（尾部包含按控制台代码页写入的系统文本，无法按 UTF-8 解码，下面以替换字符显示）')
    lines.push(tail.lines.length === 0 ? '（日志还是空的）' : tail.lines.join('\n'))
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
    shell: entryPoint.shell,
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
/**
 * 被启动实例的入口（可注入 argv/platform，供测试）。
 *
 * @param argv - 进程参数；默认 process.argv。
 * @param platform - 平台；默认 process.platform。
 * @returns 命令、前置参数、入口脚本与是否需要 shell。
 */
export function dshEntryPoint(
  argv: readonly string[] = process.argv, platform: NodeJS.Platform = process.platform,
): { command: string; args: readonly string[]; entry: string | null; shell: boolean } {
  const entry = argv[1]
  if (entry !== undefined && /(?:^|[\\/])bin\.(?:js|cjs|mjs)$/.test(entry)
    && /[\\/]@deepseek-ai[\\/]dsh(?:[\\/]|$)/.test(entry)) {
    return { command: process.execPath, args: [entry], entry, shell: false }
  }
  if (platform === 'win32') {
    // Windows 的 PATH shim 是 .cmd 批处理：必须交给 cmd.exe 执行（W-07）。
    return { command: 'dsh.cmd', args: [], entry: null, shell: true }
  }
  return { command: 'dsh', args: [], entry: null, shell: false }
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
 * 三件事：
 *  1. 单行截断（启动日志里可能有很长的堆栈，REST 响应不该被它撑爆）；
 *  2. token 脱敏（token 只允许出现在那份「仅本用户可读」的启动日志与 startEnvironment 的
 *     成功返回里）—— 注意「仅本用户可读」在 Linux 上靠 0600，在 Windows 上权限位不生效、
 *     只受目录 ACL 保护（审计 W-12），所以这是**说辞**不是保证；失败文案必须脱敏正是因为如此；
 *  3. **编码如实**（独立复验 N-04）：Node 自己写的是 UTF-8，但 cmd/powershell 的本地化报错按
 *     控制台代码页写入，按 utf8 读会得到替换字符。这里去掉控制字符，并把「是否含无法解码
 *     片段」交给调用方标注 —— 不让乱码冒充可读信息。
 *
 * @param logPath - 日志文件。
 * @param lines - 取最后多少行。
 * @returns 尾部行与「是否含无法解码的片段」；读不到时为空。
 */
function tailOfLog(logPath: string, lines: number): { lines: string[]; undecodable: boolean } {
  try {
    const text = readFileSync(logPath, 'utf8')
    const picked = text.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-lines)
      .map((line) => sanitizeLogLine(line))
    return { lines: picked, undecodable: picked.some((line) => line.includes(DECODE_REPLACEMENT)) }
  } catch {
    return { lines: [], undecodable: false }
  }
}

/** UTF-8 解码失败的替换字符（cmd/powershell 按控制台代码页写下的本地化文本会变成它）。 */
const DECODE_REPLACEMENT = '\uFFFD'

/**
 * 清理一行日志：去掉不该进用户文案的控制字符、截断超长行、token 脱敏。
 *
 * @param line - 日志原文一行。
 * @returns 可安全展示的一行。
 */
function sanitizeLogLine(line: string): string {
  const cleaned = line.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  const capped = cleaned.length > 500 ? cleaned.slice(0, 500) + '…' : cleaned
  return capped.replace(/token=[A-Za-z0-9_-]+/g, 'token=***')
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
 * 起一个 detached 子进程，并在短窗口内探测**异步**启动失败。
 *
 * 为什么需要探测：spawn 对「找不到可执行文件」是异步报错的，同步 try/catch 抓不到。
 * 审计 W-09 指出：终端模式原来的 ok 判定只看同步异常，于是「找不到终端」也会被报成
 * 「已在终端窗口启动」。这里统一成一处可等待的判定。
 *
 * @param command - 可执行文件。
 * @param args - 参数（argv 直传，不经 shell）。
 * @param extra - 追加的 spawn 选项（如日志 fd、shell）。
 * @returns 失败说明；成功（或 500ms 内没有报错）时 null。
 */
async function spawnDetached(
  command: string, args: readonly string[], extra: Record<string, unknown> = {},
): Promise<{ failure: string | null; child: ChildProcess | null }> {
  let child: ChildProcess | null = null
  try {
    child = spawn(command, [...args], {
      cwd: process.cwd(), detached: true, stdio: 'ignore', windowsHide: true, ...extra,
    })
  } catch (error) {
    return { failure: messageOf(error), child: null }
  }
  let failure: string | null = null
  const started = child
  await new Promise<void>((settle) => {
    const timer = setTimeout(settle, 500)
    timer.unref()
    started.once('spawn', () => { clearTimeout(timer); settle() })
    started.once('error', (error) => { failure = messageOf(error); clearTimeout(timer); settle() })
  })
  started.unref()
  return { failure, child: started }
}

/**
 * 默认启动器：终端窗口优先，没有可用终端就降级为后台。
 *
 * @param spec - 启动描述。
 * @returns 启动结果；mode 字段如实反映**实际**采用的启动方式。
 */
async function defaultLaunch(spec: LaunchSpec): Promise<LaunchOutcome> {
  if (spec.mode === 'terminal') {
    const terminal = await openInTerminal(spec)
    if (terminal !== null) {
      return {
        ok: true, mode: 'terminal', terminal,
        detail: '已在 ' + terminal + ' 终端窗口中启动（窗口内的启动结果尚未验证）—— 关闭该窗口即停止实例',
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
    // Linux：目录 0700 / 文件 0600；Windows：权限位**不生效**（审计 W-12），
    // 只受继承的目录 ACL 保护。所以这里按「尽力而为」写权限，不把它当安全承诺。
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 })
    const fd = openSync(logPath, 'a', 0o600)
    try {
      // Windows 的 .cmd shim 显式经 cmd.exe 执行（W-07 / N-01）：不再用 shell:true ——
      // 那会触发 Node DEP0190（args 只拼接、不转义），参数先过白名单校验。
      const invocation = spec.shell ? windowsShimInvocation(spec) : { command: spec.command, args: spec.args }
      const { failure: spawnFailure } = await spawnDetached(invocation.command, invocation.args, {
        stdio: ['ignore', fd, fd],
      })
      failure = spawnFailure
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
    ...note === undefined ? {} : { reason: note },
  }
}

/**
 * 经 cmd.exe 执行 .cmd/.bat 时，参数里允许出现的字符（保守白名单）。
 *
 * 独立复验 N-01：原来用 spawn(..., { shell: true }) 会触发 Node **DEP0190**（args 只拼接、
 * 不转义），含空格的参数没有引号保护；真机实测 `dsh2.cmd` 收到的是
 * `[--patch C:\Program Files\x.yml --port 3599]` 这样被拆开的 argv。
 * 现在改成显式 `cmd.exe /d /s /c <cmd> <args...>`（不再声明 shell，因此不再有那条警告），
 * 并在拼之前**校验**每个参数：不满足白名单就大声失败，而不是交给 cmd 静默拆错。
 * 这条回退路径的真实参数只有 `--profile <合法名>` / `--port <数字>` / `--no-open`；
 * 将来若有人传含空格或元字符的 extraArgs，会在这里拿到明确报错（而不是被悄悄转错）。
 */
const CMD_SAFE_ARG = /^[A-Za-z0-9_@%+=:,./\\-]+$/

/**
 * .cmd/.bat shim 的启动形态（显式 cmd、argv 直传、参数先校验）。
 *
 * @param spec - 启动描述（shell 为 true 时才有意义）。
 * @returns 命令与参数。
 * @throws 参数含 cmd 不安全字符时（绝不静默交给 cmd 拆错）。
 */
export function windowsShimInvocation(spec: LaunchSpec): { command: string; args: readonly string[] } {
  const tokens = [spec.command, ...spec.args]
  const unsafe = tokens.filter((token) => !CMD_SAFE_ARG.test(token))
  if (unsafe.length > 0) {
    throw new Error('Windows 下经 cmd 启动时参数含不安全字符（会被 cmd 重新拆词）：' + unsafe.join(', '))
  }
  return { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', ...tokens] }
}

/**
 * Windows 可见终端窗口的启动形态（Windows Terminal，官方 open-in-app 目录的 Win 终端项就是 wt：
 * packages/host/open-in-app/src/catalog.ts:361）。
 *
 * 为什么不用 `cmd /c start "" cmd /k <命令行>`：那条串是裸拼接的展示文本，交给 cmd 会**重新
 * 分词**；官方安装包默认在 `C:\Program Files\nodejs`，含空格时新窗口里只有「找不到命令」，
 * 而失败要等 30s 就绪超时才暴露（审计 W-08）。wt 收的是 argv，程序与每个参数各自成段，
 * 不再经过 shell 分词。
 *
 * @param spec - 启动描述。
 * @returns 要执行的命令与参数（argv 形态）。
 */
export function windowsTerminalInvocation(spec: LaunchSpec): { command: string; args: readonly string[] } {
  if (spec.shell) {
    // .cmd shim：经 cmd 执行，走同一份参数校验（与后台模式同源）。
    const shim = windowsShimInvocation(spec)
    return { command: 'wt', args: ['-d', spec.dir, shim.command, ...shim.args] }
  }
  return { command: 'wt', args: ['-d', spec.dir, spec.command, ...spec.args] }
}

/**
 * 在可见终端窗口里启动。
 *
 * 窗口让实例一直在用户眼前（关掉窗口就停掉实例），也是旧实现里用户最认可的交互。
 * POSIX 下优先切到 $TERMINAL；Windows 上只用官方目录项形态（Windows Terminal，wt）。
 * 找不到可用终端、或启动**异步失败**（wt 不存在、无桌面会话）时返回 null，由调用方
 * 降级为后台并如实说明 —— 不再出现「已启动」而其实窗口里是报错。
 *
 * @param spec - 启动描述。
 * @returns 终端名；没有可用终端时 null。
 */
async function openInTerminal(spec: LaunchSpec): Promise<string | null> {
  const line = shellLine(spec)
  if (process.platform === 'darwin') {
    const { failure } = await spawnDetached('osascript',
      ['-e', 'tell application "Terminal" to do script "' + line.split('"').join('\\"') + '"'])
    return failure === null ? 'Terminal.app' : null
  }
  if (process.platform === 'win32') {
    // 只用官方目录项形态（Windows Terminal，官方 open-in-app 目录里 Win 的终端项就是 wt）：
    // packages/host/open-in-app/src/catalog.ts:361。程序与参数走 argv，不经过 shell 二次分词，
    // 所以 `C:\Program Files\nodejs` 这类含空格的路径天然安全（审计 W-08 的根因就是裸拼接命令行）。
    // 没有 wt（或启动失败）→ 返回 null，由调用方降级为后台并如实说明；不再自造 cmd /c start 命令行。
    const invocation = windowsTerminalInvocation(spec)
    const { failure } = await spawnDetached(invocation.command, invocation.args)
    return failure === null ? 'wt' : null
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
    const { failure } = await spawnDetached(resolved, terminalArgv(basename(resolved), line))
    if (failure === null) return basename(resolved)
    // 换下一个模拟器。
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

/**
 * 终止一个实例进程。**平台语义不同，必须如实区分。**
 *
 * POSIX：给那一个 pid 发 SIGTERM —— 可被对端 handler 处理，是「请退出」。
 * Windows：Node 的 SIGTERM 等价于强制结束**那一个** pid（子进程收不到 handler），而且
 *   **不覆盖进程树**：审计 W-02 实测杀掉 cmd 包装进程后，真正跑着 bin.js 的孙进程仍然
 *   活着，而 stop 会报「已停止」。所以 Windows 走进程树终止：
 *   `taskkill /PID <pid> /T /F` —— 与官方同形实现
 *   packages/subprocess/subprocess-local/src/spawn.ts:113-122（taskkillProcessTree）一致；
 *   这里按同形自己调系统命令，不依赖那个包（subprocess-local 的内部面不对外导出，
 *   对外只有 ctx.subprocess 服务，而它只提供 spawn/spawnTerminal/resolveExecutable，
 *   没有进程枚举与终止树的方法）。
 *
 * @param pid - 目标 pid（调用方已复核过命令行仍属于同名环境）。
 * @returns 实际采用的方式，写进结果文案用（不假装优雅停止）。
 */
function terminateInstance(pid: number): 'sigterm' | 'taskkill' {
  if (process.platform === 'win32') {
    // 与官方同形：结果刻意不判成败 —— 进程树可能刚好自己退出、taskkill 也可能不在 PATH；
    // 真正的判据是下面的存活轮询，那才是事实。
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return 'taskkill'
  }
  process.kill(pid, 'SIGTERM')
  return 'sigterm'
}

/** stopEnvironment 的选项。 */
export interface StopEnvironmentOptions extends CurrentEnvironmentOptions {
  /** 等待退出的上限；默认 STOP_TIMEOUT_MS。 */
  readonly timeoutMs?: number
  /** 注入时钟（测试）。 */
  readonly now?: () => number
  /** 注入等待（测试）。 */
  readonly sleep?: (ms: number) => Promise<void>
  /**
   * 注入「读某个 pid 的命令行」（测试）。
   *
   * 为什么需要它：kill 前的复核在 Windows 上走 powershell，POSIX 上读 /proc —— 在 Linux 上
   * 伪装 process.platform='win32' 会让复核必然读不到（找不到 powershell），于是整条 Windows
   * 分支无法在 Linux 回归里覆盖。这是与 probe/launch/sleep 同风格的测试接缝。
   */
  readonly readCommand?: (pid: number) => string | null
}

/**
 * 停止一个环境的实例 —— 只按 pid 精确 kill。
 *
 * 绝不 pkill -f "dsh --profile NAME"：那会连带杀掉命令行里恰好出现同一字符串的
 * 无关进程，也会杀掉同名的 pnpm 与一次性命令。这里的流程是：扫描，取同名环境的
 * pid，逐个用 readProcessCommand 复核该 pid 仍然是同一环境的实例，再终止（POSIX
 * SIGTERM；Windows taskkill /T /F 结束进程树，见 terminateInstance），最后轮询存活。
 * 结果文案如实说明是哪种终止方式 —— Windows 上不存在「优雅停止」这回事。
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
  let factsUpd = processFacts()
  let runs = runsForName(factsUpd.runs, name)
  if (runs.length === 0 && factsUpd.readable) {
    factsUpd = processFacts({ fresh: true })
    runs = runsForName(factsUpd.runs, name)
  }
  if (!factsUpd.readable) {
    return failure('facts-unavailable', name + ' 的运行状态未知：进程事实读不到（'
      + String(factsUpd.reason) + '）。拒绝在未知状态下停止实例。')
  }
  if (runs.length === 0) return failure('not-running', name + ' 没有运行中的实例')

  const killed: number[] = []
  const skipped: string[] = []
  /** 本批实际用过的终止方式（决定文案说的是 SIGTERM 还是 taskkill）。 */
  const modes = new Set<'sigterm' | 'taskkill'>()
  for (const run of runs) {
    if (run.pid === process.pid || run.pid === process.ppid) {
      skipped.push('pid ' + String(run.pid) + '（本进程/父进程）')
      continue
    }
    const command = (options.readCommand ?? readProcessCommand)(run.pid)
    if (command === null) {
      skipped.push('pid ' + String(run.pid) + '（已退出）')
      continue
    }
    const parsed = parseRun({ pid: run.pid, command })
    if (parsed === null || !sameEnvironment(parsed.name, name)) {
      skipped.push('pid ' + String(run.pid) + '（命令行已不属于 ' + name + '，拒绝 kill）')
      continue
    }
    try {
      modes.add(terminateInstance(run.pid))
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
  const forced = modes.has('taskkill')
  const lines = ['已停止 ' + name + '（pid ' + killed.join(', ') + '）'
    + (forced ? '\n终止方式：Windows 上是 taskkill /T /F 强制结束进程树（含子进程），不是优雅停止' : '')]
  if (skipped.length > 0) lines.push('未处理：' + skipped.join('；'))
  if (stillAlive.length > 0) {
    lines.push('仍在运行：pid ' + stillAlive.join(', ') + '（'
      + (forced ? 'taskkill /T /F 之后' : '已发 SIGTERM，')
      + String(options.timeoutMs ?? STOP_TIMEOUT_MS) + 'ms 内仍在）')
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
      + '当前进程不是由 dsh 以 profile 方式启动的，跨环境包操作无法定位安装锚点。')
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
    return success('已修复安装 ' + target + '（环境 ' + profile + '）')
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


// ── 试装引擎（DESIGN §5.2 / §5.4）────────────────────────────────────────

/** 测试环境名的后缀。一个真实环境对应一个测试环境（保真需要，§5.4 命名与归属）。 */
export const TRIAL_ENVIRONMENT_SUFFIX = '-dpmc'

/**
 * 某个真实环境对应的测试环境名。
 *
 * @param realName - 真实环境名。
 * @returns 测试环境名。
 */
export function trialEnvironmentName(realName: string): string {
  return realName + TRIAL_ENVIRONMENT_SUFFIX
}

/**
 * 是不是我们创建的测试环境（只看名字形态）。
 *
 * 删除路径先用它筛，再核对归属（§5.4 清理）：不靠台账，台账会过期。
 *
 * @param name - 环境名。
 * @returns 是否形如测试环境。
 */
export function isTrialEnvironmentName(name: string): boolean {
  return name.endsWith(TRIAL_ENVIRONMENT_SUFFIX) && name.length > TRIAL_ENVIRONMENT_SUFFIX.length
}

/**
 * 测试环境名对应的真实环境名；不是测试环境时 null。
 *
 * @param name - 环境名。
 * @returns 真实环境名或 null。
 */
export function trialEnvironmentOwner(name: string): string | null {
  return isTrialEnvironmentName(name) ? name.slice(0, -TRIAL_ENVIRONMENT_SUFFIX.length) : null
}

/**
 * 环境指纹（DESIGN §5.4）：五元组，**全部读盘**，不读我们的内存台账。
 *
 * 为什么不读台账：用户可能在终端里跑官方 dsh plugin add、或直接改文件，那些改动不会经过我们，
 * 台账必然过期。所以每次要用测试环境之前重算一次、与记录比对。
 */
export interface EnvironmentFingerprint {
  /** package.json 内容 hash；缺失时 null（缺失与空文件是两件事）。 */
  readonly manifestHash: string | null
  /** pnpm-lock.yaml 内容 hash；缺失时 null。 */
  readonly lockfileHash: string | null
  /** cordis.patch.yml 内容 hash；缺失时 null。 */
  readonly patchHash: string | null
  /** bundle 层栈。 */
  readonly bundles: readonly string[]
  /** 层栈来源：官方 listBundles() 还是本地 manifest（**口径不同，必须标**）。 */
  readonly bundlesSource: 'official' | 'manifest'
  /** 直接依赖名（排序）。 */
  readonly dependencies: readonly string[]
  /** 五元组的整体 hash（比对用）。 */
  readonly hash: string
}

/** environmentFingerprint 的选项。 */
export interface FingerprintOptions {
  /** 官方层栈事实：ctx.pluginManager.listBundles()（只在测当前环境时可用）。 */
  readonly listBundles?: () => Promise<readonly string[]>
}

/**
 * 文件内容 hash。
 *
 * @param path - 文件路径。
 * @returns 16 位 hex；读不到时 null。
 */
function fileHash(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
  } catch {
    return null
  }
}

/**
 * 算一个环境当前的指纹（读盘）。
 *
 * @param name - 环境名。
 * @param options - 官方层栈来源（可注入；拿不到时退回 manifest 并如实标注口径）。
 * @returns 指纹。
 */
export async function environmentFingerprint(
  name: string, options: FingerprintOptions = {},
): Promise<EnvironmentFingerprint> {
  const dir = environmentDir(name)
  const manifest = readEnvironmentManifest(dir)
  let bundles: readonly string[] = manifest.bundles
  let bundlesSource: 'official' | 'manifest' = 'manifest'
  if (options.listBundles !== undefined) {
    try {
      bundles = await options.listBundles()
      bundlesSource = 'official'
    } catch {
      // 官方事实拿不到：退回 manifest，但口径标签会说明它不是官方投影。
    }
  }
  const tuple = {
    manifestHash: fileHash(join(dir, 'package.json')),
    lockfileHash: fileHash(join(dir, 'pnpm-lock.yaml')),
    patchHash: fileHash(join(dir, 'cordis.patch.yml')),
    bundles: [...bundles],
    bundlesSource,
    dependencies: [...manifest.dependencies].sort(),
  }
  const hash = createHash('sha256').update(JSON.stringify(tuple)).digest('hex').slice(0, 16)
  return { ...tuple, hash }
}

/**
 * 两份指纹是否同一环境状态。
 *
 * @param a - 之一。
 * @param b - 之二。
 * @returns 是否一致。
 */
export function sameFingerprint(a: EnvironmentFingerprint, b: EnvironmentFingerprint): boolean {
  return a.hash === b.hash
}

/** 一次挂载验证的判定（三态；DESIGN §5.2：**退出码不参与判定**）。 */
export type BootVerdict =
  /** 树挂载成功（stderr 只有官方的「缺任务」用法提示）。 */
  | { readonly kind: 'mounted' }
  /** 挂载失败，带根因链。 */
  | { readonly kind: 'failed'; readonly reason: string; readonly chain: readonly string[] }
  /** 判不出来（没有可识别特征、进程没起来、被超时杀掉等）。 */
  | { readonly kind: 'undetermined'; readonly reason: string }

/** 官方 headless 在「没给任务」时的 stderr 特征（§5.2 实测）。 */
const BOOT_TASK_REQUIRED = /a task is required/
/** 官方 Loader 挂载失败的特征。 */
const BOOT_TREE_FAILED = /plugin tree failed to load/
/**
 * 官方启动器「层解析不到」的特征（浅快照缺依赖时的真实形态，真机实测）。
 *
 * 它与 Loader 失败**不同形**：这一条发生在挂载之前（profile-boot 解析 bundle 时 throw），
 * 所以 stderr 里既没有 plugin tree failed to load、也没有缺任务提示 —— 旧判据会把它归成
 * 「无法判定」，于是升级分支永远不会触发（等于装饰）。两种失败可区分，所以这里单独认它。
 */
const BOOT_UNRESOLVED_LAYER = /cannot resolve profile bundle/

/**
 * 一行是不是"根因链上的噪声"：栈帧、抛错处的源码行、Node 自己的警告前缀。
 *
 * 为什么必须滤：官方失败输出里既有错误消息，也有整段堆栈。堆栈里出现的
 * `throw new Error(\`${binName}: ${stage}: …`)` 这类**源码行**同样含 "Error" 字样，
 * 早先的过滤器会把它当成第一条原因——用户看到的"根因"是一行源码，读不出任何信息。
 *
 * @param line - stderr 里的一行（已 trim）。
 * @returns 是噪声行时 true。
 */
function isChainNoise(line: string): boolean {
  if (/^at\s/.test(line)) return true          // 栈帧：at fn (file:line:col)
  if (/^throw\s/.test(line)) return true       // 抛错处源码
  if (/^\^+$/.test(line)) return true          // Node 代码帧里的插入符标记行
  if (/^\(node:\d+\)/.test(line)) return true // Node 运行期警告
  if (/^node:internal\//.test(line)) return true
  return false
}

/**
 * 从 stderr 文本判定挂载结果（纯函数，可注入文本测试）。
 *
 * 判据（§5.2 实测）：健康环境 stderr 只有一行 dsh: a task is required…，而**退出码仍是 1**，
 * 所以退出码不能用作判据；失败是 plugin tree failed to load + cause 链。两者都没有 → 无法判定。
 *
 * @param stderr - 子进程的 stderr 文本。
 * @returns 三态判定。
 */
export function judgeBootStderr(stderr: string): BootVerdict {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
  if (lines.some((line) => BOOT_TREE_FAILED.test(line))) {
    const chain = lines
      .filter((line) => /Error|\[cause\]|Cannot find|has been registered/.test(line))
      // 再滤一层：栈帧与"抛错处源码行"也含 "Error"，但它们不是原因（实测这条把
      // `throw new Error(\`${binName}: …`)` 当成了第一行原因，用户读到的是一行源码）。
      .filter((line) => !isChainNoise(line))
      .slice(0, 8)
    const reason = chain[0] ?? lines[0] ?? '未知挂载失败'
    return { kind: 'failed', reason, chain }
  }
  // 层解析不到：明确的失败（不是「判不出来」）。升级 full 的判据靠它。
  if (lines.some((line) => BOOT_UNRESOLVED_LAYER.test(line))) {
    // 真机实测的 stderr 长这样（逐字见 tests 的用例）：先是 Node 的代码帧（file 路径 /
    // throw 那一行源码 / 插入符），然后是真正的消息行 Error: dsh: cannot resolve profile bundle "X" …，
    // 最后是栈帧。旧实现取"第一行含该短语的行"，于是用户读到的"为什么快照起不来"是一行**源码模板**
    // ——里面还是 ${…} 占位符，连是哪个包都看不出来。这里先滤噪声，再在干净行里找消息。
    const clean = lines.filter((line) => !isChainNoise(line))
    const hit = clean.find((line) => BOOT_UNRESOLVED_LAYER.test(line))
      ?? clean[0]
      ?? lines.find((line) => BOOT_UNRESOLVED_LAYER.test(line))
      ?? ''
    return { kind: 'failed', reason: hit, chain: clean.slice(0, 4) }
  }
  if (lines.some((line) => BOOT_TASK_REQUIRED.test(line))) return { kind: 'mounted' }
  return {
    kind: 'undetermined',
    reason: lines.length === 0
      ? '子进程没有输出任何 stderr 文本'
      : '输出里没有可识别的官方特征：' + lines[0],
  }
}

/**
 * 官方 web app 的就绪行（**stdout**，console.log）。
 *
 * 为什么它是可信的挂载凭证：官方在 `connectionCtx.get('loader')?.await()`（Loader settle）
 * **之后**才打印这一行，注释逐字写着它是给 supervisor 的就绪信号。实测形如：
 * `dsh web: http://127.0.0.1:46141/?token=…`。
 *
 * 结尾要求一个空白（`(?=\\s)`）：流式读取不保证按行对齐，半行 URL（`…:461`）不能当成就绪——
 * 官方走 console.log，行尾一定有换行，所以这个要求不会漏掉真信号。
 */
const BOOT_READY_LINE = /dsh web:\s*(https?:\/\/\S+)(?=\s)/

/**
 * 服务形态的启动参数（官方自己的 e2e 与发布脚本同款：`dsh web --no-open --host 127.0.0.1 --port 0`）。
 *
 * `--port 0` 由 OS 分配端口，因此**永不与 GUI 抢 3080**；官方 CLI 只解析启动器自己的标志
 * （--profile / --patch / dump-config），其余参数原样交给树。
 */
const SERVICE_MODE_ARGS = ['--port', '0', '--no-open'] as const

/**
 * 一次验证启动的超时上限。
 *
 * 官方 smoke 用 90s 是在等一个真实服务；我们只等**就绪行**（实测报文 <1s），
 * 所以收在 15s：既是 20 倍余量，也把"判不出来"的等待从 30s 砍到 15s。
 */
export const VERIFY_TIMEOUT_MS = 15_000

/**
 * 验证启动的参数：**按层栈决定形态**（未知参数不能盲加——headless 类环境不认 --port）。
 *
 * @param prefixArgs - 启动器入口自己的参数（`dshEntryPoint().args`）。
 * @param name - 环境名。
 * @param webLayer - 该环境的 web 层判定（environmentWebLayer）。
 * @returns 完整参数表。
 */
export function verificationArgs(
  prefixArgs: readonly string[], name: string, webLayer: WebLayerPresence,
): readonly string[] {
  const base = [...prefixArgs, '--profile', name]
  return webLayer === 'present' ? [...base, ...SERVICE_MODE_ARGS] : base
}

/** 一次验证启动收集到的原始信号（判定只看它，退出码不参与）。 */
export interface BootSignals {
  /** 子进程 stderr 原文。 */
  readonly stderr: string
  /** 子进程 stdout 原文（服务形态的就绪行在这里）。 */
  readonly stdout?: string
  /** 就绪行里的地址（`dsh web: http://…`）；没有信号时 null。 */
  readonly readyUrl?: string | null
  /** 退出码；**仅供展示与排查，不参与判定**（§5.2）。 */
  readonly exitCode: number | null
  /** 是否读到就绪行后主动杀了子进程（服务形态常驻，必须收工）。 */
  readonly killedAfterReady?: boolean
}

/**
 * 从一次启动的原始信号给判定（纯函数，可注入文本测试）。
 *
 * 两类环境各用各的就绪信号，**谁先出现算谁**（谁先出现由启动器决定，见 defaultHeadlessRun）：
 *   · 服务形态：stdout 的官方就绪行 → mounted；
 *   · headless 形态：stderr 的 `dsh: a task is required…` → mounted（走 judgeBootStderr）。
 * 失败一律读 stderr（`plugin tree failed to load` / `cannot resolve profile bundle` + cause 链）；
 * 什么信号都没有 → undetermined（**不许当通过**）。
 *
 * @param signals - 原始信号。
 * @returns 三态判定。
 */
export function judgeBootSignals(signals: BootSignals): BootVerdict {
  if (typeof signals.readyUrl === 'string' && signals.readyUrl.length > 0) return { kind: 'mounted' }
  return judgeBootStderr(signals.stderr)
}

/** 试装的三种结论（§5.2：各有措辞、不得混；无法试装**不算通过**）。 */
export type TrialConclusion =
  /** 基线起得来、装完候选包也起得来 → 通过。 */
  | 'passed'
  /** 快照基线本身就起不来：不是候选包的问题。 */
  | 'baseline-broken'
  /** 基线好、装完候选包起不来：候选包导致的。 */
  | 'candidate-broken'
  /** 无法试装（例如禁用联网且本地 store 没有该包）：**不能算通过**。 */
  | 'cannot-trial'

/**
 * 按受控对照四步给结论（§5.2）。
 *
 * 判定顺序刻意如此：先看基线，再看候选 —— 基线失败时不许赖候选包。
 *
 * @param baseline - 物化快照后的挂载判定；没做基线启动时 null。
 * @param candidate - 装完候选包后的挂载判定；没走到这一步 null。
 * @param cannotTrialReason - 提前失败的原因（如无法下载候选包）；给了就只报「无法试装」。
 * @returns 结论。
 */
export function judgeTrialOutcome(
  baseline: BootVerdict | null,
  candidate: BootVerdict | null,
  cannotTrialReason?: string,
): TrialConclusion {
  if (cannotTrialReason !== undefined) return 'cannot-trial'
  if (baseline !== null && baseline.kind === 'failed') return 'baseline-broken'
  if (baseline !== null && baseline.kind === 'undetermined') return 'cannot-trial'
  if (candidate === null) return 'cannot-trial'
  if (candidate.kind === 'failed') return 'candidate-broken'
  if (candidate.kind === 'undetermined') return 'cannot-trial'
  return 'passed'
}
/** 快照深度（§5.2/§5.3）：自动判定，可强制。 */
export type SnapshotDepth = 'shallow' | 'full'

/**
 * 自动判定快照深度：层栈是否**全部由安装锚点提供**。
 *
 * 判据复用同一套事实（与指纹的 bundlesSource 同源：都是「层从哪里来」），不另起一套：
 *   · 某一层出现在 <dir>/node_modules 里 → 它是 profile 自己装的（第三方 bundle），
 *     浅快照（只复制清单）复现不出来 → full；
 *   · 否则试官方解析 resolveBundleDir：能从安装锚点解析到 → 浅快照够用 → shallow。
 * 拿不到锚点、或解析失败 → 一律 full（写多不写少）。
 *
 * @param dir - 真实环境目录。
 * @param bundles - 该环境的层栈。
 * @param installAnchor - 官方安装锚点（package.json 路径）。
 * @returns 深度。
 */
export function snapshotDepthFor(
  dir: string, bundles: readonly string[], installAnchor?: string,
): SnapshotDepth {
  if (installAnchor === undefined || installAnchor.length === 0) return 'full'
  for (const name of bundles) {
    if (existsSync(join(dir, 'node_modules', name, 'package.json'))) return 'full'
    try {
      resolveBundleDir(OUR_PACKAGE_NAME, name, installAnchor, dir)
    } catch {
      return 'full'
    }
  }
  return 'shallow'
}

/** 快照物化的结果。 */
export interface SnapshotMaterialization {
  readonly depth: SnapshotDepth
  /** 从真实环境复制过来的文件名。 */
  readonly copied: readonly string[]
  /** 物化前清掉的**上一次物化残留**（例如 node_modules）：快照不能带着旧依赖。 */
  readonly cleared: readonly string[]
  /** 是否跑了官方 pnpm 通道（full 深度时）。 */
  readonly installed: boolean
  /** 面向用户的说明。 */
  readonly output: string
}

/** 浅快照复制的文件（§5.2 实测：新建 profile 只有前三个，没有 node_modules）。 */
const SNAPSHOT_FILES = ['package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'] as const

/**
 * 物化前必须清掉的**残留** —— 也就是**只有物化过程自己会造出来**的那两项：
 *   · `node_modules`：上一次完整快照装的依赖（浅快照本不该有依赖，留着会让金丝雀假通过）；
 *   · `pnpm-lock.yaml`：上一次完整快照生成的锁文件（源环境没有它时，留着会把快照钉在旧状态）。
 *
 * 刻意**不动** `package.json` / `cordis.yml` / `cordis.patch.yml` / `pnpm-workspace.yaml`：
 * 它们是官方 initProfile 建出来的**profile 骨架**（本机实测：新建 profile 里就是
 * package.json + cordis.patch.yml + pnpm-workspace.yaml 三个），而且 pnpm-workspace.yaml 带着
 * `nodeLinker: hoisted` / `autoInstallPeers: false` 这类**会改变 pnpm 行为**的设置——
 * 删掉它会让我们在测试环境里用另一套安装语义去验证（那才是真的失真）。
 * 源环境有这些文件时，复制那一步会把它们覆盖成源环境的版本。
 */
const SNAPSHOT_STALE_ENTRIES = ['node_modules', 'pnpm-lock.yaml'] as const

/** materializeSnapshot 的选项。 */
export interface MaterializeSnapshotOptions extends CrossEnvironmentOptions {
  /** 强制深度；省略 = 自动判定。 */
  readonly depth?: SnapshotDepth
  /** 层栈来源（官方 listBundles()）；拿不到就用源环境的清单，够自动判定用。 */
  readonly bundlesOf?: (name: string) => Promise<readonly string[]>
}

/**
 * 把真实环境物化成测试环境（§5.4 同步原则：不订阅变化，用时即时物化）。
 *
 * 浅快照只复制清单文件；full 深度再走**官方 runPluginCommand** 装依赖（绝不自己调 pnpm 二进制）。
 * 官方通道不可用或失败时如实抛出 —— 调用方据此报「无法试装」，不许静默当成功。
 *
 * @param sourceName - 真实环境名。
 * @param targetName - 测试环境名（应等于 trialEnvironmentName(sourceName)）。
 * @param options - 深度、层栈来源与官方通道注入。
 * @returns 物化结果。
 */
export async function materializeSnapshot(
  sourceName: string, targetName: string, options: MaterializeSnapshotOptions = {},
): Promise<SnapshotMaterialization> {
  const sourceDir = environmentDir(sourceName)
  const targetDir = environmentDir(targetName)
  if (!existsSync(join(targetDir, 'package.json'))) {
    throw new EnvironmentError('not-found', '测试环境不存在：' + targetName + '（先 createTrialEnvironment）')
  }
  const manifest = readEnvironmentManifest(sourceDir)
  const bundles = options.bundlesOf === undefined ? manifest.bundles : await options.bundlesOf(sourceName)
  const anchor = options.installAnchor ?? profileContextOf(options.ctx)?.installAnchor
  const depth = options.depth ?? snapshotDepthFor(sourceDir, bundles, anchor)

  // 物化前先清掉**上一次物化留下的东西**：测试环境是被复用的（§5.4 一个真实环境一个测试环境），
  // 上一次的完整快照会在里面留下 node_modules —— 不清的话这次"浅快照"其实带着旧依赖，
  // 于是本该抓出来的依赖缺失被残留掩盖（金丝雀假通过）。删不掉就**如实报无法试装**，绝不静默沿用。
  const cleared: string[] = []
  for (const stale of SNAPSHOT_STALE_ENTRIES) {
    const path = join(targetDir, stale)
    if (!existsSync(path)) continue
    try {
      rmSync(path, { recursive: true, force: true })
    } catch (error) {
      throw new EnvironmentError('snapshot-not-shallow',
        '快照要求目录里只有源环境现在的清单，但上一次物化留下的 ' + stale + ' 删不掉（' + messageOf(error)
        + '）：不能带着旧依赖去验证（那会让结论假通过），这次试装报无法试装。')
    }
    if (existsSync(path)) {
      throw new EnvironmentError('snapshot-not-shallow',
        '快照要求目录里只有源环境现在的清单，但上一次物化留下的 ' + stale + ' 删完之后仍然在：'
        + '不能带着旧依赖去验证（那会让结论假通过），这次试装报无法试装。')
    }
    cleared.push(stale)
  }

  const copied: string[] = []
  for (const file of SNAPSHOT_FILES) {
    const from = join(sourceDir, file)
    if (!existsSync(from)) continue
    copyFileSync(from, join(targetDir, file))
    copied.push(file)
  }
  const clearedNote = cleared.length === 0 ? '' : '；并清掉了上一次物化留下的 ' + cleared.join('、')

  if (depth === 'shallow') {
    return {
      depth, copied, cleared, installed: false,
      output: '已物化浅快照（复制 ' + (copied.length === 0 ? '无' : copied.join(', ')) + clearedNote
        + '）：浅快照不含依赖，层栈全部由安装锚点提供',
    }
  }
  let runner: PluginCommandRunner
  let context: PackageOperationContext
  try {
    context = operationContext(targetName, targetDir, targetDir, options)
    runner = await officialRunner(options)
  } catch (error) {
    throw new EnvironmentError(
      error instanceof EnvironmentError ? error.code : 'official-unavailable',
      '真实快照需要官方 pnpm 通道，但不可用：' + messageOf(error),
    )
  }
  const result = await runPackageOperation(runner, context, ['install', '--prefer-offline'], options)
  if (result.exitCode !== 0) {
    throw new EnvironmentError('package-operation-failed',
      '真实快照的官方安装失败（exitCode=' + String(result.exitCode) + '）：' + result.output.trim().slice(-500))
  }
  return {
    depth, copied, cleared, installed: true,
    output: '已物化真实快照（复制 ' + (copied.length === 0 ? '无' : copied.join(', ')) + clearedNote
      + '；官方 install --prefer-offline 成功）',
  }
}

/** createTrialEnvironment 的选项。 */
export interface CreateTrialEnvironmentOptions {
  /** 建立后是否立即物化快照（默认 true）。 */
  readonly materialize?: boolean
  /** 物化选项。 */
  readonly snapshot?: MaterializeSnapshotOptions
}

/**
 * 建立/复用某个真实环境的测试环境（§5.4：一个真实环境一个测试环境）。
 *
 * @param realName - 真实环境名。
 * @param options - 物化选项。
 * @returns 结果（output 含快照深度与文件清单）。
 */
export async function createTrialEnvironment(
  realName: string, options: CreateTrialEnvironmentOptions = {},
): Promise<EnvironmentResult> {
  const problem = environmentNameProblem(realName)
  if (problem !== null) return failure('invalid-name', problem)
  if (isTrialEnvironmentName(realName)) {
    return failure('invalid-name', realName + ' 本身就是测试环境名，不能再建一层')
  }
  const target = trialEnvironmentName(realName)
  const exists = existsSync(join(environmentDir(target), 'package.json'))
  const created = exists ? success('测试环境已存在：' + target) : await createEnvironment(target, 'headless')
  if (!created.ok) return created
  if (options.materialize === false) return success(created.output + '\n（未物化快照）')
  try {
    const snapshot = await materializeSnapshot(realName, target, options.snapshot ?? {})
    return success(created.output + '\n' + snapshot.output)
  } catch (error) {
    return failure(error instanceof EnvironmentError ? error.code : 'io-failed',
      '测试环境已建立但物化快照失败：' + messageOf(error))
  }
}
/** removeTrialEnvironment 的选项。 */
export interface RemoveTrialEnvironmentOptions extends CurrentEnvironmentOptions {
  /** 注入进程事实（测试）；省略时自行读取（fresh）。 */
  readonly facts?: ProcessFacts
}

/**
 * 删除一个测试环境（§5.4：**删除必须安全**）。
 *
 * 三重纪律：
 *  1. 只删形如 <真实名>-dpmc 的环境（裸后缀不算：没有归属的目录不能进删除路径）；
 *  2. 运行中先拒 —— 不做「先停后删」的隐式动作，停是用户的显式决定；
 *  3. 进程事实不可读 → 拒绝（**未知状态下绝不动磁盘**，与 stop/remove 同一条纪律）。
 * 孤儿（真实环境已改名或删除）**可以删**：归属核对的是「名字形态 + 这是我们建的测试环境」，
 * 不是「真实环境还在」。
 *
 * @param name - 测试环境名。
 * @param options - 当前环境事实与进程事实注入。
 * @returns 操作结果。
 */
export async function removeTrialEnvironment(
  name: string, options: RemoveTrialEnvironmentOptions = {},
): Promise<EnvironmentResult> {
  const problem = environmentNameProblem(name)
  if (problem !== null) return failure('invalid-name', problem)
  if (!isTrialEnvironmentName(name)) {
    return failure('invalid-name', name + ' 不是测试环境名（必须是 <真实环境名>' + TRIAL_ENVIRONMENT_SUFFIX + '）')
  }
  const dir = environmentDir(name)
  if (!existsSync(dir)) return failure('not-found', '测试环境不存在：' + name)
  const current = resolveCurrent(options)
  if (sameEnvironment(current, name)) {
    return failure('current', name + ' 是当前正在运行的环境，不能删除（要删请先停止本进程）')
  }
  const facts = options.facts ?? processFacts({ fresh: true })
  if (!facts.readable) {
    return failure('facts-unavailable', name + ' 的运行状态未知：进程事实读不到（'
      + String(facts.reason) + '）。拒绝在未知状态下删除测试环境。')
  }
  const busy = runsForName(facts.runs, name)
  if (busy.length > 0) {
    return failure('running', name + ' 正在运行（pid ' + busy.map((run) => run.pid).join(', ')
      + '），请先停止再删除测试环境')
  }
  return enqueueMutation(async () => {
    try {
      await retryFs(() => rmSync(dir, { recursive: true, force: true }))
    } catch (error) {
      return failure('io-failed', '删除测试环境失败 ' + name + '：' + messageOf(error))
    }
    resetRunCache()
    return success('已删除测试环境 ' + name)
  })
}

/** 清理候选：全部读盘得来（mtime 取目录自身）。 */
export interface TrialCleanupCandidate {
  readonly name: string
  /** 归属的真实环境名（名字形态推出）。 */
  readonly owner: string
  /** 目录 mtime（毫秒）。 */
  readonly modifiedAt: number
  readonly running: boolean
}

/** 默认保留天数（§5.3：默认开 / 14 天，可关可配）。 */
export const DEFAULT_TRIAL_RETENTION_DAYS = 14

/** planTrialCleanup 的选项。 */
export interface TrialCleanupPlanOptions {
  /** 当前时间（毫秒）；注入供测试。 */
  readonly now?: number
  /** 保留天数；null 表示用户关掉了自动清理。 */
  readonly retainDays?: number | null
}

/** 一份清理计划：删什么、留什么，各自带原因。 */
export interface TrialCleanupPlan {
  readonly remove: readonly { readonly name: string; readonly reason: string }[]
  readonly keep: readonly { readonly name: string; readonly reason: string }[]
}

/**
 * 算一份测试环境清理计划（纯函数，便于正反用例测试）。
 *
 * 只按「到没到保留期」与「是否在跑」两个事实判；运行中的永远保留（删除安全优先）。
 * `retainDays: null` = 用户关掉了自动清理：什么都不删，但仍把候选列出来给界面显示。
 *
 * @param candidates - 候选（读盘事实）。
 * @param options - 时间与保留期。
 * @returns 计划。
 */
export function planTrialCleanup(
  candidates: readonly TrialCleanupCandidate[], options: TrialCleanupPlanOptions = {},
): TrialCleanupPlan {
  const now = options.now ?? Date.now()
  const retainDays = options.retainDays === undefined ? DEFAULT_TRIAL_RETENTION_DAYS : options.retainDays
  const remove: { name: string; reason: string }[] = []
  const keep: { name: string; reason: string }[] = []
  for (const candidate of candidates) {
    if (candidate.running) {
      keep.push({ name: candidate.name, reason: '正在运行：不删（先让用户停）' })
      continue
    }
    if (retainDays === null) {
      keep.push({ name: candidate.name, reason: '自动清理已关闭' })
      continue
    }
    const ageDays = (now - candidate.modifiedAt) / 86_400_000
    if (ageDays < retainDays) {
      keep.push({ name: candidate.name, reason: '未到保留期（' + ageDays.toFixed(1) + ' 天 < ' + String(retainDays) + ' 天）' })
      continue
    }
    remove.push({ name: candidate.name, reason: '超过保留期 ' + String(retainDays) + ' 天（' + ageDays.toFixed(1) + ' 天）' })
  }
  return { remove, keep }
}

/**
 * 列出所有测试环境候选（读盘；进程事实不可读时按「未知」处理 → 全部保留）。
 *
 * @param options - 进程事实注入（测试）。
 * @returns 候选列表与进程事实的可读性。
 */
export function listTrialEnvironments(
  options: { readonly facts?: ProcessFacts } = {},
): { readonly candidates: readonly TrialCleanupCandidate[]; readonly factsReadable: boolean; readonly reason?: string } {
  const facts = options.facts ?? processFacts()
  const candidates: TrialCleanupCandidate[] = []
  let names: string[]
  try {
    names = readdirSync(profilesRoot())
  } catch {
    return { candidates, factsReadable: facts.readable, ...facts.reason === undefined ? {} : { reason: facts.reason } }
  }
  for (const name of names) {
    if (!isTrialEnvironmentName(name)) continue
    const dir = environmentDir(name)
    let modifiedAt = 0
    try {
      modifiedAt = statSync(dir).mtimeMs
    } catch {
      continue
    }
    candidates.push({
      name,
      owner: trialEnvironmentOwner(name) ?? '',
      modifiedAt,
      // 事实不可读时不能声称「没在跑」：按最保守处理，标成 running 让清理计划保留它。
      running: facts.readable ? runsForName(facts.runs, name).length > 0 : true,
    })
  }
  return { candidates, factsReadable: facts.readable, ...facts.reason === undefined ? {} : { reason: facts.reason } }
}

/**
 * 执行清理（§5.4：删除动作**记日志**）。
 *
 * @param options - 计划选项 + 日志回调。
 * @returns 结果（删了哪些、留了哪些）。
 */
export async function cleanupTrialEnvironments(options: TrialCleanupPlanOptions & {
  readonly facts?: ProcessFacts
  readonly log?: (line: string) => void
} = {}): Promise<EnvironmentResult & { readonly removed: readonly string[] }> {
  const listed = listTrialEnvironments(options)
  const plan = planTrialCleanup(listed.candidates, options)
  const logLine = (line: string): void => {
    options.log?.(line)
    try {
      appendFileSync(join(dshHome(), 'dpmc-trial-cleanup.log'),
        new Date().toISOString() + ' ' + line + '\n', { mode: 0o600 })
    } catch {
      // 日志失败不阻断清理：删除本身已受三重纪律保护。
    }
  }
  const removed: string[] = []
  const failures: string[] = []
  for (const entry of plan.remove) {
    const result = await removeTrialEnvironment(entry.name, { facts: options.facts })
    if (result.ok) {
      removed.push(entry.name)
      logLine('removed ' + entry.name + '：' + entry.reason)
    } else {
      failures.push(entry.name + '（' + String(result.code) + '）')
      logLine('kept ' + entry.name + '：删除被拒（' + String(result.code) + '）')
    }
  }
  // 整块留（copy-dev 复核结论）：计数与「保留明细」里的原因是用户判断"为什么留着"的唯一依据。
  const lines = ['测试环境清理：删除 ' + String(removed.length) + ' 个'
    + (removed.length === 0 ? '' : '（' + removed.join(', ') + '）')
    + '，保留 ' + String(plan.keep.length + failures.length) + ' 个']
  if (failures.length > 0) lines.push('删除被拒：' + failures.join('；'))
  lines.push('保留明细：' + plan.keep.map((entry) => entry.name + '（' + entry.reason + '）').join('；'))
  return { ok: failures.length === 0, output: lines.join('\n'), removed }
}

// ── 试装：无头验证与四步编排 ──────────────────────────────────────────────

/**
 * 构建指纹（CODE-POLICY §7.8 / DEVELOPMENT §87）：真机结论必须钉在一次具体构建上。
 *
 * 产物 md5 取本模块被打进的那份文件（安装到用户环境里也能算），git HEAD 只在能读到仓库时带上，
 * 读不到就 null —— 如实标「不知道这份构建对应哪个 commit」，不编。
 */
export interface BuildIdentity {
  /** 本模块产物的 md5（dist/<file>.js）。 */
  readonly artifactMd5: string | null
  /** 产物文件 mtime（ISO）。 */
  readonly artifactMtime: string | null
  /** git HEAD；读不到仓库时为 null。 */
  readonly gitHead: string | null
}

/**
 * 算当前构建的指纹。
 *
 * @returns 构建指纹。
 */
export function buildIdentity(): BuildIdentity {
  let artifactMd5: string | null = null
  let artifactMtime: string | null = null
  let here: string | null = null
  try {
    here = fileURLToPath(import.meta.url)
    artifactMd5 = createHash('md5').update(readFileSync(here)).digest('hex')
    artifactMtime = new Date(statSync(here).mtimeMs).toISOString()
  } catch {
    // 读不到自己的产物（极少见）：如实 null。
  }
  let gitHead: string | null = null
  if (here !== null) {
    let dir = dirname(here)
    for (let depth = 0; depth < 6 && gitHead === null; depth += 1) {
      try {
        const head = readFileSync(join(dir, '.git', 'HEAD'), 'utf8').trim()
        const ref = /^ref:\s*(.+)$/.exec(head)
        gitHead = ref === null
          ? head.slice(0, 40)
          : readFileSync(join(dir, '.git', ref[1]!), 'utf8').trim().slice(0, 40)
      } catch {
        dir = dirname(dir)
      }
    }
  }
  return { artifactMd5, artifactMtime, gitHead }
}

/** 一次无头验证的结果（判定 + 证据）。 */
export interface BootVerification {
  readonly verdict: BootVerdict
  /** 实测耗时（毫秒）。 */
  readonly elapsedMs: number
  /** 子进程 stderr 原文（截断到 8KiB，供展示与判定复核）。 */
  readonly stderr: string
  /** 子进程 stdout 原文（截断到 8KiB）；服务形态的就绪行在这里。老调用点可省略。 */
  readonly stdout?: string
  /** 就绪行里的地址（服务形态）；没有信号时 null。 */
  readonly readyUrl?: string | null
  /** 是否读到就绪行后主动杀了子进程（服务形态常驻，必须收工）。 */
  readonly killedAfterReady?: boolean
  /** 退出码；**仅供展示与排查，不参与判定**（§5.2）。 */
  readonly exitCode: number | null
  /** 本次验证所在的构建指纹。 */
  readonly build: BuildIdentity
}

/** runHeadlessVerification 的选项。 */
export interface HeadlessVerificationOptions {
  /** 超时上限；默认 VERIFY_TIMEOUT_MS（15s）。 */
  readonly timeoutMs?: number
  /**
   * 启动器注入（测试）：省略时真起进程。
   * stdout / readyUrl / killedAfterReady 是服务形态那一路的证据，可以省略（headless 形态用不到）。
   */
  readonly run?: (name: string) => Promise<{
    readonly stderr: string
    readonly exitCode: number | null
    readonly stdout?: string
    readonly readyUrl?: string | null
    readonly killedAfterReady?: boolean
  }>
}

/**
 * 无头验证一个环境（§5.2 的形态，不得偏离）。
 *
 * 形态：`<dsh> --profile <name>`，**不给任何任务文本**（给了就是真跑一轮 agent，花用户的钱），
 * stdin=/dev/null，捕获 stderr；判定只读 stderr 特征（退出码不参与）。
 *
 * @param name - 环境名。
 * @param options - 超时与启动器注入。
 * @returns 验证结果。
 */
export async function runHeadlessVerification(
  name: string, options: HeadlessVerificationOptions = {},
): Promise<BootVerification> {
  const build = buildIdentity()
  const started = Date.now()
  const run = options.run ?? defaultHeadlessRun(options.timeoutMs ?? VERIFY_TIMEOUT_MS)
  let signals: BootSignals = { stderr: '', exitCode: null, stdout: '', readyUrl: null }
  try {
    const result = await run(name)
    signals = {
      stderr: result.stderr,
      exitCode: result.exitCode,
      stdout: result.stdout ?? '',
      readyUrl: result.readyUrl ?? null,
      killedAfterReady: result.killedAfterReady ?? false,
    }
  } catch (error) {
    return {
      verdict: { kind: 'undetermined', reason: '启动失败：' + messageOf(error) },
      elapsedMs: Date.now() - started, stderr: '', stdout: '', readyUrl: null, killedAfterReady: false,
      exitCode: null, build,
    }
  }
  return {
    verdict: judgeBootSignals(signals),
    elapsedMs: Date.now() - started,
    stderr: signals.stderr.slice(-8192),
    stdout: (signals.stdout ?? '').slice(-8192),
    readyUrl: signals.readyUrl ?? null,
    killedAfterReady: signals.killedAfterReady ?? false,
    exitCode: signals.exitCode,
    build,
  }
}

/** 失败特征：出现在 stderr 里的这两条，谁先出现算谁（就绪行之后才出现的失败不算挂载失败）。 */
const BOOT_FAILURE_HINT = /plugin tree failed to load|cannot resolve profile bundle/

/** 边收边判的启动信号收集器（纯逻辑，可按 chunk 驱动测试）。 */
export interface BootSignalCollector {
  /** 收一段 stderr。 */
  pushStderr(chunk: string): void
  /**
   * 收一段 stdout；返回**本次是否新认出就绪行**（调用方据此收工）。
   *
   * 两条纪律：
   *   · 就绪行可能跨 chunk（官方一行也是一个 write，但流式读取不保证对齐）→ 每次都在累积文本里找；
   *   · stderr 里已经出现失败特征时，**不再认**后来的就绪行（谁先出现算谁）。
   */
  pushStdout(chunk: string): boolean
  readonly readyUrl: string | null
  readonly stderr: string
  readonly stdout: string
}

/**
 * 造一个启动信号收集器。
 *
 * 为什么把它抽出来：就绪行的识别是"跨 chunk"和"顺序"两件事，真机跑一次证明不了边界，
 * 而这两条边界恰恰是最容易写错的（先来的失败被后来的就绪行盖掉、半行就绪行被漏掉）。
 *
 * @returns 收集器。
 */
export function createBootSignalCollector(): BootSignalCollector {
  let stderrText = ''
  let stdoutText = ''
  let readyUrl: string | null = null
  return {
    pushStderr(chunk) { stderrText += chunk },
    pushStdout(chunk) {
      stdoutText += chunk
      if (readyUrl !== null) return false
      if (BOOT_FAILURE_HINT.test(stderrText)) return false
      const hit = BOOT_READY_LINE.exec(stdoutText)
      if (hit === null) return false
      readyUrl = hit[1] ?? 'http://（就绪行里没带地址）'
      return true
    },
    get readyUrl() { return readyUrl },
    get stderr() { return stderrText },
    get stdout() { return stdoutText },
  }
}

/**
 * 默认启动器：真起一个实例，按层栈读**对应的就绪信号**。
 *
 * 两类环境（§5.2，2026-09-19 真机改定）：
 *   · **含 web 层** → 服务形态（`--port 0 --no-open`）：官方 CLI 只解析启动器自己的标志，
 *     其余参数原样交给树；`--port 0` 让 OS 分配端口，永不与 GUI 抢 3080。就绪 = **stdout** 的
 *     `dsh web: http://…`（Loader settle 之后才打印），读到即判 mounted 并**立刻杀子进程**
 *     （服务形态不会自己退，等下去只会超时）。
 *   · **headless 类** → 缺任务形态（只有 `--profile`）：真挂载整棵树后以"缺任务"收场，
 *     就绪 = stderr 的 `dsh: a task is required…`（原判据不变）。
 * 两种形态都**绝不传任务文本**（§5.2）。
 *
 * @param timeoutMs - 超时上限（超时杀掉 → 无法判定，不许当成功）。
 * @returns 启动函数。
 */
function defaultHeadlessRun(
  timeoutMs: number,
): (name: string) => Promise<{ readonly stderr: string; readonly stdout: string; readonly readyUrl: string | null; readonly killedAfterReady: boolean; readonly exitCode: number | null }> {
  return async (name) => {
    const dir = environmentDir(name)
    const webLayer = environmentWebLayer(dir, readEnvironmentManifest(dir).bundles)
    const entryPoint = dshEntryPoint()
    const args = verificationArgs(entryPoint.args, name, webLayer)
    const invocation = entryPoint.shell
      ? windowsShimInvocation({ ...emptyLaunchSpec(name), command: entryPoint.command, args, shell: true })
      : { command: entryPoint.command, args }
    return await new Promise((done, fail) => {
      const child = spawn(invocation.command, [...invocation.args], {
        // stdout 也要读：服务形态的就绪行走 console.log（stdout），不是 stderr。
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      })
      const collector = createBootSignalCollector()
      let killedAfterReady = false
      let settled = false
      let timer: NodeJS.Timeout | undefined
      const finish = (exitCode: number | null): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        done({
          stderr: collector.stderr, stdout: collector.stdout,
          readyUrl: collector.readyUrl, killedAfterReady, exitCode,
        })
      }
      timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* 已退出 */ }
        finish(null)
      }, timeoutMs)
      child.stdout?.on('data', (chunk: Buffer) => {
        if (settled) return
        if (!collector.pushStdout(chunk.toString('utf8'))) return
        // 读到官方就绪行：树已经 settle、服务已经起来 —— 立刻收工（服务形态不会自己退）。
        killedAfterReady = true
        try { child.kill('SIGKILL') } catch { /* 已退出 */ }
        finish(null)
      })
      child.stderr?.on('data', (chunk: Buffer) => { collector.pushStderr(chunk.toString('utf8')) })
      child.once('error', (error) => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        fail(error)
      })
      child.once('close', (code) => { finish(code) })
    })
  }
}

/** 一个只用来满足启动器签名的空壳（defaultHeadlessRun 只用到 name/命令）。 */
function emptyLaunchSpec(name: string): LaunchSpec {
  return {
    profile: name, port: 0, mode: 'background', command: '', args: [], entry: null, shell: false,
    dir: environmentDir(name), display: '',
  }
}
/** runTrialInstall 的选项。 */
export interface TrialInstallOptions extends Omit<MaterializeSnapshotOptions, 'depth'> {
  /**
   * 深度策略：auto（默认，先浅快照、基线明确失败再升级 full）/ shallow / full。
   *
   * 为什么 auto 不再先问「锚点能否解析」：实测这条谓词对**原装环境一律返回 full**
   * （官方层由安装锚点供给，但 resolveBundleDir 在这台机器上解析不到它们），
   * 于是 shallow 成了走不到的分支，而 shallow 真机又能挂载（526ms）。
   * 改成**以启动为判据**（Lead 授权）：先 shallow；基线**明确 failed** 才升级 full，
   * 升级后仍不 mounted 才报 baseline-broken（文案写明两种快照都试过）。
   * undetermined（超时/无可识别特征）**不升级** —— 那是「判不出来」，如实报。
   */
  readonly depth?: 'auto' | 'shallow' | 'full'
  /** 官方层栈事实（算指纹用）；只在测当前环境时可用。 */
  readonly listBundles?: () => Promise<readonly string[]>
  /** 是否做基线启动（§5.2 四步的②）；默认 true —— 关掉省 ~558ms，但失败时说不清是谁的问题。 */
  readonly baseline?: boolean
  /** 是否允许联网拉取候选包（§5.3）；false 时只用本地 store，冷包直接判「无法试装」。 */
  readonly allowNetwork?: boolean
  /** 无头验证注入（测试）。 */
  readonly verify?: (name: string) => Promise<BootVerification>
  /** 时钟注入（测试）。 */
  readonly now?: () => number
}

/** 试装结果：结论 + 证据 + 构建指纹（§7.8 真机结论必须钉在一次具体构建上）。 */
export interface TrialInstallResult {
  readonly conclusion: TrialConclusion
  readonly output: string
  /** 本次结论对应的构建（产物 md5 + mtime + 能读到时的 git HEAD）。 */
  readonly build: BuildIdentity
  /** 试装前的源环境指纹。 */
  readonly sourceFingerprint: EnvironmentFingerprint
  /** 试装后再算的源环境指纹（§5.4 第 4 步）。 */
  readonly sourceFingerprintAfter: EnvironmentFingerprint | null
  /** 试装期间源环境又变过（结论可能不适用）。 */
  readonly changedDuringTrial: boolean
  readonly baseline: BootVerdict | null
  readonly candidate: BootVerdict | null
  readonly elapsedMs: number
  /** 结论实际基于哪种快照深度。 */
  readonly depth: SnapshotDepth
  /** 是否发生过 shallow → full 的升级（只在基线明确失败时）。 */
  readonly escalated: boolean
  /** 浅快照不给力的原因（升级时给出，取失败判定的第一行）。 */
  readonly escalationReason?: string
  /** 卸包那一步的说明（task-84：让候选成为"新装"，做了/没做/失败都如实写）。 */
  readonly detached?: string
  /**
   * 候选的激活事实（进没进层栈）。拿到就带上，供调用方与界面判断"这次到底验证到了没有"。
   */
  readonly activation?: TrialActivationFact
}

/**
 * 读测试环境当前的依赖名（读不到时返回空数组——守卫会据此如实报"没有出现候选"）。
 *
 * @param target - 测试环境名。
 * @returns 依赖名列表。
 */
function trialDependencies(target: string): readonly string[] {
  try {
    const manifest = readProfileManifest(OUR_PACKAGE_NAME, environmentDir(target)) as { dependencies?: Record<string, unknown> }
    return Object.keys(manifest.dependencies ?? {})
  } catch {
    return []
  }
}

/**
 * 从候选 spec 认出**包名**（守卫要在依赖清单里对上号）。
 *
 * 三种形态：路径 spec（`link:` / `file:` / 裸相对路径）读目标目录的 package.json；
 * registry spec（`name` 或 `name@version`，含 scope）取名字部分；读不到就 undefined
 * （守卫会如实报"没有出现候选"，不猜）。
 *
 * @param spec - 候选包 spec。
 * @returns 包名；认不出来时 undefined。
 */
function candidateName(spec: string): string | undefined {
  const bare = spec.replace(/^(?:link:|file:|workspace:)/, '')
  const looksLikePath = spec.startsWith('link:') || spec.startsWith('file:') || spec.startsWith('.') || bare.startsWith('/')
  if (looksLikePath) {
    const dir = isAbsolute(bare) ? bare : resolve(process.cwd(), bare)
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }
      return typeof manifest.name === 'string' && manifest.name.length > 0 ? manifest.name : undefined
    } catch {
      return undefined
    }
  }
  const at = bare.lastIndexOf('@')
  return at > 0 ? bare.slice(0, at) : bare
}

/**
 * 候选在试装环境里的激活事实（"装上了"不等于"验证到了"的判据，可下发给界面）。
 */
export interface TrialActivationFact {
  /** 候选包名；认不出来时 undefined。 */
  readonly name: string | undefined
  /** 装完之后测试环境的层栈（dsh.profile.bundles）。 */
  readonly bundles: readonly string[]
  /** 候选是否真的进了层栈（false = 挂载期不会加载它，这次验证不作数）。 */
  readonly activated: boolean
  /** 是否为了让候选成为"新装"而先走了官方 remove。 */
  readonly removedFirst: boolean
  /** 卸包那一步的说明（做了/没做/失败，都如实写）。 */
  readonly detachNote: string
}

/** 试装环境里"候选是否真的进入了组合层栈"的核对结果。 */
interface TrialActivation {
  /** 核对通过（候选确实进了层栈，挂载期会加载它）。 */
  readonly ok: boolean
  /** 不通过时的可读原因（面向用户）。 */
  readonly detail: string
  /** 盘上事实（成功与失败都带，供结果与界面使用）。 */
  readonly fact: TrialActivationFact
}

/**
 * 把候选从**测试环境**的依赖里摘掉，使它成为"新装"，从而被官方 reconcile 真正写进层栈。
 *
 * 为什么必须有这一步（真机缺陷，task-84 阻断级）：官方 reconcile **跳过 `beforeDeps` 里已有的依赖**
 * （lib/types/operations.js 的 reconcile：`if (beforeDeps.has(name)) continue`）。而试装快照是从
 * **源环境**物化的，`SNAPSHOT_FILES` 含 `package.json`——当候选已经在源环境里时（gatedInstall
 * 的顺序是"先 installBundle 落进源环境、再试装"；升级场景更是天然如此），候选在物化那一刻
 * **就已经在测试环境的 dependencies 里**。于是试装那次 add 无事可做（pnpm 日志里没有候选那一行），
 * reconcile 跳过它 → 它进不了 `dsh.profile.bundles` → 挂载期不加载它 → 旧代码照样启动成功。
 *
 * 后果是阻断级的：试装开 + block（两个默认档）时**任何安装都被拦下**，而 `candidate-broken`
 * 变得不可达——质量门第二步从"验证"退化成"永远拦下"。
 *
 * 所以"让候选成为新装"是试装成立的前提，不是可选的优化。走的是**同一条官方通道** `remove`
 * （绝不自己调 pnpm）；卸不掉也不阻断——那时层栈事实会如实反映"它没进层栈"，由守卫报 cannot-trial。
 *
 * @param runner - 官方运行器。
 * @param context - 官方 operations 调用参数（测试环境）。
 * @param options - 输出与取消策略。
 * @param target - 测试环境名。
 * @param spec - 候选 spec。
 * @returns 是否真的卸掉了，以及面向用户的说明。
 */
async function detachCandidate(
  runner: PluginCommandRunner, context: PackageOperationContext, options: CrossEnvironmentOptions,
  target: string, spec: string,
): Promise<{ readonly removed: boolean; readonly note: string }> {
  const name = candidateName(spec)
  if (name === undefined) {
    return { removed: false, note: '认不出候选包名（' + spec + '）：没有先卸包，装它时按"新装"处理。' }
  }
  if (trialDependencies(target).includes(name)) {
    const removal = await runPackageOperation(runner, context, ['remove', name], options)
    if (removal.exitCode === 0) {
      return {
        removed: true,
        note: '已先走官方通道卸掉 ' + name + '，使候选成为"新装"'
          + '（否则官方 reconcile 会跳过"既有依赖"，候选进不了层栈，这次试装等于什么都没验证）。',
      }
    }
    return {
      removed: false,
      note: '官方卸包失败（退出码 ' + String(removal.exitCode) + '），候选可能仍被当作"既有依赖"：'
        + removal.output.trim().slice(-200),
    }
  }
  return { removed: false, note: '候选本来就不在测试环境的依赖里，装它天然是"新装"。' }
}

/**
 * 候选装完之后，核对它是否**真的进入了组合层栈**（`dsh.profile.bundles`）。
 *
 * 为什么必须有这条守卫（真机缺陷，task-80）：官方 `runProfilePnpm` 的 reconcile 只在
 * `activateNewBundles !== false` 时执行，且会**跳过 `beforeDeps` 里已有的依赖**
 * （packages/boot/plugin-manager/src/operations.ts:160 与 :82-93）。测试环境被复用、
 * 或上一轮回滚留下残留时，候选已在 `dependencies` 里 → 永远进不了层栈 →
 * 挂载期从不加载它 → 坏候选也会被判 `passed`（假通过）。
 *
 * 所以"装上了"不等于"验证到了"：这里以**盘上的层栈事实**为准，没进层栈就不许算通过。
 *
 * 与 {@link detachCandidate} 的分工：那一步负责**让正常路径走通**（把候选变成新装），
 * 这一条负责**兜住任何仍然没进层栈的情况**（摘不掉、候选不声明 dsh.bundle、测试环境有残留…）。
 * 两者都要有：只修顺序会漏掉"候选本来就不声明 bundle"这类，只留守卫则正常安装全被误拦。
 *
 * @param target - 测试环境名。
 * @param beforeDeps - 装候选包之前的依赖名集合。
 * @param spec - 候选包 spec（用于在依赖里认出它）。
 * @param detached - 是否已先卸包（卸过就不该再判成"既有的"）。
 * @returns 核对结果；不通过时带原因。
 */
function trialActivation(
  target: string, beforeDeps: readonly string[], spec: string, detached: { readonly removed: boolean; readonly note: string },
): TrialActivation {
  const candidate = candidateName(spec)
  let manifest: { dependencies?: Record<string, unknown>; dsh?: { profile?: { bundles?: readonly string[] } } }
  try {
    manifest = readProfileManifest(OUR_PACKAGE_NAME, environmentDir(target)) as typeof manifest
  } catch (error) {
    return {
      ok: false,
      detail: '读不到测试环境的 package.json（' + messageOf(error) + '）。',
      fact: { name: candidate, bundles: [], activated: false, removedFirst: detached.removed, detachNote: detached.note },
    }
  }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const deps = Object.keys(manifest.dependencies ?? {})
  const fact = (activated: boolean): TrialActivationFact =>
    ({ name: candidate, bundles: [...bundles], activated, removedFirst: detached.removed, detachNote: detached.note })
  const added = deps.filter((name) => !beforeDeps.includes(name))
  const suspects = added.length > 0
    ? added
    : candidate === undefined ? [] : deps.filter((name) => name === candidate)
  if (suspects.length === 0) {
    return {
      ok: false,
      detail: '装完候选包后，测试环境的 dependencies 里没有出现它（装前 ' + String(beforeDeps.length)
        + ' 项，装后 ' + String(deps.length) + ' 项）：这次试装没有验证到任何东西。',
      fact: fact(false),
    }
  }
  const active = suspects.filter((name) => bundles.includes(name))
  if (active.length > 0) return { ok: true, detail: '', fact: fact(true) }
  const stale = suspects.every((name) => beforeDeps.includes(name))
  return {
    ok: false,
    detail: '候选（' + suspects.join(', ') + '）装进了 node_modules，但**没有进入组合层栈**'
      + '（dsh.profile.bundles = ' + JSON.stringify(bundles) + '）——挂载期不会加载它。'
      + (stale
        ? '原因：它在本轮之前就已经是测试环境的依赖，官方 reconcile 会跳过"既有的"依赖。'
          + (detached.removed ? '（已先卸过包，但候选仍被当作既有的——见上面的卸包说明。）' : '')
        : '原因：官方 reconcile 没有把它写进层栈（它可能没有声明 dsh.bundle）。'),
    fact: fact(false),
  }
}

/**
 * 受控对照四步（§5.2）：物化快照 → 基线启动 → 装候选包 → 二次启动。
 *
 * 缺一步结论就站不住，所以：基线失败一律报 baseline-broken（**不赖候选包**）；
 * 装不上候选包报 cannot-trial（**不算通过**）；只有基线好、装完也好的才是 passed。
 * 装候选包走**官方 runPluginCommand**（绝不自己调 pnpm）；allowNetwork=false 时加 --offline，
 * 冷包失败如实报「无法试装」。
 *
 * @param spec - 候选包 spec。
 * @param realName - 真实环境名（测试环境由它派生）。
 * @param options - 四步选项与注入。
 * @returns 结果（含证据与构建指纹）。
 */
export async function runTrialInstall(
  spec: string, realName: string, options: TrialInstallOptions = {},
): Promise<TrialInstallResult> {
  const now = options.now ?? Date.now
  const started = now()
  const build = buildIdentity()
  const sourceFingerprint = await environmentFingerprint(realName, {
    ...options.listBundles === undefined ? {} : { listBundles: options.listBundles },
  })
  const target = trialEnvironmentName(realName)
  const done = (conclusion: TrialConclusion, output: string, extra: Partial<TrialInstallResult> = {}) => ({
    conclusion, output, build, sourceFingerprint, sourceFingerprintAfter: null,
    changedDuringTrial: false, baseline: null, candidate: null, elapsedMs: now() - started,
    depth: 'shallow' as SnapshotDepth, escalated: false, ...extra,
  })

  const verify = options.verify ?? ((name: string) => runHeadlessVerification(name))
  /** 只把物化需要的字段传下去（避免把 baseline/verify 等选项混进快照选项）。 */
  const snapshotOptions = (depth: SnapshotDepth): MaterializeSnapshotOptions => ({
    depth,
    ...options.ctx === undefined ? {} : { ctx: options.ctx },
    ...options.installAnchor === undefined ? {} : { installAnchor: options.installAnchor },
    ...options.runCommand === undefined ? {} : { runCommand: options.runCommand },
    ...options.bundlesOf === undefined ? {} : { bundlesOf: options.bundlesOf },
  })
  const requested = options.depth ?? 'auto'
  let depth: SnapshotDepth = requested === 'full' ? 'full' : 'shallow'
  let escalated = false
  let escalationReason: string | undefined

  const materialize = async (which: SnapshotDepth): Promise<EnvironmentResult> =>
    await createTrialEnvironment(realName, { snapshot: snapshotOptions(which) })
  let materialized = await materialize(depth)
  if (!materialized.ok) {
    return done('cannot-trial', '无法试装：测试环境没有物化成功（' + String(materialized.code) + '）。\n'
      + materialized.output + '\n这不等于通过。', { depth })
  }

  let baseline: BootVerdict | null = null
  if (options.baseline !== false) {
    let verified = await verify(target)
    baseline = verified.verdict
    // 以启动为判据的升级：**只对明确失败**升级；undetermined 是判不出来，不许悄悄换成 full。
    if (baseline.kind === 'failed' && requested === 'auto') {
      escalated = true
      escalationReason = baseline.reason
      depth = 'full'
      materialized = await materialize(depth)
      if (!materialized.ok) {
        return done('cannot-trial', '无法试装：浅快照基线失败后升级为完整快照，但重新物化失败（'
          + String(materialized.code) + '）。\n' + materialized.output + '\n这不等于通过。',
          { depth, escalated, escalationReason })
      }
      verified = await verify(target)
      baseline = verified.verdict
    }
    if (baseline.kind !== 'mounted') {
      // 三种形态各说各的话：判不出来 ≠ 基线坏了（下面这两句以前共用一条"基线起不来"，是错误归因）。
      const head = baseline.kind === 'undetermined'
        ? '这次验证没有给出判定（既没挂载成功，也没报挂载失败）—— 这不是 ' + spec + ' 的问题，试装无法判断它。\n'
        : escalated
          ? '快照基线本身就起不来（浅快照与完整快照都试过，两次都没挂载起来）—— 这不是 ' + spec + ' 的问题。\n'
            + '浅快照为什么不给力：' + String(escalationReason) + '\n'
          : '快照基线本身就起不来 —— 这不是 ' + spec + ' 的问题，试装无法判断它。\n'
      const detail = baseline.kind === 'failed'
        ? '根因：' + baseline.reason + '\n' + baseline.chain.join('\n')
        : '判不出来：' + baseline.reason
      // failed → baseline-broken；undetermined → cannot-trial（判不出来就是无法试装，不许算通过）。
      return done(judgeTrialOutcome(baseline, null),
        head + detail + '\n'
        + '实际深度：' + depth + (escalated ? '（由 shallow 升级）' : '') + '\n'
        + '构建：' + describeBuild(build), { baseline, depth, escalated, escalationReason })
    }
  }

  let runner: PluginCommandRunner
  let context: PackageOperationContext
  try {
    context = operationContext(target, environmentDir(target), environmentDir(target), options)
    runner = await officialRunner(options)
  } catch (error) {
    return done('cannot-trial', '无法试装：官方 pnpm 通道不可用（' + messageOf(error) + '）。这不等于通过。',
      { baseline })
  }
  // 装之前记下依赖清单：reconcile 会跳过"既有的"依赖，这份事实是下面那条守卫的判据。
  const beforeDeps = trialDependencies(target)
  // 让候选成为"新装"（task-84 阻断级修复）：候选已在测试环境依赖里时先卸掉它，否则官方
  // reconcile 跳过既有依赖 → 进不了层栈 → 挂载期不加载它 → 这次试装什么都没验证到。
  const detached = await detachCandidate(runner, context, options, target, spec)
  const installArgs = options.allowNetwork === false ? ['add', '--offline', spec] : ['add', spec]
  const installed = await runPackageOperation(runner, context, installArgs, options)
  if (installed.exitCode !== 0) {
    const reason = options.allowNetwork === false
      ? '已禁用联网，且本地 store 里没有这个包'
      : '官方安装失败（exitCode=' + String(installed.exitCode) + '）'
    return done('cannot-trial', '无法试装：' + reason + '。\n'
      + installed.output.trim().slice(-800) + '\n这不等于通过。', { baseline, detached: detached.note })
  }

  // 兜底守卫（task-80）：装上了不等于验证到了。候选没进层栈 → 这次试装什么都没验证到，
  // 一律 cannot-trial，**任何情况下都不许 passed**（假通过的整类问题在这里被掐断）。
  // 正常顺序下（上面刚把候选摘成"新装"）这条不该触发——它兜的是摘不掉、候选不声明
  // dsh.bundle、测试环境有残留这些真实情况。
  const activation = trialActivation(target, beforeDeps, spec, detached)
  if (!activation.ok) {
    return done('cannot-trial', '无法试装：' + activation.detail + '\n这不等于通过。',
      { baseline, depth, escalated, escalationReason, activation: activation.fact })
  }

  const after = await verify(target)
  const conclusion = judgeTrialOutcome(baseline, after.verdict)
  const sourceFingerprintAfter = await environmentFingerprint(realName, {
    ...options.listBundles === undefined ? {} : { listBundles: options.listBundles },
  })
  const changedDuringTrial = !sameFingerprint(sourceFingerprint, sourceFingerprintAfter)
  const lines = [describeConclusion(conclusion, spec, target)
    + '\n基线启动：' + (baseline === null ? '未做' : baseline.kind) + '｜候选启动：' + after.verdict.kind
    + '（验证耗时 ' + String(after.elapsedMs) + 'ms）']
  if (after.verdict.kind === 'failed') lines.push('根因链：\n' + after.verdict.chain.join('\n'))
  if (after.verdict.kind === 'undetermined') lines.push('判不出来：' + after.verdict.reason)
  lines.push('实际深度：' + depth + (escalated
    ? '（由 shallow 升级：浅快照基线失败 —— ' + String(escalationReason) + '）'
    : ''))
  lines.push('源环境指纹：' + sourceFingerprint.hash + '（试装前）')
  if (changedDuringTrial) {
    lines.push('注意：试装期间 ' + realName + ' 的环境又变过（指纹 ' + sourceFingerprintAfter.hash
      + '），这个结论可能不适用。')
  }
  lines.push('构建：' + describeBuild(build))
  return done(conclusion, lines.join('\n'), {
    baseline, candidate: after.verdict, sourceFingerprintAfter, changedDuringTrial,
    depth, escalated, detached: detached.note, activation: activation.fact,
    ...escalationReason === undefined ? {} : { escalationReason },
  })
}

/** 构建指纹的一句话描述（放进结果里，事后能对上产物）。 */
function describeBuild(build: BuildIdentity): string {
  return (build.artifactMd5 === null ? 'md5 不可读' : 'md5=' + build.artifactMd5.slice(0, 12))
    + (build.artifactMtime === null ? '' : ' mtime=' + build.artifactMtime)
    + (build.gitHead === null ? '（读不到 git HEAD）' : ' head=' + build.gitHead.slice(0, 12))
}

/** 三种结论各自的措辞（§5.2：各有措辞、不得混）。 */
function describeConclusion(conclusion: TrialConclusion, spec: string, target: string): string {
  switch (conclusion) {
    case 'passed':
      return '试装通过：' + spec + ' 装进 ' + target + ' 后仍能正常挂载。'
    case 'baseline-broken':
      return '快照基线就起不来：这不是 ' + spec + ' 的问题。'
    case 'candidate-broken':
      return '候选包导致挂载失败：' + spec + ' 装进 ' + target + ' 之后树挂不起来。'
    default:
      return '无法试装：这次没有得到有效判定（不等于通过）。'
  }
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
    // 整句括注删（copy-dev 复核）：前半是立场句（②），后半「在环境列表里创建」是把同屏控件写进句子
    // （DESIGN §12.3.2 指路式引导）。「环境不存在」这个事实本身已经够用户决定下一步。
    return failure('not-found', '目标环境不存在：' + diff.missingProfiles.join(', '))
  }
  const plan = describeDiff(diff)
  if (diff.missing.length === 0 && diff.bundlesMissing.length === 0) {
    // 结论句删：紧随其后的 plan 第一行就是「待重装 0 项：（无）」，同一件事不必说两遍。
    return diff.unrestorable.length === 0
      ? success(plan)
      : failure('unrestorable', plan)
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

/**
 * 多类型安装：skill / agent 预设的检测、直装，以及安装记录与屏蔽名单。
 *
 * 归属：A 类·重写（写文件、复制目录、管持久化状态；旧 src/kinds.ts 仅作意图参考，未复制代码）。
 * 旧实现参考：dsh-web-plugin-manager/src/kinds.ts（536 行：分层检测、SKILL.md 发现、
 *   installed-kinds.json 记录、blocked-repos.json 屏蔽名单、isUnderRoot 守卫、
 *   rmRetry/renameRetry 的 Windows 占用重试）。
 * 官方复用：官方 skill-filesystem 扫描 <dshHome>/skills（默认 chokidar 热加载），
 *   官方 agent-presets 每次读取都重扫 <dshHome>/.agent-presets 且以 agent.cordis.yml
 *   为组合文件——本模块只往这两个官方根里落文件，**不复制官方发现逻辑、
 *   不注册任何服务、不动 cordis.patch.yml**。路径基座复用 src/paths.ts 的 dshHome()。
 * 前提检查：仍然成立且这正是我们的作业面——官方 README 明说 "loading plain plugin
 *   modules stays a file operation"，skill 与 agent 预设没有安装器。旧实现的前提
 *   （官方只有只读清单、必须自建写路径）对 cordis 插件已消失，所以这里**不做**
 *   cordis 插件的安装：那种仓库交给官方 plugin_manager / CLI 的 pnpm 通道。
 *   本模块对 cordis-plugin 只做"识别并指引"。
 *
 * 四条硬约束：
 *   1. 每个落地目录都必须校验在目标根之内（isUnderRoot）——SKILL.md frontmatter
 *      里的 name 是第三方内容，可能写成 ../.. 或绝对路径。
 *   2. 删除/改名带重试：Windows 上 AV 扫描器与编辑器会短暂占用句柄。
 *   3. 记录与屏蔽名单的读改写串行化，且落盘是"临时文件 + 改名"的原子写。
 *   4. 永不执行第三方脚本：仓库里的 install.sh 只被扫描（见 scan.ts），不被运行。
 */

import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { dshHome as officialDshHome, enqueueMutation } from './paths.ts'
import { writeOwnerMarker } from './presets.ts'
import type { InstalledKind, MarketItemKind } from './types.ts'

/** 可安装的非插件资源类型。'unknown' 表示检测不出（应拒绝安装）。 */
export type RepoKind = 'agent-preset' | 'cordis-plugin' | 'skill'

/** 检测结果：三类之一，或 unknown（非插件/技能/预设仓库）。 */
export type DetectedRepoKind = RepoKind | 'unknown'

/** 官方预设组合文件：一个目录里有它就构成一个 agent 预设（官方单文件判定）。 */
export const PRESET_COMPOSITION_FILE = 'agent.cordis.yml'

/** 官方技能清单文件（大小写不敏感，见 findSkillRoots）。 */
export const SKILL_MANIFEST_FILE = 'SKILL.md'

/** 本模块记录文件的 schema 版本。 */
const RECORD_FORMAT = 1

/** 技能根发现的默认上限：5 层 / 200 个。 */
export const DEFAULT_ROOT_LIMITS = { maxDepth: 5, limit: 200 } as const

/** 插件根发现的默认上限（比技能浅：packages/* 这种布局三层足够）。 */
export const DEFAULT_PLUGIN_LIMITS = { maxDepth: 3, limit: 50 } as const

/** 预设根发现的默认上限。 */
export const DEFAULT_PRESET_LIMITS = { maxDepth: 3, limit: 50 } as const

/**
 * Harness home 覆盖（仅测试用）。
 *
 * 生产路径一律走 src/paths.ts 的 dshHome()。测试需要把落地根指向临时目录，
 * 又不能忘了清缓存——两者绑在同一个函数里，防止只清一半。
 */
let homeOverride: string | null = null

/** 进程内缓存声明放在文件前部：__setHomeForTests 要在任何读写点之前引用它们。 */
let kindCache: KindRecordMap | null = null
let blockedCache: Set<string> | null = null

/** 当前解析到的 Harness home（测试可覆盖）。 */
function dshHome(): string {
  return homeOverride ?? officialDshHome()
}

/**
 * 覆盖 Harness home 并清掉全部进程内缓存（仅测试用）。
 * @param home - 临时 home；传 null 恢复真实 home。
 */
export function __setHomeForTests(home: string | null): void {
  homeOverride = home
  kindCache = null
  blockedCache = null
}

/**
 * 当前生效的 Harness home（含测试覆盖）。
 *
 * 兄弟模块（presets.ts）必须用这个而不是直接调 paths.dshHome()：否则测试里
 * 覆盖过的 home 只有一半模块看得见，落地根与归档根会分叉。
 * @returns 绝对路径。
 */
export function resolvedHome(): string {
  return dshHome()
}

/** 本插件管辖的缓存目录（与旧仓库共用同一目录名，但文件名不同，见下）。 */
export function cacheRoot(): string {
  return join(dshHome(), 'plugin-manager-cache')
}

/**
 * 安装记录文件。
 *
 * 与旧仓库的 installed-kinds.json **不同文件**：那个文件由已停止维护的旧包读写，
 * 两边并发写会互相覆盖。读取端做兼容（见 loadKindRecords），写入端只碰自己的
 * 文件，因此两个包共存期间各自的数据都完好。
 */
export function kindRecordsFile(): string {
  return join(cacheRoot(), 'companion-kinds.json')
}

/** 旧包的记录文件（只读兼容）。 */
function legacyKindRecordsFile(): string {
  return join(cacheRoot(), 'installed-kinds.json')
}

/** 屏蔽名单文件（同样是独立文件，避免与旧包并发写）。 */
export function blockedReposFile(): string {
  return join(cacheRoot(), 'companion-blocked-repos.json')
}

/** 官方技能落地根。 */
export function skillsRoot(): string {
  return join(dshHome(), 'skills')
}

/** 官方 agent 预设落地根。 */
export function presetsRoot(): string {
  return join(dshHome(), '.agent-presets')
}

/** 根发现选项。 */
export interface RootSearchOptions {
  /** 递归层数上限（根为第 0 层）。 */
  readonly maxDepth?: number
  /** 最多返回的根数量。 */
  readonly limit?: number
}

/**
 * 路径包含判定：target 必须位于 root 之内（不等于 root）。
 *
 * 用途是删除/移动前的最后一道守卫：SKILL.md 的 frontmatter name、预设目录名
 * 都可能包含 ../ 或绝对路径（第三方内容），一旦漏判就会删到用户的主目录
 * （旧仓库记录过"删掉整个 Harness home"的事故）。大小写按平台语义处理：
 * Windows/macOS 的文件系统大小写不敏感，用大小写精确比较会误拒合法路径
 * （旧仓库审计 W2）。
 *
 * @param target - 待校验路径。
 * @param root - 允许的根。
 * @returns 是否严格位于根之内。
 */
export function isUnderRoot(target: string, root: string): boolean {
  const normalizedRoot = resolve(root).replace(/[\\/]+$/, '')
  const normalizedTarget = resolve(target)
  if (isCaseInsensitivePlatform()) {
    const lowerRoot = normalizedRoot.toLowerCase()
    const lowerTarget = normalizedTarget.toLowerCase()
    return lowerTarget !== lowerRoot && lowerTarget.startsWith(lowerRoot + sep)
  }
  return normalizedTarget !== normalizedRoot && normalizedTarget.startsWith(normalizedRoot + sep)
}

/** 平台文件名是否大小写不敏感（win32 与 darwin 都按不敏感处理）。 */
function isCaseInsensitivePlatform(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin'
}

/** 重试间隔（毫秒）。 */
const RETRY_DELAY_MS = 120

/** 重试次数上限（首次 + 3 次重试）。 */
const RETRY_ATTEMPTS = 3

/** 退避等待。 */
function retryDelay(): Promise<void> {
  return new Promise(resolveDelay => { setTimeout(resolveDelay, RETRY_DELAY_MS) })
}

/**
 * 删除一棵目录树，带短暂重试。
 *
 * Windows 上 AV 扫描器/编辑器会短暂持有句柄，第一次 rm 常以 EPERM/EBUSY 失败；
 * rm 的 force 只容忍"不存在"，不容忍"被占用"。退避用定时器而不是忙循环：
 * 调用点都在 async 路径上，同步自旋会冻住整个事件循环。
 *
 * @param target - 要删除的路径。
 * @throws 重试耗尽后抛出最后一次错误。
 */
export async function rmRetry(target: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt >= RETRY_ATTEMPTS) throw error
      await retryDelay()
    }
  }
}

/**
 * 改名（移动），带短暂重试。归档/恢复预设目录时目标可能被占用。
 *
 * @param from - 源路径。
 * @param to - 目标路径。
 * @throws 重试耗尽后抛出最后一次错误。
 */
export async function renameRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      if (attempt >= RETRY_ATTEMPTS) throw error
      await retryDelay()
    }
  }
}

/** 生成文件系统安全的目录名：小写、非字母数字折叠成 '-'。 */
export function slugDirName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug === '' ? 'plugin' : slug
}

/** Windows 保留设备名：CON/NUL/COM1… 作为目录名会 EINVAL。 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * 平台安全的目录名：Windows 保留名加后缀。
 * @param name - 期望的目录名。
 * @returns 可直接 mkdir 的名字。
 */
export function safeDirName(name: string): string {
  const trimmed = name.trim()
  const base = trimmed === '' ? 'plugin' : trimmed
  return WINDOWS_RESERVED.test(base) ? base + '-skill' : base
}

/** 取路径最后一段。 */
function lastSegment(path: string): string {
  const parts = path.split(/[\\/]+/).filter(part => part !== '')
  return parts.length === 0 ? '' : parts[parts.length - 1]!
}

/**
 * 归一化仓库引用为小写 owner/repo。
 *
 * 支持 github:owner/repo、git+https://…、https://github.com/owner/repo、
 * git@github.com:owner/repo、末尾 .git 与 #ref 片段。非 GitHub 形态（本地路径）
 * 返回 null——调用方必须自己决定用什么做键，而不是被塞一个被改写的路径。
 *
 * @param value - 用户输入的仓库引用。
 * @returns owner/repo 小写形式；无法识别的形态返回 null。
 */
export function normalizeRepoRef(value: string): string | null {
  let text = value.trim()
  if (text === '') return null
  text = text.split('#')[0]!
  text = text.replace(/^git\+/i, '')
  text = text.replace(/^git@github\.com:/i, '')
  text = text.replace(/^github:/i, '')
  text = text.replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
  text = text.replace(/\.git$/i, '')
  text = text.replace(/\/+$/, '')
  if (text === '' || text.startsWith('/') || text.startsWith('.') || /^[A-Za-z]:[\\/]/.test(text)) return null
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(text)) return null
  return text.toLowerCase()
}

/** 目录项最小视图（node 的 Dirent 结构兼容）。 */
interface DirEntry {
  readonly name: string
  isDirectory(): boolean
  isFile(): boolean
}

/** 读目录项，失败返回空数组（不存在/无权限都不应抛给调用方）。 */
async function readEntries(dir: string): Promise<readonly DirEntry[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** 大小写不敏感地找一个目录下的文件；返回真实文件名或 null。 */
async function findFile(dir: string, name: string): Promise<string | null> {
  const wanted = name.toLowerCase()
  for (const entry of await readEntries(dir)) {
    if (entry.isFile() && entry.name.toLowerCase() === wanted) return entry.name
  }
  return null
}

/** vendored 目录惯例命名：里面的 SKILL.md 不属于本仓库分发。 */
const VENDORED_DIR_NAMES = new Set(['upstream', 'vendor', 'vendored', 'third_party', 'third-party', 'external', 'deps'])

/** 遍历时跳过的目录。 */
function isSkippedDir(name: string): boolean {
  if (name.startsWith('.')) return true
  if (name === 'node_modules') return true
  return VENDORED_DIR_NAMES.has(name.toLowerCase())
}

/**
 * 判断一个 package.json 是否声明了 DSH 能力。
 *
 * 判据（与旧实现意图一致，重写实现）：有 dsh 对象字段，或依赖/peerDependencies 里
 * 出现 @deepseek-ai/cordis、@deepseek-ai/dsh、@deepseek-ai/dsh-*。仅带 package.json
 * 的聚合页/桌面壳/普通 npm 项目返回 false——那种仓库不该被当成插件强装。
 *
 * @param manifest - 解析后的 package.json 内容（任意 JSON）。
 * @returns true/false；不是对象时返回 null（无法判定）。
 */
export function looksLikeDshPlugin(manifest: unknown): boolean | null {
  if (manifest === null || typeof manifest !== 'object') return null
  const record = manifest as Record<string, unknown>
  if (record['dsh'] !== null && typeof record['dsh'] === 'object') return true
  const merge = (section: unknown): Record<string, unknown> =>
    section !== null && typeof section === 'object' ? section as Record<string, unknown> : {}
  const names = [
    ...Object.keys(merge(record['dependencies'])),
    ...Object.keys(merge(record['peerDependencies'])),
  ]
  if (names.includes('@deepseek-ai/cordis') || names.includes('@deepseek-ai/dsh')) return true
  return names.some(name => name.startsWith('@deepseek-ai/dsh-'))
}

/** 读取并解析一个 package.json；失败返回 null（坏 JSON 不是错误，只是"不是插件"）。 */
async function readManifest(dir: string): Promise<unknown | null> {
  const name = await findFile(dir, 'package.json')
  if (name === null) return null
  try {
    return JSON.parse(await readFile(join(dir, name), 'utf8')) as unknown
  } catch {
    return null
  }
}

/**
 * 找出仓库里的 SKILL.md 根（单技能仓库与技能集合仓库）。
 *
 * 一个目录里有 SKILL.md 就不再往下走：技能目录内部的子目录属于该技能自己的
 * 结构（脚本、资源），把其中的 SKILL.md 当成第二个技能会装出重复内容。
 *
 * @param root - 仓库根目录。
 * @param options - 层数与数量上限（默认 5 层 / 200 个）。
 * @returns 技能根目录的绝对路径列表。
 */
export async function findSkillRoots(root: string, options: RootSearchOptions = {}): Promise<string[]> {
  const maxDepth = options.maxDepth ?? DEFAULT_ROOT_LIMITS.maxDepth
  const limit = options.limit ?? DEFAULT_ROOT_LIMITS.limit
  const roots: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (roots.length >= limit) return
    if (await findFile(dir, SKILL_MANIFEST_FILE) !== null) {
      roots.push(dir)
      return
    }
    if (depth >= maxDepth) return
    for (const entry of await readEntries(dir)) {
      if (roots.length >= limit) return
      if (!entry.isDirectory() || isSkippedDir(entry.name)) continue
      await walk(join(dir, entry.name), depth + 1)
    }
  }
  await walk(root, 0)
  return roots
}

/**
 * 找出仓库里的 agent 预设根（根预设与预设集合都覆盖）。
 *
 * 判定只看官方组合文件 agent.cordis.yml 是否存在——preset.yml 只是可选展示元数据，
 * 不是构成条件（官方 discovery 的口径）。
 *
 * @param root - 仓库根目录。
 * @param options - 层数与数量上限（默认 3 层 / 50 个）。
 * @returns 预设根目录的绝对路径列表。
 */
export async function findPresetRoots(root: string, options: RootSearchOptions = {}): Promise<string[]> {
  const maxDepth = options.maxDepth ?? DEFAULT_PRESET_LIMITS.maxDepth
  const limit = options.limit ?? DEFAULT_PRESET_LIMITS.limit
  const roots: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (roots.length >= limit) return
    if (await findFile(dir, PRESET_COMPOSITION_FILE) !== null) {
      roots.push(dir)
      return
    }
    if (depth >= maxDepth) return
    for (const entry of await readEntries(dir)) {
      if (roots.length >= limit) return
      if (!entry.isDirectory() || isSkippedDir(entry.name)) continue
      await walk(join(dir, entry.name), depth + 1)
    }
  }
  await walk(root, 0)
  return roots
}

/**
 * 找出仓库里的 DSH 插件包根（monorepo / 多包仓库）。
 *
 * @param root - 仓库根目录。
 * @param options - 层数与数量上限（默认 3 层 / 50 个）。
 * @returns 插件包目录列表。
 */
export async function findPluginRoots(root: string, options: RootSearchOptions = {}): Promise<string[]> {
  const maxDepth = options.maxDepth ?? DEFAULT_PLUGIN_LIMITS.maxDepth
  const limit = options.limit ?? DEFAULT_PLUGIN_LIMITS.limit
  const roots: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (roots.length >= limit) return
    if (looksLikeDshPlugin(await readManifest(dir)) === true) {
      roots.push(dir)
      return
    }
    if (depth >= maxDepth) return
    for (const entry of await readEntries(dir)) {
      if (roots.length >= limit) return
      if (!entry.isDirectory() || isSkippedDir(entry.name)) continue
      await walk(join(dir, entry.name), depth + 1)
    }
  }
  await walk(root, 0)
  return roots
}

/**
 * 分层类型检测。
 *
 * 顺序（旧实现的顺序保留，重写实现）：
 *   1. 根目录就是预设（agent.cordis.yml 在根）→ agent-preset；
 *   2. 根 package.json 声明了 DSH 能力 → cordis-plugin；
 *   3. 根有 SKILL.md → skill（工具链 package.json 在纯技能仓库上很常见，
 *      不能因为"有 package.json"就判成插件）；
 *   4. 嵌套检测**统一放最后一层**：预设 → 插件 → 技能，三层只要有一层命中就
 *      返回该类型；这样"技能集合里夹带一个预设目录"和"预设集合里夹带技能"
 *      都按预设优先（预设是更具体的形态）；
 *   5. 都不命中 → unknown（调用方据此拒绝安装并加入屏蔽名单）。
 *
 * 与旧实现的差别：旧实现有第四类 'instructions'（带 install.sh 的仓库）。
 * 'unknown' 已经覆盖那个语义（拒绝安装 + 指引用户自己看仓库），少一个类型名
 * 少一处分支。**任何仓库的 install.sh 都不会被自动执行**，这一点没有变。
 *
 * @param root - 仓库根目录。
 * @returns 检测到的类型；无法识别时为 'unknown'。
 */
export async function detectRepoType(root: string): Promise<DetectedRepoKind> {
  if ((await findPresetRoots(root, { maxDepth: 0, limit: 1 })).length > 0) return 'agent-preset'
  const manifest = await readManifest(root)
  if (manifest !== null && looksLikeDshPlugin(manifest) === true) return 'cordis-plugin'
  if ((await findSkillRoots(root, { maxDepth: 0, limit: 1 })).length > 0) return 'skill'
  if ((await findPresetRoots(root)).length > 0) return 'agent-preset'
  if ((await findPluginRoots(root)).length > 0) return 'cordis-plugin'
  if ((await findSkillRoots(root, { maxDepth: 5, limit: 1 })).length > 0) return 'skill'
  return 'unknown'
}

/**
 * 读取 SKILL.md 的 YAML frontmatter 里的 name。
 *
 * 只做一件小事：'---' 块里的 name: 行。不引入 YAML 解析器——技能清单的
 * frontmatter 由官方解析，我们只需要拿它当**建议目录名**，解析失败就回退到
 * 仓库名/目录名，不影响技能本身能否被官方加载。
 *
 * @param skillDir - 技能根目录。
 * @returns 合法的技能名；没有或非法时返回 null。
 */
export async function skillDisplayName(skillDir: string): Promise<string | null> {
  const name = await findFile(skillDir, SKILL_MANIFEST_FILE)
  if (name === null) return null
  let text: string
  try {
    text = await readFile(join(skillDir, name), 'utf8')
  } catch {
    return null
  }
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (frontmatter === null) return null
  const match = /^name:\s*"?([a-z0-9][a-z0-9-]*)"?\s*$/m.exec(frontmatter[1] ?? '')
  return match?.[1] ?? null
}

/** 复制过滤器：不复制 .git 与 node_modules（技能/预设都是纯文件）。 */
function copyFilter(src: string): boolean {
  const parts = src.split(/[\\/]+/)
  return !parts.includes('.git') && !parts.includes('node_modules')
}

/** 一次直装的结果。 */
export interface InstallOutcome {
  /** 单个落地时的名字；多个时是 N-skills / N-presets 这类汇总名。 */
  readonly name: string
  /** 每个落地目录名。 */
  readonly names: readonly string[]
  /** 落地根目录。 */
  readonly location: string
  /** 每个落地目录的绝对路径（与 names 同序）。 */
  readonly dirs: readonly string[]
}

/** 直装选项。 */
export interface InstallOptions {
  /** 已被其他安装记录占用的名字；命中即拒绝（避免静默覆盖别人的技能）。 */
  readonly occupied?: ReadonlySet<string>
  /** 覆盖落地根（测试用；默认是官方用户根）。 */
  readonly root?: string
  /**
   * 是否写入安装记录（默认 true）。
   *
   * 记录是「市场已安装标记」与「uninstall-kind 卸载」的唯一依据——安装不记账等于装完就找不到。
   * 只有明确的例外场景（例如调用方已经把多个根聚合成一条记录）才关掉它。
   */
  readonly record?: boolean
}

/** 校验一个待落地目录，不通过即抛出可直接展示的原因。 */
function assertInstallTarget(root: string, name: string): string {
  const dest = join(root, name)
  if (!isUnderRoot(dest, root)) {
    throw new Error('refusing to install outside the target root: ' + JSON.stringify(dest))
  }
  return dest
}

/**
 * 安装技能仓库到 <dshHome>/skills。
 *
 * 单技能仓库与技能集合仓库都覆盖：每个 SKILL.md 根装成一个目录，目录名优先取
 * frontmatter 的 name，其次单根时取仓库名、多根时取该根自己的目录名。
 *
 * 落地前会 rm 掉同名目录（这是"重装同一技能"的语义），但**先校验包含关系**：
 * 名字来自第三方 frontmatter，必须落在技能根之内。名字已被另一条安装记录占用时
 * 抛错而不是覆盖——静默覆盖等于让用户丢掉另一个技能。
 *
 * @param repoRoot - 仓库根目录（已就绪的克隆或本地目录）。
 * @param repoName - 仓库展示名（owner/repo 或本地目录名）。
 * @param options - 已占用名字集合与根覆盖。
 * @returns 落地结果。
 * @throws 没有 SKILL.md、名字冲突、越界时。
 */
export async function installSkill(repoRoot: string, repoName: string, options: InstallOptions = {}): Promise<InstallOutcome> {
  const roots = await findSkillRoots(repoRoot)
  if (roots.length === 0) throw new Error('no SKILL.md found in the repository')
  const destRoot = options.root ?? skillsRoot()
  await mkdir(destRoot, { recursive: true, mode: 0o700 })
  const repoSlug = slugDirName(lastSegment(repoName) || repoName)
  const names: string[] = []
  const dirs: string[] = []
  for (const skillRoot of roots) {
    const fallback = roots.length === 1 ? repoSlug : slugDirName(lastSegment(skillRoot))
    const name = safeDirName((await skillDisplayName(skillRoot)) ?? fallback)
    if (options.occupied?.has(name) === true) {
      throw new Error('skill "' + name + '" is already installed from another repository — '
        + 'rename the SKILL.md frontmatter name, or uninstall the other skill first')
    }
    const dest = assertInstallTarget(destRoot, name)
    await rmRetry(dest)
    await cp(skillRoot, dest, { recursive: true, filter: copyFilter })
    names.push(name)
    dirs.push(dest)
  }
  const outcome: InstallOutcome = { name: summaryName(names, 'skills'), names, location: destRoot, dirs }
  if (options.record !== false) await saveKindRecord(repoName, kindRecordOf('skill', repoName, outcome))
  return outcome
}

/**
 * 安装 agent 预设仓库到 <dshHome>/.agent-presets。
 *
 * 目录名即 preset id（官方语义）。嵌套预设立于子目录时用子目录名做 id；名字是
 * 惯例的 preset 或根预设时回退到仓库名——这样常见布局 repo/preset/agent.cordis.yml
 * 装出来是仓库名而不是一堆同名 preset。
 *
 * 每个落地目录写一份**中立标准归属标记**（.dsh-preset-owner.json），让插件卸载时
 * 能分清"这个预设是谁装的、用户改过没有"（见 presets.ts）。已有标记不覆盖。
 *
 * @param repoRoot - 仓库根目录。
 * @param repoName - 仓库展示名（owner/repo 或本地目录名）。
 * @param options - 已占用 id 集合与根覆盖。
 * @returns 落地结果。
 * @throws 没有 agent.cordis.yml、id 冲突、越界时。
 */
export async function installPreset(repoRoot: string, repoName: string, options: InstallOptions = {}): Promise<InstallOutcome> {
  const roots = await findPresetRoots(repoRoot)
  if (roots.length === 0) throw new Error('no ' + PRESET_COMPOSITION_FILE + ' found in the repository')
  const destRoot = options.root ?? presetsRoot()
  await mkdir(destRoot, { recursive: true, mode: 0o700 })
  const repoSlug = slugDirName(lastSegment(repoName) || repoName)
  const names: string[] = []
  const dirs: string[] = []
  for (const presetRoot of roots) {
    const isRootPreset = resolve(presetRoot) === resolve(repoRoot)
    const base = isRootPreset ? '' : lastSegment(presetRoot)
    const id = safeDirName(base === '' || base === 'preset' ? repoSlug : slugDirName(base))
    if (options.occupied?.has(id) === true) {
      throw new Error('preset id "' + id + '" is already installed from another repository — '
        + 'rename the preset directory, or uninstall the other preset first')
    }
    const dest = assertInstallTarget(destRoot, id)
    await rmRetry(dest)
    await cp(presetRoot, dest, { recursive: true, filter: copyFilter })
    await writeOwnerMarker(dest, [repoName])
    names.push(id)
    dirs.push(dest)
  }
  const outcome: InstallOutcome = { name: summaryName(names, 'presets'), names, location: destRoot, dirs }
  if (options.record !== false) await saveKindRecord(repoName, kindRecordOf('agent-preset', repoName, outcome))
  return outcome
}

/** 单个落地时用名字，多个时用 N-kind 汇总名。 */
function summaryName(names: readonly string[], suffix: string): string {
  if (names.length === 0) return '0-' + suffix
  return names.length === 1 ? names[0]! : String(names.length) + '-' + suffix
}

/**
 * 删除一个已安装的 kind 目录（越界即拒绝）。
 *
 * @param root - 允许的根（技能根或预设根）。
 * @param dir - 待删除目录。
 * @throws 越界时（不删除任何东西）。
 */
export async function removeKindDir(root: string, dir: string): Promise<void> {
  if (!isUnderRoot(dir, root)) throw new Error('refusing to delete outside the target root: ' + JSON.stringify(dir))
  await rmRetry(dir)
}

// ── 安装记录（companion-kinds.json）─────────────────────────────────────────

/**
 * 把任意仓库拼写收敛成记录表的规范键。
 *
 * 记录表的键一律是 normalizeRepoRef 的结果（小写 owner/repo）；本地路径这类
 * normalizeRepoRef 认不出的形态按原样当键。
 *
 * @param ref - 任意仓库拼写（owner/repo、URL、github:、客户端回传的展示名…）。
 * @returns 规范键。
 */
export function canonicalKindKey(ref: string): string {
  return normalizeRepoRef(ref) ?? ref
}

/**
 * 落盘形态的记录。
 *
 * 比 wire 类型 InstalledKind 多两个**仅供本模块内部使用**的字段，它们解决的问题是
 * 精确性：一个技能集合仓库会落下多个目录，只记 `dir` 无法回答"这次安装到底碰了哪些
 * 目录"。孤儿扫描（findOrphanKindDirs）与将来的多目录卸载都要靠 `dirs`。
 * 多出来的键会随记录一起落盘，客户端 wire 解析只挑它认识的字段，因此不影响契约。
 */
export interface StoredKindRecord extends InstalledKind {
  /** 本次安装落地的全部目录（单目录安装时就是那一个）。旧记录没有这个字段。 */
  readonly dirs?: readonly string[]
  /** 本次安装落地的目录名（多目录安装时用于展示与归属说明）。 */
  readonly names?: readonly string[]
}

/**
 * 安装记录表。
 *
 * 键是 canonicalKindKey 归一化后的仓库引用，**查询接口对任何等价拼写宽容**：
 * 市场索引里的 repo 是原样大小写（WriteAudit/Probe-Skill-Mixed），客户端把记录体里
 * 的 repo 原样回传给卸载 op，而表键是小写——两者不相等。修复做在**查表侧**而不是
 * 写入侧，因为记录体的 repo 是给用户看的展示名，把它小写化会让 UI 丢掉原始大小写。
 *
 * 宽容只作用在 get/has/delete 的入参上；遍历（entries/values/keys）与落盘仍是每个记录
 * 一条，所以不会出现"同一个记录在列表里显示两次"。
 */
export class KindRecordMap extends Map<string, InstalledKind> {
  /**
   * 按任意等价拼写取记录。
   *
   * 顺序：规范键 → 原样键 → 逐条比对（键与记录体 repo 都过一遍归一化）。
   * 逐条比对是最后的兜底：旧包写的记录可能以 URL 为键、以 owner/repo 为体。
   *
   * @param ref - 仓库拼写。
   * @returns 记录；不存在时 undefined。
   */
  override get(ref: string): InstalledKind | undefined {
    const canonical = canonicalKindKey(ref)
    const direct = super.get(canonical)
    if (direct !== undefined) return direct
    const raw = super.get(ref)
    if (raw !== undefined) return raw
    const wanted = normalizeRepoRef(ref)
    if (wanted === null) return undefined
    for (const [key, record] of this) {
      if (canonicalKindKey(key) === wanted) return record
      if (typeof record.repo === 'string' && canonicalKindKey(record.repo) === wanted) return record
    }
    return undefined
  }

  /**
   * 是否存在等价拼写的记录。
   * @param ref - 仓库拼写。
   * @returns 是否存在。
   */
  override has(ref: string): boolean {
    return this.get(ref) !== undefined
  }

  /**
   * 按任意等价拼写删除记录（删的是它真正存放时用的那个键）。
   * @param ref - 仓库拼写。
   * @returns 是否真的删掉了一条。
   */
  override delete(ref: string): boolean {
    const key = this.keyOf(ref)
    return key === undefined ? false : super.delete(key)
  }

  /**
   * 找出某个仓库拼写真正对应的键。
   * @param ref - 仓库拼写。
   * @returns 表中的键；不存在时 undefined。
   */
  keyOf(ref: string): string | undefined {
    const canonical = canonicalKindKey(ref)
    if (super.has(canonical)) return canonical
    if (super.has(ref)) return ref
    const wanted = normalizeRepoRef(ref)
    if (wanted === null) return undefined
    for (const [key, record] of this) {
      if (canonicalKindKey(key) === wanted) return key
      if (typeof record.repo === 'string' && canonicalKindKey(record.repo) === wanted) return key
    }
    return undefined
  }
}

/**
 * 组装一条安装记录（把落地结果 + 仓库身份收敛成落盘形态）。
 *
 * @param kind - 资源类型。
 * @param repo - 仓库展示名（原样大小写，UI 直接展示）。
 * @param outcome - 直装结果。
 * @returns 可直接落盘的记录。
 */
export function kindRecordOf(
  kind: Exclude<MarketItemKind, 'unknown'>,
  repo: string,
  outcome: InstallOutcome,
): StoredKindRecord {
  return {
    kind,
    repo,
    // 单目录时记录那个目录，多目录时记录根——两者都能被幽灵判定与卸载路径使用。
    dir: outcome.dirs.length === 1 ? outcome.dirs[0]! : outcome.location,
    installedAt: new Date().toISOString(),
    dirs: [...outcome.dirs],
    names: [...outcome.names],
  }
}

/** 记录代数：每次落盘自增。 */
let kindGeneration = 0

/** 当前记录代数（0 表示本进程还没读过记录）。 */
export function kindRecordsGeneration(): number {
  return kindGeneration
}

/** 原子写 JSON：先写临时文件再改名，避免崩溃/并发留下截断的 JSON。 */
async function writeJsonAtomic(path: string, payload: unknown): Promise<void> {
  await mkdir(cacheRoot(), { recursive: true, mode: 0o700 })
  const tmp = path + '.' + String(process.pid) + '.tmp'
  await writeFile(tmp, JSON.stringify(payload, undefined, 2) + String.fromCharCode(10), { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, path)
  kindGeneration += 1
}

/** 解析记录文件，容错（坏文件读成空表）。 */
function parseRecords(text: string): KindRecordMap {
  const map = new KindRecordMap()
  try {
    const data = JSON.parse(text) as { records?: Record<string, InstalledKind> }
    for (const [key, value] of Object.entries(data.records ?? {})) {
      if (value === null || typeof value !== 'object') continue
      map.set(key, value)
    }
  } catch {
    // 坏文件当成空表：调用方随后写入会重建它。
  }
  return map
}

/**
 * 读取安装记录（带进程内缓存）。
 *
 * 兼容读取旧包的 installed-kinds.json：两个包可能共存一段时间，用户已经装好的
 * 技能/预设不该在新插件里"消失"。合并规则是本文件优先（同键时以我们自己的为准），
 * 写入永远只写本文件。
 *
 * @returns 记录表（副本；调用方改它不影响缓存）。
 */
export async function loadKindRecords(): Promise<KindRecordMap> {
  if (kindCache !== null) return new KindRecordMap(kindCache)
  const map = new KindRecordMap()
  for (const file of [legacyKindRecordsFile(), kindRecordsFile()]) {
    if (!existsSync(file)) continue
    try {
      for (const [key, value] of parseRecords(await readFile(file, 'utf8'))) map.set(key, value)
    } catch {
      // 文件不可读只意味着"没有可继承的记录"，不是错误。
    }
  }
  kindCache = map
  kindGeneration += 1
  return new KindRecordMap(map)
}

/**
 * 写入一条记录（串行读改写）。
 *
 * 键走 canonicalKindKey（小写 owner/repo），记录体里的 repo 原样保留——展示名不能被
 * 键的归一化污染，查询侧由 KindRecordMap 承担宽容。
 *
 * @param repoKey - 仓库引用（会被归一化）。
 * @param record - 记录内容（可以是带 dirs/names 的落盘形态）。
 */
export async function saveKindRecord(repoKey: string, record: InstalledKind | StoredKindRecord): Promise<void> {
  const key = canonicalKindKey(repoKey)
  await enqueueMutation(async () => {
    const records = await loadKindRecords()
    records.set(key, record)
    kindCache = records
    await writeJsonAtomic(kindRecordsFile(), { version: RECORD_FORMAT, records: Object.fromEntries(records) })
  })
}

/**
 * 删除一条记录（串行读改写）。
 * @param repoKey - 仓库引用（会被归一化）。
 * @returns 是否真的存在并被删除。
 */
export async function removeKindRecord(repoKey: string): Promise<boolean> {
  const key = canonicalKindKey(repoKey)
  return await enqueueMutation(async () => {
    const records = await loadKindRecords()
    const existed = records.delete(key)
    if (existed) {
      kindCache = records
      await writeJsonAtomic(kindRecordsFile(), { version: RECORD_FORMAT, records: Object.fromEntries(records) })
    }
    return existed
  })
}

/**
 * 按任意等价拼写查一条安装记录（含它真正存放时用的键）。
 *
 * 这是写入侧与卸载侧应该用的显式入口：调用方拿到的是 `{ key, record }`，卸载时用 `key`
 * 精确删除、用 `record.dirs` 精确清理目录，不再依赖"查表键恰好等于客户端回传字符串"。
 *
 * @param repoRef - 任意仓库拼写（owner/repo、URL、github:、展示名）。
 * @returns 记录与其键；不存在时 undefined。
 */
export async function findKindRecord(repoRef: string): Promise<{ readonly key: string; readonly record: StoredKindRecord } | undefined> {
  const records = await loadKindRecords()
  const record = records.get(repoRef)
  if (record === undefined) return undefined
  const key = records.keyOf(repoRef)
  return { key: key ?? canonicalKindKey(repoRef), record: record as StoredKindRecord }
}

/**
 * 一条记录应当清理的目录（越界的不返回）。
 *
 * 优先用落盘形态的 `dirs`（多目录安装也精确）；旧记录退回 `dir`。返回的目录已经过
 * isUnderRoot 过滤——卸载是破坏性操作，宁可少删也不越界删。
 *
 * @param record - 安装记录。
 * @param root - 允许的根（技能根或预设根）。
 * @returns 应当删除的绝对目录列表（去重、保持记录顺序）。
 */
export function kindDirsOf(record: InstalledKind | StoredKindRecord, root: string): string[] {
  const stored = record as StoredKindRecord
  const candidates = Array.isArray(stored.dirs) && stored.dirs.length > 0
    ? stored.dirs
    : record.dir === '' ? [] : [record.dir]
  const out: string[] = []
  for (const dir of candidates) {
    if (typeof dir !== 'string' || dir === '') continue
    if (!isUnderRoot(dir, root)) continue
    if (!out.includes(dir)) out.push(dir)
  }
  return out
}

/**
 * 扫描技能根与预设根，找出**没有任何安装记录认领**的目录。
 *
 * 为什么要有它：卸载失败、用户手工放置、外部工具清理记录都会留下目录残留，而契约
 * （KindListResult.orphans）与客户端字典都承诺展示这一节。发布一个恒为空的区块等于
 * 让用户以为"磁盘干净"，所以这里给出真实扫描。
 *
 * 扫描语义（刻意保守，宁可少报也不误报）：
 *   - 只扫根的**下一层**目录：安装永远落在根下第一层，更深层属于技能/预设自己的内容，
 *     把它们当成"未登记目录"没有意义；
 *   - 跳过点目录（`.dsh-preset-owner.json` 之类的标记是文件，点目录不是安装产物）；
 *   - 认领判定：任一记录的 `dirs` 或 `dir` 等于该目录，或者（旧记录没有 `dirs`、且 `dir`
 *     等于根本身时）该目录名等于仓库末段的 slug——即单根安装的命名规则。
 *     旧的多目录记录无法精确归属其余子目录，按"宁可少报"处理。
 *
 * @param options - 根覆盖（测试用）。
 * @returns 未登记目录的绝对路径（排序后）。
 */
export async function findOrphanKindDirs(options: { readonly skillsRootDir?: string; readonly presetsRootDir?: string } = {}): Promise<string[]> {
  const roots = [
    { root: options.skillsRootDir ?? skillsRoot(), kind: 'skill' as const },
    { root: options.presetsRootDir ?? presetsRoot(), kind: 'agent-preset' as const },
  ]
  const records = await loadKindRecords()
  const claimed = new Set<string>()
  for (const record of records.values()) {
    const stored = record as StoredKindRecord
    if (record.dir !== '') claimed.add(resolve(record.dir))
    if (Array.isArray(stored.dirs)) {
      for (const dir of stored.dirs) {
        if (typeof dir === 'string' && dir !== '') claimed.add(resolve(dir))
      }
    }
    for (const { root, kind } of roots) {
      if (record.kind !== kind || resolve(record.dir) !== resolve(root)) continue
      claimed.add(resolve(join(root, slugDirName(lastSegment(record.repo)))))
    }
  }
  const orphans: string[] = []
  for (const { root } of roots) {
    for (const entry of await readEntries(root)) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const dir = join(root, entry.name)
      if (claimed.has(resolve(dir))) continue
      orphans.push(dir)
    }
  }
  return orphans.sort()
}

/** 一条记录在磁盘上是否还有对应目录。 */
function recordAlive(record: InstalledKind): boolean {
  if (record.dir !== '' && record.dir !== skillsRoot() && record.dir !== presetsRoot()) {
    return existsSync(record.dir)
  }
  if (record.kind === 'cordis-plugin') return record.dir !== '' && existsSync(record.dir)
  // 多目录安装记录的是根：至少得有一个由仓库名派生的子目录还在。
  const slug = slugDirName(lastSegment(record.repo))
  const root = record.kind === 'skill' ? skillsRoot() : presetsRoot()
  return existsSync(join(root, slug))
}

/**
 * 清理幽灵记录：目录被插件外部删掉（手工 rm、别的工具、临时目录清理）的记录。
 *
 * 进程内缓存看不到外部删除，所以每个读取面（列表、市场已安装标记）都要先调它，
 * 否则已删的技能会永远显示"已安装"。
 *
 * @returns 被清掉的记录键。
 */
export async function pruneGhostRecords(): Promise<string[]> {
  return await enqueueMutation(async () => {
    const records = await loadKindRecords()
    const dropped: string[] = []
    for (const [key, record] of records) {
      if (recordAlive(record)) continue
      records.delete(key)
      dropped.push(key)
    }
    if (dropped.length > 0) {
      kindCache = records
      await writeJsonAtomic(kindRecordsFile(), { version: RECORD_FORMAT, records: Object.fromEntries(records) })
    }
    return dropped
  })
}

/** 清空记录与屏蔽名单缓存（测试用；让下一次读取重新读盘）。 */
export function __resetKindCacheForTests(): void {
  kindCache = null
  blockedCache = null
}

// ── 屏蔽名单（检测为非插件/技能/预设的仓库）───────────────────────────────

/**
 * 读取屏蔽名单（带缓存，兼容旧包的 blocked-repos.json）。
 * @returns 归一化后的仓库引用集合（副本）。
 */
export async function loadBlockedRepos(): Promise<Set<string>> {
  if (blockedCache !== null) return new Set(blockedCache)
  const set = new Set<string>()
  const legacy = join(cacheRoot(), 'blocked-repos.json')
  for (const file of [legacy, blockedReposFile()]) {
    if (!existsSync(file)) continue
    try {
      const data = JSON.parse(await readFile(file, 'utf8')) as { repos?: unknown }
      if (!Array.isArray(data.repos)) continue
      for (const repo of data.repos) {
        if (typeof repo !== 'string') continue
        set.add(normalizeRepoRef(repo) ?? repo)
      }
    } catch {
      // 坏文件跳过：屏蔽名单少一个条目是可恢复状态，不该让调用方失败。
    }
  }
  blockedCache = set
  return new Set(set)
}

/** 落盘屏蔽名单。 */
async function writeBlockedRepos(set: ReadonlySet<string>): Promise<void> {
  await writeJsonAtomic(blockedReposFile(), { version: RECORD_FORMAT, repos: [...set].sort() })
}

/**
 * 加入屏蔽名单（检测为非三类的仓库）。
 * @param repoKey - 仓库引用。
 * @returns 归一化后的键。
 */
export async function addBlockedRepo(repoKey: string): Promise<string> {
  const key = normalizeRepoRef(repoKey) ?? repoKey
  await enqueueMutation(async () => {
    const set = await loadBlockedRepos()
    set.add(key)
    blockedCache = set
    await writeBlockedRepos(set)
  })
  return key
}

/**
 * 移出屏蔽名单（市场页"解除屏蔽"）。
 * @param repoKey - 仓库引用。
 * @returns 是否真的存在并被移除。
 */
export async function removeBlockedRepo(repoKey: string): Promise<boolean> {
  const key = normalizeRepoRef(repoKey) ?? repoKey
  return await enqueueMutation(async () => {
    const set = await loadBlockedRepos()
    const existed = set.delete(key)
    if (existed) {
      blockedCache = set
      await writeBlockedRepos(set)
    }
    return existed
  })
}

/**
 * 判断仓库是否被屏蔽。
 * @param repoKey - 仓库引用。
 * @returns 是否在屏蔽名单里。
 */
export async function isBlockedRepo(repoKey: string): Promise<boolean> {
  const key = normalizeRepoRef(repoKey) ?? repoKey
  return (await loadBlockedRepos()).has(key)
}

/**
 * 目录是否存在且是目录（供 UI/CLI 汇报"记录是否还活着"）。
 * @param path - 绝对路径。
 * @returns 是否为存在的目录。
 */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * 升级引擎（档三）：把"升级已装插件"做成真实可执行、且**说清边界**的能力。
 *
 * 归属：A 类·重写（新代码；旧仓库没有升级能力，只有 CLI 的 `update` 把 spec 重写到 @latest）。
 * 官方复用：
 *   · 写通道只有一条 —— 官方 `runPluginCommand(['add', '<name>@<version>'])`（绝不自己调 pnpm，
 *     也绝不写 cordis.patch.yml）；官方 CLI 的 plugin 子命令与我们走的是同一条通道。
 *   · 版本查询走本仓库既有的出网层（net.ts 的 Fetcher），不新造 HTTP 客户端。
 *   · 金丝雀复用 task-50/75 的试装引擎：它就是"在 <环境>-dpmc 里装候选再跑两次启动"。
 * 前提检查：旧前提是"官方只有只读清单，升级得自己想办法"。0.1.6 之后官方给了完整写面与
 *   `installed` / `removable` 事实，所以本模块只做官方不覆盖的三件事：版本事实（dist-tags）、
 *   三类单元的分类、金丝雀与回滚的盘上核对。
 *
 * 三类单元（必须分开对待，这是本模块的核心诚实点）：
 *   1. `profile-dependency`：在 profile 的 dependencies 里 → 可在 profile 内升级；
 *   2. `installation-provided`：只出现在 dsh.profile.bundles 里（官方运行时层 dsh-base / dsh-web-app）
 *      → profile 内**升不了**，只检测 + 给命令，不给按钮；
 *   3. `self`：本插件自身 → 可升级，但**正在运行的就是旧代码**，必须走独立 job 并写明"下次启动生效"。
 *
 * 四态：`update-available` / `up-to-date` / `unknown` / `not-upgradable`。
 * 铁律：拿不到版本事实一律 `unknown`（文案"查不到"），**绝不**显示"已是最新"——"没查到"与
 *   "确实没有更新"是两个不同的状态，把前者说成后者就是编一个事实。
 *
 * 出网纪律（Lead 定稿）：检查时机 = 进入即查 + TTL + 手动常驻，**不做后台轮询**。
 *   "每天一次"的语义是"下次进入时若距上次成功检查超过 24h 就查"；失败也记时间戳（1 小时内不自动重试，
 *   免得每次进入都等超时）；手动按钮永远可用（不受开关、TTL 与负缓存限制）。
 */

import { lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PackageOperationContext, PackageOperationOptions } from '@deepseek-ai/dsh-plugin-manager/operations'
import type { PackageResult } from '@deepseek-ai/dsh-plugin-manager/types'
import { EnvironmentError, removeTrialEnvironment, runTrialInstall, trialEnvironmentName } from './envManager.ts'
import type { BootVerification, PluginCommandRunner, TrialInstallOptions, TrialInstallResult } from './envManager.ts'

/**
 * 试装执行器（测试注入金丝雀结论）。
 *
 * 与 index.ts 里那个 TrialRunner **结构相同、刻意各自定义**：index.ts 要 import 本模块的 op 编排，
 * 本模块再去 import 它的类型就成环了。类型层面结构一致，互相传参没有问题。
 */
export type UpgradeTrialRunner = (
  spec: string, realName: string, options: TrialInstallOptions,
) => Promise<TrialInstallResult>
import { compareVersions } from './match.ts'
import { registryItems } from './marketplace.ts'
import { fetchWithProxy, type Fetcher } from './net.ts'
import { OUR_PACKAGE_NAME, dshHome, environmentDir, isSafeEnvironmentName, readEnvironmentManifest } from './paths.ts'
import { readRegistryCacheFile, type RegistryRepo } from './registry.ts'
import { effectiveTrialConfig, effectiveUpgradeConfig, upgradeIntervalMs, type CompanionConfig } from './settings.ts'
import type {
  UpgradeActionResult, UpgradeCanaryReport, UpgradeCheckResult, UpgradeRollbackResult, UpgradeState,
  UpgradeTag, UpgradeUnitKind, UpgradeUnitReport,
} from './types.ts'

// ── 常量 ─────────────────────────────────────────────────────────────────

/** 配置留空时的 registry（官方 npm）。 */
export const OFFICIAL_REGISTRY_URL = 'https://registry.npmjs.org'

/** 单次 registry 查询的超时（一个包文档很小，15s 是宽松上限）。 */
export const REGISTRY_TIMEOUT_MS = 15_000

/** 一次检查里所有出网查询的总预算；超了就停手并如实记账，不拖住页面。 */
export const CHECK_BUDGET_MS = 20_000

/**
 * 检查失败后的静默期：1 小时内不再自动重试。
 *
 * 存在的理由：registry 挂掉时，每次进入关于页都等一次 15s 超时是折磨；手动按钮不受它限制。
 */
export const NEGATIVE_TTL_MS = 60 * 60 * 1000

/** tags 磁盘缓存的格式版本（与 registry 缓存同一纪律：格式不符即视为无缓存）。 */
export const TAGS_CACHE_FORMAT = 1

/** tags 磁盘缓存文件名（放在我们自己的缓存目录里，与市场索引缓存同级）。 */
export const TAGS_CACHE_FILE = 'upgrade-tags.json'

/** 官方包操作的服务侧输出上限与锁等待（与 envManager 同量级）。 */
const OPERATION_OUTPUT_BYTES = 64 * 1024
const OPERATION_LOCK_WAIT_MS = 120_000

// ── 出网：dist-tags ──────────────────────────────────────────────────────

/** 一次 dist-tags 查询的入参。 */
export interface DistTagsQuery {
  /** registry 地址；留空 = 官方 registry。 */
  readonly registryUrl?: string
  readonly timeoutMs?: number
  /** 抓取器注入（测试）；省略时用 net.ts 的带代理实现。 */
  readonly fetch?: Fetcher
}

/** 一次 dist-tags 查询的结果。 */
export interface DistTagsAnswer {
  readonly ok: boolean
  /** tag 名 → 版本；失败时为 null。 */
  readonly tags: Readonly<Record<string, string>> | null
  /** 失败原因（面向用户；成功时为 undefined）。 */
  readonly reason?: string
}

/**
 * 包文档 URL。
 *
 * scoped 名必须整体转义（`@scope/name` → `%40scope%2Fname`），否则 `/` 会被当成路径分隔符。
 *
 * @param registryUrl - registry 基地址（可带尾斜杠）。
 * @param name - 包名。
 * @returns 文档 URL。
 */
export function registryDocumentUrl(registryUrl: string, name: string): string {
  const base = (registryUrl.length === 0 ? OFFICIAL_REGISTRY_URL : registryUrl).replace(/\/+$/, '')
  return base + '/' + encodeURIComponent(name)
}

/**
 * 从 registry 文档里取 dist-tags（纯函数，便于用固定载荷测试）。
 *
 * 只认 `dist-tags`；缺字段或值不是字符串时返回 null（**不猜**：把 `versions` 里最大的那个
 * 当成 latest 会与 tag 的真实语义脱钩）。
 *
 * @param payload - 解析后的 JSON。
 * @returns tag 表；拿不到时 null。
 */
export function parseDistTags(payload: unknown): Record<string, string> | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  const raw = (payload as Record<string, unknown>)['dist-tags']
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const tags: Record<string, string> = {}
  for (const [tag, version] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof version !== 'string' || version.length === 0) continue
    tags[tag] = version
  }
  return Object.keys(tags).length === 0 ? null : tags
}

/**
 * 查一个包的 dist-tags。
 *
 * 失败一律以 `ok: false` + reason 返回（调用方据此显示"查不到"），不抛异常：
 * 一次网络抖动不该让整页检查失败。
 *
 * @param name - 包名。
 * @param query - registry 地址 / 超时 / 抓取器。
 * @returns 结果。
 */
export async function fetchDistTags(name: string, query: DistTagsQuery = {}): Promise<DistTagsAnswer> {
  const url = registryDocumentUrl(query.registryUrl ?? '', name)
  const fetcher = query.fetch ?? fetchWithProxy
  try {
    const response = await fetcher(url, {
      timeoutMs: query.timeoutMs ?? REGISTRY_TIMEOUT_MS,
      headers: { accept: 'application/json' },
    })
    if (response.status === 404) return { ok: false, tags: null, reason: 'registry 里没有这个包（404）' }
    if (!response.ok) return { ok: false, tags: null, reason: 'registry 返回 HTTP ' + String(response.status) }
    const payload = JSON.parse(await response.text()) as unknown
    const tags = parseDistTags(payload)
    return tags === null
      ? { ok: false, tags: null, reason: 'registry 响应里没有 dist-tags（可能不是 npm 包）' }
      : { ok: true, tags }
  } catch (error) {
    return { ok: false, tags: null, reason: 'registry 查询失败：' + messageOf(error) }
  }
}

// ── 版本比较与"线" ───────────────────────────────────────────────────────

/**
 * 一条版本线（major.minor.patch）；非法/缺失时 null。
 *
 * "与当前版本同线"= 同 major.minor.patch（例如 0.1.6-alpha.2 与 0.1.6-alpha.9 同线，
 * 与 0.1.7 不同线）。判定只做字符串切分，不假装懂 semver：比较大小交给 match.ts 的 compareVersions。
 *
 * @param version - 版本串。
 * @returns 线，或 null。
 */
export function versionLine(version: string | null): string | null {
  if (version === null || version.length === 0) return null
  const core = version.split('-')[0] ?? ''
  const parts = core.split('.')
  if (parts.length < 2 || parts.some((part) => !/^\d+$/.test(part))) return null
  return parts.slice(0, 3).join('.')
}

/**
 * 一个包是不是本地来源（`link:` / `file:` / 相对或绝对路径）。
 *
 * 本地来源也能"升级"到 registry 版本，但那会**改变来源**（不再是本地那份）——必须显式说出来。
 *
 * @param spec - dependencies 里的 spec。
 * @returns 是本地来源时 true。
 */
export function isLocalSpec(spec: string | undefined): boolean {
  if (spec === undefined) return false
  const trimmed = spec.trim()
  return /^(?:link|file):/i.test(trimmed) || trimmed.startsWith('.') || isAbsolute(trimmed)
}

/** 把 dist-tags 折成界面要的列表（含"同线/另一条线"与默认高亮）。 */
export function tagReports(tags: Readonly<Record<string, string>>, currentVersion: string | null): readonly UpgradeTag[] {
  const current = versionLine(currentVersion)
  const entries = Object.entries(tags)
  const sameLine = entries.filter(([, version]) => current !== null && versionLine(version) === current)
  let preferredVersion: string | null = null
  for (const [, version] of sameLine) {
    if (preferredVersion === null || compareVersions(version, preferredVersion) > 0) preferredVersion = version
  }
  return entries.map(([tag, version]) => ({
    tag,
    version,
    line: current === null ? 'unknown' : versionLine(version) === current ? 'same-line' : 'other-line',
    preferred: preferredVersion !== null && version === preferredVersion,
  }))
}

/**
 * 默认目标版本：与当前同线的**最新**；没有同线候选（或当前版本未知）时取 `latest`，
 * 再退一步取所有 tag 里版本最大的那个（顺序即优先级，界面据此说"会切到哪条线"）。
 *
 * @param tags - tag 表。
 * @param currentVersion - 当前版本。
 * @returns 目标版本与提供它的 tag；没有可用 tag 时 null。
 */
export function pickTarget(
  tags: Readonly<Record<string, string>>, currentVersion: string | null,
): { readonly version: string; readonly tag: string } | null {
  const entries = Object.entries(tags)
  if (entries.length === 0) return null
  const current = versionLine(currentVersion)
  if (current !== null) {
    const sameLine = entries.filter(([, version]) => versionLine(version) === current)
    if (sameLine.length > 0) {
      let best = sameLine[0]!
      for (const entry of sameLine) if (compareVersions(entry[1], best[1]) > 0) best = entry
      return { version: best[1], tag: best[0] }
    }
  }
  const latest = tags['latest']
  if (typeof latest === 'string' && latest.length > 0) return { version: latest, tag: 'latest' }
  let best = entries[0]!
  for (const entry of entries) if (compareVersions(entry[1], best[1]) > 0) best = entry
  return { version: best[1], tag: best[0] }
}

// ── tags 磁盘缓存（按包 + TTL + 负缓存）────────────────────────────────────

/** 一个包的缓存条目。 */
export interface TagsCacheEntry {
  readonly ok: boolean
  readonly tags: Readonly<Record<string, string>> | null
  /** 这次查询发生的时刻（epoch ms）。 */
  readonly at: number
  readonly reason?: string
  /**
   * 这条事实是在**哪个环境**的检查里取到的。
   *
   * 为什么必须带上它（不是可有可无的记账）：dist-tags 本身与环境无关，但"查不到"是
   * **逐环境**的用户体验。实测反例（就是这条红测）：A 环境刚查成功，B 环境里同一个包
   * 就再也不出网了——因为全局时间戳把 B 的检查判成"还没到期"，于是 B 永远看不到
   * 自己的失败，也就永远拿不到属于它的"查不到 + 重试"。条目只在自己取到的那个环境里
   * 生效，换环境一律重新取。
   */
  readonly environment: string
}

/**
 * 一个环境的检查记账。
 *
 * 为什么记账是**逐环境**的（而不是全局一份）：TTL 的语义是"这个环境下次进入时要不要出网"，
 * 而"查不到"是**逐环境**的用户体验。实测反例（就是这条红测）：A 环境刚查成功，
 * 紧接着 B 环境进入时被全局时间戳判成"还没到期"→ B 一次网都不出，于是 B 永远看不到
 * 自己的失败，也永远拿不到属于它的"查不到 + 重试"。全局时间戳把两个环境的账记成了一本。
 */
export interface TagsCacheEnvState {
  /** 这个环境上次**成功**拿到版本事实的时刻；从未成功过时 null。 */
  readonly lastCheckAt: number | null
  /** 这个环境上次**尝试**（含失败）的时刻；用于负缓存。 */
  readonly lastAttemptAt: number | null
}

/** 磁盘缓存文件。 */
export interface TagsCacheFile {
  /** 逐环境的检查记账（环境名 → 记账）。 */
  readonly environments: Readonly<Record<string, TagsCacheEnvState>>
  /**
   * 逐包的版本事实。
   *
   * 键是包名，但每条都带 {@link TagsCacheEntry.environment}：条目只在自己取到的那个
   * 环境里生效，换环境一律重新取（见那个字段的注释）。
   */
  readonly packages: Readonly<Record<string, TagsCacheEntry>>
}

/** 取某个环境的记账；没有时给一份"从未查过"的空账。 */
function envStateOf(cache: TagsCacheFile, environment: string): TagsCacheEnvState {
  return cache.environments[environment] ?? { lastCheckAt: null, lastAttemptAt: null }
}

/** 缓存文件路径（我们自己的缓存目录，与市场索引缓存同级）。 */
export function tagsCachePath(): string {
  return join(dshHome(), 'plugin-manager-companion', TAGS_CACHE_FILE)
}

/**
 * 读缓存；不存在/损坏/格式不符时返回空壳（**不抛**：缓存是可重建的派生物）。
 *
 * @returns 缓存内容。
 */
export function readTagsCache(): TagsCacheFile {
  const empty: TagsCacheFile = { environments: {}, packages: {} }
  const path = tagsCachePath()
  if (!existsSync(path)) return empty
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    if (raw['formatVersion'] !== TAGS_CACHE_FORMAT) return empty
    const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
    const environments: Record<string, TagsCacheEnvState> = {}
    const rawEnvironments = raw['environments']
    if (rawEnvironments !== null && typeof rawEnvironments === 'object' && !Array.isArray(rawEnvironments)) {
      for (const [name, value] of Object.entries(rawEnvironments as Record<string, unknown>)) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
        const state = value as Record<string, unknown>
        environments[name] = {
          lastCheckAt: num(state['lastCheckAt']),
          lastAttemptAt: num(state['lastAttemptAt']),
        }
      }
    }
    const packages: Record<string, TagsCacheEntry> = {}
    const rawPackages = raw['packages']
    if (rawPackages !== null && typeof rawPackages === 'object' && !Array.isArray(rawPackages)) {
      for (const [name, value] of Object.entries(rawPackages as Record<string, unknown>)) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
        const entry = value as Record<string, unknown>
        const at = typeof entry['at'] === 'number' && Number.isFinite(entry['at']) ? entry['at'] : null
        // 没有环境标签的条目一律丢弃：它是旧格式（或被人手改过）的残留，
        // 而"这条事实属于哪个环境"正是我们不敢猜的那件事。
        const environment = typeof entry['environment'] === 'string' && entry['environment'].length > 0
          ? entry['environment'] : null
        if (at === null || environment === null) continue
        const ok = entry['ok'] === true
        packages[name] = {
          ok,
          tags: ok ? parseDistTags({ 'dist-tags': entry['tags'] }) : null,
          at,
          environment,
          ...typeof entry['reason'] === 'string' ? { reason: entry['reason'] } : {},
        }
      }
    }
    return { environments, packages }
  } catch {
    return empty
  }
}

/**
 * 写缓存（失败不抛，返回是否写成功）。
 *
 * @param file - 要写的内容。
 * @returns 是否写成功。
 */
export function writeTagsCache(file: TagsCacheFile): boolean {
  try {
    const path = tagsCachePath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({
      formatVersion: TAGS_CACHE_FORMAT,
      environments: file.environments,
      packages: file.packages,
    }) + '\n')
    return true
  } catch {
    return false
  }
}

/**
 * 一条缓存是否仍然可用（纯函数，**逐包判定**）。
 *
 * 成功的条目按配置的检查间隔计时；失败的条目按 {@link NEGATIVE_TTL_MS} 计时
 * （失败也要记时间戳，否则每次进入都会重试一次超时）。
 *
 * 为什么判据是**条目自己的** at 而不是全局时间戳：全局时间戳会让一个包的成功
 * 顺带放行另一个包的负缓存。实测反例（就是这条红测）：环境 A 的包查成功之后，
 * 同一个环境 B 里刚失败过的包在"1 小时内不自动重试"的窗口里又被查了一次。
 *
 * @param entry - 缓存条目。
 * @param now - 当前时刻。
 * @param ttlMs - 成功条目的有效期；null = 仅手动（此时对成功条目返回 true，
 *   语义是"不因过期而自动查"——真正的自动检查开关由调用方管）。
 * @returns 可直接使用该条目时 true。
 */
export function tagsCacheUsable(entry: TagsCacheEntry, now: number, ttlMs: number | null): boolean {
  const age = now - entry.at
  if (entry.ok) return ttlMs === null ? true : age <= ttlMs
  return age <= NEGATIVE_TTL_MS
}

// ── 三类单元的事实（全部读盘）─────────────────────────────────────────────

/** 一个升级单元的事实（读盘得来，不含网络）。 */
export interface UpgradeUnitFact {
  readonly name: string
  readonly kind: UpgradeUnitKind
  /** dependencies 里的 spec；安装方提供的层没有这一项。 */
  readonly spec?: string
  /** spec 是本地来源（升级会改变来源）。 */
  readonly specIsLocal: boolean
  /** 当前版本（node_modules 里那个包的 version）；读不到时 null。 */
  readonly currentVersion: string | null
}

/** 读 manifest 里 dependencies 的 name → spec（原样，不做归一）。 */
function dependencySpecs(dir: string): Record<string, string> {
  const raw = readEnvironmentManifest(dir).raw
  const dependencies = raw['dependencies']
  const out: Record<string, string> = {}
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) return out
  for (const [name, spec] of Object.entries(dependencies as Record<string, unknown>)) {
    if (typeof spec === 'string' && spec.length > 0) out[name] = spec
  }
  return out
}

/**
 * 一个包在当前环境里装着的版本（读 node_modules/<name>/package.json）。
 *
 * 读不到就返回 null（link: 断链、没装、目录不可读都算）——**不猜**，调用方按"当前版本未知"处理。
 *
 * @param environment - 环境名。
 * @param name - 包名。
 * @returns 版本，或 null。
 */
export function readInstalledVersion(environment: string, name: string): string | null {
  const dir = environmentDir(environment)
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8')) as Record<string, unknown>
    const version = manifest['version']
    return typeof version === 'string' && version.length > 0 ? version : null
  } catch {
    return null
  }
}

/**
 * 列出这个环境的全部升级单元（三类）。
 *
 * 分类只认**盘上的结构事实**：出现在 dependencies 里 = profile 依赖（可升）；只出现在
 * dsh.profile.bundles 里 = 安装方提供的层（profile 内升不了）。这一条与官方 listBundles 的
 * `installed` 字段同源（已核实：dsh-base / dsh-web-app 只在 bundles 里、不在 dependencies 里）。
 *
 * @param environment - 环境名。
 * @param options - 本插件自身包名（默认取常量；测试可覆盖）。
 * @returns 单元清单（按名字排序，顺序稳定便于断言）。
 * @throws {EnvironmentError} 环境名不合法或环境不存在时。
 */
export function unitFacts(environment: string, options: { readonly ourPackage?: string } = {}): readonly UpgradeUnitFact[] {
  if (!isSafeEnvironmentName(environment)) {
    throw new EnvironmentError('invalid-name', '环境名不合法：' + JSON.stringify(environment))
  }
  const dir = environmentDir(environment)
  if (!existsSync(join(dir, 'package.json'))) {
    throw new EnvironmentError('not-found', '环境不存在：' + environment)
  }
  const manifest = readEnvironmentManifest(dir)
  const specs = dependencySpecs(dir)
  const ours = options.ourPackage ?? OUR_PACKAGE_NAME
  const names = [...new Set([...manifest.bundles, ...Object.keys(specs)])].sort()
  return names.map((name) => {
    const spec = specs[name]
    const kind: UpgradeUnitKind = name === ours ? 'self' : spec === undefined ? 'installation-provided' : 'profile-dependency'
    return {
      name,
      kind,
      ...spec === undefined ? {} : { spec },
      specIsLocal: isLocalSpec(spec),
      currentVersion: readInstalledVersion(environment, name),
    }
  })
}

/**
 * 安装方提供的层该给什么命令。
 *
 * 刻意**不**给 `dsh plugin add` / `dshpmc update`：那会把这一层变成 profile 的依赖（装出第二份），
 * 是"看起来能修、其实更坏"的建议。真正要做的是升级 dsh 安装本身，而具体命令取决于当初怎么装的，
 * 所以这里只给一种常见形态 + 明确的口径说明。
 *
 * @param name - 包名。
 * @returns 面向用户的命令说明。
 */
export function installationUpgradeCommand(name: string): string {
  return '升级 dsh 安装本身（' + name + ' 由安装方提供，不在 profile 的依赖里；'
    + '命令取决于当初的安装方式，例如 npm i -g @deepseek-ai/dsh@latest / pnpm add -g @deepseek-ai/dsh@latest）'
}

// ── 市场索引事实（零网络，优先级 ①）───────────────────────────────────────

/** 市场索引给出的版本事实。 */
export interface MarketVersionFact {
  readonly version: string
  /** 索引的生成时间（ISO）；拿不到时为 null。 */
  readonly at: string | null
}

/**
 * 从**已有的**市场索引缓存里找这个包的最新版本（零网络）。
 *
 * 只用缓存，不触发索引下载：关于页的一次检查不该顺手拉一份几 MB 的索引。
 *
 * @param name - 包名。
 * @param options - 注入索引仓库（测试）；省略时读磁盘缓存。
 * @returns 事实，或 null。
 */
export function marketVersionFact(name: string, options: { readonly repos?: readonly RegistryRepo[] } = {}): MarketVersionFact | null {
  let repos: readonly RegistryRepo[]
  let at: string | null = null
  if (options.repos !== undefined) {
    repos = options.repos
  } else {
    const cached = readRegistryCacheFile()
    if (cached === null) return null
    repos = cached.repos
    at = cached.generatedAt ?? new Date(cached.savedAt).toISOString()
  }
  const hit = registryItems(repos).find((item) =>
    item.packageName === name && typeof item.latestVersion === 'string' && item.latestVersion.length > 0)
  if (hit === undefined || typeof hit.latestVersion !== 'string') return null
  return { version: hit.latestVersion, at }
}

// ── 检查：四态 ───────────────────────────────────────────────────────────

/** 检查的选项。 */
export interface UpgradeCheckOptions {
  readonly environment: string
  readonly config: CompanionConfig
  /** 手动检查：无视开关、TTL 与负缓存，强制出网。 */
  readonly refresh?: boolean
  readonly fetch?: Fetcher
  readonly now?: () => number
  readonly ourPackage?: string
  readonly repos?: readonly RegistryRepo[]
}

/**
 * 一个单元的四态（纯函数，便于逐态断言）。
 *
 * @param input - 事实与版本来源。
 * @returns 状态。
 */
export function upgradeStateFor(input: {
  readonly kind: UpgradeUnitKind
  readonly currentVersion: string | null
  readonly targetVersion: string | null
}): UpgradeState {
  if (input.kind === 'installation-provided') return 'not-upgradable'
  if (input.targetVersion === null) return 'unknown'
  if (input.currentVersion === null) return 'unknown'
  return compareVersions(input.targetVersion, input.currentVersion) > 0 ? 'update-available' : 'up-to-date'
}

/**
 * 检查一个环境的升级情况（三类单元 × 四态）。
 *
 * 事实来源优先级（Lead 定稿）：① 市场索引缓存（零网络）② npm registry dist-tags（受 TTL 与开关约束）。
 * 两条都拿不到 = `unknown`（"查不到"），**绝不**显示"已是最新"。
 *
 * @param options - 环境、配置与注入缝。
 * @returns 检查结果。
 */
export async function checkUpgrades(options: UpgradeCheckOptions): Promise<UpgradeCheckResult> {
  const now = options.now ?? Date.now
  const upgrade = effectiveUpgradeConfig(options.config)
  const ttl = upgradeIntervalMs(upgrade.interval)
  const facts = unitFacts(options.environment, options.ourPackage === undefined ? {} : { ourPackage: options.ourPackage })
  const notes: string[] = []
  const cache = readTagsCache()

  const forced = options.refresh === true
  const environment = options.environment
  // 记账与条目都**按环境**取：换环境一律重新出网（见 TagsCacheEnvState 的注释）。
  const envState = envStateOf(cache, environment)
  /**
   * 自动检查的**到期**判定（用本环境自己的记账）。
   *
   * 这里刻意只回答"这一轮要不要出网"，不回答"这个包要不要查"：后者由每个包自己的
   * 条目时间戳判（见下面 cachedUsable）。两个问题混在一个时间戳上，就会出现
   * "A 包查成功 → 刚失败过的 B 包被顺带放行"（实测反例）。
   */
  const autoDue = upgrade.autoCheck && ttl !== null
    && (envState.lastCheckAt === null || now() - envState.lastCheckAt >= ttl)
  let checked = false
  let budgetExceeded = false
  const packages = { ...cache.packages }
  let lastCheckAt = envState.lastCheckAt
  let lastAttemptAt = envState.lastAttemptAt
  const deadline = now() + CHECK_BUDGET_MS

  const units: UpgradeUnitReport[] = []
  for (const fact of facts) {
    const market = marketVersionFact(fact.name, options.repos === undefined ? {} : { repos: options.repos })
    const cachedRaw = cache.packages[fact.name]
    // 条目只在本环境内生效：别的环境取到的事实不是这个环境的事实（换环境一律重新取）。
    const cachedEntry = cachedRaw !== undefined && cachedRaw.environment === environment ? cachedRaw : undefined
    // 逐包判定（**不是**全局时间戳）：成功条目按 TTL、失败条目按 1 小时负缓存，各看自己的 at。
    //
    // 注意负缓存**就是在这里生效的**：失败条目在 1 小时内 tagsCacheUsable 返回 true，
    // 于是直接走"用缓存"那一条分支、不出网；1 小时之后它返回 false，自动检查自然恢复。
    // 曾经另有一个 negativeBlocked 分支想表达同一件事，但它在判定链里**不可达**
    // （能走到那里时 age 必然已超过负缓存窗口）——死分支比没有分支更坏：它看起来在守着什么。
    const cachedUsable = cachedEntry !== undefined && !forced && tagsCacheUsable(cachedEntry, now(), ttl)
    /**
     * 市场索引里已经有版本事实 → 这一轮**不必**为它出网（DESIGN §5.5 的来源优先级 ①）。
     *
     * 判据是"索引里有这个包的版本"，而不是"索引整体可用"：没有它的条目时该查还得查。
     */
    const marketAnswers = market !== null

    let registryTags: Readonly<Record<string, string>> | null = null
    let registryAt: string | undefined
    let registryReason: string | undefined
    if (cachedUsable) {
      // TTL 内的缓存直接用（成功或失败都算），这也是"进页面不卡"的关键。
      if (cachedEntry.ok) { registryTags = cachedEntry.tags; registryAt = new Date(cachedEntry.at).toISOString() }
      else {
        // 失败条目：原样给出上次的失败原因（那是真正的事实），并说清"暂时不会自动重试"。
        const retryIn = NEGATIVE_TTL_MS - (now() - cachedEntry.at)
        registryReason = (cachedEntry.reason ?? '上次查询失败')
          + (retryIn > 0 ? '（距上次失败不到 1 小时，自动检查暂不重试；手动检查可立即重试）' : '')
      }
    } else if (marketAnswers) {
      // 有市场索引事实就不出网：零网络是这一条的全部意义（不查、也不改缓存）。
      registryReason = '市场索引里已有这个包的版本事实，本次没有出网查 registry'
    } else if ((forced || autoDue) && (fact.kind !== 'installation-provided' || fact.currentVersion !== null)) {
      if (now() > deadline) {
        budgetExceeded = true
      } else {
        const answer = await fetchDistTags(fact.name, {
          registryUrl: upgrade.registryUrl,
          ...options.fetch === undefined ? {} : { fetch: options.fetch },
        })
        checked = true
        const at = now()
        lastAttemptAt = at
        packages[fact.name] = {
          ok: answer.ok,
          tags: answer.tags,
          at,
          environment,
          ...answer.reason === undefined ? {} : { reason: answer.reason },
        }
        if (answer.ok) {
          registryTags = answer.tags
          registryAt = new Date(at).toISOString()
          lastCheckAt = at
        } else {
          registryReason = answer.reason
        }
      }
    } else if (!upgrade.autoCheck && !forced) {
      registryReason = '自动检查已关闭（手动检查随时可用）'
    } else if (ttl === null && !forced) {
      registryReason = '检查间隔设为"仅手动"'
    } else if (!autoDue && !forced) {
      const at = envState.lastCheckAt
      registryReason = '距上次成功检查还不到设置的间隔'
        + (at === null ? '' : '（上次：' + new Date(at).toISOString() + '）')
    }

    if (registryTags === null && registryReason === undefined && market === null) {
      registryReason = '还没到检查时间，且没有可用的版本事实'
    }

    const target = registryTags === null ? null : pickTarget(registryTags, fact.currentVersion)
    let state: UpgradeState
    let targetVersion: string | null = null
    let reason: string | undefined
    let source: 'market-index' | 'registry' | undefined
    let at: string | undefined
    let tags: readonly UpgradeTag[] | null = null

    if (registryTags !== null) {
      tags = tagReports(registryTags, fact.currentVersion)
      targetVersion = target?.version ?? null
      source = 'registry'
      at = registryAt
      state = upgradeStateFor({ kind: fact.kind, currentVersion: fact.currentVersion, targetVersion })
      if (state === 'up-to-date') {
        reason = 'registry 上没有比当前更新的版本（同线最新：' + String(target?.version ?? '—') + '）'
      } else if (state === 'unknown' && fact.currentVersion === null) {
        reason = '读不到当前安装的版本（node_modules 里没有这个包或读不出来）'
      }
    } else if (market !== null) {
      // ① 市场索引（零网络）：有版本事实就能判四态；但没有 tag 列表，界面因此不给"挑版本"。
      targetVersion = market.version
      source = 'market-index'
      at = market.at ?? undefined
      state = upgradeStateFor({ kind: fact.kind, currentVersion: fact.currentVersion, targetVersion })
      reason = '来自市场索引（' + (market.at ?? '生成时间未知') + '）；registry 这次没给结果：'
        + String(registryReason ?? '原因未知')
    } else {
      state = fact.kind === 'installation-provided' ? 'not-upgradable' : 'unknown'
      reason = registryReason ?? '没有可用的版本事实'
    }

    units.push({
      name: fact.name,
      kind: fact.kind,
      state,
      currentVersion: fact.currentVersion,
      currentLine: versionLine(fact.currentVersion),
      ...fact.spec === undefined ? {} : { spec: fact.spec },
      targetVersion,
      targetTag: registryTags === null ? null : target?.tag ?? null,
      targetLine: versionLine(targetVersion),
      tags,
      ...source === undefined ? {} : { source },
      ...at === undefined ? {} : { at },
      ...reason === undefined ? {} : { reason },
      ...fact.specIsLocal && fact.kind !== 'installation-provided' ? { changesSource: true } : {},
      ...fact.kind === 'installation-provided' ? { command: installationUpgradeCommand(fact.name) } : {},
    })
  }

  if (budgetExceeded) {
    notes.push('本次检查在 ' + String(CHECK_BUDGET_MS) + 'ms 预算内没查完所有包：没查到的显示"查不到"，下次进入会接着查。')
  }
  if (!upgrade.autoCheck) notes.push('自动检查已关闭：只有手动检查会出网。')
  // 记账写回本环境那一格；其它环境的账原样保留（各记各的）。
  const environments = { ...cache.environments }
  if (lastCheckAt !== null || lastAttemptAt !== null) {
    environments[environment] = { lastCheckAt, lastAttemptAt }
  }
  writeTagsCache({ environments, packages })
  return {
    environment: options.environment,
    units,
    checked,
    lastCheckAt: lastCheckAt === null ? null : new Date(lastCheckAt).toISOString(),
    notes,
  }
}


// ── 官方通道（唯一的写路径）───────────────────────────────────────────────

/** profileContext 里本模块需要的字段。 */
interface ProfileContextLike {
  readonly installAnchor?: string
  readonly home?: string
}

/** 升级引擎的共享依赖（全部可注入，测试不碰真 pnpm / 真 registry）。 */
export interface UpgradeEngineDeps {
  readonly ctx?: Context
  readonly installAnchor?: string
  /** 官方运行器覆盖（测试注入）。 */
  readonly runCommand?: PluginCommandRunner
  /** 试装执行器覆盖（测试注入金丝雀结论）。 */
  readonly trial?: UpgradeTrialRunner
  /**
   * 无头验证覆盖（测试注入"永远挂载成功/失败"）。
   *
   * 为什么这条缝必须存在：金丝雀走**真试装引擎**时，它默认会真起一个 dsh 子进程
   * （15s 超时、约 161 MiB）。单测要验的是"层栈激活"这条逻辑，不是启动器本身，
   * 所以这里透传引擎既有的注入缝（envManager 的 TrialInstallOptions.verify）。
   */
  readonly verify?: (name: string) => Promise<BootVerification>
  readonly fetch?: Fetcher
  readonly now?: () => number
  /** 清理日志回调（测试注入；生产写 <DSH_HOME>/dpmc-trial-cleanup.log）。 */
  readonly log?: (line: string) => void
}

/**
 * 组装官方 operations 的调用参数。
 *
 * 只认官方 installAnchor（ctx.profileContext.installAnchor 或调用方显式覆盖）；拿不到就抛确定性错误——
 * 猜一个路径去写别人的环境是数据损坏级别的错误，宁可拒绝。
 *
 * 注：与 envManager 里的同名函数是**同一份逻辑的两处实现**（那份没有导出，而本任务不改 envManager）。
 * 后续若把它导出来，这里应当改成 import —— 行为必须保持一致（同样拒绝、同样口径）。
 */
function officialContext(profile: string, dir: string, deps: UpgradeEngineDeps): PackageOperationContext {
  const context = deps.ctx?.get('profileContext') as ProfileContextLike | undefined
  const installAnchor = deps.installAnchor ?? context?.installAnchor
  if (installAnchor === undefined || installAnchor.length === 0) {
    throw new EnvironmentError('no-profile-context', '拿不到官方 installAnchor（ctx.profileContext.installAnchor）：'
      + '当前进程不是由 dsh 以 profile 方式启动的，升级无法定位安装锚点。')
  }
  return { profile, dir, installAnchor, cwd: dir, home: context?.home ?? dshHome() }
}

/** 取官方 operations 模块（不可用时抛确定性错误，不静默降级）。 */
async function officialRunner(deps: UpgradeEngineDeps): Promise<PluginCommandRunner> {
  if (deps.runCommand !== undefined) return deps.runCommand
  try {
    const module = await import('@deepseek-ai/dsh-plugin-manager/operations')
    return module.runPluginCommand as PluginCommandRunner
  } catch (error) {
    throw new EnvironmentError('official-unavailable',
      '官方 @deepseek-ai/dsh-plugin-manager/operations 不可用：' + messageOf(error))
  }
}

/**
 * 走官方通道 `add <spec>`（升级与回滚都是它）。
 *
 * @param environment - 目标环境名。
 * @param spec - 官方 spec（`name@version`、`link:...`、绝对路径…）。
 * @param deps - 共享依赖。
 * @returns 官方结果。
 */
export async function runOfficialAdd(environment: string, spec: string, deps: UpgradeEngineDeps = {}): Promise<PackageResult> {
  const dir = environmentDir(environment)
  const runner = await officialRunner(deps)
  const options: PackageOperationOptions = {
    execution: 'service',
    outputBytes: OPERATION_OUTPUT_BYTES,
    lockWaitMs: OPERATION_LOCK_WAIT_MS,
  }
  return await runner(officialContext(environment, dir, deps), ['add', spec], options)
}

// ── 盘上事实 ─────────────────────────────────────────────────────────────

/**
 * 一个包在这个环境里的盘上事实（升级前后各取一次，用来核对"真的变了吗"）。
 *
 * @param environment - 环境名。
 * @param name - 包名。
 * @returns 面向用户的多行事实。
 */
export function installFacts(environment: string, name: string): readonly string[] {
  const dir = environmentDir(environment)
  const manifest = readEnvironmentManifest(dir)
  const specs = dependencySpecs(dir)
  const spec = specs[name]
  const lines = [
    spec === undefined
      ? 'package.json：dependencies 里没有 ' + name
      : 'package.json：' + name + ' = ' + spec,
    'package.json：dsh.profile.bundles ' + (manifest.bundles.includes(name) ? '含 ' + name : '不含 ' + name),
  ]
  const entry = join(dir, 'node_modules', name)
  let shape = '不存在'
  try {
    const stat = lstatSync(entry)
    shape = stat.isSymbolicLink() ? '符号链接 -> ' + readlinkSync(entry) : stat.isDirectory() ? '目录' : '文件'
  } catch {
    // 不存在就是不存在：这是正常路径。
  }
  const version = readInstalledVersion(environment, name)
  lines.push('node_modules/' + name + '：' + shape + (version === null ? '（读不到 version）' : '，版本 ' + version))
  return lines
}

// ── 金丝雀（复用试装引擎）────────────────────────────────────────────────

/** 金丝雀清理日志路径（与引擎的测试环境清理共用同一份日志与同一行格式）。 */
export function canaryLogPath(): string {
  return join(dshHome(), 'dpmc-trial-cleanup.log')
}

/** 写一行清理日志（失败不抛：删除本身已经发生，日志不该反过来让升级失败）。 */
function appendCanaryLog(line: string, deps: UpgradeEngineDeps): void {
  deps.log?.(line)
  try {
    appendFileSync(canaryLogPath(), new Date().toISOString() + ' ' + line + '\n', { mode: 0o600 })
  } catch {
    // 见上：日志失败不阻断。
  }
}

/**
 * 从 spec 认出**包名**（金丝雀要先卸掉它，才能让候选成为"新装"）。
 *
 * 三种形态与 envManager 的同名私有函数同口径：路径 spec 读目标目录的 package.json；
 * registry spec 取最后一个 `@` 之前的部分（scoped 名整体保留）。
 *
 * @param spec - 候选 spec。
 * @returns 包名；认不出来时 null（此时不做 remove，如实退回"直接装"）。
 */
function canaryPackageName(spec: string): string | null {
  const bare = spec.replace(/^(?:link:|file:|workspace:)/, '')
  const looksLikePath = spec.startsWith('link:') || spec.startsWith('file:') || spec.startsWith('.') || bare.startsWith('/')
  if (looksLikePath) {
    try {
      const manifest = JSON.parse(readFileSync(join(bare, 'package.json'), 'utf8')) as { name?: unknown }
      return typeof manifest.name === 'string' && manifest.name.length > 0 ? manifest.name : null
    } catch {
      return null
    }
  }
  const at = bare.lastIndexOf('@')
  const name = at > 0 ? bare.slice(0, at) : bare
  return name.length === 0 ? null : name
}

/**
 * 金丝雀的"激活"证据：候选装完之后，测试环境的 `dsh.profile.bundles` 里到底有没有它。
 *
 * 为什么这条证据是金丝雀成立的前提（真机缺陷，task-80）：官方 reconcile **跳过
 * `beforeDeps` 里已有的依赖**，所以一个**已装插件的新版本**（正是升级场景）装进测试环境后
 * 进不了层栈 → 挂载期从不加载它 → 坏候选也会被判 `passed`（假通过）。
 * 因此"装上了"不等于"验证到了"：只有层栈里真的出现它，这次启动验证才算数。
 */
export interface CanaryActivation {
  /** 候选包名。 */
  readonly name: string
  /** 装完候选后测试环境的层栈（读盘事实）。 */
  readonly bundles: readonly string[]
  /** 候选是否真的进了层栈（false = 挂载期不会加载它，这次验证不作数）。 */
  readonly activated: boolean
  /** 是否为了让候选成为"新装"而先执行了官方 remove。 */
  readonly removedFirst: boolean
  /** 那一步的结果说明（成功或失败都如实写）。 */
  readonly removeNote: string
}

/**
 * 跑一次金丝雀：在 `<环境>-dpmc` 里把**新版本**装进快照并跑基线/候选两次启动，然后立刻删掉测试环境。
 *
 * 四条纪律：
 *   1. 复用 task-50/75 的试装引擎（含含 web 层环境读官方就绪行的那套形态），不另造验证器；
 *   2. 候选要先成为"新装"（见 activationFor 的说明），否则升级场景下它永远进不了层栈，
 *      金丝雀就退化成"什么都没验证"；
 *   3. `cannot-trial`（没验证）**不是** `passed`：调用方据此拒绝升级；
 *   4. 测试环境是**一次性资产**：用完即删（不留 14 天），删不掉也如实说，并写清理日志。
 *
 * @param environment - 真实环境名。
 * @param spec - 候选 spec（`name@version`）。
 * @param config - 本插件配置（试装段决定深度/基线/联网）。
 * @param deps - 共享依赖（试装执行器可注入）。
 * @returns 金丝雀报告。
 */
export async function runUpgradeCanary(
  environment: string, spec: string, config: CompanionConfig, deps: UpgradeEngineDeps = {},
): Promise<UpgradeCanaryReport> {
  const trial = effectiveTrialConfig(config)
  if (!trial.enabled) {
    return { ran: false, skippedReason: '试装总开关已关闭：未做金丝雀，直接升级（没有验证新版本能否挂载）', cleanup: '没有创建测试环境' }
  }
  const runner = deps.trial ?? runTrialInstall
  const target = trialEnvironmentName(environment)
  // 激活包装（见 activationFor）：把候选变成"新装"，并留下层栈事实。
  const activation = activationFor(environment, spec, deps)
  let result: TrialInstallResult
  try {
    result = await runner(spec, environment, {
      ...deps.ctx === undefined ? {} : { ctx: deps.ctx },
      ...deps.installAnchor === undefined ? {} : { installAnchor: deps.installAnchor },
      runCommand: activation.run,
      ...deps.verify === undefined ? {} : { verify: deps.verify },
      ...deps.now === undefined ? {} : { now: deps.now },
      depth: trial.depth,
      baseline: trial.baseline,
      allowNetwork: trial.allowNetwork,
    })
  } catch (error) {
    // 引擎抛异常 = 这次没能验证（不是通过）；测试环境仍要清掉。
    const cleanup = await removeCanaryEnvironment(environment, deps)
    const thrownEvidence = activation.read()
    return {
      ran: true, conclusion: 'cannot-trial', cleanup,
      output: '金丝雀执行时出错：' + messageOf(error),
      ...thrownEvidence === null ? {} : { activation: thrownEvidence },
    }
  }
  const cleanup = await removeCanaryEnvironment(environment, deps)
  const evidence = activation.read()
  // 自己核验一次激活证据：**不信任**上游给的 passed。
  // 上游（试装引擎）确实有同一条守卫，但金丝雀的结论可以来自注入的替身——那时引擎的守卫
  // 根本没跑。这里拿的是自己读的层栈事实，所以"候选没进层栈就绝不算通过"在这一层也成立。
  const unactivated = evidence !== null && !evidence.activated
  return {
    ran: true,
    conclusion: unactivated ? 'cannot-trial' : result.conclusion,
    depth: result.depth,
    escalated: result.escalated,
    elapsedMs: result.elapsedMs,
    output: unactivated
      ? '金丝雀没能验证（不等于通过）：候选 ' + evidence.name + ' 装完之后没有进入组合层栈'
        + '（dsh.profile.bundles = ' + JSON.stringify(evidence.bundles) + '）——挂载期不会加载它，'
        + '这次启动验证没有验证到新版本。\n' + evidence.removeNote + '\n' + result.output
      : result.output,
    cleanup,
    ...evidence === null ? {} : { activation: evidence },
  }
}

/**
 * 观察试装环境里的官方通道调用，留下**层栈激活证据**。
 *
 * 职责分工（task-84 之后）：
 *   · **让候选成为"新装"由试装引擎自己负责**（envManager 的 detachCandidate，走同一条官方
 *     remove 通道）。金丝雀因此不再自己卸包——两处各卸一次是重复机制，而重复的机制迟早会分叉。
 *   · 这里只**观察**：装完之后测试环境的 `dsh.profile.bundles` 里到底有没有候选。
 *     为什么还需要它：试装执行器是**可注入**的，注入替身时引擎那条守卫根本没跑，
 *     所以金丝雀要能自己读一次盘，才谈得上"不信任上游给的 passed"。
 *
 * 官方通道取不到时**不在这里抛**：把失败推迟到真正调用那一刻，让它走试装引擎原有的
 * `cannot-trial` 路径——"没验证"要如实报成没验证。
 *
 * @param environment - 真实环境名。
 * @param spec - 候选 spec。
 * @param deps - 共享依赖。
 * @returns 透传的运行器与证据句柄。
 */
function activationFor(
  environment: string, spec: string, deps: UpgradeEngineDeps,
): { readonly run: PluginCommandRunner; readonly read: () => CanaryActivation | null } {
  const target = trialEnvironmentName(environment)
  let inner: PluginCommandRunner | null = null
  let pending: Promise<PluginCommandRunner> | null = null
  const resolveInner = async (): Promise<PluginCommandRunner> => {
    if (inner !== null) return inner
    pending = pending ?? officialRunner(deps)
    inner = await pending
    return inner
  }
  const name = canaryPackageName(spec)
  let captured: CanaryActivation | null = null
  let removedFirst = false
  let removeNote = '候选不在测试环境的依赖里，装它本来就是"新装"'
  const run: PluginCommandRunner = async (context, args, options) => {
    const runner = await resolveInner()
    // remove 是引擎在摘候选（task-84）：记下来，供报告里如实说"确实先卸了"。
    if (args[0] === 'remove') {
      const removal = await runner(context, args, options)
      removedFirst = removal.exitCode === 0
      removeNote = removal.exitCode === 0
        ? '已先走官方通道卸掉 ' + String(args[1]) + '，使候选成为"新装"'
          + '（否则官方 reconcile 会跳过"既有依赖"，候选进不了层栈）'
        : '官方卸包失败（退出码 ' + String(removal.exitCode) + '），候选可能仍被当作"既有依赖"：'
          + removal.output.trim().slice(-200)
      return removal
    }
    const result = await runner(context, args, options)
    if (args[0] === 'add' && name !== null) {
      // 装完立刻读盘：层栈里有没有它，是这次验证成不成立的唯一判据。
      const dir = context.dir ?? environmentDir(target)
      const bundles = readEnvironmentManifest(dir).bundles
      captured = { name, bundles: [...bundles], activated: bundles.includes(name), removedFirst, removeNote }
    }
    return result
  }
  return { run, read: () => captured }
}

/**
 * 删掉金丝雀用的测试环境（<环境>-dpmc），并写清理日志。
 *
 * @param environment - 真实环境名。
 * @param deps - 共享依赖。
 * @returns 面向用户的清理结局。
 */
async function removeCanaryEnvironment(environment: string, deps: UpgradeEngineDeps): Promise<string> {
  const target = trialEnvironmentName(environment)
  const result = await removeTrialEnvironment(target, deps.ctx === undefined ? {} : { ctx: deps.ctx })
  if (result.ok) {
    appendCanaryLog('removed ' + target + '：升级金丝雀用完即删（一次性资产）', deps)
    return '测试环境已删除：' + target
  }
  appendCanaryLog('kept ' + target + '：删除被拒（' + String(result.code) + '）', deps)
  return '测试环境没删掉（' + String(result.code) + '）：' + result.output
}

// ── 升级与回滚 ───────────────────────────────────────────────────────────

/** 一次升级的入参。 */
export interface UpgradeActionInput extends UpgradeEngineDeps {
  readonly environment: string
  readonly name: string
  /** 目标版本（来自检查结果的 targetVersion 或用户挑的 tag）。 */
  readonly version: string
  readonly config: CompanionConfig
  /** 当前来源（用于判断"升级会改变来源"）。 */
  readonly spec?: string
  /** 显式跳过金丝雀（默认由试装总开关决定）。 */
  readonly canary?: boolean
}

/**
 * 升级一个已装包：金丝雀通过（或未做金丝雀）→ 官方 add → 盘上核对。
 *
 * 顺序不可颠倒：先验证再动真环境。金丝雀没通过（含 `cannot-trial`）就**不升级**，
 * 并把试装结论原文作为原因返回——"没验证"绝不当成"通过"。
 *
 * @param input - 目标与依赖。
 * @returns 结果（含 before/after 的盘上事实）。
 */
export async function upgradePackage(input: UpgradeActionInput): Promise<UpgradeActionResult> {
  const { environment, name, version } = input
  if (!isSafeEnvironmentName(environment)) {
    return failResult(input, 'invalid-name', '环境名不合法：' + JSON.stringify(environment))
  }
  if (name.length === 0 || version.length === 0) {
    return failResult(input, 'invalid-name', '包名与版本都必须是非空字符串')
  }
  const before = installFacts(environment, name)
  const fromVersion = readInstalledVersion(environment, name)
  const spec = name + '@' + version
  // 金丝雀的两种"没跑"必须分开说（它们是不同的诚实点）：
  //   · 调用方显式跳过 → 那是调用方的决定；
  //   · 试装总开关关着 → 那是"未验证就升级"，文案必须把这件事说出来。
  // 后者交给 runUpgradeCanary 自己回答（它持有那条口径，不在这里抄一份会漂移的措辞）。
  const canary = input.canary === false
    ? { ran: false, skippedReason: '调用方显式跳过了金丝雀', cleanup: '没有创建测试环境' } satisfies UpgradeCanaryReport
    : await runUpgradeCanary(environment, spec, input.config, input)

  if (canary.ran && canary.conclusion !== 'passed') {
    const headline = canary.conclusion === 'candidate-broken'
      ? '金丝雀没通过：新版本装进快照环境后挂不起来 —— 没有在真实环境执行升级'
      : canary.conclusion === 'baseline-broken'
        ? '金丝雀没做出判断：快照基线本身就起不来（这不是新版本的问题）—— 没有在真实环境执行升级'
        : '金丝雀没能验证（不等于通过）—— 没有在真实环境执行升级'
    return {
      ok: false,
      code: 'canary-not-passed',
      output: headline + '\n' + [
        '目标：' + spec,
        canary.cleanup,
        canary.output === undefined ? '' : '金丝雀结论：\n' + canary.output,
      ].filter((line) => line.length > 0).join('\n'),
      name,
      fromVersion,
      toVersion: version,
      spec,
      canary,
      diskFacts: before,
      restartRequired: false,
    }
  }

  let result: PackageResult
  try {
    result = await runOfficialAdd(environment, spec, input)
  } catch (error) {
    return {
      ok: false,
      code: error instanceof EnvironmentError ? error.code : 'io-failed',
      output: '升级失败：' + messageOf(error) + '\n' + canary.cleanup,
      name, fromVersion, toVersion: version, spec, canary, diskFacts: before, restartRequired: false,
    }
  }
  const after = installFacts(environment, name)
  const landed = readInstalledVersion(environment, name)
  const tail = result.output.trim().split(/\r?\n/).filter((line) => line.length > 0).slice(-6)
  const isSelf = name === OUR_PACKAGE_NAME
  const ok = result.exitCode === 0 && landed === version
  const lines = [
    ok
      ? '已升级 ' + name + '：' + String(fromVersion ?? '（未知）') + ' → ' + version
      : '升级命令退出码 ' + String(result.exitCode) + '，盘上版本是 ' + String(landed ?? '读不到') + '（期望 ' + version + '）',
    '本次 spec：' + spec,
    '金丝雀：' + (canary.ran
      ? '通过（深度 ' + String(canary.depth ?? '—') + '，耗时 ' + String(canary.elapsedMs ?? 0) + 'ms）'
      : '未做（' + String(canary.skippedReason ?? '原因未知') + '）'),
    canary.cleanup,
    isSelf ? '本插件自身：正在运行的是旧代码，新版本**下次启动**后生效（官方口径）' : '生效时机：下次启动后加载（官方口径）',
    '',
    '升级前：',
    ...before.map((line) => '  ' + line),
    '升级后：',
    ...after.map((line) => '  ' + line),
  ]
  if (tail.length > 0) lines.push('', '官方输出：', ...tail.map((line) => '  ' + line))
  // 升级成功后该包的版本事实就旧了：让它下次检查重新取（不靠"猜"来更新界面）。
  invalidateTagsCache(name)
  return {
    ok,
    ...ok ? {} : { code: 'package-operation-failed' as const },
    output: lines.join('\n').replace(/\*\*/g, ''),
    name, fromVersion, toVersion: version, spec, canary, diskFacts: after, restartRequired: true,
  }
}

/**
 * 回滚一个包到指定版本（或回滚到原来的本地来源）。
 *
 * 核对按**盘上事实**：依赖行与 node_modules 里的版本都要对上才算干净；对不上就说对不上
 * （沿用 task-23 的教训：不许声称"环境未被改动"而留下残留）。
 *
 * @param input - 目标与依赖。
 * @returns 结果。
 */
export async function rollbackUpgrade(input: UpgradeActionInput): Promise<UpgradeRollbackResult> {
  const { environment, name, version } = input
  if (!isSafeEnvironmentName(environment)) {
    return { ok: false, code: 'invalid-name', output: '环境名不合法：' + JSON.stringify(environment), name, fromVersion: null, toVersion: version, diskFacts: [], clean: false }
  }
  const fromVersion = readInstalledVersion(environment, name)
  const localSpec = isLocalSpec(input.spec) ? input.spec : undefined
  // 原来就是本地来源（link:/file:/路径）时，回滚的正解是把**那个来源**装回来，而不是装一个 registry 版本。
  const spec = localSpec ?? name + '@' + version
  const before = installFacts(environment, name)
  let result: PackageResult
  try {
    result = await runOfficialAdd(environment, spec, input)
  } catch (error) {
    return {
      ok: false,
      code: error instanceof EnvironmentError ? error.code : 'io-failed',
      output: '回滚失败：' + messageOf(error),
      name, fromVersion, toVersion: version, diskFacts: before, clean: false,
    }
  }
  const after = installFacts(environment, name)
  const landed = readInstalledVersion(environment, name)
  const clean = result.exitCode === 0 && landed === version
  const lines = [
    clean
      ? '已回滚 ' + name + '：' + String(fromVersion ?? '（未知）') + ' → ' + version
      : '回滚没能到位：官方退出码 ' + String(result.exitCode) + '，盘上版本是 ' + String(landed ?? '读不到')
        + '（期望 ' + version + '）',
    '本次 spec：' + spec,
    '生效时机：下次启动后加载（官方口径）',
    '',
    '回滚前：',
    ...before.map((line) => '  ' + line),
    '回滚后：',
    ...after.map((line) => '  ' + line),
  ]
  if (!clean) lines.push('', '上面这份盘上事实就是现状：残留需要按它处理，界面不该说"环境未被改动"。')
  invalidateTagsCache(name)
  return {
    ok: clean,
    ...clean ? {} : { code: 'rollback-incomplete' as const },
    output: lines.join('\n'),
    name, fromVersion, toVersion: version, diskFacts: after, clean,
  }
}

/**
 * 让某个包的版本事实失效（升级/回滚后必须重新取，不许拿旧事实当新状态）。
 *
 * 只删这一个包的条目，**不动**环境记账：记账说的是"这个环境什么时候查过"，
 * 那件事并没有因为一次升级而改变（升级成功只让**这个包**的版本事实过期）。
 *
 * @param name - 包名。
 */
export function invalidateTagsCache(name: string): void {
  const cache = readTagsCache()
  if (cache.packages[name] === undefined) return
  const packages = { ...cache.packages }
  delete packages[name]
  writeTagsCache({ environments: cache.environments, packages })
}

/** 一次失败结果的统一形状（把 fromVersion 与盘上事实一并带上）。 */
function failResult(input: UpgradeActionInput, code: string, output: string): UpgradeActionResult {
  return {
    ok: false,
    code,
    output,
    name: input.name,
    fromVersion: null,
    toVersion: input.version,
    spec: input.name + '@' + input.version,
    canary: { ran: false, skippedReason: '输入不合法，没有跑金丝雀', cleanup: '没有创建测试环境' },
    diskFacts: [],
    restartRequired: false,
  }
}

/** 错误消息（本地小工具）。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

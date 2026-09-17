/**
 * marketplace.ts — 索引 × 已安装状态 → MarketItem[]（服务端合并、已安装判定、分类计数、内容身份缓存）。
 *
 * 归属：A 类·重写（旧 src/marketplaceMerge.ts 仅作意图参考，未复制代码）。
 * 官方复用：paths.ts 的 dshHome/environmentDir/readEnvironmentManifest（本模块不自造路径与 manifest 解析）。
 * 旧实现参考：dsh-web-plugin-manager/src/marketplaceMerge.ts（理解意图用，未复制代码）——它解决的问题是：
 *   索引只描述"世界上有哪些插件"，而页面要回答"这台机器上装了什么、能不能更新"，
 *   于是需要一处把两侧合并、判定已安装（包名 / repository / git 源 / 目录探测四条通道），
 *   并给出分类计数供筛选器渲染。
 * 前提检查：旧实现的前提仍然成立，但它踩过的两个坑必须避开（docs/private/audit/correctness.md）：
 *   1) M-1：最终管线的缓存键**不含条目内容身份**，只用了时间戳。于是"同一时间戳 + 完全不同的条目"
 *      会命中旧缓存，新抓到的结果被静默丢弃。本实现的内容身份由 **条目的内容哈希** +
 *      调用方给的单调代际共同构成（见 itemsIdentity / marketplaceCacheKey），时间戳不再当身份用。
 *   2) m-3：把"缓存项写入时刻"当内容代际，导致内容没变也会重跑整条管线。本实现的身份来自
 *      索引内容（hash）与**已安装索引的内容身份**（InstalledIndex.identity）：TTL 到期重建但内容
 *      不变时，身份不变、管线不重跑。
 *   与旧实现的差异（由新契约决定）：不做 catalog/dsh.so 覆盖层与同包去重（"不要扩数据源"），
 *   不读 kinds.ts 的安装记录（那是另一个模块的资产，且本模块必须能在没有它时独立工作）。
 *
 * 接线方式（host 侧一行即可）：
 *   const index = await loadRegistryIndex({ refresh })
 *   const result = cachedMarketplace({
 *     profile, items: index.repos.map(registryItem), generation: index.generation,
 *     installed: buildInstalledIndex(profile), generatedAt: index.generatedAt, cached: index.cached,
 *   })
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome, environmentDir, readEnvironmentManifest } from './paths.ts'
import { hashIdentity, type RegistryRepo } from './registry.ts'
import { categoryCounts } from './tags.ts'
import type { MarketItem, MarketplaceResult } from './types.ts'

/** 已安装索引的进程内缓存有效期（毫秒）。 */
export const INSTALLED_INDEX_TTL_MS = 5_000

/** 技能与预设的落地根目录（与 kinds.ts 的安装目标一致）。 */
export const SKILLS_DIR = 'skills'
export const PRESETS_DIR = '.agent-presets'

/**
 * 市场候选条目：wire 契约（types.ts 的 MarketItem）+ **仅服务端可见**的 npm 包名。
 *
 * 为什么需要这个扩展：判定"已安装"要用 npm 包名去比对 profile 的依赖，而包名常常与
 * 仓库名不同（`@scope/tool` vs `alice/dsh-tool`）。wire 契约已定稿、没有这个字段，
 * 所以它在服务端内部流转，`finalizeMarketplace` 投影回 wire 形状时被剥掉
 * （见 toWireItem）——不往契约里塞未声明的字段。
 */
export interface MarketplaceCandidate extends MarketItem {
  /** 索引里 CI 采集到的 npm 包名（registry.json 的 pkg_name）。 */
  readonly packageName?: string
}

/**
 * 索引条目 → 市场候选条目（纯函数）。
 *
 * @param repo - 归一化后的索引条目。
 * @returns 候选条目；`kind` 默认 `plugin`——这个索引本身就是 topic:dsh-plugin 的全量表，
 *   上游若显式给了 kind 则透传。
 */
export function registryItem(repo: RegistryRepo): MarketplaceCandidate {
  return {
    repo: repo.repo,
    name: repo.name,
    description: repo.description,
    stars: repo.stars,
    updatedAt: repo.updatedAt,
    topics: repo.topics,
    ...(repo.category === undefined ? {} : { category: repo.category }),
    ...(repo.packageName === undefined ? {} : { packageName: repo.packageName }),
    ...(repo.latestVersion === undefined ? {} : { latestVersion: repo.latestVersion }),
    kind: repo.kind ?? 'cordis-plugin',
  }
}

/** 批量映射（唯一的"索引 → 条目"入口，避免各处自己拼对象）。 */
export function registryItems(repos: readonly RegistryRepo[]): MarketplaceCandidate[] {
  return repos.map(registryItem)
}

/**
 * 把候选条目投影回**严格的 wire 形状**。
 *
 * 单一出口的好处：多余字段（packageName）不会漏到 wire 上，缺失字段不会变成 undefined 键，
 * 上游 JSON 的形状漂移在这一处被收敛。
 */
export function toWireItem(item: MarketplaceCandidate): MarketItem {
  return {
    repo: item.repo,
    name: item.name,
    description: item.description,
    stars: item.stars,
    updatedAt: item.updatedAt,
    topics: item.topics,
    ...(item.category === undefined ? {} : { category: item.category }),
    ...(item.installed === undefined ? {} : { installed: item.installed }),
    ...(item.installedVersion === undefined ? {} : { installedVersion: item.installedVersion }),
    ...(item.latestVersion === undefined ? {} : { latestVersion: item.latestVersion }),
    ...(item.kind === undefined ? {} : { kind: item.kind }),
  }
}

/**
 * 解析 package.json 的 repository 字段为 `owner/repo`（小写）。
 *
 * 支持 npm 生态里的全部常见写法：`owner/repo` 简写、`github:owner/repo`、
 * `git+https://github.com/owner/repo.git`、`git://…`、`git@github.com:owner/repo.git`、
 * 以及裸 URL。**非 GitHub 主机一律返回 null**：市场索引里的 `repo` 都是 GitHub 全名，
 * 拿一个 GitLab 仓库去匹配只会制造假的"已安装"。
 *
 * @param value - repository 字段（字符串或对象里的 url 都可，调用方负责取字符串）。
 * @returns 小写 `owner/repo`；无法判定时 null。
 */
export function normalizeRepoRef(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let text = value.trim()
  if (text.length === 0) return null
  text = text.replace(/^github:/i, '')
  const scpLike = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(text)
  if (scpLike !== null) {
    if (!isGitHubHost(scpLike[1]!)) return null
    text = scpLike[2]!
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let url: URL
    try {
      url = new URL(text.replace(/^git\+/i, ''))
    } catch {
      return null
    }
    if (!isGitHubHost(url.hostname)) return null
    text = url.pathname
  }
  text = text.replace(/^\/+/, '').replace(/\/+$/, '')
  if (text.toLowerCase().endsWith('.git')) text = text.slice(0, -4)
  const parts = text.split('/').filter((part) => part.length > 0)
  if (parts.length !== 2) return null
  return (parts[0] + '/' + parts[1]).toLowerCase()
}

/** 是否 GitHub 主机（www. 前缀也算）。 */
function isGitHubHost(host: string): boolean {
  const value = host.trim().toLowerCase()
  return value === 'github.com' || value === 'www.github.com'
}

/**
 * git 源的身份：`github.com-owner-repo`。
 *
 * 两侧都用**同一个函数**生成身份，所以仓库名里带连字符也不会歧义（不拆 owner/repo，
 * 只做"整段小写 + 去掉路径分隔"的规范化）。除了依赖声明里的 git spec，也认旧 git-cache
 * 目录名形态（`…/github.com-owner-repo`），因为官方安装通道会把 git 源链接到这个目录。
 *
 * @param source - 依赖声明里的 source 值（如 `github:owner/repo`、`link:…`）。
 * @returns 身份串；不是 github 源时 null。
 */
export function gitSourceIdentity(source: unknown): string | null {
  if (typeof source !== 'string') return null
  const text = source.trim()
  if (text.length === 0) return null
  const ref = normalizeRepoRef(text)
  if (ref !== null) return 'github.com-' + ref.replace('/', '-')
  const match = /github\.com-([^/\\]+?)\/?$/.exec(text)
  return match === null ? null : 'github.com-' + match[1]!.toLowerCase()
}

/**
 * 目录名 slug（技能/预设的落地目录名）。
 *
 * 规则刻意简单（小写 + 非字母数字折叠成 `-`）：它必须与写入侧的落地目录名一致，
 * 因此不含任何 locale 相关处理。**注意**：本函数只用于"探测已安装"，探测不到只丢一个
 * 提示（假阴性），绝不误报（假阳性会让用户以为装过了）。
 */
export function directorySlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** 一个 profile 的已安装事实（构建一次，复用多次判定）。 */
export interface InstalledIndex {
  /** 小写 npm 包名 → 已安装版本（版本未知时为空串）。 */
  readonly packages: ReadonlyMap<string, string>
  /** 小写 `owner/repo`（来自各已装包的 repository 字段）→ 版本。 */
  readonly repos: ReadonlyMap<string, string>
  /** git 源身份 → 版本。 */
  readonly gitSources: ReadonlyMap<string, string>
  /** `<dshHome>/skills` 下的目录名（小写）。 */
  readonly skills: ReadonlySet<string>
  /** `<dshHome>/.agent-presets` 下的目录名（小写）。 */
  readonly presets: ReadonlySet<string>
  /**
   * 内容身份：由上面五个成员的内容决定。
   * TTL 到期重建但内容没变时**保持不变**，因此不会让下游管线缓存无谓失效（旧审计 m-3）。
   */
  readonly identity: string
}

/**
 * 条目集合的**内容身份**（缓存键的一半）。
 *
 * 长度进键是刻意的：哈希只是内容的指纹，长度把"哈希恰好相撞且长度不同"这种可能彻底排除。
 *
 * @param items - 候选条目。
 * @returns `<count>-<hash>`。
 */
export function itemsIdentity(items: readonly MarketplaceCandidate[]): string {
  return String(items.length) + '-' + hashIdentity(items.map((item) => item.repo))
}

/** 一个已安装包的事实。 */
interface InstalledPackageFacts {
  readonly version: string
  readonly repository: string | null
}

/**
 * 读一个已安装包的 package.json（不存在/损坏时 null）。
 *
 * 只有**真的存在**才算已安装：manifest 里声明了但 node_modules 里没有的包（装到一半、
 * 手工删过）不该被市场页标成"已安装"——那正是诊断层要报的问题，不能在这里被掩盖。
 */
function readInstalledPackageFacts(profileDir: string, name: string): InstalledPackageFacts | null {
  const path = join(profileDir, 'node_modules', name, 'package.json')
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const version = typeof raw['version'] === 'string' ? raw['version'].trim() : ''
    const repositoryRaw = raw['repository']
    let repository: string | null = null
    if (typeof repositoryRaw === 'string') repository = repositoryRaw
    else if (repositoryRaw !== null && typeof repositoryRaw === 'object') {
      const url = (repositoryRaw as Record<string, unknown>)['url']
      if (typeof url === 'string') repository = url
    }
    return { version, repository }
  } catch {
    return null
  }
}

/** 一个目录下的子目录名（小写）；目录不存在时返回空集合。 */
function readSubdirectoryNames(dir: string): Set<string> {
  try {
    const names = new Set<string>()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) names.add(entry.name.toLowerCase())
    }
    return names
  } catch {
    return new Set()
  }
}

/** profile 名 → 缓存条目（含未找到 profile 的 null，避免每次请求都去探一次磁盘）。 */
const installedIndexCache = new Map<string, { readonly at: number; readonly index: InstalledIndex | null }>()

/**
 * 构建（或复用）一个 profile 的已安装索引。
 *
 * 未知/非法 profile 名返回 null：调用方据此把全部条目判为"未安装"，而不是抛错。
 * 非法名先经 paths.ts 的 environmentDir 校验（路径穿越防线不在这里重造）。
 *
 * @param profile - profile 名。
 * @param options - ttlMs（默认 {@link INSTALLED_INDEX_TTL_MS}）与 now（注入时钟，测试用）。
 * @returns 已安装索引，或 null（profile 不可用）。
 */
export function buildInstalledIndex(profile: string, options: { readonly ttlMs?: number; readonly now?: number } = {}): InstalledIndex | null {
  const now = options.now ?? Date.now()
  const ttlMs = options.ttlMs ?? INSTALLED_INDEX_TTL_MS
  const cached = installedIndexCache.get(profile)
  if (cached !== undefined && now - cached.at < ttlMs) return cached.index
  const index = buildInstalledIndexUncached(profile)
  installedIndexCache.set(profile, { at: now, index })
  return index
}

/** 丢弃一个 profile（或全部）的已安装索引缓存。装/卸/更新后必须调用，不能等 TTL。 */
export function invalidateInstalledIndex(profile?: string): void {
  if (profile === undefined) installedIndexCache.clear()
  else installedIndexCache.delete(profile)
}

/** 清空已安装索引缓存（测试用，等价于 invalidateInstalledIndex()）。 */
export function clearInstalledIndexCache(): void {
  installedIndexCache.clear()
}

/** 无缓存的构建。 */
function buildInstalledIndexUncached(profile: string): InstalledIndex | null {
  let dir: string
  try {
    dir = environmentDir(profile)
  } catch {
    return null
  }
  if (!existsSync(dir)) return null
  const manifest = readEnvironmentManifest(dir)
  const dependencies = manifest.raw['dependencies']
  const specs = dependencies !== null && typeof dependencies === 'object'
    ? dependencies as Record<string, unknown>
    : {}
  const packages = new Map<string, string>()
  const repos = new Map<string, string>()
  const gitSources = new Map<string, string>()
  for (const name of Object.keys(specs)) {
    const facts = readInstalledPackageFacts(dir, name)
    if (facts === null) continue
    const key = name.toLowerCase()
    packages.set(key, facts.version)
    if (facts.repository !== null) {
      const ref = normalizeRepoRef(facts.repository)
      if (ref !== null) repos.set(ref, facts.version)
    }
    const identity = gitSourceIdentity(specs[name])
    if (identity !== null) gitSources.set(identity, facts.version)
  }
  const skills = readSubdirectoryNames(join(dshHome(), SKILLS_DIR))
  const presets = readSubdirectoryNames(join(dshHome(), PRESETS_DIR))
  const identity = hashIdentity([
    [...packages.keys()].sort().join(','),
    [...repos.keys()].sort().join(','),
    [...gitSources.keys()].sort().join(','),
    [...skills].sort().join(','),
    [...presets].sort().join(','),
  ])
  return { packages, repos, gitSources, skills, presets, identity }
}

/** 已安装判定的附加输入。 */
export interface InstallDetectionOptions {
  /**
   * 目录探测要跳过的 slug：同一个 slug 在本次 listing 里对应多个条目时无法安全归属，
   * 宁可少标一个"已安装"也不给错的人贴标签。
   */
  readonly ambiguousSlugs?: ReadonlySet<string>
}

/**
 * 判定一个条目是否已安装，并补齐已安装版本 / 形态（纯函数：只读索引，不碰磁盘）。
 *
 * 四条通道（任一命中即已安装）：
 * 1. **repository 身份**：条目 `repo`（owner/repo）命中任一已装包的 repository 字段；
 * 2. **包名**：条目的 npm 包名（索引 pkg_name）或仓库名命中已装包名——包名与仓库名不一致时
 *    这两条通道互补，覆盖对方看不见的情况；
 * 3. **git 源**：依赖声明是 `github:…` / `git+https://github.com/…` / link 到 git-cache 目录；
 * 4. **目录探测**：`<dshHome>/skills` 或 `<dshHome>/.agent-presets` 下存在对应 slug，
 *    命中时形态改写为 skill / agent-preset（这正是"装成什么"的答案）。
 *
 * 目录探测的**已知假阴性**（与 kinds.ts 核对过落地名规则后确认）：skill 的落地目录名优先取
 * SKILL.md frontmatter 里的 `name`，只有缺失时才回落到仓库名末段的 slug。frontmatter 名与仓库名
 * 不同时（如仓库 who/skill-pack、SKILL.md 里 name: memory-keeper），这里探不到——市场索引不携带
 * SKILL.md 内容，凭空猜一个名字只会制造假阳性。要彻底修好需要把 kinds.ts 的安装记录作为第五条
 * 通道传进来（loadKindRecords() 的 repo → kind/version），那需要同时把记录的内容身份纳入管线缓存键；
 * 本模块先不做，等宿主侧确实需要时再加（假阴性只影响一个徽标，假阳性会误导用户）。
 *
 * @param item - 候选条目。
 * @param index - 已安装索引；null（未知 profile）时一律判为未安装。
 * @param options - 歧义 slug 集。
 * @returns 新的条目对象（不修改入参）。
 */
export function flagInstalled(
  item: MarketplaceCandidate,
  index: InstalledIndex | null,
  options: InstallDetectionOptions = {},
): MarketplaceCandidate {
  if (index === null) return { ...item, installed: false }
  let installed = false
  let version: string | undefined
  let kind = item.kind
  const hit = (found: boolean, hitVersion?: string): void => {
    if (!found) return
    installed = true
    if (version === undefined && hitVersion !== undefined && hitVersion.length > 0) version = hitVersion
  }
  hit(index.repos.has(item.repo.toLowerCase()), index.repos.get(item.repo.toLowerCase()))
  const packageCandidates = [item.packageName?.toLowerCase(), item.name.toLowerCase()]
  for (const candidate of packageCandidates) {
    if (candidate === undefined || candidate.length === 0) continue
    hit(index.packages.has(candidate), index.packages.get(candidate))
  }
  const gitIdentity = gitSourceIdentity('https://github.com/' + item.repo)
  if (gitIdentity !== null) hit(index.gitSources.has(gitIdentity), index.gitSources.get(gitIdentity))
  const slug = directorySlug(item.name)
  if (slug.length > 0 && options.ambiguousSlugs?.has(slug) !== true) {
    if (index.skills.has(slug)) {
      installed = true
      kind = 'skill'
    } else if (index.presets.has(slug)) {
      installed = true
      kind = 'agent-preset'
    }
  }
  return {
    ...item,
    installed,
    ...(version === undefined ? {} : { installedVersion: version }),
    ...(kind === undefined ? {} : { kind }),
  }
}

/** 最终管线的入参。 */
export interface MarketplaceInput {
  /** 环境名；只用于选择管线缓存的槽位（索引内容与 profile 无关）。 */
  readonly profile: string
  readonly items: readonly MarketplaceCandidate[]
  /**
   * 调用方给的内容代际（如 registry.ts 的 `RegistryIndex.generation`）。
   * 它单调递增，因此"内容变了但哈希恰好相同"这种事也不会发生。
   */
  readonly generation: number
  readonly installed: InstalledIndex | null
  /** 索引生成时间（ISO）；未知时 null（wire 上是空串）。 */
  readonly generatedAt: string | null
  /** 本次数据是否来自缓存。 */
  readonly cached: boolean
}

/**
 * 管线缓存键：profile | 代际 | **条目内容身份** | 已安装索引身份 | 索引生成时间 | 缓存标记。
 *
 * 内容身份是这一处的核心（旧审计 M-1：键里只有时间戳，于是"同一时间戳 + 不同条目"命中旧结果，
 * 新数据被静默丢弃）。这里同时带上代际与内容哈希：代际负责"同内容不重算"，哈希负责
 * "不同内容一定重算"，两者互补。
 */
export function marketplaceCacheKey(input: MarketplaceInput): string {
  return [
    input.profile,
    String(input.generation),
    itemsIdentity(input.items),
    input.installed?.identity ?? 'none',
    input.generatedAt ?? '',
    input.cached ? 'cached' : 'fresh',
  ].join('|')
}

/**
 * 最终管线（纯函数，不做缓存）：标已安装 → 投影回 wire 形状 → 分类计数。
 *
 * 分类计数在**最终**条目集上算（投影之后），因此筛选器列出的分类与卡片能显示的分类完全一致。
 *
 * @param input - 见 {@link MarketplaceInput}。
 * @returns wire 结果。
 */
export function finalizeMarketplace(input: MarketplaceInput): MarketplaceResult {
  const ambiguous = input.installed === null ? undefined : ambiguousSlugs(input.items)
  const items: MarketItem[] = []
  for (const item of input.items) {
    items.push(toWireItem(flagInstalled(item, input.installed, ambiguous === undefined ? {} : { ambiguousSlugs: ambiguous })))
  }
  return {
    items,
    generatedAt: input.generatedAt ?? '',
    cached: input.cached,
    categories: categoryCounts(items),
  }
}

/** 本次 listing 里 slug 冲突的条目名（无法安全归属到目录探测）。 */
function ambiguousSlugs(items: readonly MarketplaceCandidate[]): ReadonlySet<string> {
  const counts = new Map<string, number>()
  for (const item of items) {
    const slug = directorySlug(item.name)
    if (slug.length === 0) continue
    counts.set(slug, (counts.get(slug) ?? 0) + 1)
  }
  const out = new Set<string>()
  for (const [slug, count] of counts) {
    if (count > 1) out.add(slug)
  }
  return out
}

/** 管线缓存：每个 profile 一格（代际只前进，所以一格足够）。 */
const pipelineCache = new Map<string, { readonly key: string; readonly result: MarketplaceResult }>()

/**
 * 带缓存的最终管线。
 *
 * 命中时返回**同一个对象实例**：调用方（REST 层的序列化缓存）可以拿它当 key。
 *
 * @param input - 见 {@link MarketplaceInput}。
 * @returns wire 结果。
 */
export function cachedMarketplace(input: MarketplaceInput): MarketplaceResult {
  const key = marketplaceCacheKey(input)
  const cached = pipelineCache.get(input.profile)
  if (cached !== undefined && cached.key === key) return cached.result
  const result = finalizeMarketplace(input)
  pipelineCache.set(input.profile, { key, result })
  return result
}

/** 清空管线缓存（测试 / 插件卸载用）。 */
export function clearMarketplaceCache(): void {
  pipelineCache.clear()
}

/**
 * registry.ts — 社区索引（topic:dsh-plugin 全量表）的多源兜底链与磁盘缓存。
 *
 * 归属：A 类·重写（旧 src/registry.ts 仅作意图参考，未复制代码）。
 * 旧实现参考：dsh-web-plugin-manager/src/registry.ts（理解意图用，未复制代码）——它解决的问题是：
 *   社区索引（registry.json，CI 每两小时重建）能让市场拿到几千条条目而**完全不碰 GitHub API 配额**；
 *   CDN 会滞后所以需要新鲜度判断；单一来源不可靠所以需要多源兜底；全部失败时要有磁盘缓存兜底。
 * 官方复用：无。官方没有市场概念，也没有索引/代理/缓存能力（见 DESIGN.md §1 的分工表）。
 * 前提检查：旧实现的前提仍然成立（社区索引依旧是唯一零配额的全量来源），但它踩过的四个坑必须避开，
 *   旧审计 docs/private/audit/correctness.md 有记录：
 *   1) M14：GitHub api/raw 的响应**没有 generated_at**，旧实现因此只允许 CDN 结果落盘——一旦 CDN 不可达，
 *      缓存永远不会被写入。本实现改成"**只允许更新，不允许回退**"：候选索引的 generated_at 必须不旧于
 *      已缓存的那个，才允许落盘（对任何来源都成立，比"按来源白名单"更精确）。
 *   2) M15：五跳串行 × 单请求 15s 可以挂住 75s。本实现给整条链一个总预算（默认 60s）并**真正中止**
 *      在途请求（AbortController），而不是只把 Promise.race 掉、让请求继续在后台跑。
 *   3) 缓存写入用 pretty-print 的 JSON，3115 条时 1.93MB / 5.4ms（旧 perf 审计 §1.8）。这里一律紧凑输出。
 *   4) 索引内容没有做"条目级"校验——非对象、缺 repo 名的条目会被当成合法条目流入下游。这里逐条严格归一化，
 *      并如实报告丢掉了多少条（skipped），不静默。
 *
 * 数据源与旧仓库一致（**不扩数据源**：不做 catalog 目录抓取、不引入 dsh.so 覆盖层）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { dshHome } from './paths.ts'
import type { Fetcher } from './net.ts'
import type { MarketItemKind } from './types.ts'

/** 社区索引仓库。只读消费，永远是硬编码兜底，不是依赖。 */
export const REGISTRY_OWNER = 'bradeGithub'
export const REGISTRY_REPO = 'DSH-Plugins-Marketplace'
/** 索引文件名（仓库根目录下由 CI 生成）。 */
export const REGISTRY_FILE = 'registry.json'

/** 索引缓存的默认有效期（分钟级配置见 settings.marketplace.cacheTtlMinutes）。 */
export const REGISTRY_CACHE_TTL_MS = 24 * 60 * 60 * 1000
/** CDN 会滞后：标记为 requireFresh 的来源，其索引超过这个年龄就跳到下一跳。 */
export const CDN_MAX_INDEX_AGE_MS = 6 * 60 * 60 * 1000
/** 整条兜底链的总预算：单请求超时由调用方给，总预算在这里封顶。 */
export const REGISTRY_TOTAL_BUDGET_MS = 60_000

/** 官方自己的仓库不是插件，永远不进市场。 */
const EXCLUDED_REPOS = new Set(['deepseek-harness'])

/**
 * 生态泛化主题词：它们是"生态标签"而不是功能信号，会挤掉卡片上有信息量的 topic。
 *
 * 这是一份**手写的小表**（不是从旧仓库或上游复制的 100+ 词表）：只保留最容易泛滥的
 * 十几个，宁可少过滤也不误杀有意义的主题。要扩充时按同一标准加（"这个词能否区分两个插件"）。
 */
export const ECO_GENERIC_TOPICS = new Set([
  'ai', 'llm', 'agent', 'agents', 'cli', 'cordis', 'cordis-plugin', 'deepseek', 'deepseek-harness',
  'dsh', 'dsh-plugin', 'dsh-plugins', 'gui', 'javascript', 'plugin', 'plugins', 'python', 'react',
  'skill', 'skills', 'tool', 'tools', 'tui', 'typescript', 'ui', 'web', 'web-ui',
])

/** 一个主题列表 → 去掉生态泛化词后的功能主题（最多 8 个，卡片上只显示 2 个）。 */
export function functionalTopics(topics: readonly string[] | undefined): string[] {
  if (topics === undefined || topics.length === 0) return []
  const out: string[] = []
  for (const topic of topics) {
    const value = String(topic).trim().toLowerCase()
    if (value.length === 0 || ECO_GENERIC_TOPICS.has(value)) continue
    out.push(value)
    if (out.length >= 8) break
  }
  return out
}

/** 索引里的一条仓库条目（已归一化，JSON-safe）。 */
export interface RegistryRepo {
  /** owner/repo，原样大小写。 */
  readonly repo: string
  /** 仓库名（repo 的 basename）。 */
  readonly name: string
  readonly description: string
  /** 星数；索引没给时为 null（**不伪造 0**——0 与"未知"在排序/展示上是两回事）。 */
  readonly stars: number | null
  /** 最后更新时间的 ISO 串；未知时 null。 */
  readonly updatedAt: string | null
  readonly topics: readonly string[]
  readonly category?: string
  /** 仓库发布的 npm 包名（CI 采集）；装到 profile 里的键就是它。 */
  readonly packageName?: string
  /** 仓库 package.json 里的版本（CI 采集）。 */
  readonly latestVersion?: string
  /** 上游若显式给出条目形态就透传；否则由 marketplace.ts 按来源判定。 */
  readonly kind?: MarketItemKind
}

const MARKET_ITEM_KINDS: readonly MarketItemKind[] = ['cordis-plugin', 'skill', 'agent-preset', 'unknown']

/** 取字符串字段；空白串视为缺失。 */
function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * 归一化一条原始索引条目；不可用时返回 null。
 *
 * 严格性是有意的：索引是外部 JSON，字段缺失/类型漂移必须在这里被挡住，
 * 否则下游的类型假设会变成运行时 TypeError（旧仓库在卡片渲染里就被 topic 非字符串炸过）。
 *
 * @param raw - 索引里的一条记录（registry.json 或 search API 的形状都兼容）。
 * @returns 归一化条目；非对象、无 repo 名、或被排除的仓库返回 null。
 */
export function normalizeRegistryRepo(raw: unknown): RegistryRepo | null {
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const fullName = str(record['full_name']) ?? str(record['repo'])
  if (fullName === undefined || !/^[^/\s]+\/[^/\s]+$/.test(fullName)) return null
  const name = str(record['name']) ?? fullName.slice(fullName.lastIndexOf('/') + 1)
  if (EXCLUDED_REPOS.has(name.toLowerCase())) return null
  const topics = Array.isArray(record['topics'])
    ? record['topics'].filter((topic): topic is string => typeof topic === 'string')
    : []
  const stars = typeof record['stargazers_count'] === 'number' && Number.isFinite(record['stargazers_count'])
    ? record['stargazers_count']
    : null
  const kind = MARKET_ITEM_KINDS.includes(record['kind'] as MarketItemKind)
    ? record['kind'] as MarketItemKind
    : undefined
  const category = str(record['category'])
  const packageName = str(record['pkg_name']) ?? str(record['package_name'])
  const latestVersion = str(record['version'])
  return {
    repo: fullName,
    name,
    description: str(record['description']) ?? '',
    stars,
    updatedAt: str(record['updated_at']) ?? null,
    topics,
    ...(category === undefined ? {} : { category }),
    ...(packageName === undefined ? {} : { packageName }),
    ...(latestVersion === undefined ? {} : { latestVersion }),
    ...(kind === undefined ? {} : { kind }),
  }
}

/** 索引载荷的解析结果。 */
export interface ParsedRegistryPayload {
  readonly repos: readonly RegistryRepo[]
  /** 索引自身的生成时间（ISO）；载荷没给时为 null。 */
  readonly generatedAt: string | null
  /** 被丢弃的条目数（形状不合法或被排除）——如实报告，不静默。 */
  readonly skipped: number
}

/**
 * 解析一份索引载荷（registry.json 的 `{generated_at, repos}`、search API 的 `{items}`、或裸数组）。
 *
 * 按 repo 名去重（保留先出现的那条：索引自己已排好序，先出现的是上游的取舍）。
 *
 * @param payload - 已 JSON.parse 的载荷。
 * @returns 解析结果；没有任何可用条目时返回 null（调用方据此跳到下一跳）。
 */
export function parseRegistryPayload(payload: unknown): ParsedRegistryPayload | null {
  let list: unknown[]
  let generatedAt: string | null = null
  if (Array.isArray(payload)) {
    list = payload
  } else if (payload !== null && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    const candidate = record['repos'] ?? record['items'] ?? record['plugins']
    if (!Array.isArray(candidate)) return null
    list = candidate
    generatedAt = str(record['generated_at']) ?? str(record['generatedAt']) ?? null
  } else {
    return null
  }
  const seen = new Set<string>()
  const repos: RegistryRepo[] = []
  let skipped = 0
  for (const entry of list) {
    const repo = normalizeRegistryRepo(entry)
    if (repo === null) {
      skipped += 1
      continue
    }
    const key = repo.repo.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    repos.push(repo)
  }
  return repos.length === 0 ? null : { repos, generatedAt, skipped }
}

/** 索引的一跳来源。 */
export interface RegistryIndexSource {
  readonly id: string
  readonly url: string
  /** 响应是 gzip（.gz 文件）时需要解压。 */
  readonly gzip: boolean
  /** 附带 GitHub token（只有 api.github.com 认这个头）。 */
  readonly token: boolean
  /** CDN 一跳：索引必须比 CDN_MAX_INDEX_AGE_MS 新，否则跳到下一跳。 */
  readonly requireFresh: boolean
}

/**
 * 兜底链的跳数顺序：api.github → jsDelivr(.gz) → raw(.gz) → jsDelivr → raw。
 *
 * 顺序的由来：api.github.com 带 token 时最可靠且能读到刚 push 的文件（CDN 会滞后），
 * 但无 token 时配额只有 60/h，所以 CDN 的 .gz（体积最小）紧跟其后；raw 是最不依赖 CDN 的一跳。
 *
 * settings.marketplace.indexUrl 非空时作为**首选**跳插入队首，但内置链仍然保留：
 * 用户填错地址不该让整个市场变成空的（配置是"优选"而不是"唯一"，这一点在配置项注释里也写了）。
 *
 * @param options - indexUrl（用户自定义源）与 branch（fork/镜像用）。
 * @returns 按尝试顺序排列的来源列表。
 */
export function registryIndexSources(options: { readonly indexUrl?: string; readonly branch?: string } = {}): RegistryIndexSource[] {
  const branch = options.branch ?? 'main'
  const base = `${REGISTRY_OWNER}/${REGISTRY_REPO}`
  const sources: RegistryIndexSource[] = []
  const custom = options.indexUrl?.trim()
  if (custom !== undefined && custom.length > 0) {
    sources.push({ id: 'custom', url: custom, gzip: custom.endsWith('.gz'), token: false, requireFresh: false })
  }
  sources.push(
    { id: 'api', url: `https://api.github.com/repos/${base}/contents/${REGISTRY_FILE}.gz`, gzip: true, token: true, requireFresh: false },
    { id: 'jsdelivr-gz', url: `https://cdn.jsdelivr.net/gh/${base}@${branch}/${REGISTRY_FILE}.gz`, gzip: true, token: false, requireFresh: true },
    { id: 'raw-gz', url: `https://raw.githubusercontent.com/${base}/${branch}/${REGISTRY_FILE}.gz`, gzip: true, token: false, requireFresh: false },
    { id: 'jsdelivr', url: `https://cdn.jsdelivr.net/gh/${base}@${branch}/${REGISTRY_FILE}`, gzip: false, token: false, requireFresh: true },
    { id: 'raw', url: `https://raw.githubusercontent.com/${base}/${branch}/${REGISTRY_FILE}`, gzip: false, token: false, requireFresh: false },
  )
  return sources
}

/** 磁盘缓存的落盘形状。 */
export interface RegistryCacheFile {
  /** 落盘时刻（epoch ms）——文件年龄。 */
  readonly savedAt: number
  /** 索引自身生成时间（ISO）；未知时 null。 */
  readonly generatedAt: string | null
  readonly repos: readonly RegistryRepo[]
}

/** 索引磁盘缓存路径（本插件自己的缓存目录，不与旧包共用）。 */
export function registryCachePath(): string {
  return join(dshHome(), 'plugin-manager-companion', 'registry-index.json')
}

/**
 * 读取磁盘缓存；不存在/损坏/形状不对时返回 null。
 *
 * 损坏的缓存**不抛错**：它是可重建的派生物，抛错会把一次网络抖动升级成市场页整页失败。
 */
export function readRegistryCacheFile(): RegistryCacheFile | null {
  const path = registryCachePath()
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const parsed = parseRegistryPayload(raw['repos'])
    if (parsed === null) return null
    const savedAt = typeof raw['savedAt'] === 'number' && Number.isFinite(raw['savedAt']) ? raw['savedAt'] : null
    if (savedAt === null) return null
    return {
      savedAt,
      generatedAt: str(raw['generatedAt']) ?? parsed.generatedAt,
      repos: parsed.repos,
    }
  } catch {
    return null
  }
}

/**
 * 写入磁盘缓存（紧凑 JSON）。
 *
 * 写失败**不抛**：缓存是派生物，磁盘满/无权限不该让一次成功的抓取变成失败。
 *
 * @returns 是否真的写成功了（调用方据此在 notes 里如实记账）。
 */
export function writeRegistryCacheFile(entry: RegistryCacheFile): boolean {
  try {
    const path = registryCachePath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ savedAt: entry.savedAt, generatedAt: entry.generatedAt, repos: entry.repos }) + '\n')
    return true
  } catch {
    return false
  }
}

/**
 * 缓存是否新鲜（纯函数，TTL 语义的唯一实现处）。
 *
 * 两条都要满足：**文件年龄**在 TTL 内（savedAt），且**内容年龄**（generatedAt，若可知）也在 TTL 内。
 * 只看 savedAt 会让"今天才存下来的三天前索引"被当成新鲜；只看 generatedAt 则无法处理
 * 载荷不带生成时间的来源（那时只能靠文件年龄）。
 *
 * @param entry - 缓存的 savedAt 与 generatedAt。
 * @param now - 当前时刻（epoch ms），由调用方注入以便测试。
 * @param ttlMs - 有效期。
 */
export function isRegistryCacheFresh(
  entry: { readonly savedAt: number; readonly generatedAt: string | null },
  now: number,
  ttlMs: number,
): boolean {
  if (!Number.isFinite(entry.savedAt) || now - entry.savedAt > ttlMs) return false
  if (entry.generatedAt === null) return true
  const at = Date.parse(entry.generatedAt)
  if (Number.isNaN(at)) return true
  return now - at <= ttlMs
}

/**
 * 候选索引是否允许覆盖已缓存的那个（M14，纯函数）。
 *
 * 规则只有一条：**只许更新，不许回退**。
 * - 候选没有 generatedAt：无法证明它不旧，拒绝落盘（宁可下次再抓，也不拿一个无法判断年龄的
 *   快照覆盖掉已知新鲜的缓存）；
 * - 没有缓存：允许；
 * - 有缓存：候选的 generatedAt 必须 >= 缓存的那个。
 */
export function shouldPersistRegistryIndex(candidateGeneratedAt: string | null, cachedGeneratedAt: string | null): boolean {
  if (candidateGeneratedAt === null) return false
  if (cachedGeneratedAt === null) return true
  const candidate = Date.parse(candidateGeneratedAt)
  const cached = Date.parse(cachedGeneratedAt)
  if (Number.isNaN(candidate) || Number.isNaN(cached)) return true
  return candidate >= cached
}

/** 一次索引加载的结果。 */
export interface RegistryIndex {
  readonly repos: readonly RegistryRepo[]
  /** 索引自身生成时间（ISO）；未知时 null。 */
  readonly generatedAt: string | null
  /** 本进程读到这份数据的时刻（epoch ms）。 */
  readonly savedAt: number
  /** true = 来自磁盘缓存（本次没有走网络）。 */
  readonly cached: boolean
  /** true = 缓存已过期（TTL 之外）但仍被采用——UI 应如实显示"数据可能过时"。 */
  readonly stale: boolean
  /** 数据来源标识：`network:<id>` / `cache` / `empty`。 */
  readonly source: string
  /** 逐跳的失败原因与如实记账（不静默吞掉）。 */
  readonly notes: readonly string[]
  /** 进程内镜像的内容代际（每次写入 +1）；缓存键的内容身份之一。 */
  readonly generation: number
  /** 被丢弃的索引条目数。 */
  readonly skipped: number
}

/** 加载入参。 */
export interface LoadRegistryIndexOptions {
  /** 忽略新鲜缓存，强制走网络（用户点"刷新"）。 */
  readonly refresh?: boolean
  readonly ttlMs?: number
  readonly timeoutMs?: number
  readonly totalBudgetMs?: number
  readonly indexUrl?: string
  readonly branch?: string
  /** 注入当前时刻（测试用）。 */
  readonly now?: number
  /** 注入抓取器（测试用）；默认走 net.ts 的 fetchWithProxy。 */
  readonly fetcher?: Fetcher
  /** 注入环境变量（token 读取用）。 */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/**
 * 内容哈希（FNV-1a，32 位十六进制）。
 *
 * 逐段就地计算，不拼接中间大字符串。段间混入一个分隔符，避免 (`ab`,`c`) 与 (`a`,`bc`) 撞。
 * 放在 registry.ts 而不是 marketplace.ts：内容身份首先是"索引内容"的概念，
 * 下游（管线缓存键）只是复用同一个哈希。
 */
export function hashIdentity(parts: readonly string[]): string {
  let hash = 0x811c9dc5
  for (const part of parts) {
    for (let index = 0; index < part.length; index += 1) {
      hash ^= part.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193)
    }
    hash ^= 0x1f
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * 一份索引的**内容印章**：只覆盖下游管线结果真正依赖的字段
 * （repo / name / category / kind / packageName）+ 索引生成时间。
 *
 * stars 与 updatedAt 故意不进印章：它们只影响展示，不影响已安装标记与分类计数，
 * 为它们推进代际只会让下游缓存白白失效。
 */
function contentStamp(repos: readonly RegistryRepo[], generatedAt: string | null): string {
  const parts: string[] = [generatedAt ?? '', String(repos.length)]
  for (const repo of repos) {
    parts.push(repo.repo, repo.name, repo.category ?? '', repo.kind ?? '', repo.packageName ?? '')
  }
  return hashIdentity(parts)
}

/** 进程内镜像（避免每次请求都读 1.5MB 的磁盘缓存）。 */
let memoryCache: { readonly at: number; readonly index: RegistryIndex } | null = null
/**
 * 内容代际：**只有内容印章变化时才 +1**。
 *
 * 旧审计 m-3 的教训：把"写入时刻"当代际，会让内容一模一样的重建（磁盘缓存重读、
 * TTL 到期重建）也把下游管线缓存顶掉，13k 条目白跑一遍。这里按内容推进。
 */
let memoryGeneration = 0
/** 上一次发布的内容印章（决定代际是否推进）。 */
let lastStamp: string | null = null
/** 在途的网络走链：并发刷新共享同一次抓取，避免 N 个页签打出 N 份请求。 */
let inFlight: Promise<RegistryIndex> | null = null

/** 当前镜像的内容代际；无镜像时为 0。 */
export function registryGeneration(): number {
  return memoryCache?.index.generation ?? 0
}

/** 清空进程内镜像与在途状态（测试与插件卸载用）。 */
export function resetRegistryMemory(): void {
  memoryCache = null
  memoryGeneration = 0
  lastStamp = null
  inFlight = null
}

/** 把一份结果放进镜像并推进代际。 */
function publish(repos: readonly RegistryRepo[], generatedAt: string | null, savedAt: number, notes: readonly string[], cached: boolean, stale: boolean, source: string, skipped: number): RegistryIndex {
  const stamp = contentStamp(repos, generatedAt)
  if (stamp !== lastStamp) {
    memoryGeneration += 1
    lastStamp = stamp
  }
  const index: RegistryIndex = {
    repos, generatedAt, savedAt, cached, stale, source, notes,
    generation: memoryGeneration,
    skipped,
  }
  memoryCache = { at: savedAt, index }
  return index
}

/** GitHub token（有就用，没有就匿名）。 */
function githubToken(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const token = env['GITHUB_TOKEN'] ?? env['GH_TOKEN']
  return token === undefined || token.trim().length === 0 ? undefined : token.trim()
}

/**
 * 逐跳走网络。
 *
 * 总预算用 AbortController **真正中止**在途请求（旧实现只 race 掉 Promise，请求还在后台跑）。
 */
async function walkSources(
  sources: readonly RegistryIndexSource[],
  options: Required<Pick<LoadRegistryIndexOptions, 'timeoutMs' | 'totalBudgetMs' | 'now'>> & {
    readonly fetcher: Fetcher
    readonly env: Readonly<Record<string, string | undefined>>
  },
): Promise<{ parsed: ParsedRegistryPayload; source: string; notes: string[] } | { parsed: null; notes: string[] }> {
  const notes: string[] = []
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, options.totalBudgetMs)
  const token = githubToken(options.env)
  try {
    for (const source of sources) {
      if (controller.signal.aborted) {
        notes.push(`总预算 ${options.totalBudgetMs}ms 用尽，剩余来源已跳过`)
        break
      }
      try {
        const headers: Record<string, string> = { 'user-agent': 'dsh-plugin-manager-companion' }
        if (source.token) {
          headers['accept'] = 'application/vnd.github.raw'
          if (token !== undefined) headers['authorization'] = `Bearer ${token}`
        }
        const response = await options.fetcher(source.url, {
          headers,
          timeoutMs: options.timeoutMs,
          signal: controller.signal,
        })
        if (!response.ok) {
          notes.push(`${source.id}: HTTP ${response.status}`)
          continue
        }
        const buffer = Buffer.from(await response.arrayBuffer())
        let text: string
        if (source.gzip) {
          try {
            text = gunzipSync(buffer).toString('utf8')
          } catch (error) {
            notes.push(`${source.id}: gzip 解压失败（${error instanceof Error ? error.message : String(error)}）`)
            continue
          }
        } else {
          text = buffer.toString('utf8')
        }
        let parsed: ParsedRegistryPayload | null
        try {
          parsed = parseRegistryPayload(JSON.parse(text))
        } catch (error) {
          notes.push(`${source.id}: JSON 解析失败（${error instanceof Error ? error.message : String(error)}）`)
          continue
        }
        if (parsed === null) {
          notes.push(`${source.id}: 没有可用条目`)
          continue
        }
        if (source.requireFresh) {
          const at = parsed.generatedAt === null ? Number.NaN : Date.parse(parsed.generatedAt)
          if (Number.isNaN(at) || options.now - at > CDN_MAX_INDEX_AGE_MS) {
            notes.push(`${source.id}: 索引过旧（CDN 会滞后），跳到下一跳`)
            continue
          }
        }
        if (parsed.skipped > 0) notes.push(`${source.id}: 丢弃 ${parsed.skipped} 条不合法条目`)
        return { parsed, source: `network:${source.id}`, notes }
      } catch (error) {
        notes.push(`${source.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { parsed: null, notes }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 加载索引：新鲜镜像 → 新鲜磁盘缓存 → 网络兜底链 → 过期磁盘缓存 → 空。
 *
 * 每一跳的结果都记进 `notes`：调用方（诊断页/市场页）能把"这次数据是怎么来的、
 * 哪几跳失败了"如实展示给用户，而不是给一个空列表让人以为是"没有插件"。
 *
 * @param options - 见 {@link LoadRegistryIndexOptions}。
 * @returns 索引结果；全部来源都不可用时返回空 items 的 `source: 'empty'`（**不抛错**）。
 */
export async function loadRegistryIndex(options: LoadRegistryIndexOptions = {}): Promise<RegistryIndex> {
  const now = options.now ?? Date.now()
  const ttlMs = options.ttlMs ?? REGISTRY_CACHE_TTL_MS
  const refresh = options.refresh === true

  if (!refresh) {
    if (memoryCache !== null && isRegistryCacheFresh(memoryCache.index, now, ttlMs)) return memoryCache.index
    const disk = readRegistryCacheFile()
    if (disk !== null && isRegistryCacheFresh(disk, now, ttlMs)) {
      return publish(disk.repos, disk.generatedAt, now, ['来自磁盘缓存（未过期）'], true, false, 'cache', 0)
    }
  }

  const fetcher = options.fetcher ?? (await import('./net.ts')).fetchWithProxy
  const walk = (): Promise<RegistryIndex> => (async () => {
    const sources = registryIndexSources({ ...(options.indexUrl === undefined ? {} : { indexUrl: options.indexUrl }), ...(options.branch === undefined ? {} : { branch: options.branch }) })
    const result = await walkSources(sources, {
      timeoutMs: options.timeoutMs ?? 15_000,
      totalBudgetMs: options.totalBudgetMs ?? REGISTRY_TOTAL_BUDGET_MS,
      now,
      fetcher,
      env: options.env ?? process.env,
    })
    if (result.parsed !== null) {
      const cached = readRegistryCacheFile()
      const persist = shouldPersistRegistryIndex(result.parsed.generatedAt, cached?.generatedAt ?? null)
      if (persist) {
        const ok = writeRegistryCacheFile({ savedAt: now, generatedAt: result.parsed.generatedAt, repos: result.parsed.repos })
        if (!ok) result.notes.push('磁盘缓存写入失败（不影响本次结果）')
      } else if (result.parsed.generatedAt === null) {
        result.notes.push('本次索引未携带 generated_at，为不覆盖已知更新鲜的缓存而跳过落盘')
      } else {
        result.notes.push('本次索引比磁盘缓存旧，跳过落盘')
      }
      return publish(result.parsed.repos, result.parsed.generatedAt, now, result.notes, false, false, result.source, result.parsed.skipped)
    }
    const stale = readRegistryCacheFile()
    if (stale !== null) {
      return publish(stale.repos, stale.generatedAt, now, [...result.notes, '全部网络来源失败，回退到过期磁盘缓存'], true, true, 'cache-stale', 0)
    }
    return publish([], null, now, [...result.notes, '全部网络来源失败且无磁盘缓存'], true, true, 'empty', 0)
  })()

  // 在途去重：并发的刷新共享同一次走链。
  if (inFlight !== null) {
    const shared = await inFlight
    // 共享结果可能早于本次调用（用户点了刷新而另一次走链刚结束），此时自己再走一次。
    if (shared.source !== 'cache' && shared.source !== 'cache-stale') return shared
  }
  const started = walk()
  inFlight = started
  try {
    return await started
  } finally {
    if (inFlight === started) inFlight = null
  }
}

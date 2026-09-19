/**
 * marketView.ts — 市场页的视图决策（**DOM-free 纯函数**：无 fs / 无 ctx / 无网络）。
 *
 * 归属：B 类·参考重写（旧 src/marketView.ts 仅作意图参考，未复制代码；用例语义在 tests/marketplace.test.mjs 重写）。
 * 旧实现参考：dsh-web-plugin-manager/src/marketView.ts（理解意图用，未复制代码）——它解决的问题是：
 *   页面原来把"排什么序、筛掉什么、显示什么文案"写在组件里，于是排序契约无法测试，
 *   方向按钮写着一个方向、列表却在另一个方向上（用户实测反馈），0 星条目还会跑到首屏。
 *   把决策抽到 DOM-free 模块后，测试 import 构建产物即可覆盖排序契约——"被验的代码就是线上跑的代码"。
 * 官方复用：无。官方没有市场概念，也没有排序/筛选模型；本模块的标签数据来自 tags.ts，
 *   渲染由 client 用官方 ui-primitives 完成（这里只产出数据与字典键）。
 * 前提检查：旧实现的两条教训继续成立并被固化进实现：
 *   1) **升序极化 + 单一 descending 取反**：四个模式共用同一套比较器，绝不混用极性
 *      （旧 stars 分支按降序写、又被无条件取反，就是"方向与按钮相反"的根因）；
 *   2) **已安装是优先级而不是排序键**：任何模式、任何方向都恒在最前，翻转方向不得把它压到底部
 *      （旧实现只在 stars 分支里兑现了这件事）。
 *   与旧实现的差异（由新契约决定，非随意变更）：
 *   - 排序模式由 4 个（stars/az/updated/created）改为 stars/az/updated/category：新 wire 契约
 *     （src/types.ts 的 MarketItem）只有 updatedAt 一个时间字段，没有 createdAt，也没有 url/status；
 *     凭空造一个 created 模式就是"扩数据源"，被任务明确禁止。category 是索引自带的分类字段，
 *     按它聚拢是筛选器表达不了的浏览顺序。
 *   - task-41 起本模块还负责**检索**（prepareMarketSearch / searchMarket）：搜索键从"只有名称"
 *     扩到 name + repo + 主题 + 描述，中文走子串（旧实现里中文查询命中恒为 0）。键击预算靠三条
 *     预计算撑住：小写字段、名称掩码（子序列的必要条件）、以及"纯 ASCII 名称 + CJK 查询直接跳过
 *     名称通道"。实测 13,998 条上每键击 1.4–4.1 ms（改动前只搜名称是 2.7–24 ms）。
 *   - 未知值（stars=null / updatedAt=null / 无 category）在**默认方向**下永远排在末尾：
 *     stars / updated 默认降序，未知取最小值自然落到末尾；category 默认升序，未知显式排在
 *     有分类之后。"无星条目越位到首屏"因此不可能再发生，排序仍是"升序极化 + 单次取反"的纯形状
 *     （方向翻转时它们回到队首，那是"反转"的诚实含义）。
 */

import type { MarketItem } from './types.ts'
import { buildMarketTags, type MarketTag } from './tags.ts'
import { compareVersions, tokenize } from './match.ts'
import { charMask, fuzzyScoreLowered, type CharMask } from './rank.ts'

/**
 * 排序模式。
 * - `stars`：星数；`trending`：近 7 天 star 增量；`az`：名称；`updated`：最后更新；`category`：上游分类。
 */
export type MarketSort = 'stars' | 'trending' | 'az' | 'updated' | 'category'

/**
 * 工具栏里的模式顺序（也是循环切换的顺序）。
 *
 * `trending` 用上游的 stars_delta_7d（近 7 天增量，12,921 条有值）：星数排序对新插件不利
 * （全体星数中位 1、6,466 条 0 星），"最近在涨"是另一件事。政策规定它**只做排序、不做徽标**
 * （7,735 条增量为 0，做成徽标就是噪声）。
 */
export const SORT_MODES: readonly MarketSort[] = ['stars', 'trending', 'az', 'updated', 'category']

/**
 * 每个模式的**默认方向**（切换模式时套用；用户按方向按钮可再翻转）。
 * 星数/时间读"越大越前"，名称读 A→Z，分类读 A→Z。
 */
export const SORT_DEFAULT_DESCENDING: Readonly<Record<MarketSort, boolean>> = {
  stars: true,
  trending: true,
  az: false,
  updated: true,
  category: false,
}

/** 该模式的默认方向。 */
export function defaultDescendingFor(sort: MarketSort): boolean {
  return SORT_DEFAULT_DESCENDING[sort]
}

/** "全部分类"的选项值（上游不存在空分类 id，所以空串是安全的哨兵值）。 */
export const ALL_CATEGORIES = ''

/** 分类筛选下拉里被钉在最后的兜底分类（上游分类器的大杂烩桶）。 */
export const CATCH_ALL_CATEGORY = 'other'

/** 本模块产出的字典键（client 侧字典必须有这些键；文案不在这里硬编码）。 */
export type MarketLabelKey =
  | 'sortStars' | 'sortTrending' | 'sortAz' | 'sortUpdated' | 'sortCategory'
  | 'sortAsc' | 'sortDesc' | 'filterCategory'
  | 'typeCordisPlugin' | 'typeSkill' | 'typeAgentPreset'
  | 'statusVerified' | 'statusArchived' | 'statusPending'
  | 'securityLow' | 'securityMedium' | 'securityHigh' | 'securityUnknown'

/** 模式的字典键。 */
export function sortLabelKey(sort: MarketSort): MarketLabelKey {
  switch (sort) {
    case 'trending': return 'sortTrending'
    case 'az': return 'sortAz'
    case 'updated': return 'sortUpdated'
    case 'category': return 'sortCategory'
    default: return 'sortStars'
  }
}

/** 安装形态的字典键。 */
export function typeLabelKey(kind: string | undefined): MarketLabelKey {
  if (kind === 'skill') return 'typeSkill'
  if (kind === 'agent-preset') return 'typeAgentPreset'
  return 'typeCordisPlugin'
}

/** 安全风险等级的字典键（无法识别的等级走"未知"，绝不折叠成 low）。 */
export function securityLabelKey(riskLevel: string): MarketLabelKey {
  switch (riskLevel.trim().toLowerCase()) {
    case 'low': return 'securityLow'
    case 'medium': return 'securityMedium'
    case 'high': return 'securityHigh'
    case 'critical': return 'securityHigh'
    default: return 'securityUnknown'
  }
}

/** 策展状态的字典键。 */
export function statusLabelKey(status: string): MarketLabelKey {
  if (status.includes('✅')) return 'statusVerified'
  return status.toLowerCase().includes('archiv') ? 'statusArchived' : 'statusPending'
}

/** 比较器结果 → 升序/降序标签。 */
export type SortDirection = 'asc' | 'desc'

/** 共享 ICU collator；null 表示环境不支持（退化到码元序）。惰性创建：host 侧也会 import 本模块。 */
let collator: Intl.Collator | null | undefined

/** 码元序：确定、与环境无关，用作 collator 不可用时的回退，以及所有并列时的最终 tie-break。 */
function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * 文本比较（名称用）。
 *
 * 用固定的 `en` + `numeric` 选项创建一次 collator 并复用：`localeCompare` 每次调用都会
 * 新建 collator（旧 perf 审计 §2 量化过这个开销），而且默认 locale 随环境变化、结果不稳定。
 * `numeric: true` 让 `plugin-2` 排在 `plugin-10` 前面（人读的顺序）。
 */
function compareText(left: string, right: string): number {
  if (collator === undefined) {
    try {
      collator = new Intl.Collator('en', { numeric: true })
    } catch {
      collator = null
    }
  }
  return collator === null ? compareCodeUnits(left, right) : collator.compare(left, right)
}

/** 星数排序键：未知按 0（= 该模式的最小值）。 */
function starsOf(item: MarketItem): number {
  return item.stars ?? 0
}

/** ISO 时间戳升序；未知按空串（= 最小值，降序时落到末尾）。 */
export function compareStamp(left: string | null, right: string | null): number {
  return compareCodeUnits(left ?? '', right ?? '')
}

/**
 * 模式的**主键**比较，四个分支一律升序极化（正数 = 升序时更靠后）。
 * 方向由 {@link rowComparator} 用同一个 descending 标志统一施加——绝不在分支里混用极性。
 */
export function compareByMode(left: MarketItem, right: MarketItem, sort: MarketSort): number {
  switch (sort) {
    case 'az':
      return compareText(left.name, right.name)
    case 'updated':
      return compareStamp(left.updatedAt, right.updatedAt)
    case 'trending':
      // 近 7 天 star 增量；增量为 0 与"上游没给"在这里同值——政策只把它当排序维度，
      // 不承担"有没有数据"的表达（60% 为 0，做成徽标就是噪声）。
      return (left.starsDelta7d ?? 0) - (right.starsDelta7d ?? 0)
    case 'category': {
      const leftCategory = (left.category ?? '').trim()
      const rightCategory = (right.category ?? '').trim()
      if (leftCategory === rightCategory) return 0
      // 无分类的条目排在有分类的之后（本模式默认升序）：未知值不占首屏。
      if (leftCategory.length === 0) return 1
      if (rightCategory.length === 0) return -1
      return compareCodeUnits(leftCategory, rightCategory)
    }
    default:
      return starsOf(left) - starsOf(right)
  }
}

/**
 * 并列时的 tie-break：名称 → repo，**两个方向都保持升序**。
 *
 * 保持升序是刻意的：13k 条目里星数并列是常态，翻转 tie-break 会把整条 0 星尾巴按 Z→A 倒过来，
 * 没有任何用户价值。它同时保证全序（repo 在索引里是唯一键；即便相同，`compareCodeUnits`
 * 也让结果只依赖值而不依赖输入顺序，剩余并列由 {@link sortRows} 的稳定排序与输入顺序决定）。
 */
export function compareTie(left: MarketItem, right: MarketItem): number {
  return compareText(left.name, right.name) || compareCodeUnits(left.name, right.name) || compareCodeUnits(left.repo, right.repo)
}

/**
 * 一个 (模式, 方向) 组合的比较器。
 *
 * @param sort - 排序模式。
 * @param descending - 主键方向；tie-break 不受它影响（见 {@link compareTie}）。
 * @returns 比较器；installed 恒在最前，与模式、方向都无关。
 */
export function rowComparator(sort: MarketSort, descending: boolean): (left: MarketItem, right: MarketItem) => number {
  return (left, right) => {
    const priority = Number(right.installed === true) - Number(left.installed === true)
    if (priority !== 0) return priority
    const primary = compareByMode(left, right, sort)
    if (primary !== 0) return descending ? -primary : primary
    return compareTie(left, right)
  }
}

/**
 * 排序（不修改入参）。
 *
 * @param items - 条目。
 * @param sort - 排序模式。
 * @param descending - 主键方向。
 * @returns 新数组。
 */
export function sortRows(items: readonly MarketItem[], sort: MarketSort, descending: boolean): MarketItem[] {
  return [...items].sort(rowComparator(sort, descending))
}

/**
 * 状态筛选：全部 / 只看已安装 / 只看可更新。
 *
 * 「可更新」用与卡片徽标同一个判据（{@link updateAvailable}），不在第二处重新判断"什么算可更新"。
 */
export type MarketStateFilter = 'all' | 'installed' | 'updatable'

/** 状态筛选的选项顺序（工具栏顺序）。 */
export const STATE_FILTERS: readonly MarketStateFilter[] = ['all', 'installed', 'updatable']

/**
 * 状态筛选。
 *
 * @param items - 条目。
 * @param filter - 选中的状态；`all` 原样返回。
 * @returns 筛后的条目（不筛时原样返回入参）。
 */
export function filterByState(items: readonly MarketItem[], filter: MarketStateFilter): readonly MarketItem[] {
  if (filter === 'all') return items
  if (filter === 'installed') return items.filter((item) => item.installed === true)
  return items.filter((item) => updateAvailable(item))
}

/**
 * 上游可装性过滤（政策 §3.2 第 1 条）。
 *
 * **只过滤一种**：installable = non-plugin（上游明说"不是插件"，1,018 条，样本里有 96,949★ 的蹭话题仓库）。
 * 其余一律照常显示——上游没标记（12,256 条）不等于"可一键安装"，我们**不替上游补这个结论**；
 * installable = manual 也不隐藏，它由「需手动安装」徽标如实说明。
 *
 * 过滤是**展示决策**，所以放在客户端：REST 结果里这些条目仍然在，host 从不替用户做取舍。
 *
 * @param items - 条目。
 * @param includeNonPlugin - 用户是否主动打开「显示非插件条目」。
 * @returns 筛后的条目。
 */
export function filterInstallable(items: readonly MarketItem[], includeNonPlugin: boolean): readonly MarketItem[] {
  if (includeNonPlugin) return items
  return items.filter((item) => item.installable !== 'non-plugin')
}

/**
 * 分类筛选。
 *
 * 精确匹配（两侧都 trim）：选项 id 来自 categoryOptions（已 trim），
 * 上游偶尔带空格的条目也必须能被自己的分类找到；空分类条目**不会**被混进任何桶。
 *
 * @param items - 条目。
 * @param category - 分类 id；{@link ALL_CATEGORIES} 表示不筛。
 * @returns 筛后的条目（不筛时原样返回入参）。
 */
export function filterByCategory(items: readonly MarketItem[], category: string): readonly MarketItem[] {
  if (category === ALL_CATEGORIES) return items
  const wanted = category.trim()
  return items.filter((item) => (item.category ?? '').trim() === wanted)
}

/**
 * 分类下拉的顺序：计数降序 → id 升序，兜底分类钉在最后。
 *
 * "兜底分类最后"是有意的：它是分类器的 catch-all 桶、体量最大，按计数排会永远占住菜单第一项，
 * 把真正的功能分类挤下去。
 *
 * @param counts - {@link import('./tags.ts').categoryCounts} 的产出（或 wire 上的 categories）。
 * @returns `{id, count}` 列表。
 */
export function categoryOptions(counts: Readonly<Record<string, number>>): { readonly id: string; readonly count: number }[] {
  const known: { id: string; count: number }[] = []
  const catchAll: { id: string; count: number }[] = []
  for (const [rawId, rawCount] of Object.entries(counts)) {
    const id = rawId.trim()
    if (id.length === 0 || !Number.isFinite(rawCount)) continue
    const entry = { id, count: rawCount }
    if (id.toLowerCase() === CATCH_ALL_CATEGORY) catchAll.push(entry)
    else known.push(entry)
  }
  known.sort((left, right) => right.count - left.count || compareCodeUnits(left.id, right.id))
  catchAll.sort((left, right) => right.count - left.count || compareCodeUnits(left.id, right.id))
  return [...known, ...catchAll]
}

/**
 * 工具栏模型：按钮必须显示的字典键。
 *
 * `direction` 由**比较器用的同一个标志**推导，因此按钮永远不会宣称一个列表不在的方向
 * （这是旧仓库被用户实测反馈过的缺陷面，tests/marketplace.test.mjs 对 8 个组合逐一断言）。
 */
export interface MarketToolbarModel {
  readonly sort: MarketSort
  readonly descending: boolean
  readonly direction: SortDirection
  readonly sortOptions: readonly MarketSort[]
  readonly sortLabelKey: MarketLabelKey
  readonly directionLabelKey: MarketLabelKey
  readonly category: string
}

/**
 * 构建工具栏模型。
 *
 * @param sort - 当前模式。
 * @param descending - 当前方向（必须与传给 {@link sortRows} 的是同一个值）。
 * @param category - 当前分类（默认全部）。
 * @returns 模型。
 */
export function marketToolbarModel(sort: MarketSort, descending: boolean, category: string = ALL_CATEGORIES): MarketToolbarModel {
  return {
    sort,
    descending,
    direction: descending ? 'desc' : 'asc',
    sortOptions: SORT_MODES,
    sortLabelKey: sortLabelKey(sort),
    directionLabelKey: descending ? 'sortDesc' : 'sortAsc',
    category,
  }
}

/**
 * 是否有可用更新：已安装 + 两侧版本都可比较 + 已安装版本**严格小于**索引版本。
 *
 * 严格小于是有意的：仓库回滚（索引版本变旧）不该被报成"可更新"。
 *
 * @param item - 市场条目。
 * @returns 是否存在更新。
 */
export function updateAvailable(item: MarketItem): boolean {
  if (item.installed !== true) return false
  const installed = item.installedVersion
  const latest = item.latestVersion
  if (installed === undefined || latest === undefined) return false
  return compareVersions(installed, latest) < 0
}

/** 一个条目的标签（每次列表构建一次，作为卡片的 memo 依赖）。 */
export function tagsOf(item: MarketItem): readonly MarketTag[] {
  return buildMarketTags(item)
}

// ── 搜索（P1：只搜名称 → 搜名称 / repo / 主题 / 描述） ──────────────────────

/**
 * 一条**预备好检索**的条目：原条目 + 预计算的小写字段。
 *
 * 为什么要预备：14,000 条 × 4 字段若每键击都 toLowerCase 一遍，键击预算直接爆掉
 * （实测只搜名称时是 2.7–24 ms/键击，扩字段后 naive 版本成倍上升）。预备一次（每次列表变化一次），
 * 键击时只剩"扫一遍已小写的串"。
 */
export interface MarketSearchEntry {
  readonly item: MarketItem
  /** 输入顺序：同分时的稳定 tie-break。 */
  readonly index: number
  /** 小写名称（名称命中优先于字段命中）。 */
  readonly name: string
  /** 小写 owner/repo。 */
  readonly repo: string
  /** 小写主题。 */
  readonly topics: readonly string[]
  /** 小写描述。 */
  readonly description: string
  /** `名称\nrepo\n主题\n描述` 的小写拼接：兜底通道一次扫完。 */
  readonly haystack: string
  /** haystack 的 ASCII 字母掩码：字段通道的 O(1) 预筛。 */
  readonly mask: CharMask
  /**
   * **名称**的 ASCII 字母掩码：名称通道的 O(1) 预筛。
   *
   * 必须与 {@link mask} 分开：子序列命中要求 needle 的每个字符都出现在**名称**里，
   * 用整条 haystack 的掩码去筛几乎筛不掉什么（描述里的字符太杂），实测名称模糊那一步
   * 因此要跑 30 ms；换成名称掩码后同一批数据 2.4–4.0 ms，命中集合逐条相同。
   */
  readonly nameMask: CharMask
  /**
   * 名称是否只含 ASCII。
   *
   * 用途：中文查询时**整条名称通道可以直接跳过**（一个 CJK 查询字符不可能匹配 ASCII 名称字符，
   * 子序列必然不成立）。不跳的话每条都要跑一次 DP 并分配两行 Float64Array——实测 CJK 查询
   * 因此要 30–56 ms/键击，跳过之后降到个位数（命中集合不变：那些条目本来就命中不了名称）。
   */
  readonly nameAsciiOnly: boolean
}

/**
 * 预备检索索引（每次列表/筛选变化调用一次，**不要**放进每键击路径）。
 *
 * @param items - 已按分类/类型筛过的条目。
 * @returns 预备条目（顺序与入参一致）。
 */
export function prepareMarketSearch(items: readonly MarketItem[]): MarketSearchEntry[] {
  return items.map((item, index) => {
    const name = item.name.toLowerCase()
    const repo = item.repo.toLowerCase()
    const topics = item.topics.map((topic) => topic.toLowerCase())
    const description = item.description.toLowerCase()
    const haystack = name + '\n' + repo + '\n' + topics.join(' ') + '\n' + description
    return {
      item, index, name, repo, topics, description, haystack,
      mask: charMask(haystack), nameMask: charMask(name), nameAsciiOnly: ASCII_ONLY.test(name),
    }
  })
}

/** 只含 ASCII 的串（用于判断名称通道能否被整条跳过）。 */
const ASCII_ONLY = /^[\u0000-\u007f]*$/

/** 主题命中：短 token（≤3）只认精确相等——反向子串会让 2–3 字母主题命中一堆无关条目。 */
function topicHit(topics: readonly string[], token: string): boolean {
  if (token.length <= 3) return topics.includes(token)
  for (const topic of topics) {
    if (topic.includes(token)) return true
  }
  return false
}

/**
 * 检索条目：**名称优先**，再按字段命中（repo / 主题 / 描述）。
 *
 * 语义（每条都有独立的理由）：
 * - 空查询返回 null——排序交给调用方的排序契约，搜索不抢排序的活；
 * - 名称通道沿用 rank.ts 的有序子序列模糊匹配（前缀 → 对齐分 → 原顺序），
 *   所以英文名的行为与改动前**逐条一致**；
 * - 字段通道是**子串**匹配（不是子序列）：中文没有"子序列"概念，而中文查询在旧实现里
 *   命中数为 0（"记忆" 0 / "记忆" 在描述与主题里有 159 条）——这是本次修的核心；
 * - 权重沿用 host 侧 match.ts 的口径（名称 3 / 主题 2 / 描述 1，repo 同名称计 3）；
 * - 字段命中排在名称命中之后，并按星数降序（用户搜"memory"时，先看到名字里带 memory 的，
 *   再看到"讲 memory"的，而不是让一个 0 星长尾压过热门条目）。
 *
 * 预算（13,998 条实测，改动前后都量过）：
 * - 名称通道用**名称掩码**预筛（不是整条 haystack 的掩码）：子序列必须全部落在名称里，
 *   用 haystack 掩码几乎筛不掉东西，实测那一步要 30 ms，换名称掩码后 2.4–4.0 ms 且命中集合不变；
 * - 纯 ASCII 名称遇到 CJK 查询直接跳过名称通道（CJK 字符不可能匹配 ASCII 字符）；
 * - 字段通道每个 token 一次 includes，掩码先淘汰，命中后才做几次短串检查定位权重。
 * 合起来：ASCII 查询 1.4–3.5 ms、CJK 查询 1.6–4.1 ms（含两 token 的 "记忆 检索"）。
 *
 * @param entries - {@link prepareMarketSearch} 的产物。
 * @param query - 用户输入。
 * @returns 命中条目（已排好序）；空查询返回 null。
 */
export function searchMarket(entries: readonly MarketSearchEntry[], query: string): MarketItem[] | null {
  const trimmed = query.trim()
  if (trimmed.length === 0) return null
  const needle = trimmed.toLowerCase()
  const tokens = tokenize(trimmed)
  if (tokens.length === 0) return null
  const needleMask = charMask(needle)
  const needleAsciiOnly = ASCII_ONLY.test(needle)
  const tokenMasks = tokens.map((token) => charMask(token))

  const named: { readonly entry: MarketSearchEntry; readonly score: number; readonly prefix: boolean }[] = []
  const fielded: { readonly entry: MarketSearchEntry; readonly score: number }[] = []
  for (const entry of entries) {
    // 纯 ASCII 名称 + 含非 ASCII 的查询 → 名称通道必然空手，直接跳过（省掉一趟 DP 与两次分配）
    const nameScore = entry.nameAsciiOnly && !needleAsciiOnly
      ? null
      : fuzzyScoreLowered(entry.name, needle, entry.nameMask, needleMask)
    if (nameScore !== null) {
      named.push({ entry, score: nameScore, prefix: entry.name.startsWith(needle) })
      continue
    }
    let score = 0
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!
      const tokenMask = tokenMasks[index]!
      if (tokenMask !== 0 && (entry.mask & tokenMask) !== tokenMask) continue
      if (!entry.haystack.includes(token)) continue
      score += entry.repo.includes(token) ? 3 : topicHit(entry.topics, token) ? 2 : 1
    }
    if (score > 0) fielded.push({ entry, score })
  }

  named.sort((left, right) =>
    Number(right.prefix) - Number(left.prefix) || right.score - left.score || left.entry.index - right.entry.index)
  fielded.sort((left, right) =>
    right.score - left.score || starsOf(right.entry.item) - starsOf(left.entry.item) || left.entry.index - right.entry.index)
  return [...named.map((hit) => hit.entry.item), ...fielded.map((hit) => hit.entry.item)]
}

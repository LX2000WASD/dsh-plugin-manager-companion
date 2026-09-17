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
 *   - 未知值（stars=null / updatedAt=null / 无 category）在**默认方向**下永远排在末尾：
 *     stars / updated 默认降序，未知取最小值自然落到末尾；category 默认升序，未知显式排在
 *     有分类之后。"无星条目越位到首屏"因此不可能再发生，排序仍是"升序极化 + 单次取反"的纯形状
 *     （方向翻转时它们回到队首，那是"反转"的诚实含义）。
 */

import type { MarketItem } from './types.ts'
import { buildMarketTags, type MarketTag } from './tags.ts'
import { compareVersions } from './match.ts'

/**
 * 排序模式。
 * - `stars`：星数；`az`：名称；`updated`：最后更新；`category`：上游分类。
 */
export type MarketSort = 'stars' | 'az' | 'updated' | 'category'

/** 工具栏里的模式顺序（也是循环切换的顺序）。 */
export const SORT_MODES: readonly MarketSort[] = ['stars', 'az', 'updated', 'category']

/**
 * 每个模式的**默认方向**（切换模式时套用；用户按方向按钮可再翻转）。
 * 星数/时间读"越大越前"，名称读 A→Z，分类读 A→Z。
 */
export const SORT_DEFAULT_DESCENDING: Readonly<Record<MarketSort, boolean>> = {
  stars: true,
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

/** 卡片标签行每行放的标签数（两行是卡片的固定预算）。 */
export const TAG_SLOTS = 4
/** 卡片标签行数。 */
export const TAG_ROWS = 2
/** 卡片能显示的标签总数。 */
export const VISIBLE_TAGS = TAG_SLOTS * TAG_ROWS

/** 本模块产出的字典键（client 侧字典必须有这些键；文案不在这里硬编码）。 */
export type MarketLabelKey =
  | 'sortStars' | 'sortAz' | 'sortUpdated' | 'sortCategory'
  | 'sortAsc' | 'sortDesc' | 'filterCategory'
  | 'typeCordisPlugin' | 'typeSkill' | 'typeAgentPreset'
  | 'statusVerified' | 'statusArchived' | 'statusPending'
  | 'securityLow' | 'securityMedium' | 'securityHigh' | 'securityUnknown'

/** 模式的字典键。 */
export function sortLabelKey(sort: MarketSort): MarketLabelKey {
  switch (sort) {
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

/**
 * "+n" 徽标的数字：共享标签模型没有吐出来的主题（它按契约限量）+ 超出两行预算的标签。
 * 主题按去重后的实际数量算，重复主题不会把计数吹大。
 */
export function tagOverflowCount(tags: readonly MarketTag[], topics: readonly string[] | undefined, slots: number = VISIBLE_TAGS): number {
  const topicTotal = new Set((topics ?? [])
    .map((topic) => topic.trim().toLowerCase())
    .filter((topic) => topic.length > 0)).size
  const shownTopics = tags.reduce((count, tag) => (tag.kind === 'topic' ? count + 1 : count), 0)
  const hiddenTags = Math.max(0, tags.length - slots)
  return Math.max(0, topicTotal - shownTopics) + hiddenTags
}

/** 被两行预算挤掉的标签（client 用字典把它们拼成 title 文案）。 */
export function tagOverflowTags(tags: readonly MarketTag[], slots: number = VISIBLE_TAGS): readonly MarketTag[] {
  return tags.slice(slots)
}

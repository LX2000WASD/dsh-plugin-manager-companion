/**
 * tags.ts — 市场徽标模型与详情数据（纯函数，无 fs / 无 ctx / 无网络）。
 *
 * 归属：B 类·参考重写（旧 src/tags.ts 仅作意图参考，未复制代码）。
 * 旧实现参考：dsh-web-plugin-manager/src/tags.ts（理解意图用，未复制代码）——它解决的是"卡片上的标签
 *   按载荷顺序临时拼、顺序随实现漂移"；本模块继续承担"一处有序、去重的唯一来源"。
 * 官方复用：无（官方没有市场概念）。
 * 前提检查：**旧实现在这里被政策整体取代**（docs/private/market-tags-policy.md，task-45 全量 13,998 条实测）：
 *   1) 旧实现的 status / verification / security 三类标签**从来没有数据源**（没有上游字段可映射）；
 *   2) 政策实测出上游真正有值且值得展示的是另外几件事：风险（risk_tier，100% 覆盖）、可装性
 *      （installable，12.4%）、编辑推荐（market_tags 的 community-pick，10.2%）、归档（archived，0.6%）、
 *      分类（100%）、功能主题（过滤泛化词后 57.5% 有值）；
 *   3) 去重必须**跨来源按归一化值**做：实测 499 条（3.6%）把自己的 category 又写进 topics
 *      （liustack/modlens=vision、MemTensor/MemOS=memory…），只做来源内部去重挡不住这种"同一个词出现两次"。
 *
 * 顺序契约（重要性从高到低，渲染方按数组顺序画、绝不再排序）：
 *   risk → caution → manual → pick → archived → category → topic
 * 这份顺序就是政策 §3.2 的优先级；{@link BADGE_PRIORITY} 是它的机器可读形式。
 */

import type { MarketInstallable, MarketRiskFlag, MarketRiskTier } from './types.ts'

/** 徽标类别（按 priority 排列的顺序见 {@link BADGE_PRIORITY}）。 */
export type MarketTagKind =
  /** 上游风险等级 = risk（danger）。 */
  | 'risk'
  /** 上游风险等级 = caution（warning）。 */
  | 'caution'
  /** 上游标记需手动安装（installable = manual）。 */
  | 'manual'
  /** 上游编辑推荐（market_tags 含 community-pick）。 */
  | 'pick'
  /** 仓库已归档（archived）。 */
  | 'archived'
  /** 上游分类（兜底槽）。 */
  | 'category'
  /** 功能主题（最低优先级，最多 2 个）。 */
  | 'topic'

/** 卡片徽标的优先级契约（政策 §3.2）。 */
export const BADGE_PRIORITY: readonly MarketTagKind[] = ['risk', 'caution', 'manual', 'pick', 'archived', 'category', 'topic']

/** 与语言无关的语义色调；client 映射到官方 --dsw-* token。 */
export type MarketTagTone = 'neutral' | 'success' | 'warning' | 'danger'

/** 一个展示徽标。`value` 是原始值或数据本身，由 client 侧字典决定文案。 */
export interface MarketTag {
  readonly kind: MarketTagKind
  readonly value: string
  readonly tone: MarketTagTone
  /** 完整的、未截断的文本（title 属性用）。 */
  readonly title?: string
}

/** 卡片徽标的默认上限：政策 §4「只能显示 3 个」的最小集合就是取前三个。 */
export const TAG_SLOT_LIMIT = 3
/** 功能主题的默认上限：政策 §3.5（泛化词占 61.3%，只能当兜底槽）。 */
export const TOPIC_SLOT_LIMIT = 2

/**
 * 徽标构建器读取的字段（刻意保持窄接口）。
 *
 * 全部来自上游索引，**原样使用**：本模块不把 risk_flags 折算成分数、不把 stars 折算成质量，
 * 也不发明"可疑/推荐"这类上游没有的结论。
 */
export interface MarketTagSource {
  readonly category?: string
  readonly installable?: MarketInstallable
  readonly riskTier?: MarketRiskTier
  readonly marketTags?: readonly string[]
  readonly archived?: boolean
  readonly topics?: readonly string[]
}

/** 上游生态泛化主题词（与 registry.ts 的 ECO_GENERIC_TOPICS 同一判据：这个词能否区分两个插件）。 */
const ECO_GENERIC_TOPICS = new Set([
  'ai', 'llm', 'agent', 'agents', 'cli', 'cordis', 'cordis-plugin', 'deepseek', 'deepseek-harness',
  'dsh', 'dsh-plugin', 'dsh-plugins', 'gui', 'javascript', 'plugin', 'plugins', 'python', 'react',
  'skill', 'skills', 'tool', 'tools', 'tui', 'typescript', 'ui', 'web', 'web-ui',
])

/** 上游收录标记里的编辑推荐。 */
const COMMUNITY_PICK = 'community-pick'

/**
 * 构建一个条目的徽标列表（**按政策**：优先级取前 N、跨来源按归一化值去重）。
 *
 * @param item - 上游字段。
 * @param options - slotLimit（卡片默认 3）与 topicLimit（默认 2）。
 * @returns 按 {@link BADGE_PRIORITY} 排好的徽标；调用方**不得**再排序。
 */
export function buildMarketTags(item: MarketTagSource, options: { readonly slotLimit?: number; readonly topicLimit?: number } = {}): MarketTag[] {
  const slotLimit = Math.max(0, options.slotLimit ?? TAG_SLOT_LIMIT)
  const topicLimit = Math.max(0, options.topicLimit ?? TOPIC_SLOT_LIMIT)
  const out: MarketTag[] = []
  const seen = new Set<string>()

  /** 归一化值去重：跨来源（分类与主题同名时只留先出现的那次，即优先级更高的来源）。 */
  const push = (tag: MarketTag): void => {
    if (out.length >= slotLimit) return
    const key = tag.value.trim().toLowerCase()
    if (key.length === 0 || seen.has(key)) return
    seen.add(key)
    out.push(tag)
  }

  if (item.riskTier === 'risk') push({ kind: 'risk', value: 'risk', tone: 'danger' })
  else if (item.riskTier === 'caution') push({ kind: 'caution', value: 'caution', tone: 'warning' })

  if (item.installable === 'manual') push({ kind: 'manual', value: 'manual', tone: 'neutral' })

  if ((item.marketTags ?? []).some((tag) => tag.trim().toLowerCase() === COMMUNITY_PICK)) {
    push({ kind: 'pick', value: COMMUNITY_PICK, tone: 'success' })
  }

  if (item.archived === true) push({ kind: 'archived', value: 'archived', tone: 'warning' })

  const category = item.category?.trim()
  if (category !== undefined && category.length > 0) push({ kind: 'category', value: category, tone: 'neutral' })

  let topics = 0
  for (const raw of item.topics ?? []) {
    if (topics >= topicLimit) break
    const value = String(raw).trim()
    if (value.length === 0 || ECO_GENERIC_TOPICS.has(value.toLowerCase())) continue
    const before = out.length
    push({ kind: 'topic', value, tone: 'neutral' })
    if (out.length > before) topics += 1
  }

  return out
}

/** 徽标的稳定 key（React key / 去重标识用）。 */
export function marketTagKey(tag: MarketTag): string {
  return tag.kind + ':' + tag.value
}

/** 详情区的一项（政策 §3.1 的八项）。`key` 由 client 侧字典翻译，本模块不产出文案。 */
export interface MarketDetailItem {
  /** 稳定 key，client 据此取字典（category / topics / riskFlags / verified / license / npm / version / kind）。 */
  readonly key: string
  /** 原始值（未本地化）：分类 id、主题列表、flag 摘要、校验证据串、许可证 id、包名、版本、形态。 */
  readonly value: string
  /** 可点外链（只可能是上游给的 https 报告地址）。 */
  readonly href?: string
  readonly tone: MarketTagTone
}

/** 详情构建器读取的字段。 */
export interface MarketDetailSource extends MarketTagSource {
  readonly kind?: string
  readonly license?: string
  readonly packageName?: string
  readonly latestVersion?: string
  readonly riskFlags?: readonly MarketRiskFlag[]
  readonly reportUrl?: string
  readonly verifiedBy?: string
  readonly verifiedAt?: string
}

/** 详情里风险明细的展示上限（与 registry 的透传上限一致）。 */
const DETAIL_FLAG_LIMIT = 12
/** 详情里功能主题的展示上限（政策 §3.1：最多 8）。 */
const DETAIL_TOPIC_LIMIT = 8

/**
 * 构建详情区的条目（政策 §3.1：分类、功能主题、风险明细、验证证据（含报告外链）、许可证、npm 包名、版本、形态）。
 *
 * 顺序是"身份 → 上游结论 → 证据 → 元数据"：用户从上往下读能先看到"这是什么"，再看到"上游怎么判的"。
 * 空值一律不产出条目（详情区不留空行）。
 *
 * @param item - 上游字段 + 少量本地派生字段（kind / packageName / latestVersion）。
 * @returns 详情项；调用方按 key 取字典文案。
 */
export function buildMarketDetail(item: MarketDetailSource): MarketDetailItem[] {
  const out: MarketDetailItem[] = []
  const kind = item.kind?.trim()
  if (kind !== undefined && kind.length > 0) out.push({ key: 'kind', value: kind, tone: 'neutral' })

  const category = item.category?.trim()
  if (category !== undefined && category.length > 0) out.push({ key: 'category', value: category, tone: 'neutral' })

  const topics = (item.topics ?? [])
    .map((topic) => String(topic).trim())
    .filter((topic) => topic.length > 0 && !ECO_GENERIC_TOPICS.has(topic.toLowerCase()))
    .slice(0, DETAIL_TOPIC_LIMIT)
  if (topics.length > 0) out.push({ key: 'topics', value: topics.join(', '), tone: 'neutral' })

  if (item.riskTier !== undefined && item.riskTier !== 'safe') {
    out.push({ key: 'riskTier', value: item.riskTier, tone: item.riskTier === 'risk' ? 'danger' : 'warning' })
    const flags = (item.riskFlags ?? []).slice(0, DETAIL_FLAG_LIMIT)
    if (flags.length > 0) {
      out.push({
        key: 'riskFlags',
        value: flags.map((flag) => flag.severity.length > 0 ? flag.id + '(' + flag.severity + ')' : flag.id).join(', '),
        tone: item.riskTier === 'risk' ? 'danger' : 'warning',
      })
    }
  }

  if (item.installable === 'manual') out.push({ key: 'manual', value: 'manual', tone: 'neutral' })
  if (item.archived === true) out.push({ key: 'archived', value: 'archived', tone: 'warning' })

  // 独立校验证据：谁验的 + 何时验的 + 报告外链，三者绑成一条（政策 §3.3：不写成含糊的"已验证"）。
  if (item.verifiedBy !== undefined || item.verifiedAt !== undefined) {
    const parts = [item.verifiedBy, item.verifiedAt].filter((part): part is string => part !== undefined && part.length > 0)
    out.push({
      key: 'verified',
      value: parts.join(' · '),
      tone: 'success',
      ...(item.reportUrl === undefined ? {} : { href: item.reportUrl }),
    })
  }

  const license = item.license?.trim()
  if (license !== undefined && license.length > 0) out.push({ key: 'license', value: license, tone: 'neutral' })

  const packageName = item.packageName?.trim()
  if (packageName !== undefined && packageName.length > 0) out.push({ key: 'npm', value: packageName, tone: 'neutral' })

  const version = item.latestVersion?.trim()
  if (version !== undefined && version.length > 0) out.push({ key: 'version', value: version, tone: 'neutral' })

  return out
}

/**
 * 统计每个上游分类的条目数，返回 JSON-safe 的 Record（写进 MarketplaceResult.categories）。
 *
 * key 的插入顺序 = 分类首次出现的顺序，同一份 listing 永远产出同一份对象。
 * 分类为空的条目**不计入**任何桶——把"没分类"混进某个分类会让筛选器说谎。
 */
export function categoryCounts(items: readonly { readonly category?: string }[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of items) {
    const id = item.category?.trim()
    if (id === undefined || id.length === 0) continue
    counts[id] = (counts[id] ?? 0) + 1
  }
  return counts
}

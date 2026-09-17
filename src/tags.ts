/**
 * tags.ts — 市场条目的标签模型（纯函数，无 fs / 无 ctx / 无网络）。
 *
 * 归属：B 类·参考重写（旧 src/tags.ts 仅作意图参考，未复制代码；语义用例在 tests/tags.test.mjs 里重写）。
 * 旧实现参考：dsh-web-plugin-manager/src/tags.ts（理解意图用，未复制代码）——它解决的问题是：
 *   卡片上的标签原来是组件里按"载荷里恰好有什么字段"临时拼的，顺序随载荷漂移；
 *   上游索引给出权威分类之后，标签需要有**一处**有序、去重的唯一来源，host 与 client 共用。
 * 官方复用：无。官方没有市场概念，也没有标签模型（ui-primitives 的 Tag 只是渲染组件，
 *   由 client 侧把这里的数据喂给它）。
 * 前提检查：旧实现的两个前提仍成立（分类来自上游分类器；标签顺序 = 重要性顺序），
 *   但旧审计 m-2（docs/private/audit/correctness.md）指出 topicLimit 是"占位预算"而不是
 *   "输出数量"：被跨 kind 去重吃掉的 topic 不补位，实际输出可能少于 limit。本实现按
 *   **实际产出**计数（emit 一个才算一个），用例见 tests/tags.test.mjs。
 *
 * 顺序契约（重要性从高到低，渲染方按数组顺序画、绝不再排序）：
 *   category → type → status → verify → security → topic
 * category 打头是因为它是上游分类器给的、对每个条目都存在（不管装没装）；
 * 质量信号居中；自由主题收尾。
 */

import type { MarketItemKind } from './types.ts'

/** 标签种类，按渲染顺序排列（数组顺序即契约）。 */
export type MarketTagKind =
  /** 上游分类器 id（tool / memory / web-ui …）。 */
  | 'category'
  /** 已安装形态：plugin | skill | agent-preset（仅已安装条目）。 */
  | 'type'
  /** 策展证据状态（来源若提供）。 */
  | 'status'
  /** 第三方独立验证等级（来源若提供）。 */
  | 'verify'
  /** 自动化安全扫描结论（来源若提供）。 */
  | 'security'
  /** 功能主题（生态泛化词已在 registry.ts 里剔除）。 */
  | 'topic'

/** 渲染顺序契约的机器可读形式；buildMarketTags 的产出顺序必须与之非递减对应。 */
export const TAG_KIND_ORDER: readonly MarketTagKind[] = ['category', 'type', 'status', 'verify', 'security', 'topic']

/** 与语言无关的语义色调；client 映射到官方 --dsw-* token。 */
export type MarketTagTone = 'neutral' | 'success' | 'warning' | 'danger'

/** 一个展示标签。`value` 是原始值，由 client 侧字典决定文案。 */
export interface MarketTag {
  readonly kind: MarketTagKind
  readonly value: string
  readonly tone: MarketTagTone
  /** verify 标签的等级（1..5）；其他 kind 没有。 */
  readonly level?: number
  /** 完整的、未截断的文本（`title` 属性用）。 */
  readonly title?: string
}

/**
 * 标签构建器读取的字段（刻意保持窄接口：buildMarketTags 只依赖这些）。
 *
 * 其中 status / verification / security 目前没有数据源提供（本仓库不扩数据源），
 * 但顺序契约包含它们——契约先于数据落地，且这些 kind 的去重/预算逻辑必须可测。
 */
export interface MarketTagSource {
  readonly category?: string
  readonly installed?: boolean
  readonly kind?: MarketItemKind
  /** 策展/生命周期状态文本。 */
  readonly status?: string
  readonly verification?: { readonly level: number; readonly label: string }
  readonly security?: { readonly riskLevel: string; readonly status: string }
  readonly topics?: readonly string[]
}

/**
 * 具体安装形态；`unknown`/undefined 视为 `cordis-plugin`（本插件的市场索引本身就是
 * topic:dsh-plugin 的插件索引）。
 */
export function normalizeInstalledKind(kind: MarketItemKind | undefined): 'cordis-plugin' | 'skill' | 'agent-preset' {
  if (kind === 'skill') return 'skill'
  if (kind === 'agent-preset') return 'agent-preset'
  return 'cordis-plugin'
}

/** 策展状态 → 色调。 */
export function statusTone(status: string): MarketTagTone {
  if (status.includes('✅')) return 'success'
  if (status.toLowerCase().includes('archiv')) return 'warning'
  return 'neutral'
}

/** 风险等级 → 色调（high 与 critical 同为 danger，未知为 neutral）。 */
export function securityTone(riskLevel: string): MarketTagTone {
  const risk = riskLevel.trim().toLowerCase()
  if (risk === 'low') return 'success'
  if (risk === 'medium') return 'warning'
  if (risk === 'high' || risk === 'critical') return 'danger'
  return 'neutral'
}

/**
 * 构建一个条目的有序标签列表。
 *
 * - `topicLimit` 限制**实际产出的 topic 标签数**（默认 2）：被去重吃掉的、空白的、
 *   超出的都不占预算（旧审计 m-2 的修法）。
 * - 跨 kind 按值去重（大小写不敏感、去空白），保留**优先级更高**的那次出现：
 *   category 是 memory、topics 里也有 memory 的条目只显示 category 标签。
 * - 空/纯空白值一律丢弃。
 *
 * @param item - 标签来源字段。
 * @param options - topicLimit（默认 2）。
 * @returns 按顺序契约排好的标签；调用方**不得**再排序。
 */
export function buildMarketTags(item: MarketTagSource, options: { readonly topicLimit?: number } = {}): MarketTag[] {
  const limit = Math.max(0, options.topicLimit ?? 2)
  const out: MarketTag[] = []
  const seen = new Set<string>()

  const push = (tag: MarketTag): boolean => {
    const key = tag.value.trim().toLowerCase()
    if (key.length === 0 || seen.has(key)) return false
    seen.add(key)
    out.push(tag)
    return true
  }

  const category = item.category?.trim()
  if (category !== undefined && category.length > 0) push({ kind: 'category', value: category, tone: 'neutral' })

  if (item.installed === true) {
    push({ kind: 'type', value: normalizeInstalledKind(item.kind), tone: 'neutral' })
  }

  const status = item.status?.trim()
  if (status !== undefined && status.length > 0) {
    push({ kind: 'status', value: status, tone: statusTone(status), title: status })
  }

  if (item.verification !== undefined) {
    push({
      kind: 'verify',
      value: 'L' + String(item.verification.level),
      level: item.verification.level,
      tone: item.verification.level >= 2 ? 'success' : 'neutral',
      title: item.verification.label,
    })
  }

  if (item.security !== undefined && item.security.status !== 'skipped') {
    push({
      kind: 'security',
      value: item.security.riskLevel,
      tone: securityTone(item.security.riskLevel),
      title: item.security.status,
    })
  }

  // 主题收尾：预算是"实际产出数"，空值/重复值都不占额度（m-2）。
  let emitted = 0
  let topicTitle: string | undefined
  for (const topic of item.topics ?? []) {
    if (emitted >= limit) break
    const value = String(topic).trim()
    if (value.length === 0) continue
    if (topicTitle === undefined) topicTitle = (item.topics ?? []).join(', ')
    if (push({ kind: 'topic', value, tone: 'neutral', title: topicTitle })) emitted += 1
  }

  return out
}

/** 标签的稳定 key（React key / 去重标识用）。 */
export function marketTagKey(tag: MarketTag): string {
  return tag.kind + ':' + tag.value
}

/**
 * 统计每个上游分类的条目数，返回 JSON-safe 的 Record（写进 MarketplaceResult.categories）。
 *
 * key 的插入顺序 = 分类首次出现的顺序，因此同一份 listing 永远产出同一份对象（可比较、可缓存）。
 * 分类为空的条目**不计入**任何桶——把"没分类"混进某个分类会让筛选器说谎。
 *
 * @param items - 带可选 category 的条目。
 * @returns 分类 id → 条目数。
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

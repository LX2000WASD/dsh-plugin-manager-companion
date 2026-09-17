/**
 * rank.ts — 名称模糊打分：字符掩码预筛 + 有序子序列对齐（纯函数，无 fs / 无 ctx / 无网络）。
 *
 * 归属：B 类·参考重写（旧 src/rank.ts 只作意图参考，未复制代码；算法按官方 rankByName 的语义重写并做长名适配）。
 * 旧实现参考：dsh-web-plugin-manager/src/rank.ts（理解意图用，未复制代码）——它解决的问题是：
 *   市场的搜索框需要一个**可预测**的模糊匹配（官方设计记录明确否决了无序字符匹配与第三方
 *   fuzzy 依赖），并且 host 单测与 client bundle 必须共用同一实现，两处行为一致。
 * 官方复用：**已核查，结论是不能直接复用**。官方 @deepseek-ai/dsh-client-ui-primitives
 *   0.1.6-alpha.2 确实导出了 rankByName（lib/types/index.d.ts 有声明），但：
 *   1) 它的运行时入口 lib/index.js 在顶层 import `./Tag.module.css` 之类的 CSS Modules 与
 *      react/react-dom，从 host 进程 import 直接失败（实测 `node -e "import('@deepseek-ai/dsh-client-ui-primitives')"`
 *      → `Cannot find package 'clsx' imported from .../lib/index.js`）。本模块的目标编译位
 *      （tsconfig.host.json 的 src/*.ts）与 node 单测都在 host 侧，因此"直接复用"不可行。
 *   2) 即便在 client 侧能 import（它是平台模块），也没法两边共用：host 侧仍需要同一套打分
 *      （plugin_search 的排序与页面必须一致）。两套实现必然漂移，所以统一走本模块。
 *   3) 语义上它面向**短命令名**（首字符用全局 -index 惩罚晚起始），套到长仓库名上会累计成大负分：
 *      旧仓库实测 trmnl → dsh-terminal-panel 得 -14，反而输给 1 分的描述兜底命中。故本模块对它
 *      做了长名适配（见 fuzzyScoreLowered 的注释），这也是任务里"长名适配版"的含义。
 * 前提检查：旧实现的两条打分规则仍然成立（边界加分、连续命中加分），适配的三条被保留并显式化：
 *   首字符晚起始**有界**扣分、间隔按实际间距扣分、总分下限 1。
 *   旧 perf 审计（docs/private/audit/perf.md §8）量化了预筛收益（13k 键击 24–33ms → 1.0–9.6ms），
 *   并**实测否决**了 DP 数组缓冲复用（更慢且引入模块级可变状态），所以这里保持每次新分配的纯函数实现。
 */

/** 26 位 ASCII 字母掩码（a–z）。 */
export type CharMask = number

/** 命中（含稳定排序键）。 */
export interface FuzzyHit<T> {
  readonly item: T
  /** 输入中的原始下标：同分时按它排序，使顺序不依赖 Array.sort 的稳定性。 */
  readonly index: number
  /** 对齐分（越大越好，恒 ≥ 1）。 */
  readonly score: number
  /** 前缀命中；排序时优先于对齐分。 */
  readonly prefix: boolean
}

/**
 * 计算字符掩码：a–z 映射到 26 个 bit。
 *
 * 只覆盖 ASCII 字母，且大小写都置位（调用方通常传小写串，兼容大写是为了防误用）。
 * 非 ASCII 字符（CJK / emoji）**不进掩码**，因此掩码只会"放过"而绝不会误杀——
 * 这是它能当预筛用的前提：子序列的必要条件是字符集合的超集关系。
 *
 * @param value - 待测字符串。
 * @returns 26 位掩码。
 */
export function charMask(value: string): CharMask {
  let mask = 0
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code >= 97 && code <= 122) mask |= 1 << (code - 97)
    else if (code >= 65 && code <= 90) mask |= 1 << (code - 65)
  }
  return mask
}

/** 边界加分：命中位是名字首位，或前一个字符是分隔符（- / _）。 */
function boundaryBonus(name: string, index: number): number {
  if (index === 0) return 8
  const previous = name.charAt(index - 1)
  return previous === '-' || previous === '_' ? 8 : 0
}

/**
 * 模糊打分（大小写不敏感）。
 *
 * @param name - 候选名。
 * @param query - 用户输入。
 * @returns 对齐分（≥1）；query 不是 name 的有序子序列时返回 null（淘汰）。
 */
export function fuzzyScore(name: string, query: string): number | null {
  return fuzzyScoreLowered(name.toLowerCase(), query.toLowerCase())
}

/**
 * 预筛版打分（调用方已把小写串与掩码算好的快路径）。
 *
 * 语义：整条 needle 必须作为 haystack 的**有序子序列**出现（不分词），取最优对齐分。
 * 打分规则（对官方的长名适配）：
 * - 每个命中位给 `1 + 边界加分`；
 * - 上一个 needle 字符恰好在前一位时额外 +4（连续命中强加分）；
 * - 间隔命中按实际间距扣分（`-(间距-1)`）；
 * - 首字符晚起始的扣分**有界**（`-min(i, 6)`）——官方用无界的 `-index`，在长仓库名上会
 *   把"散落在后半段的合法命中"压成大负分，反而输给 1 分的兜底命中；
 * - 总分下限 1：名称命中恒不低于兜底命中（调用方用"描述子串 = 1 分"兜底）。
 *
 * 时间 O(n·m)，空间 O(n)；不做缓冲复用（旧 perf 审计实测复用更慢，且会引入模块级可变状态）。
 *
 * @param haystack - 候选名（调用方保证已小写）。
 * @param needle - 查询串（调用方保证已小写）。
 * @param hayMask - 可选的 {@link charMask}(haystack)：与 needleMask 同时给出时启用 O(1) 预筛。
 * @param needleMask - 可选的 {@link charMask}(needle)。掩码只做**拒绝**、不参与打分，
 *   因此传与不传的命中集合与分数逐条相同（tests/rank.test.mjs 有等价性断言）。
 * @returns 最优对齐分；不是子序列时返回 null。
 */
export function fuzzyScoreLowered(haystack: string, needle: string, hayMask?: CharMask, needleMask?: CharMask): number | null {
  const m = needle.length
  if (m === 0) return 0
  const n = haystack.length
  if (m > n) return null
  if (hayMask !== undefined && needleMask !== undefined && (hayMask & needleMask) !== needleMask) return null

  const none = Number.NEGATIVE_INFINITY
  /** 匹配到 needle 第 j 个字符、且**恰好落在**位置 i 的最优分。 */
  let previous = new Float64Array(n).fill(none)
  for (let i = 0; i < n; i += 1) {
    if (haystack.charCodeAt(i) === needle.charCodeAt(0)) {
      previous[i] = 1 + boundaryBonus(haystack, i) - Math.min(i, 6)
    }
  }
  for (let j = 1; j < m; j += 1) {
    const needleCode = needle.charCodeAt(j)
    const current = new Float64Array(n).fill(none)
    // bestGapped = max over i' < i of (previous[i'] + i')：间隔命中的来源。
    let bestGapped = none
    for (let i = 0; i < n; i += 1) {
      if (haystack.charCodeAt(i) === needleCode) {
        let score = none
        const adjacent = i > 0 ? previous[i - 1]! : none
        if (adjacent !== none) score = adjacent + 4
        if (bestGapped !== none) {
          const gapped = bestGapped - (i - 1)
          if (gapped > score) score = gapped
        }
        if (score !== none) current[i] = score + 1 + boundaryBonus(haystack, i)
      }
      const prior = previous[i]!
      if (prior !== none) {
        const shifted = prior + i
        if (shifted > bestGapped) bestGapped = shifted
      }
    }
    previous = current
  }

  let best = none
  for (let i = 0; i < n; i += 1) {
    const value = previous[i]!
    if (value > best) best = value
  }
  return best === none ? null : Math.max(best, 1)
}

/**
 * 过滤 + 排序（前缀命中 → 对齐分 → 原始下标）。
 *
 * 排序键里带 `index`，所以同分条目的顺序由输入顺序唯一决定，不依赖引擎的排序稳定性——
 * 这是"稳定全序"要求的直接落实。
 *
 * @param items - 候选条目（保持调用方给的顺序）。
 * @param nameOf - 取名称的函数（例如 `item => item.name`）。
 * @param query - 用户输入；**空白查询返回 null**（调用方走自己的默认路径，不要在这里猜测默认顺序）。
 * @returns 命中列表；查询为空时 null。
 */
export function fuzzyFilter<T>(items: readonly T[], nameOf: (item: T) => string, query: string): FuzzyHit<T>[] | null {
  const trimmed = query.trim()
  if (trimmed.length === 0) return null
  const needle = trimmed.toLowerCase()
  const needleMask = charMask(needle)
  const hits: FuzzyHit<T>[] = []
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!
    const lowered = nameOf(item).toLowerCase()
    const score = fuzzyScoreLowered(lowered, needle, charMask(lowered), needleMask)
    if (score === null) continue
    hits.push({ item, index, score, prefix: lowered.startsWith(needle) })
  }
  hits.sort((left, right) =>
    Number(right.prefix) - Number(left.prefix) || right.score - left.score || left.index - right.index)
  return hits
}

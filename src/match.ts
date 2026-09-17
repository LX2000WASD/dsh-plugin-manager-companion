/**
 * match.ts — plugin_search 的匹配纯函数：分词、加权打分、版本比较（无 fs / 无 ctx / 无网络）。
 *
 * 归属：B 类·参考重写（旧 src/match.ts 仅作意图参考，未复制代码；用例语义在 tests/marketplace.test.mjs 重写）。
 * 旧实现参考：dsh-web-plugin-manager/src/match.ts（理解意图用，未复制代码）——它解决的问题是：
 *   模型侧的自然语言查询（"帮我找记住上下文的插件"）需要一个不看 UI 的纯函数打分器，
 *   并且要能回答"这个装好的包是不是该更新了"（版本比较）。
 * 官方复用：无。官方没有市场/搜索概念；版本比较也不能用官方 plugin_manager 工具代替
 *   （它做安装，不做"哪个更新"的判断）。
 * 前提检查：旧实现的两条权重（名称 3 / 主题 2 / 描述 1）仍然成立，但旧审计 m-1
 *   （docs/private/audit/correctness.md）指出 compareVersions 对**非法 semver 宽容解析**：
 *   `1.0.0-01`（数字标识符前导零）、`1.0.0-`（空 pre）在语义上非法，旧实现却当成合法版本走
 *   数值比较，得到 `compareVersions('1.0.0-','1.0.0') === 0` 这种"非法输入等于合法版本"的结论。
 *   本实现改为：**解析失败即回退字符串比较**（结果确定、可预期，且绝不把非法输入当合法）。
 *   主题命中沿用旧实现修过的规则：短 token（≤3）只做精确匹配——旧的"反向子串"
 *   （token.includes(topic)）会让每个 2–3 字母主题命中一大堆无关条目。
 */

import type { MarketItem } from './types.ts'

/**
 * 把查询切成小写 token（字母数字 + CJK 连续段）。
 *
 * 标点/空白都当分隔符：查询是自然语言，不该要求用户记住连字符位置。
 *
 * @param query - 用户/模型输入。
 * @returns 小写 token 列表；空查询返回空数组。
 */
export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/)
    .filter((token) => token.length > 0)
}

/**
 * 一个条目对一组 token 的加权分。
 *
 * 权重：名称（display name 或 owner/repo，命中一次只计一次 3 分）/ 主题 2 分 / 描述 1 分，
 * 逐 token 累加。名称与 repo 合并计分是有意的：owner 段（如 `termanli`）也是有效信号，
 * 但同一个 token 同时命中两者不该被算成 6 分（那会让"名字里出现两次"压过真正的相关性）。
 *
 * @param item - 市场条目。
 * @param tokens - {@link tokenize} 的结果。
 * @returns 分数；0 表示不相关。
 */
export function scoreItem(item: MarketItem, tokens: readonly string[]): number {
  const name = item.name.toLowerCase()
  const repo = item.repo.toLowerCase()
  const description = item.description.toLowerCase()
  const topics = item.topics.map((topic) => topic.toLowerCase())
  let score = 0
  for (const token of tokens) {
    if (name.includes(token) || repo.includes(token)) score += 3
    if (token.length <= 3
      ? topics.includes(token)
      : topics.some((topic) => topic.includes(token))) score += 2
    if (description.includes(token)) score += 1
  }
  return score
}

/** 星数排序键：未知按 0 计（"无星"与"未知"在这里是同一个展示位置）。 */
function starsOf(item: MarketItem): number {
  return item.stars ?? 0
}

/** 名称 → repo 的两级升序比较，保证任何排序都是确定的全序。 */
function compareNames(left: MarketItem, right: MarketItem): number {
  if (left.name !== right.name) return left.name < right.name ? -1 : 1
  if (left.repo !== right.repo) return left.repo < right.repo ? -1 : 1
  return 0
}

/**
 * plugin_search 的排序：分数降序 → 星数降序 → 名称升序。
 *
 * 空查询返回**星数最高的前 limit 条**（旧行为保留：模型常问"有什么好用的插件"）。
 * 星数相同时按名称升序而不是保持输入顺序：输入顺序来自上游索引，可能与调用方无关，
 * 显式 tie-break 让同样的输入永远给出同样的答案。
 *
 * @param items - 市场条目。
 * @param query - 查询串。
 * @param limit - 返回条数上限（负数/0 视为 0）。
 * @returns 排好序的前 limit 条（不修改入参）。
 */
export function findPluginMatches(items: readonly MarketItem[], query: string, limit: number): MarketItem[] {
  const size = Math.max(0, Math.trunc(limit))
  if (size === 0) return []
  const tokens = tokenize(query)
  if (tokens.length === 0) {
    return [...items]
      .sort((left, right) => starsOf(right) - starsOf(left) || compareNames(left, right))
      .slice(0, size)
  }
  const scored: { readonly item: MarketItem; readonly score: number }[] = []
  for (const item of items) {
    const score = scoreItem(item, tokens)
    if (score > 0) scored.push({ item, score })
  }
  scored.sort((left, right) =>
    right.score - left.score || starsOf(right.item) - starsOf(left.item) || compareNames(left.item, right.item))
  return scored.slice(0, size).map((entry) => entry.item)
}

/** 解析后的版本：core 三段（已规范化，无前导零）+ 预发布标识符列表（无 pre 时为 null）。 */
interface ParsedVersion {
  readonly core: readonly string[]
  readonly pre: readonly string[] | null
}

/**
 * 严格解析（v1.2.3-rc.1 的宽松处只有"允许省略 minor/patch"和"允许 v 前缀"）。
 *
 * @param value - 版本串。
 * @returns 解析结果；不符合 semver 时 null（调用方回退字符串比较）。
 */
function parseVersion(value: string): ParsedVersion | null {
  const text = value.trim().replace(/^v/i, '')
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text)
  if (match === null) return null
  const core = [match[1]!, match[2] ?? '0', match[3] ?? '0']
  for (const part of core) {
    // 前导零在 semver 里非法（"0" 本身合法）。
    if (part.length > 1 && part.startsWith('0')) return null
  }
  let pre: string[] | null = null
  if (match[4] !== undefined) {
    pre = match[4].split('.')
    for (const identifier of pre) {
      if (identifier.length === 0) return null
      if (!/^[0-9A-Za-z-]+$/.test(identifier)) return null
      if (/^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0')) return null
    }
  }
  return { core, pre }
}

/**
 * 数字标识符比较（逐位精确，不经过 Number）。
 *
 * 输入已保证无前导零，所以"位数多的更大，位数相同按字典序"就是数值序；
 * 这个做法同时避开了超长数字标识符（如 20 位 build 号）被 Number 截断精度的问题。
 */
function compareNumericIdentifier(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  if (left === right) return 0
  return left < right ? -1 : 1
}

/** 版本串的字典序回退（确定、可预期，绝不返回 NaN）。 */
function compareStrings(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1
}

/**
 * 轻量 semver 比较。
 *
 * 语义（semver §11）：`1.2.3-rc.1 < 1.2.3`；`rc.10 > rc.9`；`1.0` / `1` 视作 `1.0.0`；
 * 预发布标识符逐个比较，**数字标识符的优先级低于字母数字**，共享前缀相同时字段少的更小
 * （alpha < alpha.1）；build metadata 不参与优先级。
 *
 * 任一侧非法（`1.0.0-01`、`1.0.0-`、`abc`）时**回退原始串比较**：
 * 非法输入不能被当成合法版本参与数值比较（旧审计 m-1）。
 *
 * @param left - 版本串。
 * @param right - 版本串。
 * @returns -1 / 0 / 1。
 */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null || b === null) return compareStrings(left, right)
  for (let index = 0; index < 3; index += 1) {
    const order = compareNumericIdentifier(a.core[index]!, b.core[index]!)
    if (order !== 0) return order
  }
  if (a.pre === null && b.pre === null) return 0
  if (a.pre === null) return 1
  if (b.pre === null) return -1
  const length = Math.max(a.pre.length, b.pre.length)
  for (let index = 0; index < length; index += 1) {
    const x = a.pre[index]
    const y = b.pre[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) return compareNumericIdentifier(x, y)
    if (xNumeric) return -1
    if (yNumeric) return 1
    return x < y ? -1 : 1
  }
  return 0
}

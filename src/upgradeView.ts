/**
 * upgradeView.ts — 升级的**纯决策**：四态怎么显示、注册面收哪些包、结果怎么读。
 *
 * 归属：A 类·重写（新模块，无旧实现可参考：旧仓库的"升级"只是一句提示文案）。
 * 旧实现参考：无（旧 dsh-web-plugin-manager 没有升级功能；其市场页只有"可更新 x.y.z"徽标）。
 * 官方复用：无。本模块**不认识 React、不认识 ctx、不联网、不读盘**——它是可独立测试的
 *   决策层（与 marketView.ts / tags.ts 同一方法论：把判定抽出来，组件只负责画）。
 * 前提检查：四态（update-available / up-to-date / unknown / not-upgradable）由 host 的
 *   upgradeCheck op 直接给出（docs/REST-CONTRACT.md「UpgradeCheckResult.units[].state 四态」），
 *   界面**直接渲染，不自己推断**。本模块只回答三个界面问题：
 *   ① 这一行该不该画、画什么；② 官方插件页的 keyed 注册面该注册哪些包名；③ 一次升级结果
 *   该被读成成功/失败/回滚/没验证。
 *
 * 为什么必须有这一层（而不是把判断写进组件）：
 *   · "靠缺席传达状态"是本仓库反复踩过的坑（DESIGN §5.5 / §12.3.3）。四态里 up-to-date
 *     与 unknown 都不画升级入口，但它们的**事实完全不同**：前者是"查过，没有更新"，
 *     后者是"查不到"。把两者的可见性判定收进一个纯函数，测试才能逐个钉住
 *     "unknown 绝不显示成已是最新"。
 *   · 注册对账（§5.5：不留孤儿 key）需要一个可断言的集合运算，而不是散在 apply 里的副作用。
 */

import type { UpgradeState } from './types.ts'

/**
 * 本模块读的单元形状（host 的 UpgradeUnitReport 是它的超集，wire 的 UpgradeUnitView 也是）。
 *
 * 刻意用结构类型而不是 import 契约类型：判定只看这几个字段，
 * 于是同一份函数既能吃 host 的原始报告（host 侧测试）也能吃归一后的视图（客户端）。
 */
export interface UpgradeUnitLike {
  readonly name: string
  readonly state: string
  readonly currentVersion: string | null
  readonly targetVersion: string | null
  readonly targetTag: string | null
  readonly tags: readonly UpgradeTagLike[] | null
  readonly source?: string
  readonly at?: string
}

// ── 四态 → 界面决策 ──────────────────────────────────────────────────────

/**
 * 升级入口的显示形态。
 *
 * 刻意做成**四态一一对应**的枚举（而不是布尔的 canUpgrade）：布尔会把
 * up-to-date 与 unknown 压成同一个 false，而那正是要防的"靠缺席传达"。
 */
export type UpgradeRowKind =
  /** 有版本事实且比当前新 → 画升级入口（tags 非空时列出让用户挑）。 */
  | 'upgrade'
  /** 有版本事实、没有更新的 → 插件页**不画**（"已是最新"的口径在市场页/关于页）。 */
  | 'hidden'
  /** 查不到版本事实 → **必须画**「查不到：<原因>」+ 重试。 */
  | 'unknown'
  /** 结构上就升不了（安装方提供的层）→ 画说明 + 命令，**不给按钮**。 */
  | 'command'

/** 状态值 → 形态（逐态显式表：新增状态时编译期就会在这里暴露，不会静默落进 default）。 */
export const ROW_KIND_OF_STATE: Readonly<Record<UpgradeState, UpgradeRowKind>> = {
  'update-available': 'upgrade',
  'up-to-date': 'hidden',
  'unknown': 'unknown',
  'not-upgradable': 'command',
}

/** 四态的稳定顺序（用于断言与文档对照，不用于渲染顺序）。 */
export const ROW_KIND_ORDER: readonly UpgradeRowKind[] = ['upgrade', 'unknown', 'command', 'hidden']

/**
 * 一个单元在界面上的形态。
 *
 * @param unit - host 给出的单元报告。
 * @returns 形态；状态值未知时按 unknown 处理（读不懂的状态不能染成"已是最新"，
 *   也不能给出一个可能无效的升级按钮）。
 */
export function rowKindOf(unit: { readonly state: string }): UpgradeRowKind {
  return ROW_KIND_OF_STATE[unit.state as UpgradeState] ?? 'unknown'
}

/**
 * 这一行是否要出现在界面上。
 *
 * 判据直接来自 DESIGN §5.5 的表格：只有 up-to-date 缺席，其余三态各自有形态。
 * 这是本模块**唯一**的可见性出口——组件不许再写一份。
 *
 * @param unit - host 给出的单元报告。
 * @returns 要画时 true。
 */
export function rowVisible(unit: { readonly state: string }): boolean {
  return rowKindOf(unit) !== 'hidden'
}

/**
 * 把一次检查结果折成"包名 → 单元"的查找表。
 *
 * 同名条目后到者不覆盖先到者：host 的 unitFacts 按名字去重过，出现重复说明契约被破坏，
 * 此时保留第一条（并让界面的计数与列表一致）比"悄悄用最后一条"更可解释。
 *
 * @param units - 检查结果的单元列表。
 * @returns 查找表。
 */
export function unitIndex<T extends { readonly name: string }>(units: readonly T[]): ReadonlyMap<string, T> {
  const index = new Map<string, T>()
  for (const unit of units) if (!index.has(unit.name)) index.set(unit.name, unit)
  return index
}

/**
 * 注册面的**目标集合**：该为哪些包名持有 plugins.bundle.config 的 key。
 *
 * 判据 = **已装** ∧ （还没查过 ∨ 这一态要显示）。两种情况都在集合里：
 *
 *   ① **还没查过**（units 为 undefined，或这一轮检查里没有这个包）→ 注册。
 *      这是必须的，而且有两个理由：
 *        · 诚实：此时界面画的是"尚未检查 + 检查按钮"，而不是一片安静——
 *          "查不到"与"没查"都必须说出来（§12.3.3：不许用缺席表达状态）；
 *        · 因果：检查正是由**行自己挂载时的 effect** 触发的（§5.5 的"进入即查"）。
 *          若先要求"查过才注册"，就永远没有东西去触发那次检查（先有鸡还是先有蛋）。
 *   ② **查过且要显示**（update-available / unknown / not-upgradable）→ 注册；
 *      **查过且 up-to-date** → 不注册，于是那个 key 的 disposer 被释放，
 *      官方 config-ledger 重算，那一节**当场消失**（§5.5 的回收纪律）。
 *
 * 与 {@link rowVisible} 分开的理由：它们回答不同的问题——"这一行要不要画"（渲染期）与
 * "这个 key 要不要注册"（装配期）。合并会让"不画"变成"不注册"，而 keyed slot 的 key
 * 一旦撤掉那一节会**当场消失**（§5.5 要的正是这个），所以两者必须能被分别断言。
 *
 * @param installed - 当前已装的包名（官方台账）。
 * @param units - 最新一次检查的单元列表；还没检查时为 undefined。
 * @param keep - 必须**保留**的包名，见下面那段。
 * @returns 要注册的包名（去重、稳定顺序：按名字排序）。
 */
export function registeredNames(
  installed: Iterable<string>,
  units: readonly { readonly name: string; readonly state: string }[] | undefined,
  /**
   * 必须**保留**的包名（即使按上面两条判据该撤掉）。
   *
   * 目前唯一的来源是"这个包有一次还没被用户处置的升级/回滚结果"。
   * 为什么这条必须存在（真机实测的缺陷，不是洁癖）：升级成功后版本事实立刻被重查，
   * 那个包通常就变成 up-to-date 了 → key 被释放 → 那一节当场消失 ——
   * **连同刚写下的结果一起消失**。用户点完升级，看到的是界面恢复原样，
   * 完全不知道刚才那次升级是成功了、失败了还是回滚了。结果必须活到用户处置为止。
   */
  keep: Iterable<string> = [],
): string[] {
  const byName = new Map<string, { readonly name: string; readonly state: string }>()
  for (const unit of units ?? []) if (!byName.has(unit.name)) byName.set(unit.name, unit)
  const kept = new Set(keep)
  const out: string[] = []
  for (const name of new Set(installed)) {
    if (kept.has(name)) { out.push(name); continue }
    const unit = byName.get(name)
    if (unit === undefined || rowVisible(unit)) out.push(name)
  }
  return out.sort()
}

// ── 版本选择（多 dist-tags）───────────────────────────────────────────────

/**
 * 默认选中的 tag。
 *
 * 口径与 host 的 pickTarget 一致（同线最新优先），但**不重算**：host 已经在
 * unit.targetTag 里给了答案，这里只是"把那个 tag 在列表里找出来"。找不到时退到
 * preferred 标记，再退到第一个——绝不返回一个不在列表里的 tag。
 *
 * @param unit - 单元报告。
 * @returns 选中的 tag 名；没有可选 tag 时 undefined（此时不给"挑版本"）。
 */
export function defaultTag(unit: {
  readonly tags: readonly UpgradeTagLike[] | null
  readonly targetTag: string | null
}): string | undefined {
  const tags = unit.tags
  if (tags === null || tags.length === 0) return undefined
  if (unit.targetTag !== null && tags.some(tag => tag.tag === unit.targetTag)) return unit.targetTag
  const preferred = tags.find(tag => tag.preferred)
  return (preferred ?? tags[0])?.tag
}

/**
 * 本模块只读 dist-tag 的这四个字段（host 的 UpgradeTag 是它的超集）。
 *
 * line 是宽松的 string：host 新增一档版本线时，界面要能如实显示，而不是被一个窄联合
 * 挡在编译期之外。判定只对 'other-line' 取真（其余一律按"同线/未知"处理，宁可少提醒一次
 * 也不谎报"会切到另一条线"）。
 */
export interface UpgradeTagLike {
  readonly tag: string
  readonly version: string
  readonly line: string
  readonly preferred: boolean
}

/**
 * 用户挑的 tag 对应的版本。
 *
 * @param unit - 单元报告。
 * @param tag - 选中的 tag 名；undefined 时用 {@link defaultTag}。
 * @returns 版本；没有可选 tag 时退回 host 给的 targetVersion。
 */
export function versionForTag(
  unit: { readonly tags: readonly UpgradeTagLike[] | null; readonly targetTag: string | null; readonly targetVersion: string | null },
  tag?: string,
): string | null {
  const tags = unit.tags
  if (tags === null || tags.length === 0) return unit.targetVersion
  const wanted = tag ?? defaultTag(unit)
  return tags.find(entry => entry.tag === wanted)?.version ?? unit.targetVersion
}

/**
 * 所选版本是不是**切到另一条线**。
 *
 * 判据用 host 给的 UpgradeTag.line，不在这里重算版本线（那是 host 的 versionLine）。
 *
 * @param unit - 单元报告。
 * @param tag - 选中的 tag 名。
 * @returns 会切到另一条线时 true。
 */
export function changesLine(
  unit: { readonly tags: readonly UpgradeTagLike[] | null; readonly targetTag: string | null },
  tag?: string,
): boolean {
  const tags = unit.tags
  if (tags === null) return false
  const wanted = tag ?? defaultTag(unit)
  return tags.find(entry => entry.tag === wanted)?.line === 'other-line'
}

/**
 * 所选版本与当前版本是否相同（相同时不给可点按钮，DESIGN §5.5）。
 *
 * @param unit - 单元报告。
 * @param tag - 选中的 tag 名。
 * @returns 相同时 true。
 */
export function sameAsCurrent(
  unit: {
    readonly tags: readonly UpgradeTagLike[] | null
    readonly targetTag: string | null
    readonly currentVersion: string | null
    readonly targetVersion: string | null
  },
  tag?: string,
): boolean {
  const current = unit.currentVersion
  if (current === null) return false
  return versionForTag(unit, tag) === current
}

/**
 * 「当前 x → y ｜ 升级」里的版本对，缺失时给 null 让界面显示"未知"而不是编一个。
 *
 * @param unit - 单元报告。
 * @param tag - 选中的 tag 名。
 * @returns 当前版本与目标版本。
 */
export function versionPair(
  unit: {
    readonly currentVersion: string | null
    readonly tags: readonly UpgradeTagLike[] | null
    readonly targetTag: string | null
    readonly targetVersion: string | null
  },
  tag?: string,
): { readonly from: string | null; readonly to: string | null } {
  return { from: unit.currentVersion, to: versionForTag(unit, tag) }
}

/**
 * 「来源与时间」这一行要显示什么。
 *
 * 契约要求界面**必须**把事实来源与时间标出来（否则"最新"这个断言没有依据）。
 * 来源未知时返回 undefined（不编一个来源出来）。
 *
 * @param unit - 单元报告。
 * @returns 来源标识与时间；来源未知时 undefined。
 */
export function sourceFacts(
  unit: { readonly source?: string; readonly at?: string },
): { readonly source: 'market-index' | 'registry'; readonly at: string | undefined } | undefined {
  if (unit.source !== 'market-index' && unit.source !== 'registry') return undefined
  return { source: unit.source, at: unit.at }
}

// ── 一次升级的结果怎么读 ──────────────────────────────────────────────────

/**
 * 升级结果的**诚实分类**。
 *
 * 这是本模块最要紧的一条：失败态绝不能被渲染成完成（task-14/18/85 那一类问题的第四次机会）。
 * 分类刻意按"用户该知道什么"切，而不是按 host 的错误码切：
 *   · done：真升级成功；
 *   · rolled-back：试装没通过 → **没有在真实环境执行升级**（host 返回 canary-not-passed）；
 *   · failed：官方通道失败或盘上核对没到位；
 *   · unverified：金丝雀**没跑**就升级了 —— "没验证"既不是通过也不是失败，
 *     它必须能被看出来（否则用户以为验证过了）。
 */
export type UpgradeOutcomeKind = 'done' | 'rolled-back' | 'failed' | 'unverified'

/**
 * 读一次升级结果。
 *
 * @param result - host 的 upgrade op 结果（已归一）。
 * @returns 分类。
 */
export function upgradeOutcome(result: {
  readonly ok: boolean
  readonly code?: string
  readonly canary?: { readonly ran: boolean; readonly conclusion?: string }
}): UpgradeOutcomeKind {
  if (!result.ok) {
    // canary-not-passed 是"没动真实环境"（试装拦下），与"升级命令失败"是两件事：
    // 前者环境没被改，后者可能改了一半。用户处置完全不同。
    return result.code === 'canary-not-passed' ? 'rolled-back' : 'failed'
  }
  return result.canary !== undefined && result.canary.ran === false ? 'unverified' : 'done'
}

/**
 * 金丝雀的读法：**"没验证"与"验证失败"必须分开**。
 *
 * @param canary - 升级结果里的金丝雀报告；没有时为 undefined。
 * @returns 四态；没有金丝雀字段时 absent（宿主没给，界面据此不宣称任何结论）。
 */
export function canaryVerdict(
  canary: { readonly ran: boolean; readonly conclusion?: string } | undefined,
): 'passed' | 'failed' | 'not-run' | 'absent' {
  if (canary === undefined) return 'absent'
  if (canary.ran === false) return 'not-run'
  return canary.conclusion === 'passed' ? 'passed' : 'failed'
}

/**
 * 这一次升级结果**能不能**回滚（task-97）。
 *
 * 两个条件同时成立才行：
 *   · **刚完成过一次升级**（`done` / `unverified`）——
 *     `rolled-back` 是"没有升级"、`failed` 是"没完成"，两者都**没有可回滚的东西**；
 *   · **知道升级前的版本**（`fromVersion` 非空）——拿不到就**不显示入口**：
 *     回滚会把环境装成那个版本，**猜不得**（§12.10：不许用推断代替事实）。
 *
 * 为什么放在这个纯决策模块（而不是组件文件里）：这样它可被单测**直接**钉住，
 * 而不是只能靠渲染结果反推。界面与测试引用同一个函数，不各写一份（写两份必然漂移）。
 *
 * @param action - 升级结果（可能没有）。
 * @returns 可以回滚时 true。
 */
/** 可回滚的升级结果：outcome 是 done/unverified，且**确实知道**升级前的版本。 */
export interface RollbackCandidate {
  readonly outcome: string
  readonly fromVersion: string
}

export function canRollback(action: {
  readonly outcome: string
  readonly fromVersion: string | null
} | undefined): action is RollbackCandidate {
  if (action === undefined) return false
  if (action.outcome !== 'done' && action.outcome !== 'unverified') return false
  return typeof action.fromVersion === 'string' && action.fromVersion.length > 0
}

/**
 * 一次升级/回滚结果里"盘上事实"是否真的对上了。
 *
 * 回滚用的是 host 的 clean（它按盘上事实核对过）；升级用的是 ok。
 * 两者都不是"我们没看到报错"——**没看到不等于核对过**。
 *
 * @param result - 升级或回滚结果。
 * @returns 核对通过时 true；载荷缺字段时 false（读不出来不算核对过）。
 */
export function diskVerified(result: { readonly ok: boolean; readonly clean?: boolean }): boolean {
  if (result.clean !== undefined) return result.clean
  return result.ok
}

// ── 市场页卡片 ────────────────────────────────────────────────────────────

/**
 * 市场卡片上要不要画「升级到 x.y.z」。
 *
 * 零新机制：用既有的 updateAvailable 判据（marketView.ts）与 latestVersion。
 * 未安装、无更新、或版本读不到时都不出现。
 *
 * @param item - 市场条目（只读它关心的字段）。
 * @param updateAvailable - marketView 的判据（注入以便复用同一份实现，不抄第二份）。
 * @returns 目标版本；不画时 undefined。
 */
export function marketUpgradeTarget<T extends { readonly installed?: boolean; readonly installedVersion?: string; readonly latestVersion?: string }>(
  item: T,
  updateAvailable: (item: T) => boolean,
): string | undefined {
  if (item.installed !== true) return undefined
  if (updateAvailable(item) !== true) return undefined
  const version = item.latestVersion
  return version === undefined || version.length === 0 ? undefined : version
}

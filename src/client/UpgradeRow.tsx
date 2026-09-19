/**
 * UpgradeRow — 官方插件页里该组合包自己的升级行（主落点，按包名注册）。
 *
 * 归属：A 类·重写（新组件；旧仓库没有升级界面）。
 * 旧实现参考：无。
 * 官方复用：官方 ui-primitives（Button / Tag / Tooltip）与官方插件页的
 *   plugins.bundle.config 槽位契约（owner props 只有 view：'summary' | 'page'）。
 * 前提检查（已核官方源码，不另找位置）：官方插件页只有三个槽位——plugins.item（list，只服务
 *   "官方"那一组）/ plugins.bundle.config（keyed by 包名）/ plugins.row.config（keyed <包名>#<行 id>）；
 *   卸载按钮与启用开关在 DetailTop 的 actions 里，**没有槽位**。所以"加在删除旁边"做不到，
 *   本组件**不做任何 DOM 注入**，只作为注册方接入官方声明的槽位。
 *
 * 四态显示规则（DESIGN §5.5，防"靠缺席传达"）：
 *   有更新      → 升级入口（多 dist-tag 时列出让用户挑，默认高亮与当前同线的最新）；
 *   已检查无更新 → 不画（由 index.ts 的注册对账把 key 撤掉，那一节当场消失）；
 *   检查失败    → **必须画**「查不到：<原因>」+ 重试，绝不显示"已是最新"；
 *   不可升级    → 说明 + 命令，**不给按钮**（安装方提供的层在 profile 内升不了）。
 *
 * view='summary' 时只给一句话：官方的卡片与详情页顶部都会渲染它。
 */

import { useEffect, useMemo, useState } from 'react'
import { Button, Tag, Tooltip, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import { PmSelect } from './pmSelect.tsx'
import { formatRelative } from './shared.ts'
import type {
  UpgradeActionResultState, UpgradeFace, UpgradeRollbackResultState, UpgradeState,
} from './shared.ts'
import type { UpgradeUnitView } from './wire.ts'
import { changesLine, defaultTag, rowKindOf, sameAsCurrent, sourceFacts, versionForTag, versionPair } from '../upgradeView.ts'
import css from './OfficialSlots.module.css'

/** 本文件里 t 的键域（本插件字典）。 */
type T = TranslateNS<typeof NS>

/** 升级行从注册项拿到的注入面（注册项自己的 face 里就有这几个动作）。 */
export type UpgradeRowActions = Pick<
  UpgradeFace,
  'ensureUpgrades' | 'loadUpgrades' | 'upgradePackage' | 'rollbackPackage' | 'dismissUpgradeNotice'
>

/**
 * 本插件自己的包名（自我升级的措辞与别人不同：正在运行的是旧代码）。
 *
 * 与 src/paths.ts 的 OUR_PACKAGE_NAME 同一个字面量。刻意不 import 那个模块：
 * 它是 host 模块（值会拉进整套 host 代码），客户端只认这个字符串。
 */
const OUR_PACKAGE = 'dsh-plugin-manager-companion'

/**
 * 注册项交给本组件的完整 props。
 *
 * `useUpgrade` 是框架从注册项 inject 的 `hooks` 隔间合成的选择器 Hook（业务组件不自己订阅，
 * 官方 slot 纪律第 4 条）；`view` 是官方页面传进来的 owner props；其余四个升级动作
 * **平铺**在这里——官方 slot 契约就是"inject 返回的成员逐项成为组件 props"，
 * 所以本类型直接继承 {@link UpgradeRowActions}，不另包一层 actions。
 */
export interface UpgradeRowProps extends UpgradeRowActions {
  readonly t: T
  readonly useUpgrade: SnapshotSelectorHook<UpgradeState>
  readonly view: 'summary' | 'page'
  /** 本行对应的包名（keyed slot 的 key）。 */
  readonly name: string
}

/**
 * 「来源与时间」这一行的文本。
 *
 * 契约要求界面把版本事实的来源与时间标出来（否则"最新"这个断言没有依据）。
 * 来源读不出来时给 undefined，界面不画这一行——不编一个来源出来。
 *
 * @param t - 字典座位。
 * @param unit - 单元视图。
 * @returns 文本；来源未知时 undefined。
 */
function sourceLine(t: T, unit: UpgradeUnitView): string | undefined {
  const facts = sourceFacts(unit)
  if (facts === undefined) return undefined
  const label = facts.source === 'market-index' ? t('upgrade.source.market') : t('upgrade.source.registry')
  return facts.at === undefined
    ? t('upgrade.source.plain', { source: label })
    : t('upgrade.source.at', { source: label, at: formatRelative(t, facts.at) })
}

/**
 * 渲染一个组合包的升级行。
 *
 * @param props - 字典座位、owner 的 view、该包的单元视图与升级动作。
 * @returns 升级行；状态为"已是最新"时返回 null（那一节由注册对账撤掉，这里再兜一层）。
 */
export function UpgradeRow({
  t, unit, checked, view, actions, busy,
}: {
  readonly t: T
  /**
   * 这一轮检查里该包的单元。
   *
   * undefined 有**两种**含义，靠 {@link checked} 分开（真机实测踩过）：
   *   · 还没查过 → 画"尚未检查更新 + 检查按钮"（"没查"也必须说出来，§12.3.3）；
   *   · 查过了但这次没有它 → 什么都不画（它已经不是这一轮的升级单元了，
   *     注册对账随后会把这个 key 撤掉；此时画"尚未检查更新"是在**编一个不存在的事实**）。
   */
  readonly unit: UpgradeUnitView | undefined
  /** 这一轮检查是否已经落定（check 有值）。 */
  readonly checked: boolean
  readonly view: 'summary' | 'page'
  readonly actions: UpgradeRowActions
  readonly busy: boolean
}) {
  // ── 所有 Hook 必须在任何提前 return **之前** ─────────────────────────────────
  //
  // 真机实测的缺陷（不是风格问题）：第一版把"还没查过"那个提前 return 写在了 Hook 前面，
  // 于是 `unit === undefined` 时组件在到达 useEffect 之前就返回了——**进入即查永远不会触发**。
  // 症状极隐蔽：行画出来了、写着"尚未检查更新"、"检查更新"按钮也在（手点能查），
  // 但用户只是**打开页面**的话它永远停在那里，而单测因为显式调了 ensureUpgrades 而全绿。
  // React 的 Hooks 规则本来就是这个意思：条件 return 必须在 Hook 之后。
  const [picked, setPicked] = useState<string | undefined>(undefined)
  const preferred = useMemo(() => (unit === undefined ? undefined : defaultTag(unit)), [unit])
  const tag = picked ?? preferred
  const name = unit?.name
  useEffect(() => { setPicked(undefined) }, [name, preferred])

  // 进入即查（DESIGN §5.5）：用户打开这个包的页面时，若本次会话还没查过就查一次。
  // 去重在控制器里（ensureUpgrades）——这一行会被反复挂载，没有去重就变成"每开一次页面出一趟网"。
  useEffect(() => { actions.ensureUpgrades() }, [actions])

  // 查过了、但这一轮里没有它 → 它不是升级单元，什么都不画（注册对账会撤掉这个 key）。
  if (unit === undefined && checked) return null

  // 还没查过：这一态必须画出来（"没查"与"查不到"都不能靠缺席表达，DESIGN §12.3.3）。
  // 上面的 effect 正在把它变成"查到了"，所以这里是一个**会自己消失的**过渡态。
  if (unit === undefined) {
    if (view === 'summary') return <p className={css.summary}>{t('upgrade.notChecked')}</p>
    return (
      <div className={css.upgrade} role="group" aria-label={t('upgrade.rowLabel')}>
        <div className={css.upgradeHead}>
          <span className={css.upgradeTitle}>{t('upgrade.title')}</span>
          <span className={css.upgradeVersions}>{t('upgrade.notChecked')}</span>
        </div>
        <div className={css.upgradeActions}>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { actions.loadUpgrades(true) }}>
            {t('upgrade.check')}
          </Button>
        </div>
      </div>
    )
  }
  const kind = rowKindOf(unit)

  if (kind === 'hidden') return null

  const pair = versionPair(unit, tag)
  const target = versionForTag(unit, tag)
  const source = sourceLine(t, unit)

  // summary 只给一句话（官方把卡片的一句话与详情页顶部都用它渲染）：
  // 有更新时说"当前 x → y"，不可升级时说"由安装方提供"，查不到时说"查不到"——
  // 三态各自可辨，**绝不**在查不到时写成"已是最新"。
  if (view === 'summary') {
    return (
      <p className={css.summary}>
        {kind === 'upgrade'
          ? t('upgrade.versions', { from: pair.from ?? t('upgrade.unknownVersion'), to: pair.to ?? t('upgrade.unknownVersion') })
          : kind === 'command'
            ? t('upgrade.installationProvided')
            : t('upgrade.unknown', { reason: unit.reason ?? t('upgrade.unknownReason') })}
      </p>
    )
  }

  const options = (unit.tags ?? []).map(entry => ({
    id: entry.tag,
    label: entry.version + ' · ' + entry.tag
      + (entry.line === 'same-line' ? t('upgrade.tag.sameLine') : entry.line === 'other-line' ? t('upgrade.tag.otherLine') : ''),
  }))
  const disabled = busy || target === null || sameAsCurrent(unit, tag)

  return (
    <div className={css.upgrade} role="group" aria-label={t('upgrade.rowLabel')}>
      <div className={css.upgradeHead}>
        <span className={css.upgradeTitle}>{t('upgrade.title')}</span>
        {kind === 'upgrade' ? <Tag tone="info">{t('upgrade.available')}</Tag> : null}
        {kind === 'unknown' ? <Tag tone="warning">{t('upgrade.unknownTag')}</Tag> : null}
        {kind === 'command' ? <Tag tone="neutral">{t('upgrade.notUpgradableTag')}</Tag> : null}
        {/*
          版本对只在"有更新"这一态出现。不可升级那一态刻意不画它：
          它的当前版本读的是 profile 的 node_modules，而安装方提供的层不在那里（读不到 = null），
          于是会渲染成「当前 未知 → 无可升目标」——真机实测这句是纯噪声，而且会与官方 chrome
          紧挨着显示的那个真实版本号（标题旁的 v0.1.6-alpha.2 Tag）自相矛盾。
          替代载体（§12.5）：版本号由官方标题旁的 Tag 承担，状态由左侧「安装方提供」Tag 承担，
          用户要做的动作由下面的说明与命令承担——一句都没少。
        */}
        {kind !== 'upgrade' ? null : (
          <span className={css.upgradeVersions}>
            {t('upgrade.versions', {
              from: pair.from ?? t('upgrade.unknownVersion'),
              to: pair.to ?? t('upgrade.unknownVersion'),
            })}
          </span>
        )}
      </div>

      {/* 有更新：多 dist-tag 时列出让用户挑；切到别的线必须明说（DESIGN §5.5 的版本选择）。 */}
      {kind !== 'upgrade' ? null : (
        <>
          {options.length <= 1 ? null : (
            <div className={css.upgradeField}>
              <PmSelect
                label={t('upgrade.versionLine')}
                placeholder={t('upgrade.versionLine')}
                value={tag ?? ''}
                options={options}
                disabled={busy}
                onChange={(id) => { setPicked(id) }}
              />
              {changesLine(unit, tag) ? <span className={css.upgradeWarn}>{t('upgrade.switchLine')}</span> : null}
            </div>
          )}
          {unit.changesSource === true ? <p className={css.upgradeNote}>{t('upgrade.changesSource')}</p> : null}
          {unit.spec === undefined ? null : <p className={css.upgradeNote}>{t('upgrade.spec', { spec: unit.spec })}</p>}
          {source === undefined ? null : <p className={css.upgradeNote}>{source}</p>}
          {unit.reason === undefined ? null : <p className={css.upgradeNote}>{unit.reason}</p>}
          <div className={css.upgradeActions}>
            <Tooltip label={t('upgrade.actionHint')}>
              <Button
                variant="primary"
                size="sm"
                disabled={disabled}
                onClick={() => {
                  if (target === null) return
                  // spec 只用于 host 侧的"会改变来源"判定与回滚目标；升级本身一律 name@version。
                  actions.upgradePackage(unit.name, target, unit.spec)
                }}
              >
                {busy ? t('upgrade.running') : t('upgrade.action', { version: target ?? t('upgrade.unknownVersion') })}
              </Button>
            </Tooltip>
          </div>
          <p className={css.upgradeNote}>{t('upgrade.effect')}</p>
        </>
      )}

      {/* 查不到：必须画出来，并给重试 —— 绝不显示"已是最新"。 */}
      {kind !== 'unknown' ? null : (
        <>
          <p className={css.upgradeWarn}>
            {t('upgrade.unknown', { reason: unit.reason ?? t('upgrade.unknownReason') })}
          </p>
          {source === undefined ? null : <p className={css.upgradeNote}>{source}</p>}
          <div className={css.upgradeActions}>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => { actions.loadUpgrades(true) }}
            >
              {t('upgrade.retry')}
            </Button>
          </div>
        </>
      )}

      {/* 安装方提供的层：说明 + 命令，不给按钮。 */}
      {kind !== 'command' ? null : (
        <>
          <p className={css.upgradeNote}>{t('upgrade.installationProvided')}</p>
          {unit.command === undefined ? null : <code className={css.upgradeCommand}>{unit.command}</code>}
          {unit.reason === undefined ? null : <p className={css.upgradeNote}>{unit.reason}</p>}
        </>
      )}
    </div>
  )
}

/**
 * 升级结果四档 → 字典键（显式表：新增一档时编译期就会在这里暴露，不会落进 default 静默显示）。
 *
 * 四档的措辞刻意不同，因为它们对用户意味着完全不同的事：
 * 完成 / **没验证** / **没升级** / 没完成。
 */
const OUTCOME_KEY = {
  done: 'upgrade.result.done',
  unverified: 'upgrade.result.unverified',
  'rolled-back': 'upgrade.result.rolledBack',
  failed: 'upgrade.result.failed',
} as const

/**
 * 把 host 给的**树状原因**切成可渲染的层次。
 *
 * 输入是 host 侧拼好的多行文本，一层一个因果，深度靠**前导空格**表达：
 *   `试装总开关已关闭` / `  → 直接升级，没有先验证` / `    → 新版本能否加载未经验证`
 *
 * 为什么要有这一层：缩进是**数据**（空格个数 = 深度），但渲染时不能只把它当普通空格——
 * 12px 字号下两个空格只有几个像素，三行看起来在同一列，"树"就没了（真机截图实测）。
 * 所以把深度解析出来，交给组件用显式 padding 画。
 *
 * 每两个空格算一层（host 侧就是这个约定）；首行无缩进 → 深度 0。
 *
 * @param note - host 给的树状原因文本。
 * @returns 逐行的文本与深度。
 */
function reasonTree(note: string): readonly { readonly text: string; readonly depth: number }[] {
  return note.split(String.fromCharCode(10))
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const indent = line.length - line.trimStart().length
      return { text: line.trimStart(), depth: Math.floor(indent / 2) }
    })
}

/**
 * host 侧那条"命令输出"表头的**字面量**（切分原文的判据）。
 *
 * 为什么抽成常量并写这么长一段注释：这个表头是**跨模块契约**——host 侧拼、客户端切。
 * task-88 把 host 侧从 '官方输出：' 改成带命令说明的新表头时**没同步改这里**，
 * 于是 `indexOf` 恒为 -1、客户端那块"命令输出 + 原始日志"静默不渲染，
 * 而单测全绿（当时没有用例覆盖"客户端真的切出了那一段"）。真机实测才发现。
 * 现在两处都引用这个名字，upgrade-ui.test.mjs 也有一条断言钉住"切得出来"。
 */
const COMMAND_OUTPUT_MARKER = '命令输出（来自升级命令）：'

/**
 * 从 host 拼好的结论原文里取出**命令输出那一段**（结构化事实之外的那一段）。
 *
 * 为什么需要它：结论原文（host 侧 src/upgrade.ts 拼的）里已经含有一份当前状态，
 * 而界面另有一份**结构化**的当前状态列表——两份说的是同一件事，整段贴出来就是重复。
 * 但原文尾部那段命令输出是结构化列表里**没有**的东西（官方通道到底说了什么），
 * 失败时它往往是唯一线索，必须留着。
 *
 * 判据是那段自带的表头（{@link COMMAND_OUTPUT_MARKER}）；找不到时返回 undefined
 * （宁可什么都不显示，也不把整段重复内容贴上来）。
 *
 * @param output - host 给的结论原文。
 * @returns 命令输出那一段；没有时 undefined。
 */
function officialTail(output: string): string | undefined {
  const at = output.indexOf(COMMAND_OUTPUT_MARKER)
  if (at < 0) return undefined
  const tail = output.slice(at + COMMAND_OUTPUT_MARKER.length).trim()
  return tail.length === 0 ? undefined : tail
}

/** 金丝雀四态 → 字典键（"没验证"与"验证失败"必须是两句不同的话）。 */
const CANARY_KEY = {
  passed: 'upgrade.canary.passed',
  failed: 'upgrade.canary.failed',
  'not-run': 'upgrade.canary.notRun',
  absent: 'upgrade.canary.absent',
} as const

/**
 * 渲染最近一次升级（或回滚）的结果。
 *
 * 这是"失败态不得渲染成完成"在界面上的落点，所以四档各有自己的措辞与色调：
 *   · done        成功（并且要说清生效时机）；
 *   · unverified  **升级了，但没验证** —— 既不是失败也不是通过，必须能看出来；
 *   · rolled-back 试装拦下：**没有升级**，真实环境没被动过；
 *   · failed      没完成（官方通道失败 / 盘上核对没对上 / 传输失败）。
 *
 * 金丝雀那一行单独给（passed / failed / not-run / absent 四态各自可辨），
 * 因为"没验证"与"验证失败"混起来就等于把风险藏了。
 *
 * @param props - 字典座位、升级结果与回滚结果、处置回调。
 * @returns 结果块；没有结果时 null。
 */
export function UpgradeResult({
  t, action, rollback, onDismiss,
}: {
  readonly t: T
  readonly action: UpgradeActionResultState | undefined
  readonly rollback: UpgradeRollbackResultState | undefined
  readonly onDismiss: () => void
}) {
  if (action === undefined && rollback === undefined) return null
  const tone: TagTone = action === undefined
    ? (rollback?.ok === true ? 'success' : 'danger')
    : action.outcome === 'done' ? 'success'
      : action.outcome === 'unverified' ? 'warning'
        : action.outcome === 'rolled-back' ? 'warning' : 'danger'
  return (
    <div className={css.upgrade} role="status" data-upgrade-outcome={action?.outcome ?? (rollback?.ok === true ? 'rollback-done' : 'rollback-failed')}>
      {action === undefined ? null : (
        <>
          <div className={css.upgradeHead}>
            <span className={css.upgradeTitle}>{t('upgrade.result.title')}</span>
            <Tag tone={tone}>{t(OUTCOME_KEY[action.outcome], {
              name: action.name,
              from: action.fromVersion ?? t('upgrade.unknownVersion'),
              to: action.toVersion,
            })}</Tag>
          </div>
          {/*
            "没验证"必须在成功路径上也说出来——它是最容易被读成"通过"的一档。
            但**只说一次**：unverified 的标题已经写了「（这次没有验证）」，再画一行
            「这次没有验证（不等于通过）」就是同一件事说两遍（§12.3.1「重复屏幕已有信息」）。
            这一条是照着真机截图改的——task-74 的一次真实升级里那句话出现了两次。
            其余三档在这里给金丝雀结论：它们与标题说的是**不同**的事（标题给结论，这行给验证状态）。
          */}
          {action.outcome === 'unverified' ? null : <p className={css.upgradeNote}>{t(CANARY_KEY[action.canary])}</p>}
          {/*
            R2（DESIGN §12.9）：原因必须**归属**，不许冒号套冒号。
            host 给的 canaryNote 是一棵**已经缩进好的树**（它自己就是多行、每行带缩进与 →），
            所以这里按行拆开、逐行原样渲染——不能塞进一个句子模板里（那会把换行压平、
            又把整棵树挤在「原因：」后面，正是用户说的"并行与分句，让人的理解很困难"）。
            R3：树里的词由 host 侧保证（金丝雀 → 试装验证），这里不做二次改写。
          */}
          {action.canaryNote === undefined ? null : (
            <div className={css.upgradeReason}>
              <p className={css.upgradeNote}>{t('upgrade.canary.reasonLabel')}</p>
              {reasonTree(action.canaryNote).map(node => (
                <p
                  key={node.text}
                  className={css.upgradeReasonLine}
                  // 层次用**显式缩进**画：前导空格的个数就是深度（host 侧一层一个因果）。
                  // 只靠 `white-space: pre-wrap` 显示两个空格太弱——真机截图里三行几乎在同一列，
                  // "树"看不出来（第一版就是这样，而且当时还被 trim 拍平过一次）。
                  style={{ paddingLeft: String(node.depth * 14) + 'px' }}
                >
                  {node.text}
                </p>
              ))}
            </div>
          )}
          {action.canaryActivated === undefined ? null : (
            <p className={css.upgradeNote}>{t(action.canaryActivated ? 'upgrade.canary.activated' : 'upgrade.canary.notActivated')}</p>
          )}
          {/* 根因链："没通过"要可追责，所以金丝雀原文原样留在下面一层。 */}
          {action.canaryOutput === undefined ? null : <pre className={css.upgradeOutput}>{action.canaryOutput}</pre>}
          {action.restartRequired ? (
            <p className={css.upgradeNote}>
              {action.name === OUR_PACKAGE ? t('upgrade.result.selfRestart') : t('upgrade.result.restart')}
            </p>
          ) : null}
          {/*
            盘上事实**只给结构化那一份**，不再把原始 output 整段贴出来。
            真机实测（task-74 的一次真实升级）：原始 output 里那段「升级前/升级后 + 依赖声明…」
            与上面的结构化列表是**同一批事实的第二遍**，而且结构更差（一行行裸文本）。
            §12.3.1「重复屏幕已有信息」：屏幕已经有的事实不再念一遍。
            原始 output 里**只在结构化列表里没有**的那部分仍然保留——官方通道的尾部输出
            （失败时它才是唯一线索），见下面的 OFFICIAL_TAIL。
          */}
          {action.diskFacts.length === 0 ? null : (
            <>
              <p className={css.upgradeNote}>{t('upgrade.result.disk')}</p>
              <ul className={css.upgradeFacts}>
                {action.diskFacts.map(fact => <li key={fact}>{fact}</li>)}
              </ul>
            </>
          )}
          {/*
            R5（DESIGN §12.9）：原始日志必须有标识。这里先给一行标识（说明它是什么、来自哪条命令），
            再贴原始输出——否则中英混杂的一堆进度行会被读者当成我们的说明。
            标识文案与 host 侧那句同源（都点明 pnpm + 官方安装通道），两处说的是同一件事。
          */}
          {officialTail(action.output) === undefined ? null : (
            <>
              <p className={css.upgradeNote}>{t('upgrade.result.commandOutput')}</p>
              <pre className={css.upgradeOutput}>{officialTail(action.output)}</pre>
            </>
          )}
        </>
      )}
      {rollback === undefined ? null : (
        <>
          <div className={css.upgradeHead}>
            <span className={css.upgradeTitle}>{t('upgrade.rollback.title')}</span>
            <Tag tone={rollback.ok ? 'success' : 'danger'}>
              {rollback.ok
                ? t('upgrade.rollback.done', {
                  name: rollback.name,
                  from: rollback.fromVersion ?? t('upgrade.unknownVersion'),
                  to: rollback.toVersion,
                })
                : t('upgrade.rollback.incomplete', { name: rollback.name })}
            </Tag>
          </div>
          <p className={css.upgradeNote}>{t(rollback.clean === true
            ? 'upgrade.rollback.clean'
            : rollback.clean === false ? 'upgrade.rollback.dirty' : 'upgrade.rollback.unknown')}</p>
          {rollback.diskFacts.length === 0 ? null : (
            <ul className={css.upgradeFacts}>
              {rollback.diskFacts.map(fact => <li key={fact}>{fact}</li>)}
            </ul>
          )}
          {officialTail(rollback.output) === undefined ? null : (
            <>
              <p className={css.upgradeNote}>{t('upgrade.result.commandOutput')}</p>
              <pre className={css.upgradeOutput}>{officialTail(rollback.output)}</pre>
            </>
          )}
        </>
      )}
      <div className={css.upgradeActions}>
        <Button variant="ghost" size="sm" onClick={onDismiss}>{t('upgrade.dismiss')}</Button>
      </div>
    </div>
  )
}

/**
 * 造一个绑定到某个包名的注册项组件。
 *
 * 为什么是工厂而不是给组件传 `name`：keyed slot 的注册项 props 由官方页面决定（只有 view），
 * 包名是本插件在注册期就知道的事实，不该指望框架传进来。工厂把 `name` 闭包进去，
 * 于是每个 key 的组件只订阅**自己那一条**单元——任何一个包的状态变化不会让别人的行重画。
 *
 * 放在本文件（.tsx）而不是 index.ts（.ts）：注册项要 JSX，而 tsconfig.client.json 的编译面
 * 只有 index.ts 及其相对 import 链，两者同属一个程序。
 *
 * @param name - 包名（也就是 keyed slot 的 key）。
 * @returns 可直接交给 ctx.slots.register 的组件。
 */
export function createUpgradeRowComponent(name: string) {
  return function UpgradeRowFor({ t, useUpgrade, view, ...actions }: Omit<UpgradeRowProps, 'name'>) {
    const unit = useUpgrade((state: UpgradeState) => state.check?.units.find(entry => entry.name === name))
    const busy = useUpgrade((state: UpgradeState) => state.busy === name)
    const checked = useUpgrade((state: UpgradeState) => state.check !== undefined)
    // 最近一次结果**只画在自己这个包的行里**：升级是逐包的动作，把 A 包的结果挂在 B 包的页面上
    // 会让用户以为 B 也被改了。result 的归属由控制器按包名记下，这里只认自己的。
    const action = useUpgrade((state: UpgradeState) => state.action?.name === name ? state.action : undefined)
    const rollback = useUpgrade((state: UpgradeState) => state.rollback?.name === name ? state.rollback : undefined)
    // 取不到单元**不代表这一节不该出现**：它有两个来源——"还没查过"（刚注册、检查在飞）
    // 与"这一轮检查里没有它"。前者必须画出来（§12.3.3），后者由注册对账把这个 key 撤掉。
    // 所以这里不做 return null 的判断，交给 UpgradeRow 自己分态（它才有 t 与字典）。
    return (
      <>
        <UpgradeRow t={t} unit={unit} checked={checked === true} view={view} busy={busy === true} actions={actions} />
        {view !== 'page' ? null : (
          <UpgradeResult
            t={t}
            action={action}
            rollback={rollback}
            onDismiss={() => { actions.dismissUpgradeNotice() }}
          />
        )}
      </>
    )
  }
}

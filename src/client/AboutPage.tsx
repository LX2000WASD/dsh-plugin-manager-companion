/**
 * AboutPage — 「关于」一级入口：关于这套软件本身的事实面板（task-95）。
 *
 * 归属：A 类·新界面（补官方没有的信息面板）。
 * 旧实现参考：无（旧 dsh-web-plugin-manager 没有信息面板）。
 * 官方复用：@deepseek-ai/dsh-client-ui-primitives（Button/Tag）；
 *   事实来自自有 REST 的 `about` op（host 侧读，客户端只渲染）。
 * 前提检查：这些事实**客户端一个都拿不到**（浏览器 bundle：无 process、无 node:fs），
 *   所以必须由 host 读经 op 下发——调研见 docs/private/task76-recon.md。
 *
 * 子页机制**复用环境控制台那一套**（tablist + roving tabindex + 声明式 store 保存选中）：
 * 本任务只落「DSH 信息」一个子页，第二个子页（软件升级）由 task-77 挂上——
 * 届时这里加一条数据即可，不新造机器。
 *
 * 硬约束（任务描述）：不复述官方侧栏已有的构建标签；不显示 token 或完整启动命令行。
 */

import { useEffect, useId, useMemo, useRef } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { defineStore, type HandleOf, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ComposedProps, EntryKeyOf, SnapshotSelectorHook, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import { formatRelative, softwareUnits, type AboutState, type UpgradeFace, type UpgradeState } from './shared.ts'
import { rowKindOf } from '../upgradeView.ts'
import { UpgradeResult, UpgradeRow } from './UpgradeRow.tsx'
import type { UpgradeUnitView } from './wire.ts'
import type { AboutFactView } from './wire.ts'
import css from './AboutPage.module.css'

/** 本文件里 t 的键域（本插件字典）。 */
type T = TranslateNS<typeof NS>

/**
 * 「关于」页的子页 store（与 createConsoleStore 同一理由与同一形状）。
 *
 * 为什么也放声明式 store：关于页只有一个子页时不明显，但 task-77 会挂上第二个
 * （软件升级）——届时"切到软件升级、被一次 store 发布弹回 DSH 信息"就会重演
 * 控制台踩过的那个缺陷（结果块被藏起来）。机制先建对，加子页只是一条数据。
 *
 * @returns 声明式 store。
 */
export function createAboutStore() {
  return defineStore({
    init: (): AboutStoreState => ({ activeId: undefined, visitedIds: [] }),
    actions: {
      /**
       * 选中一个子页并记进"已挂载"集合。
       * @param draft - store 草稿。
       * @param id - 子页 id。
       */
      select(draft, id: string) {
        draft.activeId = id
        if (!draft.visitedIds.includes(id)) draft.visitedIds = [...draft.visitedIds, id]
      },
    },
  })
}

/** 「关于」页 store 的状态形状。 */
export interface AboutStoreState {
  activeId: string | undefined
  visitedIds: readonly string[]
}

/** 「关于」页 store 的句柄类型（句柄在 apply 里创建；模块级不放句柄）。 */
export type AboutStoreHandle = ReturnType<typeof createAboutStore>

/**
 * 「关于」页的注入面：关于页自己的面 + 升级面。
 *
 * 为什么写成一个显式接口（而不是 `AboutFace & UpgradeFace`）：与
 * {@link MarketplaceConsoleFace} 同一个坑——官方 `PropsHooks` 的映射类型在**交叉类型**上
 * 推导不出 `useAbout` / `useUpgrade` 两个成员（实测编译报 "Property 'useAbout' is missing"）。
 * 一个显式的 hooks 记录把两件事说清楚，也省掉一处会被读错的类型体操。
 */
export interface AboutConsoleFace {
  hooks: {
    about: SnapshotStore<AboutState>
    upgrade: SnapshotStore<UpgradeState>
  }
  loadAbout(refresh: boolean): void
  ensureUpgrades(): void
  loadUpgrades(refresh: boolean): void
  upgradePackage(name: string, version: string, spec?: string): void
  rollbackPackage(name: string, version: string, spec?: string): void
  dismissUpgradeNotice(): void
}

/** 软件升级子页要用的升级动作（与 UpgradeRow 的入参同形）。 */
export type AboutUpgradeActions = Pick<
  UpgradeFace,
  'ensureUpgrades' | 'loadUpgrades' | 'upgradePackage' | 'rollbackPackage' | 'dismissUpgradeNotice'
>

/** 「关于」页的注册项 props（官方组合别名 + store 座位 + 本插件字典）。 */
export type AboutPageProps = ComposedProps<
  'settings.section',
  EntryKeyOf<'settings.section'>,
  never,
  HandleOf<AboutStoreHandle>,
  AboutConsoleFace,
  never,
  typeof NS
>

/** 一个子页面的定义（与 ConsolePage 同形，让加子页只是一条数据）。 */
interface AboutTab {
  readonly id: string
  readonly label: string
}

/**
 * 渲染一条事实。
 *
 * 两态**必须可区分**（§12.3.3）：
 *   · 读到了 → 值 + 来源（来源要显示，否则"这条事实怎么来的"无从判断）；
 *   · 读不到 → "未知" + 原因，**不许**用 0、空串或省略冒充。
 *
 * @param props - 字典座位、标签与事实。
 * @returns 一行事实。
 */
function FactRow({ t, label, fact, format }: {
  readonly t: T
  readonly label: string
  readonly fact: AboutFactView<string> | AboutFactView<number>
  readonly format?: (value: never) => string
}) {
  const known = 'value' in fact
  return (
    <div className={css.fact}>
      <span className={css.factLabel}>{label}</span>
      {known ? (
        <span className={css.factBody}>
          <code className={css.factValue}>
            {format === undefined ? String(fact.value) : format(fact.value as never)}
          </code>
          {fact.source === '' ? null : <span className={css.factSource}>{fact.source}</span>}
        </span>
      ) : (
        <span className={css.factBody}>
          <Tag tone="warning">{t('about.unknown')}</Tag>
          <span className={css.factReason}>{fact.unknown}</span>
        </span>
      )}
    </div>
  )
}

/**
 * 渲染 DSH 信息子页。
 *
 * @param props - 字典座位、事实与读动作。
 * @returns DSH 信息子页。
 */
function DshInfoTab({ t, facts, loading, error, errorKey, onRetry }: {
  readonly t: T
  readonly facts: AboutState['facts']
  readonly loading: boolean
  readonly error: string | undefined
  readonly errorKey: AboutState['errorKey']
  readonly onRetry: () => void
}) {
  // 失败优先于"还没读到"：读挂了却显示"还没读到"会把故障画成加载中。
  if (error !== undefined || errorKey !== undefined) {
    return (
      <p className={css.error} role="status">
        {t('about.readFailed', { message: errorKey === undefined ? error ?? t('env.unknown') : t(errorKey) })}
        <Button variant="ghost" size="sm" onClick={onRetry}>{t('about.retry')}</Button>
      </p>
    )
  }
  if (facts === undefined) {
    return <p className={css.hint} role="status">{loading ? t('about.loading') : t('about.notLoaded')}</p>
  }
  return (
    <>
      <section className={css.group}>
        <h3 className={css.groupTitle}>{t('about.group.runtime')}</h3>
        <FactRow t={t} label={t('about.dshVersion')} fact={facts.runtime.version} />
        <FactRow t={t} label={t('about.installAnchor')} fact={facts.runtime.installAnchor} />
        <FactRow t={t} label={t('about.node')} fact={facts.process.node} />
        {/*
          平台与架构**保持 Node 的英文枚举**（linux / darwin / win32 / x64 / arm64），不翻译。
          这是 Lead 复核 task-95 时的裁决，理由记在这里免得后来人当成漏翻：
          它们是 Node 的官方取值，用户拿这个值去搜索、去对官方文档时正是这几个字；
          翻成"Linux 64 位"反而让用户对不上文档。
        */}
        <FactRow t={t} label={t('about.platform')} fact={facts.process.platform} />
        <FactRow t={t} label={t('about.arch')} fact={facts.process.arch} />
      </section>
      <section className={css.group}>
        <h3 className={css.groupTitle}>{t('about.group.profile')}</h3>
        <FactRow t={t} label={t('about.profileName')} fact={facts.profile.name} />
        <FactRow t={t} label={t('about.profileDir')} fact={facts.profile.dir} />
      </section>
      <section className={css.group}>
        <h3 className={css.groupTitle}>{t('about.group.companion')}</h3>
        <FactRow t={t} label={t('about.companionVersion')} fact={facts.companion.version} />
      </section>
      <section className={css.group}>
        <h3 className={css.groupTitle}>{t('about.group.files')}</h3>
        <FactRow t={t} label={t('about.settingsPath')} fact={facts.files.settingsPath} />
        <FactRow t={t} label={t('about.registryCache')} fact={facts.files.registryCachePath} />
        {/*
          缓存年龄用相对时间：用户问的是"这份缓存多久没更新了"，不是"毫秒数是多少"。
          读不到时给原因（"还没有成功抓过索引"），**不是 0**——0 是"刚刚写过"（§12.3.3）。
        */}
        <FactRow
          t={t}
          label={t('about.registryCacheAge')}
          fact={facts.files.registryCacheAgeMs}
          format={((value: number) => formatRelative(t, new Date(Date.now() - value).toISOString())) as never}
        />
      </section>
    </>
  )
}

/**
 * 一个软件单元的卡片：类名 + 升级行 + 结果块。
 *
 * 为什么单独一个组件（而不是在 map 里内联）：结果块要按**包名**订阅
 * `state.action` / `state.rollback`，而 Hook 不能在循环里调。抽成组件后每个单元各订阅一次。
 *
 * 结果的归属由控制器按包名记下，这里只认自己的——**A 包的结果不能挂在 B 包的卡片上**
 * （那会让用户以为 B 也被改了）。
 *
 * @param props - 字典座位、单元、升级状态选择器与动作。
 * @returns 一个单元的卡片。
 */
function SoftwareUnitCard({ t, unit, useUpgrade, busy, actions }: {
  readonly t: T
  readonly unit: UpgradeUnitView
  readonly useUpgrade: SnapshotSelectorHook<UpgradeState>
  readonly busy: boolean
  readonly actions: AboutUpgradeActions
}) {
  const action = useUpgrade((state: UpgradeState) => state.action?.name === unit.name ? state.action : undefined)
  const rollback = useUpgrade((state: UpgradeState) => state.rollback?.name === unit.name ? state.rollback : undefined)
  return (
    <div className={css.unit} data-unit-kind={unit.kind}>
      {/*
        类名与**包名**各一行。
        包名必须有：官方插件页里包名由页面自己的卡片标题渲染，而这一页**没有那个 chrome**——
        少了它，用户看到的是"官方实验包 / 当前 0.2.1 → 0.3.0"，却不知道说的是哪个包。
        这条是写测试时抓到的（第一版只画了类名，测试断言包名在不在就红了）。
      */}
      <p className={css.unitKind}>{t(UNIT_KIND_KEY[unit.kind as keyof typeof UNIT_KIND_KEY] ?? 'about.unit.other')}</p>
      <p className={css.unitName}>{unit.name}</p>
      {/*
        "已是最新"这一态：官方插件页**不画这一行**（那一节的可见性由注册对账管，DESIGN §5.5 的表格）。
        但这一页没有"注册对账"那一层——卡片是我自己 map 出来的——所以必须在这里显式说出来，
        否则用户看到的是一个只有类名与包名的**空壳**。
        这条是**真机取证时抓到的**：官方实验包那一档已经是最新，卡片上只有两行标签、
        没有任何说明（单测没暴露它：既有用例都用 update-available 的单元）。

        判据用 rowKindOf（与插件页同一个出口），不另写一份可见性判断。
      */}
      {rowKindOf(unit) === 'hidden'
        ? <p className={css.hint}>{t('about.unitUpToDate')}</p>
        : (
          <>
            <UpgradeRow t={t} unit={unit} checked view="page" busy={busy} actions={actions} />
            <UpgradeResult
              t={t}
              action={action}
              rollback={rollback}
              onDismiss={() => { actions.dismissUpgradeNotice() }}
            />
          </>
        )}
    </div>
  )
}

/**
 * 渲染「软件升级」子页（task-96）。
 *
 * 范围（DESIGN §5.5 的用户裁决）：**只列这套软件本身**——① 官方运行时 ② 官方实验包 ③ 本插件自身。
 * 第三方插件不进这一页（它们的入口在官方插件页与市场页卡片）。筛选是纯函数（shared.softwareUnits），
 * 判据用 host 分好的 `kind` + 官方作用域，不在这里按包名猜。
 *
 * **复用** UpgradeRow / UpgradeResult（view='page'），不重造：
 * 那套已经承载了四态显示、dist-tags 多线选择、金丝雀四态、结果四档与自我升级措辞
 * （`upgrade.result.selfRestart`），并且有 task-74/87 的真机取证与护栏。
 * 这一页的增量只有两件：**筛选**（只留三类官方）与**总览**（检查按钮 + 上次检查时间 + 说明）。
 *
 * @param props - 字典座位、升级状态选择器、单元与动作。
 * @returns 软件升级子页。
 */
function SoftwareUpgradeTab({ t, useUpgrade, actions }: {
  readonly t: T
  readonly useUpgrade: SnapshotSelectorHook<UpgradeState>
  readonly actions: AboutUpgradeActions
}) {
  const check = useUpgrade((state: UpgradeState) => state.check)
  const loading = useUpgrade((state: UpgradeState) => state.loading)
  const error = useUpgrade((state: UpgradeState) => state.error)
  const errorKey = useUpgrade((state: UpgradeState) => state.errorKey)
  const busy = useUpgrade((state: UpgradeState) => state.busy)
  const units = useMemo<readonly UpgradeUnitView[]>(() => softwareUnits(check?.units ?? []), [check])

  // 进入即查（与插件页同一条纪律，去重在控制器里）。
  useEffect(() => { actions.ensureUpgrades() }, [actions])

  // 检查自己失败（op 挂了）：必须说出来 + 重试——**绝不**画成"已是最新"（DESIGN §5.5）。
  if (error !== undefined || errorKey !== undefined) {
    return (
      <p className={css.error} role="status">
        {t('upgrade.loadFailed', { message: errorKey === undefined ? error ?? t('env.unknown') : t(errorKey) })}
        <Button variant="ghost" size="sm" onClick={() => { actions.loadUpgrades(true) }}>{t('upgrade.retry')}</Button>
      </p>
    )
  }
  // 还没查过：这一态必须画出来（"没查"与"查不到"都不能靠缺席表达，§12.3.3）。
  if (check === undefined) {
    return (
      <p className={css.hint} role="status">
        {t('upgrade.notChecked')}
        <Button variant="ghost" size="sm" disabled={loading} onClick={() => { actions.loadUpgrades(true) }}>{t('upgrade.check')}</Button>
      </p>
    )
  }
  return (
    <>
      <div className={css.checkBar}>
        <Button variant="outline" size="sm" disabled={loading} onClick={() => { actions.loadUpgrades(true) }}>
          {loading ? t('upgrade.checking') : t('upgrade.check')}
        </Button>
        {/* 时间性（§12.9 R6）："最新"这个断言必须有时间坐标，否则读者不知道它有多新。 */}
        <span className={css.hint}>
          {check.lastCheckAt === null
            ? t('upgrade.neverChecked')
            : t('upgrade.checkedAt', { at: formatRelative(t, check.lastCheckAt) })}
        </span>
      </div>
      {check.notes.length === 0 ? null : (
        <section className={css.group}>
          <h3 className={css.groupTitle}>{t('upgrade.notes')}</h3>
          {check.notes.map(note => <p key={note} className={css.hint}>{note}</p>)}
        </section>
      )}
      {units.length === 0 ? (
        // 一个都没有也要说出来，且**不是**"已是最新"——本页范围里没有任何可检查的单元，
        // 那是"没有对象"，与"检查过了、是最新的"是两件事（§12.3.3）。
        <p className={css.hint} role="status">{t('about.software.none')}</p>
      ) : units.map(unit => (
        <SoftwareUnitCard
          key={unit.name}
          t={t}
          unit={unit}
          useUpgrade={useUpgrade}
          busy={busy === unit.name}
          actions={actions}
        />
      ))}
    </>
  )
}

/** 三类单元 → 字典键（显式表：新增一类时编译期就会在这里暴露，不会静默显示成空白）。 */
const UNIT_KIND_KEY = {
  'installation-provided': 'about.unit.installation',
  'profile-dependency': 'about.unit.experimental',
  self: 'about.unit.self',
} as const
/**
 * 渲染「关于」页。
 *
 * @param props - 字典座位、子页选择、事实与读动作。
 * @returns 带本地子页面切换的关于页。
 */
export function AboutPage({ t, useStore, actions, useAbout, loadAbout, useUpgrade, ...upgradeActions }: AboutPageProps) {
  const tabsId = useId()
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  // 子页选择来自声明式 store（与 ConsolePage 同一理由）：store 发布或条目重挂载都不能把用户弹回第一个子页。
  const activeId = useStore((state: { activeId: string | undefined; visitedIds: readonly string[] }) => state.activeId)
  const visitedIds = useStore((state: { activeId: string | undefined; visitedIds: readonly string[] }) => state.visitedIds)
  const tabs: readonly AboutTab[] = [
    { id: 'dsh', label: t('about.tab.dsh') },
    { id: 'software', label: t('about.tab.software') },
  ]
  const active = tabs.find(tab => tab.id === activeId)?.id ?? tabs[0]?.id

  const facts = useAbout((state: AboutState) => state.facts)
  const loading = useAbout((state: AboutState) => state.loading)
  const error = useAbout((state: AboutState) => state.error)
  const errorKey = useAbout((state: AboutState) => state.errorKey)

  // 进入即读（与升级面的"进入即查"同一意图）。这里**不去重**：读的是本地事实，
  // 每次进入重读更准（缓存年龄会变）；去重那套是为出网设计的。
  useEffect(() => { loadAbout(false) }, [loadAbout])

  return (
    <div className={css.page}>
      <h2 className={css.heading}>{t('about.title')}</h2>
      <div className={css.tabs} role="tablist" aria-label={t('about.tabs')}>
        {tabs.map((tab, index) => {
          const selected = tab.id === active
          return (
            <button
              key={tab.id}
              ref={(element) => { tabRefs.current[index] = element }}
              id={`${tabsId}-tab-${tab.id}`}
              type="button"
              role="tab"
              className={css.tab}
              aria-selected={selected}
              aria-controls={`${tabsId}-panel-${tab.id}`}
              data-active={selected ? 'true' : undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => { actions.select(tab.id) }}
              onKeyDown={(event) => {
                // roving tabindex：左右键在子页之间移动（官方设置页的同一交互）。
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                event.preventDefault()
                const step = event.key === 'ArrowRight' ? 1 : -1
                const nextIndex = (index + step + tabs.length) % tabs.length
                const next = tabs[nextIndex]
                if (next === undefined) return
                actions.select(next.id)
                tabRefs.current[nextIndex]?.focus()
              }}
            >
              {tab.label}
            </button>
          )
        })}
      </div>
      {tabs.map(tab => (
        <div
          key={tab.id}
          id={`${tabsId}-panel-${tab.id}`}
          className={css.panel}
          role="tabpanel"
          aria-labelledby={`${tabsId}-tab-${tab.id}`}
          hidden={tab.id !== active}
        >
          {/*
            第一个子页**始终渲染**（与 ConsolePage 同一处理）：visitedIds 只在点击时写入，
            若首屏也等它，用户打开「关于」看到的是一片空白——而这一页本该一进来就有内容。
            visitedIds 的用途是"切走之后仍然保留已挂载的页"（草稿与展开状态不丢），
            不是"首屏要不要渲染"。这条是**真机取证时抓到的**（单测因为显式调了 select 而没暴露）。
          */}
          {tab.id === tabs[0]?.id || visitedIds.includes(tab.id)
            ? tab.id === 'dsh'
              ? <DshInfoTab t={t} facts={facts} loading={loading} error={error} errorKey={errorKey} onRetry={() => { loadAbout(true) }} />
              : <SoftwareUpgradeTab t={t} useUpgrade={useUpgrade} actions={upgradeActions} />
            : null}
        </div>
      ))}
    </div>
  )
}

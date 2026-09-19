/**
 * ConsolePage — 环境控制台：一个设置入口内的三个本地子页面（体检 / 环境 / 设置）。
 *
 * 归属：A 类·重写（旧仓库把这三个能力拆在 PluginManagerSettingsTab /
 *   PluginEnvironmentsTab / PluginCatalogTab 里，且自带样式与散落文案）。
 * 旧实现参考：dsh-web-plugin-manager/src/client/*Tab.tsx（只取交互意图：健康总览、
 *   分环境卡片、分级修复；未复制代码）。
 * 官方复用：子页机制沿用官方 ui-settings-plugins 的 PluginsSettingsSection 形态
 *   （role=tablist/tab/tabpanel + 方向键导航 + 首次选中才挂载、之后隐藏保留草稿），
 *   但**选中状态放在 register 声明的 store 里**而不是组件内 useState：任何一次 store 发布或
 *   条目重挂载都会让组件内状态复位回「体检」，而结果块就在「环境」子页里（实测缺陷，见
 *   createConsoleStore 的注释）；全部控件来自 @deepseek-ai/dsh-client-ui-primitives；
 *   配置读写走官方 ctx.settingsScope（经 ConfigController 注入）。
 * 前提检查：旧实现的"官方没有管理页，所以自建"前提已消失——启停/安装/卸载交给
 *   官方通道，本页只做官方不做的事：诊断报告、多环境管理、本插件配置。
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  Button, DisclosureRow, IconChevronDownOutline14, IconDownloadOutline16,
  IconInfoOutline14, IconPlayOutline16, IconPlusOutline16, IconRefreshOutline14, IconShieldOutline16,
  IconStopFill16, IconWarningOutline16, Input, JsonTree, Menu, Modal, RiskConfirmation,
  StateDot, Switch, Tag, TerminalBlock, Toast, Tooltip,
  type MenuEntry, type TerminalBlockLabels,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { defineStore, type HandleOf } from '@deepseek-ai/dsh-client-store'
import type { ComposedProps, EntryKeyOf, SnapshotSelectorHook, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { DiagnosticGroup, DiagnosticIssue, DiagnosticLayer, ManifestField } from '../types.ts'
import { NS, type CompanionLocaleKey } from './locales.ts'
import { PmSelect } from './pmSelect.tsx'
import {
  callOp,
  DIAGNOSTIC_LABEL, LAYER_LABEL, LAYER_ORDER,
  evidenceKindOf, formatBytes, formatRelative, healthScore, issueInGroup, layerLabelKey, severityLabelKey, severityToneOf,
  type CompanionSlotProps, type ConfigFace, type ConfigState, type ConsoleFace,
  type EnvironmentsFace, type EnvironmentsState, type HealthFace, type HealthState,
  type TrialActionState, type TrialFace, type TrialState,
} from './shared.ts'
import type { TrialEnvironmentView, TrialEnvironmentsView } from './wire.ts'
import css from './ConsolePage.module.css'

/** 本文件里 t 的键域（本插件字典）。 */
type T = TranslateNS<typeof NS>

/**
 * 环境列表**已经渲染了**的 manifest 字段。
 *
 * 用可穷尽表而不是字符串字面量判断：ManifestField 联合类型一扩展，这里就编译报错，
 * 逼着实现者同时决定新字段在界面上怎么显示（而不是被 Object.hasOwn 静默吞掉）。
 */
const RENDERED_FIELDS: Record<ManifestField, true> = { bundles: true, dependencies: true }

/** 只带动作、不带 hooks 隔间的注入子面（子面板只吃自己需要的动作）。 */
type EnvironmentActions = Omit<EnvironmentsFace, 'hooks'>
type ConfigActions = Omit<ConfigFace, 'hooks'>
type TrialActions = Omit<TrialFace, 'hooks'>

/** 控制台里跨重挂载必须存活的状态。 */
export interface ConsoleStoreState {
  /** 当前子页 id；undefined = 还没选过（首屏落在第一个子页）。 */
  activeId: string | undefined
  /** 已经挂载过的子页：切回来时本地草稿、展开状态与已读报告都还在。 */
  visitedIds: readonly string[]
}

/**
 * 控制台的声明式 store（在 apply 里创建，经 register 的 store 座位交给框架）。
 *
 * 为什么必须是 store，而不是组件内 useState：控制台只有一个注册项，但它的渲染路径会被
 * **任何一次 store 发布**穿过（体检在跑时每秒都在发布），组件内状态会当场复位到第一个子页。
 * 后果很具体：用户在「环境」子页点操作、结果块就在那个子页里，页面却跳回「体检」——等于把
 * 刚发生的结果藏起来。write-auditor 5 轮里撞到 2 轮（当时未定性），client-dev 真机复现两次，
 * task-17 取证时连点 6 次「环境」都被弹回。所以这一项状态属于"跨重挂载必须存活"，
 * 按官方 slot 纪律放进声明式 store。
 */
export function createConsoleStore() {
  return defineStore({
    init: (): ConsoleStoreState => ({ activeId: undefined, visitedIds: [] }),
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

/** 控制台的 store 句柄类型（句柄在 apply 里创建；模块级不放句柄）。 */
export type ConsoleStoreHandle = ReturnType<typeof createConsoleStore>

/** 环境控制台的注册项 props（官方组合别名 + store 座位 + 本插件字典）。 */
export type ConsolePageProps = ComposedProps<
  'settings.section',
  EntryKeyOf<'settings.section'>,
  never,
  HandleOf<ConsoleStoreHandle>,
  ConsoleFace,
  never,
  typeof NS
>

/** 一个子页面的定义。 */
interface ConsoleTab {
  readonly id: string
  readonly label: string
}

/**
 * 渲染环境控制台。
 *
 * @param props - 框架绑定的五个 share（owner / 注入面 / 字典座位等）。
 * @returns 带本地子页面切换的控制台。
 */
export function ConsolePage({
  t, useStore, actions, useHealth, useEnvironments, useConfig, useTrial,
  diagnose, fix, setDiagnosticTarget, refreshEnvironments, startEnvironment, stopEnvironment,
  createEnvironment, renameEnvironment, removeEnvironment, copyPlugins, exportBackup, loadBackup,
  diffBackup, restoreBackup, dismissEnvironmentNotice, editConfigField, saveConfig, discardConfig,
  loadTrial, removeTrialEnvironment, cleanupTrialEnvironments,
}: ConsolePageProps) {
  const tabsId = useId()
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  // 子页选择来自声明式 store：store 发布与条目重挂载都不会把它复位（缺陷背景见 createConsoleStore）。
  const activeId = useStore(state => state.activeId)
  const visitedIds = useStore(state => state.visitedIds)
  const tabs: readonly ConsoleTab[] = [
    { id: 'health', label: t('console.tab.health') },
    { id: 'env', label: t('console.tab.env') },
    { id: 'settings', label: t('console.tab.settings') },
  ]
  const active = tabs.find(tab => tab.id === activeId)?.id ?? tabs[0]?.id

  // 子页面只在首次选中时挂载，之后隐藏着保留：切换 tab 不丢表单草稿、展开状态与已读报告。
  // "选中即记入 visited"由 store 的 select action 一次做完（不靠 effect，避免首屏时序差）。

  const environmentActions: EnvironmentActions = {
    refreshEnvironments, startEnvironment, stopEnvironment, createEnvironment, renameEnvironment,
    removeEnvironment, copyPlugins, exportBackup, loadBackup, diffBackup, restoreBackup,
    dismissEnvironmentNotice,
  }
  const configActions: ConfigActions = { editConfigField, saveConfig, discardConfig }
  const trialActions: TrialActions = { loadTrial, removeTrialEnvironment, cleanupTrialEnvironments }

  return (
    <div className={css.page}>
      <h2 className={css.heading}>{t('console.title')}</h2>
      <div className={css.tabs} role="tablist" aria-label={t('console.tabs')}>
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
                let nextIndex: number
                switch (event.key) {
                  case 'ArrowRight': nextIndex = (index + 1) % tabs.length; break
                  case 'ArrowLeft': nextIndex = (index - 1 + tabs.length) % tabs.length; break
                  case 'Home': nextIndex = 0; break
                  case 'End': nextIndex = tabs.length - 1; break
                  default: return
                }
                event.preventDefault()
                const next = tabs[nextIndex] as ConsoleTab
                actions.select(next.id)
                tabRefs.current[nextIndex]?.focus()
              }}
            >
              {tab.label}
            </button>
          )
        })}
      </div>
      {tabs.filter(tab => tab.id === active || visitedIds.includes(tab.id)).map((tab) => (
        <div
          key={tab.id}
          id={`${tabsId}-panel-${tab.id}`}
          className={css.panel}
          role="tabpanel"
          aria-labelledby={`${tabsId}-tab-${tab.id}`}
          hidden={tab.id !== active}
        >
          {tab.id === 'health'
            ? (
              <HealthPanel
                t={t}
                useHealth={useHealth}
                useEnvironments={useEnvironments}
                diagnose={diagnose}
                fix={fix}
                setDiagnosticTarget={setDiagnosticTarget}
                refreshEnvironments={refreshEnvironments}
              />
            )
            : tab.id === 'env'
              ? <EnvironmentsPanel t={t} useEnvironments={useEnvironments} actions={environmentActions} />
              : (
                <ConfigPanel
                  t={t}
                  useConfig={useConfig}
                  useTrial={useTrial}
                  actions={configActions}
                  trialActions={trialActions}
                />
              )}
        </div>
      ))}
    </div>
  )
}

/**
 * 体检子页的 props。
 *
 * 体检面板同时需要环境面：诊断目标选择器的数据源是 listEnvironments，而"哪个环境是当前
 * 环境"这个事实只能从这里读到（诊断接口本身只认环境名，不回答"谁在运行"）。
 */
interface HealthPanelProps {
  readonly t: T
  readonly useHealth: SnapshotSelectorHook<HealthState>
  readonly useEnvironments: SnapshotSelectorHook<EnvironmentsState>
  readonly diagnose: HealthFace['diagnose']
  readonly fix: HealthFace['fix']
  readonly setDiagnosticTarget: HealthFace['setDiagnosticTarget']
  readonly refreshEnvironments: EnvironmentsFace['refreshEnvironments']
}

/** 组摘要里最多平铺几个作用域标签（其余折进 Tooltip，避免一行被包名挤爆）。 */
const MAX_SCOPE_TAGS = 4

/** 处置等级 → 展开图标（可自动修复用盾牌，需确认用警告，只报告用信息）。 */
const SEVERITY_ICON = {
  'safe-fix': <IconShieldOutline16 />,
  'confirm-fix': <IconWarningOutline16 />,
  'report-only': <IconInfoOutline14 />,
} as const

/** 一条发现的卡片 props（体检页与分组视图共用）。 */
interface IssueRowProps {
  readonly t: T
  readonly issue: DiagnosticIssue
  readonly open: boolean
  readonly confirming: boolean
  readonly fixing: boolean
  /** 有别的修复在跑时禁用本行的按钮。 */
  readonly busy: boolean
  /** 目标不是当前环境：不提供修复（官方写通道只覆盖当前环境）。 */
  readonly foreign: boolean
  readonly onToggle: () => void
  readonly onFix: () => void
  readonly onConfirm: () => void
}

/**
 * 渲染一条发现的卡片：标题 + 等级/层/类别标签，展开后有说明、涉及对象、证据链与修复按钮。
 *
 * @param props - 字典座位、这一条发现的状态与三个回调。
 * @returns 一条发现的卡片。
 */
function IssueRow({
  t, issue, open, confirming, fixing, busy, foreign, onToggle, onFix, onConfirm,
}: IssueRowProps) {
  const severityKey = severityLabelKey(issue.severity)
  const layerKey = layerLabelKey(issue.layer)
  return (
    <li className={css.issue}>
      <DisclosureRow
        icon={SEVERITY_ICON[issue.severity] ?? <IconInfoOutline14 />}
        title={issue.title}
        open={open}
        expandable
        expandOnRowClick
        onToggle={onToggle}
        collapsedContent={(
          <span className={css.issueMeta}>
            {severityKey === undefined
              ? <Tag tone="quiet">{issue.severity}</Tag>
              : <Tag tone={severityToneOf(issue.severity)}>{t(severityKey)}</Tag>}
            {layerKey === undefined
              ? <Tag tone="quiet">{issue.layer}</Tag>
              : <Tag tone="quiet">{t(layerKey)}</Tag>}
            <code className={css.issueCode}>{issue.code}</code>
          </span>
        )}
      >
        <div className={css.issueBody}>
          <p className={css.issueDetail}>{issue.detail}</p>
          {issue.subjects.length === 0 ? null : (
            <p className={css.subjects}>
              <span className={css.metaLabel}>{t('health.subjects')}</span>
              {issue.subjects.map(subject => <Tag key={subject} tone="neutral">{subject}</Tag>)}
            </p>
          )}
          <div className={css.evidenceBlock}>
            <span className={css.metaLabel}>{t('health.evidence')}</span>
            <ul className={css.evidence}>
              {issue.evidence.map((item, index) => (
                <li key={`${issue.id}-${String(index)}`} className={css.evidenceRow}>
                  <Tag tone="quiet">{evidenceKindOf(item.kind)}</Tag>
                  <code className={css.evidenceAt}>{item.at}</code>
                  <span className={css.evidenceNote}>{item.note}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className={css.issueActions}>
            {foreign || issue.fix === undefined
              ? <Tag tone="quiet">{t('health.reportOnly')}</Tag>
              : (
                <>
                  {/* 改什么必须不悬停就看得见：这是知情同意的一部分。 */}
                  <span className={css.fixSummary}>{issue.fix.summary}</span>
                  <Button
                    className={css.fixButton}
                    variant={issue.severity === 'safe-fix' ? 'primary' : 'outline'}
                    size="sm"
                    disabled={fixing || busy}
                    onClick={() => {
                      if (issue.severity === 'safe-fix' || confirming) {
                        onFix()
                        return
                      }
                      onConfirm()
                    }}
                  >
                    {fixing
                      ? t('health.fixing')
                      : issue.severity === 'safe-fix'
                        ? t('health.fixSafe')
                        : confirming ? t('common.confirm') : t('health.fixConfirm')}
                  </Button>
                </>
              )}
          </div>
        </div>
      </DisclosureRow>
    </li>
  )
}

/** 一组同类发现在界面上的桶：组本身 + 属于它的条目（按真实渲染条数计数）。 */
interface IssueBucket {
  readonly group: DiagnosticGroup
  readonly items: readonly DiagnosticIssue[]
}

/**
 * 渲染「体检」子页：健康分、各层计数、问题卡片（证据可展开）与分级修复按钮。
 *
 * @param props - 字典座位、报告选择器与诊断/修复动作。
 * @returns 体检面板。
 */
function HealthPanel({
  t, useHealth, useEnvironments, diagnose, fix, setDiagnosticTarget, refreshEnvironments,
}: HealthPanelProps) {
  const report = useHealth(state => state.report)
  const running = useHealth(state => state.running)
  const error = useHealth(state => state.error)
  const errorKey = useHealth(state => state.errorKey)
  const fixingId = useHealth(state => state.fixingId)
  const notice = useHealth(state => state.notice)
  const failureFrom = useHealth(state => state.failureFrom)
  const capabilities = useHealth(state => state.capabilities)
  const target = useHealth(state => state.target)
  const environments = useEnvironments(state => state.environments)
  const loadingEnvironments = useEnvironments(state => state.loading)
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set())
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set())
  const [confirmingId, setConfirmingId] = useState<string>()
  const [toast, setToast] = useState<{ text: string; seq: number }>()
  const requestedEnvironments = useRef(false)

  const issues = report?.issues ?? []
  /**
   * 层 → 该层"根本没查"的原因。
   *
   * 判据只用引擎显式给出的 `skip.layers`：层归属是引擎的事实，客户端按 check 字符串形状去猜
   * 是隐式耦合，引擎一改名就会静默退回"显示 0"——正好把"没查画成没问题"带回来。
   * 非层级跳过（install-anchor 等）不设 layers，因此不会把任何格子标成未查。
   */
  const skippedLayers = useMemo(() => {
    const map = new Map<DiagnosticLayer, string[]>()
    for (const skip of report?.skipped ?? []) {
      for (const layer of skip.layers ?? []) {
        map.set(layer, [...(map.get(layer) ?? []), skip.reason])
      }
    }
    return map
  }, [report])
  const groups = report?.groups ?? []
  const score = useMemo(() => healthScore(issues), [issues])
  // 当前环境名：profile 列表是唯一权威；列表还没读到时退到官方能力探针给的名字。
  const current = environments.find(environment => environment.current)?.name
    ?? capabilities?.environmentName
    ?? undefined
  // "非当前环境"判定：target 为 undefined 就是当前环境；否则按名字比对。
  const foreign = target !== undefined && target !== current

  // 选择器的数据源：环境列表；列表还没读到（或读失败）时至少给出当前环境。
  const environmentOptions = useMemo(() => {
    const list = environments.map(environment => ({
      id: environment.name,
      // 选项只给名字：「是不是当前环境」由选择器旁的标记承载（用户反馈：控件内部别再拼一遍）。
      label: environment.name,
    }))
    if (list.length > 0) return list
    return current === undefined ? [] : [{ id: current, label: current }]
  }, [environments, current, t])

  // 体检页先挂载（它是第一个子页），所以由它来补一次环境列表——只补一次，
  // 失败也不重试（重试会形成 loading 翻转的死循环），失败原因由环境子页自己报。
  useEffect(() => {
    if (requestedEnvironments.current || environments.length > 0 || loadingEnvironments) return
    requestedEnvironments.current = true
    refreshEnvironments()
  }, [environments.length, loadingEnvironments, refreshEnvironments])

  useEffect(() => { if (notice !== undefined && notice !== '') setToast({ text: notice, seq: Date.now() }) }, [notice])
  // 落地即体检：这一页存在的意义就是这份报告，但只在没有报告时自动跑一次。
  useEffect(() => { if (report === undefined) diagnose() }, [diagnose, report])
  // 报告换了环境就丢掉属于上一份报告的局部状态（展开的发现、待确认的修复）。
  // 诊断目标不同 = 事实不同，沿用上一份的交互状态是跨环境串味。
  const reportEnvironment = report?.environment
  useEffect(() => {
    setOpenIds(new Set())
    setOpenGroups(new Set())
    setConfirmingId(undefined)
  }, [reportEnvironment])

  // 分组视图：host 把同层同码同级的命中折成组，这里按**契约字段**把条目分回组里
  // （issueInGroup 不重算组键）。落不进任何组的发现进"未归入任何组"，一条都不丢。
  // 组的折叠状态默认收起：163 条同类命中先看到一行，而不是 163 行。
  const { buckets, rest } = useMemo(() => {
    if (groups.length === 0) return { buckets: [] as IssueBucket[], rest: [] as DiagnosticIssue[] }
    const claimed = new Set<string>()
    const list = groups.map((group): IssueBucket => ({
      group,
      items: issues.filter((issue) => {
        if (claimed.has(issue.id) || !issueInGroup(issue, group)) return false
        claimed.add(issue.id)
        return true
      }),
    }))
    return { buckets: list, rest: issues.filter(issue => !claimed.has(issue.id)) }
  }, [groups, issues])

  const toggleIssue = (id: string): void => {
    setOpenIds((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleGroup = (key: string): void => {
    setOpenGroups((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const renderIssue = (issue: DiagnosticIssue) => (
    <IssueRow
      key={issue.id}
      t={t}
      issue={issue}
      open={openIds.has(issue.id)}
      confirming={confirmingId === issue.id}
      fixing={fixingId === issue.id}
      busy={fixingId !== undefined}
      foreign={foreign}
      onToggle={() => { toggleIssue(issue.id) }}
      onFix={() => { setConfirmingId(undefined); fix(issue) }}
      onConfirm={() => { setConfirmingId(issue.id) }}
    />
  )

  return (
    <section className={css.section}>
      <div className={css.rowBetween}>
        <h3 className={css.sectionTitle}>{t('health.title')}</h3>
        <Button
          variant="outline"
          size="sm"
          icon={<IconRefreshOutline14 />}
          disabled={running}
          onClick={() => { diagnose() }}
        >
          {running ? t('health.refreshing') : report === undefined ? t('health.refresh') : t('health.runAgain')}
        </Button>
      </div>
      {/* health.intro 的渲染点已删（层名就在下面逐个显示，属"重复屏幕已有信息"）；
          字典键留给 copy-dev 在 task-47 统一收口，这里不删键。 */}
      <div className={css.fieldRow}>
        <span className={css.metaLabel}>{t('health.target')}</span>
        <PmSelect
          label={t('health.target')}
          placeholder={t('env.selectEnv')}
          value={target ?? current ?? ''}
          options={environmentOptions}
          onChange={(id) => {
            // 选中当前环境即回到默认语义（undefined），这样"当前环境"只有一个表示法。
            setDiagnosticTarget(id === current ? undefined : id)
          }}
        />
        {/*
          "这个目标是不是当前环境"必须**被说出来**，不能靠"没有标记"传达（缺席不是表达）。
          两边都有标记：当前环境用中性色（它不是问题），其他环境用 warning + 只读（那是后果）。
        */}
        {foreign ? (
          <>
            <Tag tone="warning">{t('health.foreignTag')}</Tag>
            {/* 标记而不是句子：目标不是当前环境时，本页的结论与操作都是只读的。 */}
            <Tag tone="neutral">{t('common.readOnly')}</Tag>
          </>
        ) : <Tag tone="neutral">{t('env.current')}</Tag>}
      </div>
      {/* 这里原本还有两块："诊断目标：{name}"（选择器已经显示着这个值）与
          "修改请到「环境」子页。"（目标入口在子页标签里可见可点，属于"指路"而不是可执行出路）。
          两块都按用户第三轮反馈删掉；"不是当前环境 + 只读"由选择器旁的两个标记承载。 */}
      {error === undefined && errorKey === undefined ? null : (
        <p className={css.error} role="status">
          {/*
            归因直接读控制器写下的显式字段（failureFrom）。绝不用"notice 写过没有"这种间接线索：
            修复抛异常的那条路径不写 notice，间接判据会把"修复失败"说成"体检失败"（真机实测的 P1）。
          */}
          {t(failureFrom === 'fix' ? 'health.fixFailed' : 'health.failed',
            { message: errorKey === undefined ? error ?? '' : t(errorKey) })}
        </p>
      )}
      {capabilities === undefined || capabilities.missing.length === 0 ? null : (
        <div className={css.capabilities} role="status">
          <span className={css.metaLabel}>{t('health.capabilities')}</span>
          <ul className={css.diffList}>
            {capabilities.missing.map(reason => <li key={reason} className={css.warn}>{reason}</li>)}
          </ul>
        </div>
      )}
      {report === undefined
        ? (running ? <p className={css.hint}>{t('health.refreshing')}</p> : <p className={css.hint}>{t('health.needRun')}</p>)
        : (
          <>
            <div className={css.scoreCard}>
              <Tooltip label={t('health.scoreHint')}>
                <span className={css.scoreLabel}>{t('health.score')}</span>
              </Tooltip>
              <span className={css.score}>{score}</span>
              <span className={css.scoreMeta}>
                <span>
                  {/* 只留"报告属于谁"这一件事；"不是当前环境"由选择器旁的标记承载，同一屏不重复。 */}
                  {t('health.environment', { name: report.environment })}
                </span>
                <span>{t('health.generatedAt', { at: formatRelative(t, report.generatedAt) })}</span>
              </span>
            </div>
            <div className={css.layerGrid}>
              {LAYER_ORDER.map((layer) => {
                // 计数缺失按 0 显示：这一格只是总览，不该让缺一个字段的载荷毁掉整页。
                const count = report.counts[layer] ?? 0
                const skipReasons = skippedLayers.get(layer)
                return (
                  <div key={layer} className={css.layerCell}>
                    <span className={css.layerName}>{t(LAYER_LABEL[layer])}</span>
                    {skipReasons === undefined ? (
                      <Tag tone={count === 0 ? 'quiet' : 'warning'}>{String(count)}</Tag>
                    ) : (
                      <span className={css.layerSkipped}>
                        {/* 有计数也有跳过：数字照给，但不能只给数字——那会被读成"查完了"。 */}
                        {count === 0 ? null : <Tag tone="warning">{String(count)}</Tag>}
                        <Tooltip label={skipReasons.join(' · ')}>
                          <Tag tone="neutral">{t('health.layerSkipped')}</Tag>
                        </Tooltip>
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
            {issues.length === 0 ? <p className={css.ok} role="status">{t('health.empty')}</p> : null}
            {groups.length === 0 ? (
              <ul className={css.issues}>{issues.map(renderIssue)}</ul>
            ) : (
              <>
                <p className={css.hint} role="status">
                  {t('health.grouped', { groups: groups.length, count: issues.length })}
                </p>
                {buckets.map(bucket => (
                  <section key={bucket.group.key} className={css.group}>
                    <DisclosureRow
                      icon={SEVERITY_ICON[bucket.group.severity] ?? <IconInfoOutline14 />}
                      title={bucket.group.exampleTitle ?? bucket.group.code}
                      open={openGroups.has(bucket.group.key)}
                      expandable
                      expandOnRowClick
                      onToggle={() => { toggleGroup(bucket.group.key) }}
                      collapsedContent={(
                        <span className={css.issueMeta}>
                          <Tag tone="warning">{t('health.groupCount', { count: bucket.items.length })}</Tag>
                          <Tag tone={severityToneOf(bucket.group.severity)}>
                            {t(severityLabelKey(bucket.group.severity) ?? 'severity.report-only')}
                          </Tag>
                          <code className={css.issueCode}>{bucket.group.code}</code>
                          {bucket.group.scopes.slice(0, MAX_SCOPE_TAGS).map(entry => (
                            <Tag key={entry.scope} tone="neutral">{entry.scope}</Tag>
                          ))}
                          {bucket.group.scopes.length <= MAX_SCOPE_TAGS ? null : (
                            <Tooltip label={bucket.group.scopes.map(entry => entry.scope).join(' · ')}>
                              <span className={css.metaLabel}>
                                {t('health.groupMoreScopes', { count: bucket.group.scopes.length - MAX_SCOPE_TAGS })}
                              </span>
                            </Tooltip>
                          )}
                        </span>
                      )}
                    >
                      <ul className={css.issues}>{bucket.items.map(renderIssue)}</ul>
                    </DisclosureRow>
                  </section>
                ))}
                {rest.length === 0 ? null : (
                  <details className={css.jsonDetails}>
                    <summary className={css.jsonSummary}>{t('health.groupRest', { count: rest.length })}</summary>
                    <ul className={css.issues}>{rest.map(renderIssue)}</ul>
                  </details>
                )}
              </>
            )}
            {report.skipped.length === 0 ? null : (
              <div className={css.skipped}>
                <span className={css.metaLabel}>{t('health.skipped')}</span>
                <ul className={css.evidence}>
                  {report.skipped.map(skip => (
                    <li key={skip.check} className={css.evidenceRow}>
                      <code className={css.evidenceAt}>{skip.check}</code>
                      <span className={css.evidenceNote}>{skip.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      {toast === undefined ? null : (
        <Toast key={toast.seq} text={toast.text} onDone={() => { setToast(undefined) }} />
      )}
    </section>
  )
}

/**
 * 官方模板清单的投影（op `environmentTemplates`）。
 *
 * 模板名与层栈都来自官方 PROFILE_TEMPLATES，客户端**不维护模板表**：抄一份名字表迟早与
 * 官方漂移，而漂移的后果实测过——留空的模板会建出一个没有 web 层、必然起不来的环境。
 */
interface EnvironmentTemplateList {
  /** 官方默认模板（后端给，不是客户端猜的）。 */
  readonly default: string
  readonly templates: readonly {
    readonly name: string
    readonly bundles: readonly string[]
  }[]
}

/** 环境卡片上可用的对话框。 */
type EnvironmentDialog =
  | { readonly kind: 'none' }
  | { readonly kind: 'create' }
  | { readonly kind: 'rename'; readonly name: string }
  | { readonly kind: 'remove'; readonly name: string }
  | { readonly kind: 'copy'; readonly name: string }

/** 行内操作菜单：官方 Menu 是受控的（open 由调用方持有），所以每行自带一个开关。 */
function RowMenu({ label, items, onSelect }: {
  readonly label: string
  readonly items: readonly MenuEntry[]
  readonly onSelect: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Menu
      open={open}
      items={items}
      portal
      anchor={(
        <Tooltip label={label}>
          <Button
            variant="ghost"
            size="sm"
            aria-label={label}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => { setOpen(previous => !previous) }}
          >
            <IconChevronDownOutline14 />
          </Button>
        </Tooltip>
      )}
      onSelect={(id) => { setOpen(false); onSelect(id) }}
      onClose={() => { setOpen(false) }}
    />
  )
}

/** 环境子页的 props。 */
interface EnvironmentsPanelProps {
  readonly t: T
  readonly useEnvironments: SnapshotSelectorHook<EnvironmentsState>
  readonly actions: EnvironmentActions
}

/**
 * 渲染「环境」子页：环境列表（运行状态/端口）、启停、新建、重命名、删除、复制插件、
 * 备份导出/导入/差异/恢复。
 *
 * @param props - 字典座位、环境状态选择器与环境动作。
 * @returns 环境面板。
 */
function EnvironmentsPanel({ t, useEnvironments, actions }: EnvironmentsPanelProps) {
  const environments = useEnvironments(state => state.environments)
  const loading = useEnvironments(state => state.loading)
  const busy = useEnvironments(state => state.busy)
  const error = useEnvironments(state => state.error)
  const errorKey = useEnvironments(state => state.errorKey)
  const notice = useEnvironments(state => state.notice)
  const backup = useEnvironments(state => state.backup)
  const diff = useEnvironments(state => state.diff)
  const [dialog, setDialog] = useState<EnvironmentDialog>({ kind: 'none' })
  const [draftName, setDraftName] = useState('')
  const [draftTemplate, setDraftTemplate] = useState('')
  const [templates, setTemplates] = useState<EnvironmentTemplateList>()
  const [templateError, setTemplateError] = useState<string>()
  const [copyTarget, setCopyTarget] = useState('')
  const [copyNames, setCopyNames] = useState('')
  const [exportTarget, setExportTarget] = useState('')
  const [restoreTarget, setRestoreTarget] = useState('')
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [toast, setToast] = useState<{ text: string; seq: number }>()
  const fileInput = useRef<HTMLInputElement | null>(null)
  const refresh = actions.refreshEnvironments

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => { if (notice !== undefined && notice !== '') setToast({ text: notice, seq: Date.now() }) }, [notice])

  const targets = useMemo(
    () => environments.map(environment => ({ id: environment.name, label: environment.name })),
    [environments],
  )
  const terminalLabels: TerminalBlockLabels = {
    signal: signal => t('trace.signal', { signal }),
    exitCode: code => t('trace.exitCode', { exitCode: code }),
    noExitCode: t('trace.noExitCode'),
    running: t('trace.running'),
    failed: t('trace.failed'),
    done: t('trace.done'),
    copy: t('trace.copy'),
    copied: t('trace.copied'),
    noOutput: t('trace.noOutput'),
    collapseAria: t('trace.collapseAria'),
    collapse: t('trace.collapse'),
    expandAria: hidden => t('trace.expandAria', { hidden }),
    expand: hidden => t('trace.expand', { hidden }),
  }

  const closeDialog = (): void => { setDialog({ kind: 'none' }) }

  /**
   * 打开新建对话框，并按需读一次官方模板清单（只读、读完缓存）。
   *
   * 清单读不到时不猜模板名：创建请求省掉 `template` 字段，由后端落到官方默认模板
   * （能起得来的那个），并在这里如实说明清单没读到。
   */
  const openCreate = (): void => {
    setDraftName('')
    setDialog({ kind: 'create' })
    if (templates !== undefined) return
    void (async () => {
      try {
        const list = await callOp<EnvironmentTemplateList>('environmentTemplates', {})
        setTemplates(list)
        setDraftTemplate(list.default)
        setTemplateError(undefined)
      } catch (loadError) {
        setTemplateError(loadError instanceof Error ? loadError.message : String(loadError))
      }
    })()
  }

  const selectedTemplate = templates?.templates.find(template => template.name === draftTemplate)

  return (
    <section className={css.section}>
      <div className={css.rowBetween}>
        <h3 className={css.sectionTitle}>{t('env.title')}</h3>
        <div className={css.rowActions}>
          <Button
            variant="outline"
            size="sm"
            icon={<IconRefreshOutline14 />}
            disabled={loading}
            onClick={() => { refresh() }}
          >
            {loading ? t('common.loading') : t('env.refresh')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            icon={<IconPlusOutline16 />}
            onClick={() => { openCreate() }}
          >
            {t('env.create')}
          </Button>
        </div>
      </div>
      <p className={css.hint}>{t('env.intro')}</p>
      {busy === undefined ? null : <p className={css.hint} role="status">{t('env.busy', { name: busy })}</p>}
      {error === undefined && errorKey === undefined ? null : (
        <p className={css.error} role="status">
          {t('env.failed', { message: errorKey === undefined ? error ?? '' : t(errorKey) })}
        </p>
      )}
      {environments.length === 0 && loading ? <p className={css.hint} role="status">{t('common.loading')}</p> : null}
      {environments.length === 0 && !loading ? <p className={css.hint}>{t('env.empty')}</p> : null}
      <ul className={css.envList}>
        {environments.map((environment) => {
          const running = environment.runs.length > 0
          const unknownFields = environment.unknownFields ?? []
          const runsUnknown = environment.runsKnown === false
          const bundlesUnknown = unknownFields.includes('bundles')
          const dependenciesUnknown = unknownFields.includes('dependencies')
          // 两栏之外的字段名：闭集下不该出现，但"host 知道的事实被客户端悄悄丢掉"与"把不知道说成知道"
          // 是同一枚硬币的两面，所以这里留一行兜底而不是忽略（见 env.factsIncomplete）。
          const unmapped = unknownFields.some(field => !Object.hasOwn(RENDERED_FIELDS, field))
          // 原因一行：认不出来的未知用兜底文案，被映射字段的未知直接给原因；都没有就整行不渲染。
          const unknownLine = bundlesUnknown || dependenciesUnknown || unmapped
            ? environment.unknownReason === undefined
              ? undefined
              : unmapped
                ? t('env.factsIncomplete', { reason: environment.unknownReason })
                : environment.unknownReason
            : undefined
          const menuItems: readonly MenuEntry[] = [
            { id: 'start-background', label: t('env.startBackground'), disabled: running },
            { id: 'rename', label: t('env.rename') },
            { id: 'copy', label: t('env.copy'), disabled: environment.dependencies.length === 0 && environment.bundles.length === 0 },
            { id: 'backup', label: t('env.backupExport') },
            { type: 'separator', id: 'sep' },
            { id: 'remove', label: t('env.remove'), danger: true, disabled: environment.current || environment.builtin },
          ]
          return (
            <li key={environment.name} className={css.envCard}>
              <div className={css.envHead}>
                <StateDot state={running ? 'done' : 'idle'} />
                <span className={css.envName}>{environment.name}</span>
                {environment.current ? <Tag tone="info">{t('env.current')}</Tag> : null}
                {environment.builtin ? <Tag tone="neutral">{t('env.builtin')}</Tag> : null}
                {/*
                  运行栏也要区分"确实没在运行"与"我看不见进程表"：后者显示 未知，
                  显示成"未运行"就是把"我不知道"说成"确实没有"（与层栈那两栏同一类误读）。
                */}
                {runsUnknown
                  ? <Tag tone="warning">{t('env.unknown')}</Tag>
                  : <Tag tone={running ? 'success' : 'quiet'}>{running ? t('env.running') : t('env.stopped')}</Tag>}
              </div>
              <div className={css.envMeta}>
                <code className={css.envDir}>{environment.dir}</code>
                {/*
                  两栏各自判断：这份 manifest 里这个字段读不读得出来。读不出来显示「未知」，
                  读得出来才显示数字——把"我不知道"说成"0 个"是这一整轮在消除的假事实。
                  两栏互不串味：只有一个字段读不出来时，另一栏必须照常给真实数字。
                */}
                {bundlesUnknown
                  ? <Tag tone="warning">{t('env.unknown')}</Tag>
                  : <span>{t('env.bundles', { count: environment.bundles.length })}</span>}
                {dependenciesUnknown
                  ? <Tag tone="warning">{t('env.unknown')}</Tag>
                  : <span>{t('env.dependencies', { count: environment.dependencies.length })}</span>}
                {unknownLine === undefined ? null : <span className={css.envUnknownReason}>{unknownLine}</span>}
                {/* 进程事实不可读的原因：可见文本，不挂 title。 */}
                {runsUnknown && environment.runsUnknownReason !== undefined
                  ? <span className={css.envUnknownReason}>{environment.runsUnknownReason}</span>
                  : null}
                {environment.runs.map(run => (
                  <span key={run.pid} className={css.envRun}>
                    {t('env.pid', { pid: run.pid })}
                    {run.port === null ? '' : ` · ${t('env.port', { port: run.port })}`}
                  </span>
                ))}
              </div>
              <div className={css.envActions}>
                {running ? (
                  <Button
                    variant="outline"
                    size="sm"
                    icon={<IconStopFill16 />}
                    disabled={busy !== undefined}
                    onClick={() => { actions.stopEnvironment(environment.name) }}
                  >
                    {t('env.stop')}
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    icon={<IconPlayOutline16 />}
                    disabled={busy !== undefined}
                    onClick={() => { actions.startEnvironment(environment.name, false) }}
                  >
                    {t('env.start')}
                  </Button>
                )}
                <RowMenu
                  label={`${t('env.more')}: ${environment.name}`}
                  items={menuItems}
                  onSelect={(id) => {
                    switch (id) {
                      case 'start-background': actions.startEnvironment(environment.name, true); break
                      case 'rename': setDraftName(environment.name); setDialog({ kind: 'rename', name: environment.name }); break
                      case 'copy': setCopyTarget(''); setCopyNames(''); setDialog({ kind: 'copy', name: environment.name }); break
                      case 'backup': actions.exportBackup(environment.name); break
                      case 'remove': setDialog({ kind: 'remove', name: environment.name }); break
                      default: break
                    }
                  }}
                />
              </div>
            </li>
          )
        })}
      </ul>

      <div className={css.backupCard}>
        <h4 className={css.cardTitle}>{t('env.backupSection')}</h4>
        <div className={css.backupRow}>
          <PmSelect
            label={t('env.backupExport')}
            placeholder={t('env.selectEnv')}
            value={exportTarget}
            options={targets}
            onChange={(id) => { setExportTarget(id) }}
          />
          <Button
            variant="outline"
            size="sm"
            icon={<IconDownloadOutline16 />}
            disabled={busy !== undefined || exportTarget === ''}
            onClick={() => { actions.exportBackup(exportTarget) }}
          >
            {t('env.backupExport')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => { fileInput.current?.click() }}>
            {t('env.backupImport')}
          </Button>
          <input
            ref={fileInput}
            className={css.fileInput}
            type="file"
            accept="application/json,.json"
            aria-label={t('env.backupImport')}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file !== undefined) actions.loadBackup(file)
              event.target.value = ''
            }}
          />
        </div>
        {backup === undefined ? <p className={css.hint}>{t('env.backupNone')}</p> : (
          <>
            <p className={css.hint}>{t('env.backupLoaded', { name: backup.environment, at: formatRelative(t, backup.exportedAt) })}</p>
            <div className={css.backupRow}>
              <PmSelect
                label={t('env.backupTarget')}
                placeholder={t('env.selectEnv')}
                value={restoreTarget}
                options={targets}
                onChange={(id) => { setRestoreTarget(id) }}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={restoreTarget === '' || busy !== undefined}
                onClick={() => { actions.diffBackup(restoreTarget) }}
              >
                {t('env.backupDiff')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={restoreTarget === '' || busy !== undefined}
                onClick={() => { setAcknowledged(false); setRestoreOpen(true) }}
              >
                {t('env.backupRestore')}
              </Button>
            </div>
            <details className={css.jsonDetails}>
              <summary className={css.jsonSummary}>{t('env.backupInspect')}</summary>
              <JsonTree
                data={backup as unknown as Record<string, unknown>}
                label={t('env.backupSection')}
                copyable
                expandTopLevel
                labels={{
                  copyValue: t('json.copyValue'),
                  copyJson: t('json.copyJson'),
                  copyPath: t('json.copyPath'),
                  copyPrettyJson: t('json.copyPretty'),
                  copyCompactJson: t('json.copyCompact'),
                  copied: t('json.copied'),
                  copyFailed: t('json.copyFailed'),
                  collapseNode: t('json.collapseNode'),
                  expandNode: t('json.expandNode'),
                  copyButtonTitle: action => t('json.copyButtonTitle', { action }),
                }}
              />
            </details>
          </>
        )}
        {diff === undefined ? null : (
          <div className={css.diff}>
            <span className={css.metaLabel}>{t('env.diffTitle')}</span>
            {diff.ok ? <p className={css.ok} role="status">{t('env.diffOk')}</p> : (
              <p className={css.warn} role="status">{t('env.diffConfirm')}</p>
            )}
            {diff.missing.length === 0 ? null : (
              <div className={css.diffGroup}>
                <span className={css.metaLabel}>{t('env.diffMissing')}</span>
                <ul className={css.diffList}>
                  {diff.missing.map(entry => (
                    <li key={entry.name} className={css.diffRow}>
                      <code className={css.evidenceAt}>{entry.name}</code>
                      <span className={css.evidenceNote}>{entry.source}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {diff.bundlesMissing.length === 0 ? null : (
              <div className={css.diffGroup}>
                <span className={css.metaLabel}>{t('env.diffBundlesMissing')}</span>
                <p className={css.diffRow}>{diff.bundlesMissing.map(bundle => <Tag key={bundle} tone="quiet">{bundle}</Tag>)}</p>
              </div>
            )}
            {diff.missingProfiles.length === 0 ? null : (
              <div className={css.diffGroup}>
                <span className={css.metaLabel}>{t('env.diffMissingProfiles')}</span>
                <p className={css.diffRow}>{diff.missingProfiles.map(profile => <Tag key={profile} tone="quiet">{profile}</Tag>)}</p>
              </div>
            )}
            {diff.unrestorable.length === 0 ? null : (
              <div className={css.diffGroup}>
                <span className={css.metaLabel}>{t('env.diffUnrestorable')}</span>
                <ul className={css.diffList}>
                  {diff.unrestorable.map(item => <li key={item} className={css.evidenceNote}>{item}</li>)}
                </ul>
              </div>
            )}
            {diff.already.length === 0 ? null : (
              <details className={css.jsonDetails}>
                <summary className={css.jsonSummary}>{t('env.diffAlready', { count: diff.already.length })}</summary>
                <p className={css.diffRow}>{diff.already.map(name => <Tag key={name} tone="neutral">{name}</Tag>)}</p>
              </details>
            )}
          </div>
        )}
        {notice === undefined || notice === '' ? null : (
          <TerminalBlock
            command={busy ?? t('env.notice')}
            output={notice}
            exitCode={error === undefined && errorKey === undefined ? 0 : 1}
            labels={terminalLabels}
          />
        )}
      </div>

      <Modal
        open={dialog.kind === 'create'}
        onClose={closeDialog}
        title={t('env.createTitle')}
        description={t('env.createHint')}
        closeLabel={t('common.close')}
        footer={(
          <>
            <Button variant="ghost" size="md" onClick={closeDialog}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              size="md"
              disabled={draftName.trim() === ''}
              onClick={() => {
                const template = draftTemplate.trim()
                actions.createEnvironment(draftName.trim(), template === '' ? undefined : template)
                closeDialog()
              }}
            >
              {t('env.doCreate')}
            </Button>
          </>
        )}
      >
        <label className={css.field}>
          <span className={css.metaLabel}>{t('env.name')}</span>
          <Input value={draftName} onChange={(event) => { setDraftName(event.target.value) }} aria-label={t('env.name')} />
        </label>
        <div className={css.field}>
          <span className={css.metaLabel}>{t('env.template')}</span>
          <PmSelect
            label={t('env.template')}
            placeholder={t('env.templateAuto')}
            value={draftTemplate}
            options={(templates?.templates ?? []).map(template => ({ id: template.name, label: template.name }))}
            onChange={(id) => { setDraftTemplate(id) }}
          />
          {selectedTemplate === undefined ? null : (
            <code className={css.templateBundles}>{selectedTemplate.bundles.join(' · ')}</code>
          )}
          {templateError === undefined ? null : (
            <p className={css.error} role="status">{t('env.templateLoadFailed', { message: templateError })}</p>
          )}
        </div>
      </Modal>

      <Modal
        open={dialog.kind === 'rename'}
        onClose={closeDialog}
        title={t('env.renameTitle')}
        closeLabel={t('common.close')}
        footer={(
          <>
            <Button variant="ghost" size="md" onClick={closeDialog}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              size="md"
              disabled={draftName.trim() === '' || dialog.kind !== 'rename'}
              onClick={() => {
                if (dialog.kind === 'rename') actions.renameEnvironment(dialog.name, draftName.trim())
                closeDialog()
              }}
            >
              {t('env.doRename')}
            </Button>
          </>
        )}
      >
        <label className={css.field}>
          <span className={css.metaLabel}>{t('env.renameTo')}</span>
          <Input value={draftName} onChange={(event) => { setDraftName(event.target.value) }} aria-label={t('env.renameTo')} />
        </label>
      </Modal>

      <Modal
        open={dialog.kind === 'copy'}
        onClose={closeDialog}
        title={t('env.copyTitle')}
        description={t('env.copyHint')}
        closeLabel={t('common.close')}
        footer={(
          <>
            <Button variant="ghost" size="md" onClick={closeDialog}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              size="md"
              disabled={copyTarget === '' || copyNames.trim() === '' || dialog.kind !== 'copy'}
              onClick={() => {
                if (dialog.kind === 'copy') {
                  const names = copyNames.split(',').map(name => name.trim()).filter(name => name !== '')
                  actions.copyPlugins(dialog.name, copyTarget, names)
                }
                closeDialog()
              }}
            >
              {t('env.doCopy')}
            </Button>
          </>
        )}
      >
        <div className={css.field}>
          <span className={css.metaLabel}>{t('env.copyTo')}</span>
          <PmSelect
            label={t('env.copyTo')}
            placeholder={t('env.selectEnv')}
            value={copyTarget}
            options={targets}
            onChange={(id) => { setCopyTarget(id) }}
          />
        </div>
        <label className={css.field}>
          <span className={css.metaLabel}>{t('env.copyNames')}</span>
          <Input value={copyNames} onChange={(event) => { setCopyNames(event.target.value) }} aria-label={t('env.copyNames')} />
        </label>
      </Modal>

      <Modal
        open={dialog.kind === 'remove'}
        onClose={closeDialog}
        title={t('env.removeTitle', { name: dialog.kind === 'remove' ? dialog.name : '' })}
        description={t('env.removeDesc')}
        closeLabel={t('common.close')}
        footer={(
          <>
            <Button variant="ghost" size="md" onClick={closeDialog}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              size="md"
              onClick={() => {
                if (dialog.kind === 'remove') actions.removeEnvironment(dialog.name)
                closeDialog()
              }}
            >
              {t('env.doRemove')}
            </Button>
          </>
        )}
      >
        <p className={css.warn}>{t('env.removeDesc')}</p>
      </Modal>

      <RiskConfirmation
        open={restoreOpen}
        title={t('env.restoreWarnTitle', { name: restoreTarget })}
        description={t('env.restoreWarnDesc')}
        acknowledgeLabel={t('env.acknowledge')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('common.close')}
        confirmLabel={t('env.doRestore')}
        acknowledged={acknowledged}
        disabled={busy !== undefined || restoreTarget === ''}
        onAcknowledgedChange={setAcknowledged}
        onCancel={() => { setRestoreOpen(false) }}
        onConfirm={() => { setRestoreOpen(false); actions.restoreBackup(restoreTarget) }}
      />

      {toast === undefined ? null : (
        <Toast key={toast.seq} text={toast.text} onDone={() => { setToast(undefined) }} />
      )}
    </section>
  )
}

/** 设置子页的 props。 */
interface ConfigPanelProps {
  readonly t: T
  readonly useConfig: SnapshotSelectorHook<ConfigState>
  readonly useTrial: SnapshotSelectorHook<TrialState>
  readonly actions: ConfigActions
  readonly trialActions: TrialActions
}

/**
 * 渲染「设置」子页：本插件配置表单（质量门、诊断分层、市场）。
 *
 * 与官方插件配置页同一交互模型：改的是本地草稿，保存时才写；离开页面即放弃。
 * 这个组件同时被官方插件页的 `plugins.item` / `plugins.bundle.config` 注册项复用。
 *
 * @param props - 字典座位、配置状态选择器与配置动作。
 * @returns 配置表单。
 */
export function ConfigPanel({ t, useConfig, useTrial, actions, trialActions }: ConfigPanelProps) {
  const status = useConfig(state => state.status)
  const writable = useConfig(state => state.writable)
  const value = useConfig(state => state.value)
  const draft = useConfig(state => state.draft)
  const incomplete = useConfig(state => state.incomplete)
  const dirty = useConfig(state => state.dirty)
  const saving = useConfig(state => state.saving)
  const failed = useConfig(state => state.failed)
  const saved = useConfig(state => state.saved)

  const disclosure = useTrial(state => state.disclosure)
  const disclosureError = useTrial(state => state.disclosureError)
  const disclosureErrorKey = useTrial(state => state.disclosureErrorKey)
  const report = useTrial(state => state.report)
  const trialLoading = useTrial(state => state.loading)
  const trialBusy = useTrial(state => state.busy)
  const trialError = useTrial(state => state.error)
  const trialErrorKey = useTrial(state => state.errorKey)
  const trialAction = useTrial(state => state.action)

  // 披露事实与测试环境列表各读一次（与体检页补环境列表同一手法：只补一次，失败不重试，
  // 否则会形成 loading 翻转的死循环；失败原因由这一节自己如实显示）。
  const requestedTrial = useRef(false)
  useEffect(() => {
    if (requestedTrial.current) return
    requestedTrial.current = true
    trialActions.loadTrial()
  }, [trialActions])

  // 三种状态都必须是"能读的界面"：官方宿主的 settings 快照可能尚在加载、可能没有这个
  // 命名空间、也可能只给出残缺文档。draft 是归一后的值（见 shared.ts 的 ConfigController），
  // 所以下面表单里的每个字段都一定有确定值——这一页永远不会渲染成空白。
  if (status === 'unavailable') {
    return (
      <section className={css.section}>
        <h3 className={css.sectionTitle}>{t('config.title')}</h3>
        <p className={css.hint} role="status">{t('config.unavailable')}</p>
      </section>
    )
  }
  if (draft === undefined) {
    return (
      <section className={css.section}>
        <h3 className={css.sectionTitle}>{t('config.title')}</h3>
        <p className={css.hint} role="status">{t('config.loading')}</p>
      </section>
    )
  }

  return (
    <section className={css.section}>
      <h3 className={css.sectionTitle}>{t('config.title')}</h3>
      <p className={css.hint}>{t('config.scope')}</p>
      {incomplete ? <p className={css.warn} role="status">{t('config.incomplete')}</p> : null}
      {writable ? null : (
        <p className={css.readOnlyLine} role="status">
          <Tag tone="warning">{t('common.readOnly')}</Tag>
          {/* 标记承载"只读"这个状态，句子只留后果（改动无法保存）。 */}
          <span className={css.readOnlyConsequence}>{t('config.readOnly')}</span>
        </p>
      )}
      {failed ? <p className={css.error} role="status">{t('config.saveFailed')}</p> : null}

      <fieldset className={css.group} disabled={!writable}>
        <legend className={css.groupTitle}>{t('config.qualityGate')}</legend>
        {/* 官方 Switch 只画开关本体，可见标签由调用方给（ui-primitives/Switch.tsx 的契约），
            所以每一行都要自带 label——否则用户看到一排无法分辨的拨杆。 */}
        <div className={css.fieldRow}>
          <span className={css.metaLabel}>{t('config.qualityGate.enabled')}</span>
          <Switch
            checked={draft.qualityGate.enabled}
            label={t('config.qualityGate.enabled')}
            title={t('config.qualityGate.enabledHint')}
            onChange={(next) => { actions.editConfigField(['qualityGate', 'enabled'], next) }}
          />
        </div>
        <div className={css.fieldRow}>
          <span className={css.metaLabel}>{t('config.qualityGate.mode')}</span>
          <PmSelect
            label={t('config.qualityGate.mode')}
            placeholder={t('config.qualityGate.mode.block')}
            value={draft.qualityGate.mode}
            options={[
              { id: 'block', label: t('config.qualityGate.mode.block') },
              { id: 'warn', label: t('config.qualityGate.mode.warn') },
            ]}
            onChange={(id) => { actions.editConfigField(['qualityGate', 'mode'], id) }}
          />
        </div>
      </fieldset>

      <fieldset className={css.group} disabled={!writable}>
        <legend className={css.groupTitle}>{t('config.diagnostics')}</legend>
        <p className={css.hint}>{t('config.diagnostics.hint')}</p>
        {LAYER_ORDER.map((layer) => (
          <div key={layer} className={css.fieldRow}>
            <span className={css.metaLabel}>{t(DIAGNOSTIC_LABEL[layer])}</span>
            <Switch
              checked={draft.diagnostics[layer]}
              label={t(DIAGNOSTIC_LABEL[layer])}
              onChange={(next) => { actions.editConfigField(['diagnostics', layer], next) }}
            />
          </div>
        ))}
      </fieldset>

      <fieldset className={css.group} disabled={!writable}>
        <legend className={css.groupTitle}>{t('config.marketplace')}</legend>
        <div className={css.fieldRow}>
          <span className={css.metaLabel}>{t('config.marketplace.enabled')}</span>
          <Switch
            checked={draft.marketplace.enabled}
            label={t('config.marketplace.enabled')}
            onChange={(next) => { actions.editConfigField(['marketplace', 'enabled'], next) }}
          />
        </div>
        <div className={css.fieldRow}>
          <span className={css.metaLabel}>{t('config.marketplace.cacheTtlMinutes')}</span>
          <Input
            type="number"
            min={1}
            max={10080}
            value={String(draft.marketplace.cacheTtlMinutes)}
            aria-label={t('config.marketplace.cacheTtlMinutes')}
            onChange={(event) => {
              const next = Number(event.target.value)
              if (Number.isFinite(next) && next >= 1) actions.editConfigField(['marketplace', 'cacheTtlMinutes'], next)
            }}
          />
        </div>
        <div className={css.fieldRow}>
          <span className={css.metaLabel}>{t('config.marketplace.timeoutMs')}</span>
          <Input
            type="number"
            min={1000}
            max={120000}
            step={1000}
            value={String(draft.marketplace.timeoutMs)}
            aria-label={t('config.marketplace.timeoutMs')}
            onChange={(event) => {
              const next = Number(event.target.value)
              // 与官方 schema 同界（src/settings.ts: 1000..120000）：界面先挡一次，
              // 免得用户敲一个会被 settings 服务拒绝的值而只看到"保存失败"。
              if (Number.isFinite(next) && next >= 1_000 && next <= 120_000) {
                actions.editConfigField(['marketplace', 'timeoutMs'], next)
              }
            }}
          />
        </div>
        <div className={css.field}>
          <span className={css.metaLabel}>{t('config.marketplace.indexUrl')}</span>
          <Input
            type="text"
            value={draft.marketplace.indexUrl}
            placeholder={t('config.marketplace.indexUrlPlaceholder')}
            aria-label={t('config.marketplace.indexUrl')}
            onChange={(event) => { actions.editConfigField(['marketplace', 'indexUrl'], event.target.value) }}
          />
          <span className={css.hint}>{t('config.marketplace.indexUrlHint')}</span>
        </div>
      </fieldset>

      <fieldset className={css.group} disabled={!writable}>
        <legend className={css.groupTitle}>{t('config.trial')}</legend>
        <div className={css.fieldRow}>
          <span className={css.metaLabel}>{t('config.trial.enabled')}</span>
          <Switch
            checked={draft.trial.enabled}
            label={t('config.trial.enabled')}
            onChange={(next) => { actions.editConfigField(['trial', 'enabled'], next) }}
          />
        </div>
        {/*
          披露事实：一句一行。数字与口径都取自 host 的 capabilities.trialDisclosure——
          抄一份就会在下次实测后漂移，而漂移的是"用户以为自己承担了什么风险"。
          读不到时如实说「未知」并给出原因：静默等于把不知道说成没风险。
        */}
        {disclosure === undefined ? (
          <p className={css.warn} role="status">
            <Tag tone="warning">{t('config.trial.disclosureUnknown')}</Tag>
            <span className={css.trialFactNote}>
              {t('config.trial.disclosureReason', {
                reason: disclosureErrorKey === undefined ? disclosureError ?? t('env.unknown') : t(disclosureErrorKey),
              })}
            </span>
          </p>
        ) : (
          <>
            {disclosure.executesCandidateCode ? <p className={css.trialFact}>{t('config.trial.factExecutes')}</p> : null}
            <p className={css.trialFact}>{t('config.trial.factMemory', { mib: disclosure.peakMemoryMiB })}</p>
            <p className={css.trialFactNote}>{t('config.trial.factMeasurement', { measurement: disclosure.measurement })}</p>
          </>
        )}
        <div className={css.fieldRow}>
          <span className={css.metaLabel}>{t('config.trial.depth')}</span>
          <PmSelect
            label={t('config.trial.depth')}
            placeholder={t('config.trial.depth.auto')}
            value={draft.trial.depth}
            options={[
              { id: 'auto', label: t('config.trial.depth.auto') },
              { id: 'shallow', label: t('config.trial.depth.shallow') },
              { id: 'full', label: t('config.trial.depth.full') },
            ]}
            onChange={(id) => { actions.editConfigField(['trial', 'depth'], id) }}
          />
        </div>
        <p className={css.hint}>
          {draft.trial.depth === 'shallow'
            ? t('config.trial.depth.shallowHint')
            : draft.trial.depth === 'full' ? t('config.trial.depth.fullHint') : t('config.trial.depth.autoHint')}
        </p>
        <div className={css.fieldRow}>
          <span className={css.metaLabel}>{t('config.trial.baseline')}</span>
          <Switch
            checked={draft.trial.baseline}
            label={t('config.trial.baseline')}
            onChange={(next) => { actions.editConfigField(['trial', 'baseline'], next) }}
          />
        </div>
        <p className={css.hint}>{t('config.trial.baselineHint')}</p>
        <div className={css.fieldRow}>
          <span className={css.metaLabel}>{t('config.trial.allowNetwork')}</span>
          <Switch
            checked={draft.trial.allowNetwork}
            label={t('config.trial.allowNetwork')}
            onChange={(next) => { actions.editConfigField(['trial', 'allowNetwork'], next) }}
          />
        </div>
        <p className={css.hint}>{t('config.trial.allowNetworkHint')}</p>
        <div className={css.fieldRow}>
          <span className={css.metaLabel}>{t('config.trial.onFailure')}</span>
          <PmSelect
            label={t('config.trial.onFailure')}
            placeholder={t('config.trial.onFailure.block')}
            value={draft.trial.onFailure}
            options={[
              { id: 'block', label: t('config.trial.onFailure.block') },
              { id: 'warn', label: t('config.trial.onFailure.warn') },
            ]}
            onChange={(id) => { actions.editConfigField(['trial', 'onFailure'], id) }}
          />
        </div>
        <p className={css.hint}>
          {draft.trial.onFailure === 'warn' ? t('config.trial.onFailure.warnHint') : t('config.trial.onFailure.blockHint')}
        </p>
        <div className={css.fieldRow}>
          <span className={css.metaLabel}>{t('config.trial.autoCleanup')}</span>
          <Switch
            checked={draft.trial.autoCleanup}
            label={t('config.trial.autoCleanup')}
            onChange={(next) => { actions.editConfigField(['trial', 'autoCleanup'], next) }}
          />
        </div>
        <div className={css.fieldRow}>
          <span className={css.metaLabel}>{t('config.trial.retentionDays')}</span>
          <Input
            type="number"
            min={1}
            max={3650}
            value={String(draft.trial.retentionDays)}
            aria-label={t('config.trial.retentionDays')}
            onChange={(event) => {
              const next = Number(event.target.value)
              if (Number.isFinite(next) && next >= 1) {
                actions.editConfigField(['trial', 'retentionDays'], Math.min(3650, Math.trunc(next)))
              }
            }}
          />
        </div>
        <p className={css.hint}>{t('config.trial.retentionHint')}</p>
        <div className={css.fieldRow}>
          <span className={css.metaLabel}>{t('config.trial.maxKept')}</span>
          <Input
            type="number"
            min={0}
            max={1000}
            value={String(draft.trial.maxKept)}
            aria-label={t('config.trial.maxKept')}
            onChange={(event) => {
              const next = Number(event.target.value)
              if (Number.isFinite(next) && next >= 0) {
                actions.editConfigField(['trial', 'maxKept'], Math.min(1000, Math.trunc(next)))
              }
            }}
          />
        </div>
        <p className={css.hint}>{t('config.trial.maxKeptHint')}</p>
      </fieldset>

      <TrialEnvironments
        t={t}
        report={report}
        loading={trialLoading}
        busy={trialBusy}
        action={trialAction}
        error={trialError}
        errorKey={trialErrorKey}
        onRemove={trialActions.removeTrialEnvironment}
        onCleanup={trialActions.cleanupTrialEnvironments}
      />

      <div className={css.configFooter}>
        <span className={css.hint} role="status">
          {saving ? t('config.saving') : dirty ? t('config.dirty') : saved && value !== undefined ? t('config.saved') : t('config.clean')}
        </span>
        <div className={css.rowActions}>
          <Button
            variant="ghost"
            size="sm"
            disabled={!dirty || saving}
            onClick={() => { actions.discardConfig() }}
          >
            {t('config.discard')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!dirty || saving || !writable}
            onClick={() => { actions.saveConfig() }}
          >
            {saving ? t('config.saving') : t('config.save')}
          </Button>
        </div>
      </div>
    </section>
  )
}

/** 试装环境管理那一节的 props：全是值 + 两个回调（订阅只在 ConfigPanel 一处）。 */
interface TrialEnvironmentsProps {
  readonly t: T
  readonly report: TrialEnvironmentsView | undefined
  readonly loading: boolean
  readonly busy: string | undefined
  readonly action: TrialActionState | undefined
  readonly error: string | undefined
  readonly errorKey: CompanionLocaleKey | undefined
  readonly onRemove: (name: string) => void
  readonly onCleanup: () => void
}

/**
 * 渲染"下次清理会删谁、留谁"。
 *
 * 为什么必须画出来（task-90）：清理是**删目录**的不可逆操作，而用户点「清理过期」之前
 * 看不到会删谁——引擎虽然有"运行中永不删"这类纪律，但把计划藏起来等于让用户凭运气按下去。
 * 宿主早就在 `trialEnvironments` 的返回值里给了这份计划（types.ts 的 plan.remove/keep，
 * 各带 name + reason），客户端一直没渲染。
 *
 * 两件事实都要给：
 *   · **会删**——不可逆的那部分，必须逐个列出；
 *   · **会留 + 为什么留**——用户最常问的就是"为什么没删它"，只列"会删"回答不了这个问题。
 *
 * R2（§12.9）：宿主的 reason 里自带冒号（例如"正在运行：不删（先让用户停）"），
 * 所以**名字与原因必须分层**——拼成一行会变成"名字：原因：从句"，一行两个冒号。
 * 这也是把 trial.planRow 从 `{name}：{reason}` 改掉的原因（见字典里的注释）。
 *
 * @param props - 字典座位与计划。
 * @returns 计划区；宿主没给计划时 null（不猜、不留白）。
 */
function TrialCleanupPlan({ t, plan }: {
  readonly t: T
  readonly plan: TrialEnvironmentsView['plan']
}) {
  // 宿主没给计划：这是"读不到"，不是"没有需要清理的"。两者必须分开说（§12.3.3）。
  if (plan === undefined) return null
  const empty = plan.remove.length === 0 && plan.keep.length === 0
  return (
    <div className={css.trialPlan}>
      <p className={css.metaLabel}>{t('trial.planTitle')}</p>
      {empty ? <p className={css.hint} role="status">{t('trial.cleanupNone')}</p> : null}
      {plan.remove.length === 0 ? null : (
        <>
          <p className={css.trialPlanGroup}>{t('trial.planRemove', { count: plan.remove.length })}</p>
          <ul className={css.trialPlanList}>
            {plan.remove.map(entry => (
              <li key={entry.name} className={css.trialPlanItem}>
                <code className={css.trialName}>{entry.name}</code>
                <span className={css.trialPlanReason}>{entry.reason}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {plan.keep.length === 0 ? null : (
        <>
          <p className={css.trialPlanGroup}>{t('trial.planKeep', { count: plan.keep.length })}</p>
          <ul className={css.trialPlanList}>
            {plan.keep.map(entry => (
              <li key={entry.name} className={css.trialPlanItem}>
                <code className={css.trialName}>{entry.name}</code>
                <span className={css.trialPlanReason}>{entry.reason}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

/**
 * 渲染一个测试环境：名字 + 状态标记 + 占地/时间 + 删除入口。
 *
 * 布尔事实读不到时显示「未知」而不是「未运行」「归属没了」：后者是结论，不能拿它顶替读不到。
 *
 * @param props - 字典座位、这一条环境的事实与删除回调。
 * @returns 一行测试环境。
 */
function TrialEnvironmentRow({ t, entry, busy, onRemove }: {
  readonly t: T
  readonly entry: TrialEnvironmentView
  readonly busy: boolean
  readonly onRemove: () => void
}) {
  return (
    <li className={css.trialItem}>
      <div className={css.trialHead}>
        <code className={css.trialName}>{entry.name}</code>
        {entry.running === true ? <Tag tone="info">{t('env.running')}</Tag> : null}
        {entry.running === false ? <Tag tone="neutral">{t('env.stopped')}</Tag> : null}
        {entry.running === undefined ? <Tag tone="warning">{t('trial.runningUnknown')}</Tag> : null}
        {entry.ownerExists === false ? <Tag tone="warning">{t('trial.orphan')}</Tag> : null}
        {entry.ownerExists === undefined ? <Tag tone="quiet">{t('trial.ownerUnknown')}</Tag> : null}
      </div>
      <div className={css.envMeta}>
        <span className={css.metaLabel}>
          {t('trial.owner', { name: entry.owner === '' ? t('env.unknown') : entry.owner })}
        </span>
        <span className={css.metaLabel}>
          {entry.bytes === null
            ? t('trial.bytesUnknown', { reason: entry.bytesReason ?? t('env.unknown') })
            : t('trial.bytes', { size: formatBytes(entry.bytes) })}
        </span>
        <span className={css.metaLabel}>
          {entry.ageDays === undefined
            ? t('trial.modifiedAt', { at: entry.modifiedAt === '' ? t('env.unknown') : formatRelative(t, entry.modifiedAt) })
            : t('trial.age', { days: entry.ageDays })}
        </span>
        {entry.sharedFiles > 0 ? (
          <span className={css.metaLabel}>{t('trial.sharedFiles', { count: entry.sharedFiles })}</span>
        ) : null}
        <span className={css.metaLabel}>
          {entry.snapshotMatchesOwner === true
            ? t('trial.snapshotCurrent')
            : entry.snapshotMatchesOwner === false ? t('trial.snapshotStale') : t('trial.snapshotNotApplicable')}
        </span>
      </div>
      <Button variant="ghost" size="sm" disabled={busy} onClick={onRemove}>{t('trial.doRemove')}</Button>
    </li>
  )
}

/**
 * 渲染「测试环境」那一节：谁存在、多大、最后一次物化是什么时候，以及删除与清理过期。
 *
 * 这是管理界面而不是解释界面：只列事实与动作。读失败时显示失败本身（含原因），
 * 不显示空列表——空列表会被读成"没有测试环境"。
 *
 * @param props - 字典座位、这一节的状态与两个动作。
 * @returns 测试环境列表、清理入口与操作结果。
 */
function TrialEnvironments({
  t, report, loading, busy, action, error, errorKey, onRemove, onCleanup,
}: TrialEnvironmentsProps) {
  const [confirming, setConfirming] = useState<string | undefined>(undefined)
  const failed = error !== undefined || errorKey !== undefined
  // 上一次操作的结果：成功也必须说出来（清理 0 个与清理 2 个是两件不同的事），
  // 失败走失败行——绝不把失败渲染成"完成"（task-14/18 的护栏）。
  const actionText = action === undefined
    ? undefined
    : action.kind === 'cleanup' && action.ok
      ? action.removed.length === 0 ? t('trial.cleanupNone') : t('trial.cleanupDone', { count: action.removed.length })
      : action.output
  return (
    <fieldset className={css.group}>
      <legend className={css.groupTitle}>{t('trial.title')}</legend>
      {busy === undefined ? null : <p className={css.hint} role="status">{t('env.busy', { name: busy })}</p>}
      {failed ? (
        <p className={css.error} role="status">
          {t('trial.failed', { message: errorKey === undefined ? error ?? t('env.unknown') : t(errorKey) })}
        </p>
      ) : null}
      {report === undefined
        ? (loading ? <p className={css.hint} role="status">{t('trial.loading')}</p> : null)
        : (
          <>
            <div className={css.trialSummary}>
              <span className={css.metaLabel}>{t('trial.count', { count: report.totals.count })}</span>
              <span className={css.metaLabel}>{t('trial.total', { size: formatBytes(report.totals.bytes) })}</span>
              {report.totals.unknownBytes > 0 ? (
                <Tag tone="warning">{t('trial.unknownBytes', { count: report.totals.unknownBytes })}</Tag>
              ) : null}
              {report.overCap === true ? <Tag tone="warning">{t('trial.overCap')}</Tag> : null}
              <Button variant="outline" size="sm" disabled={busy !== undefined} onClick={onCleanup}>
                {t('trial.cleanup')}
              </Button>
            </div>
            {report.factsReadable === false ? (
              <p className={css.warn} role="status">
                <Tag tone="warning">
                  {t('trial.factsUnreadable', { reason: report.factsReason ?? t('env.unknown') })}
                </Tag>
                <span className={css.trialFactNote}>{t('trial.factsUnreadableNote')}</span>
              </p>
            ) : null}
            {report.notes.map(note => <p key={note} className={css.hint}>{note}</p>)}
            {/*
              "下次清理会删谁、留谁"放在环境列表**之前**：它是按「清理过期」这个按钮之前
              唯一能回答"会动到什么"的东西，压在列表后面等于没有（task-90）。
            */}
            <TrialCleanupPlan t={t} plan={report.plan} />
            {report.environments.length === 0
              ? <p className={css.hint} role="status">{t('trial.empty')}</p>
              : (
                <ul className={css.trialList}>
                  {report.environments.map(entry => (
                    <TrialEnvironmentRow
                      key={entry.name}
                      t={t}
                      entry={entry}
                      busy={busy !== undefined}
                      onRemove={() => { setConfirming(entry.name) }}
                    />
                  ))}
                </ul>
              )}
          </>
        )}
      {action === undefined ? null : (
        action.ok
          ? <p className={css.notice} role="status">{actionText}</p>
          : (
            <p className={css.error} role="status">
              {t('trial.failed', { message: action.output === '' ? action.code ?? t('env.unknown') : action.output })}
            </p>
          )
      )}
      <Modal
        open={confirming !== undefined}
        onClose={() => { setConfirming(undefined) }}
        title={t('trial.removeTitle', { name: confirming ?? '' })}
        description={t('trial.removeDesc')}
        closeLabel={t('common.close')}
        footer={(
          <>
            <Button variant="ghost" size="md" onClick={() => { setConfirming(undefined) }}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              size="md"
              onClick={() => {
                const name = confirming
                setConfirming(undefined)
                if (name !== undefined) onRemove(name)
              }}
            >
              {t('trial.doRemove')}
            </Button>
          </>
        )}
      >
        <p className={css.warn}>{t('trial.removeDesc')}</p>
      </Modal>
    </fieldset>
  )
}


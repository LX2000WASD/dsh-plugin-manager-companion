/**
 * ConsolePage — 环境控制台：一个设置入口内的三个本地子页面（体检 / 环境 / 设置）。
 *
 * 归属：A 类·重写（旧仓库把这三个能力拆在 PluginManagerSettingsTab /
 *   PluginEnvironmentsTab / PluginCatalogTab 里，且自带样式与散落文案）。
 * 旧实现参考：dsh-web-plugin-manager/src/client/*Tab.tsx（只取交互意图：健康总览、
 *   分环境卡片、分级修复；未复制代码）。
 * 官方复用：设置子页机制照抄官方 ui-settings-plugins 的 PluginsSettingsSection
 *   （本地 useState 管 activeId + visitedIds 保证切页不丢草稿 + role=tablist/tab/tabpanel
 *   + 方向键导航）；全部控件来自 @deepseek-ai/dsh-client-ui-primitives；
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
import type { SnapshotSelectorHook, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { DiagnosticGroup, DiagnosticIssue } from '../types.ts'
import { NS } from './locales.ts'
import { PmSelect } from './pmSelect.tsx'
import {
  DIAGNOSTIC_LABEL, LAYER_LABEL, LAYER_ORDER,
  evidenceKindOf, formatRelative, healthScore, issueInGroup, layerLabelKey, severityLabelKey, severityToneOf,
  type CompanionSlotProps, type ConfigFace, type ConfigState, type ConsoleFace,
  type EnvironmentsFace, type EnvironmentsState, type HealthFace, type HealthState,
} from './shared.ts'
import css from './ConsolePage.module.css'

/** 本文件里 t 的键域（本插件字典）。 */
type T = TranslateNS<typeof NS>

/** 只带动作、不带 hooks 隔间的注入子面（子面板只吃自己需要的动作）。 */
type EnvironmentActions = Omit<EnvironmentsFace, 'hooks'>
type ConfigActions = Omit<ConfigFace, 'hooks'>

/** 环境控制台的注册项 props（官方组合别名 + 本插件字典）。 */
export type ConsolePageProps = CompanionSlotProps<'settings.section', ConsoleFace>

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
  t, useHealth, useEnvironments, useConfig,
  diagnose, fix, setDiagnosticTarget, refreshEnvironments, startEnvironment, stopEnvironment,
  createEnvironment, renameEnvironment, removeEnvironment, copyPlugins, exportBackup, loadBackup,
  diffBackup, restoreBackup, dismissEnvironmentNotice, editConfigField, saveConfig, discardConfig,
}: ConsolePageProps) {
  const tabsId = useId()
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [activeId, setActiveId] = useState<string>()
  const [visitedIds, setVisitedIds] = useState<ReadonlySet<string>>(() => new Set())
  const tabs: readonly ConsoleTab[] = [
    { id: 'health', label: t('console.tab.health') },
    { id: 'env', label: t('console.tab.env') },
    { id: 'settings', label: t('console.tab.settings') },
  ]
  const active = tabs.find(tab => tab.id === activeId)?.id ?? tabs[0]?.id

  // 子页面只在首次选中时挂载，之后隐藏着保留：切换 tab 不丢表单草稿、展开状态与
  // 已读到的报告（与官方 PluginsSettingsSection 同一机制）。
  useEffect(() => {
    if (active === undefined) return
    setVisitedIds((previous) => previous.has(active) ? previous : new Set([...previous, active]))
  }, [active])

  const environmentActions: EnvironmentActions = {
    refreshEnvironments, startEnvironment, stopEnvironment, createEnvironment, renameEnvironment,
    removeEnvironment, copyPlugins, exportBackup, loadBackup, diffBackup, restoreBackup,
    dismissEnvironmentNotice,
  }
  const configActions: ConfigActions = { editConfigField, saveConfig, discardConfig }

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
              onClick={() => { setActiveId(tab.id) }}
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
                setActiveId(next.id)
                tabRefs.current[nextIndex]?.focus()
              }}
            >
              {tab.label}
            </button>
          )
        })}
      </div>
      {tabs.filter(tab => tab.id === active || visitedIds.has(tab.id)).map((tab) => (
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
              : <ConfigPanel t={t} useConfig={useConfig} actions={configActions} />}
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
                <Button
                  variant={issue.severity === 'safe-fix' ? 'primary' : 'outline'}
                  size="sm"
                  disabled={fixing || busy}
                  title={issue.fix.summary}
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
      label: environment.current ? `${environment.name} · ${t('env.current')}` : environment.name,
    }))
    if (list.length > 0) return list
    return current === undefined ? [] : [{ id: current, label: `${current} · ${t('env.current')}` }]
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
      <p className={css.hint}>{t('health.intro')}</p>
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
        {foreign ? <Tag tone="warning">{t('health.foreignTag')}</Tag> : null}
      </div>
      <p className={css.hint}>{t('health.targetHint')}</p>
      {foreign ? (
        <div className={css.capabilities} role="status">
          <span className={css.metaLabel}>{t('health.foreignTitle', { name: target ?? '' })}</span>
          <p className={css.hint}>{t('health.foreignBody')}</p>
        </div>
      ) : null}
      {error === undefined && errorKey === undefined ? null : (
        <p className={css.error} role="status">
          {t('health.failed', { message: errorKey === undefined ? error ?? '' : t(errorKey) })}
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
                  {t('health.environment', { name: report.environment })}
                  {report.environment === current ? '' : ` · ${t('health.foreignTag')}`}
                </span>
                <span>{t('health.generatedAt', { at: formatRelative(t, report.generatedAt) })}</span>
              </span>
            </div>
            <div className={css.layerGrid}>
              {LAYER_ORDER.map((layer) => {
                // 计数缺失按 0 显示：这一格只是总览，不该让缺一个字段的载荷毁掉整页。
                const count = report.counts[layer] ?? 0
                return (
                  <div key={layer} className={css.layerCell}>
                    <span className={css.layerName}>{t(LAYER_LABEL[layer])}</span>
                    <Tag tone={count === 0 ? 'quiet' : 'warning'}>{String(count)}</Tag>
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
            onClick={() => { setDraftName(''); setDraftTemplate(''); setDialog({ kind: 'create' }) }}
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
                <Tag tone={running ? 'success' : 'quiet'}>{running ? t('env.running') : t('env.stopped')}</Tag>
              </div>
              <div className={css.envMeta}>
                <code className={css.envDir}>{environment.dir}</code>
                <span>{t('env.bundles', { count: environment.bundles.length })}</span>
                <span>{t('env.dependencies', { count: environment.dependencies.length })}</span>
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
          <PmSelect
            label={t('env.backupExport')}
            placeholder={t('env.selectEnv')}
            value={exportTarget ?? ''}
            options={targets}
            onChange={(id) => { setExportTarget(id) }}
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
            exitCode={error === undefined ? 0 : 1}
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
              onClick={() => { actions.createEnvironment(draftName.trim(), draftTemplate.trim()); closeDialog() }}
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
        <label className={css.field}>
          <span className={css.metaLabel}>{t('env.template')}</span>
          <Input value={draftTemplate} onChange={(event) => { setDraftTemplate(event.target.value) }} aria-label={t('env.template')} placeholder={t('env.templateAuto')} />
        </label>
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
  readonly actions: ConfigActions
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
export function ConfigPanel({ t, useConfig, actions }: ConfigPanelProps) {
  const status = useConfig(state => state.status)
  const writable = useConfig(state => state.writable)
  const value = useConfig(state => state.value)
  const draft = useConfig(state => state.draft)
  const incomplete = useConfig(state => state.incomplete)
  const dirty = useConfig(state => state.dirty)
  const saving = useConfig(state => state.saving)
  const failed = useConfig(state => state.failed)
  const saved = useConfig(state => state.saved)

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
      {incomplete ? <p className={css.warn} role="status">{t('config.incomplete')}</p> : null}
      {writable ? null : <p className={css.warn} role="status">{t('config.readOnly')}</p>}
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

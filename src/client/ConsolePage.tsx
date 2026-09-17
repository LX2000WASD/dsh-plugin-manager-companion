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
import { NS } from './locales.ts'
import { PmSelect } from './pmSelect.tsx'
import {
  DIAGNOSTIC_LABEL, EVIDENCE_KIND, LAYER_LABEL, LAYER_ORDER, SEVERITY_LABEL, SEVERITY_TONE,
  formatRelative, healthScore,
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
  diagnose, fix, refreshEnvironments, startEnvironment, stopEnvironment, createEnvironment,
  renameEnvironment, removeEnvironment, copyPlugins, exportBackup, loadBackup, diffBackup,
  restoreBackup, dismissEnvironmentNotice, editConfigField, saveConfig, discardConfig,
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
      <p className={css.intro}>{t('console.intro')}</p>
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
            ? <HealthPanel t={t} useHealth={useHealth} diagnose={diagnose} fix={fix} />
            : tab.id === 'env'
              ? <EnvironmentsPanel t={t} useEnvironments={useEnvironments} actions={environmentActions} />
              : <ConfigPanel t={t} useConfig={useConfig} actions={configActions} />}
        </div>
      ))}
    </div>
  )
}

/** 体检子页的 props。 */
interface HealthPanelProps {
  readonly t: T
  readonly useHealth: SnapshotSelectorHook<HealthState>
  readonly diagnose: HealthFace['diagnose']
  readonly fix: HealthFace['fix']
}

/** 处置等级 → 展开图标（可自动修复用盾牌，需确认用警告，只报告用信息）。 */
const SEVERITY_ICON = {
  'safe-fix': <IconShieldOutline16 />,
  'confirm-fix': <IconWarningOutline16 />,
  'report-only': <IconInfoOutline14 />,
} as const

/**
 * 渲染「体检」子页：健康分、各层计数、问题卡片（证据可展开）与分级修复按钮。
 *
 * @param props - 字典座位、报告选择器与诊断/修复动作。
 * @returns 体检面板。
 */
function HealthPanel({ t, useHealth, diagnose, fix }: HealthPanelProps) {
  const report = useHealth(state => state.report)
  const running = useHealth(state => state.running)
  const error = useHealth(state => state.error)
  const fixingId = useHealth(state => state.fixingId)
  const notice = useHealth(state => state.notice)
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set())
  const [confirmingId, setConfirmingId] = useState<string>()
  const [toast, setToast] = useState<{ text: string; seq: number }>()

  const issues = report?.issues ?? []
  const score = useMemo(() => healthScore(issues), [issues])

  useEffect(() => { if (notice !== undefined && notice !== '') setToast({ text: notice, seq: Date.now() }) }, [notice])
  // 落地即体检：这一页存在的意义就是这份报告，但只在没有报告时自动跑一次。
  useEffect(() => { if (report === undefined) diagnose() }, [diagnose, report])

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
      {error === undefined ? null : <p className={css.error} role="status">{t('health.failed', { message: error })}</p>}
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
                <span>{t('health.environment', { name: report.environment })}</span>
                <span>{t('health.generatedAt', { at: formatRelative(t, report.generatedAt) })}</span>
              </span>
            </div>
            <div className={css.layerGrid}>
              {LAYER_ORDER.map((layer) => {
                const count = report.counts[layer]
                return (
                  <div key={layer} className={css.layerCell}>
                    <span className={css.layerName}>{t(LAYER_LABEL[layer])}</span>
                    <Tag tone={count === 0 ? 'quiet' : 'warning'}>{String(count)}</Tag>
                  </div>
                )
              })}
            </div>
            {issues.length === 0 ? <p className={css.ok} role="status">{t('health.empty')}</p> : null}
            <ul className={css.issues}>
              {issues.map((issue) => {
                const open = openIds.has(issue.id)
                const confirming = confirmingId === issue.id
                const fixing = fixingId === issue.id
                return (
                  <li key={issue.id} className={css.issue}>
                    <DisclosureRow
                      icon={SEVERITY_ICON[issue.severity]}
                      title={issue.title}
                      open={open}
                      expandable
                      expandOnRowClick
                      onToggle={() => {
                        setOpenIds((previous) => {
                          const next = new Set(previous)
                          if (next.has(issue.id)) next.delete(issue.id)
                          else next.add(issue.id)
                          return next
                        })
                      }}
                      collapsedContent={(
                        <span className={css.issueMeta}>
                          <Tag tone={SEVERITY_TONE[issue.severity]}>{t(SEVERITY_LABEL[issue.severity])}</Tag>
                          <Tag tone="quiet">{t(LAYER_LABEL[issue.layer])}</Tag>
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
                                <Tag tone="quiet">{EVIDENCE_KIND[item.kind]}</Tag>
                                <code className={css.evidenceAt}>{item.at}</code>
                                <span className={css.evidenceNote}>{item.note}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                        <div className={css.issueActions}>
                          {issue.fix === undefined ? <Tag tone="quiet">{t('health.reportOnly')}</Tag> : (
                            <Button
                              variant={issue.severity === 'safe-fix' ? 'primary' : 'outline'}
                              size="sm"
                              disabled={fixing || fixingId !== undefined}
                              title={issue.fix.summary}
                              onClick={() => {
                                if (issue.severity === 'safe-fix' || confirming) {
                                  setConfirmingId(undefined)
                                  fix(issue)
                                  return
                                }
                                setConfirmingId(issue.id)
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
              })}
            </ul>
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
      {error === undefined ? null : <p className={css.error} role="status">{t('env.failed', { message: error })}</p>}
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
  const dirty = useConfig(state => state.dirty)
  const saving = useConfig(state => state.saving)
  const failed = useConfig(state => state.failed)
  const saved = useConfig(state => state.saved)

  if (status === 'unavailable' || draft === undefined) {
    return (
      <section className={css.section}>
        <h3 className={css.sectionTitle}>{t('config.title')}</h3>
        <p className={css.hint} role="status">{t('config.unavailable')}</p>
      </section>
    )
  }

  return (
    <section className={css.section}>
      <h3 className={css.sectionTitle}>{t('config.title')}</h3>
      <p className={css.hint}>{t('config.intro')}</p>
      {writable ? null : <p className={css.warn} role="status">{t('config.readOnly')}</p>}
      {failed ? <p className={css.error} role="status">{t('config.saveFailed')}</p> : null}

      <fieldset className={css.group} disabled={!writable}>
        <legend className={css.groupTitle}>{t('config.qualityGate')}</legend>
        <Switch
          checked={draft.qualityGate.enabled}
          label={t('config.qualityGate.enabled')}
          title={t('config.qualityGate.enabledHint')}
          onChange={(next) => { actions.editConfigField(['qualityGate', 'enabled'], next) }}
        />
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
          <Switch
            key={layer}
            checked={draft.diagnostics[layer]}
            label={t(DIAGNOSTIC_LABEL[layer])}
            onChange={(next) => { actions.editConfigField(['diagnostics', layer], next) }}
          />
        ))}
      </fieldset>

      <fieldset className={css.group} disabled={!writable}>
        <legend className={css.groupTitle}>{t('config.marketplace')}</legend>
        <Switch
          checked={draft.marketplace.enabled}
          label={t('config.marketplace.enabled')}
          onChange={(next) => { actions.editConfigField(['marketplace', 'enabled'], next) }}
        />
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

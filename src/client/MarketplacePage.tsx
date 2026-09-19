/**
 * MarketplacePage — 插件市场：索引浏览、搜索、排序、分类筛选、安装（官方通道 + 质量门）。
 *
 * 归属：A 类·重写（旧 src/client/PluginMarketplaceTab.tsx 815 行只作意图参考：
 *   搜索框 + 分类筛选 + 条目卡片 + 安装按钮；未复制代码）。
 * 旧实现参考：dsh-web-plugin-manager/src/client/PluginMarketplaceTab.tsx。旧缺陷面：
 *   排序方向与比较器不一致（按钮宣称降序、列表却是升序）、已安装条目不置顶、
 *   标签顺序随实现漂移——这三件事现在都由 src/marketView.ts / src/tags.ts 的纯函数
 *   契约承担，组件只做渲染。
 * 官方复用：@deepseek-ai/dsh-client-ui-primitives（Button/Input/Tag/Modal/Toast/Tooltip/Menu…）。
 * 前提检查：索引抓取与合并都在 host（task-3 的市场管道），客户端不联网抓 GitHub，
 *   也不自建 pnpm：安装走自有 install op（内部是官方 Remote 的禁用态安装 + 回滚）。
 *
 * 本轮（task-41）修掉的两条实证缺陷：
 *   1. **安装 spec 不在这里拼**：以前送 item.repo（owner/repo），官方 parseInstallSpec 判 invalid-spec，
 *      每一条都装不上。现在送 host 在 MarketItem.installSpec 里定好的值。
 *   2. **索引状态要说出来**：source/stale/notes 由 host 送来，不可用画成"索引不可用 + 原因 + 重试"，
 *      过期画成"这是缓存索引（生成于 X）"，不再与"没有匹配的条目"混为一谈。
 *   另：搜索从"只搜名称"改为 name/repo/主题/描述（中文查询以前命中恒为 0）。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Button, IconChevronDownOutline14, IconChevronUpOutline14, IconGlobeOutline14, IconRefreshOutline14,
  IconSearchOutline16, Input, Modal, Tag, Toast, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  categoryOptions, filterByCategory, marketToolbarModel, prepareMarketSearch, searchMarket, sortRows, tagsOf,
  updateAvailable, type MarketSort,
} from '../marketView.ts'
import type { MarketItem, MarketItemKind } from '../types.ts'
import { NS } from './locales.ts'
import { PmSelect } from './pmSelect.tsx'
import {
  KIND_LABEL, MARKET_LABEL, formatRelative, marketTagLabel,
  type CompanionSlotProps, type MarketplaceFace, type MarketplaceState,
} from './shared.ts'
import css from './MarketplacePage.module.css'

/** 本文件里 t 的键域（本插件字典）。 */
type T = TranslateNS<typeof NS>

/** 市场页的注册项 props。 */
export type MarketplacePageProps = CompanionSlotProps<'settings.section', MarketplaceFace>

/** 类型筛选器的全部选项（上游 index 的 kind 字段）。 */
const KINDS: readonly MarketItemKind[] = ['cordis-plugin', 'skill', 'agent-preset', 'unknown']

/**
 * 首屏渲染的条目数。
 *
 * 为什么必须有这个数：索引现在约 1.4 万条，全量渲染实测 **222,209 个 DOM 节点 /
 * 34.8MB HTML / 滚动高度 238 万 px**，输入一次搜索要数秒才稳定——真实浏览器里已经不可用。
 * 120 张卡片（约 2,000 节点）足够盖住首屏并留出滚动冗余。
 */
const RENDER_BATCH = 120

/**
 * 单页渲染的硬上限。
 *
 * 依据同一份测量：约 16 个 DOM 节点/卡片，1200 张 ≈ 2 万节点，仍是可交互的量级；
 * 再往上翻页不如让用户用搜索/筛选把结果缩小。到达上限后不再提供"加载更多"，
 * 改为明确提示（用户必须知道还有没有更多，而不是按钮点了没反应）。
 */
const RENDER_MAX = 1_200

/**
 * 渲染插件市场页。
 *
 * @param props - 字典座位、市场状态选择器与市场动作。
 * @returns 市场页。
 */
export function MarketplacePage({
  t, useMarketplace, loadMarketplace, setMarketQuery, setMarketCategory, setMarketKind,
  installMarketItem, dismissInstallNotice,
}: MarketplacePageProps) {
  const result = useMarketplace((state: MarketplaceState) => state.result)
  const loading = useMarketplace((state: MarketplaceState) => state.loading)
  const error = useMarketplace((state: MarketplaceState) => state.error)
  const errorKey = useMarketplace((state: MarketplaceState) => state.errorKey)
  const query = useMarketplace((state: MarketplaceState) => state.query)
  const category = useMarketplace((state: MarketplaceState) => state.category)
  const kind = useMarketplace((state: MarketplaceState) => state.kind)
  const installing = useMarketplace((state: MarketplaceState) => state.installing)
  const installError = useMarketplace((state: MarketplaceState) => state.installError)
  const gateIssues = useMarketplace((state: MarketplaceState) => state.gateIssues)
  const rolledBack = useMarketplace((state: MarketplaceState) => state.rolledBack)
  const [sort, setSort] = useState<MarketSort>('stars')
  const [descending, setDescending] = useState(true)
  const [target, setTarget] = useState<MarketItem>()
  const [toast, setToast] = useState<{ text: string; seq: number }>()
  const [limit, setLimit] = useState(RENDER_BATCH)
  const sentinel = useRef<HTMLDivElement | null>(null)

  // 落地即读索引（缓存优先）；用户点刷新才绕过缓存。
  useEffect(() => { if (result === undefined) loadMarketplace(false) }, [loadMarketplace, result])
  useEffect(() => { if (rolledBack) setToast({ text: t('market.rolledBack'), seq: Date.now() }) }, [rolledBack, t])

  const toolbar = marketToolbarModel(sort, descending, category)
  const sortOptions = useMemo(
    () => toolbar.sortOptions.map(mode => ({ id: mode, label: t(MARKET_LABEL[marketToolbarModel(mode, false).sortLabelKey]) })),
    [toolbar.sortOptions, t],
  )
  const categoryChoices = useMemo(
    () => [
      { id: '', label: t('market.all') },
      ...categoryOptions(result?.categories ?? {}).map(option => ({ id: option.id, label: `${option.id} · ${String(option.count)}` })),
    ],
    [result, t],
  )
  const kindChoices = useMemo(
    () => [{ id: '', label: t('market.all') }, ...KINDS.map(item => ({ id: item, label: t(KIND_LABEL[item]) }))],
    [t],
  )
  // 分类/类型筛选：只有它变化时才重建候选集。
  const scoped = useMemo(
    () => filterByCategory(result?.items ?? [], category).filter(item => kind === '' || (item.kind ?? 'unknown') === kind),
    [result, category, kind],
  )
  // 检索索引（小写字段 + 掩码）：**每次列表变化建一次**，绝不放进每键击路径。
  const searchable = useMemo(() => prepareMarketSearch(scoped), [scoped])
  const rows = useMemo(() => {
    const hits = searchMarket(searchable, query)
    // 有搜索词时用相关度顺序（searchMarket 已经排好：名称命中优先，其后按字段权重 + 星数），
    // 否则用契约排序：installed 恒在最前、方向键与比较器同源（marketToolbarModel.direction）。
    return hits === null ? sortRows(scoped, toolbar.sort, toolbar.descending) : hits
  }, [searchable, scoped, query, toolbar.sort, toolbar.descending])

  // 搜索 / 筛选 / 排序 / 索引刷新都会换一批结果：渲染量必须回到首屏水平，
  // 否则"切换一次就把一万多条全倒出来"，等于窗口形同虚设。
  useEffect(() => {
    setLimit(RENDER_BATCH)
  }, [query, category, kind, toolbar.sort, toolbar.descending, result])

  const shown = rows.length > limit ? rows.slice(0, limit) : rows
  const remaining = rows.length - shown.length

  // 触底自动再放一批；观察器不可用（旧浏览器/测试环境）或已达上限时，
  // footer 里的"加载更多"按钮是兜底入口——两条路都必须有，避免"滚了没反应"。
  useEffect(() => {
    if (remaining <= 0 || limit >= RENDER_MAX || typeof IntersectionObserver === 'undefined') return
    const node = sentinel.current
    if (node === null) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) {
        setLimit(previous => Math.min(previous + RENDER_BATCH, RENDER_MAX))
      }
    }, { rootMargin: '400px' })
    observer.observe(node)
    return () => { observer.disconnect() }
  }, [remaining, limit])

  const closeInstall = (): void => { setTarget(undefined); dismissInstallNotice() }

  /** 索引层提示：不可用（六跳全失败且无缓存）优先于过期（用的是旧缓存）。 */
  const indexNotice = useMemo(() => {
    if (result === undefined) return undefined
    const notes = result.notes ?? []
    if (result.source === 'empty') {
      return { unavailable: true, notes, text: t('market.unavailable', { reason: notes[0] ?? t('market.failedUnknown') }) }
    }
    if (result.stale === true) {
      return { unavailable: false, notes, text: t('market.stale', { at: formatRelative(t, result.generatedAt) }) }
    }
    return undefined
  }, [result, t])

  return (
    <div className={css.page}>
      <div className={css.rowBetween}>
        <h2 className={css.heading}>{t('market.title')}</h2>
        <Button
          variant="outline"
          size="sm"
          icon={<IconRefreshOutline14 />}
          disabled={loading}
          onClick={() => { loadMarketplace(true) }}
        >
          {loading ? t('market.refreshing') : t('market.refresh')}
        </Button>
      </div>
      {/* 这里原先渲染 market.intro（"社区索引里的插件、技能与预设。"）。删掉渲染点、**保留字典键**：
          那句话枚举的三个类型，类型筛选器上已经列着（KIND_LABEL 的 插件/技能/预设），属于"把屏幕上已有的元素又念一遍"；
          而且它还与事实不符——索引里并没有技能/预设的区分（kind 恒为 cordis-plugin），技能与预设是"技能与预设"页在管。
          键由 copy-dev 在 task-47 收口时连字典一起删；本文件已无引用。 */}
      {error === undefined && errorKey === undefined ? null : (
        <p className={css.error} role="status">
          {t('market.failed', { message: errorKey === undefined ? error ?? '' : t(errorKey) })}
        </p>
      )}

      <div className={css.filters}>
        <Input
          icon={<IconSearchOutline16 />}
          value={query}
          placeholder={t('market.search')}
          aria-label={t('market.search')}
          onChange={(event) => { setMarketQuery(event.target.value) }}
        />
        <PmSelect
          label={t('market.category')}
          placeholder={t('market.all')}
          value={category}
          options={categoryChoices}
          onChange={(id) => { setMarketCategory(id) }}
        />
        <PmSelect
          label={t('market.kind')}
          placeholder={t('market.all')}
          value={kind}
          options={kindChoices}
          onChange={(id) => { setMarketKind(id === '' ? '' : id as MarketItemKind) }}
        />
        <PmSelect
          label={t('market.sort')}
          placeholder={t('market.sort')}
          value={sort}
          options={sortOptions}
          onChange={(id) => {
            const next = id as MarketSort
            setSort(next)
            setDescending(next === 'az' || next === 'category' ? false : true)
          }}
        />
        <Tooltip label={t('market.sortDirection')}>
          <Button
            variant="outline"
            size="sm"
            aria-label={t('market.sortDirection')}
            icon={toolbar.direction === 'desc' ? <IconChevronDownOutline14 /> : <IconChevronUpOutline14 />}
            onClick={() => { setDescending(previous => !previous) }}
          >
            {t(MARKET_LABEL[toolbar.directionLabelKey])}
          </Button>
        </Tooltip>
        {result === undefined ? null : (
          <span className={css.meta}>
            {t('market.generatedAt', { at: formatRelative(t, result.generatedAt) })}
            {' · '}
            {result.cached ? t('market.cached') : t('market.fresh')}
          </span>
        )}
      </div>

      {/*
        P2：索引不可用 / 数据过期必须说出来。只给 cached 布尔值时，这三件事在界面上长得一模一样：
        「刚抓到的新索引」「用的是三天前的缓存」「六跳全失败」——用户会把后者读成"市场里没有这个插件"。
      */}
      {indexNotice === undefined ? null : (
        <div className={css.notice} role="status">
          <p className={css.error}>{indexNotice.text}</p>
          {indexNotice.notes.length === 0 ? null : (
            <ul className={css.gateList}>
              {indexNotice.notes.map(note => <li key={note} className={css.gateItem}>{note}</li>)}
            </ul>
          )}
          <Button variant="outline" size="sm" disabled={loading} onClick={() => { loadMarketplace(true) }}>
            {loading ? t('market.refreshing') : t('market.retry')}
          </Button>
        </div>
      )}

      {gateIssues.length === 0 && installError === undefined ? null : (
        <div className={css.notice} role="status">
          {installError === undefined ? null : <p className={css.error}>{t('market.installFailed', { message: installError })}</p>}
          {gateIssues.length === 0 ? null : (
            <>
              <span className={css.metaLabel}>{t('market.gateIssues')}</span>
              <ul className={css.gateList}>
                {gateIssues.map(issue => <li key={issue} className={css.gateItem}>{issue}</li>)}
              </ul>
            </>
          )}
        </div>
      )}

      {result === undefined && loading
        ? <p className={css.intro} role="status">{t('common.loading')}</p>
        : rows.length === 0
          // 索引不可用时上面已经说明了原因，这里不能再画"没有匹配的条目"——那是把故障画成空结果。
          ? <p className={css.intro}>{indexNotice?.unavailable === true ? t('market.unavailableHint') : t('market.empty')}</p>
          : (
        <ul className={css.list}>
          {shown.map((item) => {
            const tags = tagsOf(item)
            const overflow = tags.length - 8
            return (
              <li key={item.repo} className={css.card}>
                <div className={css.cardHead}>
                  <span className={css.name}>{item.name}</span>
                  <Tag tone="quiet">{t(KIND_LABEL[item.kind ?? 'unknown'])}</Tag>
                  {item.installed === true ? <Tag tone="neutral">{t('market.installed')}</Tag> : null}
                  {updateAvailable(item) ? <Tag tone="info">{t('market.updatable', { version: item.latestVersion ?? '' })}</Tag> : null}
                  {item.stars === null || item.stars === undefined ? null : <span className={css.meta}>{t('market.stars', { count: item.stars })}</span>}
                  {item.updatedAt === null || item.updatedAt === undefined ? null : (
                    <span className={css.meta}>{t('market.updatedAt', { at: formatRelative(t, item.updatedAt) })}</span>
                  )}
                </div>
                <p className={css.repoLine}>
                  <code className={css.repo}>{item.repo}</code>
                  <a className={css.link} href={`https://github.com/${item.repo}`} target="_blank" rel="noreferrer">
                    <IconGlobeOutline14 /> {t('market.openRepo')}
                  </a>
                </p>
                <p className={css.desc}>{item.description}</p>
                {tags.length === 0 ? null : (
                  <p className={css.topics}>
                    {tags.slice(0, 8).map(tag => (
                      <Tag key={`${tag.kind}:${tag.value}`} tone={tag.tone}>
                        {marketTagLabel(t, tag.kind, tag.value)}
                      </Tag>
                    ))}
                    {overflow <= 0 ? null : (
                      <Tooltip label={tags.slice(8).map(tag => marketTagLabel(t, tag.kind, tag.value)).join(' · ')}>
                        <span className={css.meta}>{t('market.moreTags', { count: overflow })}</span>
                      </Tooltip>
                    )}
                  </p>
                )}
                <div className={css.cardActions}>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={installing !== undefined || (item.installed === true && !updateAvailable(item))}
                    onClick={() => { dismissInstallNotice(); setTarget(item) }}
                  >
                    {installing === item.repo ? t('market.installing') : t('market.install')}
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {rows.length <= RENDER_BATCH ? null : (
        <div className={css.rowBetween} role="status">
          <span className={css.meta}>
            {remaining > 0
              ? t('market.window', { loaded: shown.length, total: rows.length })
              : t('market.windowAll', { total: rows.length })}
          </span>
          {remaining <= 0 || limit >= RENDER_MAX ? null : (
            <>
              <div ref={sentinel} className={css.sentinel} aria-hidden="true" />
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setLimit(previous => Math.min(previous + RENDER_BATCH, RENDER_MAX)) }}
              >
                {t('market.loadMore')}
              </Button>
            </>
          )}
          {remaining > 0 && limit >= RENDER_MAX
            ? <span className={css.metaLabel}>{t('market.windowCap')}</span>
            : null}
        </div>
      )}

      <Modal
        open={target !== undefined}
        onClose={closeInstall}
        title={t('market.installTitle', { name: target?.name ?? '' })}
        description={t('market.installDesc')}
        closeLabel={t('common.close')}
        footer={(
          <>
            <Button variant="ghost" size="md" onClick={closeInstall}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              size="md"
              disabled={target === undefined || installing !== undefined}
              onClick={() => {
                // spec 由 host 决定（MarketItem.installSpec），这里只转发——客户端不拼字符串。
                if (target !== undefined) installMarketItem({ repo: target.repo, name: target.name, installSpec: target.installSpec })
                setTarget(undefined)
              }}
            >
              {t('market.install')}
            </Button>
          </>
        )}
      >
        <p className={css.desc}>{target === undefined ? '' : target.repo}</p>
      </Modal>

      {toast === undefined ? null : (
        <Toast key={toast.seq} text={toast.text} onDone={() => { setToast(undefined) }} />
      )}
    </div>
  )
}

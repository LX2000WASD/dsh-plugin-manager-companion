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
 */

import { useEffect, useMemo, useState } from 'react'
import {
  Button, IconChevronDownOutline14, IconChevronUpOutline14, IconGlobeOutline14, IconRefreshOutline14,
  IconSearchOutline16, Input, Modal, Tag, Toast, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { categoryOptions, filterByCategory, marketToolbarModel, sortRows, tagsOf, updateAvailable, type MarketSort } from '../marketView.ts'
import { fuzzyFilter } from '../rank.ts'
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
  const rows = useMemo(() => {
    const scoped = filterByCategory(result?.items ?? [], category)
      .filter(item => kind === '' || (item.kind ?? 'unknown') === kind)
    const hits = fuzzyFilter(scoped, item => item.name, query)
    // 有搜索词时用相关度顺序（fuzzyFilter 已经排好），否则用契约排序：
    // installed 恒在最前、方向键与比较器同源（marketToolbarModel.direction）。
    return hits === null ? sortRows(scoped, toolbar.sort, toolbar.descending) : hits.map(hit => hit.item)
  }, [result, category, kind, query, toolbar.sort, toolbar.descending])

  const closeInstall = (): void => { setTarget(undefined); dismissInstallNotice() }

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
      <p className={css.intro}>{t('market.intro')}</p>
      {error === undefined ? null : <p className={css.error} role="status">{t('market.failed', { message: error })}</p>}

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

      {rows.length === 0 ? <p className={css.intro}>{t('market.empty')}</p> : (
        <ul className={css.list}>
          {rows.map((item) => {
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
                if (target !== undefined) installMarketItem({ repo: target.repo, name: target.name })
                setTarget(undefined)
              }}
            >
              {t('market.install')}
            </Button>
          </>
        )}
      >
        <p className={css.desc}>{target === undefined ? '' : target.repo}</p>
        <p className={css.meta}>{t('market.installDesc')}</p>
      </Modal>

      {toast === undefined ? null : (
        <Toast key={toast.seq} text={toast.text} onDone={() => { setToast(undefined) }} />
      )}
    </div>
  )
}

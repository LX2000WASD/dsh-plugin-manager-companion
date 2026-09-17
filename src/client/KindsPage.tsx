/**
 * KindsPage — 技能与预设：本插件安装过的 SKILL.md / agent.cordis.yml 资源清单与卸载。
 *
 * 归属：A 类·重写（旧 src/client 的 Kinds 相关交互只作意图参考：列表 + 卸载确认；
 *   未复制代码）。
 * 旧实现参考：dsh-web-plugin-manager/src/client/*（旧的技能/预设面板）。
 * 官方复用：@deepseek-ai/dsh-client-ui-primitives（Button/Tag/RiskConfirmation/Toast/Tooltip）
 *   + RiskConfirmation 作为破坏性操作的确认面；数据来自自有 REST 的 listKinds / uninstallKind。
 * 前提检查：旧实现自己扫磁盘并自己删目录；现在扫描与删除都在 host（task-4 的
 *   kinds 管道），客户端只渲染与触发，破坏性动作必须显式勾选确认。
 */

import { useEffect, useState } from 'react'
import {
  Button, IconRefreshOutline14, IconTrashOutline16, RiskConfirmation, Tag, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { InstalledKind } from '../types.ts'
import { NS } from './locales.ts'
import {
  KIND_LABEL, formatRelative,
  type CompanionSlotProps, type KindsFace, type KindsState,
} from './shared.ts'
import css from './KindsPage.module.css'

/** 本文件里 t 的键域（本插件字典）。 */
type T = TranslateNS<typeof NS>

/** 技能与预设页的注册项 props。 */
export type KindsPageProps = CompanionSlotProps<'settings.section', KindsFace>

/**
 * 渲染技能与预设页。
 *
 * @param props - 字典座位、记录选择器与卸载动作。
 * @returns 技能与预设页。
 */
export function KindsPage({ t, useKinds, loadKinds, uninstallKind }: KindsPageProps) {
  const records = useKinds((state: KindsState) => state.records)
  const orphans = useKinds((state: KindsState) => state.orphans)
  const loading = useKinds((state: KindsState) => state.loading)
  const error = useKinds((state: KindsState) => state.error)
  const busy = useKinds((state: KindsState) => state.busy)
  const notice = useKinds((state: KindsState) => state.notice)
  const [target, setTarget] = useState<InstalledKind>()
  const [acknowledged, setAcknowledged] = useState(false)
  const [toast, setToast] = useState<{ text: string; seq: number }>()
  const load = loadKinds

  useEffect(() => { load() }, [load])
  useEffect(() => { if (notice !== undefined && notice !== '') setToast({ text: notice, seq: Date.now() }) }, [notice])

  return (
    <div className={css.page}>
      <div className={css.rowBetween}>
        <h2 className={css.heading}>{t('kinds.title')}</h2>
        <Button
          variant="outline"
          size="sm"
          icon={<IconRefreshOutline14 />}
          disabled={loading}
          onClick={() => { load() }}
        >
          {loading ? t('common.loading') : t('kinds.refresh')}
        </Button>
      </div>
      <p className={css.intro}>{t('kinds.intro')}</p>
      {error === undefined ? null : <p className={css.error} role="status">{t('kinds.failed', { message: error })}</p>}
      {records.length === 0 && !loading ? <p className={css.intro}>{t('kinds.empty')}</p> : null}

      <ul className={css.list}>
        {records.map((record) => (
          <li key={`${record.kind}:${record.repo}`} className={css.card}>
            <div className={css.cardHead}>
              <span className={css.name}>{record.repo}</span>
              <Tag tone="quiet">{t(KIND_LABEL[record.kind])}</Tag>
              <span className={css.meta}>{t('kinds.installedAt', { at: formatRelative(t, record.installedAt) })}</span>
            </div>
            <div className={css.metaRow}>
              <span className={css.metaLabel}>{t('kinds.dir')}</span>
              <code className={css.path}>{record.dir}</code>
              {record.commit === undefined ? null : (
                <>
                  <span className={css.metaLabel}>{t('kinds.commit')}</span>
                  <code className={css.path}>{record.commit}</code>
                </>
              )}
            </div>
            <div className={css.cardActions}>
              <Button
                variant="outline"
                size="sm"
                icon={<IconTrashOutline16 />}
                disabled={busy !== undefined}
                onClick={() => { setAcknowledged(false); setTarget(record) }}
              >
                {t('kinds.uninstall')}
              </Button>
            </div>
          </li>
        ))}
      </ul>

      {orphans.length === 0 ? null : (
        <div className={css.orphans}>
          <h3 className={css.cardTitle}>{t('kinds.orphans')}</h3>
          <p className={css.intro}>{t('kinds.orphansHint')}</p>
          <ul className={css.list}>
            {orphans.map(dir => (
              <li key={dir} className={css.card}>
                <code className={css.path}>{dir}</code>
              </li>
            ))}
          </ul>
        </div>
      )}

      <RiskConfirmation
        open={target !== undefined}
        title={t('kinds.uninstallTitle', { repo: target?.repo ?? '' })}
        description={t('kinds.uninstallDesc')}
        acknowledgeLabel={t('kinds.acknowledge')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('common.close')}
        confirmLabel={t('kinds.uninstall')}
        acknowledged={acknowledged}
        disabled={busy !== undefined || target === undefined}
        onAcknowledgedChange={setAcknowledged}
        onCancel={() => { setTarget(undefined) }}
        onConfirm={() => {
          if (target !== undefined) uninstallKind(target.repo)
          setTarget(undefined)
        }}
      />

      {toast === undefined ? null : (
        <Toast key={toast.seq} text={toast.text} onDone={() => { setToast(undefined) }} />
      )}
    </div>
  )
}

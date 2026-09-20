/**
 * OfficialSlots — 在官方插件页里注册本插件的卡片与配置面（"点开即可管理"）。
 *
 * 归属：A 类·重写（旧仓库用遮蔽注册抢官方插件的 tab，前提已消失）。
 * 旧实现参考：dsh-web-plugin-manager/src/client/*（旧做法是注册 settings.plugins.tab
 *   把官方只读清单挤掉；新做法是**作为注册方**接入官方声明的 slot，不遮蔽任何东西）。
 * 官方复用：官方 slot 契约（镜像见 shared.ts 的 SlotMap 声明）+ 官方插件页的
 *   `plugins.item` / `plugins.bundle.config`（owner props: view = summary | page）；
 *   配置表单复用 ConsolePage 的 ConfigPanel（与设置子页同一份官方 settings 文档）。
 * 前提检查：官方页面声明这三个 slot 并要求"注册方与页面同生"——注册只在该行启用
 *   期间存在，组合包关闭时不显示配置控件是预期行为，这里不绕。
 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import { ConfigPanel } from './ConsolePage.tsx'
import type { CompanionSlotProps, ConsoleFace } from './shared.ts'
import css from './OfficialSlots.module.css'

/** 本文件里 t 的键域（本插件字典）。 */
type T = TranslateNS<typeof NS>

/** 官方 `plugins.item` 卡片与 `plugins.bundle.config` 配置面共用的注册项 props。 */
export type CompanionOfficialProps =
  | CompanionSlotProps<'plugins.item', ConsoleFace>
  | CompanionSlotProps<'plugins.bundle.config', ConsoleFace>

/** 官方插件页为我们声明的 owner props 只有 view 一个字段；两处形状一致。 */
interface ViewProps {
  readonly t: T
  readonly view: 'summary' | 'page'
}

/**
 * 渲染本插件在官方插件页里的两个视图。
 *
 * summary：标题下的一句话（卡片与详情页顶部都用它）。
 * page：带自己保存控件的配置表单——与「设置 → 环境控制台 → 设置」是同一份文档。
 *
 * @param props - 官方页面传入的 view + 框架绑定的注入面 + 字典座位。
 * @returns 对应视图的节点。
 */
export function CompanionOfficialItem(props: CompanionOfficialProps & ViewProps) {
  const { t, view } = props
  if (view !== 'page') return <p className={css.summary}>{t('official.summary')}</p>
  return (
    <div className={css.page}>
      <ConfigPanel
        t={props.t}
        // 这里是官方插件页：容器语法与设置页子页**不同**（官方自己的配置表单靠分隔线分组、
        // 一个边框都没有）。同一份组件、同一份字段与校验，只切分组容器的画法（task-105）。
        variant="plugin-page"
        useConfig={props.useConfig}
        useTrial={props.useTrial}
        actions={{
          editConfigField: props.editConfigField,
          saveConfig: props.saveConfig,
          discardConfig: props.discardConfig,
        }}
        trialActions={{
          loadTrial: props.loadTrial,
          removeTrialEnvironment: props.removeTrialEnvironment,
          cleanupTrialEnvironments: props.cleanupTrialEnvironments,
        }}
      />
    </div>
  )
}

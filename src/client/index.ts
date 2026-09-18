/**
 * 客户端入口 — 字典、三个一级设置入口，以及官方插件页内的注册面。
 *
 * 归属：A 类·重写（旧仓库的客户端入口把 27 个 op 的 SDK、路由、状态与页面装配
 *   都塞在一个文件里；这里只做装配）。
 * 旧实现参考：dsh-web-plugin-manager/src/client/index.ts（理解"一个入口 + 若干子页"
 *   的组织方式；未复制代码）。
 * 官方复用：ctx.locale.register（字典）、ctx.slots.inject + ctx.slots.register（设置入口
 *   与官方插件页 slot）、ctx.settingsScope.bind（配置读写，经 ConfigController）。
 * 前提检查：官方 settings.section 已存在且 order 约定为
 *   general=0 / models=10 / plugins=15 / agent-presets=20 / archived-sessions=25，
 *   所以本插件用 16 / 17 / 22 插在 plugins 之后、archived-sessions 之前。
 *
 * 硬约束：不注册任何名为 pluginManager 的服务；不遮蔽官方任何页面（旧仓库的
 * `settings.plugins.tab` 抢占已删除）；官方插件页只作为注册方接入。
 */

/// <reference path="./css-modules.d.ts" />
// tsconfig.client.json 只 include 本文件，所以 *.module.css 的环境声明必须由这里
// 显式引用，否则 tsc 会报 "Cannot find module './X.module.css'"。

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// 类型专用：拉起 locale / renderer / settings 三个包的 Context 合并
// （ctx.locale、ctx.slots、ctx.settingsScope）。运行时不 import 它们——跨插件取值
// 走 cordis 服务，客户端的模块表只共享平台种子里的九个包。
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { CompanionConfig } from '../settings.ts'
import { ConsolePage, createConsoleStore } from './ConsolePage.tsx'
import { KindsPage } from './KindsPage.tsx'
import { MarketplacePage } from './MarketplacePage.tsx'
import { CompanionOfficialItem } from './OfficialSlots.tsx'
import { NS, en, zh } from './locales.ts'
import {
  ConfigController, EnvironmentsController, HealthController, KindsController, MarketplaceController,
  SETTINGS_NAMESPACE,
  type ConsoleFace,
} from './shared.ts'

/** 本插件依赖的客户端服务：注册面、字典与 t 座位、配置读写。 */
export const inject = ['slots', 'locale', 'settingsScope']

/** 官方插件页里本插件条目的 id（与官方宿主侧配置页的 id 不冲突）。 */
const OFFICIAL_ITEM_ID = 'companion'

/**
 * 装配客户端：字典 → 三个一级设置入口 → 官方插件页内的注册面。
 *
 * @param ctx - 浏览器侧 cordis 上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'plugin-manager-companion: dictionaries')
  const t = ctx.locale.bind(NS)

  const healthFace = new HealthController().inject()
  const environmentsFace = new EnvironmentsController().inject()
  const configFace = new ConfigController(
    ctx.settingsScope.bind<CompanionConfig>({ namespace: SETTINGS_NAMESPACE }),
  ).inject()
  const marketplaceFace = new MarketplaceController().inject()
  const kindsFace = new KindsController().inject()

  // 一个入口、三个子页面，所以只有一份注入面：三个控制器的 hooks 隔间合在一个
  // 对象里（框架据此合成 useHealth / useEnvironments / useConfig 三个选择器）。
  const consoleFace = (): ConsoleFace => ({
    hooks: {
      health: healthFace.hooks.health,
      environments: environmentsFace.hooks.environments,
      config: configFace.hooks.config,
    },
    diagnose: healthFace.diagnose,
    fix: healthFace.fix,
    setDiagnosticTarget: healthFace.setDiagnosticTarget,
    refreshEnvironments: environmentsFace.refreshEnvironments,
    startEnvironment: environmentsFace.startEnvironment,
    stopEnvironment: environmentsFace.stopEnvironment,
    createEnvironment: environmentsFace.createEnvironment,
    renameEnvironment: environmentsFace.renameEnvironment,
    removeEnvironment: environmentsFace.removeEnvironment,
    copyPlugins: environmentsFace.copyPlugins,
    exportBackup: environmentsFace.exportBackup,
    loadBackup: environmentsFace.loadBackup,
    diffBackup: environmentsFace.diffBackup,
    restoreBackup: environmentsFace.restoreBackup,
    dismissEnvironmentNotice: environmentsFace.dismissEnvironmentNotice,
    editConfigField: configFace.editConfigField,
    saveConfig: configFace.saveConfig,
    discardConfig: configFace.discardConfig,
  })

  // 一级入口 1：插件市场（order 16，紧跟官方 plugins=15）。
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'marketplace',
    order: 16,
    label: () => t('nav.marketplace'),
    locale: NS,
    inject: () => marketplaceFace,
  }, MarketplacePage))

  // 一级入口 2：环境控制台（order 17；体检 / 环境 / 设置三个本地子页面）。
  // 子页选择走声明的 store（句柄在这里创建，模块级不放句柄）：任何一次 store 发布或条目
  // 重挂载都不能把用户从「环境」子页弹回「体检」——结果块就在那个子页里。
  const consoleStore = createConsoleStore()
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'console',
    order: 17,
    label: () => t('nav.console'),
    locale: NS,
    store: consoleStore,
    inject: consoleFace,
  }, ConsolePage))

  // 一级入口 3：技能与预设（order 22，插在官方 agent-presets=20 之后）。
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'kinds',
    order: 22,
    label: () => t('nav.kinds'),
    locale: NS,
    inject: () => kindsFace,
  }, KindsPage))

  // 官方插件页：我们自己的条目卡片（label 走字典；官方页面自己把它列进 Official 组）。
  ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item',
    id: OFFICIAL_ITEM_ID,
    order: 10,
    label: () => t('official.title'),
    locale: NS,
    inject: consoleFace,
  }, CompanionOfficialItem))

  // 官方插件页：本组合包的配置面，key 用我们自己的包名——
  // 官方 PluginManagerPage 的 configured = ledger.bundles.has(openPkg.name)，
  // 所以只有本包作为组合包安装并启用时，这一节才出现（这是预期行为，不绕）。
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: 'dsh-plugin-manager-companion',
    locale: NS,
    inject: consoleFace,
  }, CompanionOfficialItem))
}

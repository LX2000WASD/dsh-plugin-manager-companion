/**
 * index.ts — 客户端入口：字典、三个一级设置入口，以及官方插件页内的注册面。
 *
 * 归属：A 类·重写（旧仓库的客户端入口把 27 个 op 的 SDK、路由、状态与页面装配
 *   都塞在一个文件里；这里只做装配）。
 * 旧实现参考：dsh-web-plugin-manager/src/client/index.ts（理解"一个入口 + 若干子页"的
 *   组织方式；未复制代码）。
 * 官方复用：ctx.locale.register（字典）、ctx.slots.inject + ctx.slots.register（设置入口
 *   与官方插件页 slot）、ctx.settingsScope.bind（配置读写，经 ConfigController）、
 *   ctx.get('remote').pluginManager.listBundles（已装集合的 live 台账，用于升级行的注册对账）。
 * 前提检查：官方 settings.section 已存在且 order 约定为
 *   general=0 / models=10 / plugins=15 / agent-presets=20 / archived-sessions=25，
 *   所以本插件用 16 / 17 / 22 插在 plugins 之后、archived-sessions 之前。
 *
 * 硬约束：不注册任何名为 pluginManager 的服务；不遮蔽官方任何页面（旧仓库的
 *   `settings.plugins.tab` 抢占已删除）；官方插件页只作为注册方接入，**不做 DOM 注入**。
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
import { AboutPage, createAboutStore, type AboutConsoleFace } from './AboutPage.tsx'
import { ConsolePage, createConsoleStore } from './ConsolePage.tsx'
import { KindsPage } from './KindsPage.tsx'
import { MarketplacePage } from './MarketplacePage.tsx'
import { CompanionOfficialItem } from './OfficialSlots.tsx'
import { createUpgradeRowComponent, type UpgradeRowProps } from './UpgradeRow.tsx'
import { NS, en, zh } from './locales.ts'
import {
  AboutController, ConfigController, EnvironmentsController, HealthController, KindsController,
  MarketplaceController, SETTINGS_NAMESPACE, TrialController, UpgradeController,
  type ConsoleFace, type MarketplaceConsoleFace, type UpgradeFace, type UpgradeState,
} from './shared.ts'
import { registeredNames } from '../upgradeView.ts'

/** 本插件依赖的客户端服务：注册面、字典与 t 座位、配置读写。 */
export const inject = ['slots', 'locale', 'settingsScope']

/** 官方插件页里本插件条目的 id（与官方宿主侧配置页的 id 不冲突）。 */
const OFFICIAL_ITEM_ID = 'companion'

/**
 * 本插件自己的包名。
 *
 * 升级行的对账**排除**它：它自己的页面已经由下面的 `plugins.bundle.config` 注册占用
 * （官方 keyed slot 同一 key 同优先级再注册会抛 "already has an entry"），而自我升级
 * 按 REST-CONTRACT §升级动作的客户端约束是「关于 → 软件升级」那个批量视图的活（另一个任务）。
 * 排除是刻意的，不是漏了。
 */
const OUR_PACKAGE = 'dsh-plugin-manager-companion'

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
  const trialFace = new TrialController().inject()
  const upgradeController = new UpgradeController()
  // 「关于」页（task-95）：纯读事实，无写动作。
  const aboutController = new AboutController()
  const upgradeFace = upgradeController.inject()

  // 一个入口、三个子页面，所以只有一份注入面：三个控制器的 hooks 隔间合在一个
  // 对象里（框架据此合成 useHealth / useEnvironments / useConfig 三个选择器）。
  const consoleFace = (): ConsoleFace => ({
    hooks: {
      health: healthFace.hooks.health,
      environments: environmentsFace.hooks.environments,
      config: configFace.hooks.config,
      trial: trialFace.hooks.trial,
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
    loadTrial: trialFace.loadTrial,
    removeTrialEnvironment: trialFace.removeTrialEnvironment,
    cleanupTrialEnvironments: trialFace.cleanupTrialEnvironments,
  })

  // 一级入口 1：插件市场（order 16，紧跟官方 plugins=15）。
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'marketplace',
    order: 16,
    label: () => t('nav.marketplace'),
    locale: NS,
    // 市场页也要升级面：已装条目的卡片上那个「升级到 x.y.z」用的就是同一份检查结果与同一个动作。
    // 返回类型显式写出来（而不是让 TS 从交叉类型推导）：官方 PropsHooks 的映射类型在
    // 推导出来的交叉 hooks 上会失效，编译期报 useMarketplace 缺失。
    inject: (): MarketplaceConsoleFace => ({
      ...marketplaceFace,
      ...upgradeFace,
      // hooks 是**一个记录**，两个面各带一个成员：展开会把后一个盖掉前一个（实测编译报
      // "Property 'marketplace' is missing"），所以这里显式合成。
      hooks: { marketplace: marketplaceFace.hooks.marketplace, upgrade: upgradeFace.hooks.upgrade },
    }),
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

  // 一级入口 4：「关于」（order 100）。
  //
  // 为什么用 100：官方现有 0/10/15/20/25，我们 16/17/22——用一个远端正数把"最后一位"
  // 这个意图**编码进数值**（而不是靠"当前没人用 30"这种会过期的假设）。
  // 官方 navIcon 对未知 id 回落到齿轮图标，这是预期，不绕。
  const aboutStore = createAboutStore()
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'about',
    order: 100,
    label: () => t('nav.about'),
    locale: NS,
    store: aboutStore,
    // 注入面 = 关于页自己的面 + 升级面：软件升级子页直接复用 UpgradeRow / UpgradeResult，
    // 那套已经承载四态、dist-tags 选择、金丝雀四态与结果四档（task-74/87），这一页不重造。
    inject: (): AboutConsoleFace => {
      const own = aboutController.inject()
      return {
        // hooks 必须**显式合并**：两个面的 `hooks` 是各自的对象，展开后者会整个覆盖前者
        // （upgradeFace 的 hooks 里只有 upgrade）。这个坑在 MarketplaceConsoleFace 上已经踩过一次。
        hooks: { ...own.hooks, ...upgradeFace.hooks },
        loadAbout: own.loadAbout,
        ensureUpgrades: upgradeFace.ensureUpgrades,
        loadUpgrades: upgradeFace.loadUpgrades,
        upgradePackage: upgradeFace.upgradePackage,
        rollbackPackage: upgradeFace.rollbackPackage,
        dismissUpgradeNotice: upgradeFace.dismissUpgradeNotice,
      }
    },
  }, AboutPage))

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
    key: OUR_PACKAGE,
    locale: NS,
    inject: consoleFace,
  }, CompanionOfficialItem))

  // ── 升级行：按包名注册到 plugins.bundle.config（主落点）────────────────────
  //
  // 官方插件页只有三个槽位，卸载按钮与启用开关在 DetailTop 的 actions 里**没有槽位**，
  // 所以"加在删除旁边"做不到，也不许 DOM 注入（docs/REST-CONTRACT.md §升级动作的客户端约束）。
  // keyed slot 的 key 就是包名：打开该包自己的页面就能看到这一行。
  //
  // **实时对账**（DESIGN §5.5）：已装集合或检查结果一变，注册集合跟着变；register() 的
  // disposer 按需释放，撤掉 key 那一节**当场消失**（官方 config-ledger 跟着 slot 版本重算）。
  // **不留孤儿 key**：否则将来同名包重装会带着旧数据冒出来。
  //
  // 台账读在 **ctx.inject 的作用域里**（不是 apply 的根 ctx）：
  // `remote.pluginManager` 是一个独立的 cordis 服务，只有在**声明了它**的作用域里才解析得到。
  // 用根 ctx 的 `ctx.get('remote.pluginManager')` 真机实测恒为 undefined（fetch 记录证明
  // 官方页面自己在调 /api/pluginManager/listBundles，而我们的调用一次都没发出）——
  // 症状就是"直接打开官方插件页时升级行永远不出现"。
  // ctx.inject 在服务就绪后回调，因此这里既拿到了服务，也顺带解决了"装配期命名空间还没挂上"。
  ctx.inject(['slots', 'remote.pluginManager'], (scoped: ClientContext) => {
    scoped.slots.inject('plugins.bundle.config', () => reconcileUpgradeRows(scoped, upgradeController, upgradeFace))
  })
}

// ── 升级行的注册对账 ─────────────────────────────────────────────────────

/**
 * 官方 pluginManager 台账里本模块用到的最小面（用本地接口而不是 import 官方类型：
 * 该包不在本仓库的安装集里，客户端只通过 ctx 服务读它）。
 */
interface BundleLedger {
  listBundles(): Promise<{
    readonly ok: boolean
    readonly value: readonly { readonly name: string; readonly installed: boolean }[]
  }>
}

/**
 * 读官方 Remote 的两个面。
 *
 * **两个面按各自的服务名取**（真机实测踩过，不是理论担忧）：
 * `pluginManager` 是 cordis 服务名 `remote.pluginManager`（api-gateway 的 createNamespace
 * 用 `ownerCtx.plugin({ name: remoteServiceKey(name) })` 注册的**独立服务**），
 * 它**不是** `remote` 服务对象上的一个属性。第一版写成 `ctx.get('remote').pluginManager`，
 * 于是真机里恒为 undefined（单测的桩件上恰好有那个属性，所以测试全绿）——
 * 症状是"直接打开官方插件页时升级行永远不出现"。
 *
 * 这一层仍用 `ctx.get` 做**兜底读取**（`ctx.remote` 亦可，两者都试）：
 * 调用方 {@link reconcileUpgradeRows} 已经把 ctx.inject 的声明作为首选路径
 * （那才是 cordis 认可的服务可见性手段）。这里保留 get 是为了让"服务在但取法不同"
 * 这种宿主差异不至于让整块功能消失——读不到就如实降级，不影响本插件其余部分。
 *
 * @param ctx - 已注入 `remote.pluginManager` 的客户端上下文。
 * @returns 台账与事件订阅面；各自读不到时那一项为 undefined。
 */
function remoteOf(ctx: ClientContext): {
  readonly pluginManager?: BundleLedger
  readonly $on?: (event: string, listener: () => void) => () => void
} {
  const holder = ctx as {
    get?: (name: string) => unknown
    remote?: { readonly pluginManager?: BundleLedger; readonly $on?: (event: string, listener: () => void) => () => void }
  }
  // 台账：服务名就是 `remote.pluginManager`（嵌套路径由 cordis 的服务表解析）。
  const ledger = holder.get?.('remote.pluginManager') ?? holder.remote?.pluginManager
  // 事件：`$on` 是 `remote` 服务自己的方法。
  const events = holder.get?.('remote') ?? holder.remote
  const $on = typeof events === 'object' && events !== null
    ? (events as { $on?: (event: string, listener: () => void) => () => void }).$on
    : undefined
  return {
    ...typeof ledger === 'object' && ledger !== null ? { pluginManager: ledger as BundleLedger } : {},
    ...typeof $on === 'function' ? { $on: $on.bind(events) } : {},
  }
}

/**
 * 把升级行的注册集合与"当前已装 + 已检查"对账。
 *
 * 四条纪律，缺一条就会留下孤儿 key 或漏注册：
 *   1. **只注册要显示的包**（registeredNames：up-to-date 不注册 —— §5.5 插件页不显示）；
 *   2. **多退少补**：目标集合里没有的 key 立刻 disposer 释放，新增的当场注册；
 *   3. **随源变化重跑**：升级状态每次发布、官方台账每次变化都重跑一次对账；
 *   4. **台账读不到不清空**："读不到已装集合"不等于"什么都没装"，清空会让用户正在看的
 *      升级入口无故消失；此时退回用检查结果里的单元名（那份事实同样来自宿主读盘）。
 *
 * 排除了本插件自身（见 {@link OUR_PACKAGE} 的说明）。
 *
 * @param ctx - 客户端上下文。
 * @param controller - 升级控制器（读检查结果）。
 * @param face - 升级注入面（交给每个注册项）。
 * @returns 对账控制器的 disposer（撤掉全部行、订阅与首次请求）。
 */
function reconcileUpgradeRows(
  ctx: ClientContext,
  controller: UpgradeController,
  face: UpgradeFace,
): () => void {
  /** key → 该行的 disposer。 */
  const live = new Map<string, () => void>()
  /** 最近一次成功读到的官方已装集合；读不到时保持 undefined（见纪律 4）。 */
  let ledgerInstalled: readonly string[] | undefined
  let disposed = false

  const sync = (): void => {
    if (disposed) return
    const state = controller.snapshot()
    const units = state.check?.units
    // 台账读不到时退回"检查结果里的单元名"：那份事实是宿主读 profile manifest 得到的，
    // 与官方 listBundles 的 installed 同源；用它至少能保证"查过的包"都还在。
    const installed = ledgerInstalled ?? (units ?? []).map(unit => unit.name)
    // 还没被处置的结果把它的包名钉在注册集合里：否则升级成功后的重查会把它判成 up-to-date、
    // 撤掉 key，于是刚写下的结果跟着那一节一起消失（真机实测，见 registeredNames 的 keep 说明）。
    const pending = [state.action?.name, state.rollback?.name].filter((name): name is string => name !== undefined)
    const wanted = registeredNames(installed, units, pending).filter(name => name !== OUR_PACKAGE)
    const wantedSet = new Set(wanted)
    // 多退：目标集合里没有的，立刻释放（官方 config-ledger 跟着重算，那一节当场消失）。
    for (const [key, dispose] of [...live]) {
      if (wantedSet.has(key)) continue
      live.delete(key)
      dispose()
    }
    // 少补：新出现的包名当场注册。
    for (const name of wanted) {
      if (live.has(name)) continue
      live.set(name, ctx.slots.register({
        name: 'plugins.bundle.config',
        key: name,
        locale: NS,
        inject: () => face,
      }, createUpgradeRowComponent(name) as never))
    }
  }

  // 源 1：升级状态（每次检查结果发布都重跑）。
  const unsubscribe = face.hooks.upgrade.subscribe(sync)

  /**
   * 重读官方台账，取**官方插件页会列出的那批包名**。
   *
   * 刻意**不**按 `installed === true` 过滤：那个字段的语义是"在 profile 的 dependencies 里"
   * （官方 listBundles：`const installed = dependencies.includes(name)`），而升级的**第 2 类**
   * （安装方提供的层）恰恰是"在层栈里、不在 dependencies 里"——按 installed 过滤会把
   * not-upgradable 这一态整个漏掉，而它正是契约里点名的四态之一。
   *
   * 取全部名字，让 {@link registeredNames} 按四态决定要不要注册。多余的 key 是**惰性的**：
   * 官方页面只为它真正渲染的包调用 renderSlot(..., { entryKey: pkg.name })，没有派发点的 key
   * 不会画出任何东西。
   *
   * 读失败时不改 `ledgerInstalled`（保持上一次或 undefined），也不报错上屏——
   * 升级行是增强面，一次台账抖动不该把用户正在看的入口清空。
   *
   * @returns 这次是否真的读到了台账。
   */
  const readLedger = async (): Promise<boolean> => {
    const ledger = remoteOf(ctx)?.pluginManager
    if (ledger === undefined) return false
    try {
      const result = await ledger.listBundles()
      if (disposed || !result.ok) return false
      ledgerInstalled = result.value.map(bundle => bundle.name)
      sync()
      return true
    } catch {
      // 台账读不到不是致命错误（纪律 4）：保持上一次的集合。
      return false
    }
  }

  /**
   * 首次读台账：**失败要重试**（有界）。
   *
   * 为什么必须有重试（真机实测的缺陷，不是理论担忧）：apply 是同步装配，那一刻官方 Remote
   * 的 `pluginManager` 命名空间**可能还没挂上**（它由 api-gateway 的贡献按自己的节奏 mount）。
   * 一次读失败就放弃的后果很具体：用户**直接打开官方插件页**（没先去过市场页）时，
   * 注册集合恒为空 → 升级行永远不出现，而界面上没有任何提示说明为什么。
   * 对照实验：先打开市场页再回插件页就正常——因为市场页的进入即查落了检查结果，
   * 对账退回用单元名，于是注册发生。两条路都必须是通的。
   *
   * 退避 300ms 起、上限 8 次（约 4 秒）：足够覆盖命名空间挂载，又不会无限占着一个定时器。
   * 期间任何一次成功即停；被 dispose 时立刻停。
   */
  const refreshInstalled = async (): Promise<void> => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (disposed) return
      if (await readLedger()) return
      await new Promise(resolve => { setTimeout(resolve, 300 * (attempt + 1)) })
    }
  }

  /**
   * 台账变化后的重新对账。
   *
   * 两件事，顺序不能反：**先把已装集合刷新**（官方 listBundles 是权威事实），
   * **再让 host 重取一次版本事实**（新装的包要拿到它自己的四态）。反过来会出现
   * "注册表按旧集合算"——新装的包这一轮进不了注册面。
   */
  const onLedgerChanged = (): void => {
    void refreshInstalled().then(() => { face.loadUpgrades(false) })
  }

  // 源 2：官方台账变化（装/卸/启停都会推 plugin-manager/changed；重连推 connection/reset）。
  // 这里用 loadUpgrades(false) 而不是 ensureUpgrades()：台账**确实变了**，那不是"进入即查"
  // 的重复触发，而是"已装集合变了所以版本事实要重取"（host 侧仍有 TTL 与负缓存兜着，
  // 不会真的每次都出网）。真正的"进入即查"由渲染期的 ensureUpgrades 负责。
  const remote = remoteOf(ctx)
  const offChanged = remote?.$on?.('plugin-manager/changed', onLedgerChanged) ?? (() => {})
  const offReset = remote?.$on?.('connection/reset', onLedgerChanged) ?? (() => {})

  // 装配期**不**发检查请求：apply 是同步的装配步骤，而"进入即查"的语义是"用户打开页面时"。
  // 在装配期发一次会让每个加载了本插件的 profile 一启动就出一趟网——实测代价是
  // client-render 的"认不出裸 id 就不会轮询"用例当场红（calls 的第一项变成了 upgradeCheck），
  // 因为那个用例只给 diagnose 挂了桩件。
  // 台账**读取**不联网、也不产生 op 调用，装配期读一次没问题（它决定注册面有没有内容）。
  void refreshInstalled()

  return () => {
    disposed = true
    unsubscribe()
    offChanged()
    offReset()
    for (const dispose of live.values()) dispose()
    live.clear()
  }
}

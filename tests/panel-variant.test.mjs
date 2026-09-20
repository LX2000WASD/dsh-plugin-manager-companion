/**
 * 配置面板的**容器语法按页面切**（task-105，跑 dist/client.js + React SSR）。
 *
 * 守护的缺陷：本插件的配置表单（质量门 / 诊断分层 / 市场 / 试装四组）被同时注册到
 * 两个位置——设置页子页（`settings.section` 的 console 入口）与官方插件页
 * （`plugins.bundle.config` / `plugins.item` 的 page 视图）。两处的页面语法不同：
 *   · 设置页：内嵌面板，分组容器是**卡片**（边框 + 圆角 + 底色）；
 *   · 官方插件页：分节 + 行列表，官方自己的配置表单
 *     （ui-settings-plugins/fields.module.css）是 `.field{padding:12px 0}` +
 *     `.field + .field{border-top:0.5px}`——**一个边框都没有**。
 * 0.1.0 起两处共用同一个 `.group` 卡片类，于是插件页里多出一层设置页语法的容器，
 * 用户看到的就是"违和感"。
 *
 * ## 这一层断言什么、不说什么（边界要写清楚，免得它冒充它没证的事）
 *
 * SSR 没有 CSS 引擎：**渲染出的 class 名与产物里的 CSS 规则文本**在这里可读，
 * 而"算出来的 border/radius/background 到底是几 px"读不到。所以：
 *   · 本文件钉**结构**：哪条路径给哪个 class、两个 class 的规则文本各是什么；
 *   · **几何实测**（真机上算出来的计算值）由 `tests/console-panel-variant-evidence.mjs`
 *     在真机取证里承担（需要实例 + Chrome，进不了 pnpm test 的 glob）。
 * 两层判据指向的是同一件事的不同硬度，缺一层就会出现"结构对而屏上不对"或反之。
 *
 * 判据为什么钉在 class 与规则文本上而不是钉在"有没有边框"这句话上（§7.13）：
 * 卡片与分隔线**都含 border**，只有分开读四条边才区分得开——所以规则文本的断言
 * 必须查 `border:` / `border-radius:` / `background:` 这三条**声明**，
 * 而不是查字符串里出没出现 "border"。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  applyWithMocks, bootBundle, makeT, propsFor, registration, render, renderSafely,
} from './client-harness.mjs'

/** 产物里的 CSS 文本（tsdown 把 module.css 编译成"注入 <style> + 导出类名映射"的虚拟模块）。 */
const CLIENT_BUNDLE = readFileSync('dist/client.js', 'utf8')

/** 一份**完整**配置：四个分组都要渲染出来，缺一段就少一组（断言会数错）。 */
const FULL_CONFIG = {
  diagnostics: {
    dependency: true, composition: true, runtime: true, consistency: true, ecosystem: false,
    reportStaleModuleFallbackLinks: true,
  },
  qualityGate: { enabled: true, mode: 'block', allowlist: [] },
  marketplace: { enabled: true, cacheTtlMinutes: 1440, timeoutMs: 15_000, indexUrl: '' },
  trial: {
    enabled: false, depth: 'auto', baseline: true, allowNetwork: false, onFailure: 'block',
    autoCleanup: true, retentionDays: 7, maxKept: 5,
  },
}

/** 四个分组容器的标题（顺序即渲染顺序）。 */
const GROUP_TITLES = ['质量门（安装前扫描）', '诊断分层', '市场', '试装']

/**
 * 从产物里取出一个 CSS Modules 类的**哈希后完整类名**。
 *
 * 类名由 lightningcss 的 `[hash]_[local]` 生成，所以按 `.<hash>_<local>{` 定位。
 *
 * @param local - 本地类名（如 `groupPlain`）。
 * @returns 哈希后的完整类名。
 * @throws 产物里找不到这个类时抛错——找不到就是"类没被编译进产物"，必须红而不是空转。
 */
function classNameOf(local) {
  const match = CLIENT_BUNDLE.match(new RegExp('\\.([A-Za-z0-9_-]+_' + local + ')\\{'))
  assert.ok(match !== null, '产物里找不到 .' + local + ' 的规则——类没被编译进产物（构建没跑？）')
  return match[1]
}

/**
 * 从产物里取出一个 CSS Modules 类的**规则文本**。
 *
 * @param local - 本地类名（如 `groupPlain`）。
 * @returns 规则体文本。
 */
function ruleOf(local) {
  const name = local === 'group' ? GROUP_CLASS : classNameOf(local)
  const match = CLIENT_BUNDLE.match(new RegExp('\\.' + name + '\\{([^}]*)\\}'))
  assert.ok(match !== null, '产物里找不到 .' + local + '（' + name + '）的规则')
  return match[1]
}

/**
 * 两个容器类的哈希名（从产物读，不猜哈希）。
 *
 * **哈希必须从 `groupPlain` 反推，不能直接找 `group`**：产物里有多张样式表
 * （每个 `*.module.css` 一张），AboutPage / MarketplacePage 等也有各自的 `.group`，
 * 直接找 `group` 会命中**别的文件**那个（第一版实测取到 `YO0ypa_group`，
 * 而 ConsolePage 的是 `lIZxZW_group`，于是"设置页有 5 个卡片"数出 0 个）。
 *
 * `groupPlain` 是本次为 ConsolePage 新加的类，产物里只此一处——
 * 用它把 ConsolePage 那张样式表的哈希前缀定下来，再用同一个前缀找它的 `group`。
 */
const PLAIN_CLASS = classNameOf('groupPlain')
const CONSOLE_HASH = PLAIN_CLASS.slice(0, PLAIN_CLASS.lastIndexOf('_'))
const GROUP_CLASS = CONSOLE_HASH + '_group'

/**
 * 一个 class 字符串里是否含某条**声明**（不是"含某个词"）。
 * @param rule - 规则体。
 * @param declaration - 声明名（如 `border`）。
 * @returns 是否含该声明。
 */
const declares = (rule, declaration) => new RegExp('(^|;)' + declaration + ':').test(rule)

/** 启动产物并取一个注册项。 */
function bootRegistration(name, id) {
  const exported = bootBundle()
  const { slotRegistrations, dicts } = applyWithMocks(exported, { status: 'ready', value: FULL_CONFIG })
  const reg = registration(slotRegistrations, name, id)
  return { reg, face: reg.options.inject(), t: makeT(dicts, { strict: true }) }
}

/**
 * 取官方插件页里那个配置面注册项。
 *
 * 它是 **keyed** slot（`key: 包名`，不是 `id`）——官方 PluginManagerPage 的
 * `configured = ledger.bundles.has(openPkg.name)`，所以 key 必须是我们的包名。
 * 按 `id` 找会报 "未注册 slot"（第一版就是这么错的）。
 * @returns 注册项、注入面与字典座位。
 */
function bootBundleConfig() {
  const exported = bootBundle()
  const { slotRegistrations, dicts } = applyWithMocks(exported, { status: 'ready', value: FULL_CONFIG })
  const reg = slotRegistrations.find(entry =>
    entry.options.name === 'plugins.bundle.config' && entry.options.key === 'dsh-plugin-manager-companion')
  assert.ok(reg !== undefined, '没找到 plugins.bundle.config 的注册项（key 应为我们的包名）：'
    + slotRegistrations.map(entry => entry.options.name + '/' + String(entry.options.key ?? entry.options.id)).join(','))
  return { reg, face: reg.options.inject(), t: makeT(dicts, { strict: true }) }
}

/** 控制台里「设置」子页的 id（tabs 定义在 ConsolePage.tsx）。 */
const SETTINGS_TAB = 'settings'

/** 渲染控制台并落在「设置」子页。 */
function renderSettingsSubpage() {
  const { reg, face, t } = bootRegistration('settings.section', 'console')
  const props = propsFor(face, t)
  assert.ok(props.actions !== undefined, '控制台注册项没声明 store')
  props.actions.select(SETTINGS_TAB)
  return { reg, props, t }
}

/**
 * 数一段 HTML 里有几个**分组容器**。
 *
 * 按 `class` 属性里的**完整 token** 数，不是按子串数：
 * `group` 是 `groupPlain` 的子串，用 `html.split(name)` 会把 5 个 `groupPlain`
 * 在 `.group` 名下也数一遍（第一版实测：设置页数出 10 个而不是 5 个）——
 * 判据必须按 token 边界切，否则两个类互相冒充（§7.15 推论三的同族）。
 *
 * @param html - 渲染结果。
 * @param className - 哈希后的完整类名。
 * @returns 出现次数。
 */
function countClass(html, className) {
  let count = 0
  for (const match of html.matchAll(/class="([^"]*)"/g)) {
    for (const token of match[1].split(/\s+/)) if (token === className) count += 1
  }
  return count
}

describe('配置面板容器语法：按页面切（task-105）', () => {
  it('官方插件页那条路径：四个分组容器全部用 groupPlain，一个 group 都不留', () => {
    const { reg, face, t } = bootBundleConfig()
    const { html, error } = renderSafely(reg.component, propsFor(face, t, { view: 'page' }))
    assert.equal(error, undefined, '插件页配置面渲染抛异常：' + String(error))
    for (const title of GROUP_TITLES) assert.ok(html.includes(title), '插件页少了分组「' + title + '」：' + html.slice(0, 300))

    assert.equal(countClass(html, PLAIN_CLASS), 5,
      '插件页里应有 5 个无装饰分组（四组配置 + 试装环境管理那一节）：' + html.slice(0, 400))
    assert.equal(countClass(html, GROUP_CLASS), 0,
      '插件页里不许再有设置页的卡片容器（.group）——那正是用户看到的违和感来源')
  })

  it('设置页子页那条路径：容器仍然是卡片（group），一个 groupPlain 都不留', () => {
    // 子页选择走注册项声明的 store：选到「设置」子页才渲染 ConfigPanel。
    const { reg, props } = renderSettingsSubpage()
    const { html, error } = renderSafely(reg.component, props)
    assert.equal(error, undefined, '设置子页渲染抛异常：' + String(error))
    for (const title of GROUP_TITLES) assert.ok(html.includes(title), '设置子页少了分组「' + title + '」：' + html.slice(0, 300))

    assert.equal(countClass(html, GROUP_CLASS), 5, '设置子页里应有 5 个卡片容器：' + html.slice(0, 400))
    assert.equal(countClass(html, PLAIN_CLASS), 0,
      '设置子页不许用插件页的无装饰容器——卡片在设置页语法里是对的（改的是"切"，不是"删"）')
  })

  it('两类容器的规则文本：卡片有装饰、无装饰那类只有 padding 与分隔线', () => {
    const card = ruleOf('group')
    const plain = ruleOf('groupPlain')

    // 卡片：三条装饰声明都在（这是"设置页语法"的定义）。
    assert.ok(declares(card, 'border'), '.group 必须有边框声明：' + card)
    assert.ok(declares(card, 'border-radius'), '.group 必须有圆角声明：' + card)
    assert.ok(declares(card, 'background'), '.group 必须有底色声明：' + card)

    // 无装饰：三条装饰声明一条都不许有。
    assert.ok(!declares(plain, 'border-radius'), '.groupPlain 不许有圆角：' + plain)
    assert.ok(!declares(plain, 'background'), '.groupPlain 不许有底色：' + plain)
    // `border:0` 必须是**显式的归零**，不许省掉：fieldset 有 UA 默认边框。
    // 真机实测（Chromium，一次性探针）：不写这条时四条边全是 2px——
    // 也就是说"去掉卡片"之后反而会冒出一圈浏览器自带的框，比原来更糟。
    // 所以这条断言钉的是"必须显式归零"，而不是"只要不是卡片就行"。
    assert.match(plain, /(^|;)border:0(;|$)/,
      '.groupPlain 必须显式 border:0——fieldset 的 UA 默认边框是 2px，省掉它就会画出一圈自带的框：' + plain)
    // 官方 fields.module.css 的内边距口径：.field{padding:12px 0}。
    assert.match(plain, /padding:12px 0/, '.groupPlain 的内边距要对齐官方 .field 的 12px 0：' + plain)
  })

  it('相邻分组之间是分隔线（官方 .field + .field 语法），且只出现在相邻项之间', () => {
    const sibling = CLIENT_BUNDLE.match(/\.[A-Za-z0-9_-]+_groupPlain\+\.[A-Za-z0-9_-]+_groupPlain\{([^}]*)\}/)
    assert.ok(sibling !== null, '产物里找不到 .groupPlain + .groupPlain 的规则——分隔线没编译进产物')
    assert.match(sibling[1], /border-top:\s*0?\.?5px/, '相邻分组之间应是 0.5px 的发丝分隔线：' + sibling[1])
    // 只有上边：左右下三边不许跟着一起画（否则又变成盒子）。
    assert.doesNotMatch(sibling[1], /border(-left|-right|-bottom):/, '分隔线只能画上边：' + sibling[1])
  })

  it('两条路径用的是**同一个组件**（不许复制一份：四组字段与校验只能有一处）', () => {
    const source = readFileSync('src/client/OfficialSlots.tsx', 'utf8')
    assert.match(source, /import \{ ConfigPanel \} from '\.\/ConsolePage\.tsx'/,
      '插件页必须复用 ConsolePage 的 ConfigPanel，不许复制一份')
    assert.match(source, /variant="plugin-page"/, '插件页调用点必须显式声明页面语法')
    const console_ = readFileSync('src/client/ConsolePage.tsx', 'utf8')
    assert.match(console_, /variant="settings"/, '设置子页调用点必须显式声明页面语法')
    assert.equal((console_.match(/<ConfigPanel/g) ?? []).length, 1,
      'ConfigPanel 的调用点只有一个（设置子页）；插件页那个在 OfficialSlots.tsx')
  })

  it('字段与校验逻辑没有分叉：四组字段在两条路径上都渲染出来', () => {
    const plugin = bootBundleConfig()
    const pluginHtml = render(plugin.reg.component, propsFor(plugin.face, plugin.t, { view: 'page' }))
    const settings = renderSettingsSubpage()
    const settingsHtml = render(settings.reg.component, settings.props)

    // 两条路径的字段集合必须一致——这是"切容器语法没有顺手把字段也切掉"的判据。
    for (const title of GROUP_TITLES) {
      assert.ok(pluginHtml.includes(title), '插件页缺字段组：' + title)
      assert.ok(settingsHtml.includes(title), '设置页缺字段组：' + title)
    }
    // 抽查一条最深的字段（试装那一组的最后一项），确认切语法没截断内容。
    for (const html of [pluginHtml, settingsHtml]) {
      assert.ok(html.includes('最多保留数量'), '试装组最深的字段没渲染出来：' + html.slice(0, 200))
    }
  })
})

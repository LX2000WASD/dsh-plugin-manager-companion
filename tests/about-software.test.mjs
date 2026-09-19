/**
 * 「关于 → 软件升级」子页的契约（task-96）。
 *
 * 这一页的增量只有两件（其余复用 UpgradeRow / UpgradeResult），所以护栏也集中在这两件上：
 *   1. **筛选**：只列"这套软件本身"（① 官方运行时 ② 官方实验包 ③ 本插件自身），
 *      **第三方插件一个都不能出现在这一页**；
 *   2. **总览的态**：查不到 / 没查过 / 没有对象，三态各自可辨，且**都不许画成"已是最新"**。
 *
 * 复用的那部分（四态、dist-tags 多线、金丝雀四态、结果四档）由 tests/upgrade-ui.test.mjs 守着，
 * 这里不重复断言——重复的护栏会在两处漂移。
 *
 * 运行前需要 dist/client.js 是新的（pnpm run build）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { applyWithMocks, bootBundle, makeT, propsFor, registration, React, stubFetch, stubPrimitives, until } from './client-harness.mjs'
import { violationsOf } from './copy-rules.mjs'

const require_ = createRequire(import.meta.url)

/** 纯决策层（回滚判据等）：可直接 import dist，不需要 DOM。 */
const view = await import('../dist/upgradeView.js')
const { renderToStaticMarkup } = require_('react-dom/server')

/** 本插件自己的包名（③ 那一类）。 */
const OUR_PACKAGE = 'dsh-plugin-manager-companion'

/** 一条 dist-tag。 */
const tag = (name, version, line, preferred = false) => ({ tag: name, version, line, preferred })

/**
 * 一个升级单元。
 *
 * @param overrides - 覆盖字段。
 * @returns 单元视图。
 */
function unit(overrides = {}) {
  return {
    name: '@deepseek-ai/dsh-experimental-auto-review',
    kind: 'profile-dependency',
    state: 'update-available',
    currentVersion: '0.2.1',
    currentLine: '0.2.1',
    spec: '^0.2.1',
    // fixture 必须**符合 host 契约**：targetTag/targetVersion 的定义是"与当前同线的最新；
    // 没有同线候选时取 latest"（types.ts 的 UpgradeUnitReport）。
    // 我第一版把 targetTag 写成 'latest'、却把 preferred 放在同线的 'next' 上——
    // 那是**自相矛盾的假数据**，于是"默认选同线"这条断言失败：不是产品错，是 fixture 违反了契约。
    targetVersion: '0.2.9',
    targetTag: 'next',
    targetLine: '0.2.1',
    tags: [tag('latest', '0.3.0', 'other-line'), tag('next', '0.2.9', 'same-line', true)],
    source: 'registry',
    at: '2026-09-19T10:00:00.000Z',
    ...overrides,
  }
}

/**
 * 启动产物并取「关于」注册项。
 *
 * @returns 注册项、注入面与字典座位。
 */
function boot(options = {}) {
  // 覆盖**只加一个 Menu**，其余导出照旧（整份替换会把 relativeTime 之类的函数一起弄丢——
  // 第一版就是这么踩的：整份 stub 换掉之后 formatRelative 直接抛"not a function"）。
  const exported = bootBundle(options.renderMenuItems === true
    ? { '@deepseek-ai/dsh-client-ui-primitives': menuRenderingPrimitives(React, stubPrimitives()) }
    : {})
  const applied = applyWithMocks(exported, { value: {} })
  const t = makeT(applied.dicts, { strict: true })
  const entry = registration(applied.slotRegistrations, 'settings.section', 'about')
  const face = entry.options.inject()
  return { entry, face, t, applied }
}

/**
 * 渲染「关于」页并切到软件升级子页。
 *
 * @param entry - 注册项。
 * @param face - 注入面。
 * @param t - 字典座位。
 * @param tabId - 子页 id（默认 software）。
 * @returns 渲染出的 HTML。
 */
function render(entry, face, t, tabId = 'software') {
  const props = propsFor(face, t, {}, entry)
  props.actions.select(tabId)
  return renderToStaticMarkup(React.createElement(entry.component, props))
}

/**
 * 跑一次检查并渲染。
 *
 * @param units - 检查结果里的单元。
 * @param extra - 额外的 op 桩件。
 * @returns 渲染出的 HTML 与注入面。
 */
async function checkAndRender(units, extra = {}, options = {}) {
  const { entry, face, t } = boot(options)
  const stub = stubFetch({
    about: () => ({ ok: true, value: undefined }),
    upgradeCheck: () => ({
      ok: true,
      value: { environment: 'probe', units, checked: true, lastCheckAt: '2026-09-19T10:00:00.000Z', notes: [] },
    }),
    ...extra,
  })
  try {
    face.loadUpgrades(false)
    await until(() => face.hooks.upgrade.getSnapshot().check !== undefined, '检查结果落状态')
    return { html: render(entry, face, t), face }
  } finally {
    stub.restore()
  }
}

/**
 * 从渲染结果里取 Picker 的选项数据。
 *
 * 官方 Menu 的选项是浮层，SSR 桩件下不展开，所以选项列表在渲染文本里看不到。
 * 但**桩件会把 props 里的数组挂成 JSON**（client-harness 的 stubPrimitives 对数组的处理），
 * 这里把那段取回来解析——这样"全部 tag 都进选项"仍然是可断言的，而不是只能靠人看。
 *
 * @param html - 渲染出的 HTML。
 * @returns 选项数组（取不到时空数组）。
 */
/**
 * 一个会**渲染选项列表**的 Menu 桩件。
 *
 * 为什么需要它：默认的 primitives 桩把 Menu 画成一个空 div（官方 Menu 的选项是浮层，SSR 下不展开），
 * 于是"全部 dist-tags 都列出来了"这条**在渲染层不可断言**——只能看到当前选中的那一个。
 * 有了这个桩，选项列表（id + label）与 selectedId 都成了真判据（§12.10 的②：只在渲染里出现的结构）。
 *
 * 它只做一件真 Menu 在 SSR 下做不到的事：把 items 摊平画出来；其余（锚点、开关）照旧。
 *
 * @param React - harness 给的 React。
 * @returns 覆盖 ui-primitives 的桩件表。
 */
function menuRenderingPrimitives(React, base) {
  // 注意：base 是 **Proxy**（stubPrimitives 对任意名字按需造组件），
  // 所以不能用 `{...base}` 展开——展开只会得到一个空对象，
  // 于是 relativeTime / Button / Tag 全部丢失（第一版就是这么踩的：
  // 整份替换之后 formatRelative 直接抛 "relativeTime is not a function"）。
  // 正确做法是**代理转发**：只截 Menu 一个名字，其余原样落到 base。
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === 'Menu') {
        return function Menu(props) {
          const items = Array.isArray(props?.items) ? props.items : []
          return React.createElement(
            'div',
            { 'data-stub': 'Menu', 'data-selected': String(props?.selectedId ?? '') },
            items.map(entry => React.createElement('div', { key: entry.id, 'data-menu-item': entry.id }, entry.label)),
            props?.anchor ?? null,
          )
        }
      }
      return base[prop]
    },
  })
}

/**
 * 取渲染结果里的菜单选项。
 *
 * @param html - 渲染出的 HTML。
 * @returns 选项数组（id + label）。
 */
function menuEntries(html) {
  return [...html.matchAll(/data-menu-item="([^"]+)"[^>]*>([^<]*)</g)]
    .map(match => ({ id: match[1], label: match[2] }))
}

/**
 * 取 Menu 的当前选中 id。
 *
 * @param html - 渲染出的 HTML。
 * @returns 选中 id；没有菜单时空串。
 */
function menuSelectedId(html) {
  const match = /data-stub="Menu" data-selected="([^"]*)"/.exec(html)
  return match === null ? '' : match[1]
}
/**
 * 跑一次升级（金丝雀结论给定）并取**金丝雀那一行**的文本。
 *
 * @param canary - 金丝雀结论（passed / failed / not-run / absent）。
 * @returns 结果块里金丝雀那一行的文本。
 */
async function canaryLine(canary, resultOverride = {}) {
  const { entry, face, t } = boot()
  const name = '@deepseek-ai/dsh-experimental-auto-review'
  const stub = stubFetch({
    about: () => ({ ok: true, value: undefined }),
    upgradeCheck: () => ({
      ok: true,
      value: { environment: 'probe', checked: true, lastCheckAt: '2026-09-19T10:00:00.000Z', notes: [], units: [unit()] },
    }),
    upgrade: () => ({ ok: true, value: 'job-1' }),
    job: () => ({
      ok: true,
      value: {
        done: true,
        result: {
          ok: true, name, fromVersion: '0.2.1', toVersion: '0.2.9', ...resultOverride,
          // canary 缺省时**不传这个字段**（absent 的定义就是"字段不在"）。
          ...canary === undefined ? {} : { canary },
          diskFacts: [], output: '',
        },
      },
    }),
  })
  try {
    face.loadUpgrades(false)
    await until(() => face.hooks.upgrade.getSnapshot().check !== undefined, '检查落状态')
    face.upgradePackage(name, '0.2.9')
    await until(() => face.hooks.upgrade.getSnapshot().action !== undefined, '结果落状态')
    const html = render(entry, face, t)
    const at = html.indexOf('最近一次升级')
    assert.ok(at >= 0, '结果块要画出来：' + html.slice(0, 600))
    // 取**整个结果块**的可见文本（标题行与说明行都算）。
    //
    // 为什么不只取说明行：金丝雀没跑那一档（unverified）**刻意不画说明行**——
    // 它的标题已经写着「已升级（未验证）」，再画一行就是同一件事说两遍（§12.3.1，task-74 真机改的）。
    // 所以判据必须是"这一档的事实可见"，而不是"某一类元素存在"。
    // 第一版取说明行，unverified 那档拿到空数组、测试自己报了空转——**判据写错会静默变空**（§7.13）。
    return html.slice(at).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  } finally {
    stub.restore()
  }
}
/**
 * 回滚入口的显示判据（与界面用的是**同一个**纯函数，不另立一套）。
 *
 * 从 dist 里取：canRollback 是 UpgradeRow.tsx 导出的纯函数，与界面共用同一份判据——
 * 测试另写一份就会漂移，而漂移的护栏比没有护栏更糟。
 *
 * @param action - 升级结果（可能没有）。
 * @returns 可回滚时 true。
 */
const canRollback = (action) => view.canRollback(action)
describe('「关于 → 软件升级」子页（task-96）', () => {
  it('注册项同时注入关于面与升级面（hooks 两个都在）', () => {
    const { face } = boot()
    assert.ok(face.hooks.about !== undefined, '关于面的 hook 必须在')
    // 这一条钉的是一个真踩过的坑：两个面的 hooks 各自是独立对象，展开后者会整个覆盖前者。
    assert.ok(face.hooks.upgrade !== undefined, '升级面的 hook 必须在（hooks 必须显式合并，不能靠展开）')
    for (const action of ['loadAbout', 'ensureUpgrades', 'loadUpgrades', 'upgradePackage', 'rollbackPackage', 'dismissUpgradeNotice']) {
      assert.equal(typeof face[action], 'function', action + ' 必须在注入面上')
    }
  })

  it('子页机制：加第二个子页只是一条数据（两个 tab 都在，且能切）', async () => {
    const { entry, face, t } = boot()
    const html = render(entry, face, t)
    assert.ok(html.includes('DSH 信息'), '第一个子页标签要在')
    assert.ok(html.includes('软件升级'), '第二个子页标签要在：' + html.slice(0, 400))
    // 切到 software 后，DSH 信息那一段的事实标签不该还以可见形态出现。
    assert.ok(!html.includes('DSH 版本'), '切到软件升级后不该还画着 DSH 信息的事实')
  })

  it('**只列这套软件本身**：三类官方单元显示，第三方插件一个都不出现', async () => {
    const { html } = await checkAndRender([
      unit({ name: '@deepseek-ai/dsh-base', kind: 'installation-provided', state: 'not-upgradable', command: 'npm i -g @deepseek-ai/dsh@latest' }),
      unit({ name: '@deepseek-ai/dsh-experimental-auto-review', kind: 'profile-dependency' }),
      unit({ name: OUR_PACKAGE, kind: 'self', currentVersion: '0.1.0', targetVersion: '0.2.0' }),
      // 第三方：各种 kind 都要被挡掉。
      unit({ name: 'dsh-probe-block', kind: 'profile-dependency' }),
      unit({ name: '@someone-else/their-plugin', kind: 'profile-dependency' }),
      unit({ name: 'leftover-third-party', kind: 'installation-provided' }),
    ])
    for (const shown of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-experimental-auto-review', OUR_PACKAGE]) {
      assert.ok(html.includes(shown), '这一类必须在：' + shown)
    }
    for (const hidden of ['dsh-probe-block', '@someone-else/their-plugin', 'leftover-third-party']) {
      assert.ok(!html.includes(hidden), '第三方不该出现在这一页：' + hidden + String.fromCharCode(10) + html.slice(0, 600))
    }
  })

  it('第①类给命令、不给按钮（安装方提供的层在 profile 内升不了）', async () => {
    const { html } = await checkAndRender([
      unit({ name: '@deepseek-ai/dsh-base', kind: 'installation-provided', state: 'not-upgradable', command: 'npm i -g @deepseek-ai/dsh@latest' }),
    ])
    assert.ok(html.includes('由安装方提供'), '要说清为什么升不了')
    assert.ok(html.includes('npm i -g @deepseek-ai/dsh@latest'), '要给出可执行的命令：' + html.slice(0, 500))
    assert.ok(!/升级到/.test(html), '第①类不得给升级按钮')
  })

  it('第③类（本插件自身）写明"正在运行的是旧代码，新版本下次启动生效"', async () => {
    const { html } = await checkAndRender([unit({ name: OUR_PACKAGE, kind: 'self' })])
    assert.ok(html.includes('已安装，下次启动后加载。'), '生效时机沿用官方口径（DESIGN §5.5）')
    assert.ok(html.includes('升级到'), '自身可升级，要给按钮：' + html.slice(0, 500))
  })

  it('dist-tags 多线：列出**全部** tag 让用户挑（tag 名 + 版本 + 这条线是什么）', async () => {
    // 判据用①：给 Menu 一个**会渲染 items 的桩件**，于是"选项列表"本身可断言。
    // 默认的 primitives 桩把 Menu 画成一个空 div（官方 Menu 的选项是浮层），
    // 只断言渲染文本的话，这条会退化成"只看得见当前选中项"——那证不了"全部列出来了"。
    const { html } = await checkAndRender([unit()], {}, { renderMenuItems: true })
    const entries = menuEntries(html)
    assert.deepEqual(
      entries.map(entry => entry.id),
      ['latest', 'next'],
      '全部 dist-tags 都要进选项：' + JSON.stringify(entries),
    )
    assert.match(entries[0].label, /0\.3\.0/, '选项要带版本号：' + entries[0].label)
    assert.match(entries[0].label, /latest/, '选项要带 tag 名：' + entries[0].label)
    assert.match(entries[0].label, /另一条线/, '要说明这条线是什么（相对当前版本线）')
    assert.match(entries[1].label, /同线/, '同线那一条也要标出来')
  })

  it('dist-tags 多线：默认高亮与当前版本**同线**的最新', async () => {
    // 契约：host 的 `targetTag` 就是"默认目标"，而它的定义是"与当前同线的最新；
    // 没有同线候选时取 latest"（types.ts 的 UpgradeUnitReport.targetTag）。
    // 所以 fixture 里 targetTag 必须与 preferred 那条**一致**——
    // 我第一版把 targetTag 写成 latest 而 preferred 写成 next，那是**自相矛盾的假数据**，
    // 于是这条断言失败：不是产品错，是我的 fixture 违反了契约。
    const { html } = await checkAndRender([unit()], {}, { renderMenuItems: true })
    const selected = menuSelectedId(html)
    assert.equal(selected, 'next', '默认选中的必须是与当前同线的最新（next=0.2.9），不是 latest')
    // 默认同线 → 不该出现"会切到另一条线"的提示。
    assert.ok(!/升级会切到另一条版本线/.test(html), '同线默认不该提示换线')
  })

  it('dist-tags 多线：换到别的线要明说（选中 latest 时提示切线的判据）', async () => {
    // 这条钉纯决策层：界面"要不要提示换线"直接问 changesLine，不自己推断。
    const view = await import('../dist/upgradeView.js')
    assert.equal(view.changesLine(unit(), 'next'), false, '同线不该提示换线')
    assert.equal(view.changesLine(unit(), 'latest'), true, '跨线必须提示换线')
    assert.equal(view.versionForTag(unit(), 'latest'), '0.3.0', '跨线目标版本跟着走')
  })

  it('查不到：必须显示「查不到」+ 原因，**绝不**显示"已是最新"', async () => {
    const { html } = await checkAndRender([
      unit({ state: 'unknown', targetVersion: null, targetTag: null, tags: null, reason: 'registry 不可用' }),
    ])
    assert.ok(html.includes('查不到'), '查不到要说出来：' + html.slice(0, 600))
    assert.ok(html.includes('registry 不可用'), '要给原因')
    assert.ok(!/已是最新/.test(html), '查不到**绝不**能画成"已是最新"')
    assert.ok(!/升级到/.test(html), '查不到时不给升级按钮')
  })

  it('还没查过：说出来 + 给检查按钮（不靠缺席表达）', () => {
    const { entry, face, t } = boot()
    const html = render(entry, face, t)
    assert.ok(html.includes('尚未检查更新'), '没查也要说出来：' + html.slice(0, 500))
    assert.ok(html.includes('检查更新'), '要给检查按钮')
  })

  it('检查自己失败：如实说失败 + 重试，不画成"已是最新"', async () => {
    const { entry, face, t } = boot()
    const stub = stubFetch({
      about: () => ({ ok: true, value: undefined }),
      upgradeCheck: () => { throw new Error('registry 连不上') },
    })
    try {
      face.loadUpgrades(false)
      await until(() => face.hooks.upgrade.getSnapshot().error !== undefined, '失败落状态')
      const html = render(entry, face, t)
      assert.ok(html.includes('registry 连不上'), '要说失败原因：' + html.slice(0, 500))
      assert.ok(!/已是最新/.test(html), '失败**绝不**能画成"已是最新"')
    } finally {
      stub.restore()
    }
  })

  it('范围里一个单元都没有：说"没有可检查的单元"，**不是**"已是最新"', async () => {
    const { html } = await checkAndRender([
      // 只有第三方 → 本页筛选后为空。
      unit({ name: 'dsh-probe-block', kind: 'profile-dependency' }),
    ])
    assert.ok(html.includes('没有可检查的升级单元'), '空范围要说出来：' + html.slice(0, 600))
    assert.ok(!/已是最新/.test(html), '"没有对象"不是"已是最新"')
  })

  it('结果块按包名归属：A 包的结果不画在 B 包的卡片上', async () => {
    const { entry, face, t } = boot()
    const first = '@deepseek-ai/dsh-experimental-auto-review'
    const second = OUR_PACKAGE
    const stub = stubFetch({
      about: () => ({ ok: true, value: undefined }),
      upgradeCheck: () => ({
        ok: true,
        value: {
          environment: 'probe', checked: true, lastCheckAt: '2026-09-19T10:00:00.000Z', notes: [],
          units: [unit({ name: first }), unit({ name: second, kind: 'self' })],
        },
      }),
      upgrade: () => ({ ok: true, value: 'job-1' }),
      job: () => ({ ok: true, value: { done: true, result: { ok: true, name: first, toVersion: '0.3.0', fromVersion: '0.2.1', canary: 'passed', diskFacts: [], output: '' } } }),
    })
    try {
      face.loadUpgrades(false)
      await until(() => face.hooks.upgrade.getSnapshot().check !== undefined, '检查落状态')
      face.upgradePackage(first, '0.3.0')
      await until(() => face.hooks.upgrade.getSnapshot().action !== undefined, '结果落状态')
      const html = render(entry, face, t)
      // 结果里出现的包名必须是 first，且 second 的卡片里不该有"最近一次升级"。
      const at = html.indexOf('最近一次升级')
      assert.ok(at >= 0, '结果块要画出来')
      const around = html.slice(Math.max(0, at - 1500), at + 600)
      assert.ok(around.includes(first), '结果块要落在 first 的卡片里')
    } finally {
      stub.restore()
    }
  })

  it('"已是最新"那一态也要说出来（不许留一个只有类名与包名的空壳）', async () => {
    // 真机取证抓到的缺陷：官方插件页对 up-to-date **不画那一行**（可见性由注册对账管，§5.5 的表格），
    // 但这一页的卡片是自己 map 出来的、没有对账那一层——于是用户看到的是
    // "官方实验包 / @deepseek-ai/dsh-experimental-auto-review"两行标签、**下面什么都没有**。
    // 单测没暴露它：既有用例用的都是 update-available 的单元。
    const { html } = await checkAndRender([unit({ state: 'up-to-date', targetVersion: null, targetTag: null, tags: null })])
    assert.ok(html.includes('@deepseek-ai/dsh-experimental-auto-review'), '包名要在（卡片本身不该消失）')
    assert.ok(html.includes('已经是最新版本'), '这一态必须有一句话，不能是空壳：' + html.slice(0, 500))
    assert.ok(!/升级到/.test(html), '已是最新不该给升级按钮')
    assert.ok(!/查不到/.test(html), '已是最新**不是**查不到（两态不许混）')
  })
  it('金丝雀四态**互不相同**："没验证"既不是"通过"，也不是"验证失败"', async () => {
    // 这条是 task-96 的硬要求：**金丝雀未通过时要能看出是"没验证"**。
    // 变异验证发现原来的护栏有洞：把 `upgrade.canary.notRun` 改成「验证通过」时全套测试**仍然绿**
    // ——因为没有任何用例断言过金丝雀那句话（既有用例钉的是 `data-upgrade-outcome` 结构）。
    // 那正是任务描述点名的风险："没验证"最容易被读成"通过"。
    //
    // 判据（§12.10 的②，不退到③的整句比对）：四态各渲染一次，**两两不同**且各自可辨——
    // 只要有一态与另一态撞词，这条就红。
    // 四态的 host 载荷形状（canaryVerdict 的契约）：
    //   absent → 字段整个缺省；not-run → { ran: false }；
    //   passed/failed → { ran: true, conclusion: 'passed' | <其它> }。
    // 第一版直接传字符串 'passed'，于是四态全被 canaryVerdict 判成 failed——
    // 那不是产品错，是我的 fixture 不符合契约（§7.13 的同族：判据喂错了输入）。
    //
    // **失败路径也要跑**：`not-run` 在成功路径上走的是 unverified 那一档（标题已写「未验证」，
    // 说明行**刻意不画**，§12.3.1），所以 `upgrade.canary.notRun` 那句话**只在失败路径出现**。
    // 变异验证发现：只跑成功路径时，把 notRun 改成「验证通过」**测试仍然绿**——
    // 因为那一档根本不渲染说明行。这是"覆盖不全导致护栏有洞"，补上失败路径才堵住。
    const lines = {
      passed: await canaryLine({ ran: true, conclusion: 'passed' }),
      failed: await canaryLine({ ran: true, conclusion: 'failed' }),
      'not-run': await canaryLine({ ran: false }, { ok: false }),
      absent: await canaryLine(undefined),
    }
    const seen = new Map()
    for (const [state, text] of Object.entries(lines)) {
      const other = seen.get(text)
      assert.equal(other, undefined, '这两态的话撞了（用户分不出来）：' + state + ' 与 ' + other + ' 都是 ' + JSON.stringify(text))
      seen.set(text, state)
    }
    // 语义方向也要钉住："没验证"不得声称通过。
    // 判据用**同义集合**（未验证 / 没有验证 / 没验证）——R4 的判定器也是这么写的：
    // 只认一个词的话，产品把"没验证"换成"未验证"这条就误报（第一版就是这样：
    // 实际渲染是「已升级（未验证）」，而我只写了 /没有验证|没验证/）。
    assert.match(lines['not-run'], /未验证|没有验证|没验证/, '"没验证"那一态必须说清没有验证：' + lines['not-run'])
    assert.ok(!/验证通过|已验证/.test(lines['not-run']), '"没验证"那一态**不许**声称通过：' + lines['not-run'])
    assert.match(lines['passed'], /通过/, '通过那一态要说通过：' + lines['passed'])
    assert.match(lines['failed'], /没通过|未通过/, '失败那一态要说没通过：' + lines['failed'])
  })
  it('升级成功后单元变成"已是最新"，但**结果块与回滚入口必须留着**', async () => {
    // 真机取证抓到的缺陷（task-97）：升级成功后控制器立刻重查版本事实，
    // 于是那个单元**当场变成 up-to-date**；第一版把结果块也塞在"不是 hidden"那一支里，
    // 结果块（连同刚长出来的回滚入口）**当场消失**——用户刚升完级要看结果，屏幕上是空的。
    //
    // 分界：升级行说"现在能不能升"（up-to-date 就说一句已是最新），
    // 结果块说"刚才那次动作的结果"（历史，与当前状态无关，必须留着）。
    const { entry, face, t } = boot()
    const name = '@deepseek-ai/dsh-experimental-auto-review'
    const stub = stubFetch({
      about: () => ({ ok: true, value: undefined }),
      // 关键：升级后重查**返回 up-to-date**（真机就是这个序列）。
      upgradeCheck: () => ({
        ok: true,
        value: {
          environment: 'probe', checked: true, lastCheckAt: '2026-09-19T10:00:00.000Z', notes: [],
          units: [unit({ state: 'up-to-date', targetVersion: null, targetTag: null, tags: null })],
        },
      }),
      upgrade: () => ({ ok: true, value: 'job-1' }),
      job: () => ({
        ok: true,
        value: {
          done: true,
          result: {
            ok: true, name, fromVersion: '0.1.6-alpha.1', toVersion: '0.1.6-alpha.2', spec: '^0.1.6-alpha.1',
            canary: { ran: true, conclusion: 'passed' }, diskFacts: [], output: '',
          },
        },
      }),
    })
    try {
      face.loadUpgrades(false)
      await until(() => face.hooks.upgrade.getSnapshot().check !== undefined, '检查落状态')
      face.upgradePackage(name, '0.1.6-alpha.2')
      await until(() => face.hooks.upgrade.getSnapshot().action !== undefined, '结果落状态')
      const html = render(entry, face, t)
      assert.ok(html.includes('已经是最新版本'), '当前状态要说"已是最新"：' + html.slice(0, 600))
      assert.ok(html.includes('最近一次升级'), '**结果块必须留着**（它是历史，与当前状态无关）')
      assert.ok(html.includes('回滚到 0.1.6-alpha.1'), '**回滚入口也必须留着**：' + html.slice(-1200))
    } finally {
      stub.restore()
    }
  })
  it('隐藏的子页必须真的不可见：.panel 的 display 不许压掉 hidden 属性（源码级）', () => {
    // 真机取证抓到的缺陷（task-97）：`.panel { display: flex }` 会把 HTML 的 `hidden` 压掉
    // （hidden 的默认样式 display:none 被任何显式 display 声明覆盖），
    // 后果是**两个子页同时可见**——切到「软件升级」时「DSH 信息」还留在上面。
    //
    // 为什么必须源码级断言：SSR 读的是 innerText，而 **hidden 的子树 innerText 照样读得到**，
    // 所以"那一段不可见"这件事跨不过渲染（DESIGN §12.10 的推论）。
    const css = readFileSync(new URL('../src/client/AboutPage.module.css', import.meta.url), 'utf8')
    const panel = css.slice(css.indexOf('.panel {'), css.indexOf('.group {'))
    assert.match(panel, /display:\s*flex/, '前提：.panel 确实声明了 display（否则这条判据空转）')
    assert.match(css, /\.panel\[hidden\]\s*\{[^}]*display:\s*none/, '改了 display 就必须显式把 [hidden] 钉回 none：' + panel)
  })
  it('回滚入口：只在"刚完成一次升级"时出现，且必须知道**升级前的版本**', () => {
    // task-97 的 Lead 裁决：入口长在**结果块**里（不做常驻按钮——回滚的语义是"刚升完发现问题"）。
    // 判据用纯函数 canRollback（与界面**同一个**函数），不靠渲染文本反推（§12.10 的①/②）。
    assert.equal(canRollback(undefined), false, '没有结果时不该有入口')
    assert.equal(canRollback({ outcome: 'done', fromVersion: '0.2.1' }), true, '升级完成 → 可回滚')
    assert.equal(canRollback({ outcome: 'unverified', fromVersion: '0.2.1' }), true, '升级了但没验证 → 也可回滚')
    // 下面两种**没有可回滚的东西**：
    assert.equal(canRollback({ outcome: 'failed', fromVersion: '0.2.1' }), false, '没完成 → 没有可回滚的东西')
    assert.equal(canRollback({ outcome: 'rolled-back', fromVersion: '0.2.1' }), false,
      '试装拦下（没有升级）→ 没有可回滚的东西')
    // 这条是本任务的核心护栏：拿不到升级前的版本就**不显示入口**——不许猜一个版本号。
    assert.equal(canRollback({ outcome: 'done', fromVersion: null }), false,
      '拿不到 fromVersion 时**不许**显示入口（回滚会把环境装成那个版本，猜不得）')
    assert.equal(canRollback({ outcome: 'done', fromVersion: '' }), false, '空串同样不算拿到了版本')
  })

  it('回滚入口渲染：结果块里有「回滚到 {version}」，且**必须二次确认**', async () => {
    const { entry, face, t } = boot()
    const name = '@deepseek-ai/dsh-experimental-auto-review'
    const stub = stubFetch({
      about: () => ({ ok: true, value: undefined }),
      upgradeCheck: () => ({
        ok: true,
        value: { environment: 'probe', checked: true, lastCheckAt: '2026-09-19T10:00:00.000Z', notes: [], units: [unit()] },
      }),
      upgrade: () => ({ ok: true, value: 'job-1' }),
      job: () => ({
        ok: true,
        value: {
          done: true,
          result: {
            ok: true, name, fromVersion: '0.2.1', toVersion: '0.2.9', spec: '^0.2.1',
            canary: { ran: true, conclusion: 'passed' }, diskFacts: [], output: '',
          },
        },
      }),
    })
    try {
      face.loadUpgrades(false)
      await until(() => face.hooks.upgrade.getSnapshot().check !== undefined, '检查落状态')
      face.upgradePackage(name, '0.2.9')
      await until(() => face.hooks.upgrade.getSnapshot().action !== undefined, '结果落状态')
      const html = render(entry, face, t)
      assert.ok(html.includes('回滚到 0.2.1'), '要给回滚入口且写明回到哪个版本：' + html.slice(-1200))
      // 二次确认面：官方 Modal 桩即便 open=false 也渲染 children，所以判据是"确认框的标题与正文在"。
      assert.ok(html.includes('回滚这次升级'), '要有确认框（回滚也是装一个版本，会改盘上状态）')
      assert.ok(html.includes('也就是升级前的版本'), '确认框要说清回到哪个版本')
      // "必须二次确认"的直接证据：初始 open 必须是 false——不许点一下就执行。
      assert.match(html, /data-stub="Modal"[^>]*data-open="false"/, '确认框初始必须是关着的')
    } finally {
      stub.restore()
    }
  })

  it('回滚入口的**接线**：点入口只开确认框，点确认才真的回滚（源码级）', () => {
    // 为什么这条必须是源码级断言（DESIGN §12.10 的推论）：
    //   "点入口是否直接执行了回滚"这件事**跨不过渲染**——官方 Modal 桩即便 open=false 也渲染 children，
    //   所以"去掉二次确认"这个变异在 SSR 产物上**看不出差别**（变异验证实测：那条是绿的）。
    //   而它恰恰是本任务最重要的护栏（Lead 点名"必须二次确认"）。
    // 所以钉接线本身：入口按钮只能 setConfirming(true)，**不许**直接调 onRollback；
    // 只有确认按钮才调 onRollback。
    const source = readFileSync(new URL('../src/client/UpgradeRow.tsx', import.meta.url), 'utf8')
    const entry = source.slice(source.indexOf('{canRollback(action) ? ('), source.indexOf('二次确认：回滚也是'))
    assert.ok(entry.length > 0, '取不到回滚入口那段源码（判据会空转）')
    assert.match(entry, /setConfirming\(true\)/, '入口按钮必须只打开确认框：' + entry)
    assert.ok(!/onRollback\(/.test(entry), '入口按钮**不许**直接回滚（那就是没有二次确认）：' + entry)
    // 反向：确认按钮必须真的执行回滚（否则这个入口点了没反应）。
    const confirm = source.slice(source.indexOf('title={t(\'upgrade.rollback.confirmTitle\')}'))
    assert.match(confirm, /onRollback\(action\.name, action\.fromVersion, action\.spec\)/, '确认按钮要执行回滚')
  })
  it('回滚入口**不常驻**：没升过级时卡片上没有回滚按钮', async () => {
    const { html } = await checkAndRender([unit()])
    assert.ok(!/回滚到/.test(html), '没升过级就不该有回滚入口：' + html.slice(0, 600))
  })

  it('回滚入口**不出现**在失败结果上（没有可回滚的东西）', async () => {
    const { entry, face, t } = boot()
    const name = '@deepseek-ai/dsh-experimental-auto-review'
    const stub = stubFetch({
      about: () => ({ ok: true, value: undefined }),
      upgradeCheck: () => ({
        ok: true,
        value: { environment: 'probe', checked: true, lastCheckAt: '2026-09-19T10:00:00.000Z', notes: [], units: [unit()] },
      }),
      upgrade: () => ({ ok: true, value: 'job-1' }),
      job: () => ({
        ok: true,
        value: {
          done: true,
          result: {
            ok: false, code: 'install-failed', name, fromVersion: '0.2.1', toVersion: '0.2.9',
            spec: '^0.2.1', canary: { ran: true, conclusion: 'passed' }, diskFacts: [], output: '',
          },
        },
      }),
    })
    try {
      face.loadUpgrades(false)
      await until(() => face.hooks.upgrade.getSnapshot().check !== undefined, '检查落状态')
      face.upgradePackage(name, '0.2.9')
      await until(() => face.hooks.upgrade.getSnapshot().action !== undefined, '结果落状态')
      const html = render(entry, face, t)
      assert.ok(html.includes('升级没有完成'), '失败态要如实说：' + html.slice(-1000))
      assert.ok(!/回滚到/.test(html), '失败态**没有可回滚的东西**，不该给回滚入口：' + html.slice(-1000))
    } finally {
      stub.restore()
    }
  })
  it('文案：software 相关的新键过 §12（短文本不带句号、不口语化、无内部代号）', () => {
    const { applied } = boot()
    const dict = applied.dicts.find(entry => entry.ns === 'plugin-manager-companion')
    assert.ok(dict !== undefined, '字典没注册')
    const keys = ['about.tab.software', 'about.software.none', 'about.unit.installation', 'about.unit.experimental', 'about.unit.self', 'about.unit.other']
    const hits = []
    for (const key of keys) {
      const text = dict.d.zh[key]
      assert.equal(typeof text, 'string', '键必须在：' + key)
      const found = violationsOf(text, 'dict')
      if (found.length > 0) hits.push(key + ' [' + found.join(',') + '] :: ' + text)
    }
    assert.deepEqual(hits, [], '命中 §12.9：' + String.fromCharCode(10) + hits.join(String.fromCharCode(10)))
  })
})

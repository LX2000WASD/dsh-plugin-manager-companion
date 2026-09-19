/**
 * 升级 UI 的契约测试（node --test，跑 dist/client.js + React SSR）。
 *
 * 守护的是 task-74 的四件容易"看起来接上了、其实没有"的事：
 *   1. **四态不许混**（DESIGN §5.5）：有更新给入口、已检查无更新不显示、**查不到必须显示**
 *      （绝不显示"已是最新"）、不可升级给命令不给按钮；
 *   2. **注册实时对账**：已装集合或检查结果一变，官方插件页的 keyed 注册集合跟着变，
 *      register() 的 disposer 按需释放——**不留孤儿 key**；
 *   3. **失败态不得渲染成完成**：试装拦下（canary-not-passed）= 没升级；金丝雀没跑 = 没验证
 *      （既不是通过也不是失败）；
 *   4. **市场页卡片**的「升级到 x.y.z」只在已装且有更新时出现，且走的是同一条升级通道。
 *
 * 为什么自带一套 ctx 桩件（而不是复用 tests/client-harness.mjs 的 applyWithMocks）：
 *   那个桩件的 slots.register 恒返回空 disposer、也不记 key，**对账这件事在它那里不可观测**
 *   ——"撤掉 key 那一节当场消失"正是本任务的核心验收项，需要一个真的会记账的注册表替身。
 *   平台模块表（含 primitives / SnapshotStore 的缺导出护栏）仍复用共享 harness。
 *
 * 运行前需要 dist/client.js 是新的（pnpm run build:client）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { bootBundle, React, stubFetch } from './client-harness.mjs'

/** 纯决策层（四态映射、结果分类）：可直接 import dist，不需要 DOM。 */
const view = await import('../dist/upgradeView.js')

const require_ = createRequire(import.meta.url)
const { renderToStaticMarkup } = require_('react-dom/server')

const NS = 'plugin-manager-companion'
/** 本插件自己的包名（对账时必须被排除：它自己的页面已被配置面注册占用）。 */
const OUR_PACKAGE = 'dsh-plugin-manager-companion'

// ── ctx 桩件（重点：一个真的会记账的 slots 注册表）─────────────────────────

/**
 * 一个记账版 slots 替身。
 *
 * 记三件事：inject 了哪些 slot、每个 (slot, key) 的注册项、以及每个 key 的 disposer 被调用过几次。
 * 有了它，"注册集合跟着已装集合变"与"不留孤儿 key"才可被断言。
 *
 * @returns 注册表句柄。
 */
function makeSlotRegistry() {
  const injected = []
  const registrations = []
  const live = new Map()
  const disposed = new Map()
  return {
    injected,
    registrations,
    live,
    disposed,
    /**
     * 当前活着的**升级行** key 列表（顺序稳定）。
     *
     * 只列 `plugins.bundle.config#<包名>`：那正是本任务的落点，也是"那一节当场出现/消失"
     * 的观测面。其余注册项（三个一级入口、plugins.item、本插件自己的配置面）不属于对账范围，
     * 混进来会让断言把"本插件自己一直在"读成"对账没生效"。
     */
    keys() {
      return [...live.keys()]
        .filter(cell => cell.startsWith('plugins.bundle.config#') && cell !== 'plugins.bundle.config#' + OUR_PACKAGE)
        .sort()
    },
    /** 取一个活着的注册项。 */
    entry(key) { return live.get(key) },
    api: {
      inject(name, fn) {
        injected.push(name)
        const reg = fn()
        return typeof reg === 'function' ? reg : () => {}
      },
      register(options, component) {
        const cell = options.name + '#' + String(options.key ?? options.id ?? '')
        registrations.push({ options, component })
        live.set(cell, { options, component })
        return () => {
          // 幂等（官方 register 的 disposer 契约）：重复调用不重复计数。
          if (!live.has(cell)) return
          live.delete(cell)
          disposed.set(cell, (disposed.get(cell) ?? 0) + 1)
        }
      },
      entries: () => [],
      getVersion: () => 0,
      subscribe: () => () => {},
    },
  }
}

/**
 * 启动产物并以桩件调用 apply。
 *
 * @param options - 已装台账（官方 listBundles 的形状）、upgradeCheck 载荷与 primitives 覆盖。
 * @returns 注册表、字典、捕获到的 op 调用与"触发一次台账变化"的钩子。
 */
function boot(options = {}) {
  const exported = bootBundle(options.primitives === undefined ? {} : { '@deepseek-ai/dsh-client-ui-primitives': options.primitives })
  const slots = makeSlotRegistry()
  const dicts = []
  const effects = []
  const listeners = new Map()
  /** 官方台账的当前值（测试改它来模拟装/卸一个包）。 */
  const ledger = { bundles: options.bundles ?? [] }
  const listBundlesCalls = []
  const remote = {
    pluginManager: {
      async listBundles() {
        listBundlesCalls.push(ledger.bundles.map(bundle => bundle.name))
        return { ok: true, value: ledger.bundles }
      },
    },
    $on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(listener)
      return () => { listeners.get(event)?.delete(listener) }
    },
  }
  const scopeSnapshot = {
    status: 'ready', value: options.config ?? {}, base: undefined, user: undefined,
    revision: 1, writable: true, mode: 'host', namespace: NS,
  }
  const ctx = {
    effect(fn) { effects.push(fn); const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    on: () => () => {},
    // 服务表桩件必须**逐服务名**作答（与真机一致）：`pluginManager` 是独立服务
    // `remote.pluginManager`，不是 `remote` 对象上的属性。第一版桩件把两者混成一个属性，
    // 于是真机里台账恒读不到、而这里全绿——正是这种"桩件比真机宽松"造成的假绿。
    get: (name) => {
      if (name === 'remote') return remote
      if (name === 'remote.pluginManager') return remote.pluginManager
      return undefined
    },
    logger: { info() {}, warn() {}, error() {} },
    locale: {
      register(ns, d) { dicts.push({ ns, d }); return () => {} },
      bind: (ns) => (key, params) => tFromDicts(dicts, ns, key, params),
      subscribe: () => () => {},
      getSnapshot: () => ({ revision: 0 }),
    },
    slots: slots.api,
    // ctx.inject 的作用域桩件：声明 `remote.pluginManager` 后回调拿到**同一份** ctx
    // （服务可见性靠注入声明，真机同理）。桩件里的服务一直在，所以直接回调。
    inject(names, callback) {
      const list = typeof names === 'string' ? [names] : [...names]
      slots.injected.push('inject:' + list.join(','))
      callback(ctx)
      return () => {}
    },
    remote,
    settingsScope: {
      bind() {
        return {
          getSnapshot: () => scopeSnapshot,
          subscribe: () => () => {},
          mutate: async () => {},
          set: async () => {},
          unset: async () => {},
        }
      },
      describe: () => ({ subscribe: () => () => {}, getSnapshot: () => ({ descriptors: [] }) }),
    },
  }
  exported.apply(ctx)
  return {
    slots, dicts, ledger, listBundlesCalls,
    t: (key, params) => tFromDicts(dicts, NS, key, params),
    /** 模拟官方台账变化（装/卸一个包后 host 会推这个事件）。 */
    fire(event) { for (const fn of listeners.get(event) ?? []) fn() },
  }
}

/** 从字典里取一条文案（缺键即抛：字典缺键会让断言假绿）。 */
function tFromDicts(dicts, ns, key, params) {
  const dict = dicts.find(entry => entry.ns === ns)?.d.zh
  const value = dict?.[key]
  if (typeof value !== 'string') throw new Error('缺字典键：' + key)
  if (params === undefined) return value
  return value.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''))
}

// ── 四态的载荷 ────────────────────────────────────────────────────────────

/** 一条 dist-tag。 */
const tag = (name, version, line, preferred) => ({ tag: name, version, line, preferred })

/**
 * 造一个升级单元（四态由 state 决定，其余字段给足）。
 *
 * @param overrides - 覆盖字段。
 * @returns 单元载荷。
 */
function unit(overrides = {}) {
  return {
    name: 'probe-plugin',
    kind: 'profile-dependency',
    state: 'update-available',
    currentVersion: '0.2.1',
    currentLine: '0.2.1',
    spec: '^0.2.1',
    targetVersion: '0.3.0',
    targetTag: 'latest',
    targetLine: '0.3.0',
    tags: [tag('latest', '0.3.0', 'other-line', false), tag('next', '0.2.9', 'same-line', true)],
    source: 'registry',
    at: '2026-09-19T10:00:00.000Z',
    ...overrides,
  }
}

/**
 * 一条 upgradeCheck 信封。
 *
 * @param units - 单元列表。
 * @returns op 信封。
 */
const checkEnvelope = (units) => ({
  ok: true,
  value: { environment: 'web', units, checked: true, lastCheckAt: '2026-09-19T10:00:00.000Z', notes: [] },
})

/**
 * 让对账收敛到"已装集合 + 检查结果"的稳态。
 *
 * 首次对账是"装配期读台账 → 检查结果落定 → sync"三步异步，所以这里等两件事实同时成立。
 *
 * @param handle - boot 的返回值。
 * @param names - 期望的注册 key。
 * @param options - `enter`：先模拟一次"打开某个包的页面"（触发进入即查）。
 */
async function untilKeys(handle, names, options = {}) {
  if (options.enter !== undefined) enterPage(handle, options.enter)
  for (let index = 0; index < 200; index += 1) {
    // 注册集合与检查结果是**两条独立的异步链**（前者由台账驱动，后者由检查 op 驱动）。
    // 只等 key 收敛会在一瞬间就返回——那一瞬检查还没落定，渲染出来的是"尚未检查更新"，
    // 断言会误判成"四态没实现"。所以要等的那件事必须由调用方点明。
    const settled = options.until === undefined || options.until()
    if (settled && JSON.stringify(handle.slots.keys()) === JSON.stringify(names)) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.deepEqual(handle.slots.keys(), names, '注册集合没有收敛到期望值')
}

/**
 * 等这一次检查落定（`check` 有值）。
 *
 * @param handle - boot 的返回值。
 * @param name - 触发检查的包名（模拟打开它的页面）。
 */
async function untilChecked(handle, name) {
  // 真机时序：装配期读台账（异步）→ 行注册 → 用户打开页面 → 行挂载 → effect 触发检查。
  // 所以先等行出现，再模拟"打开页面"——反过来会在行还没注册时就去取它的注入面。
  for (let index = 0; index < 200; index += 1) {
    if (handle.slots.keys().includes('plugins.bundle.config#' + name)) break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  enterPage(handle, name)
  for (let index = 0; index < 200; index += 1) {
    const state = faceOf(handle, name).face.hooks.upgrade.getSnapshot()
    if (state.check !== undefined) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('升级检查没有落定')
}

/**
 * 取某个包名升级行的注入面。
 *
 * @param handle - boot 的返回值。
 * @param name - 包名。
 * @returns 注入面。
 */
function faceOf(handle, name) {
  const entry = handle.slots.entry('plugins.bundle.config#' + name)
  assert.ok(entry !== undefined, '这个包名没有注册升级行：' + name + '（现有：' + handle.slots.keys().join(', ') + '）')
  return { entry, face: entry.options.inject() }
}

/**
 * 渲染某个包名的升级行。
 *
 * @param handle - boot 的返回值。
 * @param name - 包名。
 * @param view - 官方页面要的视图。
 * @returns 静态 HTML。
 */
function renderRow(handle, name, view = 'page') {
  const { entry, face } = faceOf(handle, name)
  const props = {
    t: handle.t,
    view,
    ...face,
    useUpgrade: (selector) => selector(face.hooks.upgrade.getSnapshot()),
  }
  return renderToStaticMarkup(React.createElement(entry.component, props))
}

/**
 * 模拟"用户打开这个包的页面"：挂载时的那次进入即查。
 *
 * 为什么测试要显式调它：`ensureUpgrades` 在组件里由 `useEffect` 触发，而本文件用的是
 * SSR（`renderToStaticMarkup`）——**React 的 effect 在 SSR 下不跑**。所以这里调的是
 * 组件挂载时会调的那个**同一个回调**（不是绕过 UI 直接改状态），只是由测试代跑。
 * 真实浏览器里这一步由 effect 完成（真机截图是那条路的证据）。
 *
 * @param handle - boot 的返回值。
 * @param name - 包名。
 */
function enterPage(handle, name) {
  faceOf(handle, name).face.ensureUpgrades()
}

describe('升级行：四态各自可辨（DESIGN §5.5）', () => {
  it('有更新：画升级入口、版本对与版本线，多 tag 时列出让用户挑', async () => {
    const handle = boot({ bundles: [{ name: 'probe-plugin', installed: true }] })
    const stub = stubFetch({ upgradeCheck: () => checkEnvelope([unit()]) })
    try {
      await untilChecked(handle, 'probe-plugin')
      const html = renderRow(handle, 'probe-plugin')
      assert.match(html, /当前 0\.2\.1 → 0\.3\.0/, '版本对必须在：' + html)
      assert.match(html, /升级到 0\.3\.0/, '升级按钮要写出目标版本')
      assert.match(html, /版本线/, '多个 dist-tag 时必须列出让用户挑')
      assert.match(html, /同线|另一条线/, '每条 tag 要标出它是哪条线')
      assert.match(html, /已安装，下次启动后加载。/, '生效时机沿用官方口径')
      assert.ok(!html.includes('查不到'), '有更新时不该出现"查不到"：' + html)
    } finally { stub.restore() }
  })

  it('已检查、无更新：插件页不显示（"已是最新"的口径在市场页/关于页）', async () => {
    const handle = boot({ bundles: [{ name: 'probe-plugin', installed: true }] })
    const stub = stubFetch({
      upgradeCheck: () => checkEnvelope([unit({ state: 'up-to-date', targetVersion: '0.2.1', targetTag: 'latest' })]),
    })
    try {
      // 关键：不是"画成一句已是最新"，而是**这个 key 根本不注册**（官方那一节因此不出现）。
      // 先让它注册（进入即查之前那一态），查完之后必须被释放——这条同时验了"多退"。
      // 注意：这里刻意**不**用 untilChecked——它在检查落定后返回，而本用例要验的正是
      // "落定之后那个 key 已经没了"，取注入面会当场抛（上一版就是这么红的）。
      for (let index = 0; index < 200; index += 1) {
        if (handle.slots.keys().includes('plugins.bundle.config#probe-plugin')) break
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      const probe = faceOf(handle, 'probe-plugin')
      const checkDone = () => probe.face.hooks.upgrade.getSnapshot().check !== undefined
      probe.face.ensureUpgrades()
      await untilKeys(handle, [], { until: checkDone })
      assert.deepEqual(handle.slots.keys(), [], 'up-to-date 不该占用注册 key')
    } finally { stub.restore() }
  })

  it('查不到：必须显示「查不到：<原因>」+ 重试，且绝不显示"已是最新"', async () => {
    const handle = boot({ bundles: [{ name: 'probe-plugin', installed: true }] })
    const stub = stubFetch({
      upgradeCheck: () => checkEnvelope([unit({
        state: 'unknown', targetVersion: null, targetTag: null, targetLine: null, tags: null,
        source: undefined, at: undefined, reason: 'registry 查询失败：ETIMEDOUT',
      })]),
    })
    try {
      await untilChecked(handle, 'probe-plugin')
      const html = renderRow(handle, 'probe-plugin')
      assert.match(html, /查不到：registry 查询失败：ETIMEDOUT/, '查不到必须带上原因：' + html)
      assert.match(html, /重新检查/, '查不到必须给重试入口')
      // 这是本用例的核心：查不到 ≠ 已是最新。
      assert.ok(!html.includes('已是最新'), '查不到绝不能显示"已是最新"：' + html)
      assert.ok(!html.includes('升级到'), '查不到时不该给出升级按钮：' + html)
    } finally { stub.restore() }
  })

  it('不可升级（安装方提供的层）：说明 + 命令，不给按钮', async () => {
    const handle = boot({ bundles: [{ name: '@deepseek-ai/dsh-web-app', installed: false }] })
    const stub = stubFetch({
      upgradeCheck: () => checkEnvelope([unit({
        name: '@deepseek-ai/dsh-web-app', kind: 'installation-provided', state: 'not-upgradable',
        currentVersion: '0.1.6-alpha.2', spec: undefined, targetVersion: null, targetTag: null,
        targetLine: null, tags: null, source: undefined, at: undefined,
        command: '升级 dsh 安装本身（例如 npm i -g @deepseek-ai/dsh@latest）',
      })]),
    })
    try {
      await untilChecked(handle, '@deepseek-ai/dsh-web-app')
      const html = renderRow(handle, '@deepseek-ai/dsh-web-app')
      assert.match(html, /由安装方提供，无法在当前环境内升级/, '要说清为什么升不了：' + html)
      assert.match(html, /npm i -g @deepseek-ai\/dsh@latest/, '要给可直接照做的命令')
      assert.ok(!html.includes('升级到'), '不可升级时不给按钮：' + html)
      assert.ok(!html.includes('查不到'), '不可升级是**结构事实**，不是"查不到"：' + html)
    } finally { stub.restore() }
  })

  it('summary 视图也只说这一态的事（查不到就是查不到）', async () => {
    const handle = boot({ bundles: [{ name: 'probe-plugin', installed: true }] })
    const stub = stubFetch({
      upgradeCheck: () => checkEnvelope([unit({
        state: 'unknown', targetVersion: null, tags: null, reason: '没有可用的版本事实',
      })]),
    })
    try {
      await untilChecked(handle, 'probe-plugin')
      const html = renderRow(handle, 'probe-plugin', 'summary')
      assert.match(html, /查不到：没有可用的版本事实/, 'summary 也要如实：' + html)
      assert.ok(!html.includes('已是最新'))
    } finally { stub.restore() }
  })
})

describe('注册实时对账：不留孤儿 key（DESIGN §5.5）', () => {
  it('装一个包 → 那一节当场出现；卸掉它 → 那一节当场消失（不是刷新后）', async () => {
    const handle = boot({ bundles: [{ name: 'probe-plugin', installed: true }] })
    const stub = stubFetch({ upgradeCheck: () => checkEnvelope([unit()]) })
    try {
      await untilChecked(handle, 'probe-plugin')
      assert.deepEqual(handle.slots.keys(), ['plugins.bundle.config#probe-plugin'])

      // 官方台账变化：装上第二个包（官方会推 plugin-manager/changed）。
      handle.ledger.bundles = [
        { name: 'probe-plugin', installed: true },
        { name: 'second-plugin', installed: true },
      ]
      handle.fire('plugin-manager/changed')
      await untilKeys(handle, ['plugins.bundle.config#probe-plugin', 'plugins.bundle.config#second-plugin'], {
        until: () => handle.slots.keys().length === 2,
      })

      // 再卸掉第一个包：它的 key 必须被释放（不留孤儿 key）。
      handle.ledger.bundles = [{ name: 'second-plugin', installed: true }]
      handle.fire('plugin-manager/changed')
      await untilKeys(handle, ['plugins.bundle.config#second-plugin'], {
        until: () => handle.slots.keys().length === 1,
      })
      // 释放必须真的调用过 disposer（不是把条目留在表里靠渲染兜住）。
      assert.equal(handle.slots.disposed.get('plugins.bundle.config#probe-plugin'), 1,
        '被撤掉的 key 必须调用过它自己的 disposer')
    } finally { stub.restore() }
  })

  it('连接重置也重新对账（换一个环境后已装集合会不同）', async () => {
    const handle = boot({ bundles: [{ name: 'probe-plugin', installed: true }] })
    const stub = stubFetch({ upgradeCheck: () => checkEnvelope([unit()]) })
    try {
      await untilChecked(handle, 'probe-plugin')
      handle.ledger.bundles = [{ name: 'other-plugin', installed: true }]
      handle.fire('connection/reset')
      await untilKeys(handle, ['plugins.bundle.config#other-plugin'], {
        until: () => handle.slots.keys()[0] === 'plugins.bundle.config#other-plugin',
      })
    } finally { stub.restore() }
  })

  it('本插件自己的 key 由配置面独占（不重复注册，否则官方 keyed slot 会抛）', async () => {
    const handle = boot({ bundles: [{ name: OUR_PACKAGE, installed: true }] })
    const stub = stubFetch({
      upgradeCheck: () => checkEnvelope([unit({ name: OUR_PACKAGE, kind: 'self' })]),
    })
    try {
      await new Promise(resolve => setTimeout(resolve, 80))
      // 只允许存在一条：配置面那条（它一直在，且不在 keys() 的升级行视图里）。
      const registrations = handle.slots.registrations.filter(
        entry => entry.options.name === 'plugins.bundle.config' && entry.options.key === OUR_PACKAGE)
      assert.equal(registrations.length, 1,
        '本插件自己的 key 只能注册一次（第二次同 key 同优先级会被官方 register 抛 already has an entry）')
      assert.deepEqual(handle.slots.keys(), [], '升级行不该占用本插件自己的 key')
    } finally { stub.restore() }
  })

  it('台账读不到时不清空已注册的行（"读不到"不等于"什么都没装"）', async () => {
    const handle = boot({ bundles: [{ name: 'probe-plugin', installed: true }] })
    const stub = stubFetch({ upgradeCheck: () => checkEnvelope([unit()]) })
    try {
      await untilChecked(handle, 'probe-plugin')
      assert.deepEqual(handle.slots.keys(), ['plugins.bundle.config#probe-plugin'])
      // 台账开始报错（网络抖动 / Remote 卸载）：已注册的行必须留着。
      handle.ledger.bundles = undefined
      handle.fire('plugin-manager/changed')
      await new Promise(resolve => setTimeout(resolve, 80))
      assert.deepEqual(handle.slots.keys(), ['plugins.bundle.config#probe-plugin'],
        '台账读不到时清空注册集合，会让用户正在看的升级入口无故消失')
    } finally { stub.restore() }
  })
})

describe('结果诚实：失败态不得渲染成完成', () => {
  it('试装拦下（canary-not-passed）= 没有升级；归到 rolled-back 而不是完成', () => {
    const outcome = view.upgradeOutcome({ ok: false, code: 'canary-not-passed', canary: { ran: true, conclusion: 'candidate-broken' } })
    assert.equal(outcome, 'rolled-back', '试装拦下是"没动真实环境"，不是"升级失败"也不是"完成"')
    assert.notEqual(outcome, 'done')
    assert.equal(view.upgradeOutcome({ ok: false, code: 'package-operation-failed' }), 'failed')
    assert.equal(view.upgradeOutcome({ ok: true, canary: { ran: true, conclusion: 'passed' } }), 'done')
  })

  it('金丝雀没跑 = 没验证（既不是通过也不是失败）', () => {
    assert.equal(view.upgradeOutcome({ ok: true, canary: { ran: false } }), 'unverified',
      '"没验证就升级了"必须能被看出来，否则用户以为验证过了')
    assert.equal(view.canaryVerdict({ ran: false }), 'not-run')
    assert.equal(view.canaryVerdict({ ran: true, conclusion: 'passed' }), 'passed')
    assert.equal(view.canaryVerdict({ ran: true, conclusion: 'cannot-trial' }), 'failed',
      '"没能验证"（cannot-trial）与"验证失败"一样都不算通过')
    assert.equal(view.canaryVerdict(undefined), 'absent', '宿主没给金丝雀字段时不宣称任何结论')
  })

  it('盘上核对读不出来时是 undefined（不是 false——"读不出来"不是"不干净"）', () => {
    assert.equal(view.diskVerified({ ok: true }), true)
    assert.equal(view.diskVerified({ ok: false, clean: false }), false)
    assert.equal(view.diskVerified({ ok: false, clean: true }), true, 'ok=false 但盘上核对干净时以核对为准')
  })

  it('一次真实升级失败：状态里落下的是失败，不是完成', async () => {
    const handle = boot({ bundles: [{ name: 'probe-plugin', installed: true }] })
    const stub = stubFetch({
      upgradeCheck: () => checkEnvelope([unit()]),
      upgrade: () => ({ ok: true, value: { jobId: 'job-1' } }),
      job: () => ({
        ok: true,
        value: {
          done: true,
          result: {
            ok: false,
            code: 'canary-not-passed',
            output: '金丝雀没通过：新版本装进快照环境后挂不起来 —— 没有在真实环境执行升级',
            name: 'probe-plugin', fromVersion: '0.2.1', toVersion: '0.3.0', spec: 'probe-plugin@0.3.0',
            canary: {
              ran: true, conclusion: 'candidate-broken', cleanup: '测试环境已删除',
              output: '根因链：duplicate loader entry id',
            },
            diskFacts: ['依赖声明：^0.2.1'],
            restartRequired: false,
          },
        },
      }),
    })
    try {
      await untilChecked(handle, 'probe-plugin')
      const { face } = faceOf(handle, 'probe-plugin')
      face.upgradePackage('probe-plugin', '0.3.0', '^0.2.1')
      for (let index = 0; index < 200; index += 1) {
        if (face.hooks.upgrade.getSnapshot().action !== undefined) break
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      const action = face.hooks.upgrade.getSnapshot().action
      assert.equal(action.outcome, 'rolled-back', '试装拦下的结论必须是"没升级"：' + JSON.stringify(action))
      assert.equal(action.ok, false)
      assert.equal(action.canary, 'failed', '金丝雀跑了但没通过')
      // 根因链在 canaryOutput 里（顶层 output 是结论层，细节在下面一层）：
      // 契约要求"试装未通过 = 没升级"可追责，所以金丝雀原文必须一起带出来。
      assert.match(action.canaryOutput, /duplicate loader entry id/, '根因链要留给用户追责')
      assert.notEqual(action.outcome, 'done')
    } finally { stub.restore() }
  })

  it('传输层失败也写成 failed（不留"什么都没说"的状态）', async () => {
    const handle = boot({ bundles: [{ name: 'probe-plugin', installed: true }] })
    const stub = stubFetch({ upgradeCheck: () => checkEnvelope([unit()]) })
    try {
      await untilChecked(handle, 'probe-plugin')
      const { face } = faceOf(handle, 'probe-plugin')
      // upgrade 这个 op 没有桩件 → stubFetch 抛"未预期的 op"，等价于传输层失败。
      face.upgradePackage('probe-plugin', '0.3.0', '^0.2.1')
      for (let index = 0; index < 200; index += 1) {
        if (face.hooks.upgrade.getSnapshot().action !== undefined) break
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      const action = face.hooks.upgrade.getSnapshot().action
      assert.equal(action.outcome, 'failed', '传输失败也是失败，不能留空：' + JSON.stringify(action))
      assert.equal(action.ok, false)
    } finally { stub.restore() }
  })
})

describe('市场页卡片：升级到 x.y.z（零新机制）', () => {
  it('已装且有更新 → 出现；未安装 / 无更新 / 版本读不到 → 不出现', () => {
    const updateAvailable = (item) => {
      if (item.installed !== true) return false
      if (item.installedVersion === undefined || item.latestVersion === undefined) return false
      return item.installedVersion < item.latestVersion
    }
    assert.equal(view.marketUpgradeTarget(
      { installed: true, installedVersion: '0.2.1', latestVersion: '0.3.0' }, updateAvailable), '0.3.0')
    assert.equal(view.marketUpgradeTarget(
      { installed: false, installedVersion: '0.2.1', latestVersion: '0.3.0' }, updateAvailable), undefined,
    '未安装的条目不该出现升级入口（它该装而不是升）')
    assert.equal(view.marketUpgradeTarget(
      { installed: true, installedVersion: '0.3.0', latestVersion: '0.3.0' }, updateAvailable), undefined,
    '没有更新时不出现')
    assert.equal(view.marketUpgradeTarget(
      { installed: true, installedVersion: '0.2.1' }, updateAvailable), undefined,
    '版本读不到时不出现（不猜一个版本出来）')
    assert.equal(view.marketUpgradeTarget({ installed: true, latestVersion: '' }, updateAvailable), undefined,
    '空版本号不是版本')
  })

  it('市场页渲染出「升级到 0.3.0」，且走的是同一条升级通道（不是新开一条安装路径）', async () => {
    const handle = boot({
      bundles: [{ name: 'probe-plugin', installed: true }],
      // 市场页要 indexUrl 之外的完整配置形状；空对象即可（客户端会补默认值）。
      config: {},
    })
    const stub = stubFetch({
      upgradeCheck: () => checkEnvelope([unit()]),
      marketplace: () => ({ ok: true, value: {
        items: [{
          repo: 'alice/dsh-probe', name: 'probe-plugin', description: 'probe', stars: 1, updatedAt: null,
          topics: [], installed: true, installedVersion: '0.2.1', latestVersion: '0.3.0',
          packageName: 'probe-plugin', installSpec: 'probe-plugin',
        }],
        generatedAt: '2026-09-19T10:00:00.000Z', cached: false, categories: {},
      } }),
    })
    try {
      await untilChecked(handle, 'probe-plugin')
      const entry = handle.slots.registrations.find(
        item => item.options.name === 'settings.section' && item.options.id === 'marketplace')
      assert.ok(entry !== undefined, '市场页注册项不见了')
      const face = entry.options.inject()
      const props = {
        t: handle.t,
        ...face,
        useMarketplace: (selector) => selector(face.hooks.marketplace.getSnapshot()),
        useUpgrade: (selector) => selector(face.hooks.upgrade.getSnapshot()),
      }
      // 落地即读索引由 effect 触发（SSR 不跑 effect）：这里调组件会调的那个回调。
      face.loadMarketplace(false)
      for (let index = 0; index < 200; index += 1) {
        if (face.hooks.marketplace.getSnapshot().result !== undefined) break
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      const html = renderToStaticMarkup(React.createElement(entry.component, props))
      assert.match(html, /升级到 0\.3\.0/, '已装且有更新的条目要出现升级入口：' + html.slice(0, 400))
    } finally { stub.restore() }
  })
})

describe('纯决策层：四态映射与注册集合（逐态断言）', () => {
  it('state → 形态是逐态显式的，未知状态归到"查不到"（绝不归到"已是最新"）', () => {
    assert.equal(view.rowKindOf({ state: 'update-available' }), 'upgrade')
    assert.equal(view.rowKindOf({ state: 'up-to-date' }), 'hidden')
    assert.equal(view.rowKindOf({ state: 'unknown' }), 'unknown')
    assert.equal(view.rowKindOf({ state: 'not-upgradable' }), 'command')
    assert.equal(view.rowKindOf({ state: 'brand-new-state' }), 'unknown',
      '读不懂的状态必须归到"查不到"——归到 hidden 就是把不知道说成已是最新')
    assert.equal(view.rowKindOf({ state: '' }), 'unknown')
  })

  it('只有 up-to-date 不可见；其余三态都必须被画出来', () => {
    const visible = ['update-available', 'unknown', 'not-upgradable'].map(state => view.rowVisible({ state }))
    assert.deepEqual(visible, [true, true, true], '三态都不许靠缺席传达')
    assert.equal(view.rowVisible({ state: 'up-to-date' }), false)
  })

  it('注册集合：已装 ∧（还没查过 ∨ 要显示）；查过且已是最新的包会被撤掉', () => {
    const installed = ['a', 'b', 'c', 'd']
    const units = [
      { name: 'a', state: 'update-available' },
      { name: 'b', state: 'up-to-date' },
      { name: 'c', state: 'not-upgradable' },
    ]
    // d 还没查过 → 注册（否则永远没有东西去触发那次检查）；b 查过且已是最新 → 撤掉。
    assert.deepEqual(view.registeredNames(installed, units), ['a', 'c', 'd'])
    // 还没检查过：所有已装的都注册。
    assert.deepEqual(view.registeredNames(installed, undefined), ['a', 'b', 'c', 'd'])
    // 未安装的包即使查过也不注册（不凭空占 key）。
    assert.deepEqual(view.registeredNames(['a'], units), ['a'])
  })

  it('默认 tag 永远落在列表里（找不到时退到 preferred，再退到第一个）', () => {
    const withTags = (tags, targetTag) => ({ tags, targetTag })
    assert.equal(view.defaultTag(withTags([tag('next', '0.2.9', 'same-line', true), tag('latest', '0.3.0', 'other-line', false)], 'latest')), 'latest')
    assert.equal(view.defaultTag(withTags([tag('next', '0.2.9', 'same-line', true)], 'gone')), 'next',
      'host 给的 targetTag 不在列表里时退到 preferred')
    assert.equal(view.defaultTag(withTags([], 'latest')), undefined)
    assert.equal(view.defaultTag(withTags(null, 'latest')), undefined)
  })

  it('同线/异线与"与当前相同"：异线要能提示会切到另一条线', () => {
    const u = {
      currentVersion: '0.2.1',
      targetVersion: '0.3.0',
      targetTag: 'latest',
      tags: [tag('latest', '0.3.0', 'other-line', false), tag('next', '0.2.9', 'same-line', true)],
    }
    assert.equal(view.changesLine(u, 'latest'), true, 'latest 是另一条线')
    assert.equal(view.changesLine(u, 'next'), false, 'next 与当前同线')
    assert.equal(view.sameAsCurrent(u, 'next'), false)
    assert.equal(view.sameAsCurrent({ ...u, tags: [tag('old', '0.2.1', 'same-line', true)] }, 'old'), true,
      '所选版本等于当前版本时不给可点按钮（DESIGN §5.5）')
    assert.equal(view.sameAsCurrent({ ...u, currentVersion: null }, 'latest'), false,
      '当前版本读不到时不算"相同"（否则按钮会被永久禁用）')
  })
})

describe('真机实测抓到的两个缺陷：回归闸（单测曾经全绿而真机不工作）', () => {
  it('① 服务可见性：必须用 ctx.inject 声明 remote.pluginManager，而不是根 ctx 上 get', async () => {
    const handle = boot({ bundles: [{ name: 'probe-plugin', installed: true }] })
    const stub = stubFetch({ upgradeCheck: () => checkEnvelope([unit()]) })
    try {
      // 真机症状：`ctx.get('remote.pluginManager')` 恒为 undefined（那是一个独立的 cordis 服务，
      // 只有**声明了它**的作用域里才解析得到）。当时升级行永远停在"尚未检查更新"，
      // 而单测的桩件恰好把 pluginManager 挂在 remote 对象上，所以测试全绿。
      // 闸门：产物必须真的声明过这个服务。
      assert.ok(handle.slots.injected.includes('inject:slots,remote.pluginManager'),
        '必须用 ctx.inject 声明 [slots, remote.pluginManager]，实到：' + JSON.stringify(handle.slots.injected))
      await untilChecked(handle, 'probe-plugin')
    } finally { stub.restore() }
  })

  it('② Hook 顺序："还没查过"那一态不许挡在 useEffect 前面（否则进入即查永不触发）', () => {
    // 真机症状：组件在到达 useEffect 之前就 return 了 → 打开页面时**永远不会**发起检查，
    // 行停在"尚未检查更新"（手点按钮能查，所以肉眼很难判断是坏的）。
    // 这条用源码级断言钉住顺序：`ensureUpgrades` 的 useEffect 必须出现在第一个 `if (unit === undefined)` 之前。
    const source = readFileSync('src/client/UpgradeRow.tsx', 'utf8')
    const effectAt = source.indexOf('actions.ensureUpgrades()')
    const earlyReturnAt = source.indexOf('if (unit === undefined)')
    assert.ok(effectAt >= 0, 'UpgradeRow 里找不到 ensureUpgrades 的 effect（进入即查没了？）')
    assert.ok(earlyReturnAt >= 0, 'UpgradeRow 里找不到"还没查过"那一态')
    assert.ok(effectAt < earlyReturnAt,
      '进入即查的 useEffect 必须在"还没查过"的提前 return 之前——否则 Hook 不执行，打开页面永不检查')
    // 而且它必须真的是一个 useEffect（不是散在渲染体里的一次性调用）。
    assert.match(source, /useEffect\(\(\) => \{ actions\.ensureUpgrades\(\) \}/,
      '进入即查必须包在 useEffect 里（渲染期直接发请求会在每次重画时重复触发）')
  })

  it('③ 升级成功后重查把包判成 up-to-date 时，那一节必须留着（否则结果跟着消失）', () => {
    // 真机症状：点完升级 → 成功 → 重查把包判成 up-to-date → key 被释放 →
    // 那一节当场消失，**连同刚写下的结果一起**。用户看到界面恢复原样，不知道刚才那次是成是败。
    const installed = ['a', 'b']
    const upToDate = [{ name: 'a', state: 'up-to-date' }, { name: 'b', state: 'update-available' }]
    assert.deepEqual(view.registeredNames(installed, upToDate), ['b'], '没有待处置结果时，up-to-date 照旧撤掉')
    assert.deepEqual(view.registeredNames(installed, upToDate, ['a']), ['a', 'b'],
      'a 有一次还没被处置的结果 → 它的 key 必须留着，否则结果跟着那一节一起消失')
  })

  it('④ 查过了但这一轮没有它 → 什么都不画（不编"尚未检查更新"）', async () => {
    // 真机症状：升级成功后重查，那个包不再出现在 units 里，而它的 key 还在（结果待处置）→
    // 行画成"尚未检查更新 + 检查更新"，等于**编了一个不存在的事实**。
    const handle = boot({ bundles: [{ name: 'probe-plugin', installed: true }] })
    const stub = stubFetch({
      upgradeCheck: () => checkEnvelope([unit()]),
      upgrade: () => ({ ok: true, value: { jobId: 'job-1' } }),
      job: () => ({ ok: true, value: { done: true, result: {
        ok: true, output: '已升级 probe-plugin：0.2.1 → 0.3.0', name: 'probe-plugin',
        fromVersion: '0.2.1', toVersion: '0.3.0', spec: 'probe-plugin@0.3.0',
        canary: { ran: true, conclusion: 'passed', cleanup: '测试环境已删除' },
        diskFacts: [], restartRequired: true,
      } } }),
    })
    try {
      await untilChecked(handle, 'probe-plugin')
      const { face } = faceOf(handle, 'probe-plugin')
      face.upgradePackage('probe-plugin', '0.3.0', '^0.2.1')
      for (let index = 0; index < 200; index += 1) {
        if (face.hooks.upgrade.getSnapshot().action !== undefined) break
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      const state = face.hooks.upgrade.getSnapshot()
      assert.equal(state.action?.outcome, 'done')
      // 模拟"重查之后这个包不再是升级单元"那一轮（host 侧 up-to-date 时不再列出）。
      face.hooks.upgrade.update((draft) => {
        draft.check = { environment: 'web', units: [], checked: true, lastCheckAt: null, notes: [] }
      })
      const html = renderRow(handle, 'probe-plugin')
      assert.ok(!html.includes('尚未检查更新'),
        '这一轮查过了、只是没有它 —— 不许画成"尚未检查更新"（那是编事实）：' + html)
      assert.match(html, /data-upgrade-outcome="done"/, '结果必须还在：' + html)
    } finally { stub.restore() }
  })

  it('③b 接线：控制器里那次重查把包判成 up-to-date 后，那一节仍在（keep 真的被用上）', async () => {
    // ③ 验的是纯函数；这一条验**接线**——变异 M8（把 keep 传成空数组）在 ③ 上是绿的，
    // 因为 ③ 直接调 registeredNames 并显式传了 keep。真正会漏的是"控制器没把它接上"。
    const handle = boot({ bundles: [{ name: 'probe-plugin', installed: true }] })
    let round = 0
    const stub = stubFetch({
      // 第一轮：有更新（让行注册）；第二轮（升级后的自动重查）：up-to-date（没有 keep 就会撤掉 key）。
      upgradeCheck: () => {
        round += 1
        return checkEnvelope([round === 1
          ? unit()
          : unit({ state: 'up-to-date', targetVersion: '0.2.1', targetTag: 'latest' })])
      },
      upgrade: () => ({ ok: true, value: { jobId: 'job-1' } }),
      job: () => ({ ok: true, value: { done: true, result: {
        ok: true, output: '已升级 probe-plugin：0.2.1 → 0.3.0', name: 'probe-plugin',
        fromVersion: '0.2.1', toVersion: '0.3.0', spec: 'probe-plugin@0.3.0',
        canary: { ran: true, conclusion: 'passed', cleanup: '测试环境已删除' },
        diskFacts: [], restartRequired: true,
      } } }),
    })
    try {
      await untilChecked(handle, 'probe-plugin')
      const { face } = faceOf(handle, 'probe-plugin')
      face.upgradePackage('probe-plugin', '0.3.0', '^0.2.1')
      for (let index = 0; index < 200; index += 1) {
        if (face.hooks.upgrade.getSnapshot().action !== undefined) break
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      // 升级后的自动重查已经把 check 换成 up-to-date 的那一轮。
      assert.equal(round >= 2, true, '升级成功后必须重查一次（实际轮数 ' + String(round) + '）')
      assert.equal(handle.slots.keys().includes('plugins.bundle.config#probe-plugin'), true,
        '重查判成 up-to-date 之后那一节必须还在（否则结果跟着消失）：' + handle.slots.keys().join(','))
      const html = renderRow(handle, 'probe-plugin')
      assert.match(html, /data-upgrade-outcome="done"/, '结果必须还看得见：' + html)
    } finally { stub.restore() }
  })

  it('⑤ 盘上事实不许出现两遍（结构化列表 + 原始原文里的同一批事实）', async () => {
    // 真机症状：结果块里既有结构化的「盘上事实」列表，又把 host 拼的原文整段贴出来，
    // 原文里那段「升级前/升级后 + 依赖声明…」与列表是同一批事实的第二遍（§12.3.1）。
    const handle = boot({ bundles: [{ name: 'probe-plugin', installed: true }] })
    const stub = stubFetch({
      upgradeCheck: () => checkEnvelope([unit()]),
      upgrade: () => ({ ok: true, value: { jobId: 'job-1' } }),
      job: () => ({ ok: true, value: { done: true, result: {
        ok: true,
        output: [
          '已升级 probe-plugin：0.2.1 → 0.3.0',
          '本次 spec：probe-plugin@0.3.0',
          '金丝雀：通过（深度 shallow，耗时 900ms）',
          '测试环境已删除',
          '生效时机：下次启动后加载',
          '',
          '升级前：',
          '  依赖声明：probe-plugin = 0.2.1',
          '升级后：',
          '  依赖声明：probe-plugin = 0.3.0',
          '',
          '官方输出：',
          '  Progress: resolved 1, reused 0, downloaded 1',
        ].join('\n'),
        name: 'probe-plugin', fromVersion: '0.2.1', toVersion: '0.3.0', spec: 'probe-plugin@0.3.0',
        canary: { ran: true, conclusion: 'passed', cleanup: '测试环境已删除' },
        diskFacts: ['依赖声明：probe-plugin = 0.3.0'],
        restartRequired: true,
      } } }),
    })
    try {
      await untilChecked(handle, 'probe-plugin')
      const { face } = faceOf(handle, 'probe-plugin')
      face.upgradePackage('probe-plugin', '0.3.0', '^0.2.1')
      for (let index = 0; index < 200; index += 1) {
        if (face.hooks.upgrade.getSnapshot().action !== undefined) break
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      const html = renderRow(handle, 'probe-plugin')
      // 结构化列表给的是升级**后**的事实；原文里那段"升级前"是列表没有的 → 允许保留。
      // 但原文里与列表重复的那一行（升级后的依赖声明）不该再出现一次。
      const hits = (html.match(/依赖声明：probe-plugin = 0\.3\.0/g) ?? []).length
      assert.equal(hits, 1, '升级后的依赖声明只能出现一次（结构化列表那份）：' + html)
      // 表头（"官方输出："）本身是被剥掉的分隔标记，不重复显示；那一段的**内容**必须留着。
      assert.match(html, /Progress: resolved 1/, '官方通道的尾部输出要保留（失败时它是唯一线索）')
    } finally { stub.restore() }
  })
})

describe('结果块渲染：四档各自可辨（失败态不得渲染成完成）', () => {
  /** 造一次升级：走真实的那条路（upgrade op → job 轮询 → 状态落定）。 */
  async function upgradeOnce(handle, result) {
    const { face } = faceOf(handle, 'probe-plugin')
    face.upgradePackage('probe-plugin', '0.3.0', '^0.2.1')
    for (let index = 0; index < 200; index += 1) {
      if (face.hooks.upgrade.getSnapshot().action !== undefined) break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    return { face, html: renderRow(handle, 'probe-plugin') }
  }

  /** 升级 op 的桩件：首包 jobId，job 落定给 result。 */
  const upgradeStub = (result) => ({
    upgradeCheck: () => checkEnvelope([unit()]),
    upgrade: () => ({ ok: true, value: { jobId: 'job-1' } }),
    job: () => ({ ok: true, value: { done: true, result } }),
  })

  it('成功：写"已升级"，并说清生效时机（官方口径）', async () => {
    const handle = boot({ bundles: [{ name: 'probe-plugin', installed: true }] })
    const stub = stubFetch(upgradeStub({
      ok: true, output: '已升级 probe-plugin：0.2.1 → 0.3.0', name: 'probe-plugin',
      fromVersion: '0.2.1', toVersion: '0.3.0', spec: 'probe-plugin@0.3.0',
      canary: { ran: true, conclusion: 'passed', cleanup: '测试环境已删除' },
      diskFacts: ['依赖声明：^0.3.0'], restartRequired: true,
    }))
    try {
      await untilChecked(handle, 'probe-plugin')
      const { html } = await upgradeOnce(handle)
      assert.match(html, /data-upgrade-outcome="done"/, '结论必须是 done：' + html)
      assert.match(html, /已升级 probe-plugin：0\.2\.1 → 0\.3\.0/)
      assert.match(html, /下次启动生效/, '生效时机沿用官方口径')
      assert.match(html, /验证通过/)
    } finally { stub.restore() }
  })

  it('没验证：成功路径上也要说出"这次没有验证"，且不能画成通过', async () => {
    const handle = boot({ bundles: [{ name: 'probe-plugin', installed: true }] })
    const stub = stubFetch(upgradeStub({
      ok: true, output: '已升级 probe-plugin：0.2.1 → 0.3.0', name: 'probe-plugin',
      fromVersion: '0.2.1', toVersion: '0.3.0', spec: 'probe-plugin@0.3.0',
      canary: { ran: false, skippedReason: '试装总开关关着', cleanup: '没有创建测试环境' },
      diskFacts: [], restartRequired: true,
    }))
    try {
      await untilChecked(handle, 'probe-plugin')
      const { html } = await upgradeOnce(handle)
      assert.match(html, /data-upgrade-outcome="unverified"/, '必须是 unverified，不能是 done：' + html)
      assert.match(html, /已升级 probe-plugin（这次没有验证）/, '标题要说清"这次没有验证"：' + html)
      assert.match(html, /原因：试装总开关关着/)
      assert.ok(!html.includes('验证通过'), '"没验证"绝不能出现"验证通过"：' + html)
      // 同一件事只说一遍（§12.3.1）：真机实测里「这次没有验证」出现过两次（标题一次、
      // 金丝雀那一行又一次），这一条照着截图改。
      assert.equal((html.match(/这次没有验证/g) ?? []).length, 1,
        '「这次没有验证」只能说一次（标题已经说了，金丝雀那行不许重复）：' + html)
    } finally { stub.restore() }
  })

  it('试装拦下：写"没有升级"，真实环境没被动过', async () => {
    const handle = boot({ bundles: [{ name: 'probe-plugin', installed: true }] })
    const stub = stubFetch(upgradeStub({
      ok: false, code: 'canary-not-passed',
      output: '金丝雀没通过：新版本装进快照环境后挂不起来 —— 没有在真实环境执行升级',
      name: 'probe-plugin', fromVersion: '0.2.1', toVersion: '0.3.0', spec: 'probe-plugin@0.3.0',
      canary: {
        ran: true, conclusion: 'candidate-broken', cleanup: '测试环境已删除',
        output: '根因链：duplicate loader entry id', activation: { activated: true },
      },
      diskFacts: ['依赖声明：^0.2.1'], restartRequired: false,
    }))
    try {
      await untilChecked(handle, 'probe-plugin')
      const { html } = await upgradeOnce(handle)
      assert.match(html, /data-upgrade-outcome="rolled-back"/, '必须是 rolled-back：' + html)
      assert.match(html, /没有升级 probe-plugin：新版本没通过验证/)
      assert.match(html, /duplicate loader entry id/, '根因链必须在界面上可追责')
      assert.match(html, /新版本已进入启动列表/, '激活证据要说出来')
      assert.ok(!html.includes('已升级'), '试装拦下时绝不能出现"已升级"：' + html)
    } finally { stub.restore() }
  })

  it('升级没完成：写"没有完成"，不画成成功', async () => {
    const handle = boot({ bundles: [{ name: 'probe-plugin', installed: true }] })
    const stub = stubFetch(upgradeStub({
      ok: false, code: 'package-operation-failed',
      output: '升级命令退出码 1，盘上版本是 0.2.1（期望 0.3.0）',
      name: 'probe-plugin', fromVersion: '0.2.1', toVersion: '0.3.0', spec: 'probe-plugin@0.3.0',
      canary: { ran: true, conclusion: 'passed', cleanup: '测试环境已删除' },
      diskFacts: ['依赖声明：^0.2.1'], restartRequired: false,
    }))
    try {
      await untilChecked(handle, 'probe-plugin')
      const { html } = await upgradeOnce(handle)
      assert.match(html, /data-upgrade-outcome="failed"/, '必须是 failed：' + html)
      assert.match(html, /升级没有完成：probe-plugin/)
      assert.ok(!html.includes('已升级 probe-plugin'), '失败绝不能画成"已升级"：' + html)
    } finally { stub.restore() }
  })

  it('结果只画在自己那个包的行里（A 的结果不会挂在 B 的页面上）', async () => {
    const handle = boot({
      bundles: [{ name: 'probe-plugin', installed: true }, { name: 'other-plugin', installed: true }],
    })
    const stub = stubFetch({
      upgradeCheck: () => checkEnvelope([unit(), unit({ name: 'other-plugin' })]),
      upgrade: () => ({ ok: true, value: { jobId: 'job-1' } }),
      job: () => ({ ok: true, value: { done: true, result: {
        ok: false, code: 'canary-not-passed', output: '没有在真实环境执行升级',
        name: 'probe-plugin', fromVersion: '0.2.1', toVersion: '0.3.0', spec: 'probe-plugin@0.3.0',
        canary: { ran: true, conclusion: 'candidate-broken', cleanup: '已删除' },
        diskFacts: [], restartRequired: false,
      } } }),
    })
    try {
      await untilChecked(handle, 'probe-plugin')
      const { face } = faceOf(handle, 'probe-plugin')
      face.upgradePackage('probe-plugin', '0.3.0', '^0.2.1')
      for (let index = 0; index < 200; index += 1) {
        if (face.hooks.upgrade.getSnapshot().action !== undefined) break
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      const own = renderRow(handle, 'probe-plugin')
      const other = renderRow(handle, 'other-plugin')
      assert.match(own, /data-upgrade-outcome=/, '自己的页面要有结果')
      assert.ok(!other.includes('data-upgrade-outcome'), '别人的页面不该有这一结果：' + other.slice(0, 300))
    } finally { stub.restore() }
  })
})

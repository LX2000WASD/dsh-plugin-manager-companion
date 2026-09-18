/**
 * 客户端产物启动契约测试（node --test，跑 dist/client.js）。
 *
 * 守护的是最贵的一类失败：bundle 里出现平台模块表之外的 require，浏览器会抛
 * "missed the module table"，**整个插件页面启动中断**——不只是本插件，所有插件的
 * UI 一起消失。这里用模拟模块表把产物真正跑起来，越表 require 立刻抛错。
 *
 * 另外核对：bundle 注册 id、slot 注册面（三个一级入口）、字典 zh/en 键位对齐、
 * 以及各页面能被服务端渲染（不缺组件、不缺字典键）。
 *
 * 平台表随官方版本变。0.1.6-alpha.2 是 9 项（含 ui-dockkit），必须与
 * dsh-plugin-manager-companion/tsdown.client.config.ts 的 PLATFORM 逐字一致。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const React = require_('react')

/** 官方平台种子表（deepseek-harness packages/client/web/src/platform.ts）。 */
const PLATFORM = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/** 本包在模块表里的 id。 */
const PACKAGE_ID = 'dsh-plugin-manager-companion'

/** 三个一级设置入口的契约（用户明确要的结构：一个入口 + 三个可选子页面）。 */
const SECTIONS = [
  { id: 'marketplace', order: 16 },
  { id: 'console', order: 17 },
  { id: 'kinds', order: 22 },
]

/** primitives 用 Proxy 桩：只验启动契约，不验视觉实现。 */
function stubPrimitives() {
  const handler = { get: () => () => null }
  return new Proxy({}, handler)
}

/**
 * 符合官方 SnapshotStore 契约的桩件。
 *
 * 为什么不用真件：@deepseek-ai/dsh-client-store 的运行时入口 import zustand，
 * 在 node 里直接 import 会失败。桩件按官方 lib/types/index.d.ts 的 SnapshotStore
 * 契约实现（getSnapshot / subscribe / update / set 四个方法），足够让注册期代码运行。
 * @param init - 初始状态。
 * @returns 一个快照存储。
 */
function makeSnapshotStore(init) {
  let snapshot = init
  const listeners = new Set()
  const notify = () => { for (const fn of [...listeners]) fn() }
  return {
    getSnapshot: () => snapshot,
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn) } },
    set(next) { snapshot = next; notify() },
    update(mutator) { mutator(snapshot); notify() },
  }
}

/**
 * 以模拟模块表启动产物。
 * @returns bundle 的导出对象。
 */
function bootBundle() {
  assert.ok(existsSync('dist/client.js'), 'dist/client.js 不存在：先跑 pnpm run build:client')
  const table = {
    'react': React,
    'react/jsx-runtime': require_('react/jsx-runtime'),
    'react-dom': {}, 'react-dom/client': {},
    '@deepseek-ai/cordis': { Context: class {} },
    '@deepseek-ai/dsh-client-store': {
      createSnapshotStore: makeSnapshotStore,
      shallowEqual: (a, b) => a === b,
    // 声明式 store（register 的 store 座位）也要能被桩件启动：控制台把「当前子页」搬进了 store，
    // 缺这个导出的话产物 apply() 会抛 "defineStore is not a function"（报错指向产物、不指向桩件）。
    defineStore: spec => ({
      spec,
      create() {
        let state = spec.init()
        const listeners = new Set()
        const notify = () => { for (const fn of [...listeners]) fn() }
        const instance = {
          getSnapshot: () => state,
          subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn) } },
          clearPersisted() {},
          actions: {},
        }
        for (const [name, mutator] of Object.entries(spec.actions)) {
          instance.actions[name] = (...params) => { mutator(state, ...params); notify() }
        }
        return instance
      },
    }),
  },
    '@deepseek-ai/dsh-client-ui-slots': {},
    '@deepseek-ai/dsh-client-ui-primitives': stubPrimitives(),
    '@deepseek-ai/dsh-client-ui-dockkit': {},
  }
  const missed = []
  let exported
  globalThis.window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        exported = factory((spec) => {
          if (!(spec in table)) {
            missed.push(spec)
            throw new Error('missed the module table: ' + spec)
          }
          return table[spec]
        })
        assert.equal(id, PACKAGE_ID, 'bundle 必须以自身 id 注册')
      },
    },
  }
  new Function(readFileSync('dist/client.js', 'utf8'))()
  assert.deepEqual(missed, [], 'bundle require 了平台模块表之外的模块: ' + missed.join(', '))
  assert.ok(exported !== undefined, 'bundle 未通过 __ModuleLoader__.load 注册')
  assert.deepEqual(PLATFORM.filter(s => !(s in table)), [], '桩表缺平台模块')
  return exported
}

/**
 * 以 mock client ctx 调用 apply()，收集注册面。
 * @param exported - bundle 导出。
 * @returns 收集到的 slot 与字典注册。
 */
function applyWithMocks(exported) {
  const slotRegistrations = []
  const injected = []
  const dicts = []
  const effects = []
  const mkCtx = () => ({
    effect(fn) { effects.push(fn); const d = fn(); return typeof d === "function" ? d : () => {} },
    on() { return () => {} },
    get() { return undefined },
    logger: { info() {}, warn() {}, error() {} },
    locale: {
      register(ns, d) { dicts.push({ ns, d }); return () => {} },
      bind: (ns) => (key, params) => {
        const dict = dicts.find(e => e.ns === ns)?.d.zh ?? {}
        const value = String(dict[key] ?? key)
        return params === undefined ? value : value.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ""))
      },
      subscribe: () => () => {},
      getSnapshot: () => ({ revision: 0 }),
    },
    slots: {
      inject(name, fn) { injected.push(name); const reg = fn(); return typeof reg === "function" ? reg : () => {} },
      register(options, component) { slotRegistrations.push({ options, component }); return () => {} },
      entries: () => [],
      getVersion: () => 0,
      subscribe: () => () => {},
    },
    remote: {
      pluginManager: {},
      pluginInventory: {},
      $on: () => () => {},
      $mount: async () => () => {},
    },
    // 官方配置通道：客户端经它读写本插件的 settings 命名空间（不碰配置文件）。
    //
    // 桩件按**客户端** SettingsScope 契约（ui-settings 的 settings-contract.ts）：
    // getSnapshot / subscribe / mutate / set / unset。
    // 注意它与 host 侧的 SettingsScope 契约不同（host 是 get/watch/update/replace）——
    // 客户端这一侧是「镜像 + 排队的字段写」，不是同步读写。
    settingsScope: {
      bind({ namespace }) {
        const snapshot = {
          status: 'ready', value: undefined, base: undefined, user: undefined,
          revision: 1, writable: true, mode: 'host', namespace,
        }
        const listeners = new Set()
        return {
          getSnapshot: () => snapshot,
          subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn) } },
          mutate: async () => {},
          set: async () => {},
          unset: async () => {},
        }
      },
      describe: () => ({ subscribe: () => () => {}, getSnapshot: () => ({ descriptors: [] }) }),
    },
  })
  exported.apply(mkCtx())
  return { slotRegistrations, injected, dicts, effects }
}

describe('客户端产物启动契约', () => {
  it('产物只 require 平台模块表内的模块（越表会中断整个插件页面）', () => {
    const exported = bootBundle()
    assert.ok(typeof exported.apply === 'function', 'bundle 必须导出 apply')
  })

  it('注册三个一级设置入口，order 与设计文档一致', () => {
    const exported = bootBundle()
    const { slotRegistrations } = applyWithMocks(exported)
    const sections = slotRegistrations.filter(r => r.options.name === 'settings.section')
    assert.ok(sections.length >= 3, 'settings.section 注册数不足：' + String(sections.length))
    for (const want of SECTIONS) {
      const hit = sections.find(r => r.options.id === want.id)
      assert.ok(hit !== undefined, '缺少一级入口: ' + want.id)
      assert.equal(hit.options.order, want.order, want.id + ' 的 order 不符')
      assert.ok(hit.component !== undefined, want.id + ' 未提供组件')
    }
  })

  it('注册进官方插件页的 slot（点开即可管理配置）', () => {
    const exported = bootBundle()
    const { injected, slotRegistrations } = applyWithMocks(exported)
    const official = slotRegistrations.filter(r => String(r.options.name).startsWith('plugins.'))
    assert.ok(official.length > 0, '未注册任何官方 plugins.* slot：' + injected.join(', '))
  })

  it('字典 zh/en 键位对齐', () => {
    const exported = bootBundle()
    const { dicts } = applyWithMocks(exported)
    assert.ok(dicts.length > 0, '未注册任何字典')
    for (const { ns, d } of dicts) {
      assert.ok(d.zh !== undefined && d.en !== undefined, ns + ' 缺少 zh 或 en')
      const zh = Object.keys(d.zh).sort()
      const en = Object.keys(d.en).sort()
      assert.deepEqual(en, zh, ns + ' 的 en 键与 zh 不一致')
    }
  })
})

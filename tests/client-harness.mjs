/**
 * 客户端测试的共享桩件（node --test；四个客户端测试文件共用这一份）。
 *
 * 为什么要有这个模块：官方平台模块表的桩件原来在 client-boot / client-render / ui-copy /
 * console-page 四个文件里各写一份，产物每新增一个客户端 API（最近一次是 `defineStore`）
 * 就要同步改四处；漏一处的症状是 **31 例红，且报错是 "defineStore is not a function"**——
 * 指向产物而不是桩件，排查成本高。收敛成一份之后，"缺哪个导出"是单点问题。
 *
 * 两条纪律：
 *   1. **平台表要对官方表逐字对齐**（9 项含 ui-dockkit），越表 require 会让整个客户端启动中断，
 *      所以 `bootBundle` 启动后立刻断言表完整、且产物没有 require 表外的模块。
 *   2. **桩件缺导出要指名**：除 ui-primitives（组件工厂，任意名字都能渲染）外的每个表项都包一层
 *      Proxy，未知导出直接抛 "missed export <name> from <spec>"，而不是静默 undefined
 *      ——后者正是这次 31 例红的成因。
 *
 * 只搬不改语义：各文件原来自己那份桩件的可见行为在这里是**并集**（例如 primitives 桩既给
 * data-title/data-run-state，也把 title/command/output/状态文案渲染成文本），所以四个文件的
 * 既有断言一条都不用动。
 */
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
export const React = require_('react')
export const { renderToStaticMarkup } = require_('react-dom/server')

/** 官方平台种子表（deepseek-harness packages/client/web/src/platform.ts）。 */
export const PLATFORM = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/** 本包在模块表里的 id。 */
export const PACKAGE_ID = 'dsh-plugin-manager-companion'

/** 本插件在客户端 locale 注册表里的命名空间。 */
export const NS = 'plugin-manager-companion'

/**
 * primitives 桩：把 label/placeholder/title/text/value/command/output/状态文案与
 * collapsedContent、anchor、children 渲染成文本。
 *
 * 为什么保持"任意名字都能渲染"：primitives 是组件工厂，测试关心的是"注册方画了什么"，
 * 不是"官方导出清单是否完整"；所以它**不**参与下面的缺导出护栏。
 * @returns 模块替身。
 */
export function stubPrimitives() {
  const cache = new Map()
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === 'relativeTime') return () => ({ unit: 'now', n: 0 })
      if (typeof prop !== 'string') return undefined
      if (!cache.has(prop)) {
        const name = prop
        cache.set(name, function Stub(props) {
          const attrs = { 'data-stub': name }
          // data-title 单独暴露：只有挂在 title 上的文案等于"不悬停看不见"，
          // 断言要能把它与"真的画出来了"区分开（P2-b 的护栏依赖这一点）。
          if (typeof props?.title === 'string') attrs['data-title'] = props.title
          if (typeof props?.open === 'boolean') attrs['data-open'] = String(props.open)
          let stateText
          if (name === 'TerminalBlock') {
            // 官方 runState（ui-primitives/src/TerminalBlock.tsx:124-133）：只有
            // 「非运行中 + 无信号 + exitCode 为 0 或 undefined」才是 clean settle。
            const labels = props?.labels ?? {}
            const code = props?.exitCode
            const running = props?.running === true
            const failed = !running && ((code !== undefined && code !== null && code !== 0) || typeof props?.signal === 'string')
            attrs['data-run-state'] = running ? 'running' : failed ? 'failed' : 'done'
            stateText = running ? labels.running : failed ? labels.failed : labels.done
          }
          const text = value => (typeof value === 'string' || typeof value === 'number') ? String(value) : undefined
          // title 既挂 data-title（"只有悬停才看得见"的判据），也照渲染成文本
          // （有断言把 title 当"控件在不在"的标记，例如修复按钮的 title=fix.summary）。
          const parts = [props?.label, props?.title, props?.placeholder, props?.text, text(props?.value)]
            .filter(value => typeof value === 'string')
          const body = [parts.join(' | '), props?.command, props?.output, stateText]
            .filter(value => typeof value === 'string')
          return React.createElement('div', attrs, body.join('\n'),
            props?.collapsedContent ?? null, props?.anchor ?? null, props?.children ?? null)
        })
      }
      return cache.get(prop)
    },
  })
}

/**
 * 符合官方 SnapshotStore 契约的桩件。
 *
 * 为什么不用真件：@deepseek-ai/dsh-client-store 的运行时入口 import zustand，
 * 在 node 里直接 import 会失败。桩件按官方契约实现（getSnapshot / subscribe / update / set），
 * 足够让注册期与控制器代码运行。
 * @param init - 初始状态。
 * @returns 一个快照存储。
 */
export function makeSnapshotStore(init) {
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
 * 声明式 store（register 的 store 座位）的桩件：`defineStore(spec)` 的返回值。
 *
 * 实例语义与 makeSnapshotStore 同源：`create()` 出来的是"就地改草稿 + 通知"的引擎。
 * @param spec - 官方 store 定义（init + actions）。
 * @returns store 句柄。
 */
export function defineStoreStub(spec) {
  return {
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
  }
}

/** 打包器/互操作会探测的键：护栏必须放行，否则 Proxy 会误报缺导出。 */
const INTEROP_KEYS = new Set(['__esModule', 'default', 'then', 'prototype', 'constructor', 'toJSON', 'valueOf'])

/**
 * 给一个表项加"缺导出指名报错"的护栏。
 *
 * @param spec - 模块名（报错里点名用）。
 * @param value - 表项本体。
 * @returns 包了护栏的表项（函数/原始值原样返回）。
 */
function guardExports(spec, value) {
  if (typeof value !== 'object' || value === null) return value
  return new Proxy(value, {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop in target || INTEROP_KEYS.has(String(prop))) return target[prop]
      throw new Error('missed export ' + String(prop) + ' from ' + spec
        + '（平台表桩件缺这个导出；请到 tests/client-harness.mjs 的 platformTable 里补上）')
    },
  })
}

/**
 * 组出模拟模块表。
 * @param overrides - 覆盖某个表项（例如换掉 react，让首屏落在指定位置）。
 * @returns 模块表。
 */
export function platformTable(overrides = {}) {
  const table = {
    'react': React,
    'react/jsx-runtime': require_('react/jsx-runtime'),
    'react-dom': {}, 'react-dom/client': {},
    '@deepseek-ai/cordis': { Context: class {} },
    '@deepseek-ai/dsh-client-store': {
      createSnapshotStore: makeSnapshotStore,
      shallowEqual: (a, b) => a === b,
      defineStore: defineStoreStub,
      // 声明式 store（register 的 store 座位）：控制台把「当前子页」搬进了 store，
      // 缺这个导出的话产物 apply() 会抛 "defineStore is not a function"（指向产物、不指向桩件）。

    },
    '@deepseek-ai/dsh-client-ui-slots': {},
    '@deepseek-ai/dsh-client-ui-primitives': stubPrimitives(),
    '@deepseek-ai/dsh-client-ui-dockkit': {},
  }
  for (const [spec, value] of Object.entries(table)) {
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') continue
    table[spec] = guardExports(spec, value)
  }
  return { ...table, ...overrides }
}

/**
 * 以模拟模块表启动产物。
 *
 * @param overrides - 覆盖某个表项。
 * @returns bundle 的导出对象。
 */
export function bootBundle(overrides = {}) {
  assertArtifact()
  const table = platformTable(overrides)
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
        if (id !== PACKAGE_ID) throw new Error('bundle 必须以自身 id 注册，实到：' + String(id))
      },
    },
  }
  new Function(readFileSync('dist/client.js', 'utf8'))()
  if (missed.length > 0) throw new Error('bundle require 了平台模块表之外的模块: ' + missed.join(', '))
  if (exported === undefined) throw new Error('bundle 未通过 __ModuleLoader__.load 注册')
  const absent = PLATFORM.filter(s => !(s in table))
  if (absent.length > 0) throw new Error('桩表缺平台模块: ' + absent.join(', '))
  return exported
}

/** 产物存在性检查（缺了先 build）。 */
function assertArtifact() {
  if (!existsSync('dist/client.js')) throw new Error('dist/client.js 不存在：先跑 pnpm run build')
}

/**
 * 以 mock client ctx 调用 apply()，收集注册面与字典。
 *
 * @param exported - bundle 导出。
 * @param settings - settingsScope 桩的配置：命名空间值、状态、可写性。
 * @returns 注册面、字典、注入名、effect 与 settingsScope 快照。
 */
export function applyWithMocks(exported, settings = {}) {
  const slotRegistrations = []
  const injected = []
  const dicts = []
  const effects = []
  /**
   * 传给 apply 的 ctx 本体。
   *
   * 先建对象再调用 apply（而不是字面量直接当参数）：产物里出现了 `ctx.inject(...)` 的用法，
   * 而那个作用域桩件要把**同一份 ctx** 回调出去（服务可见性靠注入声明，真机同理）。
   */
  const scopeSnapshot = {
    status: settings.status ?? 'ready',
    value: settings.value,
    base: undefined,
    user: undefined,
    revision: 1,
    writable: settings.writable ?? true,
    mode: 'host',
    namespace: NS,
  }
  const ctx = {}
  ctx.effect = (fn) => { effects.push(fn); const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} }
  ctx.on = () => () => {}
  ctx.get = () => undefined
  ctx.logger = { info() {}, warn() {}, error() {} }
  ctx.locale = {
    register(ns, d) { dicts.push({ ns, d }); return () => {} },
    bind: (ns) => (key, params) => tFromDicts(dicts, ns, key, params, false),
    subscribe: () => () => {},
    getSnapshot: () => ({ revision: 0 }),
  }
  ctx.slots = {
    inject(name, fn) { injected.push(name); const reg = fn(); return typeof reg === 'function' ? reg : () => {} },
    register(options, component) { slotRegistrations.push({ options, component }); return () => {} },
    entries: () => [],
    getVersion: () => 0,
    subscribe: () => () => {},
  }
  ctx.remote = { pluginManager: {}, pluginInventory: {}, $on: () => () => {}, $mount: async () => () => {} }
  // 官方配置通道：客户端经它读写本插件的 settings 命名空间（不碰配置文件）。
  // 桩件按**客户端** SettingsScope 契约：getSnapshot / subscribe / mutate / set / unset。
  ctx.settingsScope = {
    bind() {
      const listeners = new Set()
      return {
        getSnapshot: () => scopeSnapshot,
        subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn) } },
        mutate: async () => {},
        set: async () => {},
        unset: async () => {},
      }
    },
    describe: () => ({ subscribe: () => () => {}, getSnapshot: () => ({ descriptors: [] }) }),
  }
  /**
   * `ctx.inject` 的作用域桩件（与真机同形：声明服务后回调拿到作用域内的 ctx）。
   *
   * 桩件里的服务一直在，所以直接回调——但**回调拿到的必须是同一份 ctx**，
   * 否则产物在作用域里读到的东西与根 ctx 不一致（真机上那正是服务可见性的机制）。
   */
  ctx.inject = (names, callback) => {
    const list = typeof names === 'string' ? [names] : [...names]
    injected.push('inject:' + list.join(','))
    callback(ctx)
    return () => {}
  }
  exported.apply(ctx)
  return { slotRegistrations, injected, dicts, effects, scopeSnapshot }
}

/** 从字典数组里取一条文案（strict 时缺键即抛）。 */
function tFromDicts(dicts, ns, key, params, strict) {
  const dict = dicts.find(entry => entry.ns === ns)?.d.zh ?? {}
  const value = dict[key]
  if (typeof value !== 'string') {
    if (strict) throw new Error('缺字典键：' + key)
    return key
  }
  return params === undefined ? value : value.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''))
}

/**
 * 本插件字典的 t 座位。
 * @param dicts - applyWithMocks 收集到的字典。
 * @param options - strict 为真时缺键抛错（默认缺键原样返回键名）。
 * @returns 翻译函数。
 */
export function makeT(dicts, options = {}) {
  return (key, params) => tFromDicts(dicts, NS, key, params, options.strict === true)
}

/** 最近一次 registration() 取到的注册项：propsFor 需要它来铺 store 座位（框架在运行时做这件事）。 */
let lastEntry

/**
 * 取一个注册项。
 * @param slotRegistrations - 注册面。
 * @param name - slot 名。
 * @param id - 可选的注册项 id。
 * @returns 注册项。
 */
export function registration(slotRegistrations, name, id) {
  const hit = slotRegistrations.find(entry =>
    entry.options.name === name && (id === undefined || entry.options.id === id))
  if (hit === undefined) throw new Error('未注册 slot: ' + name + (id === undefined ? '' : '/' + id))
  lastEntry = hit
  return hit
}

/**
 * 组装一个注册项的组件 props：hooks 隔间按框架规则合成 use<Name> 选择器，
 * 注册项声明了 store 时再铺 useStore/actions（官方语义：一 handle × 一 scope × 一实例）。
 *
 * @param face - 注册项 inject() 返回的注入面。
 * @param t - 字典座位。
 * @param extra - 额外的 owner props（如官方插件页的 view）。
 * @param entry - 注册项；省略时用最近一次 registration() 的结果。
 * @returns 可直接交给 React 的 props。
 */
export function propsFor(face, t, extra = {}, entry = lastEntry) {
  const { hooks, ...actions } = face
  const props = { t, ...actions, ...extra }
  for (const [name, source] of Object.entries(hooks)) {
    props['use' + name[0].toUpperCase() + name.slice(1)] = selector => selector(source.getSnapshot())
  }
  const handle = entry?.options?.store
  if (handle !== undefined) {
    const instance = handle.create()
    props.useStore = selector => selector(instance.getSnapshot())
    props.actions = instance.actions
  }
  return props
}

/** 把组件渲染成静态 HTML。 */
export function render(component, props) {
  return renderToStaticMarkup(React.createElement(component, props))
}

/**
 * 把组件渲染进错误边界。
 * @param component - 组件。
 * @param props - props。
 * @returns { html, error }：抛了就返回错误（断言"不该抛"用）。
 */
export function renderSafely(component, props) {
  try {
    return { html: render(component, props), error: undefined }
  } catch (error) {
    return { html: '', error }
  }
}

/**
 * 装一个 fetch 桩：按 op 名返回给定信封。
 *
 * 两种记录形状都保留（各自的既有断言不同，不动断言）：默认 `calls` 是 op 名字符串数组
 * （多数用例按顺序断言 op）；需要 `{ op, body }` 的用例传 `{ calls: 'entries' }`。
 *
 * @param handlers - op 名 → 响应函数（返回信封）。
 * @param options - `{ calls: 'ops' | 'entries' }`。
 * @returns `{ calls, restore }`。
 */
export function stubFetch(handlers, options = {}) {
  const asOps = options.calls !== 'entries'
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const op = String(url).split('/').pop()
    const body = init?.body === undefined ? undefined : JSON.parse(init.body)
    calls.push(asOps ? op : { op, body })
    const handler = handlers[op]
    if (handler === undefined) throw new Error('未预期的 op: ' + String(op))
    // handler 在 json() 里才被调用（与两个文件原来的桩件一致）：这决定了"响应落定"发生在
    // 哪一次 await，对 store 收敛时序敏感的用例会受影响，所以照搬原样而不是提前 await。
    return { status: 200, json: async () => handler(body, calls) }
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

/**
 * 等到条件成立（控制器动作是 fire-and-forget 的，只能用状态收敛做同步点）。
 * @param check - 返回真值即收敛。
 * @param what - 超时信息。
 * @returns check 的返回值。
 */
export async function until(check, what) {
  for (let i = 0; i < 200; i += 1) {
    const value = check()
    if (value !== undefined && value !== false) return value
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('等待超时：' + what)
}

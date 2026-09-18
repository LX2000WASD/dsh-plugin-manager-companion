/**
 * ConsolePage 环境子页的客户端契约（node --test，跑 dist/client.js + React SSR）。
 *
 * 归属：A 类·重写（本文件为新护栏；harness 手法与 tests/client-render.test.mjs 同源，
 *   但按 Lead 的分工独立成文件，避免与正在改那个文件的同学撞车）。
 * 官方复用：官方平台种子表的模拟模块表启动（与 client-boot.test.mjs 同一手法）。
 * 前提检查：模板名与层栈**必须**来自官方 PROFILE_TEMPLATES（经 host 的
 *   environmentTemplates op 投影）——前端抄一份名字表迟早漂移，漂移的后果实测过：
 *   留空的模板会建出一个没有 web 层、必然起不来的环境（task-16 的 F1）。
 *
 * 为什么有一部分是"源码级"断言：SSR 不跑 effect、也没有点击，新建对话框里的下拉
 * 选项只能靠真机截图（tools/e2e-visual.sh + CDP）验证；这里用源码级断言把
 * "模板字段是下拉、数据来自官方 op、没有人再拿自由文本 Input 承模板"钉住，
 * 交互真相由截图承担。运行前需要 dist/client.js 是新的（pnpm run build:client）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const React = require_('react')
const { renderToStaticMarkup } = require_('react-dom/server')

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
/** 本插件在客户端 locale 注册表里的命名空间。 */
const NS = 'plugin-manager-companion'
/** 控制台注册项的 id（settings.section 的 console 入口）。 */
const CONSOLE_ID = 'console'

/**
 * primitives 桩：把 label/title/placeholder/text/value/children 渲染成文本。
 *
 * `data-title` 单独暴露这件事很重要：只有挂在 title 上的文案等于"不悬停看不见"，
 * 测试要能把它与"真的画出来了"区分开（P2-b 的护栏依赖这一点）。
 * @returns 模块替身。
 */
function stubPrimitives() {
  const cache = new Map()
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === 'relativeTime') return () => ({ unit: 'now', n: 0 })
      if (typeof prop !== 'string') return undefined
      if (!cache.has(prop)) {
        const name = prop
        cache.set(name, function Stub(props) {
          const attrs = { 'data-stub': name }
          if (typeof props?.title === 'string') attrs['data-title'] = props.title
          if (typeof props?.open === 'boolean') attrs['data-open'] = String(props.open)
          if (name === 'TerminalBlock') {
            const code = props?.exitCode
            const failed = props?.running !== true && code !== undefined && code !== null && code !== 0
            attrs['data-run-state'] = failed ? 'failed' : 'done'
          }
          const text = value => typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
          const parts = [props?.label, props?.placeholder, props?.text, text(props?.value)]
            .filter(value => typeof value === 'string')
          const body = [parts.join(' | '), props?.command, props?.output].filter(value => typeof value === 'string')
          // `anchor` 必须照渲染：Menu/HoverCard 的可见内容就在锚点上，桩件吞掉它会让
          // 「下拉有没有渲染出来」这类断言变成假绿。
          return React.createElement('div', attrs, body.join('\n'),
            props?.collapsedContent ?? null, props?.anchor ?? null, props?.children ?? null)
        })
      }
      return cache.get(prop)
    },
  })
}

/** 符合官方 SnapshotStore 契约的桩件。 */
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
 * React 替身：把 ConsolePage 的首屏子页与新建对话框摆到指定位置。
 *
 * 为什么需要：控制台只有一个注册项，SSR 首屏落在「体检」，环境页与对话框在无 DOM 的
 * 测试里根本渲染不到。两处补丁都只改**初始值**：第一个无初值 useState 是 activeId，
 * 初值为 `{ kind: 'none' }` 的是对话框状态。钩子顺序一变，这里就渲染不到目标，
 * 断言会直接失败而不是静默通过。
 *
 * @param options - 首屏子页 id 与是否把新建对话框摆成打开。
 * @returns { react, reset }：塞进模块表的 react 替身 + 每次渲染前的复位函数。
 */
function shimReact({ tabId = 'health', openDialog = false } = {}) {
  let noArgCalls = 0
  return {
    react: {
      ...React,
      useState(initial) {
        if (arguments.length === 0 || initial === undefined) {
          noArgCalls += 1
          return React.useState(noArgCalls === 1 ? tabId : undefined)
        }
        if (openDialog && typeof initial === 'object' && initial !== null && initial.kind === 'none') {
          return React.useState({ kind: 'create' })
        }
        return React.useState(initial)
      },
    },
    reset: () => { noArgCalls = 0 },
  }
}

/** 以模拟模块表启动产物，返回注册项与假 ctx。 */
function boot(options = {}) {
  assert.ok(existsSync('dist/client.js'), 'dist/client.js 不存在：先跑 pnpm run build:client')
  const registrations = []
  const dicts = new Map()
  const table = {
    'react': options.react ?? React,
    'react/jsx-runtime': require_('react/jsx-runtime'),
    'react-dom': {}, 'react-dom/client': {},
    '@deepseek-ai/cordis': { Context: class {} },
    '@deepseek-ai/dsh-client-store': { createSnapshotStore: makeSnapshotStore, shallowEqual: (a, b) => a === b },
    '@deepseek-ai/dsh-client-ui-slots': {},
    '@deepseek-ai/dsh-client-ui-primitives': stubPrimitives(),
    '@deepseek-ai/dsh-client-ui-dockkit': {},
  }
  let exported
  globalThis.window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        exported = factory((spec) => {
          if (!(spec in table)) throw new Error('missed the module table: ' + spec)
          return table[spec]
        })
        assert.equal(id, PACKAGE_ID, 'bundle 必须以自身 id 注册')
      },
    },
  }
  new Function(readFileSync('dist/client.js', 'utf8'))()

  const noop = () => () => {}
  exported.apply({
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    on: noop,
    get() { return undefined },
    logger: { info() {}, warn() {}, error() {} },
    locale: {
      register(ns, d) { dicts.set(ns, d); return () => {} },
      bind: ns => (key, params) => {
        const value = dicts.get(ns)?.zh?.[key]
        if (typeof value !== 'string') throw new Error('缺字典键：' + key)
        return Object.entries(params ?? {}).reduce((text, [k, v]) => text.split('{' + k + '}').join(String(v)), value)
      },
      subscribe: () => () => {},
      getSnapshot: () => ({ revision: 0 }),
    },
    slots: {
      inject: (name, fn) => { const reg = fn(); return typeof reg === 'function' ? reg : () => {} },
      register(options_, component) { registrations.push({ options: options_, component }); return () => {} },
      entries: () => [], getVersion: () => 0, subscribe: () => () => {},
    },
    remote: { pluginManager: {}, pluginInventory: {}, $on: () => () => {}, $mount: async () => () => {} },
    settingsScope: {
      bind() {
        return {
          getSnapshot: () => ({ status: 'ready', value: undefined, base: undefined, user: undefined, revision: 1, writable: true, mode: 'host' }),
          subscribe: () => () => {}, mutate: async () => {}, set: async () => {}, unset: async () => {},
        }
      },
      describe: () => ({ subscribe: () => () => {}, getSnapshot: () => ({ descriptors: [] }) }),
    },
  })
  const entry = registrations.find(item => item.options.id === CONSOLE_ID)
  assert.ok(entry !== undefined, '控制台注册项不存在：' + registrations.map(r => String(r.options.id)).join(','))
  const face = entry.options.inject()
  const t = exported.apply === undefined ? undefined : (() => {
    // t 走同一份注册字典（缺键即抛，等于"零缺键文案"）。
    const dict = dicts.get(NS)
    return (key, params) => {
      const value = dict.zh[key]
      if (typeof value !== 'string') throw new Error('缺字典键：' + key)
      return Object.entries(params ?? {}).reduce((text, [k, v]) => text.split('{' + k + '}').join(String(v)), value)
    }
  })()
  return { entry, face, t, dicts }
}

/** 把注入面铺成组件 props。 */
function propsFor(face, t, extra = {}) {
  const { hooks, ...actions } = face
  const props = { t, ...actions, close: () => {}, ...extra }
  for (const [name, source] of Object.entries(hooks)) {
    props['use' + name[0].toUpperCase() + name.slice(1)] = selector => selector(source.getSnapshot())
  }
  return props
}

/** 装一个 fetch 桩：记录每次调用的 op 与请求体。 */
function stubFetch(handlers) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const op = String(url).split('/').pop()
    const body = init?.body === undefined ? undefined : JSON.parse(init.body)
    calls.push({ op, body })
    const handler = handlers[op]
    if (handler === undefined) throw new Error('未预期的 op: ' + String(op))
    return { status: 200, json: async () => handler(body, calls) }
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

/** 等状态收敛（控制器动作是 fire-and-forget 的）。 */
async function until(check, what) {
  for (let index = 0; index < 200; index += 1) {
    const value = check()
    if (value !== undefined && value !== false) return value
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('等待超时：' + what)
}

describe('环境子页：模板来自官方、启动结果如实', () => {
  it('模板清单走官方 op，模板字段是下拉（不再用自由文本承模板名）', () => {
    const source = readFileSync('src/client/ConsolePage.tsx', 'utf8')
    assert.match(source, /callOp<EnvironmentTemplateList>\('environmentTemplates', \{\}\)/,
      '新建对话框必须从 environmentTemplates op 取模板清单，不能在前端维护模板表')
    assert.match(source, /<PmSelect[\s\S]{0,600}?t\('env\.template'\)/,
      '模板字段必须是下拉（PmSelect）')
    assert.doesNotMatch(source, /<Input[^>]*draftTemplate/,
      '模板字段不得再回退成自由文本 Input：留空会建出必然起不来的环境（task-16 F1）')
    assert.match(source, /value=\{draftTemplate\}/,
      '下拉必须由 draftTemplate 驱动（否则选不中模板）')
  })

  it('渲染出的新建对话框带模板下拉（清单未读到时给占位文案，不猜模板名）', () => {
    const shim = shimReact({ tabId: 'env', openDialog: true })
    const { entry, face, t } = boot({ react: shim.react })
    shim.reset()
    const html = renderToStaticMarkup(React.createElement(entry.component, propsFor(face, t)))
    assert.ok(html.includes('新建环境'), '对话框没渲染出来：' + html.slice(0, 200))
    assert.ok(html.includes('模板'), '对话框里没有模板字段')
    // 下拉在清单还没读到时显示占位文案（清单是一次只读，SSR 不跑 effect）。
    assert.ok(html.includes('自动选择'), '模板下拉没有占位文案：' + html.slice(0, 300))
  })

  it('创建请求带上选中的模板；没有模板时省掉该字段（由后端落到官方默认模板）', async () => {
    const shim = shimReact({ tabId: 'env' })
    const { face } = boot({ react: shim.react })
    const stub = stubFetch({
      createEnvironment: () => ({ ok: true, value: { ok: true, output: '已创建' } }),
      listEnvironments: () => ({ ok: true, value: [] }),
    })
    try {
      face.createEnvironment('pm-web', 'web')
      await until(() => stub.calls.some(call => call.op === 'createEnvironment' && call.body.template === 'web'),
        'createEnvironment 带上 template')
      face.createEnvironment('pm-default')
      const omitted = await until(() => stub.calls.find(call => call.op === 'createEnvironment' && call.body.name === 'pm-default'),
        'createEnvironment 不带 template')
      assert.ok(!('template' in omitted.body), '没有选中模板时必须省掉字段，交给后端默认：' + JSON.stringify(omitted.body))
    } finally {
      stub.restore()
    }
  })

  it('启动请求把「终端 / 后台」两种模式都如实送到后端', async () => {
    const shim = shimReact({ tabId: 'env' })
    const { face } = boot({ react: shim.react })
    const stub = stubFetch({
      startEnvironment: () => ({ ok: true, value: { ok: true, output: '启动方式：后台' } }),
      listEnvironments: () => ({ ok: true, value: [] }),
    })
    try {
      face.startEnvironment('pm-web', true)
      await until(() => stub.calls.some(call => call.op === 'startEnvironment' && call.body.background === true),
        '后台启动带上 background=true')
      face.startEnvironment('pm-web', false)
      await until(() => stub.calls.some(call => call.op === 'startEnvironment' && call.body.background === false),
        '终端启动带上 background=false')
    } finally {
      stub.restore()
    }
  })

  it('启动结果按后端原文呈现：模式说明与失败态都不被改写', async () => {
    const shim = shimReact({ tabId: 'env' })
    const { entry, face, t } = boot({ react: shim.react })
    const stub = stubFetch({
      startEnvironment: () => ({ ok: true, value: { ok: true, output: '启动方式：终端窗口 konsole' } }),
      listEnvironments: () => ({ ok: true, value: [] }),
    })
    try {
      face.startEnvironment('pm-web', false)
      await until(() => face.hooks.environments.getSnapshot().notice === '启动方式：终端窗口 konsole', '结果落进 store')
      shim.reset()
      const html = renderToStaticMarkup(React.createElement(entry.component, propsFor(face, t)))
      assert.ok(html.includes('启动方式：终端窗口 konsole'), '结果块必须原样呈现后端给的启动方式')
      assert.ok(html.includes('data-run-state="done"'), '成功结果必须是成功态')
    } finally {
      stub.restore()
    }
  })

  it('启动失败不回退成成功态（task-14 的护栏）', async () => {
    const shim = shimReact({ tabId: 'env' })
    const { entry, face, t } = boot({ react: shim.react })
    const stub = stubFetch({
      startEnvironment: () => ({ ok: true, value: { ok: false, code: 'timeout', output: 'pm-web 已启动，但 30000ms 内端口未就绪' } }),
      listEnvironments: () => ({ ok: true, value: [] }),
    })
    try {
      face.startEnvironment('pm-web', false)
      await until(() => face.hooks.environments.getSnapshot().notice !== undefined, '结果落进 store')
      shim.reset()
      const html = renderToStaticMarkup(React.createElement(entry.component, propsFor(face, t)))
      assert.ok(html.includes('data-run-state="failed"'), '失败结果必须是失败态：' + html.slice(0, 300))
    } finally {
      stub.restore()
    }
  })

  it('主按钮把启动模式写明白，不再是含糊的一句「启动」', () => {
    const shim = shimReact({ tabId: 'env' })
    const { entry, face, t } = boot({ react: shim.react })
    face.hooks.environments.update((draft) => {
      draft.environments = [{
        name: 'pm-web', dir: '/tmp/pm-web', current: false, builtin: false,
        bundles: ['@deepseek-ai/dsh-base'], dependencies: [], runs: [],
      }]
    })
    shim.reset()
    const html = renderToStaticMarkup(React.createElement(entry.component, propsFor(face, t)))
    assert.ok(html.includes('终端启动'), '没运行的实例上必须写清是终端启动：' + html.slice(0, 300))
    assert.ok(!html.includes('>启动<'), '不该再出现含糊的「启动」')
  })
})

describe('环境子页与设置子页：控件唯一、归因准确、作用域如实（task-24）', () => {
  const ENV = {
    name: 'pm-web', dir: '/tmp/pm-web', current: true, builtin: false,
    bundles: ['@deepseek-ai/dsh-base'], dependencies: [], runs: [],
  }
  const REPORT_WITH_FIX = {
    environment: 'pm-web',
    generatedAt: '2026-09-19T03:00:00.000Z',
    counts: { dependency: 1, composition: 0, runtime: 0, consistency: 0, ecosystem: 0 },
    issues: [{
      id: 'i1', layer: 'dependency', severity: 'confirm-fix', code: 'undeclared-dependency',
      title: '声明了但没装：pkg', detail: 'detail', subjects: ['pkg'],
      evidence: [{ kind: 'file', at: 'package.json:12', note: '声明位置' }],
      fix: { action: 'install-dependency', target: 'pkg', summary: '重新安装 pkg，或删掉这条声明' },
    }],
    skipped: [],
  }

  it('备份区只有一个「导出备份」选择器（重复控件已删）', () => {
    const shim = shimReact({ tabId: 'env' })
    const { entry, face, t } = boot({ react: shim.react })
    face.hooks.environments.update((draft) => { draft.environments = [ENV] })
    shim.reset()
    const html = renderToStaticMarkup(React.createElement(entry.component, propsFor(face, t)))
    // 一次是工具栏按钮的文字，一次是那个选择器的可见标签；再出现第三次就是重复控件回来了。
    const occurrences = html.split('导出备份').length - 1
    assert.equal(occurrences, 2, '「导出备份」应恰好出现两次（按钮 + 一个选择器标签），实际 ' + String(occurrences))
    // 选择器本体是 PmSelect（Menu + Button 组合），备份区里只能有一个。
    // 切到第一个 Modal 之前：模态框里另有自己的选择器（新建模板、复制目标），不属于备份区。
    const cardStart = html.indexOf('backupCard')
    const cardEnd = html.indexOf('data-stub="Modal"', cardStart)
    const backupCard = html.slice(cardStart, cardEnd === -1 ? undefined : cardEnd)
    const selects = backupCard.split('data-stub="Menu"').length - 1
    assert.equal(selects, 1, '备份区只能有一个选择器（导出目标），实际 ' + String(selects))
    assert.ok(backupCard.includes('导出备份'), '备份区要有导出目标的可见标签')
  })

  it('修复失败说「修复失败」，不把归因写成「体检失败」', async () => {
    const shim = shimReact({ tabId: 'health' })
    const { entry, face, t } = boot({ react: shim.react })
    const stub = stubFetch({
      diagnose: () => ({ ok: true, value: { jobId: 'job-1' } }),
      job: () => ({ ok: true, value: { done: true, result: REPORT_WITH_FIX } }),
      fix: () => ({ ok: true, value: { ok: false, code: 'operation-failed', output: '装不上：pkg' } }),
      listEnvironments: () => ({ ok: true, value: [] }),
    })
    try {
      face.diagnose()
      await until(() => face.hooks.health.getSnapshot().report !== undefined, '报告落地')
      face.fix(face.hooks.health.getSnapshot().report.issues[0])
      await until(() => face.hooks.health.getSnapshot().error !== undefined, '修复失败落进 store')
      shim.reset()
      const html = renderToStaticMarkup(React.createElement(entry.component, propsFor(face, t)))
      assert.ok(html.includes('修复失败'), '修复失败要如实说成修复失败：' + html.slice(0, 300))
      assert.ok(!html.includes('体检失败'), '修复失败不得被写成体检失败（归因错位）')
    } finally {
      stub.restore()
    }
  })

  it('体检失败仍然说「体检失败」（归因没被改坏）', async () => {
    const shim = shimReact({ tabId: 'health' })
    const { entry, face, t } = boot({ react: shim.react })
    const stub = stubFetch({
      diagnose: () => ({ ok: true, value: { jobId: 'job-1' } }),
      job: () => ({ ok: true, value: { done: true, error: '引擎挂了' } }),
      listEnvironments: () => ({ ok: true, value: [] }),
    })
    try {
      face.diagnose()
      await until(() => face.hooks.health.getSnapshot().error !== undefined, '体检失败落进 store')
      shim.reset()
      const html = renderToStaticMarkup(React.createElement(entry.component, propsFor(face, t)))
      assert.ok(html.includes('体检失败'), '体检失败要照旧说体检失败：' + html.slice(0, 300))
      assert.ok(!html.includes('修复失败'), '没点过修复就不该出现修复失败')
    } finally {
      stub.restore()
    }
  })

  it('设置子页如实点明作用域（配置对所有环境生效）', () => {
    const shim = shimReact({ tabId: 'settings' })
    const { entry, face, t } = boot({ react: shim.react })
    face.hooks.config.update((draft) => {
      draft.status = 'ready'
      draft.value = {
        diagnostics: { dependency: true, composition: true, runtime: true, consistency: true, ecosystem: false },
        qualityGate: { enabled: true, mode: 'block', allowlist: [] },
        marketplace: { enabled: true, cacheTtlMinutes: 1440, timeoutMs: 15000, indexUrl: '' },
      }
      draft.draft = draft.value
    })
    shim.reset()
    const html = renderToStaticMarkup(React.createElement(entry.component, propsFor(face, t)))
    assert.ok(html.includes('配置对所有环境生效。'), '设置子页要有一句作用域事实：' + html.slice(0, 300))
  })

  it('回滚文案是中性的，不替后端复述结论', () => {
    const { dicts } = boot()
    const zh = dicts.get(NS).zh['market.rolledBack']
    const en = dicts.get(NS).en['market.rolledBack']
    assert.equal(zh, '已回滚')
    assert.equal(en, 'Rolled back')
    assert.ok(!/未被改动|unchanged/.test(zh + en), '客户端不该复述"环境未被改动"这类结论（事实归 host 的 output）')
  })
})

describe('体检页：跳过层如实标注、修复说明行内可见（task-27）', () => {
  /** 一份各层计数为 0 的报告；跳过信息按用例给。 */
  const reportWith = (skipped, counts = {}) => ({
    environment: 'pm-web',
    generatedAt: '2026-09-19T03:00:00.000Z',
    counts: { dependency: 0, composition: 0, runtime: 0, consistency: 0, ecosystem: 0, ...counts },
    issues: [],
    skipped,
  })
  /** 渲染「体检」子页（默认子页就是它）。 */
  const renderHealth = (report) => {
    const shim = shimReact({ tabId: 'health' })
    const { entry, face, t } = boot({ react: shim.react })
    face.hooks.health.update((draft) => { draft.report = report })
    shim.reset()
    const html = renderToStaticMarkup(React.createElement(entry.component, propsFor(face, t)))
    // 层计数格那一段：从 grid 起截一段窗口，足够覆盖五格。
    const start = html.indexOf('layerGrid')
    assert.ok(start >= 0, '没找到层计数格：' + html.slice(0, 200))
    return { html, grid: html.slice(start, start + 2500) }
  }

  it('跳过的层显示「未查」而不是 0（生态层被配置关掉时）', () => {
    const { grid } = renderHealth(reportWith([{ check: 'ecosystem-layer', reason: '配置里关闭了该层', layers: ['ecosystem'] }]))
    assert.ok(grid.includes('未查'), '跳过的层必须显示「未查」：' + grid.slice(0, 400))
    assert.ok(grid.includes('配置里关闭了该层'), '跳过原因要能读到（挂在提示里）')
  })

  it('没被跳过的层不显示「未查」（不能把"查过且没问题"一起标脏）', () => {
    const { grid } = renderHealth(reportWith([]))
    assert.ok(!grid.includes('未查'), '没有跳过就不该出现未查')
  })

  it('一次跳过废掉多层时，多层一起标未查（runtime + consistency）', () => {
    const { grid } = renderHealth(reportWith([{ check: 'runtime-inventory', reason: 'Loader 不可用', layers: ['runtime', 'consistency'] }]))
    assert.equal(grid.split('未查').length - 1, 2, '两层都要标未查：' + grid.slice(0, 400))
  })

  it('非层级跳过（没有 layers）不标任何层', () => {
    const { grid } = renderHealth(reportWith([{ check: 'install-anchor', reason: '取不到安装锚点' }]))
    assert.ok(!grid.includes('未查'), '非层级跳过不代表整层没查：' + grid.slice(0, 400))
  })

  it('既有计数又有跳过时，数字与「未查」同时呈现（数字不能被读成"查完了"）', () => {
    const { grid } = renderHealth(reportWith(
      [{ check: 'composition-layer', reason: '该层执行失败：boom', layers: ['composition'] }],
      { composition: 3 },
    ))
    const cell = grid.slice(Math.max(0, grid.indexOf('未查') - 400), grid.indexOf('未查') + 40)
    assert.ok(cell.includes('3'), '有计数就必须给数字：' + cell.slice(0, 400))
    assert.ok(cell.includes('未查'), '同时要标明这一层没查完')
  })

  it('修复动作的说明行内可见（不再只挂在悬停 title 上）', () => {
    const summary = '重新安装 pkg，或删掉这条声明'
    const shim = shimReact({ tabId: 'health' })
    const { entry, face, t } = boot({ react: shim.react })
    face.hooks.health.update((draft) => {
      draft.report = {
        environment: 'pm-web', generatedAt: '2026-09-19T03:00:00.000Z',
        counts: { dependency: 1, composition: 0, runtime: 0, consistency: 0, ecosystem: 0 },
        issues: [{
          id: 'i1', layer: 'dependency', severity: 'confirm-fix', code: 'undeclared-dependency',
          title: '声明了但没装：pkg', detail: 'detail', subjects: ['pkg'],
          evidence: [{ kind: 'file', at: 'package.json:12', note: '声明位置' }],
          fix: { action: 'install-dependency', target: 'pkg', summary },
        }],
        skipped: [],
      }
    })
    shim.reset()
    const html = renderToStaticMarkup(React.createElement(entry.component, propsFor(face, t)))
    assert.ok(html.includes(summary), '说明必须是可见文本：' + html.slice(0, 300))
    assert.ok(!html.includes('data-title="' + summary + '"'), '说明不得只挂在 title 上（不悬停也要看得到）')
  })

  it('组头/条目的 code 标签整体不折行（CSS 层护栏）', () => {
    const css = readFileSync('src/client/ConsolePage.module.css', 'utf8')
    const rule = /\.issueCode\s*\{([^}]*)\}/.exec(css)
    assert.ok(rule !== null, '.issueCode 必须有独立规则（否则会跟着 .evidenceAt 一起可断行）')
    assert.ok(/white-space:\s*nowrap/.test(rule[1]), '.issueCode 必须是 nowrap：' + String(rule[1]))
  })
})

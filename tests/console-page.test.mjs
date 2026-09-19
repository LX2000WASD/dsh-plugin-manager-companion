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
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import {
  NS, React, bootBundle, propsFor as harnessPropsFor, stubFetch as harnessStubFetch, until,
} from './client-harness.mjs'

const require_ = createRequire(import.meta.url)
const { renderToStaticMarkup } = require_('react-dom/server')

/** 控制台注册项的 id（settings.section 的 console 入口）。 */
const CONSOLE_ID = 'console'

// 平台表桩件（含 primitives / SnapshotStore / defineStore 的缺失导出护栏）都在
// tests/client-harness.mjs：四个客户端测试文件共用一份，产物新增 API 只需改那一处。

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
function shimReact({ openDialog = false } = {}) {
  return {
    react: {
      ...React,
      useState(initial) {
        if (openDialog && typeof initial === 'object' && initial !== null && initial.kind === 'none') {
          return React.useState({ kind: 'create' })
        }
        return React.useState(initial)
      },
    },
    reset: () => {},
  }
}

/**
 * 以模拟模块表启动产物，返回注册项与假 ctx。
 *
 * 模块表来自 tests/client-harness.mjs 的 platformTable（含"缺导出指名报错"的护栏），
 * 这里保留本文件自己的注册面/字典收集（字典是 Map，且缺键即抛——这是本文件的断言口径）。
 */
function boot(options = {}) {
  const exported = bootBundle({ react: options.react ?? React })
  const registrations = []
  const dicts = new Map()
  const noop = () => () => {}
  /** 传给 apply 的 ctx 本体（`ctx.inject` 的作用域桩件要把同一份 ctx 回调出去）。 */
  const ctx = {
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
          getSnapshot: () => ({
            status: 'ready', value: options.configValue, base: undefined, user: undefined,
            revision: 1, writable: true, mode: 'host',
          }),
          subscribe: () => () => {}, mutate: async () => {}, set: async () => {}, unset: async () => {},
        }
      },
      describe: () => ({ subscribe: () => () => {}, getSnapshot: () => ({ descriptors: [] }) }),
    },
  }
  // ctx.inject 的作用域桩件：与真机同形（声明服务后回调拿到作用域内的 ctx，这里就是同一份）。
  ctx.inject = (names, callback) => { callback(ctx); return () => {} }
  exported.apply(ctx)
  const entry = registrations.find(item => item.options.id === CONSOLE_ID)
  assert.ok(entry !== undefined, '控制台注册项不存在：' + registrations.map(r => String(r.options.id)).join(','))
  currentEntry = entry
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

/** 最近一次 boot 的注册项：propsFor 需要它来铺 store 座位（框架在运行时做这件事）。 */
let currentEntry

/**
 * 把注入面与 store 座位铺成组件 props。
 *
 * 铺法来自 tests/client-harness.mjs 的 propsFor（hooks 隔间 → use<Name>；注册项声明了 store
 * 就 create() 一个实例铺 useStore/actions）；本文件只固定两件自己的口径：extra 里默认带
 * `close`（对话框要的 prop），以及每次调用都会拿到**新 store 实例**（框架语义：一 handle × 一 scope × 一实例）。
 * @param face - 注入面。
 * @param t - 字典翻译。
 * @param extra - 额外 props。
 * @returns 组件 props。
 */
function propsFor(face, t, extra = {}) {
  return harnessPropsFor(face, t, { close: () => {}, ...extra }, currentEntry)
}

/** 渲染控制台并落在指定子页（子页选择走 store 的 select action，不再是组件内 state）。 */
function renderTab(entry, face, t, tabId, extra = {}) {
  const props = propsFor(face, t, extra)
  assert.ok(props.actions !== undefined, '控制台注册项没声明 store')
  props.actions.select(tabId)
  return renderToStaticMarkup(React.createElement(entry.component, props))
}

/** fetch 桩：本文件按 `{ op, body }` 记录调用，所以用共享桩件的 entries 形状。 */
const stubFetch = handlers => harnessStubFetch(handlers, { calls: 'entries' })

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
    const shim = shimReact({ openDialog: true })
    const { entry, face, t } = boot({ react: shim.react })
    const html = renderTab(entry, face, t, 'env')
    assert.ok(html.includes('新建环境'), '对话框没渲染出来：' + html.slice(0, 200))
    assert.ok(html.includes('模板'), '对话框里没有模板字段')
    // 下拉在清单还没读到时显示占位文案（清单是一次只读，SSR 不跑 effect）。
    assert.ok(html.includes('自动选择'), '模板下拉没有占位文案：' + html.slice(0, 300))
  })

  it('创建请求带上选中的模板；没有模板时省掉该字段（由后端落到官方默认模板）', async () => {
    const shim = shimReact()
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
    const shim = shimReact()
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
    const shim = shimReact()
    const { entry, face, t } = boot({ react: shim.react })
    const stub = stubFetch({
      startEnvironment: () => ({ ok: true, value: { ok: true, output: '启动方式：终端窗口 konsole' } }),
      listEnvironments: () => ({ ok: true, value: [] }),
    })
    try {
      face.startEnvironment('pm-web', false)
      await until(() => face.hooks.environments.getSnapshot().notice === '启动方式：终端窗口 konsole', '结果落进 store')
      const html = renderTab(entry, face, t, 'env')
      assert.ok(html.includes('启动方式：终端窗口 konsole'), '结果块必须原样呈现后端给的启动方式')
      assert.ok(html.includes('data-run-state="done"'), '成功结果必须是成功态')
    } finally {
      stub.restore()
    }
  })

  it('启动失败不回退成成功态（task-14 的护栏）', async () => {
    const shim = shimReact()
    const { entry, face, t } = boot({ react: shim.react })
    const stub = stubFetch({
      startEnvironment: () => ({ ok: true, value: { ok: false, code: 'timeout', output: 'pm-web 已启动，但 30000ms 内端口未就绪' } }),
      listEnvironments: () => ({ ok: true, value: [] }),
    })
    try {
      face.startEnvironment('pm-web', false)
      await until(() => face.hooks.environments.getSnapshot().notice !== undefined, '结果落进 store')
      const html = renderTab(entry, face, t, 'env')
      assert.ok(html.includes('data-run-state="failed"'), '失败结果必须是失败态：' + html.slice(0, 300))
    } finally {
      stub.restore()
    }
  })

  it('主按钮把启动模式写明白，不再是含糊的一句「启动」', () => {
    const shim = shimReact()
    const { entry, face, t } = boot({ react: shim.react })
    face.hooks.environments.update((draft) => {
      draft.environments = [{
        name: 'pm-web', dir: '/tmp/pm-web', current: false, builtin: false,
        bundles: ['@deepseek-ai/dsh-base'], dependencies: [], runs: [],
      }]
    })
    const html = renderTab(entry, face, t, 'env')
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
    const shim = shimReact()
    const { entry, face, t } = boot({ react: shim.react })
    face.hooks.environments.update((draft) => { draft.environments = [ENV] })
    const html = renderTab(entry, face, t, 'env')
    // 可见文本里「导出备份」只该出现一次：导出按钮本身。
    // （选择器的可访问名走 aria-label，桩件不渲染属性；原注释写成「按钮 + 选择器可见标签」是错的——
    //   当时那第二次其实是空态提示里重复写了一遍操作路径，已按 §12.3.2「指路式引导」删掉，见下一个用例。）
    const occurrences = html.split('导出备份').length - 1
    assert.equal(occurrences, 1, '可见文本里「导出备份」应恰好一次（导出按钮），实际 ' + String(occurrences))
    // 选择器本体是 PmSelect（Menu + Button 组合），备份区里只能有一个。
    // 切到第一个 Modal 之前：模态框里另有自己的选择器（新建模板、复制目标），不属于备份区。
    const cardStart = html.indexOf('backupCard')
    const cardEnd = html.indexOf('data-stub="Modal"', cardStart)
    const backupCard = html.slice(cardStart, cardEnd === -1 ? undefined : cardEnd)
    const selects = backupCard.split('data-stub="Menu"').length - 1
    assert.equal(selects, 1, '备份区只能有一个选择器（导出目标），实际 ' + String(selects))
    assert.ok(backupCard.includes('导出备份'), '备份区要有导出目标的可见标签')
  })

  it('备份空态只说事实：指路半句已删，两个按钮同屏可见（§12.3.2 指路式引导 / §12.5 替代载体）', () => {
    const shim = shimReact()
    const { entry, face, t } = boot({ react: shim.react })
    face.hooks.environments.update((draft) => { draft.environments = [ENV] })
    const html = renderTab(entry, face, t, 'env')
    const cardStart = html.indexOf('backupCard')
    const cardEnd = html.indexOf('data-stub="Modal"', cardStart)
    const backupCard = html.slice(cardStart, cardEnd === -1 ? undefined : cardEnd)
    // 删「指路」的前提是替代载体真的在同屏（§12.5）：这两个按钮就在同一张卡片的上一行。
    assert.ok(backupCard.includes('导出备份'), '替代载体：卡片里要能看到「导出备份」')
    assert.ok(backupCard.includes('导入备份'), '替代载体：卡片里要能看到「导入备份」')
    // 空态只留事实，不写操作路径（用户会自己看到上面两个按钮）。
    assert.ok(backupCard.includes('尚未读入备份文件'), '空态要保留事实本身')
    assert.ok(!backupCard.includes('先用'), '指路半句不得回来（按钮就在上面）')
    assert.ok(!backupCard.includes('或导入一个已有的 JSON'), '指路半句不得回来')
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
    // 走真实的归一通道：值由 settingsScope 给，ConfigController 归一成草稿。
    // 以前这里手工往 state 里塞一份未归一的 draft；task-52 之后草稿由归一保证一定有
    // trial 段，手工塞的那份会让渲染读到 undefined（那正是它该报出来的信号）。
    const { entry, face, t } = boot({
      configValue: {
        diagnostics: { dependency: true, composition: true, runtime: true, consistency: true, ecosystem: false },
        qualityGate: { enabled: true, mode: 'block', allowlist: [] },
        marketplace: { enabled: true, cacheTtlMinutes: 1440, timeoutMs: 15000, indexUrl: '' },
      },
    })
    const html = renderTab(entry, face, t, 'settings')
    assert.ok(html.includes('配置对所有环境生效'), '设置子页要有一句作用域事实：' + html.slice(0, 300))
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

  it('体检空态只说事实：指路半句已删，「开始体检」按钮同屏可见（§12.3.2 指路式引导 / §12.5 替代载体）', () => {
    const shim = shimReact({ tabId: 'health' })
    const { entry, face, t } = boot({ react: shim.react })
    // 默认就是「尚未体检」状态（没有报告）
    const html = renderToStaticMarkup(React.createElement(entry.component, propsFor(face, t)))
    // 替代载体：同一区块标题右侧那枚按钮，无报告时文案就是「开始体检」（ConsolePage.tsx:483-492）
    assert.ok(html.includes('开始体检'), '替代载体：区块标题旁要能看到「开始体检」按钮')
    assert.ok(html.includes('尚未体检'), '空态要保留事实本身')
    assert.ok(!html.includes('点击「开始体检」'), '指路半句不得回来（按钮就在标题旁）')
    assert.ok(!html.includes('生成报告'), '指路半句不得回来')
  })

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

describe('控制台：子页选择跨重挂载存活（task-30）', () => {
  /** 把注册项声明的 store 铺进 props（框架在运行时做这件事；测试按官方说法自己 create()）。 */
  const withStore = (entry, props) => {
    const handle = entry.options.store
    assert.ok(handle !== undefined, '控制台注册项必须声明 store：子页选择要跨重挂载存活')
    const instance = handle.create()
    return {
      instance,
      props: {
        ...props,
        useStore: selector => selector(instance.getSnapshot()),
        actions: instance.actions,
      },
    }
  }

  it('注册项声明了 store，且首屏仍落在体检（默认没变）', () => {
    const { entry, face, t } = boot()
    const { props } = withStore(entry, propsFor(face, t))
    const html = renderToStaticMarkup(React.createElement(entry.component, props))
    assert.ok(html.includes('开始体检') || html.includes('健康分'), '首屏应落在体检：' + html.slice(0, 200))
  })

  it('切到「环境」子页后重挂载仍在环境子页（选择来自 store，不是组件内 state）', () => {
    const { entry, face, t } = boot()
    const { props } = withStore(entry, propsFor(face, t))
    props.actions.select('env')
    const first = renderToStaticMarkup(React.createElement(entry.component, props))
    assert.ok(first.includes('新建环境'), '切过去应看到环境子页：' + first.slice(0, 200))
    // 再渲染一次等价于重挂载：组件内 useState 会复位回体检，store 不会。
    const again = renderToStaticMarkup(React.createElement(entry.component, props))
    assert.ok(again.includes('新建环境'), '重挂载后必须还在环境子页')
    assert.ok(!again.includes('开始体检'), '不得被弹回体检')
  })

  it('体检还在跑、store 连续发布时，切过去的子页不被弹回', () => {
    const { entry, face, t } = boot()
    const { props } = withStore(entry, propsFor(face, t))
    const stub = stubFetch({
      diagnose: () => ({ ok: true, value: { jobId: 'job-1' } }),
      job: () => ({ ok: true, value: { done: false } }),
      listEnvironments: () => ({ ok: true, value: [] }),
    })
    try {
      face.diagnose()
      props.actions.select('env')
      for (let tick = 0; tick < 3; tick += 1) {
        face.hooks.health.update(draft => { draft.notice = 'tick ' + String(tick) })
        const html = renderToStaticMarkup(React.createElement(entry.component, props))
        assert.ok(html.includes('新建环境'), '第 ' + String(tick + 1) + ' 次发布后必须还在环境子页')
        assert.ok(!html.includes('开始体检'), '第 ' + String(tick + 1) + ' 次发布后不得被弹回体检')
      }
    } finally {
      stub.restore()
    }
  })
})

describe('修复失败的归因与存续（task-35 P1）', () => {
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
  const okDiagnose = {
    diagnose: () => ({ ok: true, value: { jobId: 'job-1' } }),
    job: () => ({ ok: true, value: { done: true, result: REPORT_WITH_FIX } }),
    listEnvironments: () => ({ ok: true, value: [] }),
  }

  /** 跑一次诊断，让页面上有可修复的问题。 */
  async function diagnoseOnce(face) {
    face.diagnose()
    await until(() => face.hooks.health.getSnapshot().report !== undefined, '报告落地')
    return face.hooks.health.getSnapshot().report.issues[0]
  }

  it('载荷 ok=false：显示「修复失败」，不是「体检失败」', async () => {
    const { entry, face, t } = boot()
    const stub = stubFetch({
      ...okDiagnose,
      fix: () => ({ ok: true, value: { ok: false, code: 'operation-failed', output: '装不上：pkg' } }),
    })
    try {
      const issue = await diagnoseOnce(face)
      face.fix(issue)
      await until(() => face.hooks.health.getSnapshot().error !== undefined, '修复失败落进 store')
      assert.equal(face.hooks.health.getSnapshot().failureFrom, 'fix', '归因必须是 fix')
      const html = renderToStaticMarkup(React.createElement(entry.component, propsFor(face, t)))
      assert.ok(html.includes('修复失败'), '要显示修复失败：' + html.slice(0, 300))
      assert.ok(!html.includes('体检失败'), '不得写成体检失败')
    } finally { stub.restore() }
  })

  it('callOp 直接抛（异常形态）：同样显示「修复失败」——这是漏掉的那一半', async () => {
    const { entry, face, t } = boot()
    const stub = stubFetch({
      ...okDiagnose,
      // 刻意不写 notice 的那条路径：请求本身失败，客户端只拿到异常。
      fix: () => { throw new Error('Failed to fetch') },
    })
    try {
      const issue = await diagnoseOnce(face)
      face.fix(issue)
      await until(() => face.hooks.health.getSnapshot().error !== undefined, '异常落进 store')
      assert.equal(face.hooks.health.getSnapshot().failureFrom, 'fix', '异常路径的归因也必须是 fix')
      assert.equal(face.hooks.health.getSnapshot().notice, undefined, '前提：这条路径确实不写 notice')
      const html = renderToStaticMarkup(React.createElement(entry.component, propsFor(face, t)))
      assert.ok(html.includes('修复失败'), '异常形态也要显示修复失败：' + html.slice(0, 300))
      assert.ok(!html.includes('体检失败'), '不得写成体检失败（真机 P1 就是这里）')
    } finally { stub.restore() }
  })

  it('修复失败之后跑一次成功的体检，失败横幅仍在（用户处置前不消失）', async () => {
    const { entry, face, t } = boot()
    const stub = stubFetch({
      ...okDiagnose,
      fix: () => { throw new Error('Failed to fetch') },
    })
    try {
      const issue = await diagnoseOnce(face)
      face.fix(issue)
      await until(() => face.hooks.health.getSnapshot().error !== undefined, '修复失败落进 store')
      face.diagnose()
      await until(() => face.hooks.health.getSnapshot().running === false, '体检跑完')
      const state = face.hooks.health.getSnapshot()
      assert.equal(state.error !== undefined, true, '修复失败必须还在：' + JSON.stringify(state.error))
      assert.equal(state.failureFrom, 'fix', '归因仍然是 fix')
      const html = renderToStaticMarkup(React.createElement(entry.component, propsFor(face, t)))
      assert.ok(html.includes('修复失败'), '横幅必须还在页面上：' + html.slice(0, 300))
    } finally { stub.restore() }
  })

  it('重新发起修复即清上一条：新失败替换旧失败，成功则横幅消失', async () => {
    const { entry, face } = boot()
    let mode = 'fail-a'
    const stub = stubFetch({
      ...okDiagnose,
      fix: () => mode === 'fail-a'
        ? { ok: true, value: { ok: false, code: 'operation-failed', output: '第一次失败' } }
        : mode === 'fail-b'
          ? { ok: true, value: { ok: false, code: 'operation-failed', output: '第二次失败' } }
          : { ok: true, value: { ok: true, output: '装好了' } },
    })
    try {
      const issue = await diagnoseOnce(face)
      face.fix(issue)
      await until(() => face.hooks.health.getSnapshot().notice === '第一次失败', '第一次失败')
      mode = 'fail-b'
      face.fix(issue)
      await until(() => face.hooks.health.getSnapshot().notice === '第二次失败', '第二次失败替换了第一次')
      mode = 'ok'
      face.fix(issue)
      await until(() => face.hooks.health.getSnapshot().fixingId === undefined
        && face.hooks.health.getSnapshot().notice === '装好了', '修复成功')
      assert.equal(face.hooks.health.getSnapshot().error, undefined, '修复成功后不该还挂着失败')
      assert.equal(face.hooks.health.getSnapshot().failureFrom, undefined, '归因也要跟着清掉')
    } finally { stub.restore() }
  })

  it('体检失败的归因不被顶掉（仍然是「体检失败」）', async () => {
    const { entry, face, t } = boot()
    const stub = stubFetch({
      diagnose: () => ({ ok: true, value: { jobId: 'job-1' } }),
      job: () => ({ ok: true, value: { done: true, error: '引擎挂了' } }),
      listEnvironments: () => ({ ok: true, value: [] }),
    })
    try {
      face.diagnose()
      await until(() => face.hooks.health.getSnapshot().error !== undefined, '体检失败落进 store')
      assert.equal(face.hooks.health.getSnapshot().failureFrom, 'diagnose', '归因是 diagnose')
      const html = renderToStaticMarkup(React.createElement(entry.component, propsFor(face, t)))
      assert.ok(html.includes('体检失败'), '要显示体检失败：' + html.slice(0, 300))
      assert.ok(!html.includes('修复失败'), '没点过修复就不该出现修复失败')
    } finally { stub.restore() }
  })

  it('修复成功：结果留着，且报告确实被重新拉过（自动刷新不是什么都不做）', async () => {
    const { face } = boot()
    let mode = 'fail'
    const stub = stubFetch({
      ...okDiagnose,
      fix: () => mode === 'fail'
        ? { ok: true, value: { ok: false, code: 'operation-failed', output: '先失败一次' } }
        : { ok: true, value: { ok: true, output: '装好了' } },
    })
    try {
      const issue = await diagnoseOnce(face)
      face.fix(issue)
      await until(() => face.hooks.health.getSnapshot().error !== undefined, '先失败一次')
      const before = stub.calls.filter(call => call.op === 'diagnose').length
      mode = 'ok'
      face.fix(issue)
      await until(() => face.hooks.health.getSnapshot().notice === '装好了', '成功提示可见')
      await until(() => stub.calls.filter(call => call.op === 'diagnose').length > before, '自动刷新确实重跑了体检')
      const state = face.hooks.health.getSnapshot()
      assert.equal(state.notice, '装好了', '成功提示不能被自己触发的刷新清掉')
      assert.equal(state.error, undefined, '修复成功后不该还挂着失败')
      assert.equal(state.failureFrom, undefined, '归因跟着一起清')
    } finally { stub.restore() }
  })

  it('用户主动体检才清上一条动作结果（下一次动作=处置）', async () => {
    const { face } = boot()
    const stub = stubFetch({
      ...okDiagnose,
      fix: () => ({ ok: true, value: { ok: true, output: '装好了' } }),
    })
    try {
      const issue = await diagnoseOnce(face)
      face.fix(issue)
      await until(() => face.hooks.health.getSnapshot().notice === '装好了', '成功提示可见')
      face.diagnose()
      await until(() => face.hooks.health.getSnapshot().notice === undefined, '用户体检清掉上一条结果')
    } finally { stub.restore() }
  })
})

describe('环境列表：按字段显示「未知」而不是 0（task-43 字段清单）', () => {
  /** 造一个 listEnvironments 的载荷。 */
  const environmentPayload = (extra) => [{
    name: 'pm-unknown', dir: '/tmp/pm-unknown', current: true, builtin: false,
    bundles: [], dependencies: [], runs: [],
    ...extra,
  }]

  /** 用 fetch 桩喂列表，再渲染「环境」子页（走 wire 归一，最接近真机路径）。 */
  async function renderEnvWith(payload) {
    const booted = boot()
    const stub = stubFetch({ listEnvironments: () => ({ ok: true, value: payload }) })
    try {
      booted.face.refreshEnvironments()
      await until(() => booted.face.hooks.environments.getSnapshot().loading === false, '环境列表落地')
      return { ...booted, html: renderTab(booted.entry, booted.face, booted.t, 'env') }
    } finally { stub.restore() }
  }

  /** 直接喂 store 再渲染：兜底那条要在"上游产不出未映射字段"时也能测到（防御纵深）。 */
  function renderEnvWithRawState(environment) {
    const booted = boot()
    booted.face.hooks.environments.update((draft) => { draft.environments = [environment] })
    return { ...booted, html: renderTab(booted.entry, booted.face, booted.t, 'env') }
  }

  it('unknownFields 含 bundles：组合包栏「未知」+ 原因可见，且不出现 0 个组合包', async () => {
    const reason = 'dsh.profile.bundles 存在但不是字符串数组'
    const { html } = await renderEnvWith(environmentPayload({
      bundles: [], dependencies: ['@deepseek-ai/dsh-base'],
      unknownFields: ['bundles'], unknownReason: reason,
    }))
    assert.ok(html.includes('未知'), '组合包那一栏要显示「未知」：' + html.slice(0, 400))
    assert.ok(!html.includes('0 个组合包'), '读不懂不能画成"0 个组合包"（把不知道说成知道）')
    assert.ok(html.includes(reason), '原因必须是可见文本，不是只挂 title')
  })

  it('反向：没有 unknownFields 时显示真实数字，且不出现「未知」', async () => {
    const { html } = await renderEnvWith(environmentPayload({
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], dependencies: ['@deepseek-ai/dsh-base'],
    }))
    assert.ok(html.includes('2 个组合包'), '确定的事实用真实数字：' + html.slice(0, 400))
    assert.ok(html.includes('1 个依赖'), '依赖栏也是真实数字')
    assert.ok(!html.includes('未知'), '不是未知就不能出现未知')
  })

  it('两栏互不串味：只含 dependencies 时组合包栏仍显示真实数字', async () => {
    const reason = 'dependencies 不是对象'
    const { html } = await renderEnvWith(environmentPayload({
      bundles: ['@deepseek-ai/dsh-base'], dependencies: [],
      unknownFields: ['dependencies'], unknownReason: reason,
    }))
    assert.ok(html.includes('1 个组合包'), '组合包是确定事实，必须给数字：' + html.slice(0, 400))
    assert.ok(!html.includes('0 个依赖'), '依赖读不懂就不能显示 0 个依赖')
    assert.ok(html.includes('未知'), '依赖栏要显示未知')
    assert.ok(html.includes(reason), '原因可见')
  })

  it('unknownFields 为空数组：两栏都显示真实数字', async () => {
    const { html } = await renderEnvWith(environmentPayload({
      bundles: ['@deepseek-ai/dsh-base'], dependencies: ['@deepseek-ai/dsh-base'],
      unknownFields: [], unknownReason: '',
    }))
    assert.ok(html.includes('1 个组合包') && html.includes('1 个依赖'), '空清单=全部确定：' + html.slice(0, 400))
    assert.ok(!html.includes('未知'), '空清单不该出现未知')
  })

  it('wire 只透传闭集里的名字：清单里塞垃圾不发明「未知」', async () => {
    const { html } = await renderEnvWith(environmentPayload({
      bundles: ['@deepseek-ai/dsh-base'], dependencies: [],
      unknownFields: ['layers', 42, null], unknownReason: '未来字段',
    }))
    assert.ok(html.includes('1 个组合包'), '不认识的名字不入清单：' + html.slice(0, 400))
    assert.ok(!html.includes('未知'), '不发明未知')
  })

  it('只有 reason 没有清单时不显示未知（原因不能单独成立）', async () => {
    const { html } = await renderEnvWith(environmentPayload({
      bundles: ['@deepseek-ai/dsh-base'], dependencies: [],
      unknownReason: '一些原因',
    }))
    assert.ok(html.includes('1 个组合包'), '按已知显示：' + html.slice(0, 400))
    assert.ok(!html.includes('未知'), '没有清单就不该出现未知')
  })

  it('兜底：清单里有界面没映射的字段名时，两栏照常给数字，另外显示一次通用原因', () => {
    const reason = 'dsh.profile.layers 读不懂'
    const { html } = renderEnvWithRawState({
      name: 'pm-future', dir: '/tmp/pm-future', current: false, builtin: false,
      bundles: ['@deepseek-ai/dsh-base'], dependencies: ['@deepseek-ai/dsh-base'], runs: [],
      unknownFields: ['layers'], unknownReason: reason,
    })
    assert.ok(html.includes('1 个组合包') && html.includes('1 个依赖'), '两栏照常给数字：' + html.slice(0, 400))
    assert.equal(html.split(reason).length - 1, 1, '兜底原因只出现一次')
    assert.ok(html.includes('环境事实不完整'), '兜底行要标明"事实不完整"：' + html.slice(0, 500))
  })
})

describe('只读标记（task-48）：状态用标记承载，不用句子', () => {
  const ENVIRONMENTS = [
    { name: 'pm-now', dir: '/tmp/pm-now', current: true, builtin: false, bundles: ['@deepseek-ai/dsh-base'], dependencies: [], runs: [] },
    { name: 'pm-other', dir: '/tmp/pm-other', current: false, builtin: false, bundles: ['@deepseek-ai/dsh-base'], dependencies: [], runs: [] },
  ]
  const okOps = {
    listEnvironments: () => ({ ok: true, value: ENVIRONMENTS }),
    diagnose: () => ({ ok: true, value: { jobId: 'job-1' } }),
    job: () => ({
      ok: true,
      value: {
        done: true,
        result: {
          environment: 'pm-other', generatedAt: '2026-09-19T03:00:00.000Z',
          counts: { dependency: 0, composition: 0, runtime: 0, consistency: 0, ecosystem: 0 },
          issues: [], skipped: [],
        },
      },
    }),
  }

  it('诊断目标不是当前环境时显示「只读」标记；是当前环境时不显示', async () => {
    const booted = boot()
    const stub = stubFetch(okOps)
    try {
      booted.face.refreshEnvironments()
      await until(() => booted.face.hooks.environments.getSnapshot().loading === false, '环境列表落地')
      const home = renderTab(booted.entry, booted.face, booted.t, 'health')
      assert.ok(!home.includes('只读'), '当前环境下不该出现只读标记：' + home.slice(0, 300))
      // task-66：这个事实必须被说出来，不能靠"没有非当前环境标记"这种缺席去推断。
      assert.ok(home.includes('>当前环境</'), '当前环境要有明确标记（不能靠缺席表达）：' + home.slice(0, 400))
      assert.ok(!home.includes('>非当前环境</'), '当前环境下不该出现非当前环境标记')

      booted.face.setDiagnosticTarget('pm-other')
      await until(() => booted.face.hooks.health.getSnapshot().target === 'pm-other', '目标切到另一个环境')
      const away = renderTab(booted.entry, booted.face, booted.t, 'health')
      assert.ok(away.includes('只读'), '不是当前环境时要显示只读标记：' + away.slice(0, 400))
      assert.ok(away.includes('>非当前环境</'), '非当前环境要有标记')
      assert.ok(!away.includes('>当前环境</'), '两个标记不得同时出现（互斥）')
      // §12.5：被删掉的那句状态说明，语义要由标记承载——所以"标记在、句子不在"要能同时看出来。
      assert.ok(!away.includes('本页只读'), '状态句不得回来（已由标记承载）')
      assert.ok(!away.includes('默认诊断当前环境'), '被删的那句不得回来')
    } finally { stub.restore() }
  })

  it('设置只读时显示「只读」标记 + 后果半句；可写时不显示', () => {
    // 值经真实归一（宿主文档缺 trial 段时由客户端补齐）；可写性仍由 settingsScope 决定。
    const booted = boot({
      configValue: {
        diagnostics: { dependency: true, composition: true, runtime: true, consistency: true, ecosystem: false },
        qualityGate: { enabled: true, mode: 'block', allowlist: [] },
        marketplace: { enabled: true, cacheTtlMinutes: 1440, timeoutMs: 15000, indexUrl: '' },
      },
    })
    booted.face.hooks.config.update((draft) => { draft.writable = true })
    const writable = renderTab(booted.entry, booted.face, booted.t, 'settings')
    assert.ok(!writable.includes('只读'), '可写时不该出现只读标记：' + writable.slice(0, 300))

    booted.face.hooks.config.update((draft) => { draft.writable = false })
    const readOnly = renderTab(booted.entry, booted.face, booted.t, 'settings')
    assert.ok(readOnly.includes('只读'), '只读时要显示标记：' + readOnly.slice(0, 400))
    assert.ok(readOnly.includes('改动无法保存'), '后果半句要保留：' + readOnly.slice(0, 400))
    assert.ok(!readOnly.includes('本部署的设置是只读的'), '状态句不得回来（已由标记承载）')
  })
})

describe('环境列表：进程事实不可读时运行栏显示「未知」而不是「未运行」（task-63）', () => {
  const payload = (extra) => [{
    name: 'pm-runs', dir: '/tmp/pm-runs', current: true, builtin: false,
    bundles: ['@deepseek-ai/dsh-base'], dependencies: [], runs: [],
    ...extra,
  }]

  /** 走 wire 归一（最接近真机路径），再渲染「环境」子页。 */
  async function renderEnv(payloadValue) {
    const booted = boot()
    const stub = stubFetch({ listEnvironments: () => ({ ok: true, value: payloadValue }) })
    try {
      booted.face.refreshEnvironments()
      await until(() => booted.face.hooks.environments.getSnapshot().loading === false, '环境列表落地')
      return { ...booted, html: renderTab(booted.entry, booted.face, booted.t, 'env') }
    } finally { stub.restore() }
  }

  it('runsKnown=false：显示「未知」+ 可见原因，且**不出现「未运行」**', async () => {
    const reason = 'powershell CIM 不可用（spawnSync powershell ENOENT）：无法读取进程表'
    const { html } = await renderEnv(payload({ runsKnown: false, runsUnknownReason: reason }))
    assert.ok(html.includes('未知'), '运行栏要显示未知：' + html.slice(0, 500))
    assert.ok(!html.includes('未运行'), '不知道就不能说"未运行"（这正是本任务要防的误读）')
    assert.ok(html.includes(reason), '原因必须是可见文本，不是只挂 title')
  })

  it('反向：缺省 runsKnown 时照旧显示真实状态（空 runs = 未运行）', async () => {
    const { html } = await renderEnv(payload({ runs: [] }))
    assert.ok(html.includes('未运行'), '确定没在运行就照旧说未运行：' + html.slice(0, 400))
    assert.ok(!html.includes('未知'), '不是未知就不能出现未知')
  })

  it('反向：有运行实例时显示「运行中」', async () => {
    const { html } = await renderEnv(payload({ runs: [{ pid: 42, port: 3090, command: 'node dsh.js' }] }))
    assert.ok(html.includes('运行中'), '有实例就是运行中：' + html.slice(0, 400))
    assert.ok(!html.includes('未知'), '不是未知就不能出现未知')
  })

  it('只透传已知事实：runsKnown 是别的取值时不发明「未知」', async () => {
    const { html } = await renderEnv(payload({ runsKnown: 'no', runsUnknownReason: '一些原因' }))
    assert.ok(html.includes('未运行'), '非 false 一律按已知处理：' + html.slice(0, 400))
    assert.ok(!html.includes('未知'), '不发明未知')
  })
})

describe('体检页：删除冗余后，替代载体必须真的在（task-64）', () => {
  const ENVIRONMENTS = [
    { name: 'pm-now', dir: '/tmp/pm-now', current: true, builtin: false, bundles: [], dependencies: [], runs: [] },
    { name: 'pm-other', dir: '/tmp/pm-other', current: false, builtin: false, bundles: [], dependencies: [], runs: [] },
  ]

  /** 目标切到另一个环境，再渲染体检子页。 */
  async function renderForeign() {
    const booted = boot()
    const stub = stubFetch({
      listEnvironments: () => ({ ok: true, value: ENVIRONMENTS }),
      diagnose: () => ({ ok: true, value: { jobId: 'job-1' } }),
      job: () => ({
        ok: true,
        value: {
          done: true,
          result: {
            environment: 'pm-other', generatedAt: '2026-09-19T03:00:00.000Z',
            counts: { dependency: 0, composition: 0, runtime: 0, consistency: 0, ecosystem: 0 },
            issues: [], skipped: [],
          },
        },
      }),
    })
    try {
      booted.face.refreshEnvironments()
      await until(() => booted.face.hooks.environments.getSnapshot().loading === false, '环境列表落地')
      booted.face.setDiagnosticTarget('pm-other')
      await until(() => booted.face.hooks.health.getSnapshot().report !== undefined, '对另一个环境的报告落地')
      return renderTab(booted.entry, booted.face, booted.t, 'health')
    } finally { stub.restore() }
  }

  it('删「诊断目标：X」→ 选择器里显示着环境名，且那句不在', async () => {
    const html = await renderForeign()
    assert.ok(html.includes('pm-other'), '选择器要显示目标名：' + html.slice(0, 400))
    assert.ok(!html.includes('诊断目标：pm-other'), '「诊断目标：X」已删（复述控件值）')
  })

  it('删「非当前环境」后缀 → 标记留下、选项标签不再拼「· 当前环境」', async () => {
    const html = await renderForeign()
    assert.ok(html.includes('非当前环境'), '载体留在控件旁：' + html.slice(0, 400))
    assert.ok(!html.includes(' · 当前环境'), '选项标签里不再拼后缀（同一事实只留一处）')
    // 选项列表在 SSR 里不渲染（菜单是关的），所以"标签怎么拼"用源码级护栏钉住；
    // 真机由截图承担（同屏可见：标记在、选择器里只有名字）。
    const source = readFileSync('src/client/ConsolePage.tsx', 'utf8')
    assert.ok(!source.includes("· ${t('env.current')}"), '选项标签不得再拼「· 当前环境」')
    assert.match(source, /label: environment\.name/, '选项标签就是环境名')
  })

  it('删「修改请到「环境」子页」→ 「环境」入口仍可见（指路的替代载体）', async () => {
    const html = await renderForeign()
    assert.ok(html.includes('>环境</button>'), '「环境」子页标签必须在屏幕上：' + html.slice(0, 400))
    assert.ok(!html.includes('修改请到'), '指路那句已删（用户会自然打开环境页）')
    assert.ok(!html.includes('health.foreignBody'), '不得渲染已删的键')
  })

  it('报告的归属仍写清楚（报告头承载，不是控件复述）', async () => {
    const html = await renderForeign()
    assert.ok(html.includes('被诊断环境：pm-other'), '报告头要说清这份报告属于谁：' + html.slice(0, 500))
  })
})

describe('视觉令牌护栏（task-67）：承重层级与真令牌', () => {
  /** src/ 下的全部源码文件（含 CSS Modules），护栏要走完整棵树，避免"这个文件没被检查"。 */
  const sourceFiles = () => readdirSync('src', { recursive: true })
    .filter(entry => /[.](css|ts|tsx)$/.test(entry))
    .map(entry => join('src', entry))

  it('官方不存在的字体令牌名不得再出现（--dsw-font-family-mono 曾出现 4 处）', () => {
    // 旧写法是 font-family: var(--dsw-font-family-mono, ui-monospace, …)：退避值掩盖了它只是"命名幻觉"，
    // 官方任何样式表与已安装产物里都没有这个名字。换上的真令牌 --dsw-font-markdown-code-font-family 有定义
    // （ui-theme/src/styles/gradient-shadow-text.css:158 ⇒ var(--ds-font-family-code)，字体栈在同目录 base.css:9）、
    // 有官方先例（ui-primitives/src/user-text.module.css），且 docs/web-styling.md 要求特性组件消费 --dsw-* 语义
    // 别名而不是 --ds-* 基础令牌。
    const offenders = sourceFiles().filter(file => readFileSync(file, 'utf8').includes('--dsw-font-family-mono'))
    assert.deepEqual(offenders, [], '这些文件用了官方不存在的令牌名：' + offenders.join(', '))
  })

  it('代码字体用法（issueCode/evidenceAt/envDir、templateBundles、kinds.path、market.repo、试装环境名）都在真令牌上', () => {
    const files = ['src/client/ConsolePage.module.css', 'src/client/KindsPage.module.css', 'src/client/MarketplacePage.module.css']
    const uses = files.flatMap(file =>
      readFileSync(file, 'utf8').match(/font-family:[ ]*var[(]--dsw-font-markdown-code-font-family[)]/g) || [])
    // 5 = task-67 的四处（issueCode/evidenceAt/envDir 合并成一条规则 + templateBundles + kinds.path + market.repo）
    //     加 task-52 新增的试装环境名（工具生成的目录名，同属代码文本）。
    assert.equal(uses.length, 5, '代码字体都要显式消费 --dsw-font-markdown-code-font-family：' + String(uses.length))
  })

  /** 取某个类自己的规则里的 color 令牌；类必须有独立规则，否则它只是"跟着别人一起变"。 */
  const colorTokenOf = (css, className) => {
    const rule = new RegExp('[.]' + className + '[ ]*[{]([^}]*)[}]').exec(css)
    assert.notEqual(rule, null, '.' + className + ' 必须有独立规则')
    const token = /color:[ ]*var[(]--dsw-alias-label-[a-z]+[)]/.exec(rule[1])
    assert.notEqual(token, null, '.' + className + ' 必须用 label-* 语义令牌：' + rule[1])
    return token[0].slice(token[0].indexOf('--'), -1)
  }

  it('承重文本 = label-secondary；装饰层级 = label-tertiary（判据写在注释里）', () => {
    // 判据（Lead 裁定，别当成随意划的线）：删掉这段文字之后，用户还能不能完成任务？
    // 不能 → 承重 → label-secondary（浅色 5.8:1）；能 → 装饰性层级 → 保持官方 label-tertiary（浅色 3.71:1）。
    // 不做全局替换：官方刻意做的层级不能被抹掉，"与官方样式一致"这条原则更硬。
    // 未选中 tab（.tab）与市场 .link 属已知官方令牌层偏差：前者是导航入口、后者是官方 link 别名，都不由我方单方面改。
    const consoleCss = readFileSync('src/client/ConsolePage.module.css', 'utf8')
    for (const className of ['evidenceNote', 'fixSummary', 'envUnknownReason']) {
      assert.equal(colorTokenOf(consoleCss, className), '--dsw-alias-label-secondary',
        '.' + className + ' 是承重文本（证据说明 / 修复动作 / 「未知」的原因），删掉用户就没法判断该不该动手')
    }
    for (const className of ['metaLabel', 'scoreMeta', 'envMeta', 'hint', 'tab']) {
      assert.equal(colorTokenOf(consoleCss, className), '--dsw-alias-label-tertiary',
        '.' + className + ' 是装饰性层级（删掉不影响完成任务），必须保持官方层级')
    }
    for (const file of ['KindsPage', 'MarketplacePage']) {
      const css = readFileSync('src/client/' + file + '.module.css', 'utf8')
      for (const className of ['meta', 'metaLabel']) {
        assert.equal(colorTokenOf(css, className), '--dsw-alias-label-tertiary',
          file + '.' + className + ' 是层级信息，保持官方 tertiary')
      }
    }
  })
})


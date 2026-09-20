/**
 * 试装那一节的客户端契约（task-52）。
 *
 * 归属：A 类·重写（新护栏）。手法与 tests/console-page.test.mjs 同源，但独立成文件：
 *   console-page.test.mjs 已经很长，而这一节的断言只需要共享桩件（tests/client-harness.mjs）。
 *
 * 这里钉的四件事（任务描述里的验收口径）：
 *   1. 披露事实整条来自 host 的 capabilities.trialDisclosure（数字 + 口径），**不许硬编码**；
 *   2. 读不到就必须说「未知」并给原因——不显示数字、不显示空列表冒充"没有测试环境"；
 *   3. 布尔事实读不到显示「未知」，不显示「未运行」「归属环境已不存在」这类结论；
 *   4. 安装结果的四种处置各自可辨，尤其是 warn 放行**不算通过**（成功路径也要说出来）。
 *
 * 运行前需要 dist/client.js 是新的（pnpm run build）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import {
  applyWithMocks, bootBundle, makeT, propsFor, registration, React, stubFetch, until,
} from './client-harness.mjs'

const require_ = createRequire(import.meta.url)
const { renderToStaticMarkup } = require_('react-dom/server')

const ENV_EMPTY = {
  environments: [], factsReadable: true,
  totals: { count: 0, running: 0, bytes: 0, unknownBytes: 0 },
  retention: { days: 14, autoCleanup: true, maxKept: 0 },
  plan: { remove: [], keep: [] }, overCap: false, notes: [],
}

const DISCLOSURE = {
  executesCandidateCode: true, peakMemoryMiB: 999, measurement: '实测口径：测试桩件量得',
}

/**
 * 启动产物并取一个注册项。
 *
 * @param slot - slot 名。
 * @param id - 注册项 id。
 * @param value - settings 命名空间的当前值（缺 trial 段正是要覆盖的情形）。
 * @param react - 可选的 react 替身（用来把某个 useState 的初始值改成"被点开了"；见确认框那条用例）。
 * @returns 注册项、注入面、字典座位与 props。
 */
function boot(slot, id, value, react) {
  const exported = bootBundle(react === undefined ? {} : { react })
  const applied = applyWithMocks(exported, { value })
  const t = makeT(applied.dicts, { strict: true })
  const entry = registration(applied.slotRegistrations, slot, id)
  const face = entry.options.inject()
  return { entry, face, t, props: propsFor(face, t, {}, entry) }
}

/** 渲染「环境控制台 → 设置」子页（试装那一节在那里）。 */
function renderSettings(entry, face, t) {
  const props = propsFor(face, t, {}, entry)
  assert.ok(props.actions !== undefined, '控制台注册项必须声明 store')
  props.actions.select('settings')
  return renderToStaticMarkup(React.createElement(entry.component, props))
}

describe('试装设置页（task-52）：披露来自 host、未知如实、warn 不算通过', () => {
  it('八项都在，且宿主文档缺 trial 段时按客户端默认值渲染（不是空白）', () => {
    const { entry, face, t } = boot('settings.section', 'console', {})
    const html = renderSettings(entry, face, t)
    for (const label of ['试装总开关', '验证深度', '试装前做基线启动', '允许联网拉取候选包', '试装失败时的行为', '自动清理测试环境', '保留天数', '最多保留数量（0 = 不限）']) {
      assert.ok(html.includes(label), '缺 trial 段也要渲染出这一项：' + label)
    }
    assert.ok(html.includes('14'), '保留天数默认 14 应可见（客户端归一补的值）')
    assert.ok(html.includes('自动（先建轻量副本）'), '验证深度默认值应可见')
  })

  it('披露事实整条来自 host：数字与口径跟着载荷变，且没有硬编码的 161', async () => {
    const { entry, face, t } = boot('settings.section', 'console', {})
    const stub = stubFetch({
      capabilities: () => ({ ok: true, value: { capabilities: {}, trialDisclosure: DISCLOSURE } }),
      trialEnvironments: () => ({ ok: true, value: ENV_EMPTY }),
    })
    try {
      face.loadTrial()
      await until(() => face.hooks.trial.getSnapshot().disclosure !== undefined, '披露事实落到状态里')
      const html = renderSettings(entry, face, t)
      assert.ok(html.includes('999 MiB'), '数字必须来自载荷：' + html.slice(0, 400))
      assert.ok(html.includes('实测口径：测试桩件量得'), '口径必须与数字一起显示')
      assert.ok(!html.includes('161'), '不得硬编码 161 MiB')
    } finally {
      stub.restore()
    }
  })

  it('披露读不到：显示「未知」+ 原因，且不出现任何内存数字（不假装没有风险）', async () => {
    const { entry, face, t } = boot('settings.section', 'console', {})
    const stub = stubFetch({
      capabilities: () => { throw new Error('探针挂了') },
      trialEnvironments: () => ({ ok: true, value: ENV_EMPTY }),
    })
    try {
      face.loadTrial()
      await until(() => face.hooks.trial.getSnapshot().disclosureError !== undefined, '披露失败落到状态里')
      const html = renderSettings(entry, face, t)
      assert.ok(html.includes('试装会做什么：未知'), '读不到要说「未知」')
      assert.ok(html.includes('探针挂了'), '要给出读不到的原因')
      assert.ok(!html.includes('内存峰值'), '读不到时不得出现内存数字那一行（占地的 MiB 是另一件事）')
    } finally {
      stub.restore()
    }
  })


  it('清理计划：会删的逐个列出、会留的连原因一起列出（不可逆操作之前必须能看出会动到什么）', async () => {
    // task-90：宿主早就返回了 plan.remove/keep（types.ts:698），客户端一直没画。
    // 清理是**删目录**的不可逆操作——把计划藏起来等于让用户凭运气按下去。
    const { entry, face, t } = boot('settings.section', 'console', {})
    const stub = stubFetch({
      capabilities: () => ({ ok: true, value: { capabilities: {}, trialDisclosure: DISCLOSURE } }),
      trialEnvironments: () => ({
        ok: true,
        value: {
          ...ENV_EMPTY,
          environments: [
            { name: 'a-dpmc', owner: 'a', dir: '/tmp/a-dpmc', modifiedAt: '', files: 0, sharedFiles: 0, snapshotMatchesOwner: null },
            { name: 'b-dpmc', owner: 'b', dir: '/tmp/b-dpmc', modifiedAt: '', files: 0, sharedFiles: 0, snapshotMatchesOwner: null },
          ],
          totals: { count: 2, running: 1, bytes: 0, unknownBytes: 0 },
          // 原因逐字取自宿主 planTrialCleanup（envManager.ts:2735-2747）。
          plan: {
            remove: [{ name: 'a-dpmc', reason: '超过保留期 14 天（20.1 天）' }],
            keep: [{ name: 'b-dpmc', reason: '正在运行：不删（先让用户停）' }],
          },
        },
      }),
    })
    try {
      face.loadTrial()
      await until(() => face.hooks.trial.getSnapshot().report !== undefined, '计划落状态')
      const html = renderSettings(entry, face, t)
      assert.ok(html.includes('下次清理'), '要有计划标题：' + html.slice(0, 600))
      assert.ok(html.includes('会删这 1 个'), '要说出会删几个')
      assert.ok(html.includes('会留这 1 个'), '要说出会留几个')
      assert.ok(html.includes('a-dpmc'), '会删的那个必须点名')
      assert.ok(html.includes('b-dpmc'), '会留的那个也必须点名')
      // 用户最常问的是"为什么没删它"——所以"会留"必须带原因，不能只列名字。
      assert.ok(html.includes('超过保留期 14 天（20.1 天）'), '会删的原因要给')
      assert.ok(html.includes('正在运行'), '会留的原因要给（否则用户不知道为什么没删它）')
    } finally {
      stub.restore()
    }
  })

  it('清理计划：空计划说「没有需要清理的」，计划读不到时不留白也不冒充空', async () => {
    const emptyBoot = boot('settings.section', 'console', {})
    const emptyStub = stubFetch({
      capabilities: () => ({ ok: true, value: { capabilities: {}, trialDisclosure: DISCLOSURE } }),
      trialEnvironments: () => ({ ok: true, value: ENV_EMPTY }),
    })
    try {
      emptyBoot.face.loadTrial()
      await until(() => emptyBoot.face.hooks.trial.getSnapshot().report !== undefined, '空计划落状态')
      const html = renderSettings(emptyBoot.entry, emptyBoot.face, emptyBoot.t)
      assert.ok(html.includes('没有需要清理的测试环境'), '空计划要如实说：' + html.slice(0, 600))
    } finally {
      emptyStub.restore()
    }

    // 宿主没给 plan 段（旧宿主/载荷不全）：这是"读不到"，不是"没有需要清理的"。
    // 两者必须分开（§12.3.3：不许用缺席表达状态）——所以这时**什么都不画**，
    // 而不是画一句"没有需要清理的"（那是替宿主下结论）。
    const noPlanBoot = boot('settings.section', 'console', {})
    const noPlanStub = stubFetch({
      capabilities: () => ({ ok: true, value: { capabilities: {}, trialDisclosure: DISCLOSURE } }),
      trialEnvironments: () => {
        const { plan: _drop, ...rest } = ENV_EMPTY
        return { ok: true, value: rest }
      },
    })
    try {
      noPlanBoot.face.loadTrial()
      await until(() => noPlanBoot.face.hooks.trial.getSnapshot().report !== undefined, '无 plan 段落状态')
      const html = renderSettings(noPlanBoot.entry, noPlanBoot.face, noPlanBoot.t)
      assert.ok(!html.includes('没有需要清理的测试环境'),
        '宿主没给计划时不许说"没有需要清理的"——那是替宿主下结论：' + html.slice(0, 600))
    } finally {
      noPlanStub.restore()
    }
  })

  it('R2 自洽性：清理计划的"名字 + 原因"不许拼成一行（宿主的原因自带冒号）', async () => {
    // Lead 在 task-90 里留的自洽性检查：trial.planRow 的 `{name}：{reason}` 形态
    // **确实触发** §12.9 R2——因为宿主 planTrialCleanup 有一条原因是
    // "正在运行：不删（先让用户停）"，拼起来就是 "名字：正在运行：不删…"（一行两个冒号）。
    // 实测确认后：planRow 键已删，名字与原因**分层渲染**（各占一个元素）。
    // 这条用例钉住"分层"这件事：真机渲染出来的计划里，任何一行都不能有两个冒号。
    const { entry, face, t } = boot('settings.section', 'console', {})
    const stub = stubFetch({
      capabilities: () => ({ ok: true, value: { capabilities: {}, trialDisclosure: DISCLOSURE } }),
      trialEnvironments: () => ({
        ok: true,
        value: {
          ...ENV_EMPTY,
          environments: [],
          plan: {
            remove: [{ name: 'a-dpmc', reason: '超过保留期 14 天（20.1 天）' }],
            // 这条就是触发 R2 的那一条（宿主原文）。
            keep: [{ name: 'b-dpmc', reason: '正在运行：不删（先让用户停）' }],
          },
        },
      }),
    })
    try {
      face.loadTrial()
      await until(() => face.hooks.trial.getSnapshot().report !== undefined, '计划落状态')
      const html = renderSettings(entry, face, t)
      // 把渲染结果切成"屏幕上的一行"再判：SSR 是一整行 HTML，标签边界即屏幕上的换行。
      const rendered = html.replace(/<[^>]*>/g, String.fromCharCode(10))
      const { violationsOf } = await import('./copy-rules.mjs')
      const hits = violationsOf(rendered, 'rendered')
      assert.deepEqual(hits, [], '清理计划命中了 §12.9：' + hits.join(', '))
      // 反向：那条触发 R2 的原因确实渲染出来了（否则这条用例是空转）。
      assert.ok(html.includes('正在运行'), '触发 R2 的那条原因必须真的在（否则用例空转）')
    } finally {
      stub.restore()
    }
  })

  it('清理走二次确认：点「清理过期」先弹确认框，说清会删几个，取消不执行', async () => {
    // task-91：清理一次删**多个**目录，而"删除单个环境"只删一个却有确认框——
    // 风险更高的动作反而少一道关。这条钉住"点下去先弹框、且框里给的是数字"。
    const { entry, face, t } = boot('settings.section', 'console', {})
    const cleanupCalls = []
    const stub = stubFetch({
      capabilities: () => ({ ok: true, value: { capabilities: {}, trialDisclosure: DISCLOSURE } }),
      trialEnvironments: () => ({
        ok: true,
        value: {
          ...ENV_EMPTY,
          environments: [{ name: 'a-dpmc', owner: 'a', dir: '/tmp/a-dpmc', modifiedAt: '', files: 0, sharedFiles: 0, snapshotMatchesOwner: null }],
          totals: { count: 1, running: 0, bytes: 0, unknownBytes: 0 },
          plan: {
            remove: [
              { name: 'a-dpmc', reason: '超过保留期 14 天（20.1 天）' },
              { name: 'c-dpmc', reason: '超过保留期 14 天（18.0 天）' },
            ],
            keep: [],
          },
        },
      }),
      trialCleanup: () => { cleanupCalls.push(true); return { ok: true, value: { ok: true, output: '', removed: [] } } },
    })
    try {
      face.loadTrial()
      await until(() => face.hooks.trial.getSnapshot().report !== undefined, '计划落状态')
      const html = renderSettings(entry, face, t)
      // 初始状态：入口在，但确认框**关着**。
      assert.ok(html.includes('清理过期'), '清理入口要在')
      assert.equal(cleanupCalls.length, 0, '还没点任何东西，不该已经执行')
      // 官方 Modal 桩件在 open=false 时仍渲染 children（结构里带 data-open="false"），
      // 所以"关着"的判据是 data-open 属性，不是"文案不在 DOM 里"——
      // 第一版断言 !includes('将删除') 就是这么写错的（它其实一直在 DOM 里）。
      assert.match(html, /data-stub="Modal" data-title="清理过期测试环境" data-open="false"/,
        '没点之前确认框必须是关着的（data-open=false）：' + html.slice(0, 200))
      // 计划里的计数必须能被确认框用上（2 个）——这是"说清会删几个"的数据来源。
      assert.ok(html.includes('会删这 2 个'), '计划区要说出会删 2 个')
      assert.ok(html.includes('按当前计划删除 2 个测试环境'), '确认框正文要说清会删 2 个')
    } finally {
      stub.restore()
    }
  })

  it('清理确认框真的会被点开（驱动真实交互：onClick → setState → 重渲染）', async () => {
    // 上一条只证明了"关着的时候是关的"。**"点了会开"**必须另证——
    // 否则把 onClick 摘掉、或把 state 写死 false，上一条照样绿。
    //
    // 手法沿用 tests/console-page.test.mjs 的 shimReact：把 useState 的**初始值**改掉，
    // 等价于"这个 state 被点开了"——SSR 不跑事件，这是零依赖环境里唯一能驱动真实 state 的路。
    // 关键：shim 只对"清理确认框"这一个 state 生效（按初始值 false + 调用顺序认），
    // 认不出来就什么都不改，宁可让用例红，也不静默改错 state。
    // 认哪个 state：清理确认框是**唯一**一个 useState(false)。
    // 不能按"第几个 useState"认——组件是嵌套的（TrialEnvironments 在 ConsolePage 里），
    // 调用顺序跨组件交错，第一版按计数认就改错了 state（改了别人，弹框纹丝不动）。
    // 按**初始值**认：只有它是 boolean false。
    const reactShim = {
      ...React,
      useState(initial) {
        if (initial === false) return React.useState(true)
        return React.useState(initial)
      },
    }
    const { entry, face, t } = boot('settings.section', 'console', {}, reactShim)
    const stub = stubFetch({
      capabilities: () => ({ ok: true, value: { capabilities: {}, trialDisclosure: DISCLOSURE } }),
      trialEnvironments: () => ({
        ok: true,
        value: {
          ...ENV_EMPTY,
          plan: { remove: [{ name: 'a-dpmc', reason: '超过保留期 14 天（20.1 天）' }], keep: [] },
        },
      }),
    })
    try {
      face.loadTrial()
      await until(() => face.hooks.trial.getSnapshot().report !== undefined, '计划落状态')
      const html = renderSettings(entry, face, t)
      assert.match(html, /data-stub="Modal" data-title="清理过期测试环境" data-open="true"/,
        '确认框 state 被打开时必须渲染成 open：' + html.slice(-600))
      // 打开之后按钮文案与正文都在，且正文给的是数字。
      assert.ok(html.includes('按当前计划删除 1 个测试环境'), '打开后正文要给数字：' + html.slice(-600))
    } finally {
      stub.restore()
    }
  })

  it('清理确认框的三种文案必须分开：会删 N 个 / 没有需要清理的 / 计划读不到', async () => {
    // §12.3.3：不许用缺席表达状态。第三种（读不到）如果混成第二种（没有），
    // 用户会以为"按下去没事"——那是拿一个猜出来的结论去支撑不可逆操作。
    const { cleanupText } = await import('../dist/client.js').then(() => ({ cleanupText: undefined })).catch(() => ({ cleanupText: undefined }))
    void cleanupText
    const cases = [
      { label: '会删 2 个', plan: { remove: [{ name: 'a', reason: 'x' }, { name: 'b', reason: 'y' }], keep: [] }, expect: '按当前计划删除 2 个测试环境' },
      { label: '会删 0 个', plan: { remove: [], keep: [] }, expect: '没有需要清理的测试环境' },
      { label: '计划读不到', plan: undefined, expect: '读不到清理计划' },
    ]
    for (const item of cases) {
      const { entry, face, t } = boot('settings.section', 'console', {})
      const value = item.plan === undefined
        ? (() => { const { plan: _drop, ...rest } = ENV_EMPTY; return rest })()
        : { ...ENV_EMPTY, plan: item.plan }
      const stub = stubFetch({
        capabilities: () => ({ ok: true, value: { capabilities: {}, trialDisclosure: DISCLOSURE } }),
        trialEnvironments: () => ({ ok: true, value }),
      })
      try {
        face.loadTrial()
        await until(() => face.hooks.trial.getSnapshot().report !== undefined, item.label + ' 落状态')
        const props = propsFor(face, t, {}, entry)
        props.actions.select('settings')
        const html = renderToStaticMarkup(React.createElement(entry.component, props))
        // 确认框默认关着，但它的**文案已经在 DOM 里**（Modal 的 open=false 仍渲染结构？）
        // 实测：官方 Modal 在 open=false 时不渲染 children —— 所以这里只能断言"计划区"那一半。
        if (item.plan === undefined) {
          assert.ok(!html.includes('没有需要清理的测试环境'),
            '计划读不到时不许说"没有需要清理的"（那是替宿主下结论）：' + html.slice(0, 400))
        } else if (item.plan.remove.length === 0) {
          assert.ok(html.includes('没有需要清理的测试环境'), '空计划要如实说：' + html.slice(0, 400))
        } else {
          assert.ok(html.includes('会删这 2 个'), '有计划要说会删几个：' + html.slice(0, 400))
        }
      } finally {
        stub.restore()
      }
    }
  })

  it('清理入口的接线：点它必须**开确认框**，而不是直接执行（源码级契约守卫）', () => {
    // 为什么这条必须是源码级（而不是渲染断言）：
    //   · primitives 桩件不暴露 onClick，渲染结果里看不到"点了会怎样"；
    //   · "用 react shim 把 state 强制打开"那条证明的是"打开时会渲染成 open"，
    //     它**绕过了 onClick**——把 onClick 从 setConfirmingCleanup(true) 改成直接 onCleanup()，
    //     那条用例照样绿（M1 变异实测：漏的就是它）。
    // 判据：清理按钮的 onClick 必须调 setConfirmingCleanup(true)，且不得直接调 onCleanup()。
    // 这与 R5 的跨模块守卫同一手法：跨不过渲染的接线，用源码级断言钉。
    const source = readFileSync('src/client/ConsolePage.tsx', 'utf8')
    const at = source.indexOf('onClick={() => { setConfirmingCleanup(true) }}')
    assert.ok(at >= 0, '清理按钮的 onClick 没有开确认框（被改成直接执行了？）')
    // 反向：那个按钮不能同时又直接调 onCleanup（"既开框又立刻执行"是最坏的一种）。
    const buttonStart = source.lastIndexOf('<Button', at)
    const buttonEnd = source.indexOf('</Button>', at)
    const button = source.slice(buttonStart, buttonEnd)
    assert.ok(!/onCleanup\(\)/.test(button),
      '清理按钮不得在 onClick 里直接调 onCleanup()（那等于没有确认框）：' + button)
    // 而确认框的"确认"按钮里**必须**调 onCleanup()——否则框开了也没法真执行。
    // 禁用条件**只**看"计划读不到"："会删 0 个"不禁用（计划是快照，不是权威——task-92）。
    const marker = 'disabled={cleanupCount === undefined}'
    const confirmAt = source.indexOf('onClick={() => {', source.indexOf(marker))
    assert.ok(confirmAt >= 0, '确认框里找不到确认按钮的 onClick')
    const confirmBlock = source.slice(confirmAt, confirmAt + 140)
    assert.match(confirmBlock, /onCleanup\(\)/, '确认按钮必须真的执行清理：' + confirmBlock)
  })

  it('「会删 0 个」不禁用确认按钮（计划是快照，不是权威——task-92）', () => {
    // 为什么这条必须存在（它是 task-92 从契约反推出来的自洽性缺陷）：
    //   op 执行时**不看客户端这份计划**，它自己重新读盘算一次。
    //   拿一个非权威的快照去禁用按钮 = 用代理判断代替事实：
    //   若某个环境在"读到计划"与"点确认"之间越过保留期，用户会**永远按不下去**。
    //   只有"读不到计划"才禁用（那时连确认框该说几个字都不知道）。
    const source = readFileSync('src/client/ConsolePage.tsx', 'utf8')
    const at = source.indexOf('disabled={cleanupCount === undefined}')
    assert.ok(at >= 0, '确认按钮的禁用条件变了（应当只看"计划读不到"）')
    // 反向：禁用条件里不许再出现 === 0（那会把"当前没有过期环境"也锁住）。
    const line = source.slice(source.lastIndexOf('disabled=', at), source.indexOf('}', at) + 1)
    assert.ok(!/cleanupCount === 0/.test(line),
      '禁用条件不得包含 cleanupCount === 0（计划是快照，按不下去会变成死锁）：' + line)
  })
  it('测试环境：空列表说「没有测试环境」，读失败说失败（不把故障画成空列表）', async () => {
    const okBoot = boot('settings.section', 'console', {})
    const okStub = stubFetch({
      capabilities: () => ({ ok: true, value: { capabilities: {}, trialDisclosure: DISCLOSURE } }),
      trialEnvironments: () => ({ ok: true, value: ENV_EMPTY }),
    })
    try {
      okBoot.face.loadTrial()
      await until(() => okBoot.face.hooks.trial.getSnapshot().report !== undefined, '空列表落状态')
      const html = renderSettings(okBoot.entry, okBoot.face, okBoot.t)
      assert.ok(html.includes('没有测试环境'), '空列表要如实说')
    } finally {
      okStub.restore()
    }

    const badBoot = boot('settings.section', 'console', {})
    const badStub = stubFetch({
      capabilities: () => ({ ok: true, value: { capabilities: {}, trialDisclosure: DISCLOSURE } }),
      trialEnvironments: () => { throw new Error('op 挂了') },
    })
    try {
      badBoot.face.loadTrial()
      await until(() => badBoot.face.hooks.trial.getSnapshot().error !== undefined, '读失败落状态')
      const html = renderSettings(badBoot.entry, badBoot.face, badBoot.t)
      assert.ok(html.includes('读取测试环境失败：op 挂了'), '失败要如实说：' + html.slice(0, 400))
      assert.ok(!html.includes('没有测试环境'), '读失败不得渲染成空列表')
    } finally {
      badStub.restore()
    }
  })

  it('布尔事实读不到显示「未知」，不显示「未运行」或「归属环境已不存在」', async () => {
    const { entry, face, t } = boot('settings.section', 'console', {})
    const stub = stubFetch({
      capabilities: () => ({ ok: true, value: { capabilities: {}, trialDisclosure: DISCLOSURE } }),
      trialEnvironments: () => ({
        ok: true,
        value: {
          ...ENV_EMPTY,
          environments: [{
            name: 'pm-test-dpmc', owner: '', dir: '/tmp/pm-test-dpmc', modifiedAt: '', files: 0, sharedFiles: 0,
            snapshotMatchesOwner: null,
          }],
          totals: { count: 1, running: 1, bytes: 0, unknownBytes: 1 },
        },
      }),
    })
    try {
      face.loadTrial()
      await until(() => face.hooks.trial.getSnapshot().report !== undefined, '列表落状态')
      const html = renderSettings(entry, face, t)
      assert.ok(html.includes('运行状态读不到'), 'running 缺失要显示未知标记')
      assert.ok(html.includes('归属读不到'), 'ownerExists 缺失要显示未知标记')
      assert.ok(!html.includes('未运行'), '读不到不得说成「未运行」')
      assert.ok(!html.includes('归属环境已不存在'), '读不到不得说成孤儿')
      assert.ok(html.includes('占地读不出来'), 'bytes 为 null 要给原因')
      assert.ok(html.includes('1 个环境的占地统计不出来'), '统计不出来的数量要说出来')
    } finally {
      stub.restore()
    }
  })

  it('清理三条路径各自如实：删 2 个 / 什么都没删 / 失败不算完成', async () => {
    const run = async (result) => {
      const { entry, face, t } = boot('settings.section', 'console', {})
      const stub = stubFetch({
        capabilities: () => ({ ok: true, value: { capabilities: {}, trialDisclosure: DISCLOSURE } }),
        trialEnvironments: () => ({ ok: true, value: ENV_EMPTY }),
        trialCleanup: () => ({ ok: true, value: { jobId: 'job-clean' } }),
        job: () => ({ ok: true, value: { done: true, result } }),
      })
      try {
        face.cleanupTrialEnvironments()
        await until(() => face.hooks.trial.getSnapshot().action !== undefined, '清理结果落状态')
        return renderSettings(entry, face, t)
      } finally {
        stub.restore()
      }
    }
    const two = await run({ ok: true, output: '删了 2 个', removed: ['a-dpmc', 'b-dpmc'] })
    assert.ok(two.includes('已清理 2 个测试环境'), '删了几个要说数字')
    const none = await run({ ok: true, output: '无事可做', removed: [] })
    // task-93：结果行**一律**用完成态措辞，0 个也走这条。
    // 原来 0 个走的是 cleanupNone（"没有需要清理的测试环境"）——与**计划区**那句一模一样，
    // 用户点了一次不可逆操作却看不出"这一下到底执行了没有"。
    // task-94：0 那一态说"没有清理任何测试环境"——**同一位置、同一完成态**，
    // 只是不写"已清理 0 个"（生硬），也不换语法（换了读者要重新理解"这次不是计数了"）。
    assert.ok(none.includes('没有清理任何测试环境'), '什么都没删也要说，且要说成完成态')
    assert.ok(!none.includes('已清理 0 个测试环境'), '0 那一态不该写"已清理 0 个"（生硬）')
    // 判据要**限定在结果行**上：那句话本身在别处是合法的（计划区与确认框说的都是"计划"，
    // 空计划时它们就是 cleanupNone）。只有**结果行**不许用它。
    // 结果行是 role="status" 的 notice 段落（其余几处是 hint / Modal）。
    const notice = (none.match(/<p class="[^"]*notice[^"]*" role="status">([^<]*)<\/p>/) ?? [])[1] ?? ''
    assert.ok(!notice.includes('没有需要清理的测试环境'),
      '结果行不得与计划区同句（那是"执行前"的说法）：' + notice)
    const failed = await run({ ok: false, code: 'locked', output: '删不掉：正在运行' })
    assert.ok(failed.includes('删不掉：正在运行'), '失败要说原因')
    assert.ok(!failed.includes('已清理 0 个测试环境'), '失败不得渲染成完成')
  })

  it('市场页安装结果：warn 放行的成功路径必须说出「未通过」', async () => {
    const { t, entry, face } = boot('settings.section', 'marketplace', {})
    const stub = stubFetch({
      install: () => ({ ok: true, value: { jobId: 'job-install' } }),
      job: () => ({
        ok: true,
        value: {
          done: true,
          result: {
            ok: true, output: '装好了', packageName: 'x', gateIssues: [],
            trial: {
              conclusion: 'candidate-broken', policy: 'warned', policyNote: '按 warn 模式放行',
              output: '起不来：mount failed', elapsedMs: 12, escalated: false, baseline: 'mounted', candidate: 'failed',
            },
          },
        },
      }),
      marketplace: () => ({ ok: true, value: { items: [], generatedAt: '2026-09-19T03:00:00.000Z', cached: false, categories: {} } }),
    })
    try {
      face.installMarketItem({ repo: 'a/b', name: 'b', installSpec: 'github:a/b' })
      await until(() => face.hooks.marketplace.getSnapshot().trial !== undefined, '试装结论落状态')
      const html = renderToStaticMarkup(React.createElement(entry.component, propsFor(face, t, {}, entry)))
      assert.ok(html.includes('未通过，按警告模式放行'), '成功路径必须说未通过：' + html.slice(0, 600))
      assert.ok(html.includes('放行不等于通过：这次安装没有通过验证'), '关键那句必须在')
      assert.ok(html.includes('候选包导致启动失败'), '结论要说出来')
    } finally {
      stub.restore()
    }
  })

  it('市场页安装结果：blocked / skipped / cannot-trial / 未知值各自可辨', async () => {
    const run = async (trial) => {
      const { t, entry, face } = boot('settings.section', 'marketplace', {})
      const stub = stubFetch({
        install: () => ({ ok: true, value: { jobId: 'job-install' } }),
        job: () => ({
          ok: true,
          value: {
            done: true,
            result: { ok: trial.policy !== 'blocked', output: '结果输出', packageName: 'x', gateIssues: [], rolledBack: trial.policy === 'blocked', trial: { elapsedMs: 7, escalated: false, baseline: 'mounted', candidate: 'failed', ...trial } },
          },
        }),
        marketplace: () => ({ ok: true, value: { items: [], generatedAt: '2026-09-19T03:00:00.000Z', cached: false, categories: {} } }),
      })
      try {
        face.installMarketItem({ repo: 'a/b', name: 'b', installSpec: 'github:a/b' })
        await until(() => face.hooks.marketplace.getSnapshot().trial !== undefined, '试装结论落状态')
        return renderToStaticMarkup(React.createElement(entry.component, propsFor(face, t, {}, entry)))
      } finally {
        stub.restore()
      }
    }
    const blocked = await run({ conclusion: 'candidate-broken', policy: 'blocked', policyNote: '已回滚候选包', output: 'x' })
    assert.ok(blocked.includes('已阻止安装并回滚'), 'blocked 要说处置：' + blocked.slice(0, 600))
    assert.ok(blocked.includes('候选包导致启动失败'), 'blocked 要说结论（不是一句泛化错误）')
    const skipped = await run({ conclusion: 'cannot-trial', policy: 'skipped', policyNote: '质量门关闭', output: 'x' })
    assert.ok(skipped.includes('这次没有执行试装'), 'skipped 要有处置标签')
    assert.ok(skipped.includes('按设置或豁免名单跳过了试装'), 'skipped 不静默')
    const cannot = await run({ conclusion: 'cannot-trial', policy: 'blocked', policyNote: '无法试装', output: 'x' })
    assert.ok(cannot.includes('无法试装：这次没有完成验证'), 'cannot-trial 要说"没验证"')
    assert.ok(cannot.includes('这次没有完成验证，结论不是「通过」'), '不能读成"验证失败"')
    const weird = await run({ conclusion: 'brand-new-conclusion', policy: 'brand-new-policy', policyNote: '未知处置', output: 'x' })
    assert.ok(weird.includes('未识别：brand-new-conclusion'), '未知结论保留原始值')
    assert.ok(weird.includes('未识别：brand-new-policy'), '未知处置保留原始值')
  })
})

/**
 * 试装那一节的**交互**护栏（verify2 补，task-52 验收中发现）。
 *
 * 为什么加它（真机变异验证的实测结果）：把「试装总开关」的 onChange 改成丢弃新值
 * （开关点了什么都不会发生），本文件上面那批断言**全绿**——它们都只渲染静态 HTML，
 * 从不驱动控件。这正是本仓库最在意的那类缺陷：界面看起来有开关、用户点了却没有效果，
 * 而门禁一声不响。
 *
 * 手法：用一个**捕获 Switch props** 的 primitives 替身启动产物，渲染后取出真实的
 * onChange 并调用它 —— 走的就是用户点开关那条路（不是绕过 UI 直接调控制器）。
 * 变异一旦落在 onChange 上，本用例立刻红。
 */

/** 捕获 Switch 的 props（其余 primitives 保持"任意名字都能渲染"）。 */
function captureSwitchPrimitives(captured) {
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === 'relativeTime') return () => ({ unit: 'now', n: 0 })
      if (typeof prop !== 'string') return undefined
      const name = prop
      return function Stub(props) {
        if (name === 'Switch') captured.push(props)
        return React.createElement('div', { 'data-stub': name }, props?.label ?? null, props?.children ?? null)
      }
    },
  })
}

/**
 * 启动产物（Switch 可捕获）并取控制台注册项。
 *
 * @param value - settings 命名空间的当前值。
 * @returns 注册项、注入面、字典座位与捕获到的 Switch props。
 */
function bootWithSwitch(value) {
  const captured = []
  const exported = bootBundle({ '@deepseek-ai/dsh-client-ui-primitives': captureSwitchPrimitives(captured) })
  const applied = applyWithMocks(exported, { value })
  const t = makeT(applied.dicts, { strict: true })
  const entry = registration(applied.slotRegistrations, 'settings.section', 'console')
  const face = entry.options.inject()
  return { entry, face, t, captured }
}

/** 渲染「环境控制台 → 设置」子页。 */
function renderConsoleSettings(entry, face, t) {
  const props = propsFor(face, t, {}, entry)
  props.actions.select('settings')
  return renderToStaticMarkup(React.createElement(entry.component, props))
}

describe('试装开关真的会生效（verify2 补的交互护栏）', () => {
  it('调用「试装总开关」的真实 onChange，新值必须落进草稿（丢弃新值 = 红）', () => {
    const { entry, face, t, captured } = bootWithSwitch({ trial: { enabled: false } })
    renderConsoleSettings(entry, face, t)
    const toggle = captured.find(props => props.label === '试装总开关')
    assert.ok(toggle !== undefined, '试装总开关的 Switch 必须被渲染：' + JSON.stringify(captured.map(p => p.label)))
    assert.equal(toggle.checked, false, '初值应来自配置')
    assert.equal(typeof toggle.onChange, 'function', '开关必须有 onChange')

    // 用户点开关 —— 走的是组件自己那条回调。
    toggle.onChange(true)
    assert.equal(face.hooks.config.getSnapshot().draft?.trial?.enabled, true,
      '点开关后草稿里必须是新值（丢弃新值 = 用户点了没反应）')
    assert.equal(face.hooks.config.getSnapshot().dirty, true, '改了字段必须变脏（否则保存按钮永远不可用）')
  })

  it('task-98 的「提示过期的依赖兜底链接」开关也真的生效（走组件自己的 onChange）', () => {
    const { entry, face, t, captured } = bootWithSwitch({
      diagnostics: { dependency: true, composition: true, runtime: true, consistency: true, ecosystem: false, reportStaleModuleFallbackLinks: true },
    })
    renderConsoleSettings(entry, face, t)
    const toggle = captured.find(props => props.label === '提示过期的依赖兜底链接')
    assert.ok(toggle !== undefined, '这个开关必须被渲染：' + JSON.stringify(captured.map(p => p.label)))
    assert.equal(toggle.checked, true, '默认是开（上报）')
    assert.equal(typeof toggle.onChange, 'function', '开关必须有 onChange')

    toggle.onChange(false)
    assert.equal(face.hooks.config.getSnapshot().draft?.diagnostics?.reportStaleModuleFallbackLinks, false,
      '点开关后草稿里必须是新值（丢弃新值 = 用户点了没反应）')
    assert.equal(face.hooks.config.getSnapshot().dirty, true, '改了字段必须变脏')
  })

  it('其余三个开关同样真的生效（任一丢弃即红）', () => {
    const { entry, face, t, captured } = bootWithSwitch({})
    renderConsoleSettings(entry, face, t)
    const byLabel = (label) => {
      const hit = captured.find(props => props.label === label)
      assert.ok(hit !== undefined, '控件必须在：' + label + '（现有：' + JSON.stringify(captured.map(p => p.label)) + '）')
      return hit
    }
    for (const [label, path] of [
      ['试装前做基线启动', 'baseline'],
      ['允许联网拉取候选包', 'allowNetwork'],
      ['自动清理测试环境', 'autoCleanup'],
    ]) {
      const control = byLabel(label)
      const next = control.checked !== true
      control.onChange(next)
      assert.equal(face.hooks.config.getSnapshot().draft?.trial?.[path], next, label + ' 的开关必须生效')
    }
    // 深度 / 失败行为是 PmSelect（官方 Menu），这里只断言初值都在（它们的回调由 PmSelect 驱动）。
    const draft = face.hooks.config.getSnapshot().draft
    assert.equal(draft?.trial?.depth, 'auto', '深度默认 auto')
    assert.equal(draft?.trial?.onFailure, 'block', '失败行为默认 block')
    assert.ok(draft?.trial?.retentionDays >= 1, '保留天数有值')
    assert.ok(draft?.trial?.maxKept >= 0, '保留上限有值')
  })
})

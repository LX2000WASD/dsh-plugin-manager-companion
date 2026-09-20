/**
 * 客户端渲染健壮性测试（node --test，跑 dist/client.js + React SSR）。
 *
 * 守护的是一类实测过的失败：**外部载荷缺字段时整页空白**。真实事故：host 的
 * JobRegistry.start() 返回裸 job id 字符串，客户端把字符串当报告，HealthPanel 在
 * `report.counts[layer]` 上抛 TypeError，官方 SlotErrorBoundary 把整个 settings.section
 * 渲染成一个空 div —— 用户点开「环境控制台」看到的就是一片空白，且没有任何可读线索。
 *
 * 所以这里断言的不是"渲染出对的像素"，而是三件更硬的事：
 *   1. 残缺载荷（缺顶层对象 / 缺字段 / 类型不对）不能让任何一页抛异常；
 *   2. 每种状态都要渲染出**可读文本**（绝不允许空 div）；
 *   3. 长操作两种 job 形状（`{ jobId }` 信封与裸 id 字符串）都必须真的去轮询 job op。
 *
 * 为什么用 SSR 而不是 jsdom：本仓库没有 jsdom 依赖，而这一层要验的正是"渲染路径不炸 + 有文本"；
 * 交互（点击、菜单开合）由 CDP 真浏览器验收负责（tools/cdp-shot.mjs），不在本文件里重复。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  React, applyWithMocks, bootBundle, makeT, propsFor, registration, render, renderSafely, stubFetch, until,
} from './client-harness.mjs'

/** 一份形状正确的诊断报告（作为"正常路径"的对照）。 */
const REPORT = {
  environment: 'pm-test',
  generatedAt: '2026-09-19T03:00:00.000Z',
  counts: { dependency: 0, composition: 0, runtime: 0, consistency: 0, ecosystem: 0 },
  issues: [],
  skipped: [],
}

describe('客户端渲染健壮性（残缺载荷不许变成空白页）', () => {
  it('配置值残缺（空对象）时设置面板照常渲染，并如实标注"缺失项按默认值"', () => {
    const exported = bootBundle()
    const { slotRegistrations, dicts } = applyWithMocks(exported, { value: {}, status: 'ready' })
    const reg = registration(slotRegistrations, 'plugins.bundle.config')
    const face = reg.options.inject()
    const { html, error } = renderSafely(reg.component, propsFor(face, makeT(dicts), { view: 'page' }))

    assert.equal(error, undefined, '残缺配置不该让渲染抛异常：' + String(error))
    assert.ok(html.includes('质量门（安装前扫描）'), '缺字段的配置必须仍然渲染出表单：' + html.slice(0, 300))
    assert.ok(html.includes('诊断分层'), '默认值补出来的分区要出现')
    assert.ok(html.includes('宿主只提供了部分配置字段'), '补默认值这件事必须如实告诉用户')
    assert.ok(!html.includes('config.'), '不得把字典键渲染到界面上')
  })

  it('配置值完整时不显示"缺失项"提示（提示只在真的缺字段时出现）', () => {
    const exported = bootBundle()
    const { slotRegistrations, dicts } = applyWithMocks(exported, {
      status: 'ready',
      value: {
        diagnostics: {
          dependency: true, composition: true, runtime: true, consistency: true, ecosystem: false,
          reportStaleModuleFallbackLinks: true,
        },
        qualityGate: { enabled: true, mode: 'block', allowlist: [] },
        marketplace: { enabled: true, cacheTtlMinutes: 1440, timeoutMs: 15_000, indexUrl: '' },
        // 完整文档必须带 trial 段：宿主 schema 里它与其它三组同构地带默认值，
        // 官方 settings 解析过的配置一定有它；缺了它就是宿主只发了部分载荷（task-52）。
        trial: {
          enabled: false, depth: 'auto', baseline: true, allowNetwork: true,
          onFailure: 'block', autoCleanup: true, retentionDays: 14, maxKept: 0,
        },
      },
    })
    const reg = registration(slotRegistrations, 'plugins.bundle.config')
    const { html, error } = renderSafely(reg.component,
      propsFor(reg.options.inject(), makeT(dicts), { view: 'page' }))
    assert.equal(error, undefined)
    assert.ok(html.includes('质量门（安装前扫描）'))
    assert.ok(!html.includes('宿主只提供了部分配置字段'), '完整配置不该被标成残缺：' + html.slice(0, 200))
  })

  it('配置值连对象都不是时显示"正在读取配置"，而不是空白', () => {
    const exported = bootBundle()
    const { slotRegistrations, dicts } = applyWithMocks(exported, { value: 'nonsense', status: 'ready' })
    const reg = registration(slotRegistrations, 'plugins.bundle.config')
    const { html, error } = renderSafely(reg.component,
      propsFor(reg.options.inject(), makeT(dicts), { view: 'page' }))

    assert.equal(error, undefined)
    assert.ok(html.includes('设置'), '标题必须在')
    assert.ok(html.includes('正在读取配置…'), '要给出可读的状态文案：' + html)
  })

  it('宿主没有该命名空间 / 尚在加载：各自给出可读文案', () => {
    const t = (exportedValue, status, expected) => {
      const exported = bootBundle()
      const { slotRegistrations, dicts } = applyWithMocks(exported, { value: exportedValue, status })
      const reg = registration(slotRegistrations, 'plugins.bundle.config')
      const { html, error } = renderSafely(reg.component,
        propsFor(reg.options.inject(), makeT(dicts), { view: 'page' }))
      assert.equal(error, undefined)
      assert.ok(html.includes(expected), status + ' 要给出可读文案：' + html.slice(0, 200))
    }
    t(undefined, 'unavailable', '当前宿主没有提供本插件的设置命名空间')
    t(undefined, 'loading', '正在读取配置…')
  })

  it('裸 job id 字符串（旧 host 行为）也必须真的去轮询 job op', async () => {
    const exported = bootBundle()
    const { slotRegistrations, dicts } = applyWithMocks(exported, { value: undefined, status: 'unavailable' })
    const face = registration(slotRegistrations, 'settings.section', 'console').options.inject()
    const { calls, restore } = stubFetch({
      diagnose: () => ({ ok: true, value: 'job-1' }),
      job: () => ({ ok: true, value: { done: true, result: REPORT } }),
      capabilities: () => ({ ok: true, value: { capabilities: { missing: [] } } }),
    })
    try {
      face.diagnose()
      const report = await until(() => face.hooks.health.getSnapshot().report, '报告落到状态里')
      assert.deepEqual(calls.slice(0, 2), ['diagnose', 'job'], '认不出裸 id 就不会轮询（这是空白页的根因）')
      assert.equal(report.environment, 'pm-test')
      assert.deepEqual(report.counts, REPORT.counts)
    } finally { restore() }
  })

  it('{ jobId } 信封形状（契约形状）同样轮询', async () => {
    const exported = bootBundle()
    const { slotRegistrations } = applyWithMocks(exported)
    const face = registration(slotRegistrations, 'settings.section', 'console').options.inject()
    const { calls, restore } = stubFetch({
      diagnose: () => ({ ok: true, value: { jobId: 'job-2' } }),
      job: () => ({ ok: true, value: { done: true, result: REPORT } }),
      capabilities: () => ({ ok: true, value: {} }),
    })
    try {
      face.diagnose()
      await until(() => face.hooks.health.getSnapshot().report, '报告落到状态里')
      assert.deepEqual(calls.slice(0, 2), ['diagnose', 'job'])
    } finally { restore() }
  })

  it('报告缺 counts/issues/skipped：归一成空值后照常渲染，不抛异常', async () => {
    const exported = bootBundle()
    const { slotRegistrations, dicts } = applyWithMocks(exported)
    const face = registration(slotRegistrations, 'settings.section', 'console').options.inject()
    const { restore } = stubFetch({
      diagnose: () => ({ ok: true, value: { jobId: 'job-3' } }),
      job: () => ({ ok: true, value: { done: true, result: { environment: 'pm-test' } } }),
      capabilities: () => ({ ok: true, value: {} }),
    })
    try {
      face.diagnose()
      const report = await until(() => face.hooks.health.getSnapshot().report, '报告落到状态里')
      assert.deepEqual(report.counts, REPORT.counts, '缺 counts 时按各层 0 计，界面网格不能出现 undefined')
      assert.deepEqual(report.issues, [])
      assert.deepEqual(report.skipped, [])
      const reg = registration(slotRegistrations, 'settings.section', 'console')
      const { html, error } = renderSafely(reg.component, propsFor(face, makeT(dicts)))
      assert.equal(error, undefined, '缺字段的报告不该让体检页抛异常：' + String(error))
      assert.ok(html.includes('被诊断环境：pm-test'), '报告已经能看到：' + html.slice(0, 300))
      assert.ok(html.includes('未发现任何问题'), '空报告要落到空态文案')
    } finally { restore() }
  })

  it('载荷完全不可用（不是对象）：如实报失败，页面仍然可读', async () => {
    const exported = bootBundle()
    const { slotRegistrations, dicts } = applyWithMocks(exported)
    const face = registration(slotRegistrations, 'settings.section', 'console').options.inject()
    const { restore } = stubFetch({
      diagnose: () => ({ ok: true, value: { jobId: 'job-4' } }),
      job: () => ({ ok: true, value: { done: true, result: 'nope' } }),
    })
    try {
      face.diagnose()
      await until(() => face.hooks.health.getSnapshot().errorKey, '失败落到状态里')
      assert.equal(face.hooks.health.getSnapshot().errorKey, 'error.incompletePayload')
      const reg = registration(slotRegistrations, 'settings.section', 'console')
      const { html, error } = renderSafely(reg.component, propsFor(face, makeT(dicts)))
      assert.equal(error, undefined)
      assert.ok(html.includes('宿主返回的数据不完整'), '失败原因必须可读：' + html.slice(0, 300))
    } finally { restore() }
  })

  it('市场页：索引载荷残缺时渲染空态，类型不对时报可读失败', async () => {
    const exported = bootBundle()
    const { slotRegistrations, dicts } = applyWithMocks(exported)
    const reg = registration(slotRegistrations, 'settings.section', 'marketplace')
    const face = reg.options.inject()
    const t = makeT(dicts)

    const empty = stubFetch({ marketplace: () => ({ ok: true, value: {} }) })
    try {
      face.loadMarketplace(false)
      await until(() => face.hooks.marketplace.getSnapshot().result, '市场结果落到状态里')
      const { html, error } = renderSafely(reg.component, propsFor(face, t))
      assert.equal(error, undefined, '残缺索引不该让市场页抛异常')
      assert.ok(html.includes('插件市场') && html.includes('没有匹配的条目'), html.slice(0, 300))
    } finally { empty.restore() }

    const bad = stubFetch({ marketplace: () => ({ ok: true, value: 'nonsense' }) })
    try {
      face.loadMarketplace(false)
      await until(() => face.hooks.marketplace.getSnapshot().errorKey, '市场失败落到状态里')
      const { html, error } = renderSafely(reg.component, propsFor(face, t))
      assert.equal(error, undefined)
      assert.ok(html.includes('宿主返回的数据不完整'), html.slice(0, 300))
    } finally { bad.restore() }
  })

  it('市场页首屏只渲染一批（有上限），并给出"已显示 N / 共 M"与加载入口', async () => {
    const exported = bootBundle()
    const { slotRegistrations, dicts } = applyWithMocks(exported)
    const reg = registration(slotRegistrations, 'settings.section', 'marketplace')
    const face = reg.options.inject()
    const items = Array.from({ length: 500 }, (_, index) => ({
      repo: 'owner/repo-' + String(index),
      name: 'item-' + String(index),
      description: 'desc',
      stars: null,
      updatedAt: null,
      topics: [],
    }))
    const stub = stubFetch({
      marketplace: () => ({ ok: true, value: { items, generatedAt: '2026-09-19T03:00:00.000Z', cached: false, categories: {} } }),
    })
    try {
      face.loadMarketplace(false)
      await until(() => face.hooks.marketplace.getSnapshot().result, '索引落到状态里')
      const { html, error } = renderSafely(reg.component, propsFor(face, makeT(dicts)))
      assert.equal(error, undefined)
      // 卡片数按 <li> 数：排序是契约里的，断言渲染**数量**而不是具体哪几张
      // （不能数 repo 字符串——每张卡片还带一个指向 GitHub 的链接，会翻倍）。
      const rendered = (html.match(/<li/g) ?? []).length
      assert.equal(rendered, 120, '首屏必须只渲染一批（RENDER_BATCH=120）：' + String(rendered))
      assert.ok(html.includes('已显示 120 / 共 500 条'), '要说清已加载多少 / 共多少：' + html.slice(-400))
      assert.ok(html.includes('加载更多'), '要有继续加载的入口')
      assert.ok(!html.includes('已达单页渲染上限'))
    } finally { stub.restore() }
  })

  it('配置面板渲染完整 marketplace 字段（含 timeoutMs 与 indexUrl）', () => {
    const exported = bootBundle()
    const { slotRegistrations, dicts } = applyWithMocks(exported, {
      status: 'ready',
      value: {
        diagnostics: {
          dependency: true, composition: true, runtime: true, consistency: true, ecosystem: false,
          reportStaleModuleFallbackLinks: true,
        },
        qualityGate: { enabled: true, mode: 'block', allowlist: [] },
        marketplace: { enabled: true, cacheTtlMinutes: 1440, timeoutMs: 20_000, indexUrl: 'https://example.test/index.json' },
      },
    })
    const reg = registration(slotRegistrations, 'plugins.bundle.config')
    const { html, error } = renderSafely(reg.component,
      propsFor(reg.options.inject(), makeT(dicts), { view: 'page' }))
    assert.equal(error, undefined)
    assert.ok(html.includes('网络请求超时（毫秒）') && html.includes('20000'), 'timeoutMs 要有控件与当前值：' + html.slice(0, 400))
    assert.ok(html.includes('自定义索引源') && html.includes('https://example.test/index.json'), 'indexUrl 要有控件与当前值')
  })

  it('技能与预设页：记录缺字段时照常渲染（缺的字段给空值，不猜）', async () => {
    const exported = bootBundle()
    const { slotRegistrations, dicts } = applyWithMocks(exported)
    const reg = registration(slotRegistrations, 'settings.section', 'kinds')
    const face = reg.options.inject()
    const stub = stubFetch({
      listKinds: () => ({ ok: true, value: { records: [{ repo: 'a/b' }, 'junk', { repo: '' }] } }),
    })
    try {
      face.loadKinds()
      const state = await until(() => {
        const snapshot = face.hooks.kinds.getSnapshot()
        return snapshot.records.length > 0 && !snapshot.loading ? snapshot : undefined
      }, '技能列表落到状态里')
      assert.equal(state.records.length, 1, '只有带 repo 的记录能渲染，其余丢弃')
      assert.deepEqual(state.records[0], { kind: 'unknown', repo: 'a/b', dir: '', installedAt: '' })
      assert.deepEqual(state.orphans, [])
      const { html, error } = renderSafely(reg.component, propsFor(face, makeT(dicts)))
      assert.equal(error, undefined)
      assert.ok(html.includes('a/b') && html.includes('技能与预设'), html.slice(0, 300))
      assert.ok(!html.includes('undefined'), '缺字段要归一成空值，不能渲染出 undefined')
    } finally { stub.restore() }
  })

  it('噪声报告（173 条 → 4 组）：groups 与 issue.scope 透传，界面按组折叠', async () => {
    // 构造与 engine-dev 实测同形的载荷：163 条同类命中 + 3 个小组 + 1 条无处归属。
    const noisyIssues = []
    for (let i = 0; i < 163; i += 1) {
      noisyIssues.push({
        id: 'declared-not-loaded:' + String(i), layer: 'consistency', severity: 'report-only',
        code: 'declared-not-loaded', title: 'bundle 声明了却没被加载',
        detail: 'profile 声明了该包，loader 树里没有对应行', subjects: ['sdk-pkg'],
        evidence: [{ kind: 'official', at: 'loader entry ' + String(i), note: '树里没有这一行' }],
        scope: 'sdk-pkg',
      })
    }
    const groups = [
      { key: 'consistency:declared-not-loaded:report-only:sdk-pkg', layer: 'consistency', code: 'declared-not-loaded', severity: 'report-only', count: 163, scopes: [{ scope: 'sdk-pkg', count: 163 }], subjects: ['sdk-pkg'], exampleTitle: 'bundle 声明了却没被加载' },
      { key: 'dependency:missing-import:confirm-fix:web-ui-kit', layer: 'dependency', code: 'missing-import', severity: 'confirm-fix', count: 3, scopes: [{ scope: 'web-ui-kit', count: 3 }], subjects: ['web-ui-kit'], exampleTitle: '导入了未声明的依赖' },
      { key: 'runtime:phase-stuck:safe-fix:runtime', layer: 'runtime', code: 'phase-stuck', severity: 'safe-fix', count: 3, scopes: [{ scope: 'runtime', count: 3 }], subjects: ['runtime'], exampleTitle: 'fiber 相位异常' },
      { key: 'composition:duplicate-row:safe-fix:base', layer: 'composition', code: 'duplicate-row', severity: 'safe-fix', count: 3, scopes: [{ scope: 'base', count: 3 }], subjects: ['base'], exampleTitle: '行 id 重复' },
    ]
    for (const [index, group] of groups.slice(1).entries()) {
      for (let i = 0; i < group.count; i += 1) {
        noisyIssues.push({
          id: group.code + ':' + String(i), layer: group.layer, severity: group.severity, code: group.code,
          title: group.exampleTitle, detail: '同类命中', subjects: [...group.subjects],
          evidence: [{ kind: 'file', at: 'pkg.json:' + String(index), note: '证据' }], scope: group.scopes[0].scope,
        })
      }
    }
    noisyIssues.push({
      id: 'odd:1', layer: 'ecosystem', severity: 'report-only', code: 'odd-one', title: '未归组的发现',
      detail: '不属于任何组', subjects: [], evidence: [], 
    })
    const report = { ...REPORT, issues: noisyIssues, groups }

    const exported = bootBundle()
    const { slotRegistrations, dicts } = applyWithMocks(exported)
    const reg = registration(slotRegistrations, 'settings.section', 'console')
    const face = reg.options.inject()
    const stub = stubFetch({
      diagnose: () => ({ ok: true, value: { jobId: 'job-groups' } }),
      job: () => ({ ok: true, value: { done: true, result: report } }),
      capabilities: () => ({ ok: true, value: {} }),
    })
    try {
      face.diagnose()
      const landed = await until(() => face.hooks.health.getSnapshot().report, '报告落到状态里')
      // 透传证明：分组与 scopes/exampleTitle 一条不丢，issue.scope 也还在。
      assert.equal(landed.groups.length, 4, 'groups 必须透传（归一不能重建时丢掉）')
      assert.equal(landed.issues.length, 173, 'issues 一条不能少')
      assert.equal(landed.issues[0].scope, 'sdk-pkg', 'issue.scope 必须透传')
      assert.deepEqual(landed.groups[0].scopes, [{ scope: 'sdk-pkg', count: 163 }])

      const { html, error } = renderSafely(reg.component, propsFor(face, makeT(dicts)))
      assert.equal(error, undefined)
      // 括注「（共 173 条，逐条证据一条不少）」按用户第二次反馈删掉（DESIGN §12.3.1 实例3）：
      // 总览句只说归并成几组；**条数的替代载体是组头的计数**（health.groupCount，下面 323 行断言）。
      assert.ok(html.includes('同类发现已归并为 4 组'), '要给出折叠总览：' + html.slice(0, 300))
      assert.ok(!html.includes('共 173 条'), '总览不该再重复计数（计数由组头承担）')
      for (const group of groups) {
        assert.ok(html.includes(group.exampleTitle), '组标题要在：' + group.exampleTitle)
      }
      assert.ok(html.includes('163 条同类'), '组摘要要显示条数')
      assert.ok(html.includes('sdk-pkg'), '组摘要要显示作用域')
      assert.ok(html.includes('未归入任何组的 1 条'), '落不进组的发现要单独列出，不能丢')
      // 组默认收起：4 个组行都是 open=false（真实 DisclosureRow 才不会展开 163 张卡片）。
      assert.ok((html.match(/data-open="false"/g) ?? []).length >= 4, '组必须默认收起')
    } finally { stub.restore() }
  })

  it('切换诊断目标：environment 进请求体，界面按报告里的 environment 显示', async () => {
    const exported = bootBundle()
    const { slotRegistrations, dicts } = applyWithMocks(exported)
    const face = registration(slotRegistrations, 'settings.section', 'console').options.inject()
    const bodies = []
    const stub = stubFetch({
      diagnose: (body) => { bodies.push(body); return { ok: true, value: { jobId: 'job-env' } } },
      // host 回答的环境名与请求的不同：界面必须以**报告**为准（Lead 明确的契约）。
      job: () => ({ ok: true, value: { done: true, result: { ...REPORT, environment: 'other-renamed' } } }),
      capabilities: () => ({ ok: true, value: {} }),
    })
    try {
      face.setDiagnosticTarget('other')
      const report = await until(() => face.hooks.health.getSnapshot().report, '跨环境报告落到状态里')
      assert.deepEqual(bodies[0], { environment: 'other' }, '目标环境必须进请求体（省略即当前环境）')
      assert.equal(report.environment, 'other-renamed')
      const reg = registration(slotRegistrations, 'settings.section', 'console')
      const { html, error } = renderSafely(reg.component, propsFor(face, makeT(dicts)))
      assert.equal(error, undefined)
      assert.ok(html.includes('被诊断环境：other-renamed'), '报告属于哪个环境以报告字段为准：' + html.slice(0, 300))
    } finally { stub.restore() }
  })

  it('切环境立刻丢掉上一份报告，在途的旧响应按代号作废', async () => {
    const exported = bootBundle()
    const { slotRegistrations } = applyWithMocks(exported)
    const face = registration(slotRegistrations, 'settings.section', 'console').options.inject()
    const stub = stubFetch({
      diagnose: () => ({ ok: true, value: { jobId: 'job-switch' } }),
      job: () => ({ ok: true, value: { done: true, result: REPORT } }),
      capabilities: () => ({ ok: true, value: {} }),
    })
    try {
      face.diagnose()
      await until(() => face.hooks.health.getSnapshot().report, '当前环境的报告先落到状态里')
      assert.equal(face.hooks.health.getSnapshot().target, undefined)
      face.setDiagnosticTarget('other')
      const state = face.hooks.health.getSnapshot()
      assert.equal(state.target, 'other', '目标要立刻变')
      assert.equal(state.report, undefined, '上一份报告属于别的环境，必须立刻清掉')
      await until(() => face.hooks.health.getSnapshot().report !== undefined
        && face.hooks.health.getSnapshot().report.environment === 'pm-test', '新报告落定')
    } finally { stub.restore() }
  })

  it('非当前环境：不渲染一键修复按钮，改为如实说明能做什么', async () => {
    const issueReport = {
      ...REPORT,
      issues: [{
        id: 'missing-dependency:foo',
        layer: 'dependency',
        severity: 'safe-fix',
        code: 'missing-dependency',
        title: '缺少依赖 foo',
        detail: '导入了 foo 但 profile 里没有装',
        subjects: ['foo'],
        evidence: [{ kind: 'file', at: 'package.json:12', note: '声明了却没解析到' }],
        fix: { action: 'install-dependency', target: 'foo', summary: '安装 foo' },
      }],
    }
    const exported = bootBundle()
    const { slotRegistrations, dicts } = applyWithMocks(exported)
    const reg = registration(slotRegistrations, 'settings.section', 'console')
    const face = reg.options.inject()
    const stub = stubFetch({
      listEnvironments: () => ({ ok: true, value: [
        { name: 'pm-test', current: true }, { name: 'other' },
      ] }),
      diagnose: () => ({ ok: true, value: { jobId: 'job-fix' } }),
      job: () => ({ ok: true, value: { done: true, result: issueReport } }),
      capabilities: () => ({ ok: true, value: {} }),
    })
    try {
      face.refreshEnvironments()
      await until(() => face.hooks.environments.getSnapshot().environments.length === 2, '环境列表落到状态里')
      face.diagnose()
      await until(() => face.hooks.health.getSnapshot().report, '当前环境的报告落下')

      const home = renderSafely(reg.component, propsFor(face, makeT(dicts)))
      assert.equal(home.error, undefined)
      // 修复按钮的 title 就是 fix.summary（'安装 foo'）：用它断言"按钮在不在"，
      // 而不是断言文案里没有"一键修复"——那段说明文字本身就会提到这个词。
      assert.ok(home.html.includes('一键修复') && home.html.includes('安装 foo'),
        '当前环境下修复按钮要在：' + home.html.slice(0, 300))
      // 旧句「（不是当前环境）」已按标准删除，这里改成断言真正承载该事实的标记（health.foreignTag），
      // 否则这条否定断言会因为字面消失而变成空转。
      assert.ok(!home.html.includes('非当前环境'), '当前环境不该出现「非当前环境」标记')

      // 切到另一个环境：同一份发现，但按钮不能出现（点了会改到当前环境）。
      face.setDiagnosticTarget('other')
      await until(() => face.hooks.health.getSnapshot().report, '非当前环境的报告落下')
      const away = renderSafely(reg.component, propsFor(face, makeT(dicts)))
      assert.equal(away.error, undefined)
      // 【task-64 有意反转（不是放松）】这两条曾是"改强"：当时「诊断目标：X」与「修改请到…」是
      // "报告属于谁""不能改就去哪改"的**仅有载体**，所以断言它们必须在。用户第三轮反馈把这两处判为冗余：
      //   · 「诊断目标：X」在选择器里已经显示着（删「复述控件值」）；
      //   · 「修改请到「环境」子页」属"指路"——按修订后的 DESIGN §12.3.2，指路不算可执行出路
      //     （出路指命令/参数/文件名这类照做就能完成的信息），而目标入口在子页标签里可见可点。
      // 反转后的断言改成"替代载体必须真的在"：报告头仍写明被诊断环境，子页标签仍在屏幕上。
      assert.ok(away.html.includes('被诊断环境：'), '要说清报告属于谁（报告头承载，值由报告自己给）：' + away.html.slice(0, 400))
      assert.ok(!away.html.includes('诊断目标：other'), '「诊断目标：X」已删：选择器里就显示着这个值')
      // 删掉括注的替代载体：这个事实必须由「非当前环境」Tag 渲染出来（task-48 又加了「只读」标记）。
      assert.ok(away.html.includes('非当前环境'), '非当前环境必须由标记表达：' + away.html.slice(0, 400))
      assert.ok(away.html.includes('环境'), '「环境」子页标签要在屏幕上（指路那句话的前提）')
      assert.ok(!away.html.includes('修改请到「环境」子页'), '指路那句已删（用户原话：他们会自然打开环境页）')
      assert.ok(!away.html.includes('安装 foo'), '非当前环境不得给出会改错环境的按钮')
      assert.ok(away.html.includes('仅报告'), '改为如实标注仅报告')
    } finally { stub.restore() }
  })

  it('跳过项：引擎给的 layers 原样透传（含多层），缺层/未知层不猜（"未查"不能画成 0）', async () => {
    // 契约见 src/types.ts 的 DiagnosticSkip.layers：只有"整层没查"才给层名，且**可能有多个**
    // （runtime-inventory 缺失同时废掉 runtime 与 consistency；单数会把另一层错标成"查过了"）。
    // 客户端反推 check 字符串是约定耦合，归一必须原样透传、且绝不发明层名。
    const exported = bootBundle()
    const { slotRegistrations } = applyWithMocks(exported)
    const face = registration(slotRegistrations, 'settings.section', 'console').options.inject()
    const stub = stubFetch({
      diagnose: () => ({ ok: true, value: { jobId: 'job-skip' } }),
      job: () => ({
        ok: true,
        value: {
          done: true,
          result: {
            ...REPORT,
            skipped: [
              { check: 'ecosystem-layer', reason: '该层关闭', layers: ['ecosystem'] },
              { check: 'runtime-inventory', reason: '没有 Loader', layers: ['runtime', 'consistency'] },
              { check: 'environment-dir', reason: '无法确定环境目录' },
              { check: 'mystery-layer', reason: '未知层名', layers: ['not-a-layer'] },
              { check: 'mixed-layer', reason: '半真半假', layers: ['runtime', 'nope'] },
              { check: 'not-an-array', reason: '形状不对', layers: 'runtime' },
            ],
          },
        },
      }),
      capabilities: () => ({ ok: true, value: {} }),
    })
    try {
      face.diagnose()
      const landed = await until(() => face.hooks.health.getSnapshot().report, '报告落到状态里')
      assert.equal(landed.skipped.length, 6, '跳过项不能丢')
      assert.deepEqual(landed.skipped[0].layers, ['ecosystem'], '单层必须透传')
      assert.deepEqual(landed.skipped[1].layers, ['runtime', 'consistency'],
        '一次跳过废掉两层时必须带上两层（否则另一层会被画成"查过且没问题"）')
      assert.equal(landed.skipped[2].layers, undefined, '非层级的跳过不带层名（它不代表整层没查）')
      assert.equal(landed.skipped[3].layers, undefined, '未知层名不得被发明成某一层')
      assert.deepEqual(landed.skipped[4].layers, ['runtime'], '混合数组只保留已知层名')
      assert.equal(landed.skipped[5].layers, undefined, '不是数组（旧形状/脏数据）不猜')
    } finally { stub.restore() }
  })

  it('目标环境不存在：host 的失败如实呈现，不悄悄退回当前环境', async () => {
    const exported = bootBundle()
    const { slotRegistrations, dicts } = applyWithMocks(exported)
    const reg = registration(slotRegistrations, 'settings.section', 'console')
    const face = reg.options.inject()
    const stub = stubFetch({
      diagnose: () => ({ ok: false, error: { code: 'operation-failed', message: '环境 nope 不存在' } }),
    })
    try {
      face.setDiagnosticTarget('nope')
      await until(() => face.hooks.health.getSnapshot().error, '失败落到状态里')
      assert.equal(face.hooks.health.getSnapshot().report, undefined)
      const { html, error } = renderSafely(reg.component, propsFor(face, makeT(dicts)))
      assert.equal(error, undefined)
      assert.ok(html.includes('体检失败：环境 nope 不存在'), html.slice(0, 300))
      // 【task-64 有意反转】「诊断目标：X」按用户第三轮反馈删掉（选择器里就显示着这个值）。
      // 目标是谁仍可从失败文案与选择器两处看出来，所以改成断言这两条载体，而不是删掉这条检查。
      assert.ok(html.includes('环境 nope 不存在'), '失败时也要能看出目标是谁（失败文案承载）')
      assert.ok(html.includes('nope'), '选择器里也要显示着目标名：' + html.slice(0, 300))
      assert.ok(html.includes('非当前环境'), '失败态也要由标记说清它不是当前环境')
    } finally { stub.restore() }
  })

  it('失败态护栏（真实序列）：复制插件失败 → 结果块是失败态，不是「完成」', async () => {
    // 关键：这条护栏**驱动真实序列**——UI 的动作 → act() → refresh()，不直接喂状态。
    // task-14 的护栏直接写 store，绕过了 act()→refresh()，所以真机上"失败画成完成"没被抓到
    // （docs/CODE-POLICY.md 第 7.4 节记的正是这类自证式护栏）。
    const exported = bootBundle()
    const { slotRegistrations, dicts } = applyWithMocks(exported)
    const reg = registration(slotRegistrations, 'settings.section', 'console')
    const face = reg.options.inject()
    const stub = stubFetch({
      listEnvironments: () => ({ ok: true, value: [{ name: 'pm-test', current: true }, { name: 'other' }] }),
      copyPlugins: () => ({ ok: true, value: { jobId: 'job-copy' } }),
      job: () => ({
        ok: true,
        value: {
          done: true,
          result: { ok: false, code: 'package-operation-failed', output: '无法安装 dsh-probe-nope-xyz：官方返回非零退出码' },
        },
      }),
    })
    try {
      face.copyPlugins('pm-test', 'other', ['dsh-probe-nope-xyz'])
      const settled = await until(() => {
        const snapshot = face.hooks.environments.getSnapshot()
        return snapshot.busy === undefined && snapshot.notice !== undefined && !snapshot.loading ? snapshot : undefined
      }, '复制操作落定（含其后的列表刷新）')
      assert.equal(settled.error, 'package-operation-failed', '失败态必须活过 refresh()：' + JSON.stringify(settled))

      const props = propsFor(face, makeT(dicts))
      props.actions.select('env')
      const { html, error } = renderSafely(reg.component, props)
      assert.equal(error, undefined)
      assert.match(html, /data-run-state="failed"/, '结果块必须是失败态：' + html.slice(-600))
      assert.ok(!html.includes('完成'), '不得出现 trace.done「完成」文案')
      assert.ok(html.includes('无法安装 dsh-probe-nope-xyz'), '失败输出要如实呈现')
      assert.ok(html.includes('操作失败'), '失败文案要出现')
    } finally { stub.restore() }
  })

  it('失败态护栏（真实序列）：卸载技能失败 → 失败文案活过随后的 load()', async () => {
    const exported = bootBundle()
    const { slotRegistrations, dicts } = applyWithMocks(exported)
    const reg = registration(slotRegistrations, 'settings.section', 'kinds')
    const face = reg.options.inject()
    const stub = stubFetch({
      uninstallKind: () => ({ ok: true, value: { jobId: 'job-uninstall' } }),
      job: () => ({ ok: true, value: { done: true, result: { ok: false, code: 'not-found', output: '目录不存在：/tmp/x' } } }),
      listKinds: () => ({ ok: true, value: { records: [], orphans: [] } }),
    })
    try {
      face.uninstallKind('owner/repo')
      const settled = await until(() => {
        const snapshot = face.hooks.kinds.getSnapshot()
        return snapshot.busy === undefined && snapshot.notice !== undefined && !snapshot.loading ? snapshot : undefined
      }, '卸载操作落定（含其后的列表加载）')
      assert.equal(settled.error, 'not-found', '失败态必须活过 load()：' + JSON.stringify(settled))
      const { html, error } = renderSafely(reg.component, propsFor(face, makeT(dicts)))
      assert.equal(error, undefined)
      assert.ok(html.includes('not-found') || html.includes('目录不存在'), '失败文案要出现：' + html.slice(0, 300))
    } finally { stub.restore() }
  })

  it('导入无效备份：结果块不得留下上一次操作的内容（P6）', async () => {
    const exported = bootBundle()
    const { slotRegistrations, dicts } = applyWithMocks(exported)
    const reg = registration(slotRegistrations, 'settings.section', 'console')
    const face = reg.options.inject()
    const t = makeT(dicts)
    const renderEnv = () => {
      const props = propsFor(face, t)
      props.actions.select('env')
      return renderSafely(reg.component, props)
    }

    // 前置：结果块里确实有"上一次操作"的内容。
    face.hooks.environments.update((draft) => { draft.notice = '上一次操作结果：已启动 foo' })
    assert.ok(renderEnv().html.includes('已启动 foo'), '前置条件：块里先要有上一次的内容')

    // 真实序列：导入一个非法文件。
    await face.loadBackup({ text: async () => 'not-json' })
    const after = renderEnv()
    assert.equal(after.error, undefined)
    assert.ok(!after.html.includes('已启动 foo'), '上一次操作的内容必须被清掉，不能留在块里')
    assert.ok(after.html.includes('这个文件不是本插件的备份'), '失败原因要出现：' + after.html.slice(-400))
    assert.ok(!after.html.includes('data-run-state="done"'), '这次导入失败不得被画成成功态')
  })

  it('环境列表：条目缺 runs/bundles/dependencies 时归一成空数组', async () => {
    const exported = bootBundle()
    const { slotRegistrations } = applyWithMocks(exported)
    const face = registration(slotRegistrations, 'settings.section', 'console').options.inject()
    const stub = stubFetch({
      listEnvironments: () => ({ ok: true, value: [{ name: 'pm-test' }, { name: 'other', runs: [{ pid: 42 }] }] }),
    })
    try {
      face.refreshEnvironments()
      const state = await until(() => {
        const snapshot = face.hooks.environments.getSnapshot()
        return snapshot.environments.length === 2 && !snapshot.loading ? snapshot : undefined
      }, '环境列表落到状态里')
      assert.deepEqual(state.environments[0], {
        name: 'pm-test', dir: '', current: false, builtin: false, bundles: [], dependencies: [], runs: [],
      })
      assert.deepEqual(state.environments[1].runs, [{ pid: 42, port: null, command: '' }])
    } finally { stub.restore() }
  })

  it('失败态护栏：环境结果块在 errorKey-only / error-only 下都不是成功态（旧代码会画成"完成"）', () => {
    // 环境子页不是独立注册项，所以这里用 react 替身把首屏落在「环境」子页。
    const exported = bootBundle()
    const { slotRegistrations, dicts } = applyWithMocks(exported)
    const reg = registration(slotRegistrations, 'settings.section', 'console')
    const face = reg.options.inject()
    const t = makeT(dicts)
    const renderEnv = () => {
      const props = propsFor(face, t)
      props.actions.select('env')
      return renderSafely(reg.component, props)
    }

    // 1) errorKey-only：payload 残缺类失败（真实形状：只设 errorKey，不设 error）。
    face.hooks.environments.update((draft) => {
      draft.notice = '上一次操作结果'
      draft.error = undefined
      draft.errorKey = 'error.incompletePayload'
    })
    const keyOnly = renderEnv()
    assert.equal(keyOnly.error, undefined)
    assert.match(keyOnly.html, /data-run-state="failed"/, 'errorKey-only 必须渲染成失败态：' + keyOnly.html.slice(0, 300))
    assert.ok(!keyOnly.html.includes('完成'), '不得出现 trace.done「完成」文案（与同一块里的红字报错自相矛盾）')
    assert.ok(keyOnly.html.includes('宿主返回的数据不完整'), '失败文案要真的出现：' + keyOnly.html.slice(0, 300))

    // 2) error-only：host 给的原始诊断（真实形状：只设 error，不设 errorKey）。
    face.hooks.environments.update((draft) => {
      draft.notice = '上一次操作结果'
      draft.error = 'no-profile-context'
      draft.errorKey = undefined
    })
    const errorOnly = renderEnv()
    assert.equal(errorOnly.error, undefined)
    assert.match(errorOnly.html, /data-run-state="failed"/, 'error-only 必须渲染成失败态')
    assert.ok(!errorOnly.html.includes('完成'), '不得出现 trace.done「完成」文案')
    assert.ok(errorOnly.html.includes('no-profile-context'), '失败文案要真的出现')

    // 3) 成功对照：两者皆空才允许画成成功态——否则前两条会因为"永远不画成功"而形同虚设。
    face.hooks.environments.update((draft) => {
      draft.notice = '上一次操作结果'
      draft.error = undefined
      draft.errorKey = undefined
    })
    const clean = renderEnv()
    assert.equal(clean.error, undefined)
    assert.match(clean.html, /data-run-state="done"/, '干净结束仍必须是成功态')
    assert.ok(clean.html.includes('完成'), '成功对照必须出现 trace.done「完成」文案')
  })

  it('失败态护栏：errorKey-only 与 error-only 在体检/市场/技能的错误区都渲染出失败文案', async () => {
    const cases = [
      {
        id: 'console',
        hook: 'health',
        // 体检页的失败区是红线，不是结果块：两种形状都必须出现。
        keyOnly: '宿主返回的数据不完整',
        errorText: '官方能力探针不可用',
      },
      { id: 'marketplace', hook: 'marketplace', keyOnly: '宿主返回的数据不完整', errorText: '索引源不可达' },
      { id: 'kinds', hook: 'kinds', keyOnly: '宿主返回的数据不完整', errorText: '目录不可读' },
    ]
    for (const entry of cases) {
      const exported = bootBundle()
      const { slotRegistrations, dicts } = applyWithMocks(exported)
      const reg = registration(slotRegistrations, 'settings.section', entry.id)
      const face = reg.options.inject()
      const store = face.hooks[entry.hook]
      const t = makeT(dicts)

      store.update((draft) => { draft.error = undefined; draft.errorKey = 'error.incompletePayload' })
      const keyOnly = renderSafely(reg.component, propsFor(face, t))
      assert.equal(keyOnly.error, undefined)
      assert.ok(keyOnly.html.includes(entry.keyOnly), entry.id + ' errorKey-only 要出现失败文案：' + keyOnly.html.slice(0, 200))

      store.update((draft) => { draft.errorKey = undefined; draft.error = entry.errorText })
      const errorOnly = renderSafely(reg.component, propsFor(face, t))
      assert.equal(errorOnly.error, undefined)
      assert.ok(errorOnly.html.includes(entry.errorText), entry.id + ' error-only 要出现失败文案')
    }
  })
})

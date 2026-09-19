/**
 * 「关于」页的契约（task-95）。
 *
 * 归属：A 类·新护栏（新界面）。
 * 手法与 tests/trial-ui.test.mjs 同源（共享 tests/client-harness.mjs 的桩件）。
 *
 * 这里钉四件事：
 *   1. **读不到必须说"未知"+ 原因**，不许用 0 / 空串 / 省略冒充（§12.3.3）——三条降级路径各一条；
 *   2. **读到的事实在界面上**（版本、路径），且带来源；
 *   3. 载荷整体残缺时**不画空表**（显示读失败 + 重试）；
 *   4. 文案过 §12（短文本不带句号、不口语化、不用内部代号）。
 *
 * 运行前需要 dist/client.js 是新的（pnpm run build）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { applyWithMocks, bootBundle, makeT, propsFor, registration, React, stubFetch, until } from './client-harness.mjs'

const require_ = createRequire(import.meta.url)
const { renderToStaticMarkup } = require_('react-dom/server')

/** 一条读到了的事实。 */
const known = (value, source) => ({ value, source })
/** 一条读不到的事实。 */
const missing = (unknown) => ({ unknown })

/** 一份完整的事实载荷（形状与 host 的 AboutFacts 一致）。 */
const FACTS = {
  runtime: {
    version: known('0.1.6-alpha.2', '/opt/dsh/node_modules/@deepseek-ai/dsh/package.json'),
    installAnchor: known('/opt/dsh/node_modules/@deepseek-ai/dsh/package.json', '官方 profileContext.installAnchor'),
  },
  process: {
    node: known('v24.21.0', '本进程的 process.version'),
    platform: known('linux', '本进程的 process.platform'),
    arch: known('x64', '本进程的 process.arch'),
  },
  companion: { version: known('0.1.0', '/opt/companion/package.json') },
  profile: {
    name: known('pm-test', '官方 profileContext.name'),
    dir: known('/home/u/.dsh/profiles/pm-test', '官方 profileContext.dir'),
  },
  files: {
    settingsPath: known('/home/u/.dsh/settings.yaml', '由 DSH_HOME 推导'),
    registryCachePath: known('/home/u/.dsh/plugin-manager-companion/registry-index.json', '本插件的市场索引缓存位置'),
    registryCacheAgeMs: known(3_600_000, '缓存文件的修改时间'),
  },
}

/**
 * 启动产物并取「关于」注册项。
 *
 * @param value - settings 命名空间的当前值。
 * @returns 注册项、注入面与字典座位。
 */
function boot(value = {}) {
  const exported = bootBundle()
  const applied = applyWithMocks(exported, { value })
  const t = makeT(applied.dicts, { strict: true })
  const entry = registration(applied.slotRegistrations, 'settings.section', 'about')
  const face = entry.options.inject()
  return { entry, face, t, applied }
}

/**
 * 渲染「关于」页（并选中 DSH 信息子页——子页只在选中后挂载）。
 *
 * @param entry - 注册项。
 * @param face - 注入面。
 * @param t - 字典座位。
 * @returns 渲染出的 HTML。
 */
function renderAbout(entry, face, t) {
  const props = propsFor(face, t, {}, entry)
  assert.ok(props.actions !== undefined, '关于页注册项必须声明 store')
  props.actions.select('dsh')
  return renderToStaticMarkup(React.createElement(entry.component, props))
}

describe('「关于」页（task-95）：只读事实、不猜事实', () => {
  it('注册项在，且 order=100（把"最后一位"编码进数值）', () => {
    const { applied } = boot()
    const entry = registration(applied.slotRegistrations, 'settings.section', 'about')
    assert.equal(entry.options.order, 100, '关于页必须排在最后（官方 0/10/15/20/25，我们 16/17/22）')
    assert.equal(entry.options.label(), '关于', '标签走字典')
  })

  it('首屏就渲染 DSH 信息（不点任何东西也有内容）', () => {
    // 真机取证抓到的缺陷：我把子页内容 gate 在 visitedIds 上，而 visitedIds **只在点击时**写入
    // → 用户打开「关于」看到的是一片空白（只有标签）。
    // 单测当时没暴露它：其它用例都显式调了 actions.select('dsh')。
    //
    // 这条**不调 select**，直接渲染首屏——判据是"内容在"，与"点没点"无关。
    const { entry, face, t } = boot()
    const props = propsFor(face, t, {}, entry)
    const html = renderToStaticMarkup(React.createElement(entry.component, props))
    assert.ok(html.includes('DSH 信息'), '标签要在：' + html.slice(0, 300))
    // 首屏还没读到事实，但**必须**至少渲染出"正在读取/还没有读到"这类可读文本，
    // 而不是一片空白（§12.3.3 的同族：不许用缺席表达状态）。
    assert.ok(/正在读取|还没有读到/.test(html), '首屏要有可读文本，不能空白：' + html.slice(0, 400))
  })
  it('读到的事实在界面上，且带来源（"这条事实怎么来的"要能判断）', async () => {
    const { entry, face, t } = boot()
    const stub = stubFetch({ about: () => ({ ok: true, value: FACTS }) })
    try {
      face.loadAbout(false)
      await until(() => face.hooks.about.getSnapshot().facts !== undefined, '事实落状态')
      const html = renderAbout(entry, face, t)
      for (const text of ['0.1.6-alpha.2', 'v24.21.0', 'linux', 'x64', 'pm-test', '0.1.0']) {
        assert.ok(html.includes(text), '事实必须在界面上：' + text + String.fromCharCode(10) + html.slice(0, 500))
      }
      assert.ok(html.includes('/opt/dsh/node_modules/@deepseek-ai/dsh/package.json'), '安装位置要在')
      assert.ok(html.includes('settings.yaml'), '设置文件路径要在')
      // 来源必须显示：一个没有来源的版本号与一个猜出来的版本号，在界面上长得一模一样。
      assert.ok(html.includes('官方 profileContext.installAnchor'), '来源要在：' + html.slice(0, 600))
    } finally {
      stub.restore()
    }
  })

  it('降级一：锚点读不到 → 显示「未知」+ 原因（不是空、不是 0）', async () => {
    const { entry, face, t } = boot()
    const value = {
      ...FACTS,
      runtime: {
        version: missing('DSH 版本：拿不到官方安装锚点（本进程不是以 dsh profile 启动的）'),
        installAnchor: missing('安装位置：拿不到官方安装锚点（本进程不是以 dsh profile 启动的）'),
      },
    }
    const stub = stubFetch({ about: () => ({ ok: true, value }) })
    try {
      face.loadAbout(false)
      await until(() => face.hooks.about.getSnapshot().facts !== undefined, '事实落状态')
      const html = renderAbout(entry, face, t)
      assert.ok(html.includes('未知'), '读不到要说「未知」')
      assert.ok(html.includes('拿不到官方安装锚点'), '要给出原因：' + html.slice(0, 500))
      assert.ok(!html.includes('0.1.6-alpha.2'), '读不到时不得显示任何版本号')
    } finally {
      stub.restore()
    }
  })

  it('降级二：缓存不存在 → 年龄显示原因（不是 0 毫秒）', async () => {
    const { entry, face, t } = boot()
    const value = {
      ...FACTS,
      files: {
        ...FACTS.files,
        registryCacheAgeMs: missing('缓存年龄：缓存文件还不存在（还没有成功抓过索引）'),
      },
    }
    const stub = stubFetch({ about: () => ({ ok: true, value }) })
    try {
      face.loadAbout(false)
      await until(() => face.hooks.about.getSnapshot().facts !== undefined, '事实落状态')
      const html = renderAbout(entry, face, t)
      assert.ok(html.includes('缓存文件还不存在'), '要给原因：' + html.slice(0, 600))
      // 0 是"刚刚写过"，与"没有缓存"是两件事（§12.3.3）。
      assert.ok(!html.includes('刚刚'), '不得把"没有缓存"渲染成"刚刚写过"')
    } finally {
      stub.restore()
    }
  })

  it('降级三：settings.yaml 读不到 / profileContext 缺失 → 各自给原因', async () => {
    const { entry, face, t } = boot()
    const value = {
      ...FACTS,
      profile: {
        name: missing('当前环境名：宿主没有提供 profileContext'),
        dir: missing('环境目录：宿主没有提供 profileContext'),
      },
      files: {
        ...FACTS.files,
        settingsPath: missing('设置文件：读不到 DSH_HOME'),
      },
    }
    const stub = stubFetch({ about: () => ({ ok: true, value }) })
    try {
      face.loadAbout(false)
      await until(() => face.hooks.about.getSnapshot().facts !== undefined, '事实落状态')
      const html = renderAbout(entry, face, t)
      assert.ok(html.includes('宿主没有提供 profileContext'), '环境名要给原因')
      assert.ok(html.includes('读不到 DSH_HOME'), '设置文件要给原因')
      assert.ok(!html.includes('pm-test'), '读不到时不得显示任何环境名')
    } finally {
      stub.restore()
    }
  })

  it('载荷整体残缺 → 显示读失败 + 重试，**不画空表**', async () => {
    const { entry, face, t } = boot()
    const stub = stubFetch({ about: () => ({ ok: true, value: undefined }) })
    try {
      face.loadAbout(false)
      await until(() => face.hooks.about.getSnapshot().errorKey !== undefined, '残缺载荷落状态')
      const html = renderAbout(entry, face, t)
      assert.ok(html.includes('读取失败'), '要说读失败：' + html.slice(0, 400))
      assert.ok(html.includes('重试'), '要给重试')
      // 关键：不许画成"读到了但什么都没有"——那会让用户以为这份安装是空的。
      assert.ok(!html.includes('DSH 版本'), '残缺时不得画出字段标签（那是空表）')
    } finally {
      stub.restore()
    }
  })

  it('op 挂了 → 如实说失败，不画成"还没读到"', async () => {
    const { entry, face, t } = boot()
    const stub = stubFetch({ about: () => { throw new Error('网络断了') } })
    try {
      face.loadAbout(false)
      await until(() => face.hooks.about.getSnapshot().error !== undefined, '失败落状态')
      const html = renderAbout(entry, face, t)
      assert.ok(html.includes('网络断了'), '要说失败原因：' + html.slice(0, 400))
      assert.ok(!html.includes('还没有读到'), '读挂了不得显示成"还没读到"（那是把故障画成加载中）')
    } finally {
      stub.restore()
    }
  })

  it('文案：所有 about.* 键过 §12（短文本不带句号、不口语化）', async () => {
    const { applied } = boot()
    const dict = applied.dicts.find(entry => entry.ns === 'plugin-manager-companion')
    assert.ok(dict !== undefined, '字典没注册')
    const { violationsOf } = await import('./copy-rules.mjs')
    const hits = []
    for (const [key, text] of Object.entries(dict.d.zh)) {
      if (typeof text !== 'string' || !key.startsWith('about.')) continue
      const found = violationsOf(text, 'dict')
      if (found.length > 0) hits.push(key + ' [' + found.join(',') + '] :: ' + text)
    }
    assert.deepEqual(hits, [], '关于页文案命中 §12.9：' + String.fromCharCode(10) + hits.join(String.fromCharCode(10)))
  })
})

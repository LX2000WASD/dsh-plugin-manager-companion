/**
 * UI 文案标准护栏（node --test）：把 DESIGN.md §12 从"文档里的标准"变成"当场会红的断言"。
 *
 * 守护的是用户实测反馈过的那类文案：解释实现与通道、解释模块结构、以及自夸式的说明段落。
 * 官方 DSH 页面 intro 的实测标尺只有一句「这里有什么 / 这里能做什么」（DESIGN §12.1），
 * 所以本插件也不许出现解释性段落；判据是「删掉之后用户还能不能完成任务」（§12.3）。
 *
 * 两个数据源，缺一不可：
 *   1. **产物**：以模拟模块表启动 dist/client.js，取 ctx.locale.register 注册的 zh/en 字典
 *      ——这才是真正发给浏览器的那份文案（与 client-boot.test.mjs 同一套启动手法）。
 *   2. **源码**：逐行扫 src/client/locales.ts 的字典条目，保证源码里的文案也过同一张表，
 *      并用"每个键在源码里恰好两条（zh + en）"钉住扫描本身不空转——改了排版导致扫不到，
 *      或漏加一条翻译，都会当场红。
 *
 * 长度上限为什么算断言：一句话说不完的 intro，几乎都是解释性段落；在缺少语义理解的地方，
 * 长度是"这句话是不是在解释"最廉价且最稳定的代理指标。
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
/** 本插件在客户端 locale 注册表里的命名空间。 */
const NS = 'plugin-manager-companion'
/** 文案的真源（本测试的第二个数据源）。 */
const SOURCE = 'src/client/locales.ts'

/** primitives 用 Proxy 桩：本文件只关心注册面，不关心视觉实现。 */
function stubPrimitives() {
  return new Proxy({}, { get: () => () => null })
}

/**
 * 符合官方 SnapshotStore 契约的桩件（与 client-boot.test.mjs 同一实现意图）。
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
 * 以模拟模块表启动产物，取它注册的字典。
 * @returns `{ zh, en }` 两份字典。
 */
function loadDictionaries() {
  assert.ok(existsSync('dist/client.js'), 'dist/client.js 不存在：先跑 pnpm run build')
  const table = {
    'react': React,
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

  const dicts = []
  const noop = () => () => {}
  exported.apply({
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    on: noop,
    get() { return undefined },
    logger: { info() {}, warn() {}, error() {} },
    locale: {
      register(ns, d) { dicts.push({ ns, d }); return () => {} },
      bind: () => (key) => key,
      subscribe: () => () => {},
      getSnapshot: () => ({ revision: 0 }),
    },
    slots: {
      inject: (name, fn) => { const reg = fn(); return typeof reg === 'function' ? reg : () => {} },
      register: () => () => {},
      entries: () => [],
      getVersion: () => 0,
      subscribe: () => () => {},
    },
    remote: { pluginManager: {}, pluginInventory: {}, $on: () => () => {}, $mount: async () => () => {} },
    settingsScope: {
      bind({ namespace }) {
        const snapshot = {
          status: 'ready', value: undefined, base: undefined, user: undefined,
          revision: 1, writable: true, mode: 'host', namespace,
        }
        return {
          getSnapshot: () => snapshot,
          subscribe: () => () => {},
          mutate: async () => {},
          set: async () => {},
          unset: async () => {},
        }
      },
      describe: () => ({ subscribe: () => () => {}, getSnapshot: () => ({ descriptors: [] }) }),
    },
  })
  const hit = dicts.find(entry => entry.ns === NS)
  assert.ok(hit !== undefined, '产物没有注册 ' + NS + ' 字典，实到：' + dicts.map(e => e.ns).join(', '))
  assert.ok(hit.d.zh !== undefined && hit.d.en !== undefined, NS + ' 字典缺少 zh 或 en')
  return { zh: hit.d.zh, en: hit.d.en }
}

let cached
/** 惰性取字典（首次调用才启动产物，失败信息挂在具体用例上）。 */
function dictionaries() { return (cached ??= loadDictionaries()) }

/**
 * 禁止词表（DESIGN §12.2 的三类）。
 *
 * 每条都带上"为什么禁"，红的时候不用翻文档：`id` 是给人看的名字，`why` 是这一类的问题所在。
 * 表里有具体句子（用户反馈里点名的原话）也有类别词（通道 / channel），后者防的是换个说法复活。
 */
const FORBIDDEN = [
  // 类 1：实现与通道 —— 用户不关心写操作走哪条通道、配置落在哪
  { id: 'zh·官方…通道', re: /官方[^，。；\s]{0,6}通道/, why: '解释写操作走哪条通道' },
  { id: 'zh·服务落盘', re: /服务落盘/, why: '解释持久化实现' },
  { id: 'zh·不写 YAML', re: /不写\s*YAML/i, why: '解释存储格式' },
  { id: 'zh·经 loader 应用', re: /经\s*loader\s*应用/i, why: '解释应用机制' },
  { id: 'en·official channel', re: /official\s+(?:write\s+)?channel/i, why: '解释写操作走哪条通道' },
  { id: 'en·via/through the official', re: /(?:via|through) the official/i, why: '解释写操作走哪条通道' },
  { id: 'en·persisted by the official', re: /persisted by the official/i, why: '解释持久化实现' },
  { id: 'en·no YAML', re: /no\s+yaml/i, why: '解释存储格式' },
  { id: 'en·applied by the loader', re: /applied by the loader/i, why: '解释应用机制' },
  // 类 2：结构说明 —— "都在这一个入口里""和某处是同一份文档""插件本体在别处管理"
  { id: 'zh·都在这一个入口里', re: /这一个入口/, why: '说明模块结构' },
  { id: 'zh·同一份…文档', re: /同一份[^。]{0,12}文档/, why: '说明模块结构' },
  { id: 'zh·插件本体在官方插件页管理', re: /在官方插件页管理/, why: '说明模块结构' },
  { id: 'en·in one entry', re: /in one entry/i, why: '说明模块结构' },
  { id: 'en·same official … document', re: /same official[^.]{0,24}document/i, why: '说明模块结构' },
  { id: 'en·official Plugins page', re: /official\s+plugins?\s+page/i, why: '说明模块结构' },
  // 类 3：自夸 / 保证 —— 做到了自然看得见，写出来是噪声
  { id: 'zh·如实标注', re: /如实标注/, why: '做到了自然看得见' },
  { id: 'zh·绝不静默', re: /绝不静默/, why: '做到了自然看得见' },
  { id: 'zh·展开证据', re: /展开证据/, why: '点了就知道' },
  { id: 'en·marked as skipped', re: /marked as skipped/i, why: '做到了自然看得见' },
  { id: 'en·unfolds its evidence', re: /unfolds its evidence/i, why: '点了就知道' },
]

/** intro 类文案的长度上限（中文字 / 英文字符）。 */
const INTRO_LIMITS = { zh: 40, en: 100 }

/**
 * 逐行解析源码里的字典条目（`  '键': '值',`）。
 * 行级而非语法级解析：换来的是不引入 TS 解析器；漏扫由下面「每个键恰好两条」与
 * 「字面条目的键必须都在产物字典里」两条断言兜住（后者同时能抓出忘了 build 的旧产物）。
 * @returns 条目列表（行号、键、值、原始行、是否字符串字面量）。
 */
function sourceEntries() {
  const out = []
  const lines = readFileSync(SOURCE, 'utf8').split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*'([^']+)':\s*(.+)$/)
    if (match === null) continue
    const value = match[2]
    // 只把「值是字符串字面量」的行当文案条目：declare module 里的 `'命名空间': KeyType` 不是文案。
    const literal = value.startsWith("'") || value.startsWith('"')
    out.push({ line: index + 1, key: match[1], value, text: lines[index], literal })
  }
  return out
}

describe('UI 文案标准（DESIGN §12）', () => {
  it('产物字典（zh 与 en）零命中禁止词表', () => {
    const dict = dictionaries()
    for (const lang of ['zh', 'en']) {
      const messages = dict[lang]
      assert.ok(Object.keys(messages).length > 0, lang + ' 字典是空的')
      for (const [key, value] of Object.entries(messages)) {
        for (const rule of FORBIDDEN) {
          assert.ok(!rule.re.test(value),
            lang + ' 的 ' + key + ' 命中禁止词【' + rule.id + '】（' + rule.why + '）：' + value)
        }
      }
    }
  })

  it('源码 locales.ts 的字典条目过同一张表（源码是文案的真源）', () => {
    const dict = dictionaries()
    const entries = sourceEntries().filter(entry => entry.literal)
    assert.ok(entries.length > 0, '在 ' + SOURCE + ' 里一条字典条目都没扫到')
    const hits = []
    for (const entry of entries) {
      for (const rule of FORBIDDEN) {
        if (rule.re.test(entry.value)) {
          hits.push(SOURCE + ':' + entry.line + ' 键 ' + entry.key + ' 命中【' + rule.id + '】：' + entry.value)
        }
      }
    }
    assert.deepEqual(hits, [], '源码里仍有禁止词：\n' + hits.join('\n'))
  })

  it('源码扫描覆盖全部字典键（每个键恰好两条：zh + en）', () => {
    const dict = dictionaries()
    const keys = Object.keys(dict.zh)
    assert.deepEqual(Object.keys(dict.en).slice().sort(), keys.slice().sort(), 'en 与 zh 的键集不一致')
    const all = sourceEntries().filter(entry => entry.literal)
    const unknown = all.filter(entry => !(entry.key in dict.zh))
    assert.deepEqual(unknown.map(entry => SOURCE + ':' + entry.line + ' ' + entry.key), [],
      '源码里有产物字典里不存在的键（写错键名，或改了源码没重新 build）：先 pnpm run build 再重跑')
    const entries = all.filter(entry => entry.key in dict.zh)
    const counts = new Map()
    for (const entry of entries) counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1)
    const bad = keys.filter(key => counts.get(key) !== 2)
    assert.deepEqual(bad, [],
      '这些键在 ' + SOURCE + ' 里不是恰好两条（zh + en）：' + bad.map(k => k + '×' + String(counts.get(k) ?? 0)).join(', ')
      + ' —— 源码扫描会空转，先修扫描或补翻译')
    const wrapped = entries.filter(entry => !entry.value.endsWith(','))
    assert.deepEqual(wrapped.map(entry => SOURCE + ':' + entry.line + ' ' + entry.text.trim()), [],
      '字典条目必须单行写全（值以逗号收尾）：换行会让源码扫描漏掉后半句')
  })

  it('intro 类文案不超过一句话的长度上限，且不出现分号', () => {
    const dict = dictionaries()
    const introKeys = Object.keys(dict.zh).filter(key => key.endsWith('.intro'))
    assert.ok(introKeys.length > 0, '字典里一个 *.intro 都没有，本用例会退化成空转')
    const offenders = []
    for (const key of introKeys) {
      for (const lang of ['zh', 'en']) {
        const value = String(dict[lang][key])
        const length = [...value].length
        const limit = INTRO_LIMITS[lang]
        if (length > limit) offenders.push(lang + ' ' + key + '：' + length + ' > ' + limit + ' —— ' + value)
        if (/[；;]/.test(value)) offenders.push(lang + ' ' + key + ' 含分号（多句解释的信号）：' + value)
      }
    }
    assert.deepEqual(offenders, [], 'intro 必须是"这里有什么 / 这里能做什么"的一句话：\n' + offenders.join('\n'))
  })
})

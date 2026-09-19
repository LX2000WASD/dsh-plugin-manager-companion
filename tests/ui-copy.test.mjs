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
 *
 * 2026-09-19 第二次反馈：用户举了三个实例（都在环境控制台），它们全部来自第一次清理之后**仍留在界面上**的文案，
 * 而旧版护栏（禁止词表 + 句长上限）对这三条**全部放行**。不是没用，是不够：词表只认已知句子，句长只认长度。
 * 所以按 DESIGN §12.3.1 的四类补三条规则，并且**每条禁止项都注明来源**（哪次反馈 / 用户原文 / 日期）。
 *
 * 新规则按「理由」实现，不按「形态」实现：用户反对的不是顿号，是「把屏幕上已有的东西再念一遍」——
 * 规则1 因此查的是「枚举里有几个名字已经作为元素渲染在同一页」，清单每项都注明渲染点（§12.4 的校准）。
 *
 * 规则来源速查（改护栏前先读这三行）：
 *   · 第一次反馈 2026-09-19：《诊断、多环境管理都在这一个入口里；写操作一律走官方通道》→ 禁止词表 + 句长上限
 *   · 第二次反馈 2026-09-19 三例：五层诊断枚举 ／「默认诊断当前环境…本页只读」／「（共 3 条，逐条证据一条不少）」→ 三条新规则
 *   · 校准：规则1 不查顿号数量，查「界面上已渲染的元素名」的命中数（见 RENDERED_ELEMENT_NAMES 的 where 列）
 *   · DESIGN §12.5：删信息的人负责证明它已在别处可被看见，并由测试钉住替代载体——本文件管「文案侧不许复活」，
 *     页面侧的替代载体断言在 tests/client-render.test.mjs（:319/:415/:422/:425/:488 就是照这条规矩填的）
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { applyWithMocks, bootBundle, NS } from './client-harness.mjs'

/** 文案的真源（本测试的第二个数据源）。 */
const SOURCE = 'src/client/locales.ts'

/**
 * 以模拟模块表启动产物，取它注册的字典。
 *
 * 桩件（平台表 / SnapshotStore / defineStore / primitives）都在 tests/client-harness.mjs，
 * 四个客户端测试文件共用一份；这里只关心"产物真的注册了哪份文案"。
 * @returns `{ zh, en }` 两份字典。
 */
function loadDictionaries() {
  const dicts = applyWithMocks(bootBundle()).dicts
  const hit = dicts.find(entry => entry.ns === NS)
  assert.ok(hit !== undefined, '产物没有注册 ' + NS + ' 字典，实到：' + dicts.map(e => e.ns).join(', '))
  assert.ok(hit.d.zh !== undefined && hit.d.en !== undefined, NS + ' 字典缺少 zh 或 en')
  return { zh: hit.d.zh, en: hit.d.en }
}

let cached
/** 惰性取字典（首次调用才启动产物，失败信息挂在具体用例上）。 */
function dictionaries() { return (cached ??= loadDictionaries()) }

/**
 * 禁止词表 = DESIGN §12.2（第一次反馈）+ §12.3.1 / §12.4（第二次反馈）的可执行形态。
 *
 * 每条都必须写 `source`：哪次反馈、用户原话（或原文片段）、日期。`why` 说"这条为什么是噪声"，
 * `source` 说"谁在什么时候被它烦到过"——§12.4 要求注明来源，是为了让后来人知道为什么被禁，
 * 而不是把它当成一条凭空的洁癖。下面有一条用例专门钉住这件事。
 */
const FORBIDDEN = [
  // ── 第一次反馈（2026-09-19）：解释性段落（禁止词表 + 句长上限）──────────────────
  // 类 1：实现与通道 —— 用户不关心写操作走哪条通道、配置落在哪
  { id: 'zh·官方…通道', re: /官方[^，。；\s]{0,6}通道/, why: '解释写操作走哪条通道',
    source: '第一次反馈 2026-09-19 用户原话：诊断、多环境管理都在这一个入口里；写操作一律走官方通道' },
  { id: 'zh·服务落盘', re: /服务落盘/, why: '解释持久化实现',
    source: '第一次反馈 2026-09-19 同段原话：这些配置由官方 settings 服务落盘' },
  { id: 'zh·不写 YAML', re: /不写\s*YAML/i, why: '解释存储格式', source: '第一次反馈 2026-09-19：解释性段落（三类见 DESIGN §12.2）' },
  { id: 'zh·经 loader 应用', re: /经\s*loader\s*应用/i, why: '解释应用机制', source: '第一次反馈 2026-09-19：解释性段落（三类见 DESIGN §12.2）' },
  { id: 'en·official channel', re: /official\s+(?:write\s+)?channel/i, why: '解释写操作走哪条通道', source: '第一次反馈 2026-09-19：解释性段落（三类见 DESIGN §12.2）' },
  { id: 'en·via/through the official', re: /(?:via|through) the official/i, why: '解释写操作走哪条通道', source: '第一次反馈 2026-09-19：解释性段落（三类见 DESIGN §12.2）' },
  { id: 'en·persisted by the official', re: /persisted by the official/i, why: '解释持久化实现', source: '第一次反馈 2026-09-19：解释性段落（三类见 DESIGN §12.2）' },
  { id: 'en·no YAML', re: /no\s+yaml/i, why: '解释存储格式', source: '第一次反馈 2026-09-19：解释性段落（三类见 DESIGN §12.2）' },
  { id: 'en·applied by the loader', re: /applied by the loader/i, why: '解释应用机制', source: '第一次反馈 2026-09-19：解释性段落（三类见 DESIGN §12.2）' },
  // 类 2：结构说明 —— "都在这一个入口里""和某处是同一份文档""插件本体在别处管理"
  { id: 'zh·都在这一个入口里', re: /这一个入口/, why: '说明模块结构', source: '第一次反馈 2026-09-19：解释性段落（三类见 DESIGN §12.2）' },
  { id: 'zh·同一份…文档', re: /同一份[^。]{0,12}文档/, why: '说明模块结构', source: '第一次反馈 2026-09-19：解释性段落（三类见 DESIGN §12.2）' },
  { id: 'zh·插件本体在官方插件页管理', re: /在官方插件页管理/, why: '说明模块结构', source: '第一次反馈 2026-09-19：解释性段落（三类见 DESIGN §12.2）' },
  { id: 'en·in one entry', re: /in one entry/i, why: '说明模块结构', source: '第一次反馈 2026-09-19：解释性段落（三类见 DESIGN §12.2）' },
  { id: 'en·same official … document', re: /same official[^.]{0,24}document/i, why: '说明模块结构', source: '第一次反馈 2026-09-19：解释性段落（三类见 DESIGN §12.2）' },
  { id: 'en·official Plugins page', re: /official\s+plugins?\s+page/i, why: '说明模块结构', source: '第一次反馈 2026-09-19：解释性段落（三类见 DESIGN §12.2）' },
  // 类 3：自夸 / 保证 —— 做到了自然看得见，写出来是噪声
  { id: 'zh·如实标注', re: /如实标注/, why: '做到了自然看得见', source: '第一次反馈 2026-09-19：解释性段落（三类见 DESIGN §12.2）' },
  { id: 'zh·绝不静默', re: /绝不静默/, why: '做到了自然看得见', source: '第一次反馈 2026-09-19：解释性段落（三类见 DESIGN §12.2）' },
  { id: 'zh·展开证据', re: /展开证据/, why: '点了就知道', source: '第一次反馈 2026-09-19：解释性段落（三类见 DESIGN §12.2）' },
  { id: 'en·marked as skipped', re: /marked as skipped/i, why: '做到了自然看得见', source: '第一次反馈 2026-09-19：解释性段落（三类见 DESIGN §12.2）' },
  { id: 'en·unfolds its evidence', re: /unfolds its evidence/i, why: '点了就知道', source: '第一次反馈 2026-09-19：解释性段落（三类见 DESIGN §12.2）' },
  // ── 第二次反馈（2026-09-19 用户逐条举例）：§12.3.1 的四类 ──────────────────────
  // 规则2：解释设计意图（把不言自明的默认行为写成句子）
  { id: 'zh·默认…', re: /^默认[^。]{0,24}[。；]/, why: '解释设计意图：打开就是当前环境，选择器也看得见',
    source: '第二次反馈 2026-09-19 实例2 原文：默认诊断当前环境；选中其他环境后本页只读' },
  { id: 'en·Defaults to…', re: /^Defaults? to\b/i, why: '解释设计意图',
    source: '第二次反馈 2026-09-19 实例2 英文对应句：Defaults to the current environment…' },
  { id: 'zh·…即可', re: /即可/, why: '意图说明句式（把动作讲成理所当然）',
    source: '第二次反馈 2026-09-19 §12.4 点名的句式（当前语料无命中，防回归）' },
  { id: 'en·just …', re: /\bjust (click|run|use|open|install)\b/i, why: '意图说明句式',
    source: '第二次反馈 2026-09-19 §12.4 点名的句式（防回归）' },
  { id: 'zh·…一条不少', re: /(一条不少|一条不漏|绝不遗漏|一个不少)/, why: '保证式收尾：做到了自然看得见',
    source: '第二次反馈 2026-09-19 实例3 原文：同类发现已归并为 3 组（共 3 条，逐条证据一条不少）' },
  { id: 'en·still listed', re: /(every piece of evidence|still listed|nothing (?:is )?omitted)/i, why: '保证式收尾',
    source: '第二次反馈 2026-09-19 实例3 英文对应句：…every piece of evidence is still listed' },
  { id: 'zh·不言自明', re: /(不言自明|显而易见)/, why: '解释设计意图',
    source: '第二次反馈 2026-09-19 §12.4 点名的句式（防回归）' },
  // 规则3：状态写成句子（状态要用界面标记表达）
  { id: 'zh·本页只读', re: /本页[^。]{0,8}只读/, why: '状态写成句子：应当换成界面标记（Tag/Badge）',
    source: '第二次反馈 2026-09-19 实例2 原文：…选中其他环境后本页只读' },
  { id: 'en·this page read-only', re: /this page[^.]{0,16}read-only/i, why: '状态写成句子',
    source: '第二次反馈 2026-09-19 实例2 英文对应句：…this page read-only' },
  // 规则4：总结后的括注（重复计数 / 保证式收尾）
  { id: 'zh·括注重复计数', re: /（[^）]{0,24}(共|合计|总计)[^）]{0,24}）/, why: '括注重复计数：组头已经有计数',
    source: '第二次反馈 2026-09-19 实例3 原文：（共 3 条，…）' },
  { id: 'en·parenthetical total', re: /\([^)]{0,40}\b(in total|altogether)\b[^)]{0,40}\)/i, why: '括注重复计数',
    source: '第二次反馈 2026-09-19 实例3 英文对应句：（{count} findings in total…）' },
  { id: 'zh·括注保证式收尾', re: /（[^）]{0,40}(一条不少|一条不漏|绝不遗漏|不会漏)/, why: '括注里的保证式收尾',
    source: '第二次反馈 2026-09-19 实例3 原文：（…逐条证据一条不少）' },
  { id: 'en·parenthetical guarantee', re: /\([^)]{0,60}(every piece of evidence|nothing omitted|not a single)/i, why: '括注里的保证式收尾',
    source: '第二次反馈 2026-09-19 实例3 英文对应句' },
]

/**
 * 规则1 的元素清单（DESIGN §12.4 的校准版）：intro 里出现 ≥3 个**界面上已经渲染的元素名**即失败。
 *
 * 为什么不是「≥3 个顿号」：`满分 100；可自动修复扣 5 分，需确认扣 10 分，只报告扣 20 分。` 同样枚举了三个名字，
 * 但它给出的是**新信息**（各档扣多少分）——用户反对的是「把屏幕上已有的东西再念一遍」，不是顿号本身。
 * 所以判据落在「这些名字本身是不是已经作为元素渲染在同一页」。每项都必须写 `where`（渲染点）；
 * 写不清渲染点的不要往清单里加（否则护栏会退化成凭空的洁癖，§12.4）。
 */
const RENDERED_ELEMENT_NAMES = [
  { zh: '依赖', en: 'dependencies', where: '体检页分层网格逐格渲染（ConsolePage 的 LAYER_ORDER.map → t(LAYER_LABEL[...])），设置页「诊断分层」也逐行渲染同一个名字' },
  { zh: '组合', en: 'composition', where: '同上：体检页分层网格 / 设置页诊断分层行' },
  { zh: '运行时', en: 'runtime', where: '同上：体检页分层网格 / 设置页诊断分层行' },
  { zh: '一致性', en: 'consistency', where: '同上：体检页分层网格 / 设置页诊断分层行' },
  { zh: '生态', en: 'ecosystem', where: '同上：体检页分层网格 / 设置页诊断分层行' },
  { zh: '插件', en: 'plugins', where: '市场页「类型」筛选器的选项，以及每张卡片上的类型标签（market.kind.* / market.type.*）' },
  { zh: '技能', en: 'skills', where: '同上：市场页类型筛选器 / 卡片类型标签' },
  { zh: '预设', en: 'presets', where: '同上：市场页类型筛选器 / 卡片类型标签' },
  { zh: '可自动修复', en: 'auto-fixable', where: '体检页问题分组标记（severity.safe-fix 渲染成 Tag）' },
  { zh: '需确认', en: 'needs confirmation', where: '体检页问题分组标记（severity.confirm-fix）' },
  { zh: '只报告', en: 'report only', where: '体检页问题分组标记（severity.report-only）' },
  { zh: '健康分', en: 'health score', where: '体检页分数卡标题（health.score）' },
  { zh: '证据', en: 'evidence', where: '问题卡「证据」区标签（health.evidence）' },
  { zh: '涉及对象', en: 'subjects', where: '问题卡「涉及对象」区标签（health.subjects）' },
]

/**
 * 找出一条文案里「枚举到的、界面上已渲染的元素名」。
 *
 * 按「、，,；;」切成枚举段再逐段比对（而不是全文子串匹配）：`本插件安装过的 SKILL.md 与 agent.cordis.yml 资源。`
 * 里的「插件」只算 1 次命中，不会因为一句话提到一次插件就判成枚举。
 * @param value - 一条文案。
 * @param lang - 'zh' 或 'en'。
 * @returns 命中的清单项（含 where 渲染点）。
 */
function enumeratedRenderedNames(value, lang) {
  const segments = String(value).split(/[、，,；;]/).map(segment => segment.trim().toLowerCase())
  return RENDERED_ELEMENT_NAMES.filter(item => segments.some(segment => segment.includes(item[lang].toLowerCase())))
}

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
    const raw = match[2]
    // 只把「值是字符串字面量」的行当文案条目：declare module 里的 `'命名空间': KeyType` 不是文案。
    const literal = raw.startsWith("'") || raw.startsWith('"')
    // 正则把值连同外层引号一起抓了进来；断言必须看**去掉引号的内容**——
    // 否则 `^默认…` 这类锚定句首的规则在源码扫描里永远不命中（2026-09-19 由变异验证发现）。
    const quote = raw[0]
    const body = raw.endsWith(',') ? raw.slice(0, -1) : raw
    const value = literal && body.endsWith(quote) ? body.slice(1, -1) : raw
    out.push({ line: index + 1, key: match[1], value, raw, text: lines[index], literal })
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
    const wrapped = entries.filter(entry => !entry.raw.endsWith(','))
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

  it('规则1：intro 不得枚举界面上已渲染的元素名（第二次反馈实例1）', () => {
    const dict = dictionaries()
    const introKeys = Object.keys(dict.zh).filter(key => key.endsWith('.intro'))
    assert.ok(introKeys.length > 0, '字典里一个 *.intro 都没有，本用例会退化成空转')
    const offenders = []
    for (const key of introKeys) {
      for (const lang of ['zh', 'en']) {
        const hits = enumeratedRenderedNames(dict[lang][key], lang)
        if (hits.length >= 3) {
          offenders.push(lang + ' ' + key + '：枚举了 ' + hits.length + ' 个界面上已渲染的元素名 —— '
            + hits.map(hit => hit[lang] + '（渲染在：' + hit.where + '）').join('；')
            + '；原文：' + String(dict[lang][key]))
        }
      }
    }
    assert.deepEqual(offenders, [],
      'intro 把屏幕上已经渲染的东西又念了一遍（DESIGN §12.4 规则1；用户第二次反馈实例1「五层诊断：依赖、组合、运行时、一致性、生态」）：\n'
      + offenders.join('\n'))
  })

  it('规则1 的边界：枚举 + 新信息不算「把屏幕念一遍」（health.scoreHint 反例，Lead 指定永久保留）', () => {
    const dict = dictionaries()
    // 事实：这条文案**确实**枚举了三个界面上已渲染的名字（严重度 Tag：可自动修复 / 需确认 / 只报告）……
    const hits = enumeratedRenderedNames(dict.zh['health.scoreHint'], 'zh')
    assert.ok(hits.length >= 3, '反例失效：scoreHint 不再枚举严重度名，请更新这条边界样本')
    // ……但它不是页面级介绍（不是 .intro），而且给出的是屏幕上**没有**的新信息（各档扣几分）——
    // 所以规则1 不该拦它。这正是规则1 按「界面上已渲染的元素名」而不是按「顿号数量」实现的原因（DESIGN §12.4 校准）。
    assert.ok(!Object.keys(dict.zh).filter(key => key.endsWith('.intro')).includes('health.scoreHint'),
      'health.scoreHint 不该变成 intro：它承载的是计分规则，不是页面介绍')
  })

  it('规则3 放行「标记」只拦「句子」——task-48 的「只读」标记不会被误伤', () => {
    // 用户第二次反馈要的是「状态改成标记」，不是「不许说状态」：
    // 所以标记形态（Tag 的文案）必须放行，句子形态（把状态讲成一件事）必须拦下。
    const markers = ['只读', 'Read-only', 'Read only', '非当前环境']
    const sentences = ['选中其他环境后本页只读。', 'This page is read-only for other environments.']
    for (const value of markers) {
      const hits = FORBIDDEN.filter(rule => rule.re.test(value)).map(rule => rule.id)
      assert.deepEqual(hits, [], '标记型文案被误伤了（task-48 要用）：' + value + ' 命中 ' + hits.join(', '))
    }
    const missed = sentences.filter(value => !FORBIDDEN.some(rule => rule.re.test(value)))
    assert.deepEqual(missed, [], '状态句漏拦了（状态应当由标记表达，不是写成句子）：' + missed.join(' / '))
  })

  it('每条禁止项都写明了来源（哪次反馈 / 用户原文 / 日期）', () => {
    const missing = FORBIDDEN.filter(rule => typeof rule.source !== 'string' || rule.source.trim() === '')
    assert.deepEqual(missing.map(rule => rule.id), [],
      '这些禁止项没写来源——后来人只会把它当成洁癖（DESIGN §12.4：注明它来自哪次真实反馈）')
    assert.ok(FORBIDDEN.length >= 25, '禁止项少于 25 条，像是被误删了：' + FORBIDDEN.length)
  })
})

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
 * host 侧用户可见文案的真源（DESIGN §12.6）。
 *
 * 为什么需要它：本文件原本只扫客户端字典，**host 侧输出零护栏**——于是 2026-09-19 第三轮
 * 反馈里那段「安装失败：…回滚失败（not-removable）…但**没有进入组合层栈**（dsh.profile.bundles = […]）…」
 * 一路绿灯上了屏。客户端字典管不到 host 拼出来的字符串，两处必须各有一条护栏。
 */
const HOST_SOURCES = ['src/envManager.ts', 'src/index.ts', 'src/upgrade.ts']

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
  // ── 第三次反馈（2026-09-19）：§12.3.2「指路式引导」────────────────────────────
  // 判据：被指的那个控件**就在同一屏上可见**时，不要再把操作路径写成句子（引导式交互，不是纯介绍）。
  // 纪律（Lead 2026-09-19 裁定）：每条命中的控件可见性都要给出源码位置证据；控件不可见时该句保留并作为反例。
  { id: 'zh·指路式引导（写操作路径）', re: /(先用|请用|点击|请点|点一下|按一下)「[^」]{2,12}」/, why: '控件就在同一屏可见，操作路径不写成句子',
    source: '用户第三轮反馈 2026-09-19（DESIGN §12.3.2 指路式引导），两条实例：①尚未读入备份文件；先用「导出备份」生成，或导入一个已有的 JSON。②尚未体检。点击「开始体检」生成报告。' },
  { id: 'en·指路式引导（Run/Click the X）', re: /\b(Run|Click|Use|Press|Open) the [A-Za-z][A-Za-z' -]{2,24}\b (to|button|tab|dialog|menu)\b/i, why: '同上（英文）',
    source: '同上，实例②的英文对应句：No report yet. Run the check-up to generate one.' },
  { id: 'en·指路式引导（export/import one）', re: /\b(export|import) (one|an existing|it first)/i, why: '同上（英文）',
    source: '同上，实例①的英文对应句：No backup loaded yet; export one first, or import an existing JSON file.' },
]

/**
 * 规则5（指路式引导）的**允许项**——永久反例，与 `health.scoreHint` 那条同构。
 *
 * 判据（§12.3.2）：只有「目标入口在屏幕上**可见且可点**」的指路才该删。下面这条指向的是
 * **操作系统里的另一个窗口**（不在本屏、本屏不可点），而且它所在分支（日志缺失）里是**唯一**的信息来源，
 * 所以必须留——它和「控件就在同屏」的指路句是两类，不能按形态一刀切。
 * 来源：Lead 2026-09-19 指定永久保留（task-79），理由同上。
 */
const GUIDE_ALLOWED = [
  {
    file: 'src/envManager.ts',
    text: '请看刚打开的终端窗口里 dsh 的输出。',
    because: '目标是另一个窗口、本屏不可点，且是日志缺失分支唯一的信息来源（§12.3.2 判据不满足）',
  },
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

// ── host 侧护栏（DESIGN §12.6，2026-09-19 第三轮反馈）────────────────────────

/**
 * host 侧用户可见文案的提取器：剥注释 → 取字符串字面量 → 只留含中文的那些。
 *
 * 为什么必须剥注释：`src/envManager.ts` 的注释里大量出现 `dsh.profile.bundles` / `reconcile`
 * 这类词——它们是**给维护者看的**，本来就该写清楚。护栏要拦的是「发给用户的字符串」，
 * 不是「代码里提到过这个词」。剥注释让规则只在真正的文案上生效，否则规则会退化成
 * 「不许在代码里提这个术语」，那是洁癖（§12.4）。
 *
 * 判据「含中文」的理由：host 侧的面向用户文案目前全是中文（客户端字典才管 i18n）；
 * 纯英文/标识符字面量（'add'、'remove'、'package.json' 这类传给官方通道的参数）
 * 不是文案，不该被词表误伤。
 *
 * @param file - 源文件相对路径。
 * @returns 文案条目（行号 + 内容）。
 */
function hostUserStrings(file) {
  const out = []
  let inBlock = false
  const lines = readFileSync(file, 'utf8').split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index]
    if (inBlock) {
      const end = line.indexOf('*/')
      if (end < 0) continue
      line = line.slice(end + 2)
      inBlock = false
    }
    for (;;) {
      const start = line.indexOf('/*')
      if (start < 0) break
      const end = line.indexOf('*/', start + 2)
      if (end < 0) { line = line.slice(0, start); inBlock = true; break }
      line = line.slice(0, start) + line.slice(end + 2)
    }
    const comment = line.indexOf('//')
    if (comment >= 0) line = line.slice(0, comment)
    for (const match of line.matchAll(/'([^']*)'|"([^"]*)"/g)) {
      const value = match[1] ?? match[2] ?? ''
      if (!/[\u4e00-\u9fff]/.test(value)) continue
      out.push({ line: index + 1, value })
    }
  }
  return out
}

/**
 * host 侧禁止词表（DESIGN §12.6）。每条都写 why 与 source，理由同 §12.4：
 * 后来人要知道它为什么被禁，而不是把它当成一条凭空的洁癖。
 *
 * 与客户端词表分开维护：客户端那边管「文案不该讲什么」，这边管「实现词汇不该上屏」——
 * 两类问题的修法不同（前者删句，后者换词），混在一张表里会让后来人分不清该改哪边。
 */
const HOST_FORBIDDEN = [
  // ── 规则 H1：字面 ** （DESIGN §3.6 陷阱 #1；task-55/71 已清过客户端一批）──────
  { id: 'host·字面星号', re: /\*\*/, why: 'web 上会显示成可见星号；本仓库一律用「」或直接陈述，不用 markdown 强调',
    source: '第三轮反馈 2026-09-19 用户实拍原文：但**没有进入组合层栈**（dsh.profile.bundles = [...]）—— 这段由 host 侧守卫输出，客户端字典护栏扫不到它' },
  // ── 规则 H2：内部术语上屏 ────────────────────────────────────────────────
  { id: 'host·dsh.profile.bundles', re: /dsh\.profile\.bundles/, why: '官方清单文件的字段路径，是实现细节；用户要知道的是「会不会被加载」，不是字段叫什么',
    source: '第三轮反馈 2026-09-19 实拍原文：（dsh.profile.bundles = ["@deepseek-ai/dsh-base", ...]）' },
  { id: 'host·reconcile', re: /reconcile/, why: '官方内部函数名；用户关心「为什么没生效」，不是它由哪个函数决定',
    source: '第三轮反馈 2026-09-19 实拍原文：官方 reconcile 会跳过"既有的"依赖' },
  { id: 'host·beforeDeps', re: /beforeDeps/, why: '内部变量名，纯实现词汇',
    source: 'DESIGN §12.6（本轮新增清单）：第三轮反馈同类问题的通例' },
  { id: 'host·官方错误码', re: /\b(?:not-removable|management-required|stop-profile|bundle-in-use)\b/, why: '官方内部错误码；要么翻成人话，要么只在结果对象的 error 字段里保留原文（排查时读得到）',
    source: '第三轮反馈 2026-09-19 实拍原文：回滚失败（not-removable）' },
  { id: 'host·node_modules 路径语义', re: /node_modules\s*[：:]/, why: '把安装目录当句子主语（"node_modules：仍留有…"）是路径语义上屏；用户看到的是「安装残留」，不是目录名',
    source: '第三轮反馈 2026-09-19 实拍原文：node_modules：仍留有 dsh-probe-block 的目录。需要时请手工删除它。' },
  { id: 'host·dsh.bundle 字段', re: /dsh\.bundle/, why: '清单字段名；用户需要的是「它不是一个组合包」这个结论',
    source: 'DESIGN §12.6（本轮新增清单）：与 dsh.profile.bundles 同类' },
  { id: 'host·installAnchor 等 API 名', re: /installAnchor|profileContext|ctx\./, why: '内部 API 名；用户要知道的是「为什么做不了」，不是哪个服务取不到',
    source: 'Lead 复核 task-85 时发现（升级路径渲染输出实测命中）：拿不到官方 installAnchor（ctx.profileContext.installAnchor）' },
  { id: 'host·括号套括号的长句', re: /（[^）]{6,}（[^）]{4,}）[^）]{0,20}）/, why: '一层括号里再套一层括号，读者要拆两遍；先把结论说完，细节另起一行',
    source: 'Lead 复核 task-85 时发现（升级路径渲染输出实测命中）：无法试装：官方安装通道不可用（拿不到…（ctx.profileContext.installAnchor）：…）' },
  // ── 规则 H3：同一行里堆三个状态（结论 + 回滚状态 + 包名…）──────────────────
  // 形态判据（可判定）：**同一行**里出现「≥2 个冒号」且至少有一个逗号。
  // 为什么是形态而不是语义："同一件事说三遍"没有可靠的语义判据，但"三个状态短语用逗号硬拼成
  // 一行"有——它正是用户实拍里那一行的样子（安装失败：…，回滚失败（…）包名：…）。
  // 分层写法（结论一行、状态一行、细节降到下面）天然不满足它，所以正例不会被误伤。
  { id: 'host·一句堆三个状态', re: /^(?=[^\n]*：[^\n]*：)(?=[^\n]*，)/m,
    why: '三个状态短语用逗号硬拼成一行（结论＋回滚状态＋包名），读者要自己拆句子才知道发生了什么；应当分层：第一行给结论与后果，细节降到下面',
    source: '第三轮反馈 2026-09-19 实拍原文：安装失败：无法试装（不算通过），回滚失败（not-removable）dsh-probe-block：…' },
]

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

  it('规则5（指路式引导）的边界：只拦「把同屏控件写进句子」，不碰用户查不到的后果与参数', () => {
    const dict = dictionaries()
    const rule = FORBIDDEN.find(item => item.id === 'zh·指路式引导（写操作路径）')
    assert.ok(rule !== undefined, '指路式引导规则不见了')
    // 命中面（用户第三轮的两条实例）
    for (const value of ['尚未读入备份文件；先用「导出备份」生成，或导入一个已有的 JSON。', '尚未体检。点击「开始体检」生成报告。']) {
      assert.ok(rule.re.test(value), '这条指路句必须被拦下：' + value)
    }
    // 反例面：这些是用户**查不到**的后果/参数说明，不引同屏控件，必须放行（否则规则会退化成凭空的洁癖）
    for (const key of ['config.marketplace.indexUrlHint', 'env.removeDesc', 'kinds.uninstallDesc', 'health.scoreHint']) {
      assert.ok(!rule.re.test(dict.zh[key]), '不该拦下「' + key + '」：' + dict.zh[key])
    }
  })

  it('规则5 的允许项：本屏不可点的「另一处窗口」不是指路式引导（task-79 永久反例）', () => {
    const rule = FORBIDDEN.find(item => item.id === 'zh·指路式引导（写操作路径）')
    assert.ok(rule !== undefined, '指路式引导规则（规则5）不见了')
    // 清单必须显式且恰好是这些项：删条目、加条目都要回到 §12.3.2 判据重新裁定，
    // 不能靠动清单让测试变绿（task-79 的变异验证打的就是这一条）。
    assert.deepEqual(GUIDE_ALLOWED.map(item => item.text), ['请看刚打开的终端窗口里 dsh 的输出。'],
      '允许项清单被改动：任何增删都要重新裁定，不能靠删条目让护栏变绿')
    for (const item of GUIDE_ALLOWED) {
      // ① 允许项必须仍在源文件里：它被删/改写时，这里先红，逼人来重新裁定（而不是悄悄消失）
      const source = readFileSync(item.file, 'utf8')
      assert.ok(source.includes(item.text), '允许项已不在 ' + item.file + '：' + item.text)
      // ② 规则不该误伤它（判据：目标不在本屏、本屏不可点）
      assert.ok(!rule.re.test(item.text), '允许项被误伤：' + item.text + '（依据：' + item.because + '）')
    }
    // ③ 同屏可见的指路必须仍被拦下——否则「允许项」会退化成漏网
    assert.ok(rule.re.test('点击「开始体检」生成报告。'), '同屏控件的指路句必须仍被拦下')
  })

  // ── host 侧护栏（DESIGN §12.6，第三轮反馈 2026-09-19）────────────────────────

  it('host 侧用户可见文案零命中禁止词表（字面 ** / 内部术语）', () => {
    const hits = []
    for (const file of HOST_SOURCES) {
      for (const entry of hostUserStrings(file)) {
        for (const rule of HOST_FORBIDDEN) {
          if (rule.re.test(entry.value)) {
            hits.push(file + ':' + entry.line + ' 命中【' + rule.id + '】（' + rule.why + '）：' + entry.value)
          }
        }
      }
    }
    assert.deepEqual(hits, [], 'host 侧仍有不该上屏的文案（DESIGN §12.6）：\n' + hits.join('\n'))
  })

  it('host 侧提取器不空转：真的扫到了文案（否则上面那条会假绿）', () => {
    for (const file of HOST_SOURCES) {
      const entries = hostUserStrings(file)
      assert.ok(entries.length >= 5, file + ' 只扫到 ' + entries.length + ' 条中文文案，提取器可能坏了')
    }
    // 提取器必须**剥掉注释**：注释里合法地写着 dsh.profile.bundles / reconcile（给维护者看的）。
    // 若不剥注释，规则会退化成「不许在代码里提这个术语」——那是洁癖，不是文案标准。
    const env = hostUserStrings('src/envManager.ts')
    assert.ok(!env.some(entry => entry.value.includes('beforeDeps')),
      '提取器把注释里的 beforeDeps 也当成文案了：规则会误伤注释')
  })

  it('规则 H1/H2 的正反例：第三轮反馈那段实拍原文必须被拦下', () => {
    // 反例 = 用户实拍原文（逐字）。它必须命中**至少**字面星号、dsh.profile.bundles、reconcile
    // 三条——这正是「三个问题同时出现」的那段。
    const realBanner = [
      '安装失败：无法试装（不算通过），回滚失败（not-removable）dsh-probe-block：无法试装：候选（dsh-probe-block）',
      '装进了 node_modules，但**没有进入组合层栈**（dsh.profile.bundles = ["@deepseek-ai/dsh-base",',
      '"@deepseek-ai/dsh-web-app","dsh-plugin-manager-companion"]）——挂载期不会加载它。原因：它在本轮之前',
      '就已经是测试环境的依赖，官方 reconcile 会跳过"既有的"依赖。这不等于通过。package.json：依赖声明仍在，',
      '层栈已不含 dsh-probe-block。node_modules：仍留有 dsh-probe-block 的目录。需要时请手工删除它。',
    ].join('\n')
    const hitIds = HOST_FORBIDDEN.filter(rule => rule.re.test(realBanner)).map(rule => rule.id)
    for (const must of ['host·字面星号', 'host·dsh.profile.bundles', 'host·reconcile', 'host·官方错误码', 'host·node_modules 路径语义']) {
      assert.ok(hitIds.includes(must), '实拍原文必须命中【' + must + '】，实际命中：' + hitIds.join(', '))
    }
    // 正例 = 改写后的文案（本轮真实输出），一条都不许命中。
    const rewritten = [
      '没有安装 dsh-probe-bad：候选包导致挂载失败。',
      '已回滚。',
      '候选包导致挂载失败：dsh-probe-bad 装进 webprobe-dpmc 之后树挂不起来。',
      '根因链：',
      'Error: dsh: plugin tree failed to load: duplicate loader entry id: probe-bad-row',
      '环境现状：',
      '  依赖声明与加载列表都已回到原状，也没有留下安装残留。',
    ].join('\n')
    const rewrittenHits = HOST_FORBIDDEN.filter(rule => rule.re.test(rewritten)).map(rule => rule.id)
    assert.deepEqual(rewrittenHits, [], '改写后的文案不该命中任何规则：' + rewrittenHits.join(', '))
  })

  it('规则 H3：三个状态用逗号硬拼成一行必须被拦下，分层呈现必须放行', () => {
    const rule = HOST_FORBIDDEN.find(item => item.id === 'host·一句堆三个状态')
    assert.ok(rule !== undefined, 'H3 规则不见了')
    // 反例（实拍原文的头部）：结论 + 回滚状态 + 包名，三个状态挤在一行
    assert.ok(rule.re.test('安装失败：无法试装（不算通过），回滚失败（not-removable）dsh-probe-block：无法试装：候选…'),
      '三个状态硬拼成一行必须被拦下')
    // 正例：分层（第一行结论，第二行回滚状态，空行后细节）——同一批事实，但一次只说一件事
    assert.ok(!rule.re.test('没有安装 dsh-probe-bad：候选包导致挂载失败。\n已回滚。\n\n候选包导致挂载失败：…'),
      '分层呈现被误伤了（H3 要拦的是「一行塞三个状态」，不是「说了状态」）')
    // 正例边界：一句里带两个逗号但不构成「三个状态 + 冒号」的说明句，必须放行
    assert.ok(!rule.re.test('依赖声明与加载列表都已回到原状，也没有留下安装残留。'),
      '普通说明句被误伤：' + '依赖声明与加载列表都已回到原状，也没有留下安装残留。')
  })

  // ── 规则 H4：**渲染出来的输出**也必须干净（源码扫描抓不到运行时拼接）────────────
  //
  // 为什么需要它（变异验证发现的两个洞）：源码里只扫「含中文的字符串字面量」，
  // 于是这两类改动会溜过去——
  //   · 官方错误码是**变量插进模板**的（'回滚失败（' + code + '）'），字面量里没有 not-removable；
  //   · 分层输出是**多行数组 join** 的，任何单个字面量都不含整段拼接后的文本。
  // 判据因此前移到「用户真正看到的那个字符串」：驱动一次真实的安装失败，拿 result.output 过同一张表。
  it('规则 H4：真实渲染出来的失败输出也必须过同一张表（源码扫描抓不到运行时拼接）', async () => {
    const { handleOp } = await import('../dist/index.js')
    const { mkdtempSync, mkdirSync: mk, writeFileSync: wr, rmSync: rm } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join: j } = await import('node:path')
    const home = mkdtempSync(j(tmpdir(), 'pmc-copy-'))
    const originalHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const envDir = j(home, 'profiles', 'copy-env')
      mk(j(envDir, 'node_modules'), { recursive: true })
      wr(j(envDir, 'package.json'), JSON.stringify({ name: 'p', dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, undefined, 2))
      wr(j(envDir, 'cordis.patch.yml'), '[]' + String.fromCharCode(10))
      const candidate = 'dsh-probe-copy'
      const pkgDir = j(envDir, 'node_modules', candidate)
      const manager = {
        inspect: async () => ({ status: 'ok' }),
        setPluginEnabled: async () => ({ application: 'applied', stage: 'enable', target: candidate, changed: true }),
        installBundle: async () => {
          const m = JSON.parse(readFileSync(j(envDir, 'package.json'), 'utf8'))
          m.dependencies = { ...(m.dependencies ?? {}), [candidate]: 'link:/probe-src' }
          wr(j(envDir, 'package.json'), JSON.stringify(m, undefined, 2))
          mk(pkgDir, { recursive: true })
          wr(j(pkgDir, 'package.json'), JSON.stringify({ name: candidate, version: '0.0.1', main: 'index.js' }))
          wr(j(pkgDir, 'index.js'), 'export const x = 1' + String.fromCharCode(10))
          return { application: 'applied', bundle: candidate, stage: 'install', target: candidate, changed: true }
        },
        setBundleEnabled: async () => ({ application: 'applied', stage: 'enable', target: candidate, changed: true }),
        // 官方移除**失败**——这正是用户实拍里那个「回滚失败（not-removable）」的场景。
        removeBundle: async () => ({ application: 'failed', error: { code: 'not-removable' }, stage: 'remove', target: candidate }),
        listBundles: async () => [{ name: '@deepseek-ai/dsh-base', installed: false, enabled: true }],
      }
      const ctx = {
        get(name) {
          if (name === 'pluginManager') return manager
          if (name === 'profileContext') return { name: 'copy-env', dir: envDir, installAnchor: '/anchor/package.json', cwd: tmpdir(), home }
          return undefined
        },
        logger: { info() {}, warn() {}, error() {} },
        effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
      }
      const jobs = new Map()
      let seq = 0
      const deps = {
        ctx,
        config: () => ({
          diagnostics: { dependency: true, composition: true, runtime: true, consistency: true, ecosystem: false },
          qualityGate: { enabled: true, mode: 'block', allowlist: [] },
          marketplace: { enabled: false, cacheTtlMinutes: 1440, timeoutMs: 15000, indexUrl: '' },
          trial: { enabled: true, depth: 'shallow', baseline: false, allowNetwork: true, onFailure: 'block', autoCleanup: true, retentionDays: 14, maxKept: 0 },
        }),
        configUpdate: async (patch) => patch,
        capabilities: () => ({ profileBacked: true, manager: true, inventory: false, environmentName: 'copy-env', missing: [] }),
        jobs: {
          start(task) { seq += 1; const id = 'job-' + String(seq); const rec = { done: false }; jobs.set(id, rec); void Promise.resolve().then(task).then((v) => { rec.result = v; rec.done = true }, (e) => { rec.error = String(e), rec.done = true }); return id },
          status(id) { const r = jobs.get(id); return r === undefined ? { done: true, missing: true } : { done: r.done, result: r.result, error: r.error } },
        },
        // 试装替身：候选坏 → block → 走回滚失败那条路（用户实拍的同一场景）。
        trial: async () => ({
          conclusion: 'candidate-broken', output: '候选包导致挂载失败（替身）',
          build: { artifactMd5: null, artifactMtime: null, gitHead: null },
          sourceFingerprint: { manifestHash: null, lockfileHash: null, patchHash: null, bundles: [], bundlesSource: 'manifest', dependencies: [], hash: 'x' },
          sourceFingerprintAfter: null, changedDuringTrial: false,
          baseline: { kind: 'mounted' }, candidate: { kind: 'failed' }, elapsedMs: 1, depth: 'shallow', escalated: false,
        }),
      }
      const started = await handleOp('install', { spec: '/probe-src', environment: 'copy-env' }, deps)
      assert.equal(started.ok, true)
      let settled
      for (let i = 0; i < 200; i += 1) {
        const st = await handleOp('job', { id: started.value.jobId }, deps)
        if (st.value.done === true) { settled = st.value; break }
        await new Promise((r) => setTimeout(r, 5))
      }
      const output = String(settled?.result?.output ?? '')
      assert.ok(output.length > 0, '没拿到渲染输出，这条用例会空转')
      const hits = HOST_FORBIDDEN.filter(rule => rule.re.test(output)).map(rule => rule.id)
      assert.deepEqual(hits, [], '渲染出来的输出命中了禁止项：' + hits.join(', ') + String.fromCharCode(10) + output)
      // 反向：这条用例必须真的走到了「回滚失败」那条路，否则它测的不是用户实拍那一幕。
      assert.match(output, /回滚没有完成/, '这条用例没走到回滚失败路径：' + output)
      assert.equal(settled.result.rolledBack, false)
    } finally {
      if (originalHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = originalHome
      rm(home, { recursive: true, force: true })
    }
  })


  // ── 规则 H4（升级路径）：同一条判据必须覆盖 upgrade 的渲染输出 ──────────────
  //
  // 为什么补这条（Lead 复核 task-85 时发现）：H4 原先只驱动「安装失败」一条路，
  // 而 upgrade 路径的 output 是**运行时拼装**的（installFacts 的多行 + 金丝雀未激活那段），
  // 于是 `dsh.profile.bundles` 从升级路径漏了出去——护栏一声不响。
  // 判据同 H4：拿用户真正看到的那个字符串过同一张表。
  it('规则 H4（升级路径）：升级与回滚的渲染输出也必须过同一张表', async () => {
    const { handleOp } = await import('../dist/index.js')
    const { mkdtempSync, mkdirSync: mk, writeFileSync: wr, rmSync: rm } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join: j } = await import('node:path')
    const home = mkdtempSync(j(tmpdir(), 'pmc-copy-up-'))
    const originalHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const envDir = j(home, 'profiles', 'up-env')
      mk(j(envDir, 'node_modules'), { recursive: true })
      // 依赖里已经有候选、但**启动列表里没有它**——正是"装完没进层栈"那种形态，
      // installFacts 会把两行事实都渲染出来（历史上这两行就带着字段路径）。
      wr(j(envDir, 'package.json'), JSON.stringify({
        name: 'p',
        dependencies: { 'dsh-probe-up': 'link:/probe-up' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
      }, undefined, 2))
      mk(j(envDir, 'node_modules', 'dsh-probe-up'), { recursive: true })
      wr(j(envDir, 'node_modules', 'dsh-probe-up', 'package.json'), JSON.stringify({ name: 'dsh-probe-up', version: '0.0.1' }))
      const ctx = {
        get(name) {
          if (name === 'profileContext') return { name: 'up-env', dir: envDir, installAnchor: '/anchor/package.json', cwd: tmpdir(), home }
          return undefined
        },
        logger: { info() {}, warn() {}, error() {} },
        effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
      }
      const jobs = new Map()
      let seq = 0
      const deps = {
        ctx,
        config: () => ({
          diagnostics: { dependency: true, composition: true, runtime: true, consistency: true, ecosystem: false },
          qualityGate: { enabled: true, mode: 'block', allowlist: [] },
          marketplace: { enabled: false, cacheTtlMinutes: 1440, timeoutMs: 15000, indexUrl: '' },
          trial: { enabled: true, depth: 'shallow', baseline: false, allowNetwork: true, onFailure: 'block', autoCleanup: true, retentionDays: 14, maxKept: 0 },
          upgrade: { autoCheck: false, interval: 'manual', registryUrl: '' },
        }),
        configUpdate: async (patch) => patch,
        capabilities: () => ({ profileBacked: true, manager: true, inventory: false, environmentName: 'up-env', missing: [] }),
        jobs: {
          start(task) { seq += 1; const id = 'job-' + String(seq); const rec = { done: false }; jobs.set(id, rec); void Promise.resolve().then(task).then((v) => { rec.result = v; rec.done = true }, (e) => { rec.error = String(e), rec.done = true }); return id },
          status(id) { const r = jobs.get(id); return r === undefined ? { done: true, missing: true } : { done: r.done, result: r.result, error: r.error } },
        },
        // 升级替身：走"金丝雀没能验证"那条路（历史上这里拼了 dsh.profile.bundles）。
        upgrade: {
          canary: async () => ({
            ran: true, conclusion: 'cannot-trial', depth: 'shallow', escalated: false, elapsedMs: 1,
            output: '金丝雀没能验证（不等于通过）：候选 dsh-probe-up 装完之后没有进入启动列表'
              + '——启动时不会加载它，这次验证没有验证到新版本。',
            cleanup: null,
            activation: { name: 'dsh-probe-up', bundles: ['@deepseek-ai/dsh-base'], activated: false, removedFirst: false, removeNote: '' },
          }),
          apply: async () => ({ ok: false, output: '没有升级 dsh-probe-up：金丝雀没能验证（不等于通过）。' }),
        },
      }
      const started = await handleOp('upgrade', { name: 'dsh-probe-up', version: '0.0.2', environment: 'up-env' }, deps)
      assert.equal(started.ok, true, '升级 op 没起来：' + JSON.stringify(started))
      let settled
      for (let i = 0; i < 200; i += 1) {
        const st = await handleOp('job', { id: started.value.jobId }, deps)
        if (st.value.done === true) { settled = st.value; break }
        await new Promise((r) => setTimeout(r, 5))
      }
      const output = String(settled?.result?.output ?? '')
      assert.ok(output.length > 0, '没拿到升级渲染输出，这条用例会空转')
      const hits = HOST_FORBIDDEN.filter(rule => rule.re.test(output)).map(rule => rule.id)
      assert.deepEqual(hits, [], '升级输出命中了禁止项：' + hits.join(', ') + String.fromCharCode(10) + output)
    } finally {
      if (originalHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = originalHome
      rm(home, { recursive: true, force: true })
    }
  })

  it('每条 host 禁止项都写明了来源（哪次反馈 / 用户原文 / 日期）', () => {
    const missing = HOST_FORBIDDEN.filter(rule => typeof rule.source !== 'string' || rule.source.trim() === '')
    assert.deepEqual(missing.map(rule => rule.id), [], '这些 host 禁止项没写来源（DESIGN §12.4）')
    assert.ok(HOST_FORBIDDEN.length >= 7, 'host 禁止项少于 7 条，像是被误删了：' + HOST_FORBIDDEN.length)
  })

  it('每条禁止项都写明了来源（哪次反馈 / 用户原文 / 日期）', () => {
    const missing = FORBIDDEN.filter(rule => typeof rule.source !== 'string' || rule.source.trim() === '')
    assert.deepEqual(missing.map(rule => rule.id), [],
      '这些禁止项没写来源——后来人只会把它当成洁癖（DESIGN §12.4：注明它来自哪次真实反馈）')
    assert.ok(FORBIDDEN.length >= 25, '禁止项少于 25 条，像是被误删了：' + FORBIDDEN.length)
  })
})

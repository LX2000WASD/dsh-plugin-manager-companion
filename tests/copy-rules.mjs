/**
 * copy-rules.mjs — DESIGN §12.9（R1–R7）的**可判定判据**（第五次反馈 2026-09-19）。
 *
 * 为什么是一个模块而不是散在测试里：同一批判据要被**两个驱动**用——
 *   · tests/ui-copy.test.mjs：扫客户端字典 + host 侧用户可见行 + H4（真实渲染输出）；
 *   · tests/upgrade-ui.test.mjs：扫**客户端结果块的真实渲染结果**（R1/R4/R6 的判据只有在那里才成立——
 *     结论紧随主语、结论只留一处、历史记录的时间性，都是"画出来之后"的性质）。
 * 两处各写一份会漂移，而漂移的护栏比没有护栏更糟（它让人以为已经守住了）。
 *
 * 每条规则都带 `negative`（必须被拦）与 `positive`（必须放行），**逐字取自 §12.9 或用户截图**；
 * 一条自检用例会把每条规则的 negative 喂进它自己的 judge，确保判据不是空转的。
 */

/**
 * R3 的内部代号表（§12.9 的对照表逐字实现）。
 *
 * `to` 是 §12.9 给的替换建议；它同时是"为什么这个词该换"的答案。
 */
export const INTERNAL_CODENAMES = [
  { re: /金丝雀/, term: '金丝雀', to: '试装验证 / 先验证一遍' },
  { re: /盘上事实/, term: '盘上事实', to: '当前状态' },
  { re: /挂载/, term: '挂载', to: '加载 / 起不来' },
  { re: /快照/, term: '快照', to: '环境副本' },
  { re: /层栈/, term: '层栈', to: '组合层' },
  { re: /锚点/, term: '锚点', to: '安装位置' },
]

/**
 * R7 的口语化词表（§12.9：用户原话"我们不是在与用户聊天"）。
 *
 * `一下` / `我们` 这类词在**说明性文字**里一律不用；`你可以…` 是第二人称闲聊。
 * 只用于面向用户的文案，不管注释与内部日志。
 */
export const COLLOQUIAL = [
  { re: /吧/, term: '吧' },
  { re: /呢/, term: '呢' },
  { re: /哦/, term: '哦' },
  { re: /一下/, term: '一下' },
  { re: /帮你/, term: '帮你' },
  { re: /你可以/, term: '你可以' },
  { re: /我们/, term: '我们' },
]

/**
 * 结论词（升级 / 回滚 / 未完成这几档；不追求穷举动词）。
 */
const CONCLUSION = /(?:已升级|没有升级|升级没有完成|升级失败|已回滚|没有回滚|回滚没有完成|回滚失败)/

/**
 * 包名（R1 的"主语"）。渲染结果里出现的是**真名**，所以按包名的两种形状认：
 * 带 scope 的 `@scope/name`，或不带 scope 但带 `dsh-` 前缀的名字。
 *
 * 为什么不放宽到"任意标识符"：那会把版本号、字段名、路径都当成主语，
 * 于是 `已安装，下次启动后加载。` 这类正常句也会被误伤（判据退化成"不许出现结论词"）。
 */
const PACKAGE_NAME = /@[a-z0-9][\w.-]*\/[\w.-]+|\bdsh-[\w.-]+/

/**
 * R1 的判据：**结论词排在主语之前**。
 *
 * 两种形态都要覆盖：
 *   · 字典面：文案里有 `{name}` 占位符 → 看结论词是否出现在它**之前**；
 *   · 渲染面：文案里已是真包名 → 看第一个包名之前有没有结论词。
 *
 * 为什么不是"行首是结论词就算违规"：那样 `已安装` 这种**标记**会被误伤——
 * 它根本不是句子，没有主语（`market.installed` 就是这种）。判据必须落在"与主语的位置关系"上，
 * 而 §12.9 R1 说的也正是位置关系（"结论词紧随主语，不要被别的词隔开"）。
 *
 * @param value - 文案原文（字典值或渲染结果）。
 * @returns 是否违规。
 */
function conclusionBeforeSubject(value) {
  return String(value).split(/\r?\n/).some((line) => {
    const placeholder = line.indexOf('{name}')
    const name = line.match(PACKAGE_NAME)
    const subject = placeholder >= 0 ? placeholder : (name === null ? -1 : name.index)
    if (subject < 0) return false
    const conclusion = line.match(CONCLUSION)
    return conclusion !== null && conclusion.index < subject
  })
}

/**
 * 原始命令输出的特征行（R5 用它判断"这段是不是贴出来的原始日志"）。
 *
 * 为什么按内容认而不是按位置认：日志块的内容由**外部工具**决定，我们只知道它长什么样；
 * 按位置认（"最后一段"）会在输出被截断或为空时静默放行。
 */
const RAW_LOG_LINE = /(?:Progress:\s*resolved|Lockfile passes|Packages:\s*\+|ERR_PNPM|Done in \d|reused \d+, downloaded)/

/**
 * R5 要求的标识行：必须点明这是**命令**的输出。
 */
const LOG_LABEL = /命令[^\n]*[：:]/

/**
 * "未验证"这类结论的**同义说法**。
 *
 * 为什么必须是同义集合而不是一个词：R4 的反例里，标签写「未验证」、下面重复的那句写的是
 * 「（没有验证新版本能否挂载）」——**同一个结论换了词**。只数字面词抓不到它
 * （变异 M-R4 第一次就是这么溜过去的：判据数 `未验证`，而重复句里根本没有那三个字）。
 */
const NOT_VERIFIED = /未验证|没有验证|未经验证|没验证/

/** 树状原因行（R2 的产物）自带的前缀：它们是**因果链**，不是结论句。 */
const REASON_TREE_MARK = /^\s*(?:→|->)/

/** 结论句的长度上限：结论是一句话，长的多半是在解释。 */
const CONCLUSION_MAX = 25

/**
 * 数一数这段文本里"未验证"这个**结论**说了几次（R4 的判据本体）。
 *
 * 为什么不能简单地数词：R2 之后，原因是一棵**树**，树里会合法地出现
 * 「→ 新版本能否加载未经验证」这种**解释**——它也含"未验证"，但它不是结论句。
 * 所以判据要区分"结论"与"解释"：
 *   · 结论句 = 含未验证类说法 ∧ 是短句（≤25 字）∧ 不是树状行；
 *   · 树状行（以 → 开头）一律不算。
 *
 * @param value - 一段用户可见的文本（可多行）。
 * @returns 结论句的条数（≥2 就是 R4 违规：同一件事说了两遍）。
 */
function notVerifiedConclusions(value) {
  // 先按**渲染边界**切：SSR 出来的 HTML 是一整行（`<p>甲</p><p>乙</p>`），
  // 只按 \n 切会把整段当成一句，长度必然超上限，于是判据静默失效
  // （变异 M-R4 第二次就是这么溜过去的——判据写好了，但根本没看到那两句话）。
  // 标签边界与换行都算句界：它们都代表"屏幕上另起一处"。
  const segments = String(value)
    .replace(/<[^>]*>/g, '\n')
    .split(/\r?\n/)
  return segments
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && NOT_VERIFIED.test(line))
    .filter((line) => !REASON_TREE_MARK.test(line))
    .filter((line) => line.length <= CONCLUSION_MAX)
    .length
}

/** 按行切（R2 是"同一行"的性质，不能整段判）。 */
const lines = (value) => String(value).split(/\r?\n/)

/**
 * §12.9 R1–R7 的规则表。
 *
 * 字段说明：
 *   · `id` / `title`：§12.9 的编号与小标题；
 *   · `judge(value)`：**true = 违规**；
 *   · `scope`：判据在哪几个面上成立（dict = 客户端字典、host = host 侧用户可见行、rendered = 真实渲染结果）；
 *   · `why`：这条为什么是噪声；
 *   · `source`：哪次反馈、用户原话（或原文片段）、日期；
 *   · `negative` / `positive`：逐字取自 §12.9 或用户截图的反例 / 正例。
 */
export const RESULT_BLOCK_RULES = [
  {
    id: 'R1',
    title: '结论紧随主语',
    scope: ['dict', 'rendered'],
    why: '两个结论（已升级 / 未验证）被包名隔开，读者要跳读才能把它们连起来',
    source: '第五次反馈 2026-09-19 实拍原文：已升级 @deepseek-ai/dsh-experimental-auto-review（这次没有验证）',
    negative: '已升级 @deepseek-ai/dsh-experimental-auto-review（这次没有验证）',
    positive: '@deepseek-ai/dsh-experimental-auto-review 已升级（未验证）',
    judge: (value) => conclusionBeforeSubject(value),
  },
  {
    id: 'R2',
    title: '原因不许冒号套冒号',
    scope: ['dict', 'host', 'rendered'],
    why: '一层冒号又一层冒号再套括号，读者要拆三遍；应当缩进/树状，一层一个因果',
    source: '第五次反馈 2026-09-19 用户原话"并行与分句，让人的理解很困难"；实拍原文：原因：试装总开关已关闭：未做金丝雀，直接升级（没有验证新版本能否挂载）',
    negative: '原因：试装总开关已关闭：未做金丝雀，直接升级（没有验证新版本能否挂载）',
    positive: ['原因：', '  试装总开关已关闭', '    → 直接升级，没有先验证', '      → 新版本能否加载未经验证'].join('\n'),
    judge: (value) => lines(value).some((line) => (line.match(/：/g) ?? []).length >= 2),
  },
  {
    id: 'R3',
    title: '禁止内部代号上屏',
    scope: ['dict', 'host', 'rendered'],
    why: '内部代号对用户没有意义（"金丝雀"的第一反应是"什么鸟"），用户要知道的是会发生什么',
    source: '第五次反馈 2026-09-19：本轮点名 金丝雀 / 盘上事实 / 挂载 / 快照 / 层栈 / 锚点；实拍原文：原因：试装总开关已关闭：未做金丝雀，直接升级（没有验证新版本能否挂载）',
    negative: '试装总开关已关闭：未做金丝雀，直接升级（没有验证新版本能否挂载）',
    positive: '试装总开关已关闭，直接升级，没有先验证新版本能否加载',
    judge: (value) => INTERNAL_CODENAMES.some((item) => item.re.test(String(value))),
  },
  {
    id: 'R4',
    title: '结论只留一处，原因只讲为什么',
    scope: ['rendered'],
    why: '标签已经写了结论，下面又说一遍同一件事；按 §12.5，结论由标签承载时下面只说原因',
    source: '第五次反馈 2026-09-19 实拍原文：标签写"未验证"，下面又写"（没有验证新版本能否挂载）"',
    negative: ['@x/y 已升级（这次没有验证）', '这次没有验证（不等于通过）'].join('\n'),
    positive: ['@x/y 已升级（未验证）', '原因：', '  试装总开关已关闭'].join('\n'),
    judge: (value) => notVerifiedConclusions(String(value)) >= 2,
  },
  {
    id: 'R5',
    title: '原始日志必须有标识',
    scope: ['host', 'rendered'],
    why: '原始输出中英混杂、没有出处，读者会以为那是我们的说明',
    source: '第五次反馈 2026-09-19 实拍原文：[WARN] Issues with peer dependencies found. Run "pnpm peers check" to list them.（直接贴出，无标识）',
    negative: ['Packages: +2', '++', 'Progress: resolved 2, reused 2, downloaded 0, added 2, done'].join('\n'),
    positive: ['命令输出（pnpm，官方安装通道）：', '  Progress: resolved 2, reused 2, downloaded 0, added 2, done'].join('\n'),
    judge: (value) => {
      const text = String(value)
      if (!RAW_LOG_LINE.test(text)) return false
      return !LOG_LABEL.test(text)
    },
  },
  {
    id: 'R6',
    title: '历史记录必须交代时间性',
    scope: ['dict', 'rendered'],
    why: '"上次"意味不明、有误导性；要明确这是历史记录，不是当前状态',
    source: '第五次反馈 2026-09-19 实拍原文：上次升级结果',
    negative: '上次升级结果',
    positive: '最近一次升级',
    judge: (value) => /上次/.test(String(value)) && /(升级|回滚)/.test(String(value)),
  },
  {
    id: 'R7',
    title: '产品文案不口语化',
    scope: ['dict', 'host', 'rendered'],
    why: '用户原话"我们不是在与用户聊天"；说明性文字用陈述句',
    source: '第五次反馈 2026-09-19 用户原话：我们不是在与用户聊天',
    negative: '你可以点一下升级，它会帮你搞定哦',
    positive: '升级会先验证新版本，通过后才会改动当前环境',
    judge: (value) => COLLOQUIAL.some((item) => item.re.test(String(value))),
  },
]

/**
 * 一条文案违反了哪些规则。
 *
 * @param value - 用户可见的文案（单条字典值 / 一行 host 输出 / 一整段渲染结果）。
 * @param scope - 在哪个面上判（dict / host / rendered）。
 * @returns 命中的规则 id（按 R1→R7 顺序）。
 */
export function violationsOf(value, scope) {
  return RESULT_BLOCK_RULES
    .filter((rule) => rule.scope.includes(scope))
    .filter((rule) => rule.judge(value))
    .map((rule) => rule.id)
}

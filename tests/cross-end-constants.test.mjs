/**
 * 跨端常量一致性（task-102）。
 *
 * ## 为什么需要这个文件
 *
 * 客户端（`src/client/wire.ts` / `shared.ts`）刻意**不 import** host 侧文件——那会把
 * schemastery 与整套 host 代码拉进浏览器包。所以有些常量**两边各写一份**，这是**有意的**。
 *
 * 但"有意各写一份"与"没人钉住一致性"是两件事。没有断言时，改一边不会红，而后果按严重度分三档：
 *
 * | 常量 | 漂移后果 |
 * |---|---|
 * | `ROUTE_PREFIX` / `REST_PREFIX` | **所有请求 404**（前缀对不上，路由根本不匹配） |
 * | `BACKUP_FORMAT` | **静默**：客户端认不出自己的备份文件，用户导入自己的备份却被告知「格式不符」 |
 * | `SETTINGS_NAMESPACE` | 设置读写失败，或文案取不到（三处必须同值） |
 *
 * ## 为什么是**源码级**断言（DESIGN §12.10 推论三）
 *
 * 客户端与 host 跑在**不同环境**：客户端是浏览器包（无 `node:fs`、无 `process`），
 * host 是 Node 进程。运行期断言跨不过这条边界——`import` 两侧的模块再比大小是不可能的。
 * 所以判据退到"**读两侧源码文本、正则取出常量值、断言逐字相等**"：
 * 它不运行任何一侧的代码，因此两端环境的差异与它无关。
 *
 * 这与 `tests/moduleFallback.test.mjs` 里那条 `CLIENT_DEFAULTS` 护栏同型（同一手法、同一理由）。
 *
 * ## 正反两向都要红
 *
 * 判据是"两侧逐字相等"，所以**改任何一侧都会红**——变异验证对每条都做了双向。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 读一个源文件。
 *
 * @param relative - 相对仓库根的路径。
 * @returns 文件全文。
 */
function source(relative) {
  return readFileSync(join(process.cwd(), relative), 'utf8')
}

/**
 * 从源码文本里取出一个**字符串常量**的值。
 *
 * 判据刻意写得**窄**（"声明名 + 等号 + 引号里的字面量"）：
 *   · 宽判据（例如只找那串字面量）会在**注释里提到它**时假通过——而两边注释里都写着对方的名字；
 *   · 窄判据要求"这一行真的是一条声明"，于是注释与文档不会污染它。
 *
 * 找不到时**抛错而不是返回 undefined**：那说明常量被改名或挪走了，
 * 这时护栏应当红（"我以为钉住了、其实钉在空气上"是更坏的情况，§7.13）。
 *
 * @param text - 源码全文。
 * @param name - 常量名。
 * @param where - 出错信息里的出处（文件路径）。
 * @returns 常量值。
 */
function constantValue(text, name, where) {
  // 允许 `export const X = 'v'` 与 `const X = "v"` 两种（host 用双引号、客户端用单引号）。
  const pattern = new RegExp('(?:export\\s+)?const\\s+' + name + '\\s*(?::[^=]+)?=\\s*[\'\"]([^\'\"]+)[\'\"]')
  const match = pattern.exec(text)
  assert.ok(match !== null,
    where + ' 里找不到常量 ' + name + ' 的声明——它被改名或挪走了？'
    + '（护栏必须跟着改，否则这条断言钉在空气上）')
  return match[1]
}

// ── 一、REST 路由前缀：漂移则所有请求 404 ──────────────────────────────────

test('路由前缀：host 的 ROUTE_PREFIX 与客户端的 REST_PREFIX 逐字相等', () => {
  // 两侧**常量名不同**（host 叫 ROUTE_PREFIX、客户端叫 REST_PREFIX）——名字不同没关系，
  // 值必须一样：客户端拿它拼 fetch 的 URL，host 拿它注册路由前缀，对不上就是 404。
  const host = constantValue(source('src/rest.ts'), 'ROUTE_PREFIX', 'src/rest.ts')
  const client = constantValue(source('src/client/shared.ts'), 'REST_PREFIX', 'src/client/shared.ts')
  assert.equal(client, host,
    '客户端 REST_PREFIX 与 host ROUTE_PREFIX 必须逐字相等（漂移则所有请求 404）：'
    + 'host=' + JSON.stringify(host) + ' client=' + JSON.stringify(client))
  // 顺带钉住值本身：它刻意避开旧仓库的 /api2/plugin-manager（两包可能短期共存）。
  assert.equal(host, '/api2/companion', '路由前缀本身变了？那要同时确认旧仓库共存那条约束还成立')
})

// ── 二、备份格式标识：漂移是**静默**的（最危险的一条）─────────────────────

test('备份格式：host 的 BACKUP_FORMAT 与客户端逐字相等', () => {
  // 这条最危险：漂移**不报错**，只是客户端认不出自己的备份文件——
  // 用户导入**自己刚导出的**备份，界面说「格式不符」。没有任何日志指向真正的原因。
  const host = constantValue(source('src/envManager.ts'), 'BACKUP_FORMAT', 'src/envManager.ts')
  const client = constantValue(source('src/client/wire.ts'), 'BACKUP_FORMAT', 'src/client/wire.ts')
  assert.equal(client, host,
    '客户端 BACKUP_FORMAT 与 host 必须逐字相等（漂移则用户导入自己的备份被拒，且无任何报错线索）：'
    + 'host=' + JSON.stringify(host) + ' client=' + JSON.stringify(client))
})

test('备份版本号：host 与客户端都认 1（两边各写一份，也必须同值）', () => {
  // 同一族：`version` 也是两边各写一份（host 写 1 并校验 `!== 1` 报错；客户端写 1 并校验 `!== 1` 丢弃）。
  // 漂移后果与 format 一样静默：客户端把 host 产出的备份判成"读不出来"。
  //
  // 判据用一个**收窄的锚点**取那一处 `version: N`，而不是全文第一个匹配——
  // 两份文件里都还有别的 `version`（包版本、缓存格式版本），全文取会取错。
  const versionNear = (relative, anchor) => {
    const text = source(relative)
    const at = text.indexOf(anchor)
    assert.ok(at >= 0, relative + ' 里找不到锚点 ' + JSON.stringify(anchor) + '（判据会空转）')
    const match = /version:\s*(\d+)/.exec(text.slice(at))
    assert.ok(match !== null, relative + ' 的 ' + JSON.stringify(anchor) + ' 之后找不到 version 字段')
    return match[1]
  }
  const host = versionNear('src/envManager.ts', 'format: BACKUP_FORMAT')
  const client = versionNear('src/client/wire.ts', 'format: BACKUP_FORMAT')
  assert.equal(client, host,
    '客户端与 host 的备份 version 必须同值（漂移则客户端判不出 host 产出的备份）：'
    + 'host=' + host + ' client=' + client)
  assert.equal(host, '1', '备份格式版本本身变了？那要同时确认两侧的校验分支都跟着改了')
})

// ── 三、settings 命名空间：**三处**必须同值 ────────────────────────────────

test('settings 命名空间：host / 客户端 / 字典 NS 三处逐字相等', () => {
  // 三处各写一份（host 用它注册 schema，客户端用它绑 settingsScope，locales 用它做字典键域）。
  // 漂移的后果分两种：命名空间对不上 → 设置读写失败；字典 NS 对不上 → 文案取不到（界面空白）。
  const host = constantValue(source('src/settings.ts'), 'SETTINGS_NAMESPACE', 'src/settings.ts')
  const client = constantValue(source('src/client/shared.ts'), 'SETTINGS_NAMESPACE', 'src/client/shared.ts')
  const ns = constantValue(source('src/client/locales.ts'), 'NS', 'src/client/locales.ts')
  assert.equal(client, host,
    '客户端 SETTINGS_NAMESPACE 与 host 必须逐字相等：'
    + 'host=' + JSON.stringify(host) + ' client=' + JSON.stringify(client))
  assert.equal(ns, host,
    '字典 NS 与 settings 命名空间必须逐字相等（漂移则文案取不到）：'
    + 'host=' + JSON.stringify(host) + ' NS=' + JSON.stringify(ns))
})

// ── 四、护栏本身不许空转（§7.13：判据要能真的取到值）───────────────────────

test('护栏自检：三处常量都**真的取到了值**（否则上面三条恒真）', () => {
  // 为什么要有这条：`constantValue` 的判据是正则。正则写错时它会取到**别的东西**
  // （或者抛错）——但若它恰好返回同一个错值给两侧，上面的断言就会"通过"。
  // 这里逐条断言"取到的是我预期的那个值"，把"判据空转"变成可见的失败。
  assert.equal(constantValue(source('src/rest.ts'), 'ROUTE_PREFIX', 'src/rest.ts'), '/api2/companion')
  assert.equal(constantValue(source('src/client/shared.ts'), 'REST_PREFIX', 'src/client/shared.ts'), '/api2/companion')
  assert.equal(constantValue(source('src/envManager.ts'), 'BACKUP_FORMAT', 'src/envManager.ts'),
    'dsh-plugin-manager-companion/environment-backup')
  assert.equal(constantValue(source('src/client/wire.ts'), 'BACKUP_FORMAT', 'src/client/wire.ts'),
    'dsh-plugin-manager-companion/environment-backup')
  assert.equal(constantValue(source('src/settings.ts'), 'SETTINGS_NAMESPACE', 'src/settings.ts'), 'plugin-manager-companion')
  assert.equal(constantValue(source('src/client/shared.ts'), 'SETTINGS_NAMESPACE', 'src/client/shared.ts'), 'plugin-manager-companion')
  assert.equal(constantValue(source('src/client/locales.ts'), 'NS', 'src/client/locales.ts'), 'plugin-manager-companion')
  // 反向：改名之后必须抛错，而不是静默返回 undefined（那样护栏会"钉在空气上"）。
  assert.throws(() => constantValue(source('src/rest.ts'), 'NO_SUCH_CONSTANT', 'src/rest.ts'),
    /找不到常量/, '常量不存在时必须抛错——静默返回 undefined 会让护栏空转')
})

// ── 五、判据的窄性：注释里提到这些名字不算声明（防止假通过）─────────────────

test('判据的窄性：只认声明行，注释里提到常量名不会让它假通过', () => {
  // 两侧的注释里都**写着对方的常量名**（例如客户端 shared.ts 的注释里提到 host 的 ROUTE_PREFIX）。
  // 若判据写成"在文件里找这个名字"，注释就会让它通过——而真正的声明可能已经漂移。
  // 这里用一个合成文本验证判据只认声明行。
  const text = '// 注释里提到 ROUTE_PREFIX = \'/api2/companion\'\nconst OTHER = 1'
  assert.throws(() => constantValue(text, 'ROUTE_PREFIX', '合成文本'),
    /找不到常量/, '注释里的名字不算声明——否则护栏会被注释骗过')
})

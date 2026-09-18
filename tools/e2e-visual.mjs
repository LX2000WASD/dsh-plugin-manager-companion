/**
 * e2e-visual — 真浏览器渲染冒烟：把 2026-09-19 那次视觉审计固化成可复跑的一条命令。
 *
 * 归属：A 类·重写（本轮审计用的 /tmp 一次性脚本没有保留价值，这里按同一套 CDP 机制重写）。
 * 旧实现参考：审计期的 tools/visual-audit.mjs 与 /tmp/vis-audit-run*.mjs（只取流程意图：
 *   叶子文本点击、探针取内容区文本、断言顺序；未复制代码）。
 * 官方复用：无 host 侧 API；浏览器侧只用 tools/cdp-shot.mjs（CDP 真机输入 + 截图）。
 * 前提检查：审计证明"单测 + SSR 全绿 ≠ 用户能用"（空白页 / 静默丢写都只在真浏览器暴露），
 *   所以本脚本的断言值全部取"用户可见事实"：内容区文本长度、slot 崩溃、HTTP 状态码、渲染量上界。
 *
 * 用法：
 *   node tools/e2e-visual.mjs --port 3099 --token <token> [--out /tmp/vis-e2e]
 *   node tools/e2e-visual.mjs --env-file /tmp/vis-e2e.env      # 内含 PORT= / TOKEN= / OUT=
 *   没有 --token 时按 --log（默认 /tmp/pm.log）里的 dsh 启动日志解析 token。
 *
 * 退出码：0 全通过 / 1 有断言失败 / 2 环境问题（实例没起、token 拿不到、Chrome 起不来）。
 *
 * 断言（共 16 条，自动判定，任一失败即退出码 1）：
 *   1  app-shell               应用能打开（非错误页）
 *   2  settings-sections       设置面板八个分区名齐全且顺序正确（含本插件三个）
 *   3  page-插件市场/环境控制台/技能与预设   三个一级页面内容区非空
 *   4  console-report          环境控制台落地即渲染体检报告（空白页 P0 的回归闸）
 *   5  console-体检/环境/设置    三个子页非空（阈值更严）
 *   6  config-switch-labels    配置页每个开关都有可见文字标签（P1 回归闸）
 *   7  config-no-false-warning 完整配置时不显示"部分配置字段"告警（P2 回归闸）
 *   8  official-list           官方插件页能打开且列出本插件卡片
 *   9  official-bundle-config  本插件详情页 plugins.bundle.config 配置面存在
 *  10  http-status             全程无 4xx/5xx
 *  11  slot-crash              全程无 slot 崩溃（"slot entry crashed"）
 *  12  marketplace-budget      市场渲染量在宽松上界内（P3 回归闸，见 task-10）
 * 只输出给人看的：截图目录与每个页面的一句话结论（NOTE 行 + e2e-visual.json）。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchChrome, openTab, evaluate, capture } from './cdp-shot.mjs'

// ── 参数 ───────────────────────────────────────────────────────────────────

/** 解析命令行参数（支持 --k v 与 --k=v）。 */
function parseArgv(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const eq = token.indexOf('=')
    if (eq > 0) { out[token.slice(2, eq)] = token.slice(eq + 1); continue }
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) { out[token.slice(2)] = next; i += 1; continue }
    out[token.slice(2)] = 'true'
  }
  return out
}

/** 读 --env-file（KEY=value 行）。 */
function readEnvFile(path) {
  const out = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq > 0) out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
  }
  return out
}

/**
 * 从 dsh 启动日志里取 token（token 可能含连字符）。
 * 日志不存在不是异常路径：调用方按"拿不到 token"报环境问题（退出码 2），而不是崩成非约定退出码。
 * @returns token；文件缺失或没有 token 行时 undefined。
 */
function tokenFromLog(path) {
  let text
  try { text = readFileSync(path, 'utf8') } catch { return undefined }
  const match = text.match(/token=([\w-]+)/)
  return match === null ? undefined : match[1]
}

/** 取数字参数，缺省时回落。 */
function numberArg(raw, fallback) {
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

const argv = parseArgv(process.argv.slice(2))
const envFile = argv['env-file'] === undefined ? {} : readEnvFile(argv['env-file'])
const port = Number(argv.port ?? envFile.PORT ?? '3099')
const outDir = argv.out ?? envFile.OUT ?? '/tmp/vis-e2e'
const logPath = argv.log ?? envFile.LOG ?? '/tmp/pm.log'
const token = argv.token ?? envFile.TOKEN ?? process.env.PM_TOKEN ?? tokenFromLog(logPath)

/** 断言阈值（--self-test 用：把 --min-content 调到不可能满足的值即可验证退出码 1）。 */
const MIN_CONTENT = numberArg(argv['min-content'], 80)
/** 子页阈值更严：空壳只有 ~150 字，真实子页内容 255~695 字（P0 空白时是 0）。 */
const MIN_SUBPAGE_CONTENT = numberArg(argv['min-subpage-content'], 200)
const MAX_DOM_NODES = numberArg(argv['max-dom-nodes'], 150_000)
const MAX_TEXT_LENGTH = numberArg(argv['max-text-length'], 4_000_000)
const MAX_HTML_LENGTH = numberArg(argv['max-html-length'], 12_000_000)
const WAIT_MS = numberArg(argv['wait-ms'], 30_000)

// 阈值必须是正数：写错（0 / 负数 / NaN）会让断言永远通过或永远失败，因此按环境问题拦下（退出码 2）。
for (const [name, value] of [['min-content', MIN_CONTENT], ['min-subpage-content', MIN_SUBPAGE_CONTENT], ['max-dom-nodes', MAX_DOM_NODES], ['max-text-length', MAX_TEXT_LENGTH], ['max-html-length', MAX_HTML_LENGTH]]) {
  if (!(typeof value === 'number' && Number.isFinite(value) && value > 0)) {
    console.error('阈值参数 --' + name + ' 非法：' + String(value) + '（必须是正数）')
    process.exit(2)
  }
}
const BASE = 'http://127.0.0.1:' + port + '/'

/** 环境问题：与断言失败区分开（退出码 2）。 */
class EnvironmentError extends Error {}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// ── 断言账本 ───────────────────────────────────────────────────────────────

const checks = []
/** 记一条断言结果。 */
function check(id, title, ok, detail) {
  checks.push({ id, title, ok, detail })
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  【' + id + '】' + title + (detail === undefined ? '' : ' — ' + detail))
  return ok
}
/** 只给人看的观察项（不参与退出码）。 */
function observe(text) { console.log('  NOTE  ' + text) }

// ── CDP 采集 ───────────────────────────────────────────────────────────────

const exceptions = []
const slotCrashes = []
const badResponses = []
const consoleErrors = []

/** 判断一段控制台文本是否是 slot 崩溃。 */
function isSlotCrash(text) { return text.includes('slot entry crashed') }

// ── 页面探针 ───────────────────────────────────────────────────────────────

/**
 * 页面探针：返回设置对话框（或 main/body）内叶子节点的去重文本与渲染量。
 * @returns 文本长度、去重文本、DOM 节点数、对话框内容区 html 长度。
 */
const PROBE = String.raw`(function(){
  var dlg = document.querySelector('[role=dialog]');
  var main = document.querySelector('main');
  var scope = dlg || main || document.body;
  var nodes = scope.querySelectorAll('*');
  var seen = new Set();
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    if (n.tagName === 'SCRIPT' || n.tagName === 'STYLE') continue;
    if (n.children.length > 0) continue;
    var t = (n.textContent || '').trim();
    if (t.length > 0) seen.add(t.slice(0, 160));
  }
  var text = [...seen].join('\n');
  var options = dlg ? dlg.querySelector('[class*=options]') : null;
  return JSON.stringify({
    scope: dlg ? 'dialog' : (main ? 'main' : 'body'),
    text: text,
    textLen: text.length,
    domNodes: document.querySelectorAll('*').length,
    optionsHTML: options ? options.innerHTML.length : null,
    optionsTextLen: options ? (options.innerText || '').trim().length : null
  });
})()`

/** 求值并解析探针结果。 */
async function probe(tab) {
  const raw = await evaluate(tab, PROBE)
  if (raw === undefined || raw === null) return { scope: 'none', text: '', textLen: 0, domNodes: 0, optionsHTML: null, optionsTextLen: null }
  return JSON.parse(raw)
}

/**
 * 轮询等待一个页面内谓词为真。
 * @param predicate - 在页面里求值的表达式（返回布尔）。
 * @returns 是否在超时前满足。
 */
async function waitFor(tab, predicate, timeoutMs = WAIT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await evaluate(tab, predicate).catch(() => false)
    if (ok === true) return true
    await sleep(300)
  }
  return false
}

/** 元素存在且可见。 */
const visible = (selector) => '!!(()=>{var n=document.querySelector(' + JSON.stringify(selector) + ');return n && n.offsetParent!==null})()'

/**
 * 用真实鼠标事件点一个「叶子文本」命中的元素（字符串拼接构造，避免模板嵌套）。
 * @param text - 叶子文本（精确匹配）。
 * @param scopeSel - 限定作用域的选择器，默认 body。
 * @returns 'CLICKED' | 'NOT_FOUND'。
 */
async function clickLeaf(tab, text, scopeSel) {
  const expr = '(function(){var scope=document.querySelector(' + JSON.stringify(scopeSel ?? 'body') + ')||document.body;'
    + 'var leaves=[...scope.querySelectorAll("*")].filter(function(n){return n.children.length===0 && (n.textContent||"").trim()===' + JSON.stringify(text) + ' && n.offsetParent!==null});'
    + 'if(leaves.length===0) return "NOT_FOUND";'
    + 'var t=leaves[0].closest("button,[role=button],[role=tab],a")||leaves[0];'
    + 't.scrollIntoView({block:"center"});var r=t.getBoundingClientRect();'
    + 'return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()'
  const raw = await evaluate(tab, expr).catch(() => 'NOT_FOUND')
  if (raw === 'NOT_FOUND' || raw === undefined) return 'NOT_FOUND'
  const box = JSON.parse(raw)
  const common = { x: box.x, y: box.y, button: 'left', clickCount: 1 }
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
  await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common })
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common })
  return 'CLICKED'
}

/**
 * 点一个带 aria-label 的元素（侧栏面板行 button[aria-label="插件"] 这类）。
 * 为什么不用叶子文本：侧栏面板行的可见文本在 span 里，而设置对话框的残留遮罩会挡住文本命中的坐标。
 * @returns 'CLICKED' | 'NOT_FOUND'。
 */
async function clickByAria(tab, aria) {
  const expr = '(function(){var b=[...document.querySelectorAll("button[aria-label],[role=button][aria-label]")].filter(function(n){return (n.getAttribute("aria-label")||"").trim()===' + JSON.stringify(aria) + '});'
    + 'if(b.length===0) return "NOT_FOUND";var t=b[0];t.scrollIntoView({block:"center"});var r=t.getBoundingClientRect();'
    + 'return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()'
  const raw = await evaluate(tab, expr).catch(() => 'NOT_FOUND')
  if (raw === 'NOT_FOUND' || raw === undefined) return 'NOT_FOUND'
  const box = JSON.parse(raw)
  const common = { x: box.x, y: box.y, button: 'left', clickCount: 1 }
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
  await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common })
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common })
  return 'CLICKED'
}

/**
 * 点一个"最内层包含该文本"的可点元素（插件卡片标题这类，文本可能带子节点）。
 * @returns 'CLICKED' | 'NOT_FOUND'。
 */
async function clickByText(tab, text) {
  const expr = '(function(){var nodes=[...document.querySelectorAll("button,[role=button],[role=tab],a,h3,div,span")].filter(function(n){return (n.innerText||"").trim().indexOf(' + JSON.stringify(text) + ')>=0 && n.offsetParent!==null});'
    + 'if(nodes.length===0) return "NOT_FOUND";nodes.sort(function(a,b){return a.innerText.length-b.innerText.length});'
    + 'var t=nodes[0];t.scrollIntoView({block:"center"});var r=t.getBoundingClientRect();'
    + 'return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()'
  const raw = await evaluate(tab, expr).catch(() => 'NOT_FOUND')
  if (raw === 'NOT_FOUND' || raw === undefined) return 'NOT_FOUND'
  const box = JSON.parse(raw)
  const common = { x: box.x, y: box.y, button: 'left', clickCount: 1 }
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
  await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common })
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common })
  return 'CLICKED'
}

/**
 * 关掉设置对话框。官方绑定 Esc 关闭；点遮罩在实测中不可靠（.click() 不触发它的 onClick）。
 * @returns 是否已关闭。
 */
async function closeSettings(tab) {
  await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 })
  await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', windowsVirtualKeyCode: 27 })
  const gone = await waitFor(tab, '!document.querySelector("[role=dialog]")', 5000)
  if (!gone) {
    await evaluate(tab, '(function(){var d=document.querySelector("[role=dialog]");if(!d)return "NONE";var b=[...d.querySelectorAll("button")].filter(function(n){return (n.getAttribute("aria-label")||"")==="关闭"||n.className.indexOf("close")>=0});if(b[0])b[0].click();return "CLICKED"})()')
    return await waitFor(tab, '!document.querySelector("[role=dialog]")', 5000)
  }
  return true
}

/** 截图 + 打一行给人看的结论。 */
async function shot(tab, name, note) {
  const path = join(outDir, name + '.png')
  await capture(tab, path, { settleMs: 600, fullPage: false })
  observe(name + ': ' + note + ' → ' + path)
  return path
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

/** 期望的设置分区顺序（官方五 + 本插件三）。 */
const EXPECTED_SECTIONS = ['通用设置', '模型', '内置插件', '插件市场', '环境控制台', 'Agent 预设', '技能与预设', '已归档会话']

/** 跑完整个 e2e。 */
async function run() {
  if (token === undefined || token === '') {
    throw new EnvironmentError('拿不到 token：用 --token / --env-file / PM_TOKEN，或让 --log（默认 /tmp/pm.log）里有 dsh 启动日志')
  }
  const probeRes = await fetch(BASE + '?token=' + token, { redirect: 'manual' }).catch((error) => ({ status: 0, error }))
  if (probeRes.status === 0) throw new EnvironmentError('连不上 ' + BASE + '（实例没起？）：' + String(probeRes.error))
  if (probeRes.status >= 400) throw new EnvironmentError(BASE + ' 返回 ' + probeRes.status + '（token 不对或实例未就绪）')
  observe('实例可达: ' + BASE + ' → HTTP ' + probeRes.status)

  mkdirSync(outDir, { recursive: true })
  const chrome = await launchChrome().catch((error) => { throw new EnvironmentError('Chrome 起不来：' + String(error)) })
  console.log('Chrome: ' + chrome.version.Browser)
  const tab = await openTab(chrome.port)
  try {
    await tab.send('Page.enable')
    await tab.send('Runtime.enable')
    await tab.send('Log.enable')
    await tab.send('Network.enable')
    await tab.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
    tab.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails ?? {}
      const text = String((d.exception && (d.exception.description || d.exception.value)) || d.text || '')
      exceptions.push(text.slice(0, 400))
      if (isSlotCrash(text)) slotCrashes.push(text.slice(0, 400))
    })
    tab.on('Runtime.consoleAPICalled', (p) => {
      const text = (p.args ?? []).map(a => (a.value !== undefined ? a.value : (a.description || ''))).join(' ')
      if (p.type === 'error') {
        consoleErrors.push(String(text).slice(0, 400))
        if (isSlotCrash(String(text))) slotCrashes.push(String(text).slice(0, 400))
      }
    })
    tab.on('Log.entryAdded', (p) => {
      const entry = p.entry ?? {}
      if (entry.level === 'error') {
        consoleErrors.push(String(entry.text ?? '').slice(0, 400))
        if (isSlotCrash(String(entry.text ?? ''))) slotCrashes.push(String(entry.text ?? '').slice(0, 400))
      }
    })
    tab.on('Network.responseReceived', (p) => {
      const response = p.response ?? {}
      if (response.status >= 400) badResponses.push(response.status + ' ' + String(response.url ?? '').slice(0, 160))
    })

    // 断言 1：应用能打开
    await tab.send('Page.navigate', { url: BASE + '?token=' + token })
    const shellUp = await waitFor(tab, 'document.body.innerText.includes("设置") && !document.body.innerText.includes("ERR_CONNECTION_REFUSED")')
    const shell = await probe(tab)
    check('app-shell', '应用能打开（非错误页）', shellUp && shell.textLen > 40, 'scope=' + shell.scope + ' textLen=' + shell.textLen)
    await shot(tab, '00-app', '首屏')
    if (!shellUp) throw new EnvironmentError('应用外壳没渲染出来，后续断言无意义')

    // 断言 2：设置面板八个分区名与顺序
    const opened = await clickLeaf(tab, '设置', 'body')
    const dialogUp = opened === 'CLICKED' && await waitFor(tab, '!!document.querySelector("[role=dialog]")')
    const nav = JSON.parse(await evaluate(tab, '(function(){var dlg=document.querySelector("[role=dialog]");if(!dlg)return "[]";'
      + 'var rows=[...dlg.querySelectorAll("button")].filter(function(b){return b.className.indexOf("navCell")>=0});'
      + 'return JSON.stringify(rows.map(function(b){return (b.innerText||"").trim()}))})()').catch(() => '[]'))
    const expected = EXPECTED_SECTIONS.join('|')
    const actual = nav.join('|')
    check('settings-sections', '设置面板八个分区齐全且顺序正确',
      dialogUp && actual === expected,
      actual === expected ? actual : ('期望 [' + expected + '] 实际 [' + actual + ']'))
    await shot(tab, '10-settings', '设置面板：' + actual)

    // 断言 3/4：三个一级页 + 控制台三子页
    /** 打开设置里的一个分区并等到内容区非空。 */
    async function openSection(label, file) {
      const clicked = await clickLeaf(tab, label, '[role=dialog]')
      const nonEmpty = clicked === 'CLICKED' && await waitFor(tab, '(function(){var d=document.querySelector("[role=dialog]");var o=d&&d.querySelector("[class*=options]");return !!o && (o.innerText||"").trim().length > ' + MIN_CONTENT + '})()')
      const page = await probe(tab)
      check('page-' + label, '一级页面「' + label + '」内容区非空', clicked === 'CLICKED' && nonEmpty,
        'clicked=' + clicked + ' textLen=' + page.textLen + ' optionsLen=' + page.optionsTextLen + ' min=' + MIN_CONTENT)
      await shot(tab, file, label + '：内容 ' + page.textLen + ' 字')
      return page
    }
    await openSection('插件市场', '20-marketplace')
    await openSection('环境控制台', '30-console')
    // 空白页 P0 的回归闸：不只是"有文案"，而是"体检报告真的渲染出来了"（落地即跑一次诊断，可能等它出结果）。
    const reportUp = await waitFor(tab, '(function(){var d=document.querySelector("[role=dialog]");var o=d&&d.querySelector("[class*=options]");var t=o?(o.innerText||""):"";'
      + 'return t.indexOf("健康分")>=0 && (t.indexOf("被诊断环境")>=0 || t.indexOf("生成于")>=0) && (t.indexOf("未发现任何问题")>=0 || t.indexOf("条问题")>=0)})()')
    const consoleAfter = await probe(tab)
    check('console-report', '环境控制台落地即渲染体检报告', reportUp,
      reportUp ? '报告元素齐全（文本 ' + consoleAfter.optionsTextLen + ' 字）' : '等了 ' + WAIT_MS + 'ms 报告区仍未出现（文本长度 ' + consoleAfter.optionsTextLen + '）')
    for (const [sub, file] of [['体检', '31-console-health'], ['环境', '32-console-env'], ['设置', '33-console-config']]) {
      const clicked = await clickLeaf(tab, sub, '[role=dialog]')
      const nonEmpty = clicked === 'CLICKED' && await waitFor(tab, '(function(){var d=document.querySelector("[role=dialog]");var o=d&&d.querySelector("[class*=options]");return !!o && (o.innerText||"").trim().length > ' + MIN_CONTENT + '})()')
      const page = await probe(tab)
      check('console-' + sub, '环境控制台子页「' + sub + '」非空', clicked === 'CLICKED' && nonEmpty && (page.optionsTextLen ?? 0) >= MIN_SUBPAGE_CONTENT,
        'clicked=' + clicked + ' optionsLen=' + page.optionsTextLen + ' min=' + MIN_SUBPAGE_CONTENT)
      await shot(tab, file, '环境控制台·' + sub)
      if (sub === '设置') {
        // P1 回归（审计发现，已修）：官方 Switch 只画开关本体，可见标签必须由调用方给。
        const labels = JSON.parse(await evaluate(tab, '(function(){var d=document.querySelector("[role=dialog]");var o=d&&d.querySelector("[class*=options]");'
          + 'if(!o)return "[]";var sw=[...o.querySelectorAll("[role=switch]")];'
          + 'return JSON.stringify(sw.map(function(s){var p=s.parentElement;var r=s.getBoundingClientRect();'
          + 'return {visible:(p?(p.innerText||"").trim():"").slice(0,40), x:Math.round(r.x), siblingText:(p?[...p.children].filter(function(c){return c!==s}).map(function(c){return (c.innerText||"").trim()}).join("|"):"")}}))})()').catch(() => '[]'))
        const unlabelled = labels.filter(l => l.siblingText === '')
        check('config-switch-labels', '配置页开关都有可见文字标签', labels.length > 0 && unlabelled.length === 0,
          '开关 ' + labels.length + ' 个，无标签 ' + unlabelled.length + ' 个' + (unlabelled.length > 0 ? '（首个 x=' + unlabelled[0].x + '）' : ''))
        const warnText = await evaluate(tab, '(function(){var d=document.querySelector("[role=dialog]");var o=d&&d.querySelector("[class*=options]");return o?(o.innerText||"").includes("宿主只提供了部分配置字段"):false})()').catch(() => false)
        check('config-no-false-warning', '完整配置时不显示"部分配置字段"告警', warnText === false, warnText ? '告警仍在' : '未出现')
      }
    }
    await openSection('技能与预设', '40-kinds')

    // 断言 5：官方插件页集成
    await closeSettings(tab)
    const openPlugins = await clickByAria(tab, '插件')
    const officialUp = await waitFor(tab, 'document.body.innerText.includes("插件列表") || document.body.innerText.includes("添加和管理插件")')
    await shot(tab, '50-official-list', '官方插件页列表')
    const cardUp = officialUp && await waitFor(tab, 'document.body.innerText.includes("插件管理器伴生")')
    check('official-list', '官方插件页能打开且列出本插件卡片', openPlugins === 'CLICKED' && officialUp && cardUp,
      'clicked=' + openPlugins + ' officialUp=' + officialUp + ' card=' + cardUp)
    const openedCard = cardUp ? await clickByText(tab, '插件管理器伴生') : 'SKIPPED'
    const detailUp = openedCard === 'CLICKED' && await waitFor(tab, '!!document.querySelector("[data-plugin-detail],[data-plugin-config]") || document.body.innerText.includes("插件管理器伴生")')
    const config = JSON.parse(await evaluate(tab, '(function(){var c=document.querySelector("[data-plugin-config]");'
      + 'return JSON.stringify({hasConfig:!!c, text:c?(c.innerText||"").trim().slice(0,200):null})})()').catch(() => '{"hasConfig":false,"text":null}'))
    check('official-bundle-config', '本插件详情页 plugins.bundle.config 配置面存在',
      openedCard === 'CLICKED' && detailUp && config.hasConfig === true,
      'opened=' + openedCard + ' detailUp=' + detailUp + ' hasConfig=' + config.hasConfig)
    await shot(tab, '51-official-detail', '本插件详情页：配置面=' + config.hasConfig)

    // 断言 6：无 4xx/5xx
    check('http-status', '全程无 4xx/5xx', badResponses.length === 0,
      badResponses.length === 0 ? '0 条' : badResponses.slice(0, 5).join(' ; '))

    // 断言 7：无 slot 崩溃
    check('slot-crash', '全程无 slot 崩溃', slotCrashes.length === 0,
      slotCrashes.length === 0 ? '0 条' : slotCrashes[0])
    if (consoleErrors.length > 0) observe('控制台 error 共 ' + consoleErrors.length + ' 条（首条：' + consoleErrors[0] + '）')

    // 断言 8：插件市场渲染量上界（防 P3 类回归）
    await clickLeaf(tab, '设置', 'body')
    await waitFor(tab, '!!document.querySelector("[role=dialog]")')
    await clickLeaf(tab, '插件市场', '[role=dialog]')
    await waitFor(tab, '(function(){var d=document.querySelector("[role=dialog]");var o=d&&d.querySelector("[class*=options]");return !!o && (o.innerText||"").trim().length > ' + MIN_CONTENT + '})()')
    const market = await probe(tab)
    // 这条断言是 P3 的回归闸：现在**故意**保持红——市场仍是全量渲染（审计实测 222,209 节点 /
    // 34.8MB 内容区 HTML），对应 task-10。修好后这里自动转绿，没有第二处要改的开关。
    const withinBudget = market.domNodes <= MAX_DOM_NODES && market.textLen <= MAX_TEXT_LENGTH && (market.optionsHTML ?? 0) <= MAX_HTML_LENGTH
    check('marketplace-budget', '插件市场渲染量在宽松上界内', withinBudget,
      'domNodes=' + market.domNodes + '/' + MAX_DOM_NODES + ' textLen=' + market.textLen + '/' + MAX_TEXT_LENGTH + ' optionsHTML=' + market.optionsHTML + '/' + MAX_HTML_LENGTH
      + (withinBudget ? '' : '（P3 已知未修，见 task-10；调 --max-dom-nodes/--max-html-length 只用于临时放宽）'))
    await shot(tab, '60-marketplace-budget', '市场渲染量：' + market.domNodes + ' 节点')

    if (exceptions.length > 0) observe('未捕获异常 ' + exceptions.length + ' 条（首条：' + exceptions[0].split('\n')[0] + '）')
  } finally {
    await tab.close().catch(() => {})
    await chrome.close().catch(() => {})
  }
}

// ── 入口 ───────────────────────────────────────────────────────────────────

console.log('e2e-visual · ' + BASE + ' · 截图目录 ' + outDir)
let exitCode = 0
try {
  await run()
  const failed = checks.filter(c => !c.ok)
  console.log('')
  console.log('结果: ' + checks.filter(c => c.ok).length + '/' + checks.length + ' 通过' + (failed.length === 0 ? '（全部通过）' : '，失败 ' + failed.length + ' 项：' + failed.map(c => c.id).join(', ')))
  console.log('截图: ' + outDir)
  exitCode = failed.length === 0 ? 0 : 1
} catch (error) {
  if (error instanceof EnvironmentError) {
    console.error('环境问题（退出码 2）: ' + error.message)
    exitCode = 2
  } else {
    console.error('脚本自身失败（退出码 2）: ' + (error && error.stack ? error.stack : String(error)))
    exitCode = 2
  }
}
if (checks.length > 0) writeFileSync(join(outDir, 'e2e-visual.json'), JSON.stringify({ base: BASE, exitCode, checks }, null, 2))
console.log('退出码: ' + exitCode)
process.exit(exitCode)

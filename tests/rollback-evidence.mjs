/**
 * rollback-evidence.mjs — 回滚入口的真机取证（task-97）。
 *
 * 归属：A 类（新工具，不进 pnpm test 的 glob）。
 * 官方复用：无；浏览器侧用 tools/cdp-shot.mjs，可见性/md5 断言用 tools/shot-assert.mjs（§7.14）。
 *
 * 四段（对应任务要求的 ①②③）：
 *   ① 点真实升级按钮 → 等结果 → 结果块里应当出现「回滚到 <升级前版本>」；
 *   ② 点回滚入口 → 确认框弹出（截图）→ 断言"还没执行"（盘上版本未变）；
 *   ③ 点确认 → 等回滚完成 → 断言**盘上版本回到升级前**（读 node_modules 的 package.json）；
 *   ④ 每一步都截图，最后断言四张图 md5 两两不同。
 *
 * ⚠ 同一 profile 不能并发取证（2026-09-20，task-97 实际踩过）：
 *   本脚本会**真的改探针环境**（装/卸包、改盘上版本）。两个取证任务同时跑会争用同一个 profile，
 *   双方都拿到半真半假的状态，那一轮结论全部作废——只能杀掉重跑。
 *   规矩：取证**串行**跑；起新的之前先确认没有旧的还在（ss -ltn | grep ':35'）。
 *   完整记录见 docs/CODE-POLICY.md §7.15。
 *
 * 用法：node tests/rollback-evidence.mjs --port 3590 --token <t> --out /tmp/t97 --theme light
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchChrome, openTab, evaluate, capture } from '../tools/cdp-shot.mjs'
import { assertShotsDistinct, shotMd5, visibleExpr } from '../tools/shot-assert.mjs'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = argv.indexOf('--' + name)
  return index === -1 ? fallback : argv[index + 1]
}
const PORT = Number(arg('port', '3590'))
const TOKEN = arg('token', '')
const OUT = arg('out', '/tmp/t97')
const THEME = arg('theme', 'light')
/** 被升级/回滚的包（探针里真实装着的那一个）。 */
const TARGET = arg('target', '@deepseek-ai/dsh-experimental-auto-review')
/** 那个包的 package.json（读盘版本用）。 */
const TARGET_MANIFEST = arg('manifest', '')
const BASE = 'http://127.0.0.1:' + String(PORT) + '/?token=' + TOKEN
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
mkdirSync(OUT, { recursive: true })

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail === undefined ? '' : ' — ' + detail))
}

/** 读盘上那个包的版本（升级/回滚到底有没有生效，只有它能回答）。 */
function diskVersion() {
  try {
    return JSON.parse(readFileSync(TARGET_MANIFEST, 'utf8')).version
  } catch {
    return undefined
  }
}

async function waitFor(tab, expression, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await evaluate(tab, expression).catch(() => false)
    if (ok === true) return true
    await sleep(500)
  }
  return false
}

async function dismissFirstRunNotice(tab) {
  for (let index = 0; index < 30; index += 1) {
    const clicked = await evaluate(tab, '(function(){'
      + 'var labels=["继续","稍后配置","跳过","知道了","关闭","Got it","Continue","Configure later","Skip"];'
      + 'var b=[...document.querySelectorAll("button")].filter(function(n){'
      + '  return labels.indexOf((n.innerText||"").trim())>=0 && n.offsetParent!==null;})[0];'
      + 'if(!b) return false; b.click(); return true})()')
    if (clicked !== true) return
    await sleep(600)
  }
}

/** 点一个按钮（精确匹配可见文本）。 */
const clickByText = (text) => '(function(){'
  + 'var t=' + JSON.stringify(text) + ';'
  + 'var b=[...document.querySelectorAll("button")].filter(function(n){return (n.innerText||"").trim()===t && n.offsetParent!==null})[0];'
  + 'if(!b) return false; b.click(); return true})()'

/**
 * 按前缀点按钮，且**必须限定范围**（§12.10 的反面教材：按文本定位控件必须限定范围）。
 *
 * 为什么：升级按钮与回滚入口**都以「回滚到/升级到」开头**，而且确认框里的确认按钮
 * 文案与卡片上的入口**完全相同**（都是「回滚到 0.1.0」）——不限定范围时"点确认"点到的
 * 其实是卡片上那个入口（框已经开着 = 空操作）。task-92 的「清理过期」同名按钮踩过同一个坑。
 *
 * @param prefix - 按钮文案前缀。
 * @param scope - 'modal' 只点确认框里的；'page' 只点框外的。
 * @returns 注入用的表达式。
 */
const clickByPrefix = (prefix, scope = 'page') => '(function(){'
  + 'var t=' + JSON.stringify(prefix) + ';'
  + 'var all=[...document.querySelectorAll("button")].filter(function(n){return (n.innerText||"").trim().indexOf(t)===0 && n.offsetParent!==null});'
  + 'var inModal=function(n){return n.closest("[role=dialog]") !== null && n.closest("[role=dialog]").innerText.indexOf("回滚这次升级")>=0};'
  + (scope === 'modal'
    ? 'var b=all.filter(inModal)[0];'
    : 'var b=all.filter(function(n){return !inModal(n)})[0];')
  + 'if(!b) return false; b.click(); return true})()'

const PANEL_TEXT = '(function(){'
  + 'var d=document.querySelector("[role=dialog]"); if(!d) return "";'
  + 'var p=[...d.querySelectorAll("[role=tabpanel]")].filter(function(n){return !n.hasAttribute("hidden")})[0];'
  + 'return p?(p.innerText||""):""})()'

/**
 * 确认框的文本。
 *
 * 判据按**内容**找（task-92 的同一手法）：官方 Modal 在真机上是 `[role=dialog][aria-modal]`，
 * 而设置面板本身也是 `[role=dialog]`——所以不能取"第一个 dialog"，
 * 要取"内部含确认框标题的那一个"。
 *
 * 第一版用了 `[data-stub=Modal]` 选择器：那是**测试桩件**的属性，真机上根本不存在，
 * 于是判据恒为空、报了假 FAIL（断言写错会静默变空，§7.13）。
 */
const MODAL_TEXT = '(function(){'
  + 'var ds=[...document.querySelectorAll("[role=dialog]")];'
  + 'var hit=ds.filter(function(n){return (n.innerText||"").indexOf("回滚这次升级")>=0})[0];'
  + 'return hit?(hit.innerText||""):""})()'

/** 滚到某个文本所在的那一行。 */
const SCROLL_TARGET = (label) => '(function(){'
  + 'var want=' + JSON.stringify(label) + ';'
  + 'var d=document.querySelector("[role=dialog]"); if(!d) return "no-dialog";'
  + 'var all=[...d.querySelectorAll("*")];'
  + 'var hit=all.filter(function(n){return n.children.length===0 && (n.textContent||"").indexOf(want)>=0})[0];'
  + 'if(!hit) return "no-target";'
  + 'var box=null; var n=hit.parentElement;'
  + 'while(n && n!==document.body){ if(getComputedStyle(n).overflowY==="auto"){ box=n; break } n=n.parentElement }'
  + 'if(!box) return "no-scroller";'
  + 'box.scrollTop = hit.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 60;'
  + 'return String(box.scrollTop)})()'

async function main() {
  const before = diskVersion()
  console.log('  [盘上版本·升级前] ' + String(before))
  const chrome = await launchChrome()
  const tab = await openTab(chrome.port)
  const shots = []
  try {
    await tab.send('Page.enable')
    await tab.send('Runtime.enable')
    await tab.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1400, deviceScaleFactor: 1, mobile: false })
    await tab.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: THEME === 'dark' ? 'dark' : 'light' }],
    })
    await tab.send('Page.navigate', { url: BASE })
    await waitFor(tab, '!!document.querySelector("body")')
    await sleep(2500)
    await dismissFirstRunNotice(tab)

    // 设置 → 关于 → 软件升级
    await evaluate(tab, clickByText('设置'))
    await waitFor(tab, '!!document.querySelector("[role=dialog]")')
    await evaluate(tab, clickByText('关于'))
    await sleep(2500)
    await evaluate(tab, clickByText('软件升级'))
    await waitFor(tab, '/升级到|查不到|已经是最新版本/.test(' + PANEL_TEXT + ')', 60_000)
    await sleep(2000)

    // ① 点真实升级按钮
    const upgrading = await evaluate(tab, clickByPrefix('升级到'))
    check('点得到真实的升级按钮', upgrading === true, String(upgrading))
    if (upgrading !== true) throw new Error('没有可升级的按钮——探针没造出"有更新"的状态')
    // 升级是长操作（金丝雀试装 + 官方 add），给足时间。
    const settled = await waitFor(tab, '/最近一次升级/.test(' + PANEL_TEXT + ')', 300_000)
    check('升级完成（结果块出现）', settled === true)
    await sleep(1500)
    const afterUpgrade = diskVersion()
    console.log('  [盘上版本·升级后] ' + String(afterUpgrade))
    check('升级真的改了盘上版本', afterUpgrade !== before, String(before) + ' → ' + String(afterUpgrade))

    // ① 结果块里的回滚入口
    const text = await evaluate(tab, PANEL_TEXT)
    if (arg('dump', '') === '1') {
      console.log('---- PANEL ----')
      console.log(String(text).split(String.fromCharCode(10)).map((line, index) => String(index) + ': ' + line).join(String.fromCharCode(10)))
      console.log('---- END ----')
    }
    const rollbackLabel = (text.match(/回滚到 [^\s]+/) ?? ['(没有回滚入口)'])[0]
    check('结果块里有回滚入口，且写明回到哪个版本', /回滚到 /.test(text), rollbackLabel)
    // 入口必须写在**升级前**的版本上（那才是回滚目标）。
    check('回滚目标是升级前的版本', rollbackLabel.includes(String(before)), rollbackLabel + ' vs ' + String(before))
    await evaluate(tab, SCROLL_TARGET('回滚到'))
    await sleep(400)
    check('回滚入口与视口相交（截图拍得到）', (await evaluate(tab, visibleExpr('button'))) === true)
    shots.push(await capture(tab, join(OUT, 'rollback-1-entry-' + THEME + '.png'), { fullPage: false }))

    // ② 点入口 → 确认框（**不许**直接执行）
    // 范围限定到框外：卡片上的入口与确认框里的确认按钮**文案完全相同**（都是「回滚到 0.1.0」），
    // 不限定范围时"点入口"可能点到框里的确认按钮——那正好把"必须二次确认"验反了。
    const opened = await evaluate(tab, clickByPrefix('回滚到', 'page'))
    check('点得到回滚入口', opened === true, String(opened))
    await sleep(1200)
    const modal = await evaluate(tab, MODAL_TEXT)
    check('弹出确认框（不是直接执行）', /回滚这次升级/.test(modal), (modal || '').slice(0, 120).replace(/\n/g, ' '))
    check('确认框说清回到哪个版本', /也就是升级前的版本/.test(modal))
    // 最硬的一条：**点了入口但还没确认**时，盘上版本不该变。
    check('只点入口时盘上版本未变（确实没执行）', diskVersion() === afterUpgrade,
      String(afterUpgrade) + ' → ' + String(diskVersion()))
    shots.push(await capture(tab, join(OUT, 'rollback-2-confirm-' + THEME + '.png'), { fullPage: false }))

    // ③ 点确认 → 真回滚（范围限定到**框内**）
    const confirmed = await evaluate(tab, clickByPrefix('回滚到', 'modal'))
    check('点得到确认按钮', confirmed === true, String(confirmed))
    const rolledBack = await waitFor(tab, '/最近一次回滚/.test(' + PANEL_TEXT + ')', 300_000)
    check('回滚完成（回滚结果块出现）', rolledBack === true)
    await sleep(1500)
    const afterRollback = diskVersion()
    console.log('  [盘上版本·回滚后] ' + String(afterRollback))
    check('**盘上版本回到升级前**', afterRollback === before,
      String(afterUpgrade) + ' → ' + String(afterRollback) + '（目标 ' + String(before) + '）')
    const finalText = await evaluate(tab, PANEL_TEXT)
    check('回滚结果如实说已回滚', /已回滚/.test(finalText), (finalText.match(/已回滚[^\n]{0,40}/) ?? ['(无)'])[0])
    await evaluate(tab, SCROLL_TARGET('最近一次回滚'))
    await sleep(400)
    shots.push(await capture(tab, join(OUT, 'rollback-3-done-' + THEME + '.png'), { fullPage: false }))

    // 文案判据的范围：**结果块**（§12.9 管的就是"结果块的行文结构"），整块喂进去，不逐行。
    //
    // 为什么不能逐行：R5（原始日志必须有标识）判的是"这一块里有没有那行标识"，
    // 而标识与原始输出是**两个相邻元素**（<p> 标识 + <pre> 原文）——
    // 逐行判会把 <pre> 里的每一行都当成"没有标识的裸日志"，报一串假阳性。
    // （task-96 里 R6 的假阳性是反方向的：整块判会把两个元素里的词凑成一句。
    //  两条合起来说明：**判据的范围必须按规则自己的定义选**，不能一刀切。）
    const { violationsOf } = await import('./copy-rules.mjs')
    const blockAt = finalText.indexOf('最近一次回滚')
    const block = blockAt < 0 ? '' : finalText.slice(blockAt)
    const hits = violationsOf(block, 'rendered')
    check('回滚结果块文案过 §12.9 的 R1–R7', hits.length === 0,
      hits.length === 0 ? undefined : '命中 ' + hits.join(', ') + ' :: ' + block.slice(0, 120).replace(/\n/g, ' '))
  } finally {
    await tab.close()
    await chrome.close()
  }
  for (const path of shots) console.log('  [md5] ' + shotMd5(path) + '  ' + path)
  try {
    assertShotsDistinct(shots, '回滚取证三张截图')
    check('三张截图两两不同（§7.14）', true)
  } catch (error) {
    check('三张截图两两不同（§7.14）', false, String(error.message))
  }
  const failed = results.filter(entry => !entry.ok)
  console.log('== rollback/' + THEME + '：' + String(results.length - failed.length) + '/' + String(results.length) + ' 通过 ==')
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => { console.error('环境问题: ' + String(error)); process.exit(2) })

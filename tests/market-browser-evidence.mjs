/**
 * 市场页真机取证驱动（task-41）：用 tools/cdp-shot.mjs 的零依赖 CDP 工具，在真实无头 Chrome 里
 * 打开隔离实例的市场页，截图并读回可见文本。
 *
 * 用法（由 tests/../ 的编排脚本调用，见回报里的命令行）：
 *   node tests/market-browser-evidence.mjs --port 3531 --token <t> --phase normal|dead --out /tmp/pmc-evidence
 *
 * 归属：A 类（新工具）。它不进 pnpm test 的 glob（不是 *.test.mjs）——真机脚本需要实例与浏览器，
 * 不适合放进单元测试；跑法写在 docs/private/market-benchmark.md 的取证小节里。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchChrome, openTab, evaluate, capture } from '../tools/cdp-shot.mjs'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = argv.indexOf('--' + name)
  return index === -1 ? fallback : argv[index + 1]
}
const PORT = Number(arg('port', '3531'))
const TOKEN = arg('token', '')
const PHASE = arg('phase', 'normal')
const OUT = arg('out', '/tmp/pmc-evidence')
const BASE = 'http://127.0.0.1:' + String(PORT) + '/'
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/** 等一个页面内断言成立。 */
async function waitFor(tab, expression, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await evaluate(tab, expression).catch(() => false)
    if (ok === true) return true
    await sleep(300)
  }
  return false
}

/** 打开设置面板里的「插件市场」。 */
async function openMarket(tab) {
  await evaluate(tab, '(function(){var b=[...document.querySelectorAll("button")].filter(function(n){return (n.innerText||"").trim()==="设置" && n.offsetParent!==null})[0]; if(b) b.click(); return !!b})()')
  await waitFor(tab, '!!document.querySelector("[role=dialog]")')
  await evaluate(tab, '(function(){var d=document.querySelector("[role=dialog]");if(!d)return false;var b=[...d.querySelectorAll("button")].filter(function(n){return (n.innerText||"").trim().indexOf("插件市场")>=0 && n.offsetParent!==null})[0]; if(b) b.click(); return !!b})()')
  await waitFor(tab, '(function(){var d=document.querySelector("[role=dialog]");var o=d&&d.querySelector("[class*=options]");return !!o && (o.innerText||"").length>40})()')
}

/** 市场页的内容区文本（设置面板的 options 容器）。 */
const OPTIONS_TEXT = '(function(){var d=document.querySelector("[role=dialog]");var o=d&&d.querySelector("[class*=options]");return o?(o.innerText||""):""})()'

/** 把一段文本敲进搜索框（真人路径：点进去 → insertText → React onChange 收到 input 事件）。 */
async function typeSearch(tab, text) {
  const box = await evaluate(tab, '(function(){var d=document.querySelector("[role=dialog]");if(!d)return null;'
    + 'var i=[...d.querySelectorAll("input")].filter(function(n){return n.offsetParent!==null})[0];if(!i)return null;'
    + 'i.scrollIntoView({block:"center"});var r=i.getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()')
  if (box === null || box === undefined) return 'NO_INPUT'
  const { x, y } = JSON.parse(box)
  await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(200)
  // 先清空（全选 + 删除），再插入文本
  await evaluate(tab, '(function(){var d=document.querySelector("[role=dialog]");var i=[...d.querySelectorAll("input")].filter(function(n){return n.offsetParent!==null})[0];if(i){i.select&&i.select()}return true})()')
  await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  await tab.send('Input.insertText', { text })
  await sleep(400)
  let value = await evaluate(tab, INPUT_VALUE)
  if (value === text) return 'INSERT_TEXT_OK'
  // 退化路径：CDP 的 insertText 在某些受控输入上不触发 React 的 onChange（实测），
  // 改用原生 value setter + input 事件——这条路走的仍是页面上那个真实输入框。
  await evaluate(tab, '(function(){var d=document.querySelector("[role=dialog]");var i=[...d.querySelectorAll("input")].filter(function(n){return n.offsetParent!==null})[0];'
    + 'var set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;'
    + 'set.call(i,' + JSON.stringify(text) + ');i.dispatchEvent(new Event("input",{bubbles:true}));return true})()')
  await sleep(400)
  value = await evaluate(tab, INPUT_VALUE)
  return 'NATIVE_SETTER:' + String(value)
}

/** 搜索框当前值。 */
const INPUT_VALUE = '(function(){var d=document.querySelector("[role=dialog]");if(!d)return null;'
  + 'var i=[...d.querySelectorAll("input")].filter(function(n){return n.offsetParent!==null})[0];return i?i.value:null})()'

/** 市场卡片上的可见名字（前 8 个）。 */
const CARD_NAMES = '(function(){var d=document.querySelector("[role=dialog]");var o=d&&d.querySelector("[class*=options]");if(!o)return "[]";'
  + 'var names=[...o.querySelectorAll("[class*=name]")].map(function(n){return (n.innerText||"").trim()}).filter(Boolean);'
  + 'return JSON.stringify(names.slice(0,8))})()'

const report = { phase: PHASE, port: PORT, shots: [], checks: {} }
mkdirSync(OUT, { recursive: true })
const chrome = await launchChrome()
const tab = await openTab(chrome.port)
try {
  await tab.send('Page.enable')
  await tab.send('Runtime.enable')
  await tab.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false })
  await tab.send('Page.navigate', { url: BASE + '?token=' + TOKEN })
  const shell = await waitFor(tab, 'document.body.innerText.includes("设置")')
  report.checks.shell = shell
  // 新 profile 首启会有官方弹窗（内测声明 → API Key 引导），它们盖住市场列表——点掉再截图。
  const dismissed = []
  for (let round = 0; round < 4; round += 1) {
    const hit = await evaluate(tab, '(function(){var want=["继续","稍后配置","跳过"];'
      + 'for (var w=0; w<want.length; w++){var b=[...document.querySelectorAll("button")].filter(function(n){return (n.innerText||"").trim()===want[w] && n.offsetParent!==null})[0];'
      + 'if(b){b.click();return want[w]}}return ""})()')
    if (typeof hit !== 'string' || hit.length === 0) break
    dismissed.push(hit)
    await sleep(700)
  }
  report.checks.dismissed = dismissed
  await sleep(400)
  await openMarket(tab)
  await sleep(1200)

  if (PHASE === 'normal') {
    const before = await evaluate(tab, OPTIONS_TEXT)
    report.checks.marketTextLength = String(before ?? '').length
    report.checks.placeholder = await evaluate(tab, '(function(){var d=document.querySelector("[role=dialog]");var i=d&&[...d.querySelectorAll("input")].filter(function(n){return n.offsetParent!==null})[0];return i?i.placeholder:null})()')
    report.shots.push(await capture(tab, join(OUT, 'market-normal.png'), { settleMs: 800 }))

    // P1：中文查询
    report.checks.typedCn = await typeSearch(tab, '记忆')
    await sleep(1500)
    report.checks.cnNames = JSON.parse(await evaluate(tab, CARD_NAMES))
    report.checks.cnTail = await evaluate(tab, '(function(){var d=document.querySelector("[role=dialog]");var o=d&&d.querySelector("[class*=options]");if(!o)return "";var t=o.innerText||"";var i=t.indexOf("已显示");return i>=0?t.slice(i,i+60):""})()')
    report.shots.push(await capture(tab, join(OUT, 'market-search-zh.png'), { settleMs: 600 }))

    // 英文查询对照
    report.checks.typedEn = await typeSearch(tab, 'memory')
    await sleep(1200)
    report.checks.enNames = JSON.parse(await evaluate(tab, CARD_NAMES))
    report.shots.push(await capture(tab, join(OUT, 'market-search-en.png'), { settleMs: 600 }))
  } else {
    // 等索引那趟走完：六跳全失败仍要跑一遍（每跳一次连接尝试），固定 1.2s 会读到"还没加载完"的状态。
    await waitFor(tab, '(function(){var d=document.querySelector("[role=dialog]");var o=d&&d.querySelector("[class*=options]");var t=o?(o.innerText||""):"";'
      + 'return t.indexOf("插件索引不可用")>=0 || t.indexOf("这是缓存索引")>=0})()', 25_000)
    report.checks.marketText = String(await evaluate(tab, OPTIONS_TEXT) ?? '').slice(0, 600)
    report.checks.hasUnavailable = String(await evaluate(tab, OPTIONS_TEXT) ?? '').includes('插件索引不可用')
    report.checks.hasStale = String(await evaluate(tab, OPTIONS_TEXT) ?? '').includes('这是缓存索引')
    report.shots.push(await capture(tab, join(OUT, 'market-index-' + PHASE + '.png'), { settleMs: 1000 }))
  }
} finally {
  await tab.close().catch(() => {})
  await chrome.close().catch(() => {})
}
writeFileSync(join(OUT, 'browser-evidence-' + PHASE + '.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 1))

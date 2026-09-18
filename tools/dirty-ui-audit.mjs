/** 脏环境 · 体检页取证：分组折叠/展开、问题证据、修复按钮、跳过标注。只读，不点任何修复按钮。 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchChrome, openTab, evaluate, capture, clickText } from '/home/sixiao/aicode/test/test8/dsh-plugin-manager-companion/tools/cdp-shot.mjs'

const env = Object.fromEntries(readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)] }))
const PORT = env.PORT, TOKEN = env.TOKEN
const BASE = 'http://127.0.0.1:' + PORT + '/'
const OUT = env.OUT ?? (process.env.DIRTY_OUT ?? '/tmp/vis-dirty')
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const evidence = { exceptions: [], consoleErrors: [], groups: [], skipped: null, steps: {} }

/** 在页面里用真实鼠标点一个元素（按选择器 + 索引）。 */
async function clickBySelector(tab, selector, index = 0) {
  const raw = await evaluate(tab, '(function(){var l=[...document.querySelectorAll(' + JSON.stringify(selector) + ')].filter(function(n){return n.offsetParent!==null});'
    + 'var t=l[' + index + '];if(!t)return "NOT_FOUND";t.scrollIntoView({block:"center"});var r=t.getBoundingClientRect();'
    + 'return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2,tag:t.tagName,cls:String(t.className||"").slice(0,70)})})()').catch(() => 'NOT_FOUND')
  if (raw === 'NOT_FOUND' || raw === undefined) return 'NOT_FOUND'
  const box = JSON.parse(raw)
  const common = { x: box.x, y: box.y, button: 'left', clickCount: 1 }
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
  await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common })
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common })
  return 'CLICKED:' + box.tag + ' ' + box.cls
}

/** 体检页 DOM 快照（分组行 / 问题行 / 证据 / 修复按钮 / 跳过块）。 */
async function snapshot(tab) {
  const raw = await evaluate(tab, "(function snapshotHealth() {\n  try {\n    var d = document.querySelector('[role=dialog]')\n    var o = d && d.querySelector('[class*=options]')\n    if (!o) return JSON.stringify({ error: 'NO_OPTIONS' })\n    var txt = function (n) { return (n.innerText || '').trim() }\n    var groups = []\n    var sections = o.querySelectorAll('section')\n    for (var i = 0; i < sections.length; i++) {\n      var s = sections[i]\n      var head = s.firstElementChild\n      var rows = s.querySelectorAll('li')\n      var rowTexts = []\n      var visible = 0\n      for (var j = 0; j < rows.length; j++) {\n        rowTexts.push(txt(rows[j]).slice(0, 240))\n        if (rows[j].offsetParent !== null) visible += 1\n      }\n      var codes = []\n      var cls = s.querySelectorAll('code')\n      for (var k = 0; k < cls.length; k++) codes.push(txt(cls[k]))\n      var btns = []\n      var bl = s.querySelectorAll('button')\n      for (var b = 0; b < bl.length; b++) btns.push({ text: txt(bl[b]).slice(0, 40), title: bl[b].getAttribute('title') || '', disabled: !!bl[b].disabled })\n      groups.push({ headText: head ? txt(head).slice(0, 220) : null, rowCount: rows.length, visibleItems: visible, rowTexts: rowTexts, evidence: codes.slice(0, 12), buttons: btns })\n    }\n    var skipped = null\n    var sk = o.querySelector('[class*=skipped]')\n    if (sk) skipped = txt(sk).slice(0, 700)\n    return JSON.stringify({ groups: groups, skipped: skipped, text: txt(o).slice(0, 3000) })\n  } catch (e) { return JSON.stringify({ error: String(e) }) }\n}\n)()")
  return JSON.parse(raw)
}

const chrome = await launchChrome()
const tab = await openTab(chrome.port)
await tab.send('Page.enable'); await tab.send('Runtime.enable'); await tab.send('Log.enable'); await tab.send('Network.enable')
await tab.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
tab.on('Runtime.exceptionThrown', (p) => { const d = p.exceptionDetails || {}; evidence.exceptions.push(String((d.exception && (d.exception.description || d.exception.value)) || d.text || '').slice(0, 600)) })
tab.on('Runtime.consoleAPICalled', (p) => { const t = (p.args || []).map(a => (a.value !== undefined ? a.value : (a.description || ''))).join(' '); if (p.type === 'error') evidence.consoleErrors.push(String(t).slice(0, 600)) })

try {
  await tab.send('Page.navigate', { url: BASE + '?token=' + TOKEN })
  await sleep(9000)
  console.log('打开设置: ' + await clickText(tab, '设置'))
  await sleep(2500)
  console.log('进入环境控制台: ' + await clickBySelector(tab, '[role=dialog] button[class*=navCell]', 4))
  let ready = false
  for (let i = 0; i < 80; i += 1) {
    ready = await evaluate(tab, '(function(){var d=document.querySelector("[role=dialog]");var o=d&&d.querySelector("[class*=options]");return !!o && (o.innerText||"").includes("健康分")})()').catch(() => false)
    if (ready === true) break
    await sleep(500)
  }
  console.log('报告就绪: ' + ready)
  await sleep(1500)
  await capture(tab, join(OUT, '10-体检-分组折叠.png'), { settleMs: 300 })

  const collapsed = await snapshot(tab)
  evidence.steps.collapsed = { groupHeads: collapsed.groups.map(g => g.headText), visibleItems: collapsed.groups.map(g => g.visibleItems), skipped: collapsed.skipped }
  console.log('=== 折叠态：分组行 ===')
  for (const g of collapsed.groups) console.log('  · ' + String(g.headText).replace(/\n/g, ' | ') + '  [可见子项 ' + g.visibleItems + '/' + g.rowCount + ']')
  console.log('=== 折叠态：跳过块 ===')
  console.log(String(collapsed.skipped))

  // 逐个展开分组：点分组头（DisclosureRow 的 title 行，expandOnRowClick）
  const groupCount = collapsed.groups.filter(g => String(g.headText || '').includes('条同类')).length
  for (let i = 0; i < groupCount; i += 1) {
    const clicked = await clickBySelector(tab, '[role=dialog] section [class*=issueMeta]', i)
    await sleep(1200)
    console.log('展开第 ' + (i + 1) + ' 个分组: ' + clicked)
  }
  // 再展开具体问题行（组展开后才出现组内 li；等它们真的渲染出来再点）
  for (let i = 0; i < 60; i += 1) {
    const ok = await evaluate(tab, 'document.querySelectorAll("[role=dialog] section ul li [class*=issueMeta]").length > 0').catch(() => false)
    if (ok === true) break
    await sleep(300)
  }
  const rowClicks = []
  for (let i = 0; i < 3; i += 1) {
    const clickedRow = await clickBySelector(tab, '[role=dialog] section ul li [class*=issueMeta]', i)
    await sleep(1000)
    rowClicks.push(clickedRow)
  }
  console.log('展开问题行: ' + JSON.stringify(rowClicks))
  await sleep(800)
  await capture(tab, join(OUT, '12-问题详情-证据.png'), { settleMs: 300 })
  const detail = await evaluate(tab, '(function(){try{var d=document.querySelector("[role=dialog]");var o=d.querySelector("[class*=options]");'
    + 'var lis=[...o.querySelectorAll("section li")];return JSON.stringify(lis.map(function(li){return {"text":(li.innerText||"").trim().slice(0,900),'
    + '"buttons":[...li.querySelectorAll("button")].map(function(b){return {text:(b.innerText||"").trim().slice(0,30),title:b.getAttribute("title")||"",disabled:!!b.disabled}}),'
    + '"codes":[...li.querySelectorAll("code")].map(function(c){return (c.innerText||"").trim()}),'
    + '"tags":[...li.querySelectorAll("span,div")].filter(function(n){return n.children.length===0&&(n.innerText||"").trim().length>0&&(n.innerText||"").trim().length<12}).map(function(n){return (n.innerText||"").trim()})}}))}catch(e){return JSON.stringify({error:String(e)})}})()')
  evidence.steps.issueDetails = JSON.parse(detail)
  console.log('=== 问题行详情（展开后） ===')
  for (const li of evidence.steps.issueDetails) {
    console.log('--- ' + String(li.text).replace(/\n/g, ' | '))
    console.log('    按钮: ' + JSON.stringify(li.buttons))
    console.log('    code: ' + JSON.stringify(li.codes))
  }
  const expanded = await snapshot(tab)
  evidence.groups = expanded.groups
  evidence.skipped = expanded.skipped
  await capture(tab, join(OUT, '11-体检-分组展开.png'), { settleMs: 300 })
  console.log('')
  console.log('=== 展开态：每组 ===')
  for (const g of expanded.groups) {
    console.log('【组】' + String(g.headText).replace(/\n/g, ' | '))
    for (const t of g.rowTexts) console.log('   子项: ' + String(t).replace(/\n/g, ' | ').slice(0, 200))
    console.log('   证据 code: ' + JSON.stringify(g.evidence))
    console.log('   按钮: ' + JSON.stringify(g.buttons))
  }
  console.log('=== 跳过块原文 ===')
  console.log(String(expanded.skipped))
} catch (error) {
  console.log('审计中断: ' + String(error).slice(0, 300))
} finally {
  writeFileSync(join(OUT, 'browser-evidence.json'), JSON.stringify(evidence, null, 2))
  console.log('异常 ' + evidence.exceptions.length + '，控制台 error ' + evidence.consoleErrors.length)
  await tab.close().catch(() => {})
  await chrome.close().catch(() => {})
}
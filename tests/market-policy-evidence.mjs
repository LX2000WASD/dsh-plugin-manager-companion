/**
 * 市场徽标/筛选/详情 的真机取证驱动（task-46）。复用 tools/cdp-shot.mjs 的零依赖 CDP 工具。
 *
 * 用法：node tests/market-policy-evidence.mjs --port 3533 --token <t> --out /tmp/pmc-evidence
 * 取证点（每条对应 task-45 政策的一节）：
 *   · 卡片三槽：徽标行 ≤3，且**不出现恒定的 kind 词**（政策 §3.4）
 *   · 同名去重：category 与 topics 同值的条目上，那个词只出现一次（政策 §2.1）
 *   · 非插件过滤：默认隐藏 installable=non-plugin，勾选后才出现（政策 §3.2 第 1 条）
 *   · 详情：八项行 + reportUrl 外链 + risk_flags 明细（政策 §3.1/§3.3）
 *   · 热度排序：按星数与按热度的首屏顺序不同（政策 §5 第 6 条）
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchChrome, openTab, evaluate, capture, clickText as clickByMouse } from '../tools/cdp-shot.mjs'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = argv.indexOf('--' + name)
  return index === -1 ? fallback : argv[index + 1]
}
const PORT = Number(arg('port', '3533'))
const TOKEN = arg('token', '')
const OUT = arg('out', '/tmp/pmc-evidence')
const BASE = 'http://127.0.0.1:' + String(PORT) + '/'
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(tab, expression, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await evaluate(tab, expression).catch(() => false)
    if (ok === true) return true
    await sleep(300)
  }
  return false
}

const OPTIONS = '(function(){var d=document.querySelector("[role=dialog]");var o=d&&d.querySelector("[class*=options]");return o?(o.innerText||""):""})()'

/** 前 n 张卡片的「名字 + 徽标行 + 详情行」文本。 */
const CARDS = (n) => '(function(){var d=document.querySelector("[role=dialog]");var o=d&&d.querySelector("[class*=options]");if(!o)return "[]";'
  + 'var cards=[...o.querySelectorAll("li")].slice(0,' + String(n) + ');'
  + 'return JSON.stringify(cards.map(function(c){'
  + 'var name=(c.querySelector("[class*=name]")||{}).innerText||"";'
  + 'var tagRow=c.querySelector("[class*=topics]");'
  + 'var tags=tagRow?[...tagRow.querySelectorAll("[class*=Tag], span")].map(function(t){return (t.innerText||"").trim()}).filter(Boolean):[];'
  + 'return {name:name.trim(), tags:tags}}))})()'

/** 在设置面板里点一个可见文本按钮。 */
async function clickText(tab, text) {
  return await evaluate(tab, '(function(){var d=document.querySelector("[role=dialog]");var scope=d||document;'
    + 'var b=[...scope.querySelectorAll("button,label,[role=checkbox]")].filter(function(n){return (n.innerText||"").trim().indexOf(' + JSON.stringify(text) + ')>=0 && n.offsetParent!==null})[0];'
    + 'if(b){b.scrollIntoView({block:"center"});b.click();return true}return false})()')
}

/** 打开设置 → 插件市场。 */
async function openMarket(tab) {
  await evaluate(tab, '(function(){var b=[...document.querySelectorAll("button")].filter(function(n){return (n.innerText||"").trim()==="设置" && n.offsetParent!==null})[0]; if(b) b.click(); return !!b})()')
  await waitFor(tab, '!!document.querySelector("[role=dialog]")')
  for (let round = 0; round < 3; round += 1) {
    await evaluate(tab, '(function(){var want=["继续","稍后配置","跳过"];for(var w=0;w<want.length;w++){var b=[...document.querySelectorAll("button")].filter(function(n){return (n.innerText||"").trim()===want[w] && n.offsetParent!==null})[0];if(b){b.click();return true}}return false})()')
    await sleep(500)
  }
  await evaluate(tab, '(function(){var d=document.querySelector("[role=dialog]");if(!d)return false;var b=[...d.querySelectorAll("button")].filter(function(n){return (n.innerText||"").trim().indexOf("插件市场")>=0 && n.offsetParent!==null})[0]; if(b) b.click(); return !!b})()')
  await waitFor(tab, '(function(){var d=document.querySelector("[role=dialog]");var o=d&&d.querySelector("[class*=options]");return !!o && (o.innerText||"").length>40})()')
}

async function typeSearch(tab, text) {
  const box = await evaluate(tab, '(function(){var d=document.querySelector("[role=dialog]");if(!d)return null;'
    + 'var i=[...d.querySelectorAll("input")].filter(function(n){return n.offsetParent!==null})[0];if(!i)return null;'
    + 'i.scrollIntoView({block:"center"});var r=i.getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()')
  if (box === null || box === undefined) return 'NO_INPUT'
  const { x, y } = JSON.parse(box)
  await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(150)
  await evaluate(tab, '(function(){var d=document.querySelector("[role=dialog]");var i=[...d.querySelectorAll("input")].filter(function(n){return n.offsetParent!==null})[0];var set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;'
    + 'set.call(i,' + JSON.stringify(text) + ');i.dispatchEvent(new Event("input",{bubbles:true}));return true})()')
  await sleep(1200)
  return 'TYPED'
}

const report = { shots: [], checks: {} }
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
  await openMarket(tab)

  // ① 卡片三槽 + 无 kind 徽标：搜 browser（含 Tencent/BrowserSkill，risk）
  await typeSearch(tab, 'browser')
  const cards = JSON.parse(await evaluate(tab, CARDS(6)))
  report.checks.cardBadges = cards
  report.checks.badgeSlotsWithinLimit = cards.every(card => card.tags.length <= 3)
  report.checks.noConstantKindWord = cards.every(card => !card.tags.some(tag => tag === '插件' || tag === 'Plugin'))
  report.checks.riskBadgePresent = cards.some(card => card.tags.includes('风险'))
  report.shots.push(await capture(tab, join(OUT, 'policy-cards.png'), { settleMs: 600 }))

  // ② 同名去重：找 category 与 topics 同值的条目（vm 里先算好候选）
  await typeSearch(tab, process.env.POLICY_DUP_QUERY ?? 'memory')
  const dupCards = JSON.parse(await evaluate(tab, CARDS(8)))
  const dupValue = process.env.POLICY_DUP_VALUE ?? 'memory'
  const dupHits = dupCards.filter(card => card.tags.filter(tag => tag.toLowerCase() === dupValue).length > 1)
  report.checks.dupCards = dupCards
  report.checks.duplicateTagInstances = dupHits.length
  report.shots.push(await capture(tab, join(OUT, 'policy-dedup.png'), { settleMs: 600 }))

  // ③ 非插件过滤：默认隐藏（installable=non-plugin）→ 勾选后出现
  // 查询词选一个只可能命中它自己的：'open-design' 会被分词成 open + design，靠描述也能命中别的条目。
  await typeSearch(tab, 'nocobase')
  const hidden = JSON.parse(await evaluate(tab, CARDS(4)))
  const toggle = await clickText(tab, '显示非插件条目')
  await sleep(1200)
  const shownAfter = JSON.parse(await evaluate(tab, CARDS(4)))
  report.checks.nonPluginHiddenByDefault = hidden.length === 0
  report.checks.nonPluginAfterToggle = shownAfter.length
  report.checks.toggleClicked = toggle === true
  report.shots.push(await capture(tab, join(OUT, 'policy-filter-nonplugin.png'), { settleMs: 600 }))
  await clickText(tab, '显示非插件条目')
  await sleep(800)

  // ④ 详情八项 + 报告外链：搜 modlens（独立校验簇：verdict=pass + reportUrl）
  await typeSearch(tab, 'modlens')
  // 用真鼠标事件点「详情」（与排序菜单同一个理由：合成 click 在部分组件上不生效；这里也更贴近真人操作）。
  const opened = await clickByMouse(tab, '详情')
  await waitFor(tab, '(function(){var d=document.querySelector("[role=dialog]");var o=d&&d.querySelector("[class*=options]");if(!o)return false;'
    + 'return [...o.querySelectorAll("span")].some(function(s){return (s.innerText||"").trim()==="收起"})})()', 8000)
  report.checks.detailOpened = opened
  await sleep(500)
  // 详情行必须从**展开的那张卡**里读：容器里最后一个 p.topics 往往是别的卡的徽标行（实测踩过）。
  // 详情行必须从**展开的那张卡**里读：容器里最后一个 p.topics 往往是别的卡的徽标行（实测踩过）。
  // 认卡方式用「详情独有的行」——独立校验只可能出现在详情里，不依赖展开按钮的 DOM 形态。
  const detail = JSON.parse(await evaluate(tab, '(function(){var d=document.querySelector("[role=dialog]");var o=d&&d.querySelector("[class*=options]");if(!o)return "[]";'
    + 'var card=[...o.querySelectorAll("li")].filter(function(c){return (c.innerText||"").indexOf("独立校验")>=0})[0];'
    + 'if(!card)return "[]";var rows=[...card.querySelectorAll("p[class*=topics]")].pop();'
    + 'return JSON.stringify(rows?[...rows.querySelectorAll("span")].map(function(s){return (s.innerText||"").trim()}):[])})()'))
  const links = JSON.parse(await evaluate(tab, '(function(){var d=document.querySelector("[role=dialog]");var o=d&&d.querySelector("[class*=options]");if(!o)return "[]";'
    + 'return JSON.stringify([...o.querySelectorAll("a")].map(function(a){return a.href}).filter(function(h){return h.indexOf("dsh-plugin-verify")>=0}))})()'))
  report.checks.detailRows = detail
  // modlens 是 safe：政策规定**不出**风险行，所以这里断言的是"该有的七项都在、风险行正确地不在"。
  report.checks.detailRowsSafeItem = ['类型', '分类', '主题', '独立校验', '许可证', 'npm 包', '版本'].every(key => detail.some(row => row.startsWith(key + '：')))
  report.checks.detailHasNoRiskRowForSafe = !detail.some(row => row.startsWith('风险等级'))
  report.checks.reportLinks = links
  report.shots.push(await capture(tab, join(OUT, 'policy-detail.png'), { settleMs: 600 }))

  // ④b 风险详情：Tencent/BrowserSkill（risk + 4 条 risk_flags）
  await typeSearch(tab, 'BrowserSkill')
  await clickByMouse(tab, '详情')
  await sleep(900)
  const riskDetail = JSON.parse(await evaluate(tab, '(function(){var d=document.querySelector("[role=dialog]");var o=d&&d.querySelector("[class*=options]");if(!o)return "[]";'
    + 'var card=[...o.querySelectorAll("li")].filter(function(c){return (c.innerText||"").indexOf("风险等级")>=0})[0];'
    + 'if(!card)return "[]";var rows=[...card.querySelectorAll("p[class*=topics]")].pop();'
    + 'return JSON.stringify(rows?[...rows.querySelectorAll("span")].map(function(s){return (s.innerText||"").trim()}):[])})()'))
  report.checks.detailRowsRiskItem = riskDetail
  report.checks.detailHasRiskKeys = riskDetail.some(row => row.startsWith('风险等级：'))
    && riskDetail.some(row => row.startsWith('风险明细：'))
  report.shots.push(await capture(tab, join(OUT, 'policy-detail-risk.png'), { settleMs: 600 }))

  // ⑤ 热度排序：按星数 vs 按热度 首屏顺序不同
  await typeSearch(tab, '')
  await sleep(900)
  const byStars = JSON.parse(await evaluate(tab, CARDS(6))).map(card => card.name)
  // 排序下拉是官方 Menu：菜单项监听 pointer 事件，合成 click 不生效——必须用真鼠标事件（cdp-shot 的 clickText）。
  const switched = await clickByMouse(tab, '按星数')
  await sleep(400)
  const picked = await clickByMouse(tab, '按热度')
  await sleep(1200)
  const byTrend = JSON.parse(await evaluate(tab, CARDS(6))).map(card => card.name)
  report.checks.sortSwitch = switched + '/' + picked
  report.checks.byStars = byStars
  report.checks.byTrending = byTrend
  report.checks.trendingDiffers = JSON.stringify(byStars) !== JSON.stringify(byTrend)
  report.shots.push(await capture(tab, join(OUT, 'policy-sort-trending.png'), { settleMs: 600 }))
} finally {
  await tab.close().catch(() => {})
  await chrome.close().catch(() => {})
}
writeFileSync(join(OUT, 'policy-evidence.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 1))

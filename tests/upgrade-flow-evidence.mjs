/**
 * upgrade-flow-evidence.mjs — 一次**真实升级**的 UI 全流程取证 + 注册对账取证（task-74）。
 *
 * 归属：A 类（新工具，不进 pnpm test 的 glob）。
 * 官方复用：无；浏览器侧只用 tools/cdp-shot.mjs。
 * 前提检查：真升级必须点真按钮（不是直接调 op）——否则证不了"用户点得动"。
 *
 * 三段：
 *   ① 点真实升级按钮 → 等结果 → 截图（含"升级中"那一帧）；
 *   ② 结果块如实（成功/没验证/回滚各自可辨）；
 *   ③ 注册对账：用官方通道卸掉一个包 → 插件页那一节**当场消失**（不刷新）。
 *
 * 用法：node tests/upgrade-flow-evidence.mjs --port 3471 --token <t> --out /tmp/upg-flow
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchChrome, openTab, evaluate, capture, clickText } from '../tools/cdp-shot.mjs'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = argv.indexOf('--' + name)
  return index === -1 ? fallback : argv[index + 1]
}
const PORT = Number(arg('port', '3471'))
const TOKEN = arg('token', '')
const OUT = arg('out', '/tmp/upg-flow')
const BASE = 'http://127.0.0.1:' + String(PORT) + '/?token=' + TOKEN
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
mkdirSync(OUT, { recursive: true })

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail === undefined ? '' : ' — ' + detail))
}

async function waitFor(tab, expression, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await evaluate(tab, expression).catch(() => false)
    if (ok === true) return true
    await sleep(300)
  }
  return false
}

const MODAL_OPEN = '!!document.querySelector("[role=dialog]")'
const DETAIL_TEXT = '(function(){var d=document.querySelector("[data-plugin-detail]");return d?(d.innerText||""):""})()'

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

/** 打开官方插件页并点开某个显示标题对应的包。 */
async function openPluginDetail(tab, title) {
  const inDetail = await evaluate(tab, '!!document.querySelector("[data-plugin-detail]")')
  if (inDetail === true) {
    await evaluate(tab, '(function(){var b=[...document.querySelectorAll("button")].filter(function(n){return (n.innerText||"").trim()==="插件列表" && n.offsetParent!==null})[0]; if(b) b.click(); return !!b})()')
    await sleep(1200)
  } else {
    await evaluate(tab, '(function(){var d=document.querySelector("[role=dialog]");if(d){document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));}return true})()')
    await sleep(600)
    await dismissFirstRunNotice(tab)
    await evaluate(tab, '(function(){var b=[...document.querySelectorAll("button,a,[role=button]")].filter(function(n){return (n.innerText||"").trim()==="插件" && n.offsetParent!==null})[0]; if(b) b.click(); return !!b})()')
    await waitFor(tab, '!!document.querySelector("[data-plugin-scope=global]")', 15_000)
    await sleep(1000)
  }
  const find = (name) => '(function(){'
    + 'var target=' + JSON.stringify(name) + ';'
    + 'var list=[...document.querySelectorAll("[data-plugin-scope=global]")];'
    + 'for (var i=0;i<list.length;i++){'
    + '  var leaves=[...list[i].querySelectorAll("*")].filter(function(n){return n.children.length===0 && (n.textContent||"").trim()===target});'
    + '  if(leaves.length){ var node=leaves[0];'
    + '    while(node && node !== document.body){ var role=node.getAttribute && node.getAttribute("role");'
    + '      if(node.tagName==="BUTTON"||role==="button"||node.tagName==="A"){ node.click(); return true } node=node.parentElement }'
    + '  }'
    + '}'
    + 'return false})()'
  let opened = await evaluate(tab, find(title))
  if (opened !== true) {
    await evaluate(tab, '(function(){var s=document.querySelector("[data-plugin-scope=global]"); if(s&&s.parentElement) s.parentElement.scrollTop += 900; return true})()')
    await sleep(800)
    opened = await evaluate(tab, find(title))
  }
  await sleep(1500)
  return opened
}

async function main() {
  const chrome = await launchChrome()
  const tab = await openTab(chrome.port)
  const shots = []
  try {
    await tab.send('Page.enable')
    await tab.send('Runtime.enable')
    await tab.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1200, deviceScaleFactor: 1, mobile: false })
    await tab.send('Page.navigate', { url: BASE })
    await waitFor(tab, '!!document.querySelector("body")')
    await sleep(2500)
    await dismissFirstRunNotice(tab)

    const PKG = '@deepseek-ai/dsh-experimental-auto-review'
    const opened = await openPluginDetail(tab, '自动授权审查')
    check('flow: 打开可升级包的页面', opened === true)
    let before = await evaluate(tab, DETAIL_TEXT)
    check('flow: 升级前显示"当前 0.1.6-alpha.1 → 0.1.6-alpha.2"',
      /当前 0\.1\.6-alpha\.1 → 0\.1\.6-alpha\.2/.test(before))
    shots.push(await capture(tab, join(OUT, '01-before.png'), { fullPage: false }))

    // ① 点真实按钮（不是直接调 op）。
    const clicked = await clickText(tab, '升级到 0.1.6-alpha.2')
    check('flow: 点得到"升级到 0.1.6-alpha.2"这个真实按钮', clicked !== 'NOT_FOUND', String(clicked))
    // 升级中那一帧（按钮变"升级中…"，说明忙碌态真的画出来了）。
    //
    // 注意 capture 的 settleMs 必须是 0：默认 800ms 的"等页面稳定"会让这一帧在真装完
    // 之后才截，于是截出来的是结果态（第一版就是这样——两张图 md5 完全相同）。
    // 这里检测到就立刻截，settleMs=0 只跳过等待、不影响截图本身。
    let running = false
    for (let index = 0; index < 40; index += 1) {
      const shown = await evaluate(tab, '/升级中/.test(' + DETAIL_TEXT + ')')
      if (shown === true) {
        running = true
        shots.push(await capture(tab, join(OUT, '02-running.png'), { fullPage: false, settleMs: 0 }))
        break
      }
      await sleep(150)
    }
    check('flow: 等待期间画出了"升级中…"（长操作有进度）', running === true)

    // ② 等结果块出现。
    const settled = await waitFor(tab, '!!document.querySelector("[data-upgrade-outcome]")', 240_000)
    check('flow: 升级结果落定并渲染出结果块', settled === true)
    const after = await evaluate(tab, DETAIL_TEXT)
    const outcome = await evaluate(tab, '(function(){var n=document.querySelector("[data-upgrade-outcome]");return n?n.getAttribute("data-upgrade-outcome"):null})()')
    console.log('    [debug] outcome = ' + String(outcome))
    console.log('    [debug] 结果文本：' + String(after).slice(0, 500).replace(/\n/g, ' | '))
    check('flow: 结论不是"完成"以外的含糊态（有明确的 outcome 属性）',
      typeof outcome === 'string' && outcome.length > 0, String(outcome))
    check('flow: 结果里没有字面 ** （§12.6 陷阱 #1）', !/\*\*/.test(after))
    shots.push(await capture(tab, join(OUT, '03-result.png'), { fullPage: false }))

    // ③ 注册对账：官方通道卸掉一个包 → 那一节当场消失。
    // 用官方 UI 的卸载按钮（不是调 op）——证的是"用户点了卸载，那一节跟着没"。
    const TEAM = '@deepseek-ai/dsh-experimental-agent-team-profile'
    const openedTeam = await openPluginDetail(tab, '智能体团队')
    check('flow: 打开智能体团队的页面（对账前的对照）', openedTeam === true)
    const teamBefore = await evaluate(tab, DETAIL_TEXT)
    check('flow: 它的升级行在（安装方提供）', /由安装方提供/.test(teamBefore))
    shots.push(await capture(tab, join(OUT, '04-reconcile-before.png'), { fullPage: false }))

    // ④ 注册对账：走**官方 UI 的开关**把这一层关掉，那一节必须当场消失（不是刷新后）。
    //
    // 为什么用开关而不是卸载：安装方提供的层不可卸载（官方 removable=false），
    // 关掉它会让它离开 dsh.profile.bundles → 官方 listBundles 不再列它 → 我们的对账撤掉这个 key。
    // 这条同时证明了「注册集合跟着已装集合走」与「不留孤儿 key」。
    const toggled = await evaluate(tab, '(function(){' 
      + 'var sw=[...document.querySelectorAll("[data-plugin-detail] input[type=checkbox], [data-plugin-detail] button[role=switch]")].filter(function(n){return n.offsetParent!==null})[0];' 
      + 'if(sw){sw.click();return true} return false})()')
    check('flow: 找得到官方详情页的启用开关', toggled === true)
    // 等那一节消失（官方 config-ledger 跟着 slot 版本重算）。
    let vanished = false
    for (let index = 0; index < 40; index += 1) {
      await sleep(500)
      const text = await evaluate(tab, DETAIL_TEXT)
      if (!/由安装方提供/.test(text)) { vanished = true; break }
    }
    check('flow: 关掉这一层后，升级行当场消失（注册对账生效、不留孤儿 key）', vanished === true,
      String(await evaluate(tab, DETAIL_TEXT)).slice(0, 200).replace(/\n/g, ' '))
    shots.push(await capture(tab, join(OUT, '05-reconcile-after.png'), { fullPage: false }))

    writeFileSync(join(OUT, 'result.json'), JSON.stringify({ results, shots }, undefined, 2))
  } finally {
    await tab.close()
    await chrome.close()
  }
  const failed = results.filter(entry => !entry.ok)
  console.log('== flow：' + String(results.length - failed.length) + '/' + String(results.length) + ' 通过 ==')
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => { console.error('环境问题: ' + String(error)); process.exit(2) })

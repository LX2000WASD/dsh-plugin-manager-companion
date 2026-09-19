/**
 * trial-plan-evidence.mjs — 清理计划的真机取证（task-90）。
 *
 * 归属：A 类（新工具，不进 pnpm test 的 glob）。
 * 官方复用：无；浏览器侧只用 tools/cdp-shot.mjs。
 * 前提检查：两种形态都要拍——"有计划（含会删与会留）"与"计划为空"，浅色 + 深色各一张。
 *
 * 用法：node tests/trial-plan-evidence.mjs --port 3530 --token <t> --out /tmp/t90 --theme light --state planned|empty
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { launchChrome, openTab, evaluate, capture } from '../tools/cdp-shot.mjs'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = argv.indexOf('--' + name)
  return index === -1 ? fallback : argv[index + 1]
}
const PORT = Number(arg('port', '3530'))
const TOKEN = arg('token', '')
const OUT = arg('out', '/tmp/t90')
const THEME = arg('theme', 'light')
const STATE = arg('state', 'planned')
const BASE = 'http://127.0.0.1:' + String(PORT) + '/?token=' + TOKEN
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
mkdirSync(OUT, { recursive: true })

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail === undefined ? '' : ' — ' + detail))
}

async function waitFor(tab, expression, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await evaluate(tab, expression).catch(() => false)
    if (ok === true) return true
    await sleep(300)
  }
  return false
}

const PANEL_TEXT = '(function(){var d=document.querySelector("[role=dialog]");var o=d&&d.querySelector("[class*=options]");return o?(o.innerText||""):""})()'

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

async function main() {
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

    // 打开 设置 → 环境控制台 → 环境 子页
    await evaluate(tab, '(function(){var b=[...document.querySelectorAll("button")].filter(function(n){return (n.innerText||"").trim()==="设置" && n.offsetParent!==null})[0]; if(b) b.click(); return !!b})()')
    await waitFor(tab, '!!document.querySelector("[role=dialog]")')
    await evaluate(tab, '(function(){var d=document.querySelector("[role=dialog]");if(!d)return false;'
      + 'var b=[...d.querySelectorAll("button")].filter(function(n){return (n.innerText||"").indexOf("环境控制台")>=0 && n.offsetParent!==null})[0];'
      + ' if(b) b.click(); return !!b})()')
    await sleep(1500)
    // 切到「设置」子页：试装那一节（含清理计划）在**设置**里，不在「环境」里。
    // 精确匹配「设置」——不能按 indexOf，否则会命中「环境控制台」这个侧栏按钮。
    await evaluate(tab, '(function(){var d=document.querySelector("[role=dialog]");if(!d)return false;'
      + 'var b=[...d.querySelectorAll("[role=tab],button")].filter(function(n){return (n.innerText||"").trim()==="设置" && n.offsetParent!==null})[0];'
      + ' if(b) b.click(); return !!b})()')
    await sleep(2000)

    const text = await evaluate(tab, PANEL_TEXT)
    check('环境子页渲染出内容', typeof text === 'string' && text.length > 20, (text || '').slice(0, 120).replace(/\n/g, ' '))
    check('清理计划区在（下次清理）', /下次清理/.test(text))

    if (STATE === 'planned') {
      check('说出会删几个', /会删这 \d+ 个/.test(text), (text.match(/会删这 \d+ 个/) ?? ['(无)'])[0])
      check('说出会留几个', /会留这 \d+ 个/.test(text))
      check('会删的那个点名了', /dpmc/.test(text))
      check('会留的原因在（用户要问的就是这个）', /正在运行|未到保留期|自动清理已关闭/.test(text))
      // R2：计划里任何一行都不能有两个冒号（宿主原因自带冒号，所以名字与原因必须分层）。
      const twoColon = text.split(String.fromCharCode(10)).filter(line => (line.match(/：/g) ?? []).length >= 2)
      check('R2：计划里没有"一行两个冒号"', twoColon.length === 0, twoColon.join(' | ').slice(0, 120))
      // §12.9 全表
      const { violationsOf } = await import('./copy-rules.mjs')
      const hits = violationsOf(text, 'rendered')
      check('清理计划过 §12.9 的 R1–R7', hits.length === 0, hits.length === 0 ? undefined : '命中 ' + hits.join(', '))
    } else {
      check('空计划说"没有需要清理的测试环境"', /没有需要清理的测试环境/.test(text), (text || '').slice(0, 200).replace(/\n/g, ' '))
    }

    // 截图前必须把计划区**滚进视口**：innerText 读得到滚动外的内容，所以断言会过，
    // 而截图里什么都没有（第一版就是这样——图上只有设置页顶部，计划在折叠线以下）。
    //
    // 注意滚动容器**不是** dialog：实测那条链是
    //   div.trialPlan → fieldset → section → div.panel → div.page → div.options(overflow:auto)
    // 只有 div.options 是可滚动的。所以不能对 dialog 调 scrollTop（那是无效操作，页面纹丝不动），
    // 也不能只靠 scrollIntoView——它会把**祖先链里最近的可滚动元素**滚到位，这里就够用，
    // 但要显式取那个容器来确认它真的动了。
    const scrolled = await evaluate(tab, '(function(){'
      + 'var d=document.querySelector("[role=dialog]"); if(!d) return "no-dialog";'
      + 'var all=[...d.querySelectorAll("*")];'
      + 'var hit=all.filter(function(n){return n.children.length===0 && (n.textContent||"").trim()==="下次清理"})[0];'
      + 'if(!hit) return "no-plan";'
      + 'var box=null; var n=hit.parentElement;'
      + 'while(n && n!==document.body){ if(getComputedStyle(n).overflowY==="auto"){ box=n; break } n=n.parentElement }'
      + 'if(!box) return "no-scroller";'
      + 'box.scrollTop = hit.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 40;'
      + 'return String(box.scrollTop)})()')
    check('计划区真的滚进了视口（截图才拍得到）',
      typeof scrolled === 'string' && Number(scrolled) > 0, String(scrolled))
    await sleep(400)
    shots.push(await capture(tab, join(OUT, 'plan-' + STATE + '-' + THEME + '.png'), { fullPage: false }))
  } finally {
    await tab.close()
    await chrome.close()
  }
  const failed = results.filter(entry => !entry.ok)
  console.log('== ' + STATE + '/' + THEME + '：' + String(results.length - failed.length) + '/' + String(results.length) + ' 通过 ==')
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => { console.error('环境问题: ' + String(error)); process.exit(2) })

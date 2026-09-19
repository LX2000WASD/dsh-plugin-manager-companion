/**
 * trial-cleanup-confirm-evidence.mjs — 清理二次确认框的真机取证（task-91）。
 *
 * 归属：A 类（新工具，不进 pnpm test 的 glob）。
 * 官方复用：无；浏览器侧只用 tools/cdp-shot.mjs。
 * 前提检查：必须**真的点**「清理过期」（不是直接读 DOM）——要证的是"点了会弹框"。
 *
 * 用法：node tests/trial-cleanup-confirm-evidence.mjs --port 3550 --token <t> --out /tmp/t91 --theme light
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { launchChrome, openTab, evaluate, capture } from '../tools/cdp-shot.mjs'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = argv.indexOf('--' + name)
  return index === -1 ? fallback : argv[index + 1]
}
const PORT = Number(arg('port', '3550'))
const TOKEN = arg('token', '')
const OUT = arg('out', '/tmp/t91')
const THEME = arg('theme', 'light')
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

/** 点一个按钮（按可见文本精确匹配）。 */
const clickByText = (text) => '(function(){'
  + 'var t=' + JSON.stringify(text) + ';'
  + 'var b=[...document.querySelectorAll("button")].filter(function(n){return (n.innerText||"").trim()===t && n.offsetParent!==null})[0];'
  + 'if(!b) return false; b.click(); return true})()'

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

    // 设置 → 环境控制台 → 设置 子页
    await evaluate(tab, clickByText('设置'))
    await waitFor(tab, '!!document.querySelector("[role=dialog]")')
    await evaluate(tab, clickByText('环境控制台'))
    await sleep(1500)
    await evaluate(tab, '(function(){var d=document.querySelector("[role=dialog]");if(!d)return false;'
      + 'var b=[...d.querySelectorAll("[role=tab],button")].filter(function(n){return (n.innerText||"").trim()==="设置" && n.offsetParent!==null})[0];'
      + ' if(b) b.click(); return !!b})()')
    await sleep(2000)

    // 点「清理过期」——**真点**，然后看确认框出不出来。
    const clicked = await evaluate(tab, clickByText('清理过期'))
    check('点得到「清理过期」这个真实按钮', clicked === true, String(clicked))
    await sleep(800)

    // 确认框：官方 Modal 是 role=dialog；这一层里会有标题「清理过期测试环境」+ 那句计数文案。
    const modalText = await evaluate(tab, '(function(){'
      + 'var ds=[...document.querySelectorAll("[role=dialog]")];'
      + 'var hit=ds.filter(function(n){return (n.innerText||"").indexOf("清理过期测试环境")>=0})[0];'
      + 'return hit?(hit.innerText||""):""})()')
    check('点下去弹出了确认框（不是直接执行）', typeof modalText === 'string' && modalText.length > 0,
      (modalText || '').slice(0, 120).replace(/\n/g, ' '))
    check('确认框说清了会删几个（按当前计划删除 N 个）', /按当前计划删除 \d+ 个测试环境/.test(modalText),
      (modalText.match(/按当前计划删除 \d+ 个测试环境/) ?? ['(没找到)'])[0])
    check('确认框给了取消与确认两个出口', /取消/.test(modalText) && /清理过期/.test(modalText))

    // §12.9：确认框里的文案也要过同一张表。
    const { violationsOf } = await import('./copy-rules.mjs')
    const hits = violationsOf(modalText, 'rendered')
    check('确认框文案过 §12.9 的 R1–R7', hits.length === 0, hits.length === 0 ? undefined : '命中 ' + hits.join(', '))

    shots.push(await capture(tab, join(OUT, 'confirm-' + THEME + '.png'), { fullPage: false }))

    // 取消之后**不能**执行：清理结果行不该出现。
    await evaluate(tab, clickByText('取消'))
    await sleep(1200)
    const after = await evaluate(tab, '(function(){var d=document.querySelector("[role=dialog]");var o=d&&d.querySelector("[class*=options]");return o?(o.innerText||""):""})()')
    check('取消之后没有执行清理（没有"已删除 N 个"那行）', !/已删除 \d+ 个测试环境/.test(after),
      (after.match(/已删除[^\n]{0,20}/) ?? ['(无)'])[0])

    shots.push(await capture(tab, join(OUT, 'after-cancel-' + THEME + '.png'), { fullPage: false }))
  } finally {
    await tab.close()
    await chrome.close()
  }
  const failed = results.filter(entry => !entry.ok)
  console.log('== confirm/' + THEME + '：' + String(results.length - failed.length) + '/' + String(results.length) + ' 通过 ==')
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => { console.error('环境问题: ' + String(error)); process.exit(2) })

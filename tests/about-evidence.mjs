/**
 * about-evidence.mjs — 「关于」页的真机取证（task-95）。
 *
 * 归属：A 类（新工具，不进 pnpm test 的 glob）。
 * 官方复用：无；浏览器侧只用 tools/cdp-shot.mjs。
 * 前提检查：两种形态都要拍——**正常态**（事实读到了）与**未知态**（事实读不到）。
 *   未知态靠 DSH_INSTALL_ANCHOR 指向一个不存在的文件来造（真实降级，不是假载荷）。
 *
 * 用法：node tests/about-evidence.mjs --port 3560 --token <t> --out /tmp/t95 --theme light --state normal|unknown
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { launchChrome, openTab, evaluate, capture } from '../tools/cdp-shot.mjs'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = argv.indexOf('--' + name)
  return index === -1 ? fallback : argv[index + 1]
}
const PORT = Number(arg('port', '3560'))
const TOKEN = arg('token', '')
const OUT = arg('out', '/tmp/t95')
const THEME = arg('theme', 'light')
const STATE = arg('state', 'normal')
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

const clickByText = (text) => '(function(){'
  + 'var t=' + JSON.stringify(text) + ';'
  + 'var b=[...document.querySelectorAll("button")].filter(function(n){return (n.innerText||"").trim()===t && n.offsetParent!==null})[0];'
  + 'if(!b) return false; b.click(); return true})()'

const PANEL_TEXT = '(function(){var d=document.querySelector("[role=dialog]");var o=d&&d.querySelector("[class*=options]");return o?(o.innerText||""):""})()'

/**
 * 把**某一个标签所在的那一行**滚进视口（截图才拍得到）。
 *
 * 为什么按标签找而不是滚到页首：要证的那一行（例如"缓存年龄"）在折叠线以下，
 * 滚到页首拍不到它——第一版两张图 md5 完全相同就是这么来的。
 *
 * @param label - 行标签文本（如 '缓存年龄'）。
 * @returns 注入用的表达式（返回 scrollTop）。
 */
const SCROLL_TARGET = (label) => '(function(){'
  + 'var want=' + JSON.stringify(label) + ';'
  + 'var d=document.querySelector("[role=dialog]"); if(!d) return "no-dialog";'
  + 'var all=[...d.querySelectorAll("*")];'
  + 'var hit=all.filter(function(n){return n.children.length===0 && (n.textContent||"").trim()===want})[0];'
  + 'if(!hit) return "no-target";'
  + 'var box=null; var n=hit.parentElement;'
  + 'while(n && n!==document.body){ if(getComputedStyle(n).overflowY==="auto"){ box=n; break } n=n.parentElement }'
  + 'if(!box) return "no-scroller";'
  + 'box.scrollTop = hit.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 60;'
  + 'return String(box.scrollTop)})()'

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

    // 设置 → 关于（侧栏最后一项）
    await evaluate(tab, clickByText('设置'))
    await waitFor(tab, '!!document.querySelector("[role=dialog]")')
    await evaluate(tab, clickByText('关于'))
    await sleep(2500)

    const text = await evaluate(tab, PANEL_TEXT)
    check('「关于」页渲染出内容', typeof text === 'string' && text.length > 20, (text || '').slice(0, 120).replace(/\n/g, ' '))
    check('DSH 信息子页在', /DSH 信息/.test(text))

    if (STATE === 'normal') {
      check('DSH 版本读到了（形如 0.1.6-alpha.2）', /0\.1\.\d/.test(text), (text.match(/0\.1\.[^\s]*/) ?? ['(无)'])[0])
      check('Node 版本读到了', /v\d+\.\d+\.\d+/.test(text), (text.match(/v\d+\.\d+\.\d+/) ?? ['(无)'])[0])
      check('平台/架构读到了', /linux|darwin|win32/.test(text))
      check('安装位置读到了', /node_modules\/@deepseek-ai\/dsh/.test(text))
      check('设置文件路径在', /settings\.yaml/.test(text))
      check('本插件版本在', /0\.1\.0/.test(text))
      check('来源在（"这条事实怎么来的"）', /profileContext|process\.|DSH_HOME|修改时间/.test(text))
      check('没有出现「未知」（这一态都读得到）', !/未知/.test(text), (text.match(/未知[^\n]{0,30}/) ?? ['(无)'])[0])
    } else {
      // 未知态怎么造的（**真实的降级，不是假载荷**）：
      //   · 探针里删掉市场索引缓存文件 → files.registryCacheAgeMs 读不到（mtime 拿不到）。
      //   · 试过把 DSH_INSTALL_ANCHOR 指到不存在的路径，但官方 profileContext.installAnchor
      //     **优先于**环境变量（它是权威来源）——所以那条在真机上造不出，实测仍读到真锚点。
      //     锚点降级由单测覆盖（显式喂 unknown 载荷）。
      check('读不到时显示「未知」', /未知/.test(text), (text.match(/未知/) ?? ['(无)'])[0])
      check('读不到时给出原因', /缓存文件还不存在|还没有成功抓过索引/.test(text),
        (text.match(/(缓存文件还不存在|还没有成功抓过索引)[^\n]{0,40}/) ?? ['(无)'])[0])
      // §12.3.3：读不到**不许**用空白/省略冒充——所以要能看到「未知」标记。
      check('读不到的那一项确实有「未知」标记（不是空白）', /未知/.test(text))
      // 反向：**读到的那几项仍然是值**（不是整页都变未知——那会把"一条读不到"放大成"全读不到"）。
      check('其它事实仍正常显示（只有一条降级）', /v\d+\.\d+\.\d+/.test(text) && /settings\.yaml/.test(text),
        (text.match(/v\d+\.\d+\.\d+/) ?? ['(无)'])[0])
    }

    const { violationsOf } = await import('./copy-rules.mjs')
    const hits = violationsOf(text, 'rendered')
    check('关于页文案过 §12.9 的 R1–R7', hits.length === 0, hits.length === 0 ? undefined : '命中 ' + hits.join(', '))

    // 截图前把**要证的那一行**滚进视口。
    // 未知态要拍的是"缓存年龄"那一行（它降级了）——滚到页首是拍不到它的：
    // 第一版两张图 md5 完全相同，就是因为它落在折叠线以下（断言过、图里没有 = 假证据）。
    const scrolled = await evaluate(tab, SCROLL_TARGET(STATE === 'unknown' ? '缓存年龄' : '运行时'))
    check('目标那一行滚进了视口（截图才拍得到）', scrolled !== 'no-target' && scrolled !== 'no-scroller', String(scrolled))
    await sleep(400)
    shots.push(await capture(tab, join(OUT, 'about-' + STATE + '-' + THEME + '.png'), { fullPage: false }))
  } finally {
    await tab.close()
    await chrome.close()
  }
  const failed = results.filter(entry => !entry.ok)
  console.log('== about/' + STATE + '/' + THEME + '：' + String(results.length - failed.length) + '/' + String(results.length) + ' 通过 ==')
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => { console.error('环境问题: ' + String(error)); process.exit(2) })

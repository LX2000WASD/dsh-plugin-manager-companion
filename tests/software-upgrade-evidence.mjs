/**
 * software-upgrade-evidence.mjs — 「关于 → 软件升级」的真机取证（task-96）。
 *
 * 归属：A 类（新工具，不进 pnpm test 的 glob）。
 * 官方复用：无；浏览器侧只用 tools/cdp-shot.mjs，可见性/md5 断言用 tools/shot-assert.mjs（§7.14 的硬要求）。
 *
 * 用法：node tests/software-upgrade-evidence.mjs --port 3570 --token <t> --out /tmp/t96 --theme light --state normal|unknown
 *
 * 两个 state：
 *   · normal —— 探针环境能连 registry：三类单元各自成卡，第①类给命令，第③类写明重启口径；
 *   · unknown —— 把 npm registry 指到一个不存在的地址：**查不到**那一态必须显示出来，
 *     且**绝不**显示"已是最新"（DESIGN §5.5 的核心诚实点）。
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { launchChrome, openTab, evaluate, capture } from '../tools/cdp-shot.mjs'
import { assertShotsDistinct, shotMd5, visibleExpr } from '../tools/shot-assert.mjs'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = argv.indexOf('--' + name)
  return index === -1 ? fallback : argv[index + 1]
}
const PORT = Number(arg('port', '3570'))
const TOKEN = arg('token', '')
const OUT = arg('out', '/tmp/t96')
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

/**
 * 当前**可见**子页的文本。
 *
 * 为什么不能读整个 dialog：两个 tabpanel 都在 DOM 里（第一个还写着"还没有读到"这类文本），
 * `innerText` 会把隐藏的那个也读出来——于是断言拿到的是两页的并集，
 * 既误报（R2/R6 命中的其实是 DSH 信息页的路径文本），又会掩盖真问题。
 * 判据：只取 `[role=tabpanel]:not([hidden])`。
 */
const PANEL_TEXT = '(function(){'
  + 'var d=document.querySelector("[role=dialog]"); if(!d) return "";'
  + 'var p=[...d.querySelectorAll("[role=tabpanel]")].filter(function(n){return !n.hasAttribute("hidden")})[0];'
  + 'return p?(p.innerText||""):""})()'

/** 滚到某个标签所在的那一行（按文本找，不按位置）。 */
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

/**
 * 取第②类（官方实验包）那张卡的文本。
 *
 * 按包名切：从 `@deepseek-ai/dsh-experimental-auto-review` 到下一个包名（或结尾）。
 * 为什么要按卡片切：整页文本里"查不到"可能出现在别的卡片上，整段判会张冠李戴。
 *
 * @param text - 整页文本。
 * @returns 那一张卡的文本。
 */
function secondCard(text) {
  const lines = String(text).split(String.fromCharCode(10))
  const start = lines.findIndex(line => line.trim() === '@deepseek-ai/dsh-experimental-auto-review')
  if (start < 0) return ''
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => line.trim().startsWith('dsh-plugin-manager-companion') || line.trim() === '本插件自身')
  return (end < 0 ? rest : rest.slice(0, end)).join(String.fromCharCode(10))
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

    // 设置 → 关于 → 软件升级
    await evaluate(tab, clickByText('设置'))
    await waitFor(tab, '!!document.querySelector("[role=dialog]")')
    await evaluate(tab, clickByText('关于'))
    await sleep(2500)
    const switched = await evaluate(tab, clickByText('软件升级'))
    check('切得到「软件升级」子页', switched === true, String(switched))
    // 进入即查要出网（或超时失败），给足时间。
    await waitFor(tab, '/检查更新|正在|查不到/.test(' + PANEL_TEXT + ')', 40_000)
    await sleep(6000)

    const text = await evaluate(tab, PANEL_TEXT)
    if (arg('dump', '') === '1') {
      console.log('---- PANEL TEXT ----')
      console.log(String(text).split(String.fromCharCode(10)).map((line, index) => String(index) + ': ' + line).join(String.fromCharCode(10)))
      console.log('---- END ----')
    }
    check('软件升级子页渲染出内容', typeof text === 'string' && text.length > 20, (text || '').slice(0, 140).replace(/\n/g, ' '))
    // 三类单元的类名标签（① 官方运行时 / ② 官方实验包 / ③ 本插件自身）。
    check('第①类（官方运行时）在', /官方运行时/.test(text), (text.match(/官方运行时[^\n]{0,20}/) ?? ['(无)'])[0])

    // 两个态**真正不同**的地方在哪（先想清楚再取证，否则两张图拍的是同一处）：
    //   · 本插件自身（③）在真机上**两个态都是查不到**——它没发布到 npm（404，实测），
    //     所以拿它当"状态差异"的证据是错的。
    //   · 差别在**第②类（官方实验包）**：normal 态能连 registry → 有真实 dist-tags；
    //     unknown 态连不上 → 那一档变"查不到"。
    // 所以截图滚到第②类，并且下面的断言也按这个来。
    if (STATE === 'normal') {
      check('第①类给出升级命令、且不给按钮', /npm i -g|pnpm add -g/.test(text), (text.match(/(npm i -g|pnpm add -g)[^\n]{0,30}/) ?? ['(无)'])[0])
      check('第①类说明"由安装方提供"', /由安装方提供/.test(text))
      check('第③类（本插件自身）在', /本插件自身/.test(text))
      //
      // 关于"重启口径"这条断言：本插件在**真机上不可升级**——它没发布到 npm（404），
      // 所以永远走不到 upgrade 那一支，那句"已安装，下次启动后加载。"在真机上**渲染不出来**。
      // 这不是产品缺陷，是环境的真实事实（探针里本插件是 `link:` 装的）。
      // 那句文案由单测钉住（tests/about-software.test.mjs 的第③类用例 + upgrade-ui 的同名断言）。
      // 这里如实断言**可达**的那件事：第③类要么给升级入口（带重启口径），要么如实说查不到。
      check('第③类如实给态（可升级给入口 / 不可达就说查不到，不留空壳）',
        /已安装，下次启动后加载。|查不到|已经是最新版本/.test(text),
        (text.match(/(已安装，下次启动后加载。|查不到[^\n]{0,30}|已经是最新版本)/) ?? ['(无)'])[0])
      // "已是最新"只允许出现在**已是最新**那一态（§5.5：查不到绝不显示它）。
      // 所以判据不是"不许出现这四个字"，而是"出现了就必须有对应的已是最新卡片"。
      check('"已是最新"若出现，必须对应"已经是最新版本"那一态（不许张冠李戴）',
        !/已是最新/.test(text) || /已经是最新版本/.test(text),
        (text.match(/已经是最新版本/) ?? ['(无)'])[0])
      // 第②类在这一态必须**不是**"查不到"（它能连上 registry）——这才是两个态的差别所在。
      check('第②类在这一态拿到了版本事实（不是查不到）', !/查不到/.test(secondCard(text)),
        secondCard(text).slice(0, 120).replace(/\n/g, ' '))
    } else {
      check('查不到时必须显示「查不到」', /查不到/.test(text), (text.match(/查不到[^\n]{0,40}/) ?? ['(无)'])[0])
      check('查不到时给原因', /registry|网络|ENOTFOUND|ECONNREFUSED|超时|不可用/.test(text),
        (text.match(/(registry|ENOTFOUND|ECONNREFUSED|超时|不可用)[^\n]{0,30}/) ?? ['(无)'])[0])
      check('查不到**绝不**显示"已是最新"', !/已是最新/.test(text), (text.match(/已是最新[^\n]{0,20}/) ?? ['(无)'])[0])
      check('查不到时给重试', /重新检查|重试/.test(text))
    }

    // 按**行**过判据，不是整段。
    // 为什么：R2 的定义就是"同一行"的性质（copy-rules 自己的注释：「按行切（R2 是"同一行"的性质，
    // 不能整段判）」）；R6 也是"一句话里同时出现 上次 + 升级"这种**片段**性质。
    // 第一版把整个面板的 innerText 当一段喂进去，于是"上次检查"（一个元素）与"升级"（另一个元素）
    // 跨元素同时命中，报出**假阳性**——那是我的用法错，不是产品错（§7.13 的同族：判据用错了范围）。
    const { violationsOf } = await import('./copy-rules.mjs')
    const hits = []
    for (const line of String(text).split(String.fromCharCode(10))) {
      for (const id of violationsOf(line, 'rendered')) hits.push(id + ' :: ' + line.slice(0, 60))
    }
    check('软件升级页文案过 §12.9 的 R1–R7（逐行）', hits.length === 0,
      hits.length === 0 ? undefined : '命中 ' + hits.join(' | '))

    // §7.14：截图前断言目标在视口内（滚到它 + 断言相交）。
    // 滚到**第③类那张卡**（本插件自身）。
    // 为什么不是第①类：两张"官方运行时"卡片的标签文本**完全相同**，
    // 按文本找永远命中第一张；而 normal 与 unknown 的差别恰恰在最后一张卡上——
    // 于是两张截图拍的是同一处，md5 相同（第一版就是这样，被 shot-assert 抓住了）。
    const scrolled = await evaluate(tab, SCROLL_TARGET('@deepseek-ai/dsh-experimental-auto-review'))
    check('第②类那张卡滚进了视口（截图才拍得到两个态的差别）', scrolled !== 'no-target' && scrolled !== 'no-scroller', String(scrolled))
    await sleep(400)
    const visible = await evaluate(tab, visibleExpr('[class*=unit]'))
    check('要证的单元卡片与视口相交（截图确实拍得到）', visible === true, String(visible))
    shots.push(await capture(tab, join(OUT, 'software-' + STATE + '-' + THEME + '.png'), { fullPage: false }))
  } finally {
    await tab.close()
    await chrome.close()
  }
  for (const path of shots) console.log('  [md5] ' + shotMd5(path) + '  ' + path)
  const failed = results.filter(entry => !entry.ok)
  console.log('== software/' + STATE + '/' + THEME + '：' + String(results.length - failed.length) + '/' + String(results.length) + ' 通过 ==')
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => { console.error('环境问题: ' + String(error)); process.exit(2) })

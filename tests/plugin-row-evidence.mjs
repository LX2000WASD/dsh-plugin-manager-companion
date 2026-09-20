/**
 * plugin-row-evidence.mjs — 官方插件页里升级行的**形态取证**（task-99）。
 *
 * 归属：A 类（新工具，不进 pnpm test 的 glob）。
 * 官方复用：无；浏览器侧用 tools/cdp-shot.mjs，可见性/md5 断言用 tools/shot-assert.mjs（§7.14）。
 *
 * 取证目标：**同一屏、同一滚动位置**拍升级行那一块，并读回它的几何事实
 * （行块自身的 border / border-radius / background / padding，以及它所在的 detailSections 的 gap）。
 *
 * 为什么要读几何而不是"看截图觉得像不像"：
 *   用户说的是"违和感"，而违和感的可判定形式就是**我们画的容器与官方语法不一致**——
 *   官方插件页的 detailSections 是 gap:32px 的分节，行列表（.row）只有 padding + border-bottom；
 *   我们如果在里面再画一个 border+radius+background 的卡片，就是多了一层容器。
 *   把这三条 CSS 事实读回来，"改前/改后"才是可对照的数字，而不是两张"看着不同"的图。
 *
 * ⚠ 同一 profile 不能并发取证（CODE-POLICY §7.15）：本脚本会开真机、点真实卡片。
 *   取证**串行**跑；起新的之前先确认没有旧的还在（ss -ltn | grep ':35'）。
 *
 * 用法：node tests/plugin-row-evidence.mjs --port 3610 --token <t> --out /tmp/t99 --theme light --tag before
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { launchChrome, openTab, evaluate, capture } from '../tools/cdp-shot.mjs'
import { shotMd5, visibleExpr } from '../tools/shot-assert.mjs'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = argv.indexOf('--' + name)
  return index === -1 ? fallback : argv[index + 1]
}
const PORT = Number(arg('port', '3610'))
const TOKEN = arg('token', '')
const OUT = arg('out', '/tmp/t99')
const THEME = arg('theme', 'light')
/** 这一轮的角色：before / after（写进文件名，改前改后不能混）。 */
const TAG = arg('tag', 'before')
/** 被观察的包（探针里真实装着、且可升级的那一个）。 */
const TARGET = arg('target', '@deepseek-ai/dsh-experimental-auto-review')
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

/** 打开官方插件页（侧栏「插件」）。 */
async function openPluginsPage(tab) {
  await evaluate(tab, '(function(){var d=document.querySelector("[role=dialog]");if(d){document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));}return true})()')
  await sleep(600)
  await dismissFirstRunNotice(tab)
  await evaluate(tab, '(function(){var b=[...document.querySelectorAll("button,a,[role=button]")].filter(function(n){return (n.innerText||"").trim()==="插件" && n.offsetParent!==null})[0]; if(b) b.click(); return !!b})()')
  return await waitFor(tab, '!!document.querySelector("[data-plugin-scope=global]")', 15_000)
}

/**
 * 在列表里点开目标包的详情页。
 *
 * 为什么**不能**按包名找卡片：列表上的卡片标题是**本地化过的**（`@deepseek-ai/dsh-experimental-auto-review`
 * 在界面上显示成「自动授权审查」），包名只出现在详情页的 `code[data-plugin-name]` 里。
 * 第一版按包名找叶子节点，于是永远找不到卡片（实测：列表页开着、详情页没打开）。
 *
 * 判据改成"**点开卡片 → 核对详情页里的包名**"：逐个点已装卡片，读 `[data-plugin-name]`，
 * 命中目标就停下，不是目标就退回列表继续。这样不依赖任何标题文案。
 *
 * @param tab - 标签页。
 * @param name - 目标包名（详情页里的 `data-plugin-name`）。
 * @returns 是否停在目标包的详情页。
 */
async function openDetail(tab, name) {
  const back = async () => {
    const inDetail = await evaluate(tab, '!!document.querySelector("[data-plugin-detail]")')
    if (inDetail !== true) return
    await evaluate(tab, '(function(){var b=[...document.querySelectorAll("button")].filter(function(n){return (n.innerText||"").trim()==="插件列表" && n.offsetParent!==null})[0]; if(b) b.click(); return !!b})()')
    await sleep(900)
  }
  await back()
  // 官方列表把包名**直接写在卡片元素上**（`li[data-plugin-package]`）——
  // 用它定位，不猜标题文案、也不需要"逐个点开核对"。
  const clicked = await evaluate(tab, '(function(){'
    + 'var card=document.querySelector(\'[data-plugin-scope=global] li[data-plugin-package="' + name + '"]\');'
    + 'if(!card) return false;'
    // 可点的是卡片**里面那个 button**（`li` 本身点了不导航——实测两种点法：
    // 点 li 无反应，点它里面的 button 才进详情页）。
    + 'var b=card.querySelector("button");'
    + 'if(!b) return false;'
    + 'b.click(); return true})()')
  if (clicked !== true) return false
  await sleep(1200)
  return await waitFor(tab, '!!document.querySelector("[data-plugin-detail]")', 10_000)
}

/**
 * 升级行那一块的**几何事实**（改前改后对照的判据）。
 *
 * 取的是 `[data-plugin-config]` 里我们注册的那个区块：
 *   · self：它的 border / border-radius / background / padding（我们画的容器）；
 *   · sections：外层 detailSections 的 gap（官方分节语法）；
 *   · rows：官方行列表的 .row 有没有边框（对照：官方靠 border-bottom 分行的那个语法）。
 */
const GEOMETRY = '(function(){'
  + 'var sec=document.querySelector("[data-plugin-detail] [data-plugin-config]");'
  + 'if(!sec) return JSON.stringify({error:"no-config-section"});'
  + 'var cs=getComputedStyle(sec);'
  // 取"我们画的那个块"：升级行的根是 `[role=group][aria-label]`（slot 渲染器可能还包了一层，
  // 直接取 firstElementChild 会拿到没有样式的包装层——实测 boxBorder 恒为 0px，判据空转）。
  + 'var box=sec.querySelector("[role=group]") || sec.firstElementChild;'
  + 'var bc=box?getComputedStyle(box):null;'
  + 'return JSON.stringify({'
  + '  sectionGap:cs.gap, sectionDisplay:cs.display, sectionMarginTop:cs.marginTop,'
  + '  boxTag:box?box.tagName.toLowerCase():"",'
  + '  boxBorder:bc?bc.borderTopWidth:"", boxRadius:bc?bc.borderTopLeftRadius:"",'
  + '  boxBackground:bc?bc.backgroundColor:"", boxPadding:bc?bc.padding:""})})()'

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

    const onPage = await openPluginsPage(tab)
    check('打开了官方插件页', onPage === true)
    const opened = await openDetail(tab, TARGET)
    check('打开了 ' + TARGET + ' 的详情页', opened === true)
    await sleep(1200)

    // 等升级行那一块挂上来（它是本插件的注册项）。
    const hasRow = await waitFor(tab, '!!document.querySelector("[data-plugin-config] *" )', 20_000)
    check('升级行那一块渲染出来了', hasRow === true)

    const raw = await evaluate(tab, GEOMETRY)
    const geom = JSON.parse(String(raw))
    console.log('  [几何] ' + JSON.stringify(geom))
    check('取到了几何事实', geom.error === undefined, JSON.stringify(geom).slice(0, 160))

    // ── 判据（task-99 的核心）：我们那块**不许**自带卡片装饰 ──────────────────
    //
    // 依据（官方自己的渲染上下文）：官方插件页的详情页是"分节 + 行列表"语法——
    // `detailSections{gap:32px}` 里放 `detailSection{gap:12px}`，行列表 `.row` 只有
    // `padding:12px 2px; border-bottom:0.5px`；官方自己的四个配置页用
    // `.field{padding:12px 0}` + `.field + .field{border-top:0.5px}` **靠分隔线分组**。
    // 所以外层的边框/圆角/底色属于**设置页**语法，在这里是多出来的一层容器。
    //
    // 这三条断言是"改前/改后"的**数字判据**（不是看图觉得像不像）：改前实测
    // boxBorder=1px / boxRadius=10px / boxBackground=rgb(255,255,255)。
    check('升级行不自带边框（官方行列表语法）', geom.boxBorder === '0px', 'borderTopWidth=' + String(geom.boxBorder))
    check('升级行不自带圆角', geom.boxRadius === '0px', 'borderTopLeftRadius=' + String(geom.boxRadius))
    check('升级行不自带底色', /rgba\(0, 0, 0, 0\)|transparent/.test(String(geom.boxBackground)),
      'backgroundColor=' + String(geom.boxBackground))

    // §7.14：截图前把目标滚进视口 + 断言相交。
    // 关键：**同一滚动位置**——把目标块的顶部对齐到视口固定偏移（不用"滚到页首"，
    // 那样不同版本的内容高度不同、对照无效）。
    const scrolled = await evaluate(tab, '(function(){'
      + 'var sec=document.querySelector("[data-plugin-detail] [data-plugin-config]");'
      + 'if(!sec) return "no-target";'
      + 'var box=null; var n=sec.parentElement;'
      + 'while(n && n!==document.body){ if(getComputedStyle(n).overflowY==="auto"){ box=n; break } n=n.parentElement }'
      + 'if(!box) return "no-scroller";'
      + 'box.scrollTop = sec.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 120;'
      + 'return String(box.scrollTop)})()')
    check('目标滚进了固定偏移（同一滚动位置）', scrolled !== 'no-target' && scrolled !== 'no-scroller', String(scrolled))
    await sleep(500)
    check('目标块与视口相交（截图拍得到）', (await evaluate(tab, visibleExpr('[data-plugin-config]'))) === true)

    const shot = join(OUT, 'plugin-row-' + TAG + '-' + THEME + '.png')
    shots.push(await capture(tab, shot, { fullPage: false }))
    console.log('  [md5] ' + shotMd5(shot) + '  ' + shot)
  } finally {
    await tab.close()
    await chrome.close()
  }
  const failed = results.filter(entry => !entry.ok)
  console.log('== plugin-row/' + TAG + '/' + THEME + '：' + String(results.length - failed.length) + '/' + String(results.length) + ' 通过 ==')
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => { console.error('环境问题: ' + String(error)); process.exit(2) })

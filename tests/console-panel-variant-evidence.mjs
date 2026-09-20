/**
 * console-panel-variant-evidence.mjs — 插件页配置面板的**容器语法**取证（task-105）。
 *
 * 归属：A 类（新工具，不进 pnpm test 的 glob——真机取证需要实例与浏览器）。
 * 官方复用：无；浏览器侧用 tools/cdp-shot.mjs，可见性/md5 断言用 tools/shot-assert.mjs（§7.14）。
 *
 * 取证目标（两件必须同时成立的事，缺一条就不能叫"按页面切"）：
 *   ① **插件页**：四个分组容器（质量门 / 诊断分层 / 市场 / 试装）的 border / radius / background
 *      全为 0 / 透明——即容器装饰真的没了；
 *   ② **设置页子页**：同一批容器的这三项**仍然是卡片**——即这不是"把卡片全删了"。
 *
 * 为什么两个页面都要测：只测插件页的话，"删掉 .group 的装饰"同样能全绿，
 * 而那会把设置页也一起改坏（用户最初观察的正是"两页语法不同"，不是"卡片不好"）。
 * 判据必须能区分"按页面切"与"全删"（§7.13：判据要钉在能区分的那条上）。
 *
 * 为什么读几何而不是"看截图觉得像不像"：违和感的可判定形式就是"我们画的容器与官方语法不一致"。
 * 官方插件页是 detailSections{gap:32px} → detailSection{gap:12px} 的分节，行列表 .row 只有
 * padding + border-bottom；官方自己的配置表单（ui-settings-plugins/fields.module.css）是
 * .field{padding:12px 0} + .field + .field{border-top:0.5px}——**一个边框都没有**。
 * 把这三条读回来，"改前/改后"才是可对照的数字。
 *
 * ⚠ 同一 profile 不能并发取证（CODE-POLICY §7.15）：本脚本会开真机、点真实页面。取证**串行**跑。
 *
 * 用法：node tests/console-panel-variant-evidence.mjs --port 3620 --token <t> --out /tmp/t105 --theme light --tag after
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { launchChrome, openTab, evaluate, capture } from '../tools/cdp-shot.mjs'
import { shotMd5, assertShotsDistinct, visibleExpr } from '../tools/shot-assert.mjs'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = argv.indexOf('--' + name)
  return index === -1 ? fallback : argv[index + 1]
}
const PORT = Number(arg('port', '3620'))
const TOKEN = arg('token', '')
const OUT = arg('out', '/tmp/t105')
const THEME = arg('theme', 'light')
/** 这一轮的角色：before / after / mutated（写进文件名，改前改后不能混）。 */
const TAG = arg('tag', 'after')
/** 插件页里本插件的包名（详情页 code[data-plugin-name] 里那个）。 */
const OUR_PACKAGE = arg('package', 'dsh-plugin-manager-companion')
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

/**
 * 读一批元素的**容器装饰**三件套。
 *
 * 判据元素：`fieldset`——两套语法下它都是"分组容器"本身（.group / .groupPlain 都挂在它上面），
 * 所以改前改后取到的是**同一个元素**，对照成立。
 * （不用 `[role=group]`：那是升级行的根，不是配置面板的分组容器。）
 *
 * @param scope - 限定在哪个容器里找（'plugin' = 官方详情页的 [data-plugin-config]；'settings' = 设置面板）。
 * @returns 注入用的表达式（返回 JSON 字符串）。
 */
const containersExpr = (scope) => '(function(){'
  + 'var root=' + (scope === 'plugin'
    ? 'document.querySelector("[data-plugin-detail] [data-plugin-config]")'
    : '(function(){var d=document.querySelector("[role=dialog]");return d?d.querySelector("[class*=options]"):null})()')
  + ';'
  + 'if(!root) return JSON.stringify({error:"no-root",scope:' + JSON.stringify(scope) + '});'
  + 'var fieldsets=[...root.querySelectorAll("fieldset")];'
  + 'return JSON.stringify({scope:' + JSON.stringify(scope) + ',count:fieldsets.length,boxes:fieldsets.map(function(n){'
  + '  var cs=getComputedStyle(n);'
  + '  var legend=n.querySelector("legend");'
  // 四条边**分开**报：卡片是"四面闭合的盒子"，分隔线是"只有上边、且只出现在相邻项之间"。
  // 只报 borderTopWidth 会把这两件事混成一个数——那正是第一版判据的错（§7.15 推论三）。
  + '  return {title:legend?(legend.innerText||"").trim():"",'
  + '    top:cs.borderTopWidth,right:cs.borderRightWidth,bottom:cs.borderBottomWidth,left:cs.borderLeftWidth,'
  + '    radius:cs.borderTopLeftRadius,background:cs.backgroundColor,'
  + '    paddingTop:cs.paddingTop,paddingBottom:cs.paddingBottom};'
  + '})})})()'

/** 打开官方插件页并进入本包详情页。 */
async function openPluginDetail(tab) {
  await evaluate(tab, '(function(){var d=document.querySelector("[role=dialog]");if(d){document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));}return true})()')
  await sleep(600)
  await dismissFirstRunNotice(tab)
  await evaluate(tab, '(function(){var b=[...document.querySelectorAll("button,a,[role=button]")].filter(function(n){return (n.innerText||"").trim()==="插件" && n.offsetParent!==null})[0]; if(b) b.click(); return !!b})()')
  const onList = await waitFor(tab, '!!document.querySelector("[data-plugin-scope=global]")', 15_000)
  if (onList !== true) return false
  const clicked = await evaluate(tab, '(function(){'
    + 'var card=document.querySelector(\'[data-plugin-scope=global] li[data-plugin-package="' + OUR_PACKAGE + '"]\');'
    + 'if(!card) return false; var b=card.querySelector("button"); if(!b) return false; b.click(); return true})()')
  if (clicked !== true) return false
  await sleep(1200)
  return await waitFor(tab, '!!document.querySelector("[data-plugin-detail] [data-plugin-config] fieldset")', 20_000)
}

/** 打开设置 → 环境控制台 → 设置子页。 */
async function openSettingsSubpage(tab) {
  await evaluate(tab, '(function(){var d=document.querySelector("[role=dialog]");if(d){document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));}return true})()')
  await sleep(600)
  await dismissFirstRunNotice(tab)
  await evaluate(tab, '(function(){var b=[...document.querySelectorAll("button,a,[role=button]")].filter(function(n){return (n.innerText||"").trim()==="设置" && n.offsetParent!==null})[0]; if(b) b.click(); return !!b})()')
  const opened = await waitFor(tab, '!!document.querySelector("[role=dialog]")', 15_000)
  if (opened !== true) return false
  await evaluate(tab, '(function(){var b=[...document.querySelectorAll("button,a,[role=button]")].filter(function(n){return (n.innerText||"").trim()==="环境控制台" && n.offsetParent!==null})[0]; if(b) b.click(); return !!b})()')
  await sleep(1500)
  await evaluate(tab, '(function(){var d=document.querySelector("[role=dialog]");if(!d)return false;'
    + 'var b=[...d.querySelectorAll("[role=tab],button")].filter(function(n){return (n.innerText||"").trim()==="设置" && n.offsetParent!==null})[0]; if(b) b.click(); return !!b})()')
  await sleep(2000)
  return await waitFor(tab, '!!document.querySelector("[role=dialog] [class*=options] fieldset")', 20_000)
}

/**
 * 把目标滚到固定偏移（改前改后同一滚动位置，§7.14）。
 *
 * 从 **hit 自己**开始找可滚动祖先（不是 hit.parentElement）：设置页里那个
 * `div.options` **本身就是滚动容器**，从父节点开始找会一路走到 body 得到 "no-scroller"
 * （第一版就是这么报的，而截图其实拍得到——断言空转，正是 §7.14 要防的形态）。
 *
 * @param scope - 'plugin'（官方详情页）或 'settings'（设置面板）。
 * @returns 注入用的表达式（返回 scrollTop 的字符串）。
 */
async function scrollTo(tab, scope) {
  const selector = scope === 'plugin' ? '[data-plugin-config]' : '[role=dialog] [class*=options]'
  return await evaluate(tab, '(function(){'
    + 'var hit=document.querySelector(' + JSON.stringify(selector) + ');'
    + 'if(!hit) return "no-target";'
    + 'var box=null; var n=hit;'
    + 'while(n && n!==document.body){ if(getComputedStyle(n).overflowY==="auto"){ box=n; break } n=n.parentElement }'
    + 'if(!box) return "no-scroller";'
    + 'box.scrollTop = hit.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 120;'
    + 'return String(box.scrollTop)})()')
}

const TRANSPARENT = /rgba\(0, 0, 0, 0\)|transparent/
const px = value => Number(String(value).replace('px', ''))

/**
 * 把一批容器的装饰断言成"卡片"或"官方表单语法"。
 *
 * **卡片与分隔线必须分开判**（第一版把两者混成一个 `borderTopWidth`，于是改后误报红）：
 *   · 卡片 = 四面闭合的盒子（四条边都非 0）+ 圆角 + 底色；
 *   · 分隔线 = 只有上边、没有左右下边、没有圆角、没有底色，且**只出现在相邻项之间**
 *     （首项不许有引导线）。官方 `.field + .field { border-top: 0.5px }` 正是后者。
 * 所以"无卡片"的判据是**左右边为 0**（盒子不再闭合），而不是"上边为 0"。
 *
 * @param scope - 'plugin' 或 'settings'（只用于日志）。
 * @param label - 断言前缀。
 * @param geom - 探针读回的几何。
 * @param expect - 'card'（设置页）或 'plain'（插件页）。
 */
function judge(scope, label, geom, expect) {
  if (geom.error !== undefined) { check(label + '：取到几何事实', false, JSON.stringify(geom)); return }
  check(label + '：分组容器都在', geom.count >= 4, 'count=' + String(geom.count))
  console.log('  [' + scope + ' 几何] ' + JSON.stringify(geom.boxes))
  const boxes = geom.boxes
  const radii = boxes.map(b => b.radius)
  const bgs = boxes.map(b => b.background)
  const closed = boxes.map(b => b.top !== '0px' && b.right !== '0px' && b.bottom !== '0px' && b.left !== '0px')
  const sides = boxes.map(b => b.top + '/' + b.right + '/' + b.bottom + '/' + b.left)
  if (expect === 'card') {
    // 设置页子页：卡片语法必须**仍然在**（证明是"按页面切"而不是"全删"）。
    check(label + '：仍是卡片（四面闭合的边框）', closed.every(Boolean), sides.join(' '))
    check(label + '：仍是卡片（有圆角）', radii.every(v => px(v) > 0), radii.join(','))
    check(label + '：仍是卡片（有底色）', bgs.every(v => !TRANSPARENT.test(v)), bgs.join(','))
  } else {
    // 插件页：盒子必须**不再闭合**（左右边为 0）、无圆角、无底色。
    check(label + '：分组容器不是卡片（左右边为 0，盒子不闭合）',
      boxes.every(b => b.left === '0px' && b.right === '0px'), sides.join(' '))
    check(label + '：分组容器无圆角', radii.every(v => v === '0px'), radii.join(','))
    check(label + '：分组容器无底色', bgs.every(v => TRANSPARENT.test(v)), bgs.join(','))
    // 分隔线：官方 .field + .field 语法——首项无引导线，其余项上边是发丝线。
    check(label + '：首项没有引导线（分隔线只出现在相邻项之间）', boxes[0]?.top === '0px', String(boxes[0]?.top))
    check(label + '：相邻分组之间是发丝分隔线（≤1px，且只在上边）',
      boxes.slice(1).every(b => px(b.top) > 0 && px(b.top) <= 1 && b.left === '0px' && b.right === '0px' && b.bottom === '0px'),
      boxes.slice(1).map(b => b.top + '/' + b.right + '/' + b.bottom + '/' + b.left).join(' '))
    // 与官方 fields.module.css 同构：内边距是 .field 的 12px 0（不是卡片的 10px 12px）。
    check(label + '：内边距对齐官方 .field（12px 0，不再是卡片的 10px 12px）',
      boxes.every(b => b.paddingTop === '12px' && b.paddingBottom === '12px'),
      boxes.map(b => b.paddingTop + ' ' + b.paddingBottom).join(','))
  }
}

/**
 * 注入表达式的**语法自检**（在开浏览器之前跑）。
 *
 * 为什么要有：第一版 `containersExpr` 少了一个右括号，脚本一路跑到真机、
 * 打开详情页之后才在 `Runtime.evaluate` 里炸掉（`SyntaxError: Unexpected end of input`）——
 * 一次真机取证就这么废了，而错的是一个纯字符串问题。
 * 用 `new Function` 在本地把每个注入表达式 parse 一遍，代价为零。
 *
 * @param expression - 要注入页面的表达式。
 * @param what - 表达式名字（写进错误里）。
 * @throws 语法不合法时抛错。
 */
function assertParses(expression, what) {
  try {
    // eslint-disable-next-line no-new-func -- 只做语法检查，不求值
    new Function('return (' + expression + ')')
  } catch (error) {
    throw new Error('注入表达式语法错误（' + what + '）：' + String(error && error.message))
  }
}

async function main() {
  assertParses(containersExpr('plugin'), 'containersExpr(plugin)')
  assertParses(containersExpr('settings'), 'containersExpr(settings)')
  assertParses(visibleExpr('[data-plugin-config]'), 'visibleExpr')
  const chrome = await launchChrome()
  const tab = await openTab(chrome.port)
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

    // ── 插件页 ────────────────────────────────────────────────────────────
    const onPlugin = await openPluginDetail(tab)
    check('打开了官方插件页里本包的详情页', onPlugin === true)
    if (onPlugin === true) {
      const raw = await evaluate(tab, containersExpr('plugin'))
      judge('plugin', '插件页', JSON.parse(String(raw)), 'plain')
      const scrolled = await scrollTo(tab, 'plugin')
      check('插件页滚到了固定偏移（同一滚动位置）', scrolled !== 'no-target' && scrolled !== 'no-scroller', String(scrolled))
      await sleep(500)
      check('插件页目标与视口相交（截图拍得到）', (await evaluate(tab, visibleExpr('[data-plugin-config]'))) === true)
      const shot = join(OUT, 'plugin-panel-' + TAG + '-' + THEME + '.png')
      await capture(tab, shot, { fullPage: false })
      console.log('  [md5] ' + shotMd5(shot) + '  ' + shot)
    }

    // ── 设置页子页（同一实例、同一轮）──────────────────────────────────────
    const onSettings = await openSettingsSubpage(tab)
    check('打开了设置 → 环境控制台 → 设置 子页', onSettings === true)
    if (onSettings === true) {
      const raw = await evaluate(tab, containersExpr('settings'))
      judge('settings', '设置页', JSON.parse(String(raw)), 'card')
      const scrolled = await scrollTo(tab, 'settings')
      check('设置页滚到了固定偏移（同一滚动位置）', scrolled !== 'no-target' && scrolled !== 'no-scroller', String(scrolled))
      await sleep(500)
      check('设置页目标与视口相交（截图拍得到）', (await evaluate(tab, visibleExpr('[role=dialog] [class*=options]'))) === true)
      const shot = join(OUT, 'settings-panel-' + TAG + '-' + THEME + '.png')
      await capture(tab, shot, { fullPage: false })
      console.log('  [md5] ' + shotMd5(shot) + '  ' + shot)
    }
  } finally {
    await tab.close()
    await chrome.close()
  }
  const failed = results.filter(entry => !entry.ok)
  console.log('== panel-variant/' + TAG + '/' + THEME + '：' + String(results.length - failed.length) + '/' + String(results.length) + ' 通过 ==')
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => { console.error('环境问题: ' + String(error)); process.exit(2) })

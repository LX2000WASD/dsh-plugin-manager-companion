/**
 * env-copy-evidence.mjs — envManager 用户文案（§12.9 R2/R3）的真机取证（task-89）。
 *
 * 归属：A 类（新工具，不进 pnpm test 的 glob）。
 * 官方复用：无；浏览器侧用 tools/cdp-shot.mjs，可见性/md5 断言用 tools/shot-assert.mjs（§7.14）。
 *
 * 为什么选「环境控制台 → 设置」这一页：task-89 改的是 `src/envManager.ts` 里**用户可见的那几行**，
 * 它们出现在两处——新建环境/启动环境的回执、以及试装结果块。前者最容易在真机上触发
 * （建一个环境就有回执），且回执里正好含本轮改掉的「组合层」（原 `bundle 层栈`）。
 *
 * 四段：
 *   ① 建一个环境 → 回执里应当是「组合层」，**不许**再出现 `bundle 层栈` / `层栈`；
 *   ② 环境列表里那个新环境在（证明 ① 的回执对应一个真实结果，不是空转）；
 *   ③ 整页过 §12.9 R1–R7（逐行 + 整块各自按规则的定义，见 §7.15）；
 *   ④ 截图并断言 md5 两两不同。
 *
 * ⚠ 同一 profile 不能并发取证（2026-09-20，task-97 实际踩过）：
 *   本脚本会**真的改探针环境**（建/删环境）。两个取证任务同时跑会争用同一个 profile，
 *   双方都拿到半真半假的状态，那一轮结论全部作废——只能杀掉重跑。
 *   规矩：取证**串行**跑；起新的之前先确认没有旧的还在（ss -ltn | grep ':35'）。
 *   完整记录见 docs/CODE-POLICY.md §7.15。
 *
 * 用法：node tests/env-copy-evidence.mjs --port 3600 --token <t> --out /tmp/t89 --theme light
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
const PORT = Number(arg('port', '3600'))
const TOKEN = arg('token', '')
const OUT = arg('out', '/tmp/t89')
const THEME = arg('theme', 'light')
/** 本轮建的那个一次性环境名（跑完删掉）。 */
const NEW_ENV = arg('name', 'copy-probe-dpmc')
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

/** 精确文本点按钮（可见的）。 */
const clickByText = (text) => '(function(){'
  + 'var t=' + JSON.stringify(text) + ';'
  + 'var b=[...document.querySelectorAll("button")].filter(function(n){return (n.innerText||"").trim()===t && n.offsetParent!==null})[0];'
  + 'if(!b) return false; b.click(); return true})()'

/** 设置面板里当前可见子页的文本。 */
const PANEL_TEXT = '(function(){'
  + 'var d=document.querySelector("[role=dialog]"); if(!d) return "";'
  + 'var p=[...d.querySelectorAll("[role=tabpanel]")].filter(function(n){return !n.hasAttribute("hidden")})[0];'
  + 'return p?(p.innerText||""):(d.innerText||"")})()'

/** 按文本把某一行滚进视口（截图才拍得到）。 */
const SCROLL_TARGET = (label) => '(function(){'
  + 'var want=' + JSON.stringify(label) + ';'
  + 'var d=document.querySelector("[role=dialog]"); if(!d) return "no-dialog";'
  + 'var all=[...d.querySelectorAll("*")];'
  + 'var hit=all.filter(function(n){return n.children.length===0 && (n.textContent||"").indexOf(want)>=0})[0];'
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
    // 首次运行会弹「配置模型」引导层。**必须真的把它关掉**：
    // 它是一个 portal 覆盖层（[role=dialog] + aria-label="添加一个 API Key 开始使用"），
    // 开着的时候会**挡住「新建环境」的点击**——第一版实测：点了但对话框根本没开，
    // 于是找输入框恒为 no-input（看起来像选择器写错，其实是前面那层没关）。
    // 关法：按 aria-label 找到它，点它的「稍后配置」。
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const closed = await evaluate(tab, '(function(){'
        + 'var ds=[...document.querySelectorAll("[role=dialog]")];'
        + 'var onb=ds.filter(function(n){return /API Key|API 密钥|开始使用/.test(n.getAttribute("aria-label")||"") || /开始使用/.test(n.innerText||"")})[0];'
        + 'if(!onb) return "none";'
        + 'var b=[...onb.querySelectorAll("button")].filter(function(n){return /稍后配置|跳过|关闭|Skip|Later/.test((n.innerText||"").trim())})[0];'
        + 'if(!b) return "no-button";'
        + 'b.click(); return "clicked"})()')
      if (closed === 'none') break
      await sleep(800)
    }
    // 断言它真的关了（否则后面所有步骤都会失败，而失败原因会被误读成选择器问题）。
    const onboardingGone = await evaluate(tab, '(function(){'
      + 'return String([...document.querySelectorAll("[role=dialog]")].filter(function(n){return /开始使用/.test(n.innerText||"")}).length === 0)})()')
    check('首次运行引导层已关闭（否则它会挡住后面的点击）', onboardingGone === 'true', String(onboardingGone))

    // 设置 → 环境控制台 → 环境 子页
    //
    // ⚠ 又是同名（本轮第三次）：环境控制台**内部**也有一个叫「设置」的子页标签，
    // 而「设置」在侧栏是入口。不限定范围时，后面那一步会点到子页标签、把「环境」切走。
    // 这里两个点击都限定为**框外**（侧栏与设置面板的导航都还没有 dialog 包着入口那一层）。
    await evaluate(tab, '(function(){'
      + 'var b=[...document.querySelectorAll("button")].filter(function(n){return (n.innerText||"").trim()==="设置" && n.offsetParent!==null})[0];'
      + 'if(!b) return false; b.click(); return true})()')
    await waitFor(tab, '!!document.querySelector("[role=dialog]")')
    await sleep(800)
    await evaluate(tab, '(function(){'
      + 'var d=document.querySelector("[role=dialog]"); if(!d) return false;'
      + 'var b=[...d.querySelectorAll("button")].filter(function(n){return (n.innerText||"").trim()==="环境控制台" && n.offsetParent!==null})[0];'
      + 'if(!b) return false; b.click(); return true})()')
    await sleep(1500)
    await evaluate(tab, '(function(){var d=document.querySelector("[role=dialog]");if(!d)return false;'
      + 'var b=[...d.querySelectorAll("[role=tab],button")].filter(function(n){return (n.innerText||"").trim()==="环境" && n.offsetParent!==null})[0];'
      + ' if(b) b.click(); return !!b})()')
    await sleep(1500)

    // ① 新建环境 → 回执
    //
    // ⚠ 同名陷阱（§12.10 的反面教材，本轮踩了三次）：
    //   · 「设置」既是侧栏入口、又是环境控制台内部的子页标签；
    //   · 「新建环境」既是**触发按钮**、又是它打开后的**对话框标题**（`env.create` 与
    //     `env.createTitle` 两个字面值相同）。
    //
    // 更绕的是：**环境控制台面板本身就在 [role=dialog] 里**（设置面板是一个 Modal），
    // 所以"不在任何 dialog 里"这种限定范围会**把真正的按钮也排掉**（实测：buttons 列表里
    // 唯一那个按钮 inDialog=true）。
    //
    // 正确判据：找**创建对话框自己**（aria-label="新建环境"），若它开着就先关掉；
    // 然后点那个"在设置面板里、但不是创建对话框"的按钮。
    const createDialogOpen = '(function(){return [...document.querySelectorAll("[role=dialog]")].filter(function(n){return n.getAttribute("aria-label")==="新建环境"}).length})()'
    const closeStale = await evaluate(tab, '(function(){'
      + 'var d=[...document.querySelectorAll("[role=dialog]")].filter(function(n){return n.getAttribute("aria-label")==="新建环境"})[0];'
      + 'if(!d) return "none";'
      + 'var b=[...d.querySelectorAll("button")].filter(function(n){return /取消|关闭|Close|Cancel/.test((n.innerText||"").trim()) || (n.getAttribute("aria-label")||"").match(/关闭|Close/)})[0];'
      + 'if(!b) return "no-button";'
      + 'b.click(); return "closed"})()')
    if (closeStale !== 'none') await sleep(800)
    check('点之前没有残留的「新建环境」对话框', String(await evaluate(tab, createDialogOpen)) === '0', String(await evaluate(tab, createDialogOpen)))
    // 触发按钮的判据：文本是「新建环境」、可见、且**不在**创建对话框里（它在设置面板里，那是正常的）。
    const opened = await evaluate(tab, '(function(){'
      + 'var b=[...document.querySelectorAll("button")].filter(function(n){'
      + '  if ((n.innerText||"").trim()!=="新建环境" || n.offsetParent===null) return false;'
      + '  var owner=[...document.querySelectorAll("[role=dialog]")].filter(function(d){return d.contains(n)})[0];'
      + '  return !owner || owner.getAttribute("aria-label")!=="新建环境"})[0];'
      + 'if(!b) return false; b.click(); return true})()')
    check('点得到「新建环境」触发按钮', opened === true, String(opened))
    // 等对话框**真的出现**再往下走，不要用固定 sleep：
    // 实测 1.5s 有时还不够（对话框还没挂上来），于是后面 find input 恒为空，
    // 而失败现象看起来像"选择器写错"——**等条件、不等时间**。
    // 判据用 **aria-label**，不用 innerText：设置面板那个 dialog 的 innerText 里**也含**
    // 「新建环境」（因为里面就有那个按钮），用文本判会**永远命中它**——
    // 于是 dialogUp 瞬间为真、而后面操作的是错误的那一层（实测就是这个：
    // 对话框"出现了"但里面没有 input）。官方 Modal 的 aria-label 就是它的 title。
    // ⚠ 这里必须返回**布尔**，不能包一层 String()：`waitFor` 的判据是 `ok === true`，
    // 字符串 "true" 永远不等于 true → 条件恒不满足 → 白等 20s 后报 FAIL。
    // 实测就是这个：断言红了，而紧跟着的"填名字/点创建"全都通过（对话框其实早就开了）。
    const dialogUp = await waitFor(tab, '(function(){'
      + 'return [...document.querySelectorAll("[role=dialog]")].filter(function(n){return n.getAttribute("aria-label")==="新建环境"}).length > 0})()', 20_000)
    check('「新建环境」对话框出现', dialogUp === true)
    if (arg('dump', '') === '1') {
      console.log('  [dump] dialogs = ' + String(await evaluate(tab, '(function(){return JSON.stringify([...document.querySelectorAll("[role=dialog]")].map(function(n){return {label:n.getAttribute("aria-label"), text:(n.innerText||"").slice(0,40), inputs:n.querySelectorAll("input").length}}))})()')))
    }
    // 填名字：找**创建对话框**里第一个文本输入（按 aria-label 定位，理由同上）。
    const typed = await evaluate(tab, '(function(){'
      + 'var ds=[...document.querySelectorAll("[role=dialog]")];'
      + 'var d=ds.filter(function(n){return n.getAttribute("aria-label")==="新建环境"})[0];'
      + 'if(!d) return "no-dialog";'
      + 'var i=[...d.querySelectorAll("input")].filter(function(n){return n.type!=="checkbox" && n.offsetParent!==null})[0];'
      + 'if(!i) return "no-input";'
      + 'var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;'
      + 'setter.call(i,' + JSON.stringify(NEW_ENV) + ');'
      + 'i.dispatchEvent(new Event("input",{bubbles:true}));'
      + 'return i.value})()')
    check('填得上环境名', typed === NEW_ENV, String(typed))
    await sleep(500)
    const submitted = await evaluate(tab, '(function(){'
      + 'var ds=[...document.querySelectorAll("[role=dialog]")];'
      + 'var d=ds.filter(function(n){return n.getAttribute("aria-label")==="新建环境"})[0];'
      + 'if(!d) return false;'
      + 'var b=[...d.querySelectorAll("button")].filter(function(n){return (n.innerText||"").trim()==="创建" && n.offsetParent!==null})[0];'
      + 'if(!b) return false; b.click(); return true})()')
    check('点得到「创建」', submitted === true, String(submitted))
    const created = await waitFor(tab, '/已创建环境|创建环境失败|环境不存在/.test(' + PANEL_TEXT + ')', 60_000)
    check('创建回执出现', created === true)
    await sleep(1500)

    const text = await evaluate(tab, PANEL_TEXT)
    // ② 本轮改掉的那一处：回执里应当是「组合层」
    check('回执用「组合层」（§12.9 R3：层栈是内部代号）', /组合层/.test(text),
      (text.match(/组合层[^\n]{0,40}/) ?? ['(无)'])[0])
    // 反向：旧代号**不许**再上屏（这条是 R3 的核心）。
    check('回执里没有「bundle 层栈」/「层栈」', !/层栈/.test(text),
      (text.match(/[^\n]{0,20}层栈[^\n]{0,20}/) ?? ['(无)'])[0])
    check('回执里没有「挂载」/「快照」/「锚点」/「金丝雀」/「盘上事实」',
      !/挂载|快照|锚点|金丝雀|盘上事实/.test(text),
      (text.match(/[^\n]{0,20}(挂载|快照|锚点|金丝雀|盘上事实)[^\n]{0,20}/) ?? ['(无)'])[0])

    // ③ 文案过 §12.9（逐行 + 整块各自按规则定义，见 §7.15）
    const { violationsOf } = await import('./copy-rules.mjs')
    const blockHits = violationsOf(text, 'rendered')
    check('环境页整块过 §12.9 的 R1–R7', blockHits.length === 0,
      blockHits.length === 0 ? undefined : '命中 ' + blockHits.join(', '))
    const lineHits = []
    for (const line of String(text).split(String.fromCharCode(10))) {
      for (const id of violationsOf(line, 'rendered')) lineHits.push(id + ' :: ' + line.slice(0, 60))
    }
    check('环境页逐行过 §12.9 的 R1–R7', lineHits.length === 0,
      lineHits.length === 0 ? undefined : '命中 ' + lineHits.join(' | '))

    // 回执是 `p.notice[role=status]`（ConsolePage:1857）。
    // 选择器用 **role=status** 这个稳定属性，不用 `[class*=notice]`：
    // CSS Modules 的类名是哈希的（产物里是 `YO0ypa_notice` 这种），`[class*=notice]` 恰好也能中，
    // 但它同时会中一堆别的东西（`[role=status]` 在本页有十来个）——判据要指到**那一条**上。
    // 可见性判据必须指到**回执那一块**，不能只写 `[role=status]`：
    // 本页有十来个 `[role=status]`（体检、能力提示、busy…），`visibleExpr` 取的是**第一个**——
    // 那是别的东西，于是断言恒红（实测）。
    // 这里用 `:has()` 找到"内含已创建环境那行"的那个元素（回执块），对它判可见性。
    // 这一步是 §7.14 的硬要求：截图前必须断言目标**真的在视口内**。
    const scrolled = await evaluate(tab, SCROLL_TARGET('已创建环境'))
    check('回执那一行滚进了视口', scrolled !== 'no-target' && scrolled !== 'no-scroller', String(scrolled))
    await sleep(400)
    const visible = await evaluate(tab, visibleExpr('pre:has(+ *), [role=status]:has(*)'))
    const receiptVisible = await evaluate(tab, '(function(){'
      + 'var all=[...document.querySelectorAll("*")].filter(function(n){return n.children.length===0 && (n.textContent||"").indexOf("已创建环境")>=0});'
      + 'if(!all.length) return "no-receipt";'
      + 'var r=all[0].getBoundingClientRect();'
      + 'var h=window.innerHeight||document.documentElement.clientHeight;'
      + 'return String(r.bottom>0 && r.top<h && r.width>0)})()')
    check('回执那一行与视口相交（截图拍得到）', receiptVisible === 'true', String(receiptVisible) + ' / ' + String(visible))
    shots.push(await capture(tab, join(OUT, 'env-copy-' + THEME + '.png'), { fullPage: false }))

    // 收尾：把刚建的一次性环境删掉（不留垃圾）
    const removed = await evaluate(tab, '(function(){'
      + 'var d=document.querySelector("[role=dialog]"); if(!d) return false;'
      + 'var rows=[...d.querySelectorAll("*")].filter(function(n){return (n.textContent||"").indexOf(' + JSON.stringify(NEW_ENV) + ')>=0});'
      + 'var b=[...d.querySelectorAll("button")].filter(function(n){return (n.innerText||"").trim()==="删除" && n.offsetParent!==null})[0];'
      + 'if(!b) return false; b.click(); return true})()')
    console.log('  [收尾] 删除按钮点到：' + String(removed))
  } finally {
    await tab.close()
    await chrome.close()
  }
  for (const path of shots) console.log('  [md5] ' + shotMd5(path) + '  ' + path)
  const failed = results.filter(entry => !entry.ok)
  console.log('== env-copy/' + THEME + '：' + String(results.length - failed.length) + '/' + String(results.length) + ' 通过 ==')
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => { console.error('环境问题: ' + String(error)); process.exit(2) })

/**
 * trial-cleanup-confirm-evidence.mjs — 清理二次确认框的真机取证（task-91 + task-92）。
 *
 * 归属：A 类（新工具，不进 pnpm test 的 glob）。
 * 官方复用：无；浏览器侧只用 tools/cdp-shot.mjs。
 * 前提检查：必须**真的点**「清理过期」（不是直接读 DOM）——要证的是"点了会弹框"。
 *
 * 两个场景（task-92 加的第二个是 Lead 裁决的"不删东西的等价场景"）：
 *   · `planned`：有计划（会删 N 个）→ 点开框 → **取消** → 断言没执行、目录没变；
 *   · `empty`  ：计划为空（会删 0 个）→ 点开框 → **点确认** → 断言**执行路径真的被触发**
 *               （引擎的如实回执出现），且**没有任何目录被删**。
 *
 * 为什么需要第二个：第一个只验到"取消不执行"——那等于"点了会执行"从未被任何真机证据支持。
 * 而直接在有计划的场景点确认会真删掉取证构造物，为证明"能删"而破坏取证环境性价比不对。
 *
 * 用法：node tests/trial-cleanup-confirm-evidence.mjs --port 3550 --token <t> --out /tmp/t91 --theme light [--state planned|empty]
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
 * 点一个按钮（按可见文本精确匹配）。
 *
 * **必须限定范围**（task-92 实测踩到的坑）：触发按钮与确认框里的确认按钮**文案相同**
 * （都叫「清理过期」）。不限定范围时取到的是**第一个**可见的，也就是触发按钮——
 * 于是"点确认"实际是再点一次触发（已开着框，等于空操作），而断言却以为执行过了。
 *
 * @param text - 按钮上的可见文本（精确匹配）。
 * @param scope - 'panel'（默认，设置面板内、**排除**确认框）或 'modal'（确认框内）。
 * @returns 注入用的表达式。
 */
const clickByText = (text, scope = 'panel') => '(function(){'
  + 'var t=' + JSON.stringify(text) + ';'
  + 'var all=[...document.querySelectorAll("button")].filter(function(n){return (n.innerText||"").trim()===t && n.offsetParent!==null});'
  + 'var inModal=function(n){return n.closest("[role=dialog]") && n.closest("[role=dialog]").innerText.indexOf("清理过期测试环境")>=0};'
  + (scope === 'modal'
    ? 'var b=all.filter(inModal)[0];'
    : 'var b=all.filter(function(n){return !inModal(n)})[0];')
  + 'if(!b) return false; b.click(); return true})()'

/**
 * 把测试环境那一段滚进视口（截图才拍得到）。
 *
 * 与 trial-plan-evidence.mjs 同一手法：可滚容器是设置面板里的 div.options（不是 dialog），
 * 所以要显式取它、显式断言 scrollTop 变了——否则 innerText 读得到而截图里什么都没有。
 *
 * @returns 注入用的表达式（返回 scrollTop 的字符串形式）。
 */
const SCROLL_TO_TRIAL = '(function(){'
  + 'var d=document.querySelector("[role=dialog]"); if(!d) return "no-dialog";'
  + 'var all=[...d.querySelectorAll("*")];'
  + 'var hit=all.filter(function(n){return n.children.length===0 && (n.textContent||"").trim()==="测试环境"})[0];'
  + 'if(!hit) return "no-section";'
  + 'var box=null; var n=hit.parentElement;'
  + 'while(n && n!==document.body){ if(getComputedStyle(n).overflowY==="auto"){ box=n; break } n=n.parentElement }'
  + 'if(!box) return "no-scroller";'
  + 'box.scrollTop = hit.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 40;'
  + 'return String(box.scrollTop)})()'

/** 确认框（标题是「清理过期测试环境」的那个 dialog）里的文本；没有则空串。 */
const MODAL_TEXT = '(function(){'
  + 'var ds=[...document.querySelectorAll("[role=dialog]")];'
  + 'var hit=ds.filter(function(n){return (n.innerText||"").indexOf("清理过期测试环境")>=0})[0];'
  + 'return hit?(hit.innerText||""):""})()'

/** 设置面板里当前渲染出来的文本。 */
const PANEL_TEXT = '(function(){var d=document.querySelector("[role=dialog]");var o=d&&d.querySelector("[class*=options]");return o?(o.innerText||""):""})()'

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
    // 记录 op 请求：这是"执行路径真的被触发"最硬的证据（与文案无关，记账在客户端侧）。
    await evaluate(tab, '(function(){ if(window.__t92ops) return "already"; window.__t92ops=[];'
      + 'var of=window.fetch; window.fetch=function(u,o){ try{ window.__t92ops.push(String(u)) }catch(e){}; return of.apply(this, arguments) };'
      + 'return "hooked" })()')

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

    const modalText = await evaluate(tab, MODAL_TEXT)
    check('点下去弹出了确认框（不是直接执行）', typeof modalText === 'string' && modalText.length > 0,
      (modalText || '').slice(0, 120).replace(/\n/g, ' '))
    // 文案按场景分开断言（三个场景三句话，见 ConsolePage.cleanupText）：
    //   · 会删 N 个 → 给数字；· 会删 0 个 → 说"没有需要清理的"；· 读不到 → 说"读不到"。
    // 第一版把"给数字"那条无条件套在两个场景上，于是 empty 场景误报 FAIL——那是断言写错，不是产品错。
    if (STATE === 'planned') {
      check('确认框说清了会删几个（按当前计划删除 N 个）', /按当前计划删除 \d+ 个测试环境/.test(modalText),
        (modalText.match(/按当前计划删除 \d+ 个测试环境/) ?? ['(没找到)'])[0])
    } else {
      check('计划为空时确认框如实说"没有需要清理的"', /没有需要清理的测试环境/.test(modalText),
        (modalText.match(/没有需要清理的测试环境/) ?? ['(没找到)'])[0])
    }
    check('确认框给了取消与确认两个出口', /取消/.test(modalText) && /清理过期/.test(modalText))

    const { violationsOf } = await import('./copy-rules.mjs')
    const hits = violationsOf(modalText, 'rendered')
    check('确认框文案过 §12.9 的 R1–R7', hits.length === 0, hits.length === 0 ? undefined : '命中 ' + hits.join(', '))

    shots.push(await capture(tab, join(OUT, 'confirm-' + STATE + '-' + THEME + '.png'), { fullPage: false }))

    if (STATE === 'planned') {
      // 场景一：**取消** → 断言没执行。
      await evaluate(tab, clickByText('取消'))
      await sleep(1200)
      const after = await evaluate(tab, PANEL_TEXT)
      check('取消之后没有执行清理（没有"已删除 N 个"那行）', !/已删除 \d+ 个测试环境/.test(after),
        (after.match(/已删除[^\n]{0,20}/) ?? ['(无)'])[0])
      shots.push(await capture(tab, join(OUT, 'after-cancel-' + THEME + '.png'), { fullPage: false }))
    } else {
      // 场景二（task-92）：**点确认** → 断言执行路径真的被触发，且没删任何东西。
      //
      // 关键：确认框**必须消失**，而且那句回执必须是**点完之后才出现的**。
      //   · 第一版只断言"面板文本里有『没有需要清理的测试环境』"——那句话在**点之前**
      //     就已经在确认框里了（框的正文就是它），所以断言恒真（自证式测试，§7.4）。
      //   · 第二版限定范围之后又发现：两个按钮文案相同，不限定范围时"点确认"点的是触发按钮。
      // 现在两条都堵上：范围限定到框内，且用"框关掉了 + 面板里出现回执"作为执行证据。
      const clickedConfirm = await evaluate(tab, clickByText('清理过期', 'modal'))
      check('点得到确认框里的「清理过期」', clickedConfirm === true, String(clickedConfirm))
      // 执行路径被触发的第一个证据：框关掉了（onClick 里先 setConfirmingCleanup(false)）。
      const closed = await waitFor(tab, '(' + MODAL_TEXT + ') === ""', 30_000)
      check('点确认之后确认框关掉了（onClick 真的跑了）', closed === true,
        String(await evaluate(tab, MODAL_TEXT)).slice(0, 80))
      // 第二个证据：**面板里多出一处**引擎的如实回执。
      //
      // 注意：不能只断言"面板里有『没有需要清理的测试环境』"——**那句话在点之前就在了**
      // （计划区在空计划时说的就是它）。那样断言恒真，又是自证式测试（§7.4）。
      // 所以判据是**出现次数**：计划区一处 + 结果行一处 = 点完变成 2 处。
      const countBefore = (await evaluate(tab, PANEL_TEXT)).split('没有需要清理的测试环境').length - 1
      const settled = await waitFor(tab, '(' + PANEL_TEXT + ').split("没有需要清理的测试环境").length - 1 > ' + String(countBefore), 30_000)
      const after = await evaluate(tab, PANEL_TEXT)
      const countAfter = after.split('没有需要清理的测试环境').length - 1
      check('执行路径真的被触发（结果行让那句话多出一处）', settled === true,
        '点前 ' + String(countBefore) + ' 处 → 点后 ' + String(countAfter) + ' 处')
      // 第三个证据（最硬）：op 请求真的发出去了——记账在客户端侧，与文案无关。
      const opCalls = await evaluate(tab, '(function(){return JSON.stringify(window.__t92ops||[])})()')
      check('清理 op 请求真的发出去了（fetch 记录里有 trialCleanup）', /trialCleanup/.test(opCalls),
        String(opCalls).slice(0, 160))
      check('没有目录被删（计划为空时清理是空操作）', !/已删除 \d+ 个测试环境/.test(after),
        (after.match(/已删除[^\n]{0,20}/) ?? ['(无)'])[0])
      // 截图前把测试环境那段滚进视口：回执就在那一节里，不滚的话截图上什么都看不到
      // （断言过、图里没有 = 假证据；trial-plan-evidence.mjs 踩过同一个坑）。
      const scrolled = await evaluate(tab, SCROLL_TO_TRIAL)
      check('回执所在的那一段滚进了视口（截图才拍得到）',
        typeof scrolled === 'string' && Number(scrolled) > 0, String(scrolled))
      await sleep(400)
      shots.push(await capture(tab, join(OUT, 'after-confirm-' + THEME + '.png'), { fullPage: false }))
    }
  } finally {
    await tab.close()
    await chrome.close()
  }
  const failed = results.filter(entry => !entry.ok)
  console.log('== confirm/' + STATE + '/' + THEME + '：' + String(results.length - failed.length) + '/' + String(results.length) + ' 通过 ==')
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => { console.error('环境问题: ' + String(error)); process.exit(2) })

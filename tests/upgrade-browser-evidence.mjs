/**
 * upgrade-browser-evidence.mjs — 升级 UI 的真机取证（task-74）。
 *
 * 归属：A 类（新工具）。它不进 pnpm test 的 glob（不是 *.test.mjs）——真机脚本需要实例与浏览器。
 * 官方复用：无；浏览器侧只用 tools/cdp-shot.mjs 的零依赖 CDP 工具。
 * 前提检查：单测 + SSR 全绿 ≠ 用户能用（视觉审计的教训），所以这里的断言全部取"用户可见事实"：
 *   真实无头 Chrome 里打开官方插件页与市场页，读回可见文本并截图。
 *
 * 用法：node tests/upgrade-browser-evidence.mjs --port 3471 --token <t> --out /tmp/upg-evidence [--theme light|dark]
 * 退出码：0 全通过 / 1 有断言失败 / 2 环境问题。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchChrome, openTab, evaluate, capture } from '../tools/cdp-shot.mjs'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = argv.indexOf('--' + name)
  return index === -1 ? fallback : argv[index + 1]
}
const PORT = Number(arg('port', '3471'))
const TOKEN = arg('token', '')
const OUT = arg('out', '/tmp/upg-evidence')
const THEME = arg('theme', 'light')
const BASE = 'http://127.0.0.1:' + String(PORT) + '/?token=' + TOKEN
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail === undefined ? '' : ' — ' + detail))
}

/** 等一个页面内断言成立。 */
async function waitFor(tab, expression, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await evaluate(tab, expression).catch(() => false)
    if (ok === true) return true
    await sleep(300)
  }
  return false
}

/** 设置面板内容区文本。 */
const PANEL_TEXT = '(function(){var d=document.querySelector("[role=dialog]");var o=d&&d.querySelector("[class*=options]");return o?(o.innerText||""):""})()'

/** 打开设置面板并选中某个一级入口。 */
async function openSection(tab, label) {
  await evaluate(tab, '(function(){var b=[...document.querySelectorAll("button")].filter(function(n){return (n.innerText||"").trim()==="设置" && n.offsetParent!==null})[0]; if(b) b.click(); return !!b})()')
  await waitFor(tab, '!!document.querySelector("[role=dialog]")')
  await evaluate(tab, '(function(){var d=document.querySelector("[role=dialog]");if(!d)return false;'
    + 'var b=[...d.querySelectorAll("button")].filter(function(n){return (n.innerText||"").trim().indexOf(' + JSON.stringify(label) + ')>=0 && n.offsetParent!==null})[0];'
    + ' if(b) b.click(); return !!b})()')
  await waitFor(tab, '(function(){var d=document.querySelector("[role=dialog]");var o=d&&d.querySelector("[class*=options]");return !!o && (o.innerText||"").length>40})()')
  await sleep(1200)
}

/**
 * 关掉首次启动会挡住页面的那些对话框（新 profile 第一次打开必有）。
 *
 * 为什么必须在导航前做：那些模态盖在插件页上面，点不开任何卡片——
 * 第一版取证脚本就是被它们挡住的（截图里只有"继续"与"稍后配置"两个按钮）。
 * 逐个点名按钮文案（不按"第几个按钮"猜）：这些是**真实存在的用户路径**，
 * 走它们与真人第一次打开页面做的事一样。
 */
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

/** 当前有没有模态挡着页面（取证脚本的"挡板"自检）。 */
const MODAL_OPEN = '!!document.querySelector("[role=dialog]")'

/**
 * 打开官方插件页（侧栏 Plugins）。
 *
 * @param tab - 标签页。
 */
async function openPluginsPage(tab) {
  // 关掉设置面板（Esc），回到主界面。
  await evaluate(tab, '(function(){var d=document.querySelector("[role=dialog]");if(d){document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));}return true})()')
  await sleep(600)
  await dismissFirstRunNotice(tab)
  await evaluate(tab, '(function(){var b=[...document.querySelectorAll("button,a,[role=button]")].filter(function(n){return (n.innerText||"").trim()==="插件" && n.offsetParent!==null})[0]; if(b) b.click(); return !!b})()')
  await waitFor(tab, '!!document.querySelector("[data-plugin-scope=global]")', 15_000)
  await sleep(1000)
}

/**
 * 点开某个包自己的详情页。
 *
 * 官方插件页把包名列成卡片（`<code data-plugin-name>` 也在详情页里），所以这里按
 * **列表里的可见包名叶子节点**找卡片并点击——不猜 DOM 结构，只用"用户看得见的名字"。
 * 列表很长（官方层 + 已装 + 精选），找不到时先滚到底再找。
 *
 * @param tab - 标签页。
 * @param packageName - 包名。
 * @returns 是否点开了详情页。
 */
async function openPluginDetail(tab, packageName) {
  // 从列表页开始：已经在某个包的详情页时要先退回去（否则找不到卡片）。
  // 官方的返回控件就是面包屑那个「插件列表」按钮——走它，不猜别的路径。
  const inDetail = await evaluate(tab, '!!document.querySelector("[data-plugin-detail]")')
  if (inDetail === true) {
    await evaluate(tab, '(function(){var b=[...document.querySelectorAll("button")].filter(function(n){return (n.innerText||"").trim()==="插件列表" && n.offsetParent!==null})[0]; if(b) b.click(); return !!b})()')
    await sleep(1200)
  } else {
    await openPluginsPage(tab)
  }
  const findAndClick = (name) => '(function(){'
    + 'var target=' + JSON.stringify(name) + ';'
    // 只在"还没进详情页"的列表里找：详情页自己的 data-plugin-name 也在 <code> 里，
    // 那会让第二次调用点到一个已经在的详情页上。
    + 'var list=[...document.querySelectorAll("[data-plugin-scope=global]")];'
    + 'for (var i=0;i<list.length;i++){'
    + '  var leaves=[...list[i].querySelectorAll("*")].filter(function(n){return n.children.length===0 && (n.textContent||"").trim()===target});'
    + '  if(leaves.length){ var node=leaves[0];'
    + '    while(node && node !== document.body){ var role=node.getAttribute && node.getAttribute("role");'
    + '      if(node.tagName==="BUTTON"||role==="button"||node.tagName==="A"){ node.click(); return true } node=node.parentElement }'
    + '  }'
    + '}'
    + 'return false})()'
  let opened = await evaluate(tab, findAndClick(packageName))
  if (opened !== true) {
    // 卡片可能在视口外：滚一段再找（官方列表是滚动容器）。
    await evaluate(tab, '(function(){var s=document.querySelector("[data-plugin-scope=global]"); if(s&&s.parentElement) s.parentElement.scrollTop += 900; return true})()')
    await sleep(800)
    opened = await evaluate(tab, findAndClick(packageName))
  }
  await sleep(1500)
  return opened
}

/** 官方插件详情页的可见文本。 */
const DETAIL_TEXT = '(function(){var d=document.querySelector("[data-plugin-detail]");return d?(d.innerText||""):""})()'

async function main() {
  const chrome = await launchChrome()
  const tab = await openTab(chrome.port)
  const shots = []
  try {
    await tab.send('Page.enable')
    await tab.send('Runtime.enable')
    await tab.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1100, deviceScaleFactor: 1, mobile: false })
    // 主题：官方把主题放在 documentElement 的属性/类上；用 prefers-color-scheme 模拟更可靠。
    await tab.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: THEME === 'dark' ? 'dark' : 'light' }],
    })
    await tab.send('Page.navigate', { url: BASE })
    await waitFor(tab, '!!document.querySelector("body")')
    await sleep(2500)

    // ① 市场页：已装条目的「升级到 x.y.z」
    //
    // 先关掉首启模态再截：新 profile 第一次打开会弹「添加一个 API Key」，它盖在设置面板上，
    // 截出来的市场页是被遮住的（第一版两张市场图都有这个问题）。
    // 注意顺序：关首启对话框必须在**打开设置面板之前**。第二次关它时，面板已经开着，
    // 那些"跳过/继续"按钮一被点到就会把面板一起关掉（实测：市场页渲染断言因此失败）。
    await dismissFirstRunNotice(tab)
    await openSection(tab, '插件市场')
    let market = await evaluate(tab, PANEL_TEXT)
    // 市场索引要联网抓；本机装了 auto-review 但索引里未必有它，所以这里只断言"有市场页"
    // 与"升级入口的渲染规则"（真正的升级入口在插件页那一条上验）。
    check('market: 市场页渲染出内容', typeof market === 'string' && market.length > 40,
      (market || '').slice(0, 120).replace(/\n/g, ' '))
    shots.push(await capture(tab, join(OUT, '01-market-' + THEME + '.png'), { fullPage: false }))

    // ② 官方插件页：upgradable 包（auto-review）的升级行。
    //
    // 卡片标题不是包名：官方 presentation.shortName() 把 `@scope/dsh-xxx` 压成 `xxx`，
    // 再用 BUILTIN_COPY 把已知官方包换成中文本地化标题。所以这里按**用户看到的名字**找卡片
    // （debug 输出里实测是「自动授权审查」），而不是按 npm 包名。
    const PKG = '@deepseek-ai/dsh-experimental-auto-review'
    const PKG_TITLE = '自动授权审查'
    const opened = await openPluginDetail(tab, PKG_TITLE)
    const blocked = await evaluate(tab, MODAL_OPEN)
    check('official: 插件页没有被模态挡住', blocked !== true, blocked === true ? '还有模态开着' : undefined)
    // 直接打开插件页（没先去过市场页）也必须拿到四态：检查由本行挂载时的 effect 触发。
    // 这条是本轮真机实测抓到的两个缺陷的回归闸——服务可见性（ctx.inject）与 Hook 顺序。
    const pageText = await evaluate(tab, '(function(){var s=document.querySelector("[data-plugin-scope=global]");return s?(s.parentElement.innerText||""):"(no list)"})()')
    console.log('    [debug] 插件页文本前 400 字：' + String(pageText).slice(0, 400).replace(/\n/g, ' | '))
    check('official: 能点开 ' + PKG + ' 的页面', opened === true)
    let detail = await evaluate(tab, DETAIL_TEXT)
    const hasUpgradeRow = /当前 0\.1\.6-alpha\.1 → 0\.1\.6-alpha\.2/.test(detail)
    check('official: 升级行显示"当前 → 目标"', hasUpgradeRow, (detail || '').slice(0, 200).replace(/\n/g, ' '))
    check('official: 有升级按钮', /升级到 0\.1\.6-alpha\.2/.test(detail))
    check('official: 生效时机沿用官方口径', /已安装，下次启动后加载。/.test(detail))
    check('official: 没有出现"已是最新"（这个包有更新）', !/已是最新/.test(detail))
    shots.push(await capture(tab, join(OUT, '02-upgrade-row-' + THEME + '.png'), { fullPage: false }))

    // ③ 安装方提供的层："不可升级"形态。
    //
    // 为什么用 agent-team-profile 而不是 dsh-web-app：**官方插件页根本不列 dsh-web-app**
    // （它在官方页的 BUILTIN_PROFILE_BUNDLES 黑名单里，那是官方 chrome 的决定，我们无权也不该绕）。
    // agent-team-profile 在官方 OPTIONAL_BUNDLES 里 → optional=true → 官方页把它列进"官方"组，
    // 而它不在 profile 的 dependencies 里 → 我们的 upgradeCheck 判它 not-upgradable。
    // 这正好是"打开一个真实可见、且结构上确实升不了的层"的形态。
    // 标题走官方 BUILTIN_COPY 的中文本地化（builtinAgentTeamTitle = 智能体团队）。
    const TEAM = '@deepseek-ai/dsh-experimental-agent-team-profile'
    const opened2 = await openPluginDetail(tab, '智能体团队')
    let detail2 = await evaluate(tab, DETAIL_TEXT)
    check('official: 能点开 ' + TEAM + ' 的页面', opened2 === true)
    check('official: 安装方提供的层给出说明（不是按钮）',
      /由安装方提供，无法在当前环境内升级/.test(detail2), (detail2 || '').slice(0, 200).replace(/\n/g, ' '))
    check('official: 安装方提供的层给出命令', /npm i -g @deepseek-ai\/dsh@latest/.test(detail2))
    check('official: 安装方提供的层不给按钮（没有"升级到"）', !/升级到/.test(detail2))
    check('official: 安装方提供的层不写"当前 未知"（版本号由官方标题旁 Tag 承担）',
      !/当前 未知/.test(detail2), '真机实测这句是噪声且与官方标题旁的版本号自相矛盾')
    shots.push(await capture(tab, join(OUT, '03-not-upgradable-' + THEME + '.png'), { fullPage: false }))

    writeFileSync(join(OUT, 'result-' + THEME + '.json'), JSON.stringify({ theme: THEME, results, shots }, undefined, 2))
  } finally {
    await tab.close()
    await chrome.close()
  }
  const failed = results.filter(entry => !entry.ok)
  console.log('== ' + THEME + '：' + String(results.length - failed.length) + '/' + String(results.length) + ' 通过 ==')
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => { console.error('环境问题: ' + String(error)); process.exit(2) })

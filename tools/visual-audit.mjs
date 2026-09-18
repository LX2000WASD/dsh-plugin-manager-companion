/**
 * 视觉验证：把本插件的三个一级页面 + 官方插件页集成逐个截屏。
 *
 * 用法：
 *   node tools/visual-audit.mjs --port 3099 --token <token> --out /tmp/vis
 *
 * 它只读页面、只截图，不改任何状态（除了导航本身）。
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { launchChrome, openTab, shoot, evaluate } from './cdp-shot.mjs'

const argv = process.argv.slice(2)
/** 取一个 flag 的值。 */
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const port = arg("port", "3099")
const token = arg("token", "")
const out = arg("out", "/tmp/vis")
mkdirSync(out, { recursive: true })

/** 按可见文本点一个元素（字符串拼接构造，避免模板嵌套）。 */
function clickByText(text, tag) {
  const selector = tag === undefined ? "button, [role=tab], [role=button], a, li" : tag
  return "(() => {"
    + "const nodes = [...document.querySelectorAll(" + JSON.stringify(selector) + ")];"
    + "const hit = nodes.find(n => n.innerText && n.innerText.trim() === " + JSON.stringify(text) + " && n.offsetParent !== null);"
    + "if (!hit) return \"NOT_FOUND\";"
    + "hit.click(); return \"CLICKED\";"
    + "})()"
}

/** 等某个文本出现。 */
async function waitText(tab, text, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await evaluate(tab, `document.body.innerText.includes(${JSON.stringify(text)})`)
    if (r === true) return true
    await new Promise(res => setTimeout(res, 400))
  }
  return false
}

const steps = []
/** 记一步结果。 */
function note(name, ok, detail = "") {
  steps.push({ name, ok, detail })
  console.log(`  ${ok ? "OK  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`)
}

const chrome = await launchChrome()
console.log("Chrome:", chrome.version.Browser)
const tab = await openTab(chrome.port)

try {
  // 1) 打开应用
  const base = `http://127.0.0.1:${port}/`
  await shoot(tab, token ? `${base}?token=${token}` : base, {
    waitFor: "body", out: join(out, "00-app.png"), settleMs: 3500, width: 1680, height: 1050,
  })
  note("应用打开", true, await evaluate(tab, "document.title"))

  // 2) 打开设置
  const opened = await evaluate(tab, clickByText("设置"))
  note("点击「设置」", opened === "CLICKED", opened)
  await waitText(tab, "常规")
  await new Promise(res => setTimeout(res, 1500))
  await shoot(tab, base, { waitFor: "body", out: join(out, "01-settings.png"), settleMs: 1200 })

  // 3) 列出设置侧栏里的一级分区
  const sections = await evaluate(tab, `JSON.stringify([...document.querySelectorAll("button,[role=tab],[role=button]")].map(n => n.innerText?.trim()).filter(t => t && t.length < 24))`)
  console.log("  可见的导航项:", String(sections).slice(0, 600))

  // 4) 逐个进我们的页面
  for (const [i, label] of ["插件市场", "环境控制台", "技能与预设"].entries()) {
    const r = await evaluate(tab, clickByText(label))
    const ok = r === "CLICKED"
    if (ok) {
      await new Promise(res => setTimeout(res, 2500))
      await shoot(tab, base, { waitFor: "body", out: join(out, `1${i}-${label}.png`), settleMs: 1500 })
    }
    note(`打开「${label}」`, ok, r)
  }

  // 5) 环境控制台的三个子页
  for (const [i, sub] of ["体检", "环境", "设置"].entries()) {
    const r = await evaluate(tab, clickByText(sub, "[role=tab], button"))
    if (r === "CLICKED") {
      await new Promise(res => setTimeout(res, 2000))
      await shoot(tab, base, { waitFor: "body", out: join(out, `2${i}-console-${sub}.png`), settleMs: 1200 })
    }
    note(`环境控制台 · ${sub}`, r === "CLICKED", r)
  }
} catch (error) {
  note("执行中断", false, error.message)
} finally {
  await tab.close().catch(() => {})
  await chrome.close().catch(() => {})
}

console.log('\n截图目录:', out)
console.log('结果:', JSON.stringify(steps))
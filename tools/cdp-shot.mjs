/**
 * 零依赖 CDP 截图工具：用系统 Chrome 的无头模式渲染真实页面并截屏。
 *
 * 为什么不用 --screenshot：那个 CLI 开关配 --virtual-time-budget 会等"网络静默"，
 * 而 DSH 的 Web 客户端持有一条长连 SSE 流，虚拟时间永远不推进（实测挂满 80s 不出图）。
 * CDP 让我们显式控制：导航 → 等选择器 → 主动截屏。
 *
 * 用 Node 22+ 自带的 fetch 与 WebSocket，**不引入任何依赖**。
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 系统 Chrome 的可执行文件（可用 CHROME 环境变量覆盖）。 */
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome-stable'

/** 等一会儿。 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 启动一个无头 Chrome 并连上它的浏览器级 CDP。
 * @returns 连接句柄与关闭函数。
 */
export async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), "cdp-profile-"))
  const port = 9200 + Math.floor(Math.random() * 300)
  const child = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  // 等 DevTools 端点就绪
  let version
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) { version = await res.json(); break }
    } catch { /* 还没起来 */ }
    await sleep(250)
  }
  if (version === undefined) {
    child.kill('SIGKILL')
    rmSync(profile, { recursive: true, force: true })
    throw new Error('Chrome 的 DevTools 端点未就绪：' + CHROME)
  }

  return {
    port,
    version,
    async close() {
      try { child.kill('SIGKILL') } catch { /* 已退出 */ }
      await sleep(200)
      rmSync(profile, { recursive: true, force: true })
    },
  }
}

/**
 * 开一个新标签页并连上它的 CDP。
 * @param port - 浏览器调试端口。
 * @returns 标签页句柄（send / 事件 / 关闭）。
 */
export async function openTab(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
  const target = await res.json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true })
  })

  let seq = 0
  const pending = new Map()
  const listeners = new Map()
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id !== undefined) {
      const entry = pending.get(msg.id)
      if (entry !== undefined) {
        pending.delete(msg.id)
        if (msg.error !== undefined) entry.reject(new Error(JSON.stringify(msg.error)))
        else entry.resolve(msg.result)
      }
      return
    }
    const handlers = listeners.get(msg.method)
    if (handlers !== undefined) for (const fn of [...handlers]) fn(msg.params)
  })

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    seq += 1
    pending.set(seq, { resolve, reject })
    ws.send(JSON.stringify({ id: seq, method, params }))
  })

  return {
    send,
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, new Set())
      listeners.get(method).add(fn)
    },
    async close() {
      ws.close()
      await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {})
    },
  }
}

/**
 * 打开一个页面、等到标志元素出现、截全页图。
 *
 * @param tab - 标签页句柄。
 * @param url - 要打开的地址（可含 token）。
 * @param options - 等待的选择器、超时、视口尺寸、等待额外毫秒数。
 * @returns 截图文件路径。
 */
export async function shoot(tab, url, options = {}) {
  const {
    waitFor = 'body', timeoutMs = 45_000, width = 1600, height = 1200,
    settleMs = 1500, out = join(tmpdir(), `shot-${Date.now()}.png`), fullPage = true,
  } = options

  await tab.send('Page.enable')
  await tab.send('Runtime.enable')
  await tab.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await tab.send('Page.navigate', { url })

  // 轮询等待标志元素（SPA 渲染完才截图）
  const deadline = Date.now() + timeoutMs
  let found = false
  while (Date.now() < deadline) {
    const r = await tab.send('Runtime.evaluate', {
      expression: `!!document.querySelector(${JSON.stringify(waitFor)})`,
      returnByValue: true,
    })
    if (r.result?.value === true) { found = true; break }
    await sleep(300)
  }
  if (!found) throw new Error(`等待选择器超时：${waitFor}`)
  await sleep(settleMs)

  const shot = await tab.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage })
  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  return out
}

/**
 * 在页面里求值（用于检查渲染结果、取文本/尺寸）。
 * @param tab - 标签页句柄。
 * @param expression - 表达式。
 * @returns 求值结果。
 */
export async function evaluate(tab, expression) {
  const r = await tab.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails !== undefined) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300))
  return r.result?.value
}
/**
 * 用一个**真实的**鼠标事件点一个元素（按可见文本匹配）。
 *
 * 为什么不用 element.click()：部分 UI 组件监听 pointerdown/mouseup 而不是 click，
 * 合成 click 不会触发它们（实测设置面板就是这种情况）。CDP 的
 * Input.dispatchMouseEvent 走的是浏览器真实输入管线。
 *
 * @param tab - 标签页句柄。
 * @param text - 元素的可见文本。
 * @returns 点击结果描述。
 */
export async function clickText(tab, text) {
  const box = await evaluate(tab, "(() => {"
    + "const leaf = [...document.querySelectorAll(\"*\")].filter(n => n.children.length === 0 && n.textContent && n.textContent.trim() === " + JSON.stringify(text) + " && n.offsetParent !== null)[0];"
    + "if (!leaf) return null;"
    + "const target = leaf.closest(\"button, [role=button], [role=tab], a\") ?? leaf;"
    + "target.scrollIntoView({ block: \"center\" });"
    + "const r = target.getBoundingClientRect();"
    + "return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, tag: target.tagName });"
    + "})()")
  if (box === null || box === undefined) return "NOT_FOUND"
  const { x, y, tag } = JSON.parse(box)
  const common = { x, y, button: "left", clickCount: 1 }
  await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y })
  await tab.send("Input.dispatchMouseEvent", { type: "mousePressed", ...common })
  await tab.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...common })
  return `CLICKED:${tag}@${Math.round(x)},${Math.round(y)}`
}
/**
 * 只对**当前**页面截屏，不导航。
 *
 * 为什么需要它：{@link shoot} 每次都导航——在"点开某个面板再截图"的流程里，
 * 那次导航会把刚打开的面板刷掉（实测踩过：设置面板明明开了，截图却是首页）。
 *
 * @param tab - 标签页句柄。
 * @param out - 输出文件路径。
 * @param options - 是否整页、额外等待毫秒。
 * @returns 截图文件路径。
 */
export async function capture(tab, out, options = {}) {
  const { settleMs = 800, fullPage = false } = options
  await sleep(settleMs)
  const shot = await tab.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: fullPage })
  writeFileSync(out, Buffer.from(shot.data, "base64"))
  return out
}

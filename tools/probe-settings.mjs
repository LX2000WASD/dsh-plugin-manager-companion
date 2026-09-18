import { launchChrome, openTab, evaluate, clickText, capture } from './cdp-shot.mjs'

const token = process.argv[2]
const chrome = await launchChrome()
const tab = await openTab(chrome.port)
const logs = []
tab.on("Runtime.consoleAPICalled", (p) => { logs.push(`[${p.type}] ` + p.args.map(a => a.value ?? a.description ?? "").join(" ").slice(0, 240)) })
tab.on("Runtime.exceptionThrown", (p) => { logs.push("[EXCEPTION] " + JSON.stringify(p.exceptionDetails).slice(0, 400)) })
tab.on("Log.entryAdded", (p) => { if (p.entry.level === "error") logs.push("[log] " + p.entry.text.slice(0, 240)) })
try {
  await tab.send("Page.enable")
  await tab.send("Runtime.enable")
  await tab.send("Log.enable")
  await tab.send("Emulation.setDeviceMetricsOverride", { width: 1680, height: 1050, deviceScaleFactor: 1, mobile: false })
  await tab.send("Page.navigate", { url: `http://127.0.0.1:3099/?token=${token}` })
  await new Promise(r => setTimeout(r, 7000))
  await clickText(tab, "设置")
  await new Promise(r => setTimeout(r, 3000))
  logs.length = 0  // 只看进入我们页面之后的
  await clickText(tab, "环境控制台")
  await new Promise(r => setTimeout(r, 5000))
  await capture(tab, "/tmp/vis/console-debug.png", { settleMs: 500 })

  const dom = await evaluate(tab, `(() => {
    const dlg = document.querySelector("[role=dialog], dialog") ?? document.querySelector("[class*=dialog]");
    const panel = dlg ?? document.body;
    return JSON.stringify({
      panelText: panel.innerText.slice(0, 500),
      panelChildren: panel.children.length,
      ourNodes: [...document.querySelectorAll("[class*=companion], [class*=Console], [class*=console]")].length,
      html: panel.innerHTML.length,
    });
  })()`)
  console.log("DOM:", dom)
  console.log("")
  console.log("=== 控制台输出（" + logs.length + " 条）===")
  for (const l of logs.slice(0, 15)) console.log("  " + l)
} finally { await tab.close().catch(()=>{}); await chrome.close().catch(()=>{}) }

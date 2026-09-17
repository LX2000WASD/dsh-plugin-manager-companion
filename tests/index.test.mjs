/**
 * 入口 op 分派契约测试（node --test，跑 dist/index.js）。
 *
 * 守护的是装配层最容易断的地方：分派表与各模块的真实签名对不上（这次接线就撞了
 * 6 处）、以及"错误被吞掉变成看起来成功的空响应"。
 *
 * 用隔离的 DSH_HOME，绝不碰真实环境。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), "companion-home-"))
const originalHome = process.env.DSH_HOME
process.env.DSH_HOME = home

// 造两个环境：一个普通、一个内置。
mkdirSync(join(home, "profiles", "demo-env"), { recursive: true })
writeFileSync(join(home, "profiles", "demo-env", "package.json"), JSON.stringify({
  name: "dsh-profile-demo-env",
  dependencies: {},
  dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
}))
writeFileSync(join(home, "profiles", "demo-env", "cordis.patch.yml"), "[]\n")
mkdirSync(join(home, "profiles", "web"), { recursive: true })
writeFileSync(join(home, "profiles", "web", "package.json"), JSON.stringify({ name: "dsh-profile-web" }))

const mod = await import("../dist/index.js")
const { handleOp, JobRegistry } = { ...mod, JobRegistry: undefined }

/** 构造一份 deps；ctx 用最小桩件，只提供分派路径真正读到的成员。 */
function makeDeps(overrides = {}) {
  let config = {
    diagnostics: { dependency: true, composition: true, runtime: true, consistency: true, ecosystem: false },
    qualityGate: { enabled: true, mode: "block", allowlist: [] },
    marketplace: { enabled: false, cacheTtlMinutes: 1440, timeoutMs: 15000, indexUrl: "" },
  }
  const ctx = {
    get() { return undefined },
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) { const d = fn(); return typeof d === "function" ? d : () => {} },
    ...overrides.ctx,
  }
  return {
    ctx,
    config: overrides.config ?? (() => config),
    configUpdate: async (patch) => { config = { ...config, ...patch }; return config },
    capabilities: () => ({
      profileBacked: true, manager: false, inventory: false,
      environmentName: "demo-env", missing: [],
    }),
    jobs: overrides.jobs ?? makeJobs(),
  }
}

/** 最小 job 注册表桩件（真实实现见 rest.ts，已在 rest.test.mjs 单独覆盖）。 */
function makeJobs() {
  const map = new Map()
  let seq = 0
  return {
    start(task) {
      seq += 1
      const id = "job-" + String(seq)
      const record = { done: false }
      map.set(id, record)
      void Promise.resolve().then(task).then(
        (value) => { record.result = value; record.done = true },
        (error) => { record.error = String(error && error.message ? error.message : error); record.done = true },
      )
      return id
    },
    status(id) {
      const record = map.get(id)
      if (record === undefined) return { done: true, missing: true }
      return { done: record.done, ...(record.result === undefined ? {} : { result: record.result }), ...(record.error === undefined ? {} : { error: record.error }) }
    },
  }
}

/** 等一个 job 落定。 */
async function settle(deps, id) {
  for (let i = 0; i < 200; i += 1) {
    const status = await handleOp("job", { id }, deps)
    if (status.ok && status.value.done === true) return status.value
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error("job 未在预期时间内落定")
}

test('capabilities op 返回能力与配置', async () => {
  const result = await handleOp("capabilities", {}, makeDeps())
  assert.equal(result.ok, true)
  assert.equal(result.value.capabilities.environmentName, "demo-env")
  assert.ok(result.value.config.qualityGate.enabled)
})

test('getConfig / setConfig 走配置句柄', async () => {
  const deps = makeDeps()
  const before = await handleOp("getConfig", {}, deps)
  assert.equal(before.value.marketplace.enabled, false)
  const after = await handleOp("setConfig", { patch: { marketplace: { enabled: true, cacheTtlMinutes: 60, timeoutMs: 5000, indexUrl: "" } } }, deps)
  assert.equal(after.ok, true)
  assert.equal(after.value.marketplace.enabled, true)
})

test('setConfig 缺 patch 或类型不对时报可读错误，而不是静默成功', async () => {
  const missing = await handleOp("setConfig", {}, makeDeps())
  assert.equal(missing.ok, false)
  assert.match(missing.error.message, /patch/)
  const wrongType = await handleOp("setConfig", { patch: "not-an-object" }, makeDeps())
  assert.equal(wrongType.ok, false)
})

test('listEnvironments 列出隔离 home 里的环境并标注内置', async () => {
  const result = await handleOp("listEnvironments", {}, makeDeps())
  assert.equal(result.ok, true)
  const names = result.value.map(env => env.name).sort()
  assert.deepEqual(names, ["demo-env", "web"])
  const web = result.value.find(env => env.name === "web")
  assert.equal(web.builtin, true)
  const demo = result.value.find(env => env.name === "demo-env")
  assert.equal(demo.builtin, false)
  assert.deepEqual(demo.bundles, ["@deepseek-ai/dsh-base"])
})

test('scanRuns 返回 plain object（可 JSON 序列化）', async () => {
  const result = await handleOp("scanRuns", {}, makeDeps())
  assert.equal(result.ok, true)
  assert.equal(Object.getPrototypeOf(result.value), Object.prototype)
  assert.doesNotThrow(() => JSON.stringify(result.value))
})

test('diagnose 是长操作：返回 jobId，随后可从 job op 取到报告', async () => {
  const deps = makeDeps()
  const started = await handleOp("diagnose", {}, deps)
  assert.equal(started.ok, true)
  assert.equal(typeof started.value, "string")
  const settled = await settle(deps, started.value)
  assert.equal(settled.error, undefined)
  const report = settled.result
  assert.equal(report.environment, "demo-env")
  assert.ok(Array.isArray(report.issues))
  assert.ok(Array.isArray(report.skipped))
  // 五个层的计数键必须齐全（诊断页要直接渲染，缺键会显示 undefined）。
  for (const layer of ["dependency", "composition", "runtime", "consistency", "ecosystem"]) {
    assert.equal(typeof report.counts[layer], "number", "counts 缺 " + layer)
  }
})

test('诊断在官方能力缺失时如实记 skipped，不假装健康', async () => {
  const deps = makeDeps()
  const started = await handleOp("diagnose", {}, deps)
  const settled = await settle(deps, started.value)
  const report = settled.result
  // 本桩件的 capabilities 里 manager=false / inventory=false，运行时层必然跳过。
  assert.ok(report.skipped.length > 0, "能力缺失时必须有 skipped 记录")
  assert.ok(report.skipped.some(entry => /运行时|Loader/i.test(entry.reason) || entry.check.includes("runtime")))
})

test('fix op 走 job，并把 needs-manual 如实透出（不报成失败）', async () => {
  const deps = makeDeps()
  const started = await handleOp("fix", { action: "remove-duplicate-row", target: "row-a" }, deps)
  assert.equal(started.ok, true)
  assert.equal(typeof started.value, "string")
  const settled = await settle(deps, started.value)
  assert.equal(settled.error, undefined)
  assert.equal(settled.result.status, "needs-manual")
  assert.equal(settled.result.action, "remove-duplicate-row")
  assert.equal(settled.result.target, "row-a")
})

test('fix op 缺 action 时报错并指出字段名', async () => {
  const result = await handleOp("fix", {}, makeDeps())
  assert.equal(result.ok, false)
  assert.match(result.error.message, /action/)
})

test('fix op 对未知动作返回 failed 而不是静默成功', async () => {
  const deps = makeDeps()
  const started = await handleOp("fix", { action: "no-such-action" }, deps)
  const settled = await settle(deps, started.value)
  assert.equal(settled.result.status, "failed")
})

test('未知 op 报错而不是返回空成功', async () => {
  const result = await handleOp("nope", {}, makeDeps())
  assert.equal(result.ok, false)
  assert.match(result.error.message, /未知操作/)
})

test('缺必填字段时报错并指出字段名', async () => {
  const result = await handleOp("removeEnvironment", {}, makeDeps())
  assert.equal(result.ok, false)
  assert.match(result.error.message, /name/)
})

test('handleOp 永不抛：模块抛错一律折成失败信封', async () => {
  const deps = makeDeps({ config: () => { throw new Error("配置读取炸了") } })
  const result = await handleOp("getConfig", {}, deps)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, "operation-failed")
  assert.match(result.error.message, /配置读取炸了/)
})

test('marketplace 在关闭时不联网，返回空 listing 而不是报错', async () => {
  const result = await handleOp("marketplace", {}, makeDeps())
  assert.equal(result.ok, true)
  assert.deepEqual(result.value.items, [])
  assert.equal(result.value.cached, false)
})

test('环境名不安全时被拒（路径逃逸防线）', async () => {
  const result = await handleOp("removeEnvironment", { name: ".." }, makeDeps())
  assert.equal(result.ok, true)
  assert.equal(result.value.ok, false)
  assert.equal(result.value.code, "invalid-name")
})

after(() => {
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
  rmSync(home, { recursive: true, force: true })
})

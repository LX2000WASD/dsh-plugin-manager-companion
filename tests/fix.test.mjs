// 修复执行契约测试：applyFix 的三种结局与"拒绝自己写 profile 组合"这条硬约束。
// 被验对象是构建产物 dist/fix.js。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { applyFix } = await import("../dist/fix.js")

/** 构造依赖桩件。 */
function makeDeps(overrides = {}) {
  const calls = []
  return {
    calls,
    deps: {
      ctx: { get: () => undefined, logger: { info() {}, warn() {}, error() {} } },
      environmentName: () => "demo-env",
      install: async (spec) => { calls.push(spec); return { ok: true, output: "已安装 " + spec } },
      ...overrides,
    },
  }
}

test('删行类修复回 needs-manual，且绝不声称已执行', async () => {
  for (const action of ["remove-duplicate-row", "remove-row"]) {
    const { deps } = makeDeps()
    const result = await applyFix(action, "some-row-id", deps)
    assert.equal(result.status, "needs-manual", action)
    assert.equal(result.ok, false)
    // 关键：不能把 needs-manual 报成 failed——用户要知道该做什么，不是"失败了"。
    assert.notEqual(result.status, "failed")
    assert.match(result.output, /cordis\.patch\.yml/)
    assert.match(result.output, /行号/)
  }
})

test('needs-manual 的输出带上目标，便于用户定位', async () => {
  const { deps } = makeDeps()
  const result = await applyFix("remove-row", "acme-plugin-row", deps)
  assert.equal(result.target, "acme-plugin-row")
  assert.match(result.output, /acme-plugin-row/)
})

test('needs-manual 缺 target 时不崩，仍给出可读说明', async () => {
  const { deps } = makeDeps()
  const result = await applyFix("remove-duplicate-row", undefined, deps)
  assert.equal(result.status, "needs-manual")
  assert.match(result.output, /未知目标/)
})

test('安装类修复转交受质量门保护的安装通道', async () => {
  const { deps, calls } = makeDeps()
  const result = await applyFix("install-provider", "@acme/pkg", deps)
  assert.equal(result.status, "executed")
  assert.deepEqual(calls, ["@acme/pkg"])
})

test('安装类修复失败时如实报 failed', async () => {
  const { deps } = makeDeps({ install: async () => ({ ok: false, output: "质量门拦截" }) })
  const result = await applyFix("install-dependency", "bad-pkg", deps)
  assert.equal(result.status, "failed")
  assert.match(result.output, /质量门拦截/)
})

test('安装类修复缺 target 时报错而不是装空包', async () => {
  const { deps, calls } = makeDeps()
  const result = await applyFix("install-provider", undefined, deps)
  assert.equal(result.status, "failed")
  assert.deepEqual(calls, [])
})

test('行级启停走官方通道；官方不可用时折成 failed 而不是抛', async () => {
  const { deps } = makeDeps()
  // 桩件的 ctx.get 一律返回 undefined → 官方 pluginManager 不可用。
  const result = await applyFix("enable-row", "some-row", deps)
  assert.equal(result.status, "failed")
  assert.ok(result.output.length > 0, "必须有可读原因")
})

test('行级启停缺 target 时不动官方通道', async () => {
  const { deps } = makeDeps()
  const result = await applyFix("disable-row", undefined, deps)
  assert.equal(result.status, "failed")
  assert.match(result.output, /target/)
})

test('未知动作报 failed 而不是静默成功', async () => {
  const { deps } = makeDeps()
  const result = await applyFix("do-something-clever", "x", deps)
  assert.equal(result.status, "failed")
  assert.match(result.output, /未知修复动作/)
})

test('非官方能力缺失类异常被捕获成 failed，绝不向上抛', async () => {
  const { deps } = makeDeps({
    environmentName: () => { throw new Error("炸了") },
  })
  const result = await applyFix("remove-official-copy", "@deepseek-ai/dsh-tools", deps)
  assert.equal(result.ok, false)
  assert.equal(result.status, "failed")
  assert.match(result.output, /炸了/)
})

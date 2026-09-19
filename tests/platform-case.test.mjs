// 大小写不敏感平台上的护栏测试（审计 W-01 的回归）。
//
// 为什么单独一个文件：这条 bug 在最坏形态下（删掉官方内置环境）**在 Linux 上永远复现不了**——
// Linux 的文件系统大小写敏感，`WEB` 与 `web` 是两个目录。所以这里直接测判定本身，
// 并用真 REST 层的入口证明"非规范大小写会被当作内置环境拒绝"。
import { test } from "node:test"
import assert from "node:assert/strict"

const { isBuiltinEnvironment, sameEnvironment } = await import("../dist/paths.js")
const { removeEnvironment } = await import("../dist/envManager.js")

/** 临时把 process.platform 伪装成另一个平台（判定依赖它，所以要能模拟）。 */
function withPlatform(platform, body) {
  const original = Object.getOwnPropertyDescriptor(process, "platform")
  Object.defineProperty(process, "platform", { value: platform, configurable: true })
  try { return body() } finally { Object.defineProperty(process, "platform", original) }
}

test("内置环境判定与大小写无关（无条件）", () => {
  for (const name of ["web", "WEB", "Web", "headless", "HEADLESS", "Headless"]) {
    assert.equal(isBuiltinEnvironment(name), true, name)
  }
  assert.equal(isBuiltinEnvironment("my-env"), false)
})

test("非规范大小写的内置名，在 REST 层入口就被拒绝，而不是走到删除", async () => {
  // 修复前：Linux 上 `WEB` 不是内置 → 继续走到"环境不存在"；Windows/macOS 上会真的删掉 web 目录。
  // 现在必须在校验阶段就以 builtin 拒绝，且**不碰文件系统**。
  for (const name of ["WEB", "Headless"]) {
    const result = await removeEnvironment(name)
    assert.equal(result.ok, false, name)
    assert.equal(result.code, "builtin", name + " 应当以内置环境为由被拒绝，实际：" + String(result.code))
  }
})

test("sameEnvironment：同一台机器上是否指向同一个目录", () => {
  assert.equal(sameEnvironment("web", "web"), true)
  assert.equal(sameEnvironment(null, null), true)
  assert.equal(sameEnvironment("web", null), false)

  // Windows/macOS 默认文件系统大小写不敏感：两个名字落到同一个目录，必须判为同一个。
  for (const platform of ["win32", "darwin"]) {
    withPlatform(platform, () => {
      assert.equal(sameEnvironment("web", "WEB"), true, platform)
      assert.equal(sameEnvironment("pm-test", "PM-Test"), true, platform)
    })
  }

  // Linux 是大小写敏感的：那里它们确实是两个目录，不能无条件忽略大小写。
  withPlatform("linux", () => {
    assert.equal(sameEnvironment("web", "WEB"), false)
  })
})

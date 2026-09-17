// 传输层契约测试：信任围栏、请求体分级、job 注册表。
// 被验对象是构建产物 dist/rest.js —— 与线上跑的完全一致。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

const {
  ROUTE_PREFIX, BODY_LIMIT_DEFAULT, BODY_LIMIT_BACKUP, bodyLimitFor,
  isTrustedRequest, isJsonPost, readJsonBody, JobRegistry, JOB_MAX_PENDING,
} = await import('../dist/rest.js')

// ── 信任围栏 ──────────────────────────────────────────────────────────────

test('ROUTE_PREFIX 避开旧仓库的前缀，两包可短期共存', () => {
  assert.equal(ROUTE_PREFIX, '/api2/companion')
  assert.notEqual(ROUTE_PREFIX, '/api2/plugin-manager')
})

test('回环 Host 放行', () => {
  for (const host of ['127.0.0.1:3080', '127.0.0.1', 'localhost:3080', 'localhost', '[::1]:3080', '127.5.5.5:1']) {
    const r = isTrustedRequest({ method: 'POST', headers: { host } })
    assert.equal(r.ok, true, host + ' 应放行')
  }
})

test('非回环且未白名单的 Host 拒绝（挡 DNS-rebinding）', () => {
  const r = isTrustedRequest({ method: 'POST', headers: { host: 'evil.example.com' } })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'untrusted-host')
})

test('白名单 Host 放行', () => {
  const r = isTrustedRequest({ method: 'POST', headers: { host: 'box.lan:3080' } }, { trustedHosts: ['box.lan'] })
  assert.equal(r.ok, true)
})

test('Origin 与 Host 不同源时拒绝（挡 CSRF）', () => {
  const r = isTrustedRequest({ method: 'POST', headers: { host: '127.0.0.1:3080', origin: 'http://evil.example.com' } })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'cross-origin')
})

test('Origin 同源时放行', () => {
  const r = isTrustedRequest({ method: 'POST', headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } })
  assert.equal(r.ok, true)
})

test('非法 Origin 拒绝', () => {
  const r = isTrustedRequest({ method: 'POST', headers: { host: '127.0.0.1:3080', origin: 'not a url' } })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'bad-origin')
})

test('无 Host 的非 HTTP 载体：默认拒绝，显式允许且非 cross-site 时放行', () => {
  const bare = { method: 'POST', headers: {} }
  const denied = isTrustedRequest(bare)
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'untrusted-host')

  const allowed = isTrustedRequest(bare, { allowNonHttpCarrier: true })
  assert.equal(allowed.ok, true)

  const crossSite = isTrustedRequest(
    { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } },
    { allowNonHttpCarrier: true },
  )
  assert.equal(crossSite.ok, false)
  assert.equal(crossSite.code, 'cross-site')
})

test('sec-fetch-site 缺失不判为 cross-site（非浏览器载体不带此头）', () => {
  const r = isTrustedRequest({ method: 'POST', headers: { host: '127.0.0.1' } })
  assert.equal(r.ok, true)
})

test('header 为数组时取首值', () => {
  const r = isTrustedRequest({ method: 'POST', headers: { host: ['127.0.0.1:3080', 'other'] } })
  assert.equal(r.ok, true)
})

// ── JSON POST 判定 ────────────────────────────────────────────────────────

test('只接受 POST + application/json', () => {
  assert.equal(isJsonPost({ method: 'POST', headers: { 'content-type': 'application/json' } }), true)
  assert.equal(isJsonPost({ method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' } }), true)
  assert.equal(isJsonPost({ method: 'GET', headers: { 'content-type': 'application/json' } }), false)
  assert.equal(isJsonPost({ method: 'POST', headers: { 'content-type': 'text/plain' } }), false)
  assert.equal(isJsonPost({ method: 'POST', headers: {} }), false)
})

// ── 请求体分级 ────────────────────────────────────────────────────────────

test('请求体上限按 op 分级，只有备份导入用大上限', () => {
  assert.equal(bodyLimitFor('backupRestore'), BODY_LIMIT_BACKUP)
  assert.equal(bodyLimitFor('diagnose'), BODY_LIMIT_DEFAULT)
  assert.ok(BODY_LIMIT_BACKUP > BODY_LIMIT_DEFAULT)
})

// ── 请求体读取 ────────────────────────────────────────────────────────────

const streamOf = (text) => Readable.from([Buffer.from(text, 'utf8')])

test('读取并解析 JSON 请求体', async () => {
  const r = await readJsonBody(streamOf('{"a":1}'), 1024)
  assert.equal(r.ok, true)
  assert.deepEqual(r.value, { a: 1 })
})

test('空体解析为空对象（无参数的 op 可以不带 body）', async () => {
  const r = await readJsonBody(streamOf('   '), 1024)
  assert.equal(r.ok, true)
  assert.deepEqual(r.value, {})
})

test('超出上限即拒绝，且不因先读完后判断而失去保护', async () => {
  const r = await readJsonBody(streamOf('{"a":"' + 'x'.repeat(4096) + '"}'), 64)
  assert.equal(r.ok, false)
  assert.equal(r.code, 'body-too-large')
})

test('坏 JSON 给出 bad-json 而不是抛异常', async () => {
  const r = await readJsonBody(streamOf('{oops'), 1024)
  assert.equal(r.ok, false)
  assert.equal(r.code, 'bad-json')
})

test('多字节字符按字节数计入上限', async () => {
  // 每个中文字符 3 字节：50 个字符 = 150 字节 > 100
  const r = await readJsonBody(streamOf('"' + '中'.repeat(50) + '"'), 100)
  assert.equal(r.ok, false)
  assert.equal(r.code, 'body-too-large')
})

// ── job 注册表 ────────────────────────────────────────────────────────────

test('job 完成后可按 id 读到结果', async () => {
  const registry = new JobRegistry()
  const id = registry.start(async () => ({ value: 42 }))
  await new Promise(resolve => setImmediate(resolve))
  const status = registry.status(id)
  assert.equal(status.done, true)
  assert.deepEqual(status.result, { value: 42 })
})

test('job 失败被折叠成 error 字段而不是未处理拒绝', async () => {
  const registry = new JobRegistry()
  const id = registry.start(async () => { throw new Error('boom') })
  await new Promise(resolve => setImmediate(resolve))
  const status = registry.status(id)
  assert.equal(status.done, true)
  assert.equal(status.error, 'boom')
})

test('未知 id 返回 missing，供客户端区分“过期”与“仍在跑”', () => {
  const registry = new JobRegistry()
  assert.deepEqual(registry.status('nope'), { done: true, missing: true })
})

test('在途 job 达上限时背压拒绝', async () => {
  const registry = new JobRegistry()
  let release
  const gate = new Promise(resolve => { release = resolve })
  for (let i = 0; i < JOB_MAX_PENDING; i += 1) registry.start(async () => gate)
  assert.throws(() => registry.start(async () => gate), /too many operations in flight/)
  release()
})

test('已完成的 job 不占在途配额', async () => {
  const registry = new JobRegistry()
  const id = registry.start(async () => 1)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(registry.status(id).done, true)
  // 配额已释放，可以继续起新的
  for (let i = 0; i < JOB_MAX_PENDING; i += 1) registry.start(async () => new Promise(() => {}))
})

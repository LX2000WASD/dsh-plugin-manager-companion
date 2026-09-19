/**
 * tests/marketplace.test.mjs — 市场管道的验收测试。
 *
 * 被测对象是**构建产物** `dist/*.js`，不是 src：沿用旧仓库"被验的代码就是线上跑的代码"的方法论。
 * 覆盖：网络层纯函数（代理/NO_PROXY）→ 索引多源兜底链与磁盘缓存（注入假 fetcher，无网络）
 * → 已安装判定四条通道与 TTL/内容身份缓存 → 管线缓存键与分类计数 → 视图排序 8 组合
 * → plugin_search 的打分与版本比较。
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { noProxyMatches, proxyUrlFor } = await import('../dist/net.js')
const registry = await import('../dist/registry.js')
const marketplace = await import('../dist/marketplace.js')
const view = await import('../dist/marketView.js')
const tags = await import('../dist/tags.js')
const match = await import('../dist/match.js')

// ── 测试夹具 ────────────────────────────────────────────────────────────

/**
 * 本轮建过的临时 HOME：跑完统一删掉。
 * 不删的话每次跑测试都会往 /tmp 里堆 30 个目录（实测一次全量跑遗留 1,056 个），
 * 属于测试自己对环境的不负责。
 */
const createdHomes = []
after(() => {
  for (const home of createdHomes) rmSync(home, { recursive: true, force: true })
  createdHomes.length = 0
})

/** 每个测试自建一个 DSH_HOME，避免污染真实环境（也避免测试之间互相看见缓存）。 */
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'pmc-market-'))
  createdHomes.push(home)
  process.env.DSH_HOME = home
  registry.resetRegistryMemory()
  marketplace.clearInstalledIndexCache()
  marketplace.clearMarketplaceCache()
  return home
}

/** 一个响应式假响应。 */
function reply(payload, { status = 200, gzip = false } = {}) {
  const buffer = gzip ? gzipSync(Buffer.from(JSON.stringify(payload), 'utf8')) : Buffer.from(JSON.stringify(payload), 'utf8')
  return {
    ok: status >= 200 && status < 300,
    status,
    async arrayBuffer() { return buffer },
    async text() { return buffer.toString('utf8') },
  }
}

/** 按 URL 分派的假 fetcher（同时记录调用顺序，便于断言"有没有走网络"）。 */
function fakeFetcher(routes) {
  const calls = []
  const fetcher = async (url, options) => {
    calls.push(url)
    const handler = routes[url]
    if (handler === undefined) return reply({}, { status: 404 })
    return typeof handler === 'function' ? handler(url, options) : handler
  }
  fetcher.calls = calls
  return fetcher
}

/** 一个索引载荷。 */
function indexPayload(repos, generatedAt) {
  return { generated_at: generatedAt, repos }
}

/** 一条最小索引条目。 */
function repo(fullName, extra = {}) {
  return { full_name: fullName, name: fullName.split('/')[1], description: 'x', stargazers_count: 1, updated_at: '2026-01-01T00:00:00Z', topics: [], ...extra }
}

/** 一条市场条目。 */
function item(over = {}) {
  return {
    repo: 'alice/tool',
    name: 'tool',
    description: 'a plugin',
    stars: 10,
    updatedAt: '2026-01-02T00:00:00Z',
    topics: [],
    ...over,
  }
}

const SOURCES = registry.registryIndexSources()

// ── 网络层纯函数 ────────────────────────────────────────────────────────

test('noProxyMatches：通配 / 精确 / 后缀 / 端口 / IPv6', () => {
  assert.equal(noProxyMatches('github.com', undefined), false)
  assert.equal(noProxyMatches('github.com', ''), false)
  assert.equal(noProxyMatches('github.com', '*'), true)
  assert.equal(noProxyMatches('github.com', 'example.com'), false)
  assert.equal(noProxyMatches('github.com', 'github.com'), true)
  assert.equal(noProxyMatches('api.github.com', 'github.com'), true)
  assert.equal(noProxyMatches('api.github.com', '.github.com'), true)
  assert.equal(noProxyMatches('notgithub.com', 'github.com'), false)
  assert.equal(noProxyMatches('github.com', 'localhost:8080, github.com:443'), true)
  assert.equal(noProxyMatches('github.com', 'localhost,example.com'), false)
  assert.equal(noProxyMatches('[::1]', '[::1]:8080'), true)
  assert.equal(noProxyMatches('example.com', '  ,  '), false)
})

test('proxyUrlFor：按 scheme 取代理，NO_PROXY 命中则直连', () => {
  const env = { HTTPS_PROXY: 'http://127.0.0.1:7890', HTTP_PROXY: 'http://127.0.0.1:7891', NO_PROXY: 'example.com' }
  assert.equal(proxyUrlFor('https://api.github.com/x', env), 'http://127.0.0.1:7890')
  assert.equal(proxyUrlFor('http://api.github.com/x', env), 'http://127.0.0.1:7891')
  assert.equal(proxyUrlFor('https://example.com/x', env), null)
  assert.equal(proxyUrlFor('https://api.github.com/x', {}), null)
  assert.equal(proxyUrlFor('not a url', env), null)
  assert.equal(proxyUrlFor('https://api.github.com/x', { https_proxy: 'http://lower:1' }), 'http://lower:1')
})

// ── 索引归一化与载荷解析 ────────────────────────────────────────────────

test('normalizeRegistryRepo：形状 / 缺字段 / 非法输入', () => {
  const full = registry.normalizeRegistryRepo(repo('alice/tool', { pkg_name: '@alice/tool', version: '1.2.3', category: 'tool', topics: ['memory', 'x'] }))
  assert.deepEqual(full, {
    repo: 'alice/tool', name: 'tool', description: 'x', stars: 1, updatedAt: '2026-01-01T00:00:00Z',
    topics: ['memory', 'x'], category: 'tool', packageName: '@alice/tool', latestVersion: '1.2.3',
  })
  // 星数缺失是 null（"未知"），不是伪造的 0
  assert.equal(registry.normalizeRegistryRepo({ full_name: 'a/b' }).stars, null)
  assert.equal(registry.normalizeRegistryRepo({ full_name: 'a/b' }).updatedAt, null)
  assert.equal(registry.normalizeRegistryRepo({ full_name: 'a/b' }).description, '')
  // 非法输入
  assert.equal(registry.normalizeRegistryRepo(null), null)
  assert.equal(registry.normalizeRegistryRepo('alice/tool'), null)
  assert.equal(registry.normalizeRegistryRepo({ full_name: 'noslash' }), null)
  assert.equal(registry.normalizeRegistryRepo({ full_name: 'a/b/c' }), null)
  // 官方自己的仓库不是插件
  assert.equal(registry.normalizeRegistryRepo({ full_name: 'deepseek-ai/deepseek-harness' }), null)
  // 数字主题不该让归一化炸掉
  assert.deepEqual(registry.normalizeRegistryRepo({ full_name: 'a/b', topics: ['ok', 7, null] }).topics, ['ok'])
})

test('parseRegistryPayload：去重 / 丢弃计数 / generated_at / 两种载荷形状', () => {
  const parsed = registry.parseRegistryPayload(indexPayload([
    repo('a/one'), repo('a/one'), repo('b/two'), { nope: true }, null,
  ], '2026-01-01T00:00:00Z'))
  assert.deepEqual(parsed.repos.map((entry) => entry.repo), ['a/one', 'b/two'])
  assert.equal(parsed.skipped, 2)
  assert.equal(parsed.generatedAt, '2026-01-01T00:00:00Z')
  // search API 形状（裸数组 + items）
  assert.equal(registry.parseRegistryPayload({ items: [repo('c/three')] }).repos.length, 1)
  assert.equal(registry.parseRegistryPayload([repo('d/four')]).generatedAt, null)
  assert.equal(registry.parseRegistryPayload({ repos: [] }), null)
  assert.equal(registry.parseRegistryPayload(42), null)
})

test('functionalTopics：剔掉生态泛化词、保序、限量', () => {
  assert.deepEqual(registry.functionalTopics(['ai', 'memory', 'dsh-plugin', 'cli', 'RAG']), ['memory', 'rag'])
  assert.deepEqual(registry.functionalTopics(undefined), [])
  assert.equal(registry.functionalTopics(Array.from({ length: 20 }, (_, index) => 'topic' + index)).length, 8)
})

test('isRegistryCacheFresh：文件年龄与内容年龄都要在 TTL 内', () => {
  const now = 1_000_000_000
  const hour = 3600_000
  assert.equal(registry.isRegistryCacheFresh({ savedAt: now, generatedAt: new Date(now - hour).toISOString() }, now, 24 * hour), true)
  assert.equal(registry.isRegistryCacheFresh({ savedAt: now - 25 * hour, generatedAt: new Date(now).toISOString() }, now, 24 * hour), false)
  // 今天才存下来的三天前索引不算新鲜
  assert.equal(registry.isRegistryCacheFresh({ savedAt: now, generatedAt: new Date(now - 72 * hour).toISOString() }, now, 24 * hour), false)
  // 载荷不带生成时间时只能靠文件年龄
  assert.equal(registry.isRegistryCacheFresh({ savedAt: now - hour, generatedAt: null }, now, 24 * hour), true)
  assert.equal(registry.isRegistryCacheFresh({ savedAt: now - hour, generatedAt: 'not-a-date' }, now, 24 * hour), true)
})

test('shouldPersistRegistryIndex：只许更新不许回退（M14）', () => {
  const newer = '2026-01-02T00:00:00Z'
  const older = '2026-01-01T00:00:00Z'
  assert.equal(registry.shouldPersistRegistryIndex(newer, older), true)
  assert.equal(registry.shouldPersistRegistryIndex(older, newer), false)
  assert.equal(registry.shouldPersistRegistryIndex(newer, null), true)
  // 无法证明年龄的载荷不落盘（宁可下次再抓）
  assert.equal(registry.shouldPersistRegistryIndex(null, newer), false)
  assert.equal(registry.shouldPersistRegistryIndex(null, null), false)
  assert.equal(registry.shouldPersistRegistryIndex(newer, newer), true)
})

test('registryIndexSources：自定义源优先、内置五跳仍保留、CDN 跳标记新鲜度', () => {
  const plain = registry.registryIndexSources()
  assert.deepEqual(plain.map((source) => source.id), ['api', 'jsdelivr-gz', 'raw-gz', 'jsdelivr', 'raw'])
  assert.deepEqual(plain.filter((source) => source.requireFresh).map((source) => source.id), ['jsdelivr-gz', 'jsdelivr'])
  assert.equal(plain[0].token, true)
  const custom = registry.registryIndexSources({ indexUrl: 'https://mirror.example/registry.json.gz' })
  assert.equal(custom[0].id, 'custom')
  assert.equal(custom[0].gzip, true)
  assert.equal(custom.length, 6)
})

// ── 兜底链与磁盘缓存（无网络） ──────────────────────────────────────────

test('兜底链：首跳失败即顺延，CDN 过旧要跳过，gz 能解压', async () => {
  makeHome()
  const now = Date.now()
  const fresh = new Date(now).toISOString()
  const stale = new Date(now - 7 * 3600_000).toISOString()
  const fetcher = fakeFetcher({
    [SOURCES[0].url]: reply({}, { status: 403 }),
    [SOURCES[1].url]: reply(indexPayload([repo('js/hit')], stale), { gzip: true }),
    [SOURCES[2].url]: reply(indexPayload([repo('raw/hit')], stale), { gzip: true }),
  })
  const index = await registry.loadRegistryIndex({ fetcher, now })
  assert.equal(index.source, 'network:raw-gz')
  assert.deepEqual(index.repos.map((entry) => entry.repo), ['raw/hit'])
  assert.equal(index.cached, false)
  assert.ok(index.notes.some((note) => note.includes('api') && note.includes('403')), '如实记账首跳失败')
  assert.ok(index.notes.some((note) => note.includes('jsdelivr-gz') && note.includes('过旧')), 'CDN 过旧被跳过')

  // 换一份新鲜的 CDN 索引：它应该赢
  const fetcher2 = fakeFetcher({
    [SOURCES[0].url]: reply({}, { status: 500 }),
    [SOURCES[1].url]: reply(indexPayload([repo('js/hit')], fresh), { gzip: true }),
  })
  registry.resetRegistryMemory()
  const second = await registry.loadRegistryIndex({ fetcher: fetcher2, now, refresh: true })
  assert.equal(second.source, 'network:jsdelivr-gz')
  assert.equal(second.generatedAt, fresh)
})

test('磁盘缓存：新鲜时短路网络；refresh 时忽略；全失败时回退（并标记 stale）', async () => {
  const home = makeHome()
  const now = Date.now()
  const generatedAt = new Date(now).toISOString()
  assert.equal(registry.writeRegistryCacheFile({
    savedAt: now, generatedAt, repos: [registry.normalizeRegistryRepo(repo('cache/hit'))],
  }), true)
  assert.ok(registry.readRegistryCacheFile().repos.length === 1)
  assert.ok(registry.registryCachePath().startsWith(home))

  // 新鲜缓存：不碰网络
  const offline = fakeFetcher({})
  const cached = await registry.loadRegistryIndex({ fetcher: offline, now })
  assert.equal(cached.cached, true)
  assert.equal(cached.stale, false)
  assert.equal(cached.source, 'cache')
  assert.equal(offline.calls.length, 0)

  // 用户点刷新：必须走网络（这里网络全 404 → 回退到过期/仍旧的缓存）
  registry.resetRegistryMemory()
  const failing = fakeFetcher({})
  const refreshed = await registry.loadRegistryIndex({ fetcher: failing, now, refresh: true })
  assert.ok(failing.calls.length > 0)
  assert.equal(refreshed.source, 'cache-stale')
  assert.deepEqual(refreshed.repos.map((entry) => entry.repo), ['cache/hit'])

  // TTL 之外 + 网络全失败 → 过期缓存兜底
  registry.resetRegistryMemory()
  const expiredFetcher = fakeFetcher({})
  const expired = await registry.loadRegistryIndex({ fetcher: expiredFetcher, now: now + 48 * 3600_000 })
  assert.equal(expired.stale, true)

  // 无缓存 + 网络全失败 → 空结果，绝不抛错
  const emptyHome = makeHome()
  assert.equal(emptyHome.length > 0, true)
  const empty = await registry.loadRegistryIndex({ fetcher: fakeFetcher({}), now })
  assert.deepEqual(empty.repos, [])
  assert.equal(empty.source, 'empty')
  assert.equal(empty.stale, true)
  assert.equal(empty.cached, false, '什么都没拿到时不能说"来自缓存"（P2：旧的 true 会让 UI 画成缓存的假象）')
  assert.ok(empty.notes.some((note) => note.includes('无磁盘缓存')))
})

test('落盘策略：比缓存旧的索引不覆盖缓存（M14）', async () => {
  makeHome()
  const now = Date.now()
  const newer = new Date(now).toISOString()
  const older = new Date(now - 3 * 3600_000).toISOString()
  await registry.loadRegistryIndex({ fetcher: fakeFetcher({ [SOURCES[0].url]: reply(indexPayload([repo('a/new')], newer), { gzip: true }) }), now })
  assert.equal(registry.readRegistryCacheFile().generatedAt, newer)

  registry.resetRegistryMemory()
  const olderWalk = await registry.loadRegistryIndex({
    fetcher: fakeFetcher({ [SOURCES[0].url]: reply(indexPayload([repo('a/old')], older), { gzip: true }) }),
    now: now + 1000,
    refresh: true,
  })
  assert.deepEqual(olderWalk.repos.map((entry) => entry.repo), ['a/old'], '本次结果仍然是本次抓到的')
  assert.equal(registry.readRegistryCacheFile().generatedAt, newer, '但不许覆盖更新的缓存')
  assert.ok(olderWalk.notes.some((note) => note.includes('比磁盘缓存旧')))

  // 不带 generated_at 的载荷同样不落盘
  registry.resetRegistryMemory()
  const noStamp = await registry.loadRegistryIndex({
    fetcher: fakeFetcher({ [SOURCES[0].url]: reply({ repos: [repo('a/nostamp')] }, { gzip: true }) }),
    now: now + 2000,
    refresh: true,
  })
  assert.equal(registry.readRegistryCacheFile().generatedAt, newer)
  assert.ok(noStamp.notes.some((note) => note.includes('generated_at')))
})

test('索引内容代际：内容不变不推进，内容变了才推进（m-3）', async () => {
  makeHome()
  const now = Date.now()
  const payload = (name) => indexPayload([repo(name)], new Date(now).toISOString())
  const walk = () => registry.loadRegistryIndex({
    fetcher: fakeFetcher({ [SOURCES[0].url]: reply(payload('a/one'), { gzip: true }) }),
    now,
    refresh: true,
  })
  const first = await walk()
  // 同一份内容再走一次网络（用户连点两次刷新）也不该推进
  const again = await walk()
  assert.equal(again.generation, first.generation, '同内容的网络重抓不推进代际')
  // TTL 之后网络全失败 → 回退到内容相同的过期磁盘缓存，同样不该推进
  const stale = await registry.loadRegistryIndex({ fetcher: fakeFetcher({}), now: now + 48 * 3600_000 })
  assert.equal(stale.source, 'cache-stale')
  assert.equal(stale.stale, true)
  assert.equal(stale.generation, first.generation, '同内容的缓存重读不推进代际')

  // 换内容（refresh 绕过缓存）→ 代际必须前进
  const changed = await registry.loadRegistryIndex({
    fetcher: fakeFetcher({ [SOURCES[0].url]: reply(payload('b/two'), { gzip: true }) }),
    now,
    refresh: true,
  })
  assert.ok(changed.generation > first.generation, '内容变了代际要前进')
  assert.deepEqual(changed.repos.map((entry) => entry.repo), ['b/two'])
  assert.equal(registry.registryGeneration(), changed.generation)
})

// ── 已安装判定 ──────────────────────────────────────────────────────────

/** 造一个装了三个包的 profile：普通包（repository 是完整 URL）、scoped 包、git 源包。 */
function seedProfile(home, name = 'web') {
  const dir = join(home, 'profiles', name)
  mkdirSync(join(dir, 'node_modules', 'dsh-note'), { recursive: true })
  mkdirSync(join(dir, 'node_modules', '@alice', 'tool'), { recursive: true })
  mkdirSync(join(dir, 'node_modules', 'git-tool'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'profile-web',
    dependencies: { 'dsh-note': '^1.0.0', '@alice/tool': '^2.0.0', 'git-tool': 'github:alice/git-tool' },
  }))
  writeFileSync(join(dir, 'node_modules', 'dsh-note', 'package.json'), JSON.stringify({
    name: 'dsh-note', version: '1.4.0', repository: { type: 'git', url: 'git+https://github.com/bob/dsh-note.git' },
  }))
  writeFileSync(join(dir, 'node_modules', '@alice', 'tool', 'package.json'), JSON.stringify({
    name: '@alice/tool', version: '2.1.0', repository: 'alice/dsh-tool',
  }))
  writeFileSync(join(dir, 'node_modules', 'git-tool', 'package.json'), JSON.stringify({ name: 'git-tool', version: '0.9.0' }))
  return dir
}

test('buildInstalledIndex：四条通道的事实来源 + 未装声明的包不算已安装', () => {
  const home = makeHome()
  const dir = seedProfile(home)
  // 声明了但 node_modules 里没有 → 不算已安装（那正是诊断层要报的问题）
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  manifest.dependencies['ghost-pkg'] = '^1.0.0'
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  mkdirSync(join(home, 'skills', 'skill-pack'), { recursive: true })
  mkdirSync(join(home, '.agent-presets', 'preset-pack'), { recursive: true })

  const index = marketplace.buildInstalledIndex('web', { now: 0 })
  assert.equal(index.packages.get('dsh-note'), '1.4.0')
  assert.equal(index.packages.has('ghost-pkg'), false)
  assert.equal(index.repos.get('bob/dsh-note'), '1.4.0')
  assert.equal(index.repos.get('alice/dsh-tool'), '2.1.0')
  assert.equal(index.gitSources.get('github.com-alice-git-tool'), '0.9.0')
  assert.deepEqual([...index.skills], ['skill-pack'])
  assert.deepEqual([...index.presets], ['preset-pack'])

  // 未知 / 非法 profile 名一律 null（不抛错）
  assert.equal(marketplace.buildInstalledIndex('nope', { now: 0 }), null)
  assert.equal(marketplace.buildInstalledIndex('..', { now: 0 }), null)
})

test('已安装索引缓存：TTL 之内复用、到期重建、显式失效立即生效', () => {
  const home = makeHome()
  const dir = seedProfile(home)
  const ttl = 5_000
  const first = marketplace.buildInstalledIndex('web', { now: 1_000, ttlMs: ttl })
  assert.equal(first.packages.has('dsh-note'), true)

  // 磁盘上新增一个包：TTL 之内看不到（缓存复用）
  mkdirSync(join(dir, 'node_modules', 'late-pkg'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'late-pkg', 'package.json'), JSON.stringify({ name: 'late-pkg', version: '1.0.0' }))
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  manifest.dependencies['late-pkg'] = '^1.0.0'
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))

  const stillCached = marketplace.buildInstalledIndex('web', { now: 1_000 + ttl - 1, ttlMs: ttl })
  assert.equal(stillCached, first, 'TTL 内返回同一个对象')
  const rebuilt = marketplace.buildInstalledIndex('web', { now: 1_000 + ttl, ttlMs: ttl })
  assert.equal(rebuilt.packages.has('late-pkg'), true, 'TTL 到期后重建')

  // 内容身份：重建但内容不变 → 身份不变（m-3，不让下游管线缓存无谓失效）
  marketplace.clearInstalledIndexCache()
  const contentA = marketplace.buildInstalledIndex('web', { now: 10, ttlMs: 0 })
  const contentB = marketplace.buildInstalledIndex('web', { now: 20, ttlMs: 0 })
  assert.equal(contentA.identity, contentB.identity)

  // 显式失效：装/卸/更新后不能等 TTL
  marketplace.invalidateInstalledIndex('web')
  const invalidated = marketplace.buildInstalledIndex('web', { now: 1_000 + 1, ttlMs: ttl })
  assert.equal(invalidated.packages.has('late-pkg'), true)
})

test('flagInstalled：repository / 包名 / git 源 / 目录探测四条通道', () => {
  const home = makeHome()
  seedProfile(home)
  mkdirSync(join(home, 'skills', 'skill-pack'), { recursive: true })
  const index = marketplace.buildInstalledIndex('web', { now: 0 })

  // 1) repository 身份（双向：条目 repo 命中已装包的 repository）
  const byRepo = marketplace.flagInstalled(marketplace.registryItem(registry.normalizeRegistryRepo(repo('bob/dsh-note'))), index)
  assert.equal(byRepo.installed, true)
  assert.equal(byRepo.installedVersion, '1.4.0')

  // 2) 包名（索引 pkg_name 与仓库名不同：@alice/tool vs alice/dsh-tool）
  const byPackage = marketplace.flagInstalled(
    marketplace.registryItem(registry.normalizeRegistryRepo(repo('alice/dsh-tool', { pkg_name: '@alice/tool', version: '2.2.0' }))),
    index,
  )
  assert.equal(byPackage.installed, true)
  assert.equal(byPackage.installedVersion, '2.1.0')
  assert.equal(view.updateAvailable(byPackage), true, '2.1.0 < 2.2.0 → 有更新')

  // 3) git 源
  const byGit = marketplace.flagInstalled(marketplace.registryItem(registry.normalizeRegistryRepo(repo('alice/git-tool'))), index)
  assert.equal(byGit.installed, true)
  assert.equal(byGit.installedVersion, '0.9.0')

  // 4) 目录探测（skill），形态随之改写
  const byDir = marketplace.flagInstalled(marketplace.registryItem(registry.normalizeRegistryRepo(repo('who/skill-pack'))), index)
  assert.equal(byDir.installed, true)
  assert.equal(byDir.kind, 'skill')

  // 未安装
  const miss = marketplace.flagInstalled(marketplace.registryItem(registry.normalizeRegistryRepo(repo('who/else'))), index)
  assert.equal(miss.installed, false)
  assert.equal(Object.hasOwn(miss, 'installedVersion'), false)

  // 未知 profile（index=null）一律未安装
  assert.equal(marketplace.flagInstalled(marketplace.registryItem(registry.normalizeRegistryRepo(repo('bob/dsh-note'))), null).installed, false)

  // 目录探测的歧义保护：同一 slug 出现两次就不认
  const ambiguous = marketplace.flagInstalled(
    marketplace.registryItem(registry.normalizeRegistryRepo(repo('who/skill-pack'))),
    index,
    { ambiguousSlugs: new Set(['skill-pack']) },
  )
  assert.equal(ambiguous.installed, false)
})

test('normalizeRepoRef / gitSourceIdentity / directorySlug 的形态覆盖', () => {
  for (const value of [
    'alice/tool', 'github:alice/tool', 'git+https://github.com/alice/tool.git',
    'https://github.com/alice/tool', 'https://github.com/alice/tool/', 'git://github.com/alice/tool.git',
    'git@github.com:alice/tool.git', 'https://www.github.com/alice/tool',
  ]) {
    assert.equal(marketplace.normalizeRepoRef(value), 'alice/tool', value)
  }
  assert.equal(marketplace.normalizeRepoRef('https://gitlab.com/alice/tool'), null)
  assert.equal(marketplace.normalizeRepoRef('alice/tool/extra'), null)
  assert.equal(marketplace.normalizeRepoRef(''), null)
  assert.equal(marketplace.normalizeRepoRef(undefined), null)
  assert.equal(marketplace.gitSourceIdentity('link:/home/u/.dsh/cache/github.com-alice-tool'), 'github.com-alice-tool')
  assert.equal(marketplace.gitSourceIdentity('github:alice/tool'), 'github.com-alice-tool')
  assert.equal(marketplace.gitSourceIdentity('^1.0.0'), null)
  assert.equal(marketplace.directorySlug('Dsh Note!'), 'dsh-note')
  assert.equal(marketplace.directorySlug('  --x--  '), 'x')
})

// ── 管线：分类计数 / wire 形状 / 内容身份缓存 ───────────────────────────

test('finalizeMarketplace：分类计数、wire 形状收敛、已安装标记', () => {
  const home = makeHome()
  seedProfile(home)
  const index = marketplace.buildInstalledIndex('web', { now: 0 })
  const repos = [
    registry.normalizeRegistryRepo(repo('bob/dsh-note', { category: 'memory' })),
    registry.normalizeRegistryRepo(repo('alice/dsh-tool', { category: 'tool', pkg_name: '@alice/tool' })),
    registry.normalizeRegistryRepo(repo('x/untagged')),
  ]
  const result = marketplace.finalizeMarketplace({
    profile: 'web',
    items: marketplace.registryItems(repos),
    generation: 1,
    installed: index,
    generatedAt: '2026-01-01T00:00:00Z',
    cached: false,
  })
  assert.deepEqual(result.categories, { memory: 1, tool: 1 }, '无分类的条目不进任何桶')
  assert.equal(result.generatedAt, '2026-01-01T00:00:00Z')
  assert.equal(result.cached, false)
  assert.equal(result.items.length, 3)
  // wire 形状收敛：只出现契约声明的字段（本轮新增 packageName / installSpec）
  const allowed = ['repo', 'name', 'description', 'stars', 'updatedAt', 'topics', 'category', 'installed', 'installedVersion', 'latestVersion', 'kind', 'packageName', 'installSpec']
  for (const entry of result.items) {
    assert.deepEqual(Object.keys(entry).filter((key) => !allowed.includes(key)), [], entry.repo)
  }
  assert.equal(result.items[0].installed, true)
  assert.equal(result.items[2].installed, false)
  // P0：每条都带上 host 定好的安装 spec，且**绝不是** owner/repo 那种官方拒收的形态
  for (const entry of result.items) {
    assert.equal(typeof entry.installSpec, 'string')
    assert.ok(entry.installSpec.length > 0)
    assert.notEqual(entry.installSpec, entry.repo)
    assert.ok(entry.installSpec.startsWith('github:') || !entry.installSpec.includes('/') || entry.installSpec.startsWith('@'), entry.installSpec)
  }
  assert.equal(result.items[1].packageName, '@alice/tool', 'npm 名一路带到 wire')
  assert.equal(result.items[1].installSpec, '@alice/tool', '有 npm 名就用 npm 名')
  assert.equal(result.items[0].installSpec, 'github:bob/dsh-note', '没有 npm 名就用官方认的 github: 形态')
})

test('installSpecFor：host 侧唯一定 spec 的地方（P0）', () => {
  assert.equal(marketplace.installSpecFor('alice/tool', 'dsh-tool'), 'dsh-tool')
  assert.equal(marketplace.installSpecFor('alice/tool', '@alice/tool'), '@alice/tool')
  assert.equal(marketplace.installSpecFor('alice/tool', '  DSH-Tool  '), 'dsh-tool', '归一化大小写与空白')
  assert.equal(marketplace.installSpecFor('alice/tool'), 'github:alice/tool')
  assert.equal(marketplace.installSpecFor('alice/tool', ''), 'github:alice/tool')
  assert.equal(marketplace.installSpecFor('alice/tool', 'not a package name'), 'github:alice/tool', '非法 npm 名不能原样送')
  assert.equal(marketplace.installSpecFor('alice/tool', 'Owner/Tool'), 'github:alice/tool', '带斜杠的不是包名')
  // 核心不变量：返回值永远不是 owner/repo（官方 parseInstallSpec 会判 invalid-spec）
  for (const spec of [marketplace.installSpecFor('a/b'), marketplace.installSpecFor('a/b', 'x'), marketplace.installSpecFor('a/b', 'A B')]) {
    assert.ok(spec !== 'a/b', spec)
  }
})

// 客户端 wire.ts 的归一化没有可导入的产物（client 侧 tsc 只出 .d.ts，js 由 tsdown 打成
// 浏览器 bundle），因此它的过桥由真机取证覆盖（断网截图里的文案就是那条链路的输出）。
// host 侧这一段必须可单测：source / stale / notes 要真的进得了结果。
test('结果透传索引状态：source / stale / notes（P2 的 host 半边）', () => {
  makeHome()
  const input = {
    profile: 'web',
    items: [marketplace.registryItem(registry.normalizeRegistryRepo(repo('a/one')))],
    generation: 1,
    installed: null,
    generatedAt: null,
    cached: true,
    source: 'cache-stale',
    stale: true,
    notes: ['api: HTTP 503', 'jsdelivr-gz: 索引过旧', 'raw-gz: HTTP 503', 'raw: HTTP 503', '第五条应被截断'],
  }
  const result = marketplace.finalizeMarketplace(input)
  assert.equal(result.source, 'cache-stale')
  assert.equal(result.stale, true)
  assert.equal(result.notes.length, marketplace.MARKET_NOTES_LIMIT, 'notes 有上限（不把整页淹掉）')
  assert.equal(result.notes[0], 'api: HTTP 503')
  assert.equal(result.generatedAt, '', '未知生成时间是空串，不伪造一个时间')
  // 缺省时不写这些字段（老契约的载荷形状保持干净）
  const bare = marketplace.finalizeMarketplace({ ...input, source: undefined, stale: undefined, notes: undefined })
  assert.equal('source' in bare, false)
  assert.equal('stale' in bare, false)
  assert.equal('notes' in bare, false)
  // 索引状态进缓存键：同内容不同来源/过期状态不能互相顶掉
  assert.notEqual(marketplace.marketplaceCacheKey(input), marketplace.marketplaceCacheKey({ ...input, source: 'network:api', stale: false }))
})

test('搜索（P1）：名称优先、字段命中在后，中文从 0 命中变成有命中', async () => {
  const { prepareMarketSearch, searchMarket } = await import('../dist/marketView.js')
  const { fuzzyFilter } = await import('../dist/rank.js')
  const items = [
    item({ repo: 'a/dsh-note', name: 'dsh-note', description: 'keeps project memory', topics: ['memory'] }),
    item({ repo: 'b/unrelated', name: 'unrelated', description: '', topics: [] }),
    item({ repo: 'c/记忆助手', name: 'memory-helper', description: '中文记忆插件', topics: ['记忆'] }),
    item({ repo: 'd/topic-only', name: 'topic-only', description: '', topics: ['memory'] }),
    item({ repo: 'e/desc-only', name: 'desc-only', description: 'about memory', topics: [] }),
  ]
  // 名称通道与改动前逐条一致（子序列模糊匹配）
  const before = fuzzyFilter(items, (entry) => entry.name, 'mem').map((hit) => hit.item.repo)
  const after = searchMarket(prepareMarketSearch(items), 'mem').map((entry) => entry.repo)
  assert.deepEqual(after.slice(0, before.length), before, '名称命中仍排在前面且顺序不变')
  assert.ok(after.length > before.length, '字段命中补上了名称看不见的条目')

  // 中文：旧实现 0 命中，新实现能搜到（描述/主题/名称都算）
  const cnBefore = fuzzyFilter(items, (entry) => entry.name, '记忆')
  const cnAfter = searchMarket(prepareMarketSearch(items), '记忆').map((entry) => entry.repo)
  assert.equal(cnBefore === null ? 0 : cnBefore.length, 0, '旧路径对中文恒为 0')
  assert.deepEqual(cnAfter, ['c/记忆助手'], '中文命中来自描述/主题/名称的子串')

  // 权重与排序：repo/主题 > 描述；同权重按星数
  const weighted = [
    item({ repo: 'z/desc', name: 'zzz', description: 'memory', topics: [], stars: 999 }),
    item({ repo: 'y/topic', name: 'yyy', description: '', topics: ['memory'], stars: 1 }),
  ]
  assert.deepEqual(searchMarket(prepareMarketSearch(weighted), 'memory').map((entry) => entry.repo), ['y/topic', 'z/desc'], '主题 2 分 > 描述 1 分，星数只在同分时破平')

  // 空查询 / 空白查询 → null（排序交给调用方）
  assert.equal(searchMarket(prepareMarketSearch(items), ''), null)
  assert.equal(searchMarket(prepareMarketSearch(items), '   '), null)
  assert.deepEqual(searchMarket(prepareMarketSearch(items), 'zzzzz'), [])
})

test('搜索（P1）：掩码预筛不改变命中集合（与逐条全扫等价）', async () => {
  const { prepareMarketSearch, searchMarket } = await import('../dist/marketView.js')
  // 造一批含非 ASCII 的条目，确认掩码（只覆盖 ASCII 字母）只放过不误杀
  const items = []
  for (let index = 0; index < 60; index += 1) {
    items.push(item({
      repo: 'r/' + String(index),
      name: index % 2 === 0 ? ('plugin-' + String(index)) : ('插件' + String(index)),
      description: index % 3 === 0 ? '中文描述 memory' : 'ascii description',
      topics: index % 5 === 0 ? ['记忆', 'rag'] : ['other'],
    }))
  }
  const entries = prepareMarketSearch(items)
  for (const query of ['memory', '记忆', 'rag', 'plugin', '插件', 'zzz']) {
    const hits = searchMarket(entries, query).map((entry) => entry.repo)
    // 参照实现：不做掩码，直接全扫同样的字段
    const naive = []
    for (const entry of items) {
      const needle = query.toLowerCase()
      // 注意 fuzzyFilter 对非空查询返回的是**数组**（空数组=没有命中），不是 null
      const nameHit = (await import('../dist/rank.js')).fuzzyFilter([entry], (x) => x.name, query).length > 0
      const hay = (entry.name + ' ' + entry.repo + ' ' + entry.topics.join(' ') + ' ' + entry.description).toLowerCase()
      if (nameHit || hay.includes(needle)) naive.push(entry.repo)
    }
    assert.deepEqual([...hits].sort(), [...naive].sort(), '查询 ' + query + ' 的命中集合必须一致')
  }
})

test('管线缓存键包含内容身份（M-1：同代际不同条目必须重算）', () => {
  makeHome()
  const base = { profile: 'web', generation: 7, installed: null, generatedAt: 'T', cached: false }
  const keyA = marketplace.marketplaceCacheKey({ ...base, items: [marketplace.registryItem(registry.normalizeRegistryRepo(repo('a/one')))] })
  const keyB = marketplace.marketplaceCacheKey({ ...base, items: [marketplace.registryItem(registry.normalizeRegistryRepo(repo('b/two')))] })
  const keyC = marketplace.marketplaceCacheKey({ ...base, items: [marketplace.registryItem(registry.normalizeRegistryRepo(repo('a/one')))] })
  assert.notEqual(keyA, keyB, '不同内容 → 不同键（旧实现只比时间戳，这里必须能区分）')
  assert.equal(keyA, keyC, '同内容 → 同键')
  assert.notEqual(keyA, marketplace.marketplaceCacheKey({ ...base, generation: 8, items: [marketplace.registryItem(registry.normalizeRegistryRepo(repo('a/one')))] }))
  assert.equal(marketplace.itemsIdentity([]), '0-' + registry.hashIdentity([]))

  // 内容身份对"顺序不同但集合相同"也敏感（顺序是索引的一部分）
  const two = [marketplace.registryItem(registry.normalizeRegistryRepo(repo('a/one'))), marketplace.registryItem(registry.normalizeRegistryRepo(repo('b/two')))]
  assert.notEqual(marketplace.itemsIdentity(two), marketplace.itemsIdentity([...two].reverse()))
})

test('cachedMarketplace：命中返回同一对象；条目变了必须重算', () => {
  makeHome()
  const input = (items, generation = 1) => ({
    profile: 'web', items, generation, installed: null, generatedAt: 'T', cached: false,
  })
  const first = marketplace.cachedMarketplace(input([marketplace.registryItem(registry.normalizeRegistryRepo(repo('a/one')))]))
  const again = marketplace.cachedMarketplace(input([marketplace.registryItem(registry.normalizeRegistryRepo(repo('a/one')))]))
  assert.equal(first, again, '相同内容命中缓存（同一个对象）')

  // 旧仓库的坑：时间戳/代际相同但条目不同 → 绝不许复用旧结果
  const different = marketplace.cachedMarketplace(input([marketplace.registryItem(registry.normalizeRegistryRepo(repo('b/two')))]))
  assert.notEqual(first, different)
  assert.deepEqual(different.items.map((entry) => entry.repo), ['b/two'])

  // 已安装索引的内容身份变化同样要重算
  const home = process.env.DSH_HOME
  seedProfile(home)
  marketplace.clearInstalledIndexCache()
  const installed = marketplace.buildInstalledIndex('web', { now: 0 })
  const withIndex = marketplace.cachedMarketplace({ ...input([marketplace.registryItem(registry.normalizeRegistryRepo(repo('bob/dsh-note')))]), installed })
  assert.equal(withIndex.items[0].installed, true)
  marketplace.clearMarketplaceCache()
  const afterClear = marketplace.cachedMarketplace(input([marketplace.registryItem(registry.normalizeRegistryRepo(repo('a/one')))]))
  assert.notEqual(afterClear, first)
})

// ── 视图：排序 8 组合 / 方向语义 / 筛选 / 工具栏 ────────────────────────

/** 一批有区分度的条目（星数、时间、分类、名称都各不相同）。 */
function sampleItems() {
  return [
    item({ repo: 'z/zulu', name: 'zulu', stars: 5, updatedAt: '2026-01-05T00:00:00Z', category: 'tool' }),
    item({ repo: 'a/alpha', name: 'alpha', stars: 10, updatedAt: '2026-01-01T00:00:00Z', category: 'memory' }),
    item({ repo: 'm/mike', name: 'mike', stars: null, updatedAt: null, category: undefined }),
    item({ repo: 'b/bravo', name: 'bravo', stars: 0, updatedAt: '2026-01-09T00:00:00Z', category: 'memory' }),
    item({ repo: 'c/charlie', name: 'charlie', stars: 10, updatedAt: '2026-01-03T00:00:00Z', category: 'tool' }),
  ]
}

/** 实测列表在主键上的方向（并列/全空时返回 'flat'）。 */
function measuredDirection(items, sort) {
  for (let index = 1; index < items.length; index += 1) {
    const primary = view.compareByMode(items[index - 1], items[index], sort)
    if (primary < 0) return 'asc'
    if (primary > 0) return 'desc'
  }
  return 'flat'
}

test('排序：8 个 (模式 × 方向) 组合都守恒、幂等、方向与按钮一致', () => {
  const items = sampleItems()
  for (const sort of view.SORT_MODES) {
    for (const descending of [false, true]) {
      const sorted = view.sortRows(items, sort, descending)
      const label = sort + '/' + (descending ? 'desc' : 'asc')
      // 守恒：不丢、不重、不改引用集合
      assert.equal(sorted.length, items.length, label)
      assert.deepEqual([...sorted].map((entry) => entry.repo).sort(), [...items].map((entry) => entry.repo).sort(), label)
      // 幂等 + 全序：再排一次结果逐位相同
      assert.deepEqual(view.sortRows(sorted, sort, descending).map((entry) => entry.repo), sorted.map((entry) => entry.repo), label)
      // 方向语义：按钮说的方向就是列表实际的方向（同一批数据、至少有一对可判）
      const direction = measuredDirection(sorted, sort)
      if (direction !== 'flat') assert.equal(direction, view.marketToolbarModel(sort, descending).direction, label)
      // 入参不被修改
      assert.deepEqual(items.map((entry) => entry.repo), sampleItems().map((entry) => entry.repo), label)
    }
  }
})

test('排序：方向真的翻转主键，tie-break 两个方向都保持升序', () => {
  const items = sampleItems()
  const key = (entry) => entry.stars ?? 0
  const asc = view.sortRows(items, 'stars', false).map(key)
  const desc = view.sortRows(items, 'stars', true).map(key)
  assert.deepEqual(desc, [...asc].reverse(), '主键序列完全镜像（tie-break 不参与翻转）')
  assert.deepEqual(asc, [0, 0, 5, 10, 10])
  assert.deepEqual(view.sortRows(items, 'az', false).map((entry) => entry.name), ['alpha', 'bravo', 'charlie', 'mike', 'zulu'])
  assert.deepEqual(view.sortRows(items, 'az', true).map((entry) => entry.name), ['zulu', 'mike', 'charlie', 'bravo', 'alpha'])
  // 星数并列（alpha / charlie 都是 10）时 tie-break 恒升序，方向翻转不改它
  assert.deepEqual(view.sortRows(items, 'stars', true).slice(0, 2).map((entry) => entry.name), ['alpha', 'charlie'])
})

test('排序：未知值（无星 / 无时间 / 无分类）不越位到首屏', () => {
  const items = sampleItems()
  // 默认方向（降序，最热的在最前）：未知星数必须落在末尾
  const byStars = view.sortRows(items, 'stars', view.defaultDescendingFor('stars'))
  assert.deepEqual(byStars.map((entry) => entry.stars), [10, 10, 5, 0, null])
  // 默认降序（最新在最前）：无时间戳的落在末尾
  const byUpdated = view.sortRows(items, 'updated', view.defaultDescendingFor('updated'))
  assert.deepEqual(byUpdated.map((entry) => entry.updatedAt).at(-1), null)
  // 默认升序（A→Z）：无分类的落在末尾（默认视图里未知值永远在最后）
  const byCategory = view.sortRows(items, 'category', view.defaultDescendingFor('category'))
  assert.equal(byCategory.at(-1).category, undefined)
  assert.deepEqual(byCategory.map((entry) => entry.category ?? '-'), ['memory', 'memory', 'tool', 'tool', '-'])
})

test('排序：已安装是优先级，8 个组合、两个方向都恒在最前', () => {
  const items = [...sampleItems().slice(1), item({ repo: 'i/installed', name: 'installed', stars: 0, updatedAt: '1999-01-01T00:00:00Z', category: 'zzz', installed: true })]
  for (const sort of view.SORT_MODES) {
    for (const descending of [false, true]) {
      const sorted = view.sortRows(items, sort, descending)
      assert.equal(sorted[0].repo, 'i/installed', sort + '/' + (descending ? 'desc' : 'asc'))
      assert.equal(sorted.slice(1).some((entry) => entry.installed === true), false)
    }
  }
})

test('category 模式与筛选、选项顺序', () => {
  const items = sampleItems()
  const counts = tags.categoryCounts(items)
  assert.deepEqual(counts, { tool: 2, memory: 2 })
  assert.deepEqual(view.categoryOptions({ ...counts, other: 9 }).map((entry) => entry.id), ['memory', 'tool', 'other'])
  assert.deepEqual(view.categoryOptions({ tool: 1, memory: 1 }).map((entry) => entry.id), ['memory', 'tool'], '计数并列按 id 升序')

  assert.equal(view.filterByCategory(items, view.ALL_CATEGORIES), items, '不筛时原样返回')
  assert.deepEqual(view.filterByCategory(items, 'memory').map((entry) => entry.repo), ['a/alpha', 'b/bravo'])
  assert.deepEqual(view.filterByCategory(items, ' tool ').map((entry) => entry.repo), ['z/zulu', 'c/charlie'])
  // 上游带空格的分类值也必须能被自己的分类找到；无分类的条目不被混进任何桶
  const spaced = [item({ repo: 's/s', name: 's', category: ' memory ' }), item({ repo: 'n/n', name: 'n' })]
  assert.deepEqual(view.filterByCategory(spaced, 'memory').map((entry) => entry.repo), ['s/s'])
})

test('工具栏模型：方向键位与比较器同源', () => {
  for (const sort of view.SORT_MODES) {
    for (const descending of [false, true]) {
      const model = view.marketToolbarModel(sort, descending, 'tool')
      assert.equal(model.direction, descending ? 'desc' : 'asc')
      assert.equal(model.directionLabelKey, descending ? 'sortDesc' : 'sortAsc')
      assert.equal(model.category, 'tool')
      assert.equal(model.descending, descending)
      assert.deepEqual(model.sortOptions, view.SORT_MODES)
    }
  }
  assert.equal(view.marketToolbarModel('az', false).sortLabelKey, 'sortAz')
  assert.equal(view.marketToolbarModel('updated', false).sortLabelKey, 'sortUpdated')
  assert.equal(view.marketToolbarModel('category', false).sortLabelKey, 'sortCategory')
  assert.equal(view.marketToolbarModel('stars', true).sortLabelKey, 'sortStars')
  assert.equal(view.marketToolbarModel('stars', true).category, view.ALL_CATEGORIES)
})

test('updateAvailable 与徽标槽位（政策后的卡片契约）', () => {
  assert.equal(view.updateAvailable(item({ installed: true, installedVersion: '1.0.0', latestVersion: '1.1.0' })), true)
  assert.equal(view.updateAvailable(item({ installed: true, installedVersion: '1.1.0', latestVersion: '1.1.0' })), false)
  assert.equal(view.updateAvailable(item({ installed: true, installedVersion: '2.0.0', latestVersion: '1.1.0' })), false, '仓库回滚不报更新')
  assert.equal(view.updateAvailable(item({ installed: false, installedVersion: '1.0.0', latestVersion: '1.1.0' })), false)
  assert.equal(view.updateAvailable(item({ installed: true, installedVersion: '1.0.0' })), false)

  // 卡片徽标：政策 ≤3 槽、优先级取前、跨来源去重（详见 tests/tags.test.mjs 的政策用例）
  assert.deepEqual(view.tagsOf(item({ category: 'tool', topics: ['memory'] })).map((tag) => tag.value), ['tool', 'memory'])
  assert.equal(view.tagsOf(item({ category: 'tool', riskTier: 'risk', installable: 'manual', topics: ['memory', 'rag'] })).length, 3, '最多 3 个')
  assert.deepEqual(
    view.tagsOf(item({ category: 'vision', topics: ['vision', 'ocr'] })).map((tag) => tag.value),
    ['vision', 'ocr'],
    '分类与主题同名时只留分类（那 499 条同名重复的实例）',
  )
  assert.equal(view.typeLabelKey('skill'), 'typeSkill')
  assert.equal(view.typeLabelKey('agent-preset'), 'typeAgentPreset')
  assert.equal(view.typeLabelKey(undefined), 'typeCordisPlugin')
  assert.equal(view.securityLabelKey('critical'), 'securityHigh')
  assert.equal(view.securityLabelKey('weird'), 'securityUnknown')
  assert.equal(view.statusLabelKey('✅ listed'), 'statusVerified')
  assert.equal(view.statusLabelKey('archived'), 'statusArchived')
  assert.equal(view.statusLabelKey('待测'), 'statusPending')
})

// ── plugin_search 的打分与版本比较 ──────────────────────────────────────

test('tokenize / scoreItem / findPluginMatches', () => {
  assert.deepEqual(match.tokenize('Memory (RAG) 记忆'), ['memory', 'rag', '记忆'])
  assert.deepEqual(match.tokenize('  !!  '), [])

  const entry = item({ repo: 'alice/dsh-note', name: 'dsh-note', description: 'keeps project memory', topics: ['memory', 'cli'] })
  assert.equal(match.scoreItem(entry, ['memory']), 2 + 1, '主题 + 描述各命中一次')
  assert.equal(match.scoreItem(entry, ['note']), 3)
  assert.equal(match.scoreItem(entry, ['cli']), 2, '短 token 走精确匹配')
  assert.equal(match.scoreItem(entry, ['cli-extra']), 0, '短 token 不做反向子串匹配')
  assert.equal(match.scoreItem(entry, ['missing']), 0)

  const items = [
    item({ repo: 'a/one', name: 'one', description: 'unrelated', stars: 100 }),
    item({ repo: 'b/memory', name: 'memory', description: '', stars: 1 }),
    item({ repo: 'c/three', name: 'three', description: 'memory helper', stars: 50 }),
  ]
  assert.deepEqual(match.findPluginMatches(items, 'memory', 10).map((entry) => entry.repo), ['b/memory', 'c/three'])
  assert.deepEqual(match.findPluginMatches(items, '', 2).map((entry) => entry.repo), ['a/one', 'c/three'], '空查询按星数取前 N')
  assert.deepEqual(match.findPluginMatches(items, 'memory', 0), [])
  // 星数并列时按名称升序，结果不依赖输入顺序
  const tied = [item({ repo: 'b/zzz', name: 'zzz', stars: 5 }), item({ repo: 'a/aaa', name: 'aaa', stars: 5 })]
  assert.deepEqual(match.findPluginMatches(tied, '', 5).map((entry) => entry.name), ['aaa', 'zzz'])
})

test('compareVersions：semver §11 语义 + 非法输入回退字符串比较', () => {
  const cases = [
    ['1.2.3', '1.2.3', 0],
    ['1.0', '1.0.0', 0],
    ['1', '1.0.0', 0],
    ['v1.2.3', '1.2.3', 0],
    ['1.2.3+build.7', '1.2.3', 0],
    ['1.2.3-rc.1', '1.2.3', -1],
    ['1.2.3-rc.10', '1.2.3-rc.9', 1],
    ['1.2.3-alpha', '1.2.3-alpha.1', -1],
    ['1.2.3-1', '1.2.3-alpha', -1, '数字标识符优先级低于字母数字'],
    ['1.2.4', '1.2.3', 1],
    ['2.0.0', '10.0.0', -1, '数值比较不是字典序'],
  ]
  for (const [left, right, expected, note] of cases) {
    assert.equal(match.compareVersions(left, right), expected, note ?? left + ' vs ' + right)
    assert.equal(match.compareVersions(right, left), expected === 0 ? 0 : -expected, '反对称：' + left + ' vs ' + right)
  }
  // 非法输入（前导零 pre / 空 pre）必须回退字符串比较，绝不当成合法版本
  const fallback = (left, right) => (left === right ? 0 : left < right ? -1 : 1)
  for (const [left, right] of [['1.0.0-01', '1.0.0-1'], ['1.0.0-', '1.0.0'], ['1.0.0-alpha..1', '1.0.0-alpha.1'], ['01.0.0', '1.0.0']]) {
    assert.equal(match.compareVersions(left, right), fallback(left, right), left + ' vs ' + right)
  }
  assert.equal(match.compareVersions('1.0.0-', '1.0.0'), 1, '旧实现这里是 0（把非法当合法）')
})

test('端到端接线：loadRegistryIndex → registryItem → buildInstalledIndex → cachedMarketplace（离线）', async () => {
  const home = makeHome()
  seedProfile(home)
  mkdirSync(join(home, 'skills', 'skill-pack'), { recursive: true })
  const now = Date.now()
  const generatedAt = new Date(now).toISOString()
  // 走链：首跳用新鲜 CDN（gz），其余全 404
  const fetcher = fakeFetcher({
    [SOURCES[1].url]: reply(indexPayload([
      repo('bob/dsh-note', { category: 'memory', version: '1.5.0' }),
      repo('alice/other', { category: 'tool' }),
      repo('who/skill-pack', { category: 'skill' }),
    ], generatedAt), { gzip: true }),
  })
  const index = await registry.loadRegistryIndex({ fetcher, now })
  assert.equal(index.source, 'network:jsdelivr-gz')

  const build = () => marketplace.cachedMarketplace({
    profile: 'web',
    items: index.repos.map(marketplace.registryItem),
    generation: index.generation,
    installed: marketplace.buildInstalledIndex('web', { now }),
    generatedAt: index.generatedAt,
    cached: index.cached,
  })
  const result = build()
  assert.deepEqual(result.categories, { memory: 1, tool: 1, skill: 1 })
  assert.equal(result.generatedAt, generatedAt)
  assert.equal(result.cached, false)
  const byRepo = Object.fromEntries(result.items.map((entry) => [entry.repo, entry]))
  assert.equal(byRepo['bob/dsh-note'].installed, true)
  assert.equal(byRepo['bob/dsh-note'].installedVersion, '1.4.0')
  assert.equal(byRepo['bob/dsh-note'].latestVersion, '1.5.0')
  assert.equal(view.updateAvailable(byRepo['bob/dsh-note']), true)
  assert.equal(byRepo['alice/other'].installed, false)
  assert.equal(byRepo['who/skill-pack'].installed, true)
  assert.equal(byRepo['who/skill-pack'].kind, 'skill')
  // 再次请求：同一份数据必须命中同一对象（REST 层的序列化缓存可以拿它当 key）
  assert.equal(build(), result)
})

test('政策筛选：非插件默认隐藏、状态筛选复用同一个可更新判据', () => {
  const items = [
    item({ repo: 'a/plain', name: 'plain' }),
    item({ repo: 'b/nonplugin', name: 'nonplugin', installable: 'non-plugin' }),
    item({ repo: 'c/manual', name: 'manual', installable: 'manual' }),
    item({ repo: 'd/installed', name: 'installed', installed: true, installedVersion: '1.0.0', latestVersion: '1.1.0' }),
    item({ repo: 'e/uptodate', name: 'uptodate', installed: true, installedVersion: '1.1.0', latestVersion: '1.1.0' }),
  ]
  // 非插件过滤：**只**隐藏 non-plugin；manual 与"上游没标记"都要留着（不替上游补结论）
  assert.deepEqual(view.filterInstallable(items, false).map((entry) => entry.repo), ['a/plain', 'c/manual', 'd/installed', 'e/uptodate'])
  assert.equal(view.filterInstallable(items, true), items, '打开开关时原样返回')
  // 状态筛选：可更新用与卡片徽标同一个判据（updateAvailable）
  assert.equal(view.filterByState(items, 'all'), items)
  assert.deepEqual(view.filterByState(items, 'installed').map((entry) => entry.repo), ['d/installed', 'e/uptodate'])
  assert.deepEqual(view.filterByState(items, 'updatable').map((entry) => entry.repo), ['d/installed'])
  assert.deepEqual([...view.STATE_FILTERS], ['all', 'installed', 'updatable'])
  // **分层**：host 不过滤，过滤只发生在展示层——所以上面这些条目在原始结果里都还在
  assert.equal(items.some((entry) => entry.repo === 'b/nonplugin'), true)
})

test('政策排序：热度用 stars_delta_7d，缺值时按 0 处理', () => {
  const items = [
    item({ repo: 'a/slow', name: 'slow', starsDelta7d: 5, stars: 9000 }),
    item({ repo: 'b/hot', name: 'hot', starsDelta7d: 400, stars: 10 }),
    item({ repo: 'c/unknown', name: 'unknown' }),
  ]
  assert.deepEqual(view.sortRows(items, 'trending', true).map((entry) => entry.repo), ['b/hot', 'a/slow', 'c/unknown'], '增量降序、缺值当 0 落末尾')
  assert.deepEqual(view.sortRows(items, 'trending', false).map((entry) => entry.repo), ['c/unknown', 'a/slow', 'b/hot'], '升序是同一主键取反')
  assert.equal(view.SORT_MODES.includes('trending'), true)
  assert.equal(view.defaultDescendingFor('trending'), true)
  assert.equal(view.sortLabelKey('trending'), 'sortTrending')
  // 星数排序不受影响（两个维度是两件事：新插件星少但可能在涨）
  assert.deepEqual(view.sortRows(items, 'stars', true).map((entry) => entry.repo), ['a/slow', 'b/hot', 'c/unknown'])
})

test('被测代码就是线上跑的代码：dist 产物存在，纯函数模块不碰 node 内置模块', () => {
  for (const name of ['rank', 'tags', 'match', 'marketView', 'marketplace', 'registry', 'net']) {
    const source = readFileSync(new URL('../dist/' + name + '.js', import.meta.url), 'utf8')
    assert.ok(source.length > 0, name + '.js 必须存在')
  }
  // 纯函数模块的 DOM-free 契约：不许 import fs/ctx/网络（它们要能在浏览器包里内联）
  for (const name of ['rank', 'tags', 'match', 'marketView']) {
    const source = readFileSync(new URL('../dist/' + name + '.js', import.meta.url), 'utf8')
    assert.equal(/from\s+["']node:/.test(source), false, name + ' 不许 import node 内置模块')
  }
})

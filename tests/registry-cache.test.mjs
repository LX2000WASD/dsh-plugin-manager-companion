/**
 * tests/registry-cache.test.mjs — 索引磁盘缓存的往返契约（task-69）。
 *
 * 被测对象是**构建产物** dist/registry.js（沿用"被验的代码就是线上跑的代码"）。
 *
 * 守护的缺陷：缓存文件里存的是**我们归一化后的记录形**（stars / updatedAt / riskTier …），
 * 早先的读侧却把它又交给了读上游字段名（stargazers_count / risk_tier …）的解析器，
 * 于是往返丢 11 项：stars→null、updatedAt、packageName、latestVersion、riskTier、riskFlags、
 * reportUrl、marketTags、starsDelta7d、verifiedBy、verifiedAt 全部消失。
 * 后果是**缓存命中的那次加载**（绝大多数页面加载）没有风险/精选/趋势徽标、没有 npm 名与版本、
 * 星数排序与「只看可更新」一起失效，而冷抓取正常——表现为"时好时坏"的静默降级。
 *
 * 本文件的三组断言：①全字段往返逐字段相等（那 11 项一个都不能少）；②缓存路径与冷抓取路径
 * 得到**同一份事实**；③形状/版本不对的缓存按"无缓存"处理并如实记账，绝不产出被削过的数据。
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const registry = await import('../dist/registry.js')

/** 本轮建过的临时 HOME，跑完统一删（测试不许往 /tmp 里堆垃圾）。 */
const homes = []
after(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
  homes.length = 0
})

/** 换一个临时 DSH_HOME 并清掉进程内镜像。 */
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'pmc-regcache-'))
  homes.push(home)
  process.env.DSH_HOME = home
  registry.resetRegistryMemory()
  return home
}

/** 一条模拟上游 registry.json 的记录（snake_case，字段名与真实抓取一致）。 */
function upstreamRecord(over = {}) {
  return {
    full_name: 'Tencent/BrowserSkill',
    name: 'BrowserSkill',
    description: 'browser automation',
    stargazers_count: 5404,
    updated_at: '2026-09-19T04:26:36Z',
    topics: ['agent', 'browser-use'],
    category: 'coding',
    pkg_name: 'browser-skill',
    version: '1.2.3',
    risk_tier: 'risk',
    risk_flags: [{ id: 'curl-pipe-shell', severity: 'medium', category: 'downloadExec' }],
    market_tags: ['community-pick'],
    stars_delta_7d: 321,
    installable: 'manual',
    archived: true,
    license: 'MIT',
    verdict: 'pass',
    verifiedBy: 'dsh-plugin-verify@0.1.2',
    verifiedAt: '2026-09-18',
    reportUrl: 'https://example.test/report',
    ...over,
  }
}

/** 上游载荷 → 归一化条目。 */
function normalize(raw) {
  const parsed = registry.parseRegistryPayload({ generated_at: '2026-09-19T00:04:47Z', repos: [raw] })
  assert.ok(parsed !== null, '上游载荷必须能解析')
  return parsed.repos[0]
}

/**
 * 夹具时钟：**测试不许依赖墙上时钟**。
 *
 * 为什么需要它（真缺陷，2026-09-20 暴露）：`isRegistryCacheFresh` 有两条判据——文件年龄（savedAt）
 * **与内容年龄（generatedAt）都要在 TTL 内**。早先这里硬编码了一个固定 `generatedAt`、又调
 * `loadRegistryIndex` 不注入 `now`（默认 Date.now()），于是夹具带了**时间炸弹**：
 * 写它的当天是绿的，跨过 24 小时 TTL 后**永久变红**——不是偶发，是必然。
 *
 * 现在把"当前时刻"钉在夹具常量上，与 `generatedAt` 保持固定间隔，永不过期。
 */
const FIXTURE_GENERATED_AT = '2026-09-19T00:04:47Z'
/** 夹具当前时刻：比 generatedAt 晚 1 分钟（稳在 TTL 内，且与真实时钟无关）。 */
const FIXTURE_NOW = Date.parse(FIXTURE_GENERATED_AT) + 60_000

/** 落盘一份缓存（用与生产相同的写入函数），返回读回结果。 */
function roundTrip(repos, generatedAt = FIXTURE_GENERATED_AT) {
  assert.equal(registry.writeRegistryCacheFile({ savedAt: FIXTURE_NOW, generatedAt, repos }), true, '落盘必须成功')
  return registry.readRegistryCacheFile()
}

test('往返：全字段条目逐字段相等（task-69 的 11 项一个都不能丢）', () => {
  makeHome()
  const first = normalize(upstreamRecord())
  const back = roundTrip([first])
  assert.ok(back !== null, '缓存必须能读回')
  assert.equal(back.repos.length, 1)
  // 逐字段（含 undefined 与 null 的区别）比对：差异清单必须为空
  const lost = Object.keys(first).filter((key) => JSON.stringify(first[key]) !== JSON.stringify(back.repos[0][key]))
  assert.deepEqual(lost, [], '往返不得丢任何字段：' + JSON.stringify(lost))
  // 那 11 项单独点名，防止将来有人把它们从记录形里删掉却"恰好"两边都缺
  for (const key of ['stars', 'updatedAt', 'packageName', 'latestVersion', 'riskTier', 'riskFlags', 'reportUrl', 'marketTags', 'starsDelta7d', 'verifiedBy', 'verifiedAt']) {
    assert.notEqual(first[key], undefined, key + ' 在上游解析后就该有值（否则这条断言没意义）')
    assert.deepEqual(back.repos[0][key], first[key], key + ' 必须在缓存往返后保持不变')
  }
  assert.equal(back.repos[0].stars, 5404, '星数不能变成 null（那会让星数排序整列塌掉）')
  assert.equal(back.repos[0].riskTier, 'risk')
  assert.deepEqual(back.repos[0].marketTags, ['community-pick'])
  assert.equal(back.skipped, 0, '整份缓存都可用时不该有丢弃计数')
})

test('往返：最小记录（只有基础字段）也能读回，且不凭空补字段', () => {
  makeHome()
  const minimal = normalize({ full_name: 'a/tiny', name: 'tiny', stargazers_count: 3, updated_at: '2026-09-01T00:00:00Z', topics: [] })
  const back = roundTrip([minimal])
  assert.ok(back !== null)
  assert.deepEqual(back.repos[0], minimal)
  assert.equal(back.repos[0].stars, 3)
  assert.equal('riskTier' in back.repos[0], false, '上游没给的字段不许在缓存里长出来')
  assert.equal(back.repos[0].starsDelta7d, undefined)
})

test('缓存路径与冷抓取路径给出同一份事实（这是缺陷的用户可见形态）', async () => {
  makeHome()
  const repo = normalize(upstreamRecord())
  roundTrip([repo])
  // 网络全失败 → 走"新鲜磁盘缓存"分支；结果里的条目必须与冷抓取逐字段一致
  const dead = async () => ({ ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0), text: async () => '' })
  const index = await registry.loadRegistryIndex({ fetcher: dead, now: FIXTURE_NOW })
  assert.equal(index.source, 'cache')
  assert.equal(index.cached, true)
  const item = index.repos[0]
  assert.equal(item.stars, 5404)
  assert.equal(item.updatedAt, '2026-09-19T04:26:36Z')
  assert.equal(item.packageName, 'browser-skill')
  assert.equal(item.latestVersion, '1.2.3')
  assert.equal(item.riskTier, 'risk')
  assert.deepEqual(item.marketTags, ['community-pick'])
  assert.equal(item.starsDelta7d, 321)
  assert.equal(item.verifiedBy, 'dsh-plugin-verify@0.1.2')
  // 冷抓取路径（这里用同一份上游载荷喂给解析器）不能有差别
  assert.deepEqual(item, repo)
})

test('格式版本不符的缓存按「无缓存」处理（旧文件不许被读成被削过的数据）', async () => {
  const home = makeHome()
  const path = registry.registryCachePath()
  mkdirSync(dirname(path), { recursive: true })
  // 模拟旧格式：没有 formatVersion（或版本更老），记录形仍是我们的记录形
  writeFileSync(path, JSON.stringify({
    savedAt: FIXTURE_NOW,
    generatedAt: FIXTURE_GENERATED_AT,
    repos: [normalize(upstreamRecord())],
  }) + '\n')
  assert.equal(registry.readRegistryCacheFile(), null, '缺 formatVersion 一律视为无缓存')
  writeFileSync(path, JSON.stringify({
    formatVersion: 1,
    savedAt: FIXTURE_NOW,
    generatedAt: FIXTURE_GENERATED_AT,
    repos: [normalize(upstreamRecord())],
  }) + '\n')
  assert.equal(registry.readRegistryCacheFile(), null, '旧版本号同样视为无缓存')
  // 于是整条链会去重新抓取，而不是端出一份缺字段的索引
  const dead = async () => ({ ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0), text: async () => '' })
  const index = await registry.loadRegistryIndex({ fetcher: dead, now: FIXTURE_NOW })
  assert.equal(index.source, 'empty', '没有可用缓存时如实说"空了"，不能假装有缓存')
  assert.equal(home.length > 0, true)
})

test('形状不符的记录被丢弃并计数（不静默产出缺字段结果）', () => {
  makeHome()
  const good = normalize(upstreamRecord())
  const back = roundTrip([
    good,
    null,                                   // 非对象
    { name: 'no-repo' },                    // 缺 repo
    { repo: 'no-slash' },                   // repo 形态不对
    { repo: 'b/other', stars: 'huge' },     // 星数类型不对 → stars 归一为 null 但记录仍可用
  ])
  assert.ok(back !== null)
  assert.deepEqual(back.repos.map((entry) => entry.repo), ['Tencent/BrowserSkill', 'b/other'])
  assert.equal(back.skipped, 3, '三条不可用记录要如实计数')
  assert.equal(back.repos[1].stars, null, '类型不对的星数归一为 null，而不是带着字符串往下走')
  // 全部不可用 → 视为没有缓存（loadRegistryIndex 会去重新抓取）
  const empty = roundTrip([null, { repo: 'x' }])
  assert.equal(empty, null)
})

test('缓存读取按 repo 去重（与上游载荷同一条语义）', () => {
  makeHome()
  const repo = normalize(upstreamRecord())
  const back = roundTrip([repo, { ...repo, repo: 'tencent/browserskill', stars: 1 }])
  assert.ok(back !== null)
  assert.equal(back.repos.length, 1, '大小写不同视为同一条')
  assert.equal(back.repos[0].stars, 5404, '保留先出现的那条')
})

test('被丢弃的记录在加载结果里如实记账（notes）', async () => {
  makeHome()
  const repo = normalize(upstreamRecord())
  roundTrip([repo, { repo: 'bad-entry' }])
  const dead = async () => ({ ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0), text: async () => '' })
  const index = await registry.loadRegistryIndex({ fetcher: dead, now: FIXTURE_NOW })
  assert.equal(index.source, 'cache')
  assert.ok(index.notes.some((note) => note.includes('形状不符')), '丢弃必须出现在 notes 里：' + JSON.stringify(index.notes))
})

test('落盘文件里带 formatVersion（读侧据此判断记录形）', () => {
  makeHome()
  roundTrip([normalize(upstreamRecord())])
  const raw = JSON.parse(readFileSync(registry.registryCachePath(), 'utf8'))
  assert.equal(raw.formatVersion, registry.REGISTRY_CACHE_FORMAT)
  assert.equal(Array.isArray(raw.repos), true)
  assert.equal(typeof raw.savedAt, 'number')
})

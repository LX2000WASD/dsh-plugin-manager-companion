/**
 * 升级引擎（task-73）的验收测试（node --test，跑 dist 产物）。
 *
 * 被验的是"升级这件事的边界"：三类单元分开、四态不许混、查不到绝不写成"已是最新"、
 * 金丝雀没通过（含"没验证"）绝不动真环境、回滚按盘上事实核对。
 * 网络与 pnpm 全部注入替身：这一层不该真的出网，也不该真的装包（真机证据在任务报告里）。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'pmc-upgrade-test-'))
process.env.DSH_HOME = HOME
const PROFILES = join(HOME, 'profiles')

const up = await import('../dist/upgrade.js')
const settings = await import('../dist/settings.js')
const index = await import('../dist/index.js')
const paths = await import('../dist/paths.js')
// 真试装引擎（激活守卫那条测试要它；其余测试一律用替身，不出网、不起进程）。
const env = await import('../dist/envManager.js')

/** 造一个环境：bundles + dependencies（带 spec）+ 已装版本。 */
function makeEnv(name, { bundles = [], dependencies = {}, installed = {} } = {}) {
  const dir = join(PROFILES, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-' + name,
    private: true,
    dependencies,
    dsh: { profile: { bundles } },
  }, undefined, 2) + String.fromCharCode(10))
  for (const [pkg, version] of Object.entries(installed)) {
    const pkgDir = join(dir, 'node_modules', pkg)
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: pkg, version }) + String.fromCharCode(10))
  }
  return dir
}

/** 一个假的 registry 响应。 */
function jsonResponse(status, payload) {
  return { ok: status >= 200 && status < 300, status, async arrayBuffer() { return new ArrayBuffer(0) }, async text() { return JSON.stringify(payload) } }
}

/** 记录调用的 fetcher 替身。 */
function makeFetcher(reply) {
  const calls = []
  return {
    calls,
    fetch: async (url) => {
      calls.push(url)
      return reply(url, calls.length)
    },
  }
}

/** 官方运行器替身：按调用改盘（模拟 add 的效果）。 */
function makeRunner(config) {
  const calls = []
  return {
    calls,
    run: async (context, args, options) => {
      calls.push({ profile: context.profile, dir: context.dir, installAnchor: context.installAnchor, args: [...args], execution: options?.execution })
      const outcome = config?.(args, calls.length) ?? {}
      if (outcome.version !== undefined) {
        const pkgDir = join(context.dir, 'node_modules', outcome.name ?? 'pkg')
        mkdirSync(pkgDir, { recursive: true })
        writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: outcome.name ?? 'pkg', version: outcome.version }) + String.fromCharCode(10))
      }
      return { exitCode: outcome.exitCode ?? 0, output: outcome.output ?? 'ok', truncated: false, logPath: '/dev/null' }
    },
  }
}

/** 试装执行器替身：按给定结论回一份形状完整的 TrialInstallResult。 */
function makeTrial(conclusion, overrides = {}) {
  const calls = []
  return {
    calls,
    run: async (spec, realName, options) => {
      calls.push({ spec, realName, options })
      return {
        conclusion,
        output: '金丝雀（替身）：' + conclusion,
        build: { artifactMd5: null, artifactMtime: null, gitHead: null },
        sourceFingerprint: { manifestHash: null, lockfileHash: null, patchHash: null, bundles: [], bundlesSource: 'manifest', dependencies: [], hash: 'x' },
        sourceFingerprintAfter: null,
        changedDuringTrial: false,
        baseline: { kind: 'mounted' },
        candidate: { kind: conclusion === 'candidate-broken' ? 'failed' : 'mounted' },
        elapsedMs: 12,
        depth: 'shallow',
        escalated: false,
        ...overrides,
      }
    },
  }
}

function configWith(overrides = {}) {
  return {
    ...settings.DEFAULT_CONFIG,
    ...overrides,
  }
}

after(() => { rmSync(HOME, { recursive: true, force: true }) })

// ── ① 三类单元 ────────────────────────────────────────────────────────────

test('三类单元分开：profile 依赖可升 / 安装方提供的层只检测+命令 / 本插件自身是 self', () => {
  makeEnv('three', {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-plugin-manager-companion', 'probe-plugin'],
    dependencies: {
      'dsh-plugin-manager-companion': 'link:' + join(HOME, 'repo'),
      'probe-plugin': '^1.2.3',
    },
    installed: {
      'dsh-plugin-manager-companion': '0.1.0',
      'probe-plugin': '1.2.0',
    },
  })
  const facts = up.unitFacts('three')
  const byName = new Map(facts.map((fact) => [fact.name, fact]))
  assert.equal(byName.get('probe-plugin').kind, 'profile-dependency')
  assert.equal(byName.get('probe-plugin').spec, '^1.2.3')
  assert.equal(byName.get('probe-plugin').currentVersion, '1.2.0')
  assert.equal(byName.get('probe-plugin').specIsLocal, false)
  assert.equal(byName.get('dsh-plugin-manager-companion').kind, 'self', '本插件自身是第三类')
  assert.equal(byName.get('dsh-plugin-manager-companion').specIsLocal, true, 'link: 是本地来源（升级会改来源）')
  assert.equal(byName.get('@deepseek-ai/dsh-base').kind, 'installation-provided', '只在 bundles 里 = 安装方提供')
  assert.equal(byName.get('@deepseek-ai/dsh-base').spec, undefined)
  assert.equal(byName.get('@deepseek-ai/dsh-base').currentVersion, null, '读不到版本就如实 null，不猜')
  // 命令只给第三类；且明确不给 dsh plugin add / dshpmc update（那会把这一层变成 profile 依赖）
  const command = up.installationUpgradeCommand('@deepseek-ai/dsh-base')
  assert.match(command, /由安装方提供/)
  assert.match(command, /取决于当初的安装方式/)
  assert.doesNotMatch(command, /dsh plugin add|dshpmc update/)
  assert.throws(() => up.unitFacts('..'), (error) => error.code === 'invalid-name')
  assert.throws(() => up.unitFacts('ghost-env'), (error) => error.code === 'not-found')
})

// ── ② dist-tags：全列 + 同线优先 + 切线可辨 ────────────────────────────────

test('dist-tags 全列：同线最新默认高亮，别的线标出来（切线要能明说）', () => {
  const tags = { latest: '0.2.0', next: '0.3.0-rc.1', alpha: '0.1.6-alpha.9', legacy: '0.1.5' }
  const reports = up.tagReports(tags, '0.1.6-alpha.2')
  assert.deepEqual(reports.map((item) => item.tag).sort(), ['alpha', 'latest', 'legacy', 'next'])
  const alpha = reports.find((item) => item.tag === 'alpha')
  assert.equal(alpha.line, 'same-line', '0.1.6-alpha.9 与当前同线')
  assert.equal(alpha.preferred, true, '同线最新要高亮')
  assert.equal(reports.find((item) => item.tag === 'latest').line, 'other-line')
  const target = up.pickTarget(tags, '0.1.6-alpha.2')
  assert.equal(target.version, '0.1.6-alpha.9', '默认目标是同线最新，不是 latest')
  assert.equal(target.tag, 'alpha')
  // 同线没有候选时退到 latest（此时 targetLine ≠ currentLine，界面据此提示"会切到 X 线"）
  const other = up.pickTarget({ latest: '0.2.0' }, '0.1.6-alpha.2')
  assert.equal(other.version, '0.2.0')
  assert.notEqual(up.versionLine(other.version), up.versionLine('0.1.6-alpha.2'))
  // 当前版本未知：不假装知道线
  assert.equal(up.pickTarget(tags, null).tag, 'latest')
  assert.deepEqual(up.tagReports(tags, null).map((item) => item.line), ['unknown', 'unknown', 'unknown', 'unknown'])
})

test('registry 文档 URL 与 dist-tags 解析：scoped 名整体转义；缺 dist-tags 不猜', () => {
  assert.equal(up.registryDocumentUrl('', '@deepseek-ai/dsh-base'), 'https://registry.npmjs.org/%40deepseek-ai%2Fdsh-base')
  assert.equal(up.registryDocumentUrl('https://mirror.example/npm/', 'lodash'), 'https://mirror.example/npm/lodash')
  assert.deepEqual(up.parseDistTags({ 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} } }), { latest: '1.0.0' })
  assert.equal(up.parseDistTags({ versions: { '1.0.0': {}, '9.9.9': {} } }), null, '没有 dist-tags 就说没有，不拿 versions 里最大的冒充')
  assert.equal(up.parseDistTags({ 'dist-tags': {} }), null)
})

// ── ③④ 查不到 / 绝不显示"已是最新" ─────────────────────────────────────────

test('查不到就是查不到：404 与网络错误都不许写成"已是最新"', async () => {
  makeEnv('lookup', { bundles: ['probe-plugin'], dependencies: { 'probe-plugin': '^1.0.0' }, installed: { 'probe-plugin': '1.0.0' } })
  const missing = makeFetcher(() => jsonResponse(404, { error: 'Not found' }))
  const answer = await up.fetchDistTags('probe-plugin', { fetch: missing.fetch })
  assert.equal(answer.ok, false)
  assert.match(answer.reason, /404/)

  const broken = makeFetcher(() => { throw new Error('getaddrinfo ENOTFOUND registry.example') })
  const check = await up.checkUpgrades({
    environment: 'lookup', config: configWith(), refresh: true, fetch: broken.fetch, repos: [],
  })
  const unit = check.units.find((item) => item.name === 'probe-plugin')
  assert.equal(unit.state, 'unknown', '拿不到事实 = 查不到')
  assert.equal(unit.targetVersion, null)
  assert.doesNotMatch(JSON.stringify(unit), /最新/, '查不到时不许出现"最新"这种断言')
  assert.match(unit.reason, /registry 查询失败/)
  assert.equal(check.checked, true)
})

test('有事实才算四态：同线更新 = 可升级；同线不更新 = 已是最新（带依据）', async () => {
  makeEnv('states', { bundles: ['probe-plugin'], dependencies: { 'probe-plugin': '^1.0.0' }, installed: { 'probe-plugin': '1.2.0' } })
  const newer = makeFetcher(() => jsonResponse(200, { 'dist-tags': { latest: '1.3.0' } }))
  const check = await up.checkUpgrades({ environment: 'states', config: configWith(), refresh: true, fetch: newer.fetch, repos: [] })
  const unit = check.units.find((item) => item.name === 'probe-plugin')
  assert.equal(unit.state, 'update-available')
  assert.equal(unit.targetVersion, '1.3.0')
  assert.equal(unit.source, 'registry')
  assert.equal(unit.tags.length, 1)

  const same = makeFetcher(() => jsonResponse(200, { 'dist-tags': { latest: '1.2.0' } }))
  const again = await up.checkUpgrades({ environment: 'states', config: configWith(), refresh: true, fetch: same.fetch, repos: [] })
  const settled = again.units.find((item) => item.name === 'probe-plugin')
  assert.equal(settled.state, 'up-to-date')
  assert.match(settled.reason, /1.2.0/, '已是最新必须带依据（是哪个版本）')
})

test('安装方提供的层：不可升级（不查、不猜、只给命令）', async () => {
  makeEnv('runtime', { bundles: ['@deepseek-ai/dsh-base'] })
  const fetcher = makeFetcher(() => jsonResponse(200, { 'dist-tags': { latest: '9.9.9' } }))
  const check = await up.checkUpgrades({ environment: 'runtime', config: configWith(), refresh: true, fetch: fetcher.fetch, repos: [] })
  const unit = check.units.find((item) => item.name === '@deepseek-ai/dsh-base')
  assert.equal(unit.state, 'not-upgradable')
  assert.equal(unit.targetVersion, null)
  assert.match(unit.command, /由安装方提供/)
  assert.equal(fetcher.calls.length, 0, '不可升级的层不必出网')
})

test('市场索引优先（零网络）：有关键事实就不查 registry，且标出来源与时间', async () => {
  makeEnv('indexed', { bundles: ['community-plugin'], dependencies: { 'community-plugin': '^1.0.0' }, installed: { 'community-plugin': '1.0.0' } })
  const fetcher = makeFetcher(() => jsonResponse(200, { 'dist-tags': { latest: '9.9.9' } }))
  const check = await up.checkUpgrades({
    environment: 'indexed', config: configWith(), fetch: fetcher.fetch,
    repos: [{ repo: 'u/community-plugin', name: 'community-plugin', description: '', stars: 1, updatedAt: null, topics: [], packageName: 'community-plugin', latestVersion: '1.1.0', kind: 'cordis-plugin' }],
  })
  const unit = check.units.find((item) => item.name === 'community-plugin')
  assert.equal(unit.source, 'market-index')
  assert.equal(unit.state, 'update-available')
  assert.equal(unit.targetVersion, '1.1.0')
  assert.equal(unit.tags, null, '市场索引没有 dist-tags：界面因此不给"挑版本"')
  assert.equal(fetcher.calls.length, 0, '有市场索引事实就不该出网')
})

// ── ⑤ 缓存：TTL / 负缓存 / 升级后单包失效 ─────────────────────────────────

test('检查缓存：TTL 内用缓存不出网；失败进负缓存（1 小时内不自动重试）；手动永远可用', async () => {
  makeEnv('cached', { bundles: ['probe-plugin'], dependencies: { 'probe-plugin': '^1.0.0' }, installed: { 'probe-plugin': '1.0.0' } })
  const first = makeFetcher(() => jsonResponse(200, { 'dist-tags': { latest: '1.1.0' } }))
  const auto = await up.checkUpgrades({ environment: 'cached', config: configWith(), fetch: first.fetch, repos: [] })
  assert.equal(auto.checked, true, '首次自动检查（没有缓存）应当出网')
  assert.equal(first.calls.length, 1)

  // 紧接着的第二次进入：间隔是"每天"，不该再出网，但仍拿得到状态（这就是"进页面不卡"）
  const second = makeFetcher(() => { throw new Error('不该被调用') })
  const again = await up.checkUpgrades({ environment: 'cached', config: configWith(), fetch: second.fetch, repos: [] })
  assert.equal(again.checked, false)
  assert.equal(second.calls.length, 0)
  assert.equal(again.units.find((item) => item.name === 'probe-plugin').state, 'update-available')

  // 失败 → 负缓存：1 小时内自动不重试；手动（refresh）照打
  makeEnv('failing', { bundles: ['probe-plugin'], dependencies: { 'probe-plugin': '^1.0.0' }, installed: { 'probe-plugin': '1.0.0' } })
  const boom = makeFetcher(() => { throw new Error('offline') })
  await up.checkUpgrades({ environment: 'failing', config: configWith(), fetch: boom.fetch, repos: [] })
  const blocked = makeFetcher(() => jsonResponse(200, { 'dist-tags': { latest: '1.1.0' } }))
  const auto2 = await up.checkUpgrades({ environment: 'failing', config: configWith(), fetch: blocked.fetch, repos: [] })
  assert.equal(blocked.calls.length, 0, '失败后 1 小时内不自动重试')
  assert.equal(auto2.units.find((item) => item.name === 'probe-plugin').state, 'unknown')
  const manual = await up.checkUpgrades({ environment: 'failing', config: configWith(), refresh: true, fetch: blocked.fetch, repos: [] })
  assert.equal(blocked.calls.length, 1, '手动按钮不受负缓存限制')
  assert.equal(manual.units.find((item) => item.name === 'probe-plugin').state, 'update-available')

  // 间隔 = 仅手动：自动检查不再出网
  makeEnv('manualonly', { bundles: ['probe-plugin'], dependencies: { 'probe-plugin': '^1.0.0' }, installed: { 'probe-plugin': '1.0.0' } })
  const never = makeFetcher(() => jsonResponse(200, { 'dist-tags': { latest: '1.1.0' } }))
  const manualOnly = await up.checkUpgrades({
    environment: 'manualonly', config: configWith({ upgrade: { autoCheck: true, interval: 'manual', registryUrl: '' } }), fetch: never.fetch, repos: [],
  })
  assert.equal(never.calls.length, 0)
  assert.equal(manualOnly.units.find((item) => item.name === 'probe-plugin').state, 'unknown')
  assert.match(manualOnly.units.find((item) => item.name === 'probe-plugin').reason, /仅手动/)

  // 负缓存必须**会过期**：1 小时之后自动检查要恢复（否则用户永远卡在"查不到"，
  // 只有手动按钮能救——那与"失败 1 小时内不自动重试"是两件事）。
  // 用一个干净环境单独验，免得借上面那些已经成功的调用。
  makeEnv('expiry', { bundles: ['probe-plugin'], dependencies: { 'probe-plugin': '^1.0.0' }, installed: { 'probe-plugin': '1.0.0' } })
  const t0 = Date.now()
  const offline = makeFetcher(() => { throw new Error('offline') })
  await up.checkUpgrades({ environment: 'expiry', config: configWith(), fetch: offline.fetch, repos: [], now: () => t0 })
  const withinHour = await up.checkUpgrades({
    environment: 'expiry', config: configWith(), fetch: offline.fetch, repos: [], now: () => t0 + 30 * 60 * 1000,
  })
  assert.equal(offline.calls.length, 1, '半小时内不自动重试')
  assert.equal(withinHour.units.find((item) => item.name === 'probe-plugin').state, 'unknown')
  assert.match(withinHour.units.find((item) => item.name === 'probe-plugin').reason, /offline/,
    '原因要如实带出上次的失败原文')
  assert.match(withinHour.units.find((item) => item.name === 'probe-plugin').reason, /不到 1 小时/,
    '并说清"暂时不会自动重试"（否则用户以为它坏了）')
  const recovered = makeFetcher(() => jsonResponse(200, { 'dist-tags': { latest: '1.1.0' } }))
  const afterHour = await up.checkUpgrades({
    environment: 'expiry', config: configWith(), fetch: recovered.fetch, repos: [], now: () => t0 + up.NEGATIVE_TTL_MS + 1,
  })
  assert.equal(recovered.calls.length, 1, '过了静默期自动检查必须恢复（负缓存会过期）')
  assert.equal(afterHour.units.find((item) => item.name === 'probe-plugin').state, 'update-available')

  // 单包失效：升级成功后那个包的缓存必须消失（下次重新取）
  const cachePath = up.tagsCachePath()
  const before = JSON.parse(readFileSync(cachePath, 'utf8'))
  assert.notEqual(before.packages['probe-plugin'], undefined)
  up.invalidateTagsCache('probe-plugin')
  const afterInvalidate = JSON.parse(readFileSync(cachePath, 'utf8'))
  assert.equal(afterInvalidate.packages['probe-plugin'], undefined, '失效后不留旧事实')
})

// ── ⑥ 金丝雀：不通过（含"没验证"）绝不动真环境 ────────────────────────────

// 注意：这条（以及下面那条"候选坏/没验证"）测的是**金丝雀真的跑了**的路径，因此必须
// 显式把试装总开关打开——试装默认**关**（DESIGN §5.3：它会在用户机器上真实装包并执行对方
// 代码），"关掉时如实说未验证"由后面那条专门的测试守。之前这里用的是 configWith() 默认值
// （enabled:false），于是同一个配置值在两条测试里被要求出两种相反的行为——那是测试自己的矛盾。
const CANARY_ON = { ...settings.DEFAULT_TRIAL_CONFIG, enabled: true }

test('金丝雀通过才升级：官方 add <name>@<version>，测试环境用完即删并记账', async () => {
  const dir = makeEnv('canary-ok', { bundles: ['probe-plugin'], dependencies: { 'probe-plugin': '^1.0.0' }, installed: { 'probe-plugin': '1.0.0' } })
  makeEnv('canary-ok-dpmc')  // 金丝雀会用到这个测试环境；用完必须删掉
  const trial = makeTrial('passed')
  const runner = makeRunner(() => ({ name: 'probe-plugin', version: '1.1.0' }))
  const logs = []
  const result = await up.upgradePackage({
    environment: 'canary-ok', name: 'probe-plugin', version: '1.1.0',
    config: configWith({ trial: CANARY_ON }),
    installAnchor: '/anchor/package.json', trial: trial.run, runCommand: runner.run, log: (line) => logs.push(line),
  })
  assert.equal(result.ok, true, result.output)
  assert.equal(result.fromVersion, '1.0.0')
  assert.equal(result.toVersion, '1.1.0')
  assert.equal(result.canary.ran, true)
  assert.equal(result.canary.conclusion, 'passed')
  assert.deepEqual(runner.calls.map((call) => call.args), [['add', 'probe-plugin@1.1.0']])
  assert.equal(runner.calls[0].execution, 'service')
  assert.equal(trial.calls[0].spec, 'probe-plugin@1.1.0', '金丝雀装的就是待升级的那个 spec')
  assert.equal(result.restartRequired, true)
  assert.match(result.output, /下次启动/)
  assert.equal(existsSync(join(PROFILES, 'canary-ok-dpmc')), false, '测试环境用完即删（一次性资产，不留 14 天）')
  assert.match(logs.join('\n'), /removed canary-ok-dpmc/)
  assert.match(readFileSync(up.canaryLogPath(), 'utf8'), /removed canary-ok-dpmc/)
  // 盘上事实：before/after 都要给
  assert.ok(result.diskFacts.some((line) => /版本 1\.1\.0/.test(line)))
  assert.equal(readFileSync(join(dir, 'node_modules', 'probe-plugin', 'package.json'), 'utf8').includes('1.1.0'), true)
})

test('金丝雀候选坏 / 没验证：一律不升级，且说清是哪种（"没验证"不是"通过"）', async () => {
  for (const [conclusion, expected] of [['candidate-broken', /金丝雀没通过/], ['cannot-trial', /没能验证/], ['baseline-broken', /没做出判断/]]) {
    makeEnv('canary-' + conclusion, { bundles: ['probe-plugin'], dependencies: { 'probe-plugin': '^1.0.0' }, installed: { 'probe-plugin': '1.0.0' } })
    makeEnv('canary-' + conclusion + '-dpmc')
    const trial = makeTrial(conclusion)
    const runner = makeRunner(() => ({ name: 'probe-plugin', version: '1.1.0' }))
    const result = await up.upgradePackage({
      environment: 'canary-' + conclusion, name: 'probe-plugin', version: '1.1.0',
      config: configWith({ trial: CANARY_ON }),
      installAnchor: '/anchor/package.json', trial: trial.run, runCommand: runner.run, log: () => {},
    })
    assert.equal(result.ok, false, conclusion + '：不许升级')
    assert.equal(result.code, 'canary-not-passed')
    assert.equal(runner.calls.length, 0, conclusion + '：不能碰真环境')
    assert.match(result.output, expected)
    assert.match(result.output, /没有在真实环境执行升级/)
    assert.equal(result.canary.conclusion, conclusion)
    assert.equal(existsSync(join(PROFILES, 'canary-' + conclusion + '-dpmc')), false, '失败路径也要清掉测试环境')
  }
  // 引擎自己抛异常 = 没能验证，同样不升级
  makeEnv('canary-throw', { bundles: ['probe-plugin'], dependencies: { 'probe-plugin': '^1.0.0' }, installed: { 'probe-plugin': '1.0.0' } })
  const thrown = await up.upgradePackage({
    environment: 'canary-throw', name: 'probe-plugin', version: '1.1.0',
    config: configWith({ trial: CANARY_ON }),
    installAnchor: '/anchor/package.json',
    trial: async () => { throw new Error('spawn 失败') },
    runCommand: makeRunner().run, log: () => {},
  })
  assert.equal(thrown.ok, false)
  assert.equal(thrown.canary.conclusion, 'cannot-trial')
  assert.match(thrown.canary.output, /spawn 失败/)
})

test('试装总开关关闭：不跑金丝雀，但必须如实说明"未验证就升级"', async () => {
  makeEnv('canary-off', { bundles: ['probe-plugin'], dependencies: { 'probe-plugin': '^1.0.0' }, installed: { 'probe-plugin': '1.0.0' } })
  const trial = makeTrial('candidate-broken')
  const runner = makeRunner(() => ({ name: 'probe-plugin', version: '1.1.0' }))
  const result = await up.upgradePackage({
    environment: 'canary-off', name: 'probe-plugin', version: '1.1.0',
    config: configWith({ trial: { ...settings.DEFAULT_TRIAL_CONFIG, enabled: false } }),
    installAnchor: '/anchor/package.json', trial: trial.run, runCommand: runner.run, log: () => {},
  })
  assert.equal(result.ok, true)
  assert.equal(result.canary.ran, false)
  assert.match(result.canary.skippedReason, /未做金丝雀/)
  assert.match(result.output, /未做/)
  assert.equal(trial.calls.length, 0)
  assert.equal(runner.calls.length, 1)
})

// ── ⑥b 金丝雀的激活守卫（task-80 的机制 + 本次的解法）────────────────────────

/**
 * 这条测的是**金丝雀真的能验证"升级"**这件事本身（不是替身给的结论）。
 *
 * 走的是**真试装引擎**（runTrialInstall），只有启动验证被注入成"永远挂载成功"：
 * 于是结论完全由"候选到底有没有进层栈"决定——这正是 task-80 守卫的判据。
 *
 * 两个方向都要有：
 *   · 候选已在测试环境 dependencies 里（**升级场景**）→ 不卸包就必然 cannot-trial（假通过被掐断）；
 *   · 同一条路走一次卸包（activationFor 做的）→ 候选成为"新装"，层栈里真的出现它 → passed。
 * 两者只差"有没有先 remove"，所以它同时证明了修复有效、且守卫没有被绕过。
 */
/**
 * 造一个模拟**官方 reconcile 语义**的官方运行器替身：
 *   · `remove` 把包从 dependencies 与 bundles 一起摘掉；
 *   · `add` 写进 dependencies，且**只有"新装"的包才进层栈**（既有依赖被跳过）。
 *
 * 这就是官方 lib/types/operations.js 里 reconcile 的真实行为，也是 task-84 的机制所在。
 */
function reconcileRunner(calls) {
  return async (context, args) => {
    calls.push([...args])
    const dir = context.dir
    const manifestPath = join(dir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const deps = manifest.dependencies ?? {}
    const bundles = manifest.dsh?.profile?.bundles ?? []
    if (args[0] === 'remove') {
      const name = args[1]
      delete deps[name]
      manifest.dependencies = deps
      manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: bundles.filter((n) => n !== name) } }
      writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + String.fromCharCode(10))
      return { exitCode: 0, output: 'removed', truncated: false, logPath: '/dev/null' }
    }
    const before = new Set(Object.keys(deps))
    deps['probe-plugin'] = '1.1.0'
    manifest.dependencies = deps
    if (!before.has('probe-plugin') && !bundles.includes('probe-plugin')) bundles.push('probe-plugin')
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } }
    writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + String.fromCharCode(10))
    const pkgDir = join(dir, 'node_modules', 'probe-plugin')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'probe-plugin', version: '1.1.0' }) + String.fromCharCode(10))
    return { exitCode: 0, output: 'added', truncated: false, logPath: '/dev/null' }
  }
}

test('试装引擎自己摘候选（task-84）：候选已在测试环境依赖里时先卸再装，才进层栈', async () => {
  const spec = 'probe-plugin@1.1.0'
  const mounted = async () => ({ verdict: { kind: 'mounted' }, elapsedMs: 1, stderr: '', exitCode: 0, build: {} })

  // 形态 A：候选已在测试环境 deps 里、但不在层栈（**gatedInstall 的顺序造成的原始形态**：
  // 候选先落进源环境 → 快照把它带进测试环境 → reconcile 跳过既有依赖）。
  // 引擎必须先把它摘掉，否则这次试装什么都没验证到。
  makeEnv('act-stale', { bundles: [], dependencies: { 'probe-plugin': '^1.0.0' }, installed: { 'probe-plugin': '1.0.0' } })
  const staleCalls = []
  const stale = await env.runTrialInstall(spec, 'act-stale', {
    installAnchor: '/anchor/package.json', runCommand: reconcileRunner(staleCalls), verify: mounted,
  })
  assert.deepEqual(staleCalls, [['remove', 'probe-plugin'], ['add', spec]], '必须先卸再装')
  assert.equal(stale.conclusion, 'passed', stale.output)
  assert.equal(stale.activation.activated, true, '摘过之后候选才真的进层栈')
  assert.equal(stale.activation.removedFirst, true)
  assert.match(stale.detached, /使候选成为"新装"/)
  assert.ok(stale.activation.bundles.includes('probe-plugin'), JSON.stringify(stale.activation.bundles))

  // 形态 B：候选既在 deps 也在层栈（**升级场景**：已装且已启用）。同一条路。
  makeEnv('act-live', { bundles: ['probe-plugin'], dependencies: { 'probe-plugin': '^1.0.0' }, installed: { 'probe-plugin': '1.0.0' } })
  const liveCalls = []
  const live = await env.runTrialInstall(spec, 'act-live', {
    installAnchor: '/anchor/package.json', runCommand: reconcileRunner(liveCalls), verify: mounted,
  })
  assert.deepEqual(liveCalls, [['remove', 'probe-plugin'], ['add', spec]], '升级场景同样要先卸再装')
  assert.equal(live.conclusion, 'passed', live.output)
  assert.equal(live.activation.activated, true)

  // 形态 C：候选本来就不在测试环境里（**全新安装**）→ 不该多发一次 remove（那会白跑一次 pnpm）。
  makeEnv('act-fresh', { bundles: [], dependencies: {} })
  const freshCalls = []
  const fresh = await env.runTrialInstall(spec, 'act-fresh', {
    installAnchor: '/anchor/package.json', runCommand: reconcileRunner(freshCalls), verify: mounted,
  })
  assert.deepEqual(freshCalls, [['add', spec]], '不在依赖里就不卸包')
  assert.equal(fresh.conclusion, 'passed', fresh.output)
  assert.equal(fresh.activation.removedFirst, false)
})

test('金丝雀验证升级：走真引擎，候选先卸再装才进层栈（否则官方 reconcile 跳过既有依赖 = 假通过）', async () => {
  const spec = 'probe-plugin@1.1.0'
  const mounted = async () => ({ verdict: { kind: 'mounted' }, elapsedMs: 1, stderr: '', exitCode: 0, build: {} })

  // 走升级引擎的金丝雀（真试装引擎 + 真官方通道替身）→ 候选成为新装 → 层栈里真的有它 → passed。
  makeEnv('act-live', { bundles: ['probe-plugin'], dependencies: { 'probe-plugin': '^1.0.0' }, installed: { 'probe-plugin': '1.0.0' } })
  makeEnv('act-live-dpmc', { bundles: ['probe-plugin'], dependencies: { 'probe-plugin': '^1.0.0' }, installed: { 'probe-plugin': '1.0.0' } })
  const liveCalls = []
  const canary = await up.runUpgradeCanary('act-live', spec, configWith({ trial: CANARY_ON }), {
    installAnchor: '/anchor/package.json',
    runCommand: reconcileRunner(liveCalls),
    // 注入"永远挂载成功"：这条测试验的是**层栈激活**，不是启动器（真启动另有真机证据）。
    verify: mounted,
    log: () => {},
  })
  assert.equal(canary.ran, true)
  assert.equal(canary.conclusion, 'passed', canary.output)
  assert.deepEqual(liveCalls, [['remove', 'probe-plugin'], ['add', spec]], '必须先卸再装')
  assert.equal(canary.activation.activated, true, '证据：候选真的进了层栈')
  assert.equal(canary.activation.removedFirst, true)
  assert.match(canary.activation.removeNote, /使候选成为"新装"/)
  assert.ok(canary.activation.bundles.includes('probe-plugin'), JSON.stringify(canary.activation.bundles))
  assert.equal(existsSync(join(PROFILES, 'act-live-dpmc')), false, '用完即删')
})

test('金丝雀自核验激活：替身说"通过"但层栈里没有候选 → 仍然算没验证（不信上游的 passed）', async () => {
  makeEnv('canary-liar', { bundles: [], dependencies: { 'probe-plugin': '^1.0.0' }, installed: { 'probe-plugin': '1.0.0' } })
  makeEnv('canary-liar-dpmc', { bundles: [], dependencies: { 'probe-plugin': '^1.0.0' }, installed: { 'probe-plugin': '1.0.0' } })
  // 替身**谎报** passed；同时 runCommand 老实做 add（不卸包 → 候选是既有依赖 → 进不了层栈）。
  const liar = {
    calls: [],
    run: async (spec, realName, options) => {
      liar.calls.push(spec)
      // 真的走一次注入的官方通道：它会 add，但层栈里不会出现候选。
      await options.runCommand(
        { profile: realName + '-dpmc', dir: join(PROFILES, realName + '-dpmc'), installAnchor: '/anchor/package.json', cwd: join(PROFILES, realName + '-dpmc') },
        ['add', spec], { execution: 'service', outputBytes: 1024, lockWaitMs: 1000 },
      )
      return makeTrial('passed').run(spec, realName, options)
    },
  }
  const result = await up.upgradePackage({
    environment: 'canary-liar', name: 'probe-plugin', version: '1.1.0',
    config: configWith({ trial: CANARY_ON }),
    installAnchor: '/anchor/package.json', trial: liar.run, runCommand: makeRunner().run, log: () => {},
  })
  assert.equal(result.ok, false, '层栈里没有候选就不许升级')
  assert.equal(result.code, 'canary-not-passed')
  assert.equal(result.canary.conclusion, 'cannot-trial', '替身说通过也不算：自核验说了算')
  assert.equal(result.canary.activation.activated, false)
  assert.match(result.output, /没能验证/)
})

test('负缓存是逐包逐环境的：一个包成功不放行另一个包的静默期', async () => {
  // A 包查成功、B 包查失败，落在**同一个环境**里：紧接着再进一次，B 不许被重试
  // （它自己的 1 小时静默期还没过），A 也不该再出网（TTL 内）。
  makeEnv('neg', {
    bundles: ['pkg-a', 'pkg-b'],
    dependencies: { 'pkg-a': '^1.0.0', 'pkg-b': '^1.0.0' },
    installed: { 'pkg-a': '1.0.0', 'pkg-b': '1.0.0' },
  })
  const first = makeFetcher((url) => url.includes('pkg-a')
    ? jsonResponse(200, { 'dist-tags': { latest: '1.1.0' } })
    : jsonResponse(500, { error: 'boom' }))
  const one = await up.checkUpgrades({ environment: 'neg', config: configWith(), fetch: first.fetch, repos: [] })
  assert.equal(first.calls.length, 2, '第一次两个包各查一次')
  assert.equal(one.units.find((u) => u.name === 'pkg-a').state, 'update-available')
  assert.equal(one.units.find((u) => u.name === 'pkg-b').state, 'unknown')

  // 第二次进入：a 有 TTL 内的成功条目，b 有自己的负缓存 → 两个都不该再出网。
  const second = makeFetcher(() => { throw new Error('不该被调用') })
  const two = await up.checkUpgrades({ environment: 'neg', config: configWith(), fetch: second.fetch, repos: [] })
  assert.equal(second.calls.length, 0, 'a 的成功不许把 b 的负缓存顶掉（逐包判定）')
  assert.equal(two.units.find((u) => u.name === 'pkg-a').state, 'update-available')
  assert.equal(two.units.find((u) => u.name === 'pkg-b').state, 'unknown')

  // 手动永远可用：两个包都会被重查。
  const manual = makeFetcher(() => jsonResponse(200, { 'dist-tags': { latest: '1.1.0' } }))
  const three = await up.checkUpgrades({ environment: 'neg', config: configWith(), refresh: true, fetch: manual.fetch, repos: [] })
  assert.equal(manual.calls.length, 2, '手动检查不受 TTL 与负缓存限制')
  assert.equal(three.units.find((u) => u.name === 'pkg-b').state, 'update-available')
})

test('记账按环境分开：A 环境查过不代表 B 环境查过（B 该出网还得出网）', async () => {
  const mk = (name) => makeEnv(name, { bundles: ['probe-plugin'], dependencies: { 'probe-plugin': '^1.0.0' }, installed: { 'probe-plugin': '1.0.0' } })
  mk('env-a')
  mk('env-b')
  const a = makeFetcher(() => jsonResponse(200, { 'dist-tags': { latest: '1.1.0' } }))
  await up.checkUpgrades({ environment: 'env-a', config: configWith(), fetch: a.fetch, repos: [] })
  assert.equal(a.calls.length, 1)
  // B 是另一个环境：它的账本是空的，所以必须出网（不许被 A 的时间戳按住）。
  const b = makeFetcher(() => jsonResponse(200, { 'dist-tags': { latest: '1.2.0' } }))
  const checkB = await up.checkUpgrades({ environment: 'env-b', config: configWith(), fetch: b.fetch, repos: [] })
  assert.equal(b.calls.length, 1, 'B 环境自己没查过，就该出网')
  assert.equal(checkB.checked, true)
  assert.equal(checkB.units.find((u) => u.name === 'probe-plugin').state, 'update-available')
})

test('升级失败如实报：官方退出码非零 / 盘上没到位，都不许说成功', async () => {
  makeEnv('fail-run', { bundles: ['probe-plugin'], dependencies: { 'probe-plugin': '^1.0.0' }, installed: { 'probe-plugin': '1.0.0' } })
  const runner = makeRunner(() => ({ exitCode: 1, output: 'ERR_PNPM_NETWORK', version: undefined }))
  const result = await up.upgradePackage({
    environment: 'fail-run', name: 'probe-plugin', version: '1.1.0',
    config: configWith({ trial: { ...settings.DEFAULT_TRIAL_CONFIG, enabled: false } }),
    installAnchor: '/anchor/package.json', runCommand: runner.run, log: () => {},
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'package-operation-failed')
  assert.match(result.output, /退出码 1/)
  assert.match(result.output, /盘上版本是 1\.0\.0/)
})

// ── ⑦ 回滚：按盘上事实核对 ────────────────────────────────────────────────

test('回滚：官方通道装回原版本；盘上核对干净才算成功；不干净就说"残留按它处理"', async () => {
  const dir = makeEnv('roll', { bundles: ['probe-plugin'], dependencies: { 'probe-plugin': '^1.1.0' }, installed: { 'probe-plugin': '1.1.0' } })
  const runner = makeRunner((args) => ({ name: 'probe-plugin', version: String(args[1]).split('@').pop() }))
  const clean = await up.rollbackUpgrade({
    environment: 'roll', name: 'probe-plugin', version: '1.0.0',
    config: configWith(), installAnchor: '/anchor/package.json', runCommand: runner.run,
  })
  assert.equal(clean.ok, true, clean.output)
  assert.equal(clean.clean, true)
  assert.deepEqual(runner.calls.map((call) => call.args), [['add', 'probe-plugin@1.0.0']])
  assert.match(clean.output, /已回滚 probe-plugin：1\.1\.0 → 1\.0\.0/)
  assert.equal(readFileSync(join(dir, 'node_modules', 'probe-plugin', 'package.json'), 'utf8').includes('1.0.0'), true)

  // 盘上没到位（替身什么都不做）：如实报不干净，并说明残留要按事实处理
  const dir2 = makeEnv('roll2', { bundles: ['probe-plugin'], dependencies: { 'probe-plugin': '^1.1.0' }, installed: { 'probe-plugin': '1.1.0' } })
  void dir2
  const stuck = makeRunner(() => ({ exitCode: 0 }))
  const notClean = await up.rollbackUpgrade({
    environment: 'roll2', name: 'probe-plugin', version: '1.0.0',
    config: configWith(), installAnchor: '/anchor/package.json', runCommand: stuck.run,
  })
  assert.equal(notClean.ok, false)
  assert.equal(notClean.clean, false)
  assert.equal(notClean.code, 'rollback-incomplete')
  assert.match(notClean.output, /回滚没能到位/)
  assert.match(notClean.output, /环境未被改动/)
})

test('原来就是本地来源（link:）时：回滚装回那个来源，而不是装一个 registry 版本', async () => {
  makeEnv('roll-link', { bundles: ['probe-plugin'], dependencies: { 'probe-plugin': 'link:' + join(HOME, 'local-src') }, installed: { 'probe-plugin': '1.0.0' } })
  const runner = makeRunner(() => ({ name: 'probe-plugin', version: '1.0.0' }))
  const result = await up.rollbackUpgrade({
    environment: 'roll-link', name: 'probe-plugin', version: '1.0.0', spec: 'link:' + join(HOME, 'local-src'),
    config: configWith(), installAnchor: '/anchor/package.json', runCommand: runner.run,
  })
  assert.equal(result.ok, true, result.output)
  assert.deepEqual(runner.calls.map((call) => call.args), [['add', 'link:' + join(HOME, 'local-src')]])
})

// ── ⑧ 官方通道的前置条件 ──────────────────────────────────────────────────

test('拿不到 installAnchor 时拒绝升级（绝不猜路径）', async () => {
  makeEnv('noanchor', { bundles: ['probe-plugin'], dependencies: { 'probe-plugin': '^1.0.0' }, installed: { 'probe-plugin': '1.0.0' } })
  const result = await up.upgradePackage({
    environment: 'noanchor', name: 'probe-plugin', version: '1.1.0',
    config: configWith({ trial: { ...settings.DEFAULT_TRIAL_CONFIG, enabled: false } }),
    runCommand: makeRunner().run, log: () => {},
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'no-profile-context')
  assert.match(result.output, /installAnchor/)
})

// ── ⑨ 设置：三项 + 归一 ───────────────────────────────────────────────────

test('升级设置：默认每天一次、自动检查开；归一与间隔映射都要有确定值', () => {
  assert.deepEqual(settings.DEFAULT_UPGRADE_CONFIG, { autoCheck: true, interval: 'daily', registryUrl: '' })
  const resolved = settings.ConfigSchema({})
  for (const key of Object.keys(settings.DEFAULT_UPGRADE_CONFIG)) {
    assert.notEqual(resolved.upgrade[key], undefined, 'schema 回填后 ' + key + ' 不能是 undefined')
  }
  assert.deepEqual(settings.effectiveUpgradeConfig(undefined), settings.DEFAULT_UPGRADE_CONFIG)
  assert.deepEqual(settings.effectiveUpgradeConfig({}), settings.DEFAULT_UPGRADE_CONFIG)
  const junk = settings.effectiveUpgradeConfig({ upgrade: { autoCheck: 'yes', interval: 'nope', registryUrl: 7 } })
  assert.deepEqual(junk, settings.DEFAULT_UPGRADE_CONFIG)
  assert.equal(settings.upgradeIntervalMs('session'), 0)
  assert.equal(settings.upgradeIntervalMs('6h'), 6 * 60 * 60 * 1000)
  assert.equal(settings.upgradeIntervalMs('daily'), 24 * 60 * 60 * 1000)
  assert.equal(settings.upgradeIntervalMs('manual'), null, '仅手动 = 永不自动检查')
  assert.equal(up.isLocalSpec('link:../x'), true)
  assert.equal(up.isLocalSpec('/abs/path'), true)
  assert.equal(up.isLocalSpec('^1.0.0'), false)
  assert.equal(up.versionLine('0.1.6-alpha.2'), '0.1.6')
  assert.equal(up.versionLine('not-a-version'), null)
})

// ── ⑩ op 层：三个 op + 自身升级走独立 job ─────────────────────────────────

function makeDeps({ upgrade, capabilities } = {}) {
  const jobs = []
  return {
    ctx: { get: () => undefined, logger: { info() {}, warn() {} }, effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} } },
    config: () => configWith({ trial: { ...settings.DEFAULT_TRIAL_CONFIG, enabled: false } }),
    configUpdate: async (patch) => configWith(patch),
    capabilities: () => ({ profileBacked: true, manager: false, inventory: false, environmentName: capabilities ?? 'three', missing: [] }),
    jobs: {
      start(task) { jobs.push(task); return 'job-upgrade-1' },
      status() { return { done: false } },
    },
    upgrade,
  }
}

test('op 层：upgradeCheck 直接给四态；upgrade / upgradeRollback 都是 job（自身升级走独立 job）', async () => {
  makeEnv('three', {
    bundles: ['@deepseek-ai/dsh-base', 'dsh-plugin-manager-companion', 'probe-plugin'],
    dependencies: { 'dsh-plugin-manager-companion': 'link:' + join(HOME, 'repo'), 'probe-plugin': '^1.0.0' },
    installed: { 'dsh-plugin-manager-companion': '0.1.0', 'probe-plugin': '1.0.0' },
  })
  const runner = makeRunner(() => ({ name: 'probe-plugin', version: '1.1.0' }))
  const trial = makeTrial('passed')
  const deps = makeDeps({ upgrade: { installAnchor: '/anchor/package.json', runCommand: runner.run, trial: trial.run, fetch: makeFetcher(() => jsonResponse(200, { 'dist-tags': { latest: '1.1.0' } })).fetch, log: () => {} } })
  const check = await index.handleOp('upgradeCheck', { refresh: true }, deps)
  assert.equal(check.ok, true)
  const names = check.value.units.map((unit) => unit.name).sort()
  assert.deepEqual(names, ['@deepseek-ai/dsh-base', 'dsh-plugin-manager-companion', 'probe-plugin'])
  assert.equal(check.value.units.find((unit) => unit.name === '@deepseek-ai/dsh-base').state, 'not-upgradable')

  const started = await index.handleOp('upgrade', { name: 'probe-plugin', version: '1.1.0' }, deps)
  assert.equal(started.ok, true)
  assert.equal(typeof started.value.jobId, 'string', '升级必须是 job（首包是 { jobId }）')
  const rolled = await index.handleOp('upgradeRollback', { name: 'probe-plugin', version: '1.0.0' }, deps)
  assert.equal(rolled.ok, true)
  assert.equal(typeof rolled.value.jobId, 'string')

  const missing = await index.handleOp('upgrade', { name: 'probe-plugin' }, deps)
  assert.equal(missing.ok, false)
  assert.match(missing.error.message, /version/)
})

test('自升级：结论里必须写"下次启动生效"（官方口径），并且是 job', async () => {
  const dir = makeEnv('self', {
    bundles: ['dsh-plugin-manager-companion'],
    dependencies: { 'dsh-plugin-manager-companion': 'link:' + join(HOME, 'repo') },
    installed: { 'dsh-plugin-manager-companion': '0.1.0' },
  })
  void dir
  const runner = makeRunner(() => ({ name: 'dsh-plugin-manager-companion', version: '0.2.0' }))
  const result = await up.upgradePackage({
    environment: 'self', name: paths.OUR_PACKAGE_NAME, version: '0.2.0',
    config: configWith({ trial: { ...settings.DEFAULT_TRIAL_CONFIG, enabled: false } }),
    installAnchor: '/anchor/package.json', runCommand: runner.run, log: () => {},
  })
  assert.equal(result.ok, true, result.output)
  assert.equal(result.restartRequired, true)
  assert.match(result.output, /本插件自身/)
  assert.match(result.output, /下次启动/)
  assert.doesNotMatch(result.output, /已立即生效|立即生效/, '不许假装立即生效')
})

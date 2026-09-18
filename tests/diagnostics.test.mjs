/**
 * diagnostics.ts 单测（node --test，**跑 dist 产物**而不是源码）。
 *
 * 覆盖验收要求：duplicate-row-id / missing-import / official-duplicate / disabled-dependency /
 * failed-fiber 检出，能力缺失时 skipped 有记录，证据必须带真实行号；另附词法扫描器
 * 对"注释里的伪注册、字符串里的伪 import"的回归用例（旧实现的正则扫描在这两处会误报）。
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  analyzeEnvironment, installAnchorRoots, installedPackageDir, scanCode, specifierResolves,
  tokenize, locatePatchRows,
} from '../dist/diagnostics.js'

let home
let envDir
let patchPath
let brokenDir
let installDir
let installAnchor
let reverseDir
let reversePatchPath
let bundleDir
let bundlePatchPath
let crossPlainLine
let crossSecondLine

/** reverse profile 的 patch 里某片段的行号（1 起）。 */
function reversePatchLine(needle) {
  const lines = readFileSync(reversePatchPath, 'utf8').split('\n')
  const index = lines.findIndex(line => line.includes(needle))
  assert.ok(index >= 0, 'reverse fixture 里找不到 ' + needle)
  return index + 1
}

/** 写 JSON 文件（自动建目录）。 */
async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2))
}

/** 写文本文件（自动建目录）。 */
async function writeText(file, text) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text)
}

/** demo profile 的 patch 层（行号在测试里按内容反查，避免写死漂移）。 */
const PATCH = [
  '# demo profile patch',
  '- insert:',
  '    - id: p1-row',
  '      name: p1',
  '    - id: p2-row',
  '      name: p2',
  '      disabled: true',
  '    - id: alpha',
  '      name: p1',
  '    - id: alpha',
  '      name: p2',
  "    - name: '@org/not-installed'",
  '',
].join('\n')

/** patch 里某个片段所在的行号（1 起）。 */
function lineOf(needle) {
  const lines = PATCH.split('\n')
  const index = lines.findIndex(line => line.includes(needle))
  assert.ok(index >= 0, 'fixture patch 里找不到 ' + needle)
  return index + 1
}

/** 造一个只实现本模块用到的官方探测面的 ctx（get / loader / logger）。 */
function makeCtx(options = {}) {
  const services = {
    loader: options.loader,
    profileContext: options.profileContext,
  }
  return {
    get: name => services[name],
    loader: options.loader,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  }
}

/** 一个 loader 条目（官方 readPluginInventory 直接读 ctx.loader.entries()）。 */
function loaderEntry(id, name, state, disabled = false) {
  return { id, options: { name }, disabled, fiber: { state } }
}

/**
 * demo 环境。installAnchor 省略即 launcher 没给锚点的降级形态（要记 skipped，不静默判缺包）。
 * @param installAnchor - dsh 应用包的 package.json 路径。
 * @returns EnvironmentInfo（带或不带锚点）。
 */
const ENV = (installAnchor) => ({
  name: 'demo',
  dir: envDir,
  current: false,
  builtin: false,
  bundles: [],
  dependencies: ['p1', 'p2', '@deepseek-ai/cordis'],
  runs: [],
  ...(installAnchor === undefined ? {} : { installAnchor }),
})

const CONFIG = {
  diagnostics: {
    dependency: true, composition: true, runtime: true, consistency: true, ecosystem: false,
  },
  qualityGate: { enabled: true, mode: 'block', allowlist: [] },
  marketplace: { enabled: true, cacheTtlMinutes: 1440, timeoutMs: 15000, indexUrl: '' },
}

/** 在报告里找一个 code（找不到返回 undefined）。 */
function issueOf(report, code) {
  return report.issues.find(issue => issue.code === code)
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'dshpm-diag-'))
  process.env.DSH_HOME = home
  const profiles = join(home, 'profiles')
  envDir = join(profiles, 'demo')
  patchPath = join(envDir, 'cordis.patch.yml')

  // 安装兜底层（profiles/node_modules）：官方 cordis 在这里
  await writeJson(join(profiles, 'node_modules', '@deepseek-ai', 'cordis', 'package.json'),
    { name: '@deepseek-ai/cordis', version: '4.0.2' })

  // profile 层：cordis 又装了一份 -> official-duplicate
  await writeJson(join(envDir, 'package.json'), {
    name: 'dsh-profile-demo',
    private: true,
    dependencies: { p1: '1.0.0', p2: '1.0.0', '@deepseek-ai/cordis': '4.0.2' },
    dsh: { profile: { bundles: [] } },
  })
  await writeJson(join(envDir, 'node_modules', '@deepseek-ai', 'cordis', 'package.json'),
    { name: '@deepseek-ai/cordis', version: '4.0.2' })

  // p1：声明了 p2（依赖边），导入一个谁都不提供的包（missing-import），并 inject 一个没人提供的服务
  await writeJson(join(envDir, 'node_modules', 'p1', 'package.json'), {
    name: 'p1', version: '1.0.0', exports: { '.': './index.js' }, dependencies: { p2: '1.0.0' },
  })
  await writeText(join(envDir, 'node_modules', 'p1', 'index.js'), [
    "import 'p2'",
    "import '@deepseek-ai/missing-provider'",
    "export const inject = ['missing-service']",
    'export const apply = () => {}',
    '',
  ].join('\n'))

  // p2：peer 要求 cordis ^5，实际装的是 4.0.2 -> peer-mismatch
  await writeJson(join(envDir, 'node_modules', 'p2', 'package.json'), {
    name: 'p2', version: '1.0.0', exports: { '.': './index.js' },
    peerDependencies: { '@deepseek-ai/cordis': '^5.0.0' },
  })
  await writeText(join(envDir, 'node_modules', 'p2', 'index.js'), 'export const apply = () => {}\n')

  await writeText(patchPath, PATCH)

  // 第二个 fixture：manifest 坏掉（官方组合口径会抛错），但 patch 文本可读
  brokenDir = join(profiles, 'broken')
  await writeText(join(brokenDir, 'package.json'), '{ "name": "broken-profile", ')
  await writeText(join(brokenDir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: dup',
    '      name: alpha-pkg',
    '    - id: dup',
    '      name: beta-pkg',
    '    - id: disabled-row',
    '      name: gamma-pkg',
    '      disabled: true',
    '',
  ].join('\n'))

  // 安装锚点：官方包与 bundle 本体由**安装侧**提供，profile 的 node_modules 里没有它们。
  // 只有把它纳入解析根，这些行才不会被判成孤儿（实测干净环境 163 条 orphan-row 全是这么来的）。
  installDir = join(home, 'runtime', 'node_modules', '@deepseek-ai', 'dsh')
  installAnchor = join(installDir, 'package.json')
  await writeJson(installAnchor, { name: '@deepseek-ai/dsh', version: '0.1.6-alpha.2' })
  await writeJson(join(home, 'runtime', 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'),
    { name: '@deepseek-ai/dsh-base', version: '0.1.6-alpha.2' })
  await writeText(join(home, 'runtime', 'node_modules', '@deepseek-ai', 'official-lib', 'sub.js'),
    'export const sub = 1\n')
  await writeJson(join(home, 'runtime', 'node_modules', '@deepseek-ai', 'official-lib', 'package.json'),
    { name: '@deepseek-ai/official-lib', version: '1.0.0' })

  // 反向证明用的 profile：patch 引用安装锚点里也没有的包 —— 该报的必须照样报。
  reverseDir = join(profiles, 'reverse')
  reversePatchPath = join(reverseDir, 'cordis.patch.yml')
  await writeJson(join(reverseDir, 'package.json'), {
    name: 'dsh-profile-reverse', private: true, dependencies: { p1: '1.0.0' },
    dsh: { profile: { bundles: [] } },
  })
  // p1 与它的依赖声明都在这个 profile 里 -> 必须解析得到（用来证明反向用例不是无差别报错）
  await writeJson(join(reverseDir, 'node_modules', 'p1', 'package.json'),
    { name: 'p1', version: '1.0.0' })
  await writeText(join(reverseDir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: really-missing',
    "      name: '@deepseek-ai/truly-not-installed'",
    '    - id: profile-local',
    '      name: p1',
    '',
  ].join('\n'))
  // 需要人工动手的两条诊断（orphan-row / duplicate-row-id）：
  // ① bundle 自带的 patch 里也有一个解析不到的行（用来钉「bundle 通道」的措辞与三要素）；
  // ② 跨 insert 列表的同名 id（实测不致命，必须与致命的那种区分开）。
  bundleDir = join(profiles, 'bundle-holder', 'node_modules', 'probe-bundle')
  bundlePatchPath = join(bundleDir, 'cordis.patch.yml')
  await writeJson(join(profiles, 'bundle-holder', 'package.json'), {
    name: 'dsh-profile-bundle-holder', private: true, dependencies: {},
    dsh: { profile: { bundles: ['probe-bundle'] } },
  })
  await writeJson(join(bundleDir, 'package.json'), {
    name: 'probe-bundle', version: '1.0.0', exports: { '.': './index.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  await writeText(join(bundleDir, 'index.js'), 'export const apply = () => {}\n')
  await writeText(bundlePatchPath, [
    '- insert:',
    '    - id: bundle-bad-row',
    "      name: '@nope/never-installed-anywhere'",
    '',
  ].join('\n'))

  // reverse profile 追加：同列表重复 id（致命）+ 跨列表同名 id（不致命）。
  await writeText(reversePatchPath, [
    '- insert:',
    '    - id: really-missing',
    "      name: '@deepseek-ai/truly-not-installed'",
    '    - id: profile-local',
    '      name: p1',
    '    - id: fatal-dup',
    '      name: p1',
    '    - id: fatal-dup',
    '      name: p1',
    '    - id: cross-both',
    '      name: p1',
    '- id: another-group',
    '  insert:',
    '    - id: cross-both',
    '      name: p1',
    '',
  ].join('\n'))
  crossPlainLine = reversePatchLine('- id: cross-both')
  crossSecondLine = reversePatchLine('    - id: cross-both')
})

after(async () => {
  await rm(home, { recursive: true, force: true })
  delete process.env.DSH_HOME
})

describe('diagnostics · 五层诊断', () => {
  it('报告形状：计数与 issues 一致、时间戳是 ISO、五层键齐全', async () => {
    const report = await analyzeEnvironment(makeCtx({ profileContext: {} }), ENV(), CONFIG)
    assert.equal(report.environment, 'demo')
    assert.match(report.generatedAt, /^\d{4}-\d{2}-\d{2}T/)
    const total = Object.values(report.counts).reduce((sum, value) => sum + value, 0)
    assert.equal(total, report.issues.length)
    assert.deepEqual(Object.keys(report.counts).sort(),
      ['composition', 'consistency', 'dependency', 'ecosystem', 'runtime'])
    assert.ok(Array.isArray(report.skipped))
    // 报告要跨 wire 传给客户端：必须 JSON-safe（不能带 undefined 值、Map、Set 或循环引用）
    const roundTrip = JSON.parse(JSON.stringify(report))
    assert.deepEqual(roundTrip, report)
    assert.doesNotThrow(() => JSON.stringify(report.issues.map(issue => issue.fix ?? null)))
  })

  it('detects duplicate-row-id 并指向两处原始行号', async () => {
    const report = await analyzeEnvironment(makeCtx({ profileContext: {} }), ENV(), CONFIG)
    const issue = issueOf(report, 'duplicate-row-id')
    assert.ok(issue, '应检出 duplicate-row-id')
    assert.equal(issue.layer, 'composition')
    // 这条需要用户自己删 patch 行（我们不代写该文件），因此不是能自动跑完的 safe-fix。
    assert.equal(issue.severity, 'confirm-fix')
    assert.ok(issue.fix, '有一键入口，但执行结果是 needs-manual')
    assert.equal(issue.fix.action, 'remove-duplicate-row')
    assert.equal(issue.fix.target, 'alpha')
    const fileEvidence = issue.evidence.filter(item => item.kind === 'file').map(item => item.at)
    assert.ok(fileEvidence.includes('cordis.patch.yml:' + lineOf('id: alpha')),
      '证据要指回第一处重复行：' + JSON.stringify(fileEvidence))
    assert.ok(fileEvidence.some(at => at.endsWith(':10')), '证据要指回第二处重复行：' + JSON.stringify(fileEvidence))
    assert.ok(issue.evidence.some(item => item.kind === 'official' && item.at.includes('loader entry id')),
      '要给出官方 loader 行为的证据')
  })

  it('detects missing-import（未声明且无提供者）并带到行号', async () => {
    const report = await analyzeEnvironment(makeCtx({ profileContext: {} }), ENV(), CONFIG)
    const issue = issueOf(report, 'missing-import')
    assert.ok(issue, '应检出 missing-import')
    assert.equal(issue.layer, 'dependency')
    assert.equal(issue.severity, 'confirm-fix')
    assert.ok(issue.subjects.includes('@deepseek-ai/missing-provider'))
    assert.equal(issue.evidence[0].at, 'node_modules/p1/index.js:2')
    assert.equal(issue.fix.action, 'install-provider')
    // 已声明且装好的 p2 不应被报成 missing-import
    assert.ok(!report.issues.some(other => other.subjects.includes('p2') && other.code === 'missing-import'))
  })

  it('detects official-duplicate（两层 node_modules 都有官方包）', async () => {
    const report = await analyzeEnvironment(makeCtx({ profileContext: {} }), ENV(), CONFIG)
    const issue = issueOf(report, 'official-duplicate')
    assert.ok(issue, '应检出 official-duplicate')
    assert.equal(issue.severity, 'safe-fix')
    assert.equal(issue.fix.action, 'remove-official-copy')
    assert.deepEqual(issue.subjects.slice(0, 1), ['@deepseek-ai/cordis'])
    assert.equal(issue.evidence.length, 2)
    assert.ok(issue.evidence[0].at.startsWith('node_modules/@deepseek-ai/cordis'))
    assert.ok(issue.evidence[1].at.includes('profiles/node_modules/@deepseek-ai/cordis'))
  })

  it('detects disabled-dependency（被依赖的行被禁用）', async () => {
    const report = await analyzeEnvironment(makeCtx({ profileContext: {} }), ENV(), CONFIG)
    const issue = issueOf(report, 'disabled-dependency')
    assert.ok(issue, '应检出 disabled-dependency')
    assert.equal(issue.severity, 'safe-fix')
    assert.equal(issue.fix.action, 'enable-row')
    assert.equal(issue.fix.target, 'p2-row', '修复目标必须是 loader 行 id')
    assert.ok(issue.subjects.includes('p1') && issue.subjects.includes('p2'))
    assert.ok(issue.evidence.some(item => item.at === 'cordis.patch.yml:' + lineOf('disabled: true'))
      || issue.evidence.some(item => item.at === 'node_modules/p1/index.js:1'))
  })

  it('报告 unaddressable-row（无显式 id）与 orphan-row（解析不到的 name）', async () => {
    const report = await analyzeEnvironment(makeCtx({ profileContext: {} }), ENV(), CONFIG)
    const anonymous = issueOf(report, 'unaddressable-row')
    assert.ok(anonymous, '应检出 unaddressable-row')
    assert.equal(anonymous.severity, 'report-only')
    assert.equal(anonymous.fix, undefined, 'report-only 不给 fix')
    assert.equal(anonymous.evidence[0].at, 'cordis.patch.yml:' + lineOf("name: '@org/not-installed'"))

    const orphan = issueOf(report, 'orphan-row')
    assert.ok(orphan, '应检出 orphan-row')
    assert.equal(orphan.severity, 'confirm-fix')
    assert.ok(orphan.subjects.includes('@org/not-installed'))
  })

  it('detects peer-mismatch（peer 版本不满足，只报告）', async () => {
    const report = await analyzeEnvironment(makeCtx({ profileContext: {} }), ENV(), CONFIG)
    const issue = issueOf(report, 'peer-mismatch')
    assert.ok(issue, '应检出 peer-mismatch')
    assert.equal(issue.severity, 'report-only')
    assert.equal(issue.fix, undefined)
    assert.deepEqual(issue.subjects, ['p2', '@deepseek-ai/cordis'])
  })

  it('detects failed-fiber（load 相位 3 = failed）', async () => {
    const ctx = makeCtx({
      profileContext: {},
      loader: { entries: () => [loaderEntry('p1-row', 'p1', 3)] },
    })
    const report = await analyzeEnvironment(ctx, ENV(), CONFIG)
    const issue = issueOf(report, 'failed-fiber')
    assert.ok(issue, '应检出 failed-fiber')
    assert.equal(issue.layer, 'runtime')
    assert.equal(issue.severity, 'confirm-fix')
    assert.equal(issue.fix.action, 'disable-row')
    assert.equal(issue.fix.target, 'p1-row')
    assert.equal(issue.evidence[0].at, 'loader entry "p1-row"')
    assert.ok(!report.skipped.some(item => item.check === 'runtime-inventory'), '有 loader 时不该跳过运行时层')
  })

  it('pending 相位且注入的服务没有提供者时如实说出缺哪个服务', async () => {
    const ctx = makeCtx({
      profileContext: {},
      loader: { entries: () => [loaderEntry('p1-row', 'p1', 0)] },
    })
    const report = await analyzeEnvironment(ctx, ENV(), CONFIG)
    const issue = issueOf(report, 'pending-fiber')
    assert.ok(issue, '应检出 pending-fiber')
    assert.match(issue.detail, /missing-service/)
    assert.ok(issue.subjects.includes('missing-service'))
  })

  it('能力缺失时不假装健康：没有 Loader 服务时运行时层如实记 skipped', async () => {
    const report = await analyzeEnvironment(makeCtx({}), ENV(), CONFIG)
    assert.ok(report.skipped.some(item => item.check === 'runtime-inventory'),
      '缺少 Loader 时必须记 skipped：' + JSON.stringify(report.skipped))
    assert.equal(report.counts.runtime, 0, '没有 loader 就不该产出运行时发现')
    // 组合层不依赖 Loader（走官方 app-boot 读文件），因此照样给出结论
    assert.ok(issueOf(report, 'duplicate-row-id'))
    assert.ok(issueOf(report, 'disabled-dependency'))
  })

  it('官方组合口径抛错时降级：纯文本检查照做，禁用状态类结论不产出', async () => {
    const env = { name: 'broken', dir: brokenDir, current: false, builtin: false, bundles: [], dependencies: [], runs: [] }
    const report = await analyzeEnvironment(makeCtx({ profileContext: {} }), env, CONFIG)
    assert.ok(report.skipped.some(item => item.check === 'composition-official'),
      '官方组合不可用必须记 skipped：' + JSON.stringify(report.skipped))
    assert.ok(report.skipped.some(item => item.check === 'runtime-inventory'))
    assert.ok(issueOf(report, 'broken-manifest'), '坏 manifest 必须被报出来')
    assert.ok(issueOf(report, 'duplicate-row-id'), '官方组合不可用也要保留纯文本检查')
    assert.ok(!issueOf(report, 'disabled-dependency'), '禁用状态不可判定时不得给出该结论')
  })

  it('配置关掉的层记 skipped，且不产出该层发现', async () => {
    const config = { ...CONFIG, diagnostics: { ...CONFIG.diagnostics, dependency: false, ecosystem: true } }
    const report = await analyzeEnvironment(makeCtx({ profileContext: {} }), ENV(), config)
    assert.ok(report.skipped.some(item => item.check === 'dependency-layer'))
    assert.ok(report.skipped.some(item => item.check === 'ecosystem-index'))
    assert.equal(report.counts.dependency, 0)
  })

  it('环境目录不存在时不抛错，只记 skipped', async () => {
    const env = { ...ENV(), dir: join(home, 'profiles', 'nope') }
    const report = await analyzeEnvironment(makeCtx({ profileContext: {} }), env, CONFIG)
    assert.ok(report.skipped.some(item => item.check === 'environment-dir'))
  })

  it('分级处置不变量：safe-fix 必有 fix，report-only 必无 fix', async () => {
    const report = await analyzeEnvironment(makeCtx({ profileContext: {} }), ENV(), CONFIG)
    for (const issue of report.issues) {
      if (issue.severity === 'safe-fix') assert.ok(issue.fix, issue.code + ' 是 safe-fix 却没有 fix')
      if (issue.severity === 'report-only') assert.equal(issue.fix, undefined, issue.code + ' 是 report-only 却给了 fix')
      assert.ok(issue.detail.length > 10, issue.code + ' 的 detail 太短')
      assert.ok(issue.evidence.length > 0, issue.code + ' 没有证据')
    }
  })
})


describe('diagnostics · 安装锚点解析根（误报治理）', () => {
  it('安装锚点解析根按官方口径取自 createRequire(anchor).resolve.paths', () => {
    const roots = installAnchorRoots(installAnchor)
    assert.ok(Array.isArray(roots) && roots.length > 0, '锚点应当解析出模块根：' + JSON.stringify(roots))
    assert.ok(roots.includes(join(home, 'runtime', 'node_modules')),
      '锚点自己的 node_modules 必须在解析根里：' + JSON.stringify(roots))
    assert.ok(roots.every(root => root.endsWith('node_modules')), '解析根只保留 node_modules 位置')
    assert.equal(installAnchorRoots(join(home, 'runtime', 'no-such-package.json')), null,
      '锚点不存在时必须如实返回 null，不能假装解析成功')
    assert.equal(installAnchorRoots(undefined), null, '没有锚点就是 null')
  })

  it('官方包（安装侧提供）不再被误报成孤儿、缺包、缺 peer', async () => {
    const report = await analyzeEnvironment(makeCtx({ profileContext: {} }), ENV(installAnchor), CONFIG)
    const orphans = report.issues.filter(issue => issue.code === 'orphan-row')
    assert.deepEqual(orphans.map(issue => issue.subjects[0]), ['@org/not-installed'],
      '只剩 fixture 里那个真正解析不到的包：' + JSON.stringify(report.issues.map(issue => issue.code)))
    assert.deepEqual(report.issues.filter(issue => issue.code === 'undeclared-dependency'), [],
      'bundles 里的官方包由安装侧提供，不该报 声明了但没装')
    assert.deepEqual(report.issues.filter(issue => issue.code === 'missing-peer'), [],
      'peer 由安装侧满足，不该报缺失')
    assert.ok(installedPackageDir(envDir, '@deepseek-ai/dsh-base', installAnchor),
      '安装侧的包必须能在解析根里找到')
    assert.equal(specifierResolves(envDir, '@deepseek-ai/official-lib/sub', installAnchor), true,
      '锚点里的包连同它的子路径都要解析得到')
    assert.equal(specifierResolves(envDir, '@deepseek-ai/official-lib/sub', undefined), false,
      '没有锚点时按 profile 解析：同一个说明符解析不到（这正是修前的误报根源）')
  })

  it('反向证明：锚点里真没有的包照样报 orphan-row（不是把检查做哑）', async () => {
    const env = { name: 'reverse', dir: reverseDir, current: false, builtin: false, bundles: [], dependencies: ['p1'], runs: [], installAnchor }
    const report = await analyzeEnvironment(makeCtx({ profileContext: {} }), env, CONFIG)
    const orphans = report.issues.filter(issue => issue.code === 'orphan-row')
    assert.equal(orphans.length, 1, '只该报真正解析不到的那一行：' + JSON.stringify(orphans.map(issue => issue.subjects)))
    assert.ok(orphans[0].subjects.includes('@deepseek-ai/truly-not-installed'))
    assert.match(orphans[0].detail, /安装锚点/, 'detail 要说清查过哪些解析根：' + orphans[0].detail)
    assert.ok(!orphans.some(issue => issue.subjects.some(name => name === 'p1')),
      'profile 本地能解析的行不该混进来')
    assert.equal(orphans[0].fix.action, 'remove-row')
  })

  it('依赖闭包跨到安装锚点：loader 树上、却只由锚点提供的包不算"挂着但不在闭包里"', async () => {
    const ctx = makeCtx({
      profileContext: {},
      loader: { entries: () => [loaderEntry('base-row', '@deepseek-ai/dsh-base', 2)] },
    })
    const report = await analyzeEnvironment(ctx, ENV(installAnchor), CONFIG)
    assert.deepEqual(report.issues.filter(issue => issue.code === 'loaded-not-declared'), [],
      '闭包必须能跨过安装锚点：' + JSON.stringify(report.issues.map(issue => issue.code)))
    assert.ok(report.issues.every(issue => issue.code !== 'failed-fiber' && issue.code !== 'pending-fiber'),
      '相位 2 = active，不该报 fiber 问题')
  })

  it('launcher 没给锚点时退回 profile 解析并如实记 skipped', async () => {
    const report = await analyzeEnvironment(makeCtx({ profileContext: {} }), ENV(), CONFIG)
    assert.ok(report.skipped.some(item => item.check === 'install-anchor'),
      '省略锚点时必须记 skipped：' + JSON.stringify(report.skipped.map(item => item.check)))
  })
})

describe('diagnostics · 噪声治理', () => {
  it('同一 code 的同类命中给出可折叠的组（组计数之和等于逐条总数）', async () => {
    const report = await analyzeEnvironment(makeCtx({ profileContext: {} }), ENV(installAnchor), CONFIG)
    assert.ok(Array.isArray(report.groups), '报告必须带 groups（客户端据此折叠）')
    const total = report.groups.reduce((sum, group) => sum + group.count, 0)
    assert.equal(total, report.issues.length, '一条不少：组计数之和必须等于逐条总数')
    const duplicate = report.groups.find(group => group.code === 'duplicate-row-id')
    assert.ok(duplicate, '应有一个 duplicate-row-id 组：' + JSON.stringify(report.groups))
    assert.equal(duplicate.count, 1)
    assert.deepEqual(duplicate.scopes, [{ scope: 'dsh-profile-demo', count: 1 }],
      '组要说明命中归属哪个包（demo profile 的 patch 与其 package.json 同目录）')
    assert.ok(duplicate.key.startsWith('composition:duplicate-row-id:confirm-fix:dsh-profile-demo'),
      '组键要带上严重级别：' + duplicate.key)
    assert.ok(duplicate.exampleTitle.includes('alpha'), '组要带一条样例标题：' + duplicate.exampleTitle)
  })
})


describe('diagnostics · 需人工处理的提示（后果 + 三要素）', () => {
  /** 三要素：完整文件路径、行 id、删完做什么（重启）。 */
  function assertActionable(text, { file, id, expectRestart = true }) {
    assert.ok(text.includes(file), '要给出文件路径 ' + file + '：' + text)
    assert.ok(text.includes(id), '要给出要动的行 id ' + id + '：' + text)
    if (expectRestart) assert.match(text, /重启该环境/, '要说明删完要重启该环境：' + text)
  }

  it('orphan-row：说清后果是整个 profile 起不来，并给出文件+行 id+重启', async () => {
    const env = { name: 'reverse', dir: reverseDir, current: false, builtin: false, bundles: [], dependencies: ['p1'], runs: [], installAnchor }
    const report = await analyzeEnvironment(makeCtx({ profileContext: {} }), env, CONFIG)
    const issue = report.issues.find(candidate => candidate.code === 'orphan-row')
    assert.ok(issue, '应检出 orphan-row')
    assert.match(issue.detail, /整个 profile 起不来/, '后果必须与事实等重：' + issue.detail)
    assert.match(issue.detail, /ERR_MODULE_NOT_FOUND/)
    assert.doesNotMatch(issue.detail, /会让这一行失败/, '旧的低估措辞必须消失')
    // 报告里给的是环境相对的 cordis.patch.yml（证据可点回源），detail 里同时给绝对路径
    assertActionable(issue.detail, { file: reversePatchPath, id: 'really-missing' })
    assertActionable(issue.fix.summary, { file: 'cordis.patch.yml:' + reversePatchLine('    - id: really-missing'), id: 'really-missing' })
    assert.ok(issue.evidence.some(item => item.at === 'cordis.patch.yml:' + reversePatchLine('    - id: really-missing')),
      '证据要指回那一行：' + JSON.stringify(issue.evidence))
    assert.match(issue.extra.operation, /重启该环境/, '机器可读的操作文本也要带后续动作')
  })

  it('变异验证：把行号从 fix.summary 去掉，钉住的断言必须报红', async () => {
    const env = { name: 'reverse', dir: reverseDir, current: false, builtin: false, bundles: [], dependencies: ['p1'], runs: [], installAnchor }
    const report = await analyzeEnvironment(makeCtx({ profileContext: {} }), env, CONFIG)
    const issue = report.issues.find(candidate => candidate.code === 'orphan-row')
    const lineOfRow = reversePatchLine('    - id: really-missing')
    const mutated = issue.fix.summary.replace('cordis.patch.yml:' + lineOfRow, 'cordis.patch.yml')
    assert.notEqual(mutated, issue.fix.summary, '变异体必须真的改掉了行号')
    assert.throws(() => assertActionable(mutated, { file: 'cordis.patch.yml:' + lineOfRow, id: 'really-missing' }),
      '去掉行号后断言必须失败——否则说明这条钉子是空的')
    assert.ok(!mutated.includes('cordis.patch.yml:' + lineOfRow), '变异后不该再出现行号')
  })

  it('duplicate-row-id：同列表重复说清是致命，并给出文件+行 id+重启', async () => {
    const env = { name: 'reverse', dir: reverseDir, current: false, builtin: false, bundles: [], dependencies: ['p1'], runs: [], installAnchor }
    const report = await analyzeEnvironment(makeCtx({ profileContext: {} }), env, CONFIG)
    const issue = report.issues.find(candidate => candidate.code === 'duplicate-row-id')
    assert.ok(issue, '应检出 duplicate-row-id')
    assert.equal(issue.severity, 'confirm-fix', '这条没有可自动执行的动作，不能标成 safe-fix')
    assert.match(issue.detail, /整个 profile 起不来/)
    assert.match(issue.detail, /duplicate loader entry id/)
    assertActionable(issue.detail, { file: reversePatchPath, id: 'fatal-dup' })
    assertActionable(issue.fix.summary,
      { file: 'cordis.patch.yml:' + reversePatchLine('    - id: fatal-dup'), id: 'fatal-dup' })
  })

  it('跨 insert 列表的同名 id：不报成致命，改报 report-only 的 id 重名', async () => {
    const env = { name: 'reverse', dir: reverseDir, current: false, builtin: false, bundles: [], dependencies: ['p1'], runs: [], installAnchor }
    const report = await analyzeEnvironment(makeCtx({ profileContext: {} }), env, CONFIG)
    const fatal = report.issues.find(candidate => candidate.code === 'duplicate-row-id')
    assert.ok(!fatal.subjects.includes('cross-both'), '跨列表的那一对不能被判成致命：' + JSON.stringify(fatal.subjects))
    const across = report.issues.find(candidate => candidate.code === 'duplicate-row-id-across-groups')
    assert.ok(across, '跨列表重名要如实报出来：' + JSON.stringify(report.issues.map(candidate => candidate.code)))
    assert.equal(across.severity, 'report-only')
    assert.equal(across.fix, undefined, 'report-only 不给修复动作')
    assert.match(across.detail, /不会触发官方 loader 的/, '要如实写明不致命')
    assert.match(across.detail, /能正常启动/)
    assert.ok(across.detail.includes('cordis.patch.yml:' + crossPlainLine),
      '要指回第一处：' + across.detail)
    assert.ok(across.detail.includes('cordis.patch.yml:' + crossSecondLine),
      '要指回第二处：' + across.detail)
  })

  it('bundle 自带的 patch：处置走官方通道，同时照样给文件+行 id+重启', async () => {
    const env = { name: 'bundle-holder', dir: join(home, 'profiles', 'bundle-holder'), current: false, builtin: false, bundles: ['probe-bundle'], dependencies: [], runs: [], installAnchor }
    const report = await analyzeEnvironment(makeCtx({ profileContext: {} }), env, CONFIG)
    const issue = report.issues.find(candidate => candidate.code === 'orphan-row')
    assert.ok(issue, '应检出 orphan-row：' + JSON.stringify(report.issues.map(candidate => candidate.code)))
    assertActionable(issue.detail, { file: bundlePatchPath, id: 'bundle-bad-row' })
    assert.match(issue.detail, /官方插件页/, 'bundle 的 patch 要指向官方通道')
    assert.match(issue.detail, /取消勾选/)
    assert.match(issue.detail, /随包升级会被覆盖/)
  })

  it('官方组合结果里确认不到这一行时，指示降一档语气（不装作确定）', async () => {
    const env = { name: 'broken', dir: brokenDir, current: false, builtin: false, bundles: [], dependencies: [], runs: [], installAnchor }
    const report = await analyzeEnvironment(makeCtx({ profileContext: {} }), env, CONFIG)
    assert.ok(report.skipped.some(item => item.check === 'composition-official'))
    const issue = report.issues.find(candidate => candidate.code === 'orphan-row')
    assert.ok(issue, '官方组合不可用时纯文本检查仍要给出 orphan-row')
    assert.equal(issue.code, 'orphan-row')
    assert.ok(issue.detail.includes(brokenDir), '照样要给文件位置：' + issue.detail)
    assertActionable(issue.detail, { file: join(brokenDir, 'cordis.patch.yml'), id: 'dup' })
  })
})

describe('diagnostics · 词法扫描器', () => {
  it('注释与字符串里的伪注册、伪 import 都不算数', () => {
    const code = [
      '// new Service(ctx, \'commented-service\')',
      '/* import \'commented-dep\' */',
      'const text = "from \'string-dep\'"',
      "import realDep from 'real-dep'",
      "export const inject = ['svc-a', 'svc-b']",
      "ctx.tools.register({ name: 'real-tool', description: 'x' })",
      '',
    ].join('\n')
    const result = scanCode(code)
    assert.deepEqual(result.imports.map(hit => hit.spec), ['real-dep'])
    assert.deepEqual(result.services.map(hit => hit.name), [])
    assert.deepEqual(result.injects.map(hit => hit.name), ['svc-a', 'svc-b'])
    assert.deepEqual(result.tools.map(hit => hit.name), ['real-tool'])
  })

  it('注册点与服务名带真实行号，注释不参与行号偏移', () => {
    const code = [
      '/*',
      ' 多行注释',
      '*/',
      "class S { constructor(ctx) { super(ctx, 'my-service') } }",
      "ctx.provide('other-service')",
      '',
    ].join('\n')
    const result = scanCode(code)
    assert.deepEqual(result.services.map(hit => [hit.name, hit.line]), [
      ['my-service', 4], ['other-service', 5],
    ])
  })

  it('import 的四种形态都被识别（静态 / 动态 / re-export / require）', () => {
    const code = [
      "import 'side-effect'",
      "const a = await import('dyn')",
      "export { b } from 're-exported'",
      "const c = require('cjs-dep')",
      '',
    ].join('\n')
    const kinds = scanCode(code).imports.map(hit => hit.kind)
    assert.deepEqual(kinds, ['static', 'dynamic', 're-export', 'require'])
  })

  it('行定位器只认 insert 块里的行，且记录显式 id 的有无', () => {
    const rows = locatePatchRows(patchPath)
    assert.equal(rows.length, 5)
    assert.equal(rows[0].id, 'p1-row')
    assert.equal(rows[0].name, 'p1')
    assert.equal(rows[0].line, lineOf('id: p1-row'))
    assert.equal(rows[1].disabled, 'true')
    assert.equal(rows[4].id, undefined, '最后一行没有显式 id')
    assert.equal(rows[4].name, '@org/not-installed')
  })

  it('条件表达式写成的 disabled 记成 conditional，不算"已禁用"', () => {
    const text = [
      '- insert:',
      '    - id: conditional-row',
      '      name: some-pkg',
      '      disabled: !!js "!ctx.get(\'profileContext\')"',
      '',
    ].join('\n')
    const rows = []
    // 直接复用行定位器需要文件：写一份临时文件
    return import('node:fs/promises').then(async fs => {
      const file = join(home, 'conditional.patch.yml')
      await fs.writeFile(file, text)
      rows.push(...locatePatchRows(file))
      assert.equal(rows.length, 1)
      assert.equal(rows[0].disabled, 'conditional')
    })
  })
})

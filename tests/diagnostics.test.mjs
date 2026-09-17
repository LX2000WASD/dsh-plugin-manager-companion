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
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { analyzeEnvironment, scanCode, tokenize, locatePatchRows } from '../dist/diagnostics.js'

let home
let envDir
let patchPath
let brokenDir

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

const ENV = () => ({
  name: 'demo',
  dir: envDir,
  current: false,
  builtin: false,
  bundles: [],
  dependencies: ['p1', 'p2', '@deepseek-ai/cordis'],
  runs: [],
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
    assert.equal(issue.severity, 'safe-fix')
    assert.ok(issue.fix, 'safe-fix 必须给出 fix')
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

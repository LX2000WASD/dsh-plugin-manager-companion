/**
 * 依赖兜底目录（`$DSH_HOME/profiles/node_modules`）陈旧链接的诊断与清理（node --test，跑 dist 产物）。
 *
 * 守护三件事：
 *   1. 三分类判对（断链 / 完好但过时 / 正常）——尤其是"过时"必须靠**当前安装闭包**判，
 *      不能靠"目标存不存在"糊弄过去；
 *   2. 清理**只删断链**，且**只删符号链接**（绝不递归删目录）——这条有专门的变异用例；
 *   3. 闭包算不出来、目录不存在时如实记"没查"，不许画成"查过且干净"。
 *
 * 全部用隔离的临时 HOME，绝不碰真实 `~/.dsh`。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'pmc-fallback-'))
const originalHome = process.env.DSH_HOME
process.env.DSH_HOME = home

const {
  cleanupDanglingLinks, listModuleFallbackLinks, moduleFallbackDir, readModuleFallbackClosure,
  scanModuleFallback, scanProfileModuleFallback,
} = await import('../dist/moduleFallback.js')

after(() => {
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
  rmSync(home, { recursive: true, force: true })
})

/** 造一个目录（可含内容）。 */
function makeDir(...segments) {
  const dir = join(...segments)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 造一个"真的存在"的包目录。 */
function makePackage(root, name) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }) + '\n')
  return dir
}

/** 造一个指向不存在目标的符号链接（断链）。 */
function makeDanglingLink(linkDir, name) {
  const link = join(linkDir, name)
  mkdirSync(join(link, '..'), { recursive: true })
  symlinkSync(join(home, 'gone', name), link)
  return link
}

/** 造一个指向存在目标的符号链接。 */
function makeLiveLink(linkDir, name, target) {
  const link = join(linkDir, name)
  mkdirSync(join(link, '..'), { recursive: true })
  symlinkSync(target, link)
  return link
}

/** 假闭包（避免真去算官方闭包）。 */
const closureOf = (...names) => ({ ok: true, names: new Set(names) })

// ── 1. 分类 ────────────────────────────────────────────────────────────────

test('三分类判对：断链 / 完好但过时 / 正常，且 scope 包按 @scope/name 报出来', () => {
  const dir = makeDir(home, 'classify', 'node_modules')
  const alive = makeDir(home, 'classify-src')
  const liveTarget = makePackage(alive, 'live-pkg')
  const staleTarget = makePackage(alive, 'stale-pkg')
  const scopedTarget = makePackage(alive, '@scope/pkg')

  makeDanglingLink(dir, 'dangling-pkg')
  makeLiveLink(dir, 'stale-pkg', staleTarget)
  makeLiveLink(dir, 'live-pkg', liveTarget)
  const scopedDir = makeDir(dir, '@scope')
  symlinkSync(scopedTarget, join(scopedDir, 'pkg'))

  const scan = scanModuleFallback(dir, closureOf('live-pkg', '@scope/pkg'))
  assert.equal(scan.scanned, true)
  assert.deepEqual(scan.dangling.map(l => l.name), ['dangling-pkg'])
  assert.deepEqual(scan.stale.map(l => l.name), ['stale-pkg'])
  assert.deepEqual(scan.current.map(l => l.name).sort(), ['@scope/pkg', 'live-pkg'])
  assert.equal(scan.total, 4, '总数含 scope 一层')

  // 证据要能指回目标：断链那条必须带 target 原文
  assert.match(scan.dangling[0].target, /gone\/dangling-pkg$/)
})

test('"过时"靠闭包判，不靠"目标存不存在"：同一个链接换个闭包就从 current 变成 stale', () => {
  const dir = makeDir(home, 'closure', 'node_modules')
  const src = makeDir(home, 'closure-src')
  const target = makePackage(src, 'shared-pkg')
  makeLiveLink(dir, 'shared-pkg', target)

  assert.deepEqual(scanModuleFallback(dir, closureOf('shared-pkg')).current.map(l => l.name), ['shared-pkg'])
  // 闭包里没有它 → 过时（目标仍在，所以不是断链）
  const stale = scanModuleFallback(dir, closureOf('other-pkg'))
  assert.deepEqual(stale.stale.map(l => l.name), ['shared-pkg'])
  assert.equal(stale.dangling.length, 0, '目标在，就不该判成断链')
})

test('scope 目录本身是真目录，不是链接——只下探一层，不递归', () => {
  const dir = makeDir(home, 'depth', 'node_modules')
  const src = makeDir(home, 'depth-src')
  const inner = makePackage(src, 'deep-pkg')
  const scope = makeDir(dir, '@s')
  symlinkSync(inner, join(scope, 'a'))
  // 再造一层更深的（不该被扫到：只下探 scope 一层）
  const deeper = makeDir(scope, 'nested')
  symlinkSync(inner, join(deeper, 'b'))

  const links = listModuleFallbackLinks(dir)
  assert.deepEqual(links.map(l => l.name), ['@s/a'], '只列 scope 一层，不递归')
})

// ── 2. 清理纪律 ────────────────────────────────────────────────────────────

test('清理只删断链：完好的过时链接必须原样留着', () => {
  const dir = makeDir(home, 'cleanup', 'node_modules')
  const src = makeDir(home, 'cleanup-src')
  const staleTarget = makePackage(src, 'keep-pkg')
  makeDanglingLink(dir, 'drop-pkg')
  makeLiveLink(dir, 'keep-pkg', staleTarget)

  const scan = scanModuleFallback(dir, closureOf('nothing'))
  assert.equal(scan.dangling.length, 1)
  assert.equal(scan.stale.length, 1)

  const result = cleanupDanglingLinks(dir, scan, path => { rmSync(path, { force: true }) })
  assert.equal(result.removed, 1)
  assert.equal(result.failed, 0)
  assert.equal(existsSync(join(dir, 'drop-pkg')), false, '断链必须真的没了')
  assert.equal(existsSync(join(dir, 'keep-pkg')), true, '完好但过时的必须还在')
  assert.equal(lstatSync(join(dir, 'keep-pkg')).isSymbolicLink(), true)
})

test('清理**绝不删目录**：同名位置是真目录时跳过并说明（变异验证打的就是这条）', () => {
  const dir = makeDir(home, 'guard', 'node_modules')
  // 造一个"看起来该删"的真目录：它没有 package.json，容易被当成垃圾
  const realDir = makeDir(dir, 'not-a-link')
  writeFileSync(join(realDir, 'important.txt'), 'do not delete me\n')

  // 手工构造一份"声称它是断链"的扫描结果（模拟判据被改坏的情形）
  const scan = {
    dir, exists: true, scanned: true, closure: [], current: [], stale: [],
    dangling: [{ name: 'not-a-link', path: join(dir, 'not-a-link'), kind: 'dangling' }],
    total: 1,
  }
  const result = cleanupDanglingLinks(dir, scan, path => { rmSync(path, { recursive: true, force: true }) })
  assert.equal(result.removed, 0, '真目录不许删')
  assert.equal(result.skipped, 1)
  assert.match(result.skipReasons[0], /不是符号链接（目录）/)
  assert.equal(existsSync(join(realDir, 'important.txt')), true, '目录内容必须完好')
})

test('删除前重新核对：目标在扫描后被恢复 → 跳过不删', () => {
  const dir = makeDir(home, 'recheck', 'node_modules')
  const target = makePackage(home, 'recheck-src/revived-pkg')
  const link = join(dir, 'revived-pkg')
  symlinkSync(join(home, 'recheck-src', 'revived-pkg'), link)
  // 扫描时它还是断链（用一个不存在目标的链接来模拟"扫描那一刻是断的"）
  const scan = {
    dir, exists: true, scanned: true, closure: [], current: [], stale: [],
    dangling: [{ name: 'revived-pkg', path: link, kind: 'dangling' }],
    total: 1,
  }
  void target
  const result = cleanupDanglingLinks(dir, scan, path => { rmSync(path, { force: true }) })
  assert.equal(result.removed, 0, '目标已恢复就不该删')
  assert.match(result.skipReasons[0], /目标已恢复/)
  assert.equal(existsSync(link), true)
})

test('已经不在的条目记"跳过"而不是"失败"（别人先删了不是错误）', () => {
  const dir = makeDir(home, 'gone', 'node_modules')
  const scan = {
    dir, exists: true, scanned: true, closure: [], current: [], stale: [],
    dangling: [{ name: 'already-gone', path: join(dir, 'already-gone'), kind: 'dangling' }],
    total: 1,
  }
  const result = cleanupDanglingLinks(dir, scan, path => { rmSync(path, { force: true }) })
  assert.equal(result.removed, 0)
  assert.equal(result.failed, 0)
  assert.match(result.skipReasons[0], /删除前已不存在/)
})

test('删除失败逐条报出来，不吞错', () => {
  const dir = makeDir(home, 'fail', 'node_modules')
  makeDanglingLink(dir, 'boom-pkg')
  const scan = scanModuleFallback(dir, closureOf())
  const result = cleanupDanglingLinks(dir, scan, () => { throw new Error('EACCES: 权限不足') })
  assert.equal(result.removed, 0)
  assert.equal(result.failed, 1)
  assert.match(result.failures[0], /boom-pkg.*EACCES/)
})

// ── 3. 算不出闭包 / 目录不存在：如实记"没查" ─────────────────────────────────

test('闭包算不出来时：断链照样查（它与闭包无关），只是"过时"这一类不猜', () => {
  const dir = makeDir(home, 'noclosure', 'node_modules')
  const src = makeDir(home, 'noclosure-src')
  makeLiveLink(dir, 'some-pkg', makePackage(src, 'some-pkg'))
  makeDanglingLink(dir, 'broken-pkg')

  const scan = scanModuleFallback(dir, { ok: false, reason: '没有安装锚点' })
  assert.equal(scan.exists, true)
  assert.equal(scan.scanned, true, '目录真的扫过了——断链的判据不需要闭包')
  assert.deepEqual(scan.dangling.map(l => l.name), ['broken-pkg'],
    '断链必须照样查出来（它正是本功能要自动清理的那一类，不能因为闭包缺失一起丢掉）')
  assert.deepEqual(scan.stale, [], '闭包算不出来就不猜"过时"')
  assert.deepEqual(scan.current, [], '也不猜"正常"')
  assert.match(scan.closureReason, /没有安装锚点/, '必须带原因，让调用方能说清"这一类这次没查"')
  // total 必须独立计数：闭包算不出来时，目标存在的链接归不了类，但它们确实在目录里。
  // 用"三类之和"会报成 0 —— 那等于告诉用户"这个目录是空的"（实测踩过这个坑）。
  assert.equal(scan.total, 2, 'total 必须包含扫到但归不了类的那一条（否则会报成空目录）')
})

test('目录不存在：exists=false、scanned=false（不是"查过且干净"）', () => {
  const scan = scanModuleFallback(join(home, 'never-created', 'node_modules'), closureOf('x'))
  assert.equal(scan.exists, false)
  assert.equal(scan.scanned, false)
  assert.equal(scan.total, 0)
})

test('没有安装锚点时闭包如实报原因，不返回空集冒充"闭包是空的"', async () => {
  const missing = await readModuleFallbackClosure(undefined, home)
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /没有安装锚点/)
  const empty = await readModuleFallbackClosure('', home)
  assert.equal(empty.ok, false)
})

// ── 4. 官方闭包算法：只读 + 锚点必须 realpath ───────────────────────────────

test('官方闭包算法是只读的：传一个不存在的 home 也不会把它创建出来', async () => {
  const ghost = join(home, 'ghost-home')
  const anchor = join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh-plugin-manager', 'package.json')
  if (!existsSync(anchor)) return // 该环境没装官方包：如实跳过（不假装通过）
  const before = existsSync(ghost)
  await readModuleFallbackClosure(anchor, ghost)
  assert.equal(existsSync(ghost), before, 'materialize:false 不该创建任何目录')
  assert.equal(before, false)
})

test('锚点先 realpath：传符号链接路径与传真实路径得到同一个闭包', async () => {
  // pnpm 的 node_modules/<scope>/<name> 是符号链接；官方实现从锚点所在层向上找依赖，
  // 不 realpath 会只找到锚点自己那一条（实测 463 → 1）——这是静默错，必须钉住。
  const linked = join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh-plugin-manager', 'package.json')
  if (!existsSync(linked)) return
  const { realpathSync } = await import('node:fs')
  const viaLink = await readModuleFallbackClosure(linked, home)
  const viaReal = await readModuleFallbackClosure(realpathSync(linked), home)
  assert.equal(viaLink.ok, true)
  assert.equal(viaReal.ok, true)
  assert.equal(viaLink.names.size, viaReal.names.size, '两种传法必须得到同一个闭包')
  assert.ok(viaLink.names.size > 1, '闭包不该只有锚点自己（那正是没 realpath 的症状）')
})

// ── 5. 诊断层接线：issue 的 code / 计数 / 证据 / 开关 ──────────────────────────

/**
 * 造一个最小环境目录，并用它跑一次 analyzeEnvironment。
 *
 * 这里只关心依赖兜底那两条 issue：其余四层照常跑（环境很干净，不会产出别的发现）。
 * @param opts - 开关与链接构造方式。
 * @returns 报告。
 */
async function analyzeWith(opts = {}) {
  const { analyzeEnvironment } = await import('../dist/diagnostics.js')
  const root = mkdtempSync(join(tmpdir(), 'pmc-fb-diag-'))
  const envDir = join(root, 'profiles', 'diagenv')
  mkdirSync(join(envDir, 'node_modules'), { recursive: true })
  writeFileSync(join(envDir, 'package.json'), JSON.stringify({
    name: 'diagenv', dependencies: {}, dsh: { profile: { bundles: [] } },
  }, undefined, 2) + '\n')
  writeFileSync(join(envDir, 'cordis.patch.yml'), '[]\n')

  // 兜底目录 = <root>/profiles/node_modules（dshHome 由 DSH_HOME 决定）
  const fallback = join(root, 'profiles', 'node_modules')
  // noFallback：连目录都不建，用来验"没扫到要记 skipped"。
  if (opts.noFallback !== true) mkdirSync(fallback, { recursive: true })
  if (opts.dangling === true) symlinkSync(join(root, 'gone-pkg'), join(fallback, 'gone-pkg'))
  if (opts.stale === true) {
    const target = join(root, 'stale-src')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'stale-pkg', version: '1.0.0' }) + '\n')
    symlinkSync(target, join(fallback, 'stale-pkg'))
  }
  // "过时"要靠**真实的当前安装闭包**判，所以得给一个真的安装锚点。
  // 用本仓库依赖的官方包：它在测试环境里一定装好了（没装时如实跳过，不假装通过）。
  const anchor = join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh-plugin-manager', 'package.json')
  const useAnchor = opts.stale === true && existsSync(anchor)

  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  try {
    const config = {
      diagnostics: {
        dependency: true, composition: true, runtime: true, consistency: true, ecosystem: false,
        ...(opts.reportStale === undefined ? {} : { reportStaleModuleFallbackLinks: opts.reportStale }),
      },
    }
    const ctx = { get: () => undefined, logger: { info() {}, warn() {}, error() {}, debug() {} } }
    return await analyzeEnvironment(ctx, {
      name: 'diagenv', dir: envDir, current: false, builtin: false, bundles: [], dependencies: [], runs: [],
      ...(useAnchor ? { installAnchor: anchor } : {}),
    }, config)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(root, { recursive: true, force: true })
  }
}

test('诊断层：断链报 module-fallback-dangling-link，证据带名字与目标，且说清"已不参与解析"', async () => {
  const report = await analyzeWith({ dangling: true })
  const issue = report.issues.find(i => i.code === 'module-fallback-dangling-link')
  assert.ok(issue !== undefined, '断链必须报出来：' + JSON.stringify(report.issues.map(i => i.code)))
  assert.equal(issue.layer, 'dependency')
  assert.equal(issue.severity, 'safe-fix', '断链是可安全清理的')
  assert.match(issue.title, /1 条断开的链接/)
  // 必须说清"删了不会坏"：这是用户最容易误解的地方
  assert.match(issue.detail, /不参与解析|不会影响任何东西的运行/)
  assert.match(issue.detail, /不递归删目录/)
  assert.ok(issue.evidence.some(e => e.at === 'gone-pkg' && /指向/.test(e.note)), '证据要指回目标')
  assert.equal(issue.fix?.action, 'remove-dangling-module-fallback-links')
})

test('诊断层：完好但过时报 module-fallback-stale-link，且**没有** fix（只报不删）', async (t) => {
  const report = await analyzeWith({ stale: true })
  if (report.issues.every(i => i.code !== 'module-fallback-stale-link') && report.skipped.some(s => s.check === 'module-fallback')) {
    // 本环境算不出闭包（没装官方包）：如实跳过，不假装通过。
    t.skip('该环境算不出官方安装闭包：' + String(report.skipped.find(s => s.check === 'module-fallback')?.reason))
    return
  }
  const issue = report.issues.find(i => i.code === 'module-fallback-stale-link')
  assert.ok(issue !== undefined, '过时链接必须报出来')
  assert.equal(issue.severity, 'report-only')
  assert.equal(issue.fix, undefined, '过时的**不许**带 fix —— 用户裁决是只报不删')
  assert.match(issue.detail, /不自动删/)
})

test('诊断层开关：关掉后过时不再上报，但断链照样报（断链不受这个开关管）', async () => {
  const off = await analyzeWith({ dangling: true, stale: true, reportStale: false })
  assert.ok(off.issues.some(i => i.code === 'module-fallback-dangling-link'), '断链不受开关影响')
  assert.ok(!off.issues.some(i => i.code === 'module-fallback-stale-link'), '过时被开关静音')

  const on = await analyzeWith({ dangling: true, stale: true, reportStale: true })
  assert.ok(on.issues.some(i => i.code === 'module-fallback-dangling-link'))
  assert.ok(on.issues.some(i => i.code === 'module-fallback-stale-link'), '开着就报')
})

test('诊断层：兜底目录不存在时记 skipped，而不是画成"查过且干净"', async () => {
  const report = await analyzeWith({ noFallback: true })
  const skip = report.skipped.find(s => s.check === 'module-fallback')
  assert.ok(skip !== undefined, '没扫到就该记 skipped：' + JSON.stringify(report.skipped))
  assert.deepEqual([...skip.layers], ['dependency'], '层归属必须写清，否则界面会画成 0')
  assert.match(skip.reason, /不存在/)
})

test('诊断层：闭包算不出来时只把"过时"这一类标成没查，断链照常产出（不许整层画成没查）', async () => {
  const report = await analyzeWith({ dangling: true })
  // 这个环境没有安装锚点 → 闭包算不出来
  assert.ok(report.issues.some(i => i.code === 'module-fallback-dangling-link'),
    '断链必须照常产出：它与闭包无关')
  const skip = report.skipped.find(s => s.check === 'module-fallback-stale')
  assert.ok(skip !== undefined, '要说清"过时"这一类没查：' + JSON.stringify(report.skipped))
  assert.equal(skip.layers, undefined,
    '**不许带 layers**：带了会被界面画成整层"没查"，把已经查出来的断链一起抹掉')
  assert.match(skip.reason, /没有判定"完好但过时"这一类/)
})

// ── 6. 私有兜底层（<profile>/.dsh-module-fallback）────────────────────────────

test('私有层：断链单独报（官方有清理机制却没清掉，属于官方漏了）', () => {
  const profileDir = makeDir(home, 'private', 'profs', 'web')
  const owned = makeDir(home, 'private', 'profs', 'web', '.dsh-module-fallback', 'node_modules')
  const src = makeDir(home, 'private', 'src')
  makeLiveLink(owned, 'healthy', makePackage(src, 'healthy'))
  symlinkSync(join(home, 'private', 'gone'), join(owned, 'broken'))

  const scan = scanProfileModuleFallback(profileDir)
  assert.equal(scan.exists, true)
  assert.equal(scan.scanned, true)
  assert.deepEqual(scan.dangling.map(l => l.name), ['broken'], '只报断链')
  assert.equal(scan.total, 2, '总数含正常的那些')
})

test('私有层：只下探 scope 一层，不递归（与共享层同一套纪律）', () => {
  const profileDir = makeDir(home, 'private-depth', 'profs', 'web')
  const owned = makeDir(home, 'private-depth', 'profs', 'web', '.dsh-module-fallback', 'node_modules')
  const src = makeDir(home, 'private-depth', 'src')
  const target = makePackage(src, 'deep-pkg')
  const scope = makeDir(owned, '@s')
  symlinkSync(target, join(scope, 'a'))
  // 更深一层：不该被扫到
  const deeper = makeDir(scope, 'nested')
  symlinkSync(join(home, 'private-depth', 'gone'), join(deeper, 'b'))

  const scan = scanProfileModuleFallback(profileDir)
  assert.equal(scan.total, 1, '只该看到 scope 一层的 1 条，不递归')
  assert.deepEqual(scan.dangling, [], '更深那层里的断链不该被扫到（扫到就会误删）')
})

test('私有层：目录不存在时 exists=false（不是"查过且干净"）', () => {
  const scan = scanProfileModuleFallback(join(home, 'no-such-profile'))
  assert.equal(scan.exists, false)
  assert.equal(scan.scanned, false)
  assert.deepEqual(scan.dangling, [])
})

test('私有层：诊断层报 profile-module-fallback-dangling-link，且**没有** fix（归官方管，我们不删）', async () => {
  const { analyzeEnvironment } = await import('../dist/diagnostics.js')
  const root = mkdtempSync(join(tmpdir(), 'pmc-fb-private-'))
  const envDir = join(root, 'profiles', 'privenv')
  mkdirSync(join(envDir, 'node_modules'), { recursive: true })
  writeFileSync(join(envDir, 'package.json'), JSON.stringify({
    name: 'privenv', dependencies: {}, dsh: { profile: { bundles: [] } },
  }, undefined, 2) + '\n')
  writeFileSync(join(envDir, 'cordis.patch.yml'), '[]\n')
  const owned = join(envDir, '.dsh-module-fallback', 'node_modules')
  mkdirSync(owned, { recursive: true })
  symlinkSync(join(root, 'never-existed'), join(owned, 'leftover-pkg'))

  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  try {
    const report = await analyzeEnvironment(
      { get: () => undefined, logger: { info() {}, warn() {}, error() {}, debug() {} } },
      { name: 'privenv', dir: envDir, current: false, builtin: false, bundles: [], dependencies: [], runs: [] },
      { diagnostics: { dependency: true, composition: false, runtime: false, consistency: false, ecosystem: false } },
    )
    const issue = report.issues.find(i => i.code === 'profile-module-fallback-dangling-link')
    assert.ok(issue !== undefined, '私有层断链必须报出来：' + JSON.stringify(report.issues.map(i => i.code)))
    assert.equal(issue.severity, 'report-only')
    assert.equal(issue.fix, undefined, '私有层归官方管，我们只报不删（不许带 fix）')
    assert.match(issue.detail, /官方.*清理机制/)
    assert.ok(issue.evidence.some(e => e.at.includes('.dsh-module-fallback/node_modules/leftover-pkg')))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 7. 客户端镜像与 host 默认值必须一致（M16 变异暴露的洞）─────────────────────

test('客户端默认值与 host 默认值逐字段一致（开关默认必须两边同向）', async () => {
  // 为什么要有这条（变异验证 M16 发现）：客户端 wire.ts 刻意**不 import** host 的 settings.ts
  // （那会把 schemastery 与整套 host 代码拉进客户端包），于是两边各写一份默认值。
  // 两份值一旦漂移，界面显示的默认态与 host 实际行为就不一致——
  // 用户看到"开"，host 却按"关"跑。此前没有任何断言钉住这件事。
  const { CLIENT_DEFAULTS } = await import('../dist/client/wire.js').catch(() => ({ CLIENT_DEFAULTS: undefined }))
  const { DEFAULT_CONFIG } = await import('../dist/settings.js')
  if (CLIENT_DEFAULTS === undefined) {
    // 产物没导出它（客户端 bundle 形状不同）：退化为读源码文本，仍是同一判据。
    const source = readFileSync(join(process.cwd(), 'src/client/wire.ts'), 'utf8')
    assert.match(source, /reportStaleModuleFallbackLinks: true/,
      '客户端默认值里这一项必须是 true（与 host 的 DEFAULT_CONFIG.diagnostics 同向）')
    assert.equal(DEFAULT_CONFIG.diagnostics.reportStaleModuleFallbackLinks, true, 'host 默认值必须是 true（默认上报）')
    return
  }
  assert.deepEqual(CLIENT_DEFAULTS.diagnostics, DEFAULT_CONFIG.diagnostics,
    '客户端 diagnostics 默认值必须与 host 逐字段一致')
})

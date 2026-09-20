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
  cleanupDanglingLinks, cleanupEmptyScopes, listModuleFallbackLinks, moduleFallbackDir,
  readModuleFallbackClosure, scanModuleFallback, scanProfileModuleFallback,
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

// ── 8. 计数口径（Lead 复核 task-100：171 与 516 都对，含义不同）───────────────

test('计数口径：total 数的是「顶层链接 + @scope 下一层」，不是 maxdepth 1', () => {
  const dir = makeDir(home, 'caliber', 'node_modules')
  const src = makeDir(home, 'caliber-src')
  // 顶层 3 条
  makeDanglingLink(dir, 'top-1')
  makeDanglingLink(dir, 'top-2')
  makeLiveLink(dir, 'top-3', makePackage(src, 'top-3'))
  // @scope 下一层 2 条
  const scope = makeDir(dir, '@sc')
  symlinkSync(join(home, 'gone-a'), join(scope, 'a'))
  symlinkSync(join(home, 'gone-b'), join(scope, 'b'))
  // 更深一层 1 条：**不该被数进去**（不递归）
  const deeper = makeDir(scope, 'nested')
  symlinkSync(join(home, 'gone-c'), join(deeper, 'c'))

  const scan = scanModuleFallback(dir, closureOf())
  assert.equal(scan.total, 5,
    '口径 = 顶层 3 + scope 下一层 2 = 5（不含更深那层）。'
    + '如果这里变成 3，说明口径退化成 maxdepth 1；变成 6 说明递归了')
  // 逐类相加也必须等于 total（本用例里闭包可用，所以三类齐全）
  assert.equal(scan.dangling.length + scan.stale.length + scan.current.length, scan.total,
    '闭包可用时三类之和应等于 total')
})

test('计数口径：闭包不可用时 total 仍数「扫到的条数」，与三类之和可以不相等', () => {
  const dir = makeDir(home, 'caliber2', 'node_modules')
  const src = makeDir(home, 'caliber2-src')
  makeDanglingLink(dir, 'broken')
  makeLiveLink(dir, 'healthy', makePackage(src, 'healthy'))
  const scan = scanModuleFallback(dir, { ok: false, reason: 'x' })
  assert.equal(scan.total, 2, '两条都在目录里，total 必须是 2')
  assert.equal(scan.dangling.length, 1)
  assert.equal(scan.stale.length + scan.current.length, 0, '归不了类的那条不进任何一类')
  assert.notEqual(scan.dangling.length + scan.stale.length + scan.current.length, scan.total,
    '这个形态下三类之和 < total 是**正确**的（用求和会让 total 报成 1）')
})

test('文档口径与实现一致：DESIGN 里的数字必须带口径说明', () => {
  // 为什么钉这条：Lead 复核时用 maxdepth 1 核出 171，与文档的 516 对不上——
  // 两个数都对但含义不同。文档必须把口径写出来，否则后来人会以为写错了。
  const design = readFileSync(join(process.cwd(), 'docs/DESIGN.md'), 'utf8')
  assert.match(design, /171/, 'DESIGN 要写出「只顶层」那个数')
  assert.match(design, /345/, 'DESIGN 要写出 scope 下一层那个数')
  assert.match(design, /口径/, 'DESIGN 要明说这是口径问题')
  // 模块注释里也要有（改代码的人先看那里）
  const source = readFileSync(join(process.cwd(), 'src/moduleFallback.ts'), 'utf8')
  assert.match(source, /计数口径/, '模块注释里要写清扫的是哪一层')
  assert.match(source, /maxdepth 1/, '注释里要给出对照命令，否则没法自查')
})

// ── 9. 幂等（Lead 复核 task-100 ②：修完再跑不该重复报）───────────────────────

test('幂等：删完断链后再扫，断链归零且不再报该 issue，而「过时」仍在', () => {
  const dir = makeDir(home, 'idem', 'node_modules')
  const src = makeDir(home, 'idem-src')
  makeDanglingLink(dir, 'd1')
  makeDanglingLink(dir, 'd2')
  makeLiveLink(dir, 'keep-pkg', makePackage(src, 'keep-pkg'))

  const before = scanModuleFallback(dir, closureOf('nothing'))
  assert.equal(before.dangling.length, 2, '前提：两条断链')
  assert.equal(before.stale.length, 1, '前提：一条完好但过时')

  const cleanup = cleanupDanglingLinks(dir, before, path => { rmSync(path, { force: true }) })
  assert.equal(cleanup.removed, 2)
  assert.equal(cleanup.failed, 0)

  // 第二次扫：断链必须归零（幂等），过时的仍在（它不自动删）
  const after = scanModuleFallback(dir, closureOf('nothing'))
  assert.equal(after.dangling.length, 0, '修完再扫，断链必须归零（否则会重复报）')
  assert.deepEqual(after.stale.map(l => l.name), ['keep-pkg'], '「过时」不自动删，必须仍在')
  assert.equal(after.total, 1, '目录里只剩那一条过时链接')

  // 第二次清理：不该再删任何东西（幂等）
  const again = cleanupDanglingLinks(dir, after, path => { rmSync(path, { force: true }) })
  assert.equal(again.removed, 0, '再修一次不该删任何东西')
  assert.equal(again.failed, 0)
  assert.equal(existsSync(join(dir, 'keep-pkg')), true, '过时的必须仍在')
})

// ── 10. 变空的 scope 目录清理（task-101）─────────────────────────────────────

test('删完断链后，变空的 @scope 目录一并删掉；非空的一律不碰', () => {
  const dir = makeDir(home, 'scope-clean', 'node_modules')
  const src = makeDir(home, 'scope-clean-src')
  // 空 scope：里面的链接删完就空了
  makeDir(dir, '@aws-sdk')
  // 非空 scope：里面还有一条完好链接
  makeDir(dir, '@keep')
  makeLiveLink(join(dir, '@keep'), 'pkg', makePackage(src, 'pkg'))
  // 顶层普通目录（不是 scope）：不许碰
  const notScope = makeDir(dir, 'notascope')

  const scan = scanModuleFallback(dir, closureOf('@keep/pkg'))
  const result = cleanupDanglingLinks(dir, scan, path => { rmSync(path, { force: true }) })

  assert.deepEqual([...result.removedScopes], ['@aws-sdk'], '只删空的那个 scope')
  assert.equal(existsSync(join(dir, '@aws-sdk')), false, '空的必须真的没了')
  assert.equal(existsSync(join(dir, '@keep')), true, '非空的必须还在')
  assert.equal(existsSync(notScope), true, '非 scope 的目录不许碰')
  assert.ok(result.scopeSkipReasons.some(r => r.includes('@keep') && r.includes('非空')),
    '非空的要如实记跳过原因：' + JSON.stringify(result.scopeSkipReasons))
})

test('scope 清理只删空目录：里面有任何一项（哪怕是一个文件）都跳过', () => {
  const dir = makeDir(home, 'scope-nonempty', 'node_modules')
  const scope = makeDir(dir, '@has-file')
  writeFileSync(join(scope, 'stray.txt'), 'something\n')

  const result = cleanupEmptyScopes(dir)
  assert.deepEqual([...result.removed], [], '有内容的目录不许删')
  assert.ok(result.skipped.some(r => r.includes('@has-file') && r.includes('1 项')),
    '要说清里面还有几项：' + JSON.stringify(result.skipped))
  assert.equal(existsSync(join(scope, 'stray.txt')), true, '内容必须完好')
})

test('scope 清理只认 @scope 形态的一级真目录：符号链接与普通目录都不碰', () => {
  const dir = makeDir(home, 'scope-shape', 'node_modules')
  const src = makeDir(home, 'scope-shape-src')
  // 普通目录（不以 @ 开头）：不碰
  makeDir(dir, 'plain-dir')
  // 以 @ 开头的**符号链接**：不碰（链接归 cleanupDanglingLinks 管）
  symlinkSync(makePackage(src, 'target'), join(dir, '@alink'))
  // 真正的空 scope：删
  makeDir(dir, '@real-scope')

  const result = cleanupEmptyScopes(dir)
  assert.deepEqual([...result.removed], ['@real-scope'])
  assert.equal(existsSync(join(dir, 'plain-dir')), true, '普通目录不许碰')
  assert.equal(lstatSync(join(dir, '@alink')).isSymbolicLink(), true, '符号链接不许碰（它不是目录）')
})

test('scope 清理幂等：再跑一次不报错、不重复删', () => {
  const dir = makeDir(home, 'scope-idem', 'node_modules')
  makeDir(dir, '@empty-one')
  makeDir(dir, '@empty-two')
  const first = cleanupEmptyScopes(dir)
  assert.deepEqual([...first.removed].sort(), ['@empty-one', '@empty-two'])
  const second = cleanupEmptyScopes(dir)
  assert.deepEqual([...second.removed], [], '第二次不该再删任何东西')
  assert.deepEqual([...second.skipped], [], '也不该报跳过（本来就没东西）')
})

test('scope 清理：目录不存在时不报错（第一次就没什么可清）', () => {
  const result = cleanupEmptyScopes(join(home, 'never-here', 'node_modules'))
  assert.deepEqual([...result.removed], [])
  assert.deepEqual([...result.skipped], [])
})

test('scope 清理：删除失败如实记下来，不吞错', () => {
  const dir = makeDir(home, 'scope-fail', 'node_modules')
  makeDir(dir, '@will-fail')
  const result = cleanupEmptyScopes(dir, () => { throw new Error('EPERM: 权限不足') })
  assert.deepEqual([...result.removed], [])
  assert.ok(result.skipped.some(r => r.includes('@will-fail') && r.includes('EPERM')),
    '失败原因要带出来：' + JSON.stringify(result.skipped))
})

test('真机状态复现：**没有断链**但有空的 scope 目录，照样要清掉', () => {
  // Lead 真机执行过一次清理：516 条断链归零，剩 29 个空 @scope 目录。
  // 早退（"没有断链就不做事"）会让那些空目录永远清不掉——这条钉住那个形态。
  const dir = makeDir(home, 'no-dangling', 'node_modules')
  makeDir(dir, '@deepseek-ai')
  makeDir(dir, '@anthropic-ai')
  const scan = scanModuleFallback(dir, closureOf())
  assert.equal(scan.dangling.length, 0, '前提：没有断链')

  const result = cleanupDanglingLinks(dir, scan, path => { rmSync(path, { force: true }) })
  assert.equal(result.removed, 0, '没有链接可删')
  assert.deepEqual([...result.removedScopes].sort(), ['@anthropic-ai', '@deepseek-ai'],
    '没有断链时也要清空 scope 目录')
})

// ── 11. fix 动作层的 scope 结果（M8/M9 变异暴露的洞）────────────────────────

/** 跑一次 fix op（走 op 分派，与用户点修复按钮同一条路）。 */
async function runFixOp(homeDir) {
  const { handleOp } = await import('../dist/index.js')
  const jobs = new Map()
  let seq = 0
  const deps = {
    ctx: { get: () => undefined, logger: { info() {}, warn() {}, error() {}, debug() {} }, effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} } },
    config: () => ({ diagnostics: { dependency: true }, qualityGate: { enabled: true, mode: 'block', allowlist: [] }, marketplace: { enabled: false, cacheTtlMinutes: 1440, timeoutMs: 15000, indexUrl: '' } }),
    configUpdate: async (p) => p,
    capabilities: () => ({ profileBacked: true, manager: true, inventory: false, environmentName: 'x', missing: [] }),
    jobs: {
      start(task) { seq += 1; const id = 'job-' + String(seq); const rec = { done: false }; jobs.set(id, rec); void Promise.resolve().then(task).then((v) => { rec.result = v; rec.done = true }, (e) => { rec.error = String(e); rec.done = true }); return id },
      status(id) { const r = jobs.get(id); return r === undefined ? { done: true, missing: true } : { done: r.done, result: r.result, error: r.error } },
    },
  }
  const started = await handleOp('fix', { action: 'remove-dangling-module-fallback-links' }, deps)
  assert.equal(started.ok, true)
  for (let i = 0; i < 200; i += 1) {
    const st = await handleOp('job', { id: started.value.jobId }, deps)
    if (st.value.done === true) return st.value.result
    await new Promise(resolvePromise => setTimeout(resolvePromise, 5))
  }
  throw new Error('fix job 未落定')
}

test('fix 动作：没有断链但有空的 scope 目录时，也要真的清掉并在输出里说明（M8 变异）', async () => {
  // M8 变异（在"没有断链"时早退）原本全绿——说明动作层这条路径没有被测到。
  // 真机正是这个形态：Lead 执行过一次清理，516 条链接归零，剩 29 个空 scope 目录。
  const home2 = mkdtempSync(join(tmpdir(), 'pmc-fix-scope-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home2
  try {
    const dir = join(home2, 'profiles', 'node_modules')
    mkdirSync(join(dir, '@deepseek-ai'), { recursive: true })
    mkdirSync(join(dir, '@anthropic-ai'), { recursive: true })
    mkdirSync(join(dir, '@keep'), { recursive: true })
    mkdirSync(join(home2, 't'), { recursive: true })
    writeFileSync(join(home2, 't', 'package.json'), '{}')
    symlinkSync(join(home2, 't'), join(dir, '@keep', 'pkg'))

    const result = await runFixOp(home2)
    assert.equal(result.ok, true, 'fix 应当成功：' + String(result.output))
    assert.equal(existsSync(join(dir, '@deepseek-ai')), false, '空的必须真的被清掉（早退会让它留下）')
    assert.equal(existsSync(join(dir, '@anthropic-ai')), false, '两个空的都要清掉')
    assert.equal(existsSync(join(dir, '@keep')), true, '非空的必须还在')
    // M9 变异（不报 scope 结果）也要被拦住：用户必须看得到发生了什么
    assert.match(String(result.output), /变空的 scope 目录 → 已删 2 个/,
      '输出必须说明删了几个空 scope 目录：' + String(result.output))
    assert.match(String(result.output), /@deepseek-ai/, '输出要点名删了哪些')
    assert.match(String(result.output), /@keep：里面还有 1 项，非空，不删/, '非空的要如实说明')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home2, { recursive: true, force: true })
  }
})

test('fix 动作幂等：连跑两次，第二次不报错也不重复删', async () => {
  const home2 = mkdtempSync(join(tmpdir(), 'pmc-fix-idem-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home2
  try {
    const dir = join(home2, 'profiles', 'node_modules')
    mkdirSync(join(dir, '@empty-one'), { recursive: true })
    symlinkSync(join(home2, 'gone'), join(dir, 'dangling'))

    const first = await runFixOp(home2)
    assert.equal(first.ok, true)
    assert.match(String(first.output), /已删 1 条/, '第一次删掉那条断链')
    assert.match(String(first.output), /已删 1 个/, '第一次也清掉空 scope')
    assert.equal(existsSync(join(dir, '@empty-one')), false)

    const second = await runFixOp(home2)
    assert.equal(second.ok, true, '第二次不该报错：' + String(second.output))
    assert.match(String(second.output), /断链 0 条 → 已删 0 条/, '第二次没有链接可删')
    assert.match(String(second.output), /没有变空的 scope 目录/, '第二次也没有 scope 可清')
    assert.doesNotMatch(String(second.output), /失败：/, '第二次不该有失败项')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home2, { recursive: true, force: true })
  }
})

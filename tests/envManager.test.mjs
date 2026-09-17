/**
 * 环境管理引擎的验收测试。
 *
 * 被验的代码是构建产物 dist/envManager.js —— 线上跑的就是被验的那份。
 * 环境事实全部在临时 DSH_HOME 里造，绝不触碰真实的 ~/.dsh。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'pmc-env-test-'))
process.env.DSH_HOME = HOME

const env = await import('../dist/envManager.js')
const paths = await import('../dist/paths.js')

const PROFILES = join(HOME, 'profiles')

/** 造一个有 package.json 的环境目录。 */
function makeEnv(name, { bundles = [], dependencies = {}, manifest } = {}) {
  const dir = join(PROFILES, name)
  mkdirSync(dir, { recursive: true })
  const document = manifest ?? {
    name: 'dsh-profile-' + name,
    private: true,
    dependencies,
    dsh: { profile: { bundles } },
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(document, undefined, 2) + '\n')
  return dir
}

function readManifest(name) {
  return JSON.parse(readFileSync(join(PROFILES, name, 'package.json'), 'utf8'))
}

/** 在环境里放一个真的能被官方 bundle 解析器认出来的本地 bundle 包。 */
function addResolvableBundle(envName, bundleName = '@fake/dsh-bundle') {
  const dir = join(PROFILES, envName, 'node_modules', bundleName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: bundleName,
    version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, undefined, 2) + '\n')
  writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
  return dir
}

/** 假的 host 上下文：只提供官方 profileContext。 */
function fakeCtx(current) {
  return {
    get(key) {
      return key === 'profileContext'
        ? { name: current, installAnchor: '/anchor/package.json', cwd: '/anchor', home: HOME }
        : undefined
    },
  }
}

function sleep(ms) {
  return new Promise((done) => { setTimeout(done, ms) })
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() > deadline) return false
    await sleep(50)
  }
}

after(() => { rmSync(HOME, { recursive: true, force: true }) })

test('isSafeEnvironmentName 拒绝路径穿越，环境名校验一致', async () => {
  assert.equal(paths.isSafeEnvironmentName('..'), false)
  assert.equal(paths.isSafeEnvironmentName('.'), false)
  assert.equal(paths.isSafeEnvironmentName('../x'), false)
  assert.equal(paths.isSafeEnvironmentName('a/b'), false)
  assert.equal(paths.isSafeEnvironmentName(''), false)
  assert.equal(paths.isSafeEnvironmentName('a'.repeat(121)), false)
  assert.equal(paths.isSafeEnvironmentName('ok-name_1.ts'), true)
  assert.match(env.environmentNameProblem('..'), /不合法/)
  assert.equal(env.environmentNameProblem('ok-name'), null)
  // 引擎的每个入口都必须先过这道校验，且不得产生任何文件系统副作用。
  for (const result of [
    await env.createEnvironment('..'),
    await env.renameEnvironment('..', 'x'),
    await env.removeEnvironment('..'),
    await env.startEnvironment('..'),
    await env.stopEnvironment('..'),
  ]) {
    assert.equal(result.ok, false)
    assert.equal(result.code, 'invalid-name')
  }
})

test('listEnvironments 识别 builtin / current / bundles / 依赖 / runs', () => {
  makeEnv('web', { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] })
  makeEnv('headless', { bundles: ['@deepseek-ai/dsh-base'], dependencies: { 'pkg-a': '^1.0.0' } })
  makeEnv('custom', { bundles: ['@deepseek-ai/dsh-base'], dependencies: { 'pkg-b': 'link:../pkg-b' } })
  // 这两个都不是环境：node_modules 是共享回退位置，另一个没有 package.json。
  mkdirSync(join(PROFILES, 'node_modules'), { recursive: true })
  writeFileSync(join(PROFILES, 'node_modules', 'package.json'), '{}\n')
  mkdirSync(join(PROFILES, 'no-manifest'), { recursive: true })
  // 坏 manifest 的环境仍要出现在列表里，只是 bundles/依赖为空。
  makeEnv('broken', { manifest: '{ not json' })
  writeFileSync(join(PROFILES, 'broken', 'package.json'), '{ not json')

  const runs = new Map([['headless', [{ pid: 7, port: 4321, command: 'node dsh bin.js headless' }]]])
  const list = env.listEnvironments(fakeCtx('web'), { runs })
  const byName = new Map(list.map((item) => [item.name, item]))

  assert.deepEqual([...byName.keys()], ['broken', 'custom', 'headless', 'web'])
  assert.equal(byName.get('web').builtin, true)
  assert.equal(byName.get('web').current, true)
  assert.equal(byName.get('headless').builtin, true)
  assert.equal(byName.get('headless').current, false)
  assert.deepEqual(byName.get('headless').bundles, ['@deepseek-ai/dsh-base'])
  assert.deepEqual(byName.get('headless').dependencies, ['pkg-a'])
  assert.deepEqual(byName.get('headless').runs.map((run) => [run.pid, run.port]), [[7, 4321]])
  assert.deepEqual(byName.get('custom').runs, [])
  assert.equal(byName.get('custom').builtin, false)
  assert.equal(byName.get('custom').current, false)
  assert.equal(byName.get('web').dir, join(PROFILES, 'web'))
})

test('scanRuns：解析、TTL 缓存、fresh 绕过缓存', () => {
  makeEnv('runme')
  env.resetRunCache()
  const lines = [
    // 真实形态一：安装目录里的 bin.js + 位置参数（本机实测）
    '4242 node /opt/apps/@deepseek-ai/dsh/lib/bin.js runme --port 4321 --no-open',
    // 入口不像 dsh：不能当成实例（否则 stop 会对无关进程发 SIGTERM）
    '4243 node /srv/other/bin.js runme --port 4322',
    // 一次性包操作：不是常驻实例
    '4244 dsh plugin --profile runme add pkg',
    // 环境目录不存在
    '4245 node /opt/apps/@deepseek-ai/dsh/lib/bin.js ghost --port 1',
    // 真实形态二：--profile 显式形式 + --port= 写法
    '4246 dsh --profile runme --port=4323',
    // 诊断类一次性命令
    '4247 node /opt/apps/@deepseek-ai/dsh/lib/bin.js --dump-config --profile runme',
    'not-a-process-line',
  ]
  let reads = 0
  let clock = 1_000
  const options = { reader: () => { reads += 1; return lines }, now: () => clock }

  const first = env.scanRuns(options)
  assert.equal(reads, 1)
  assert.deepEqual((first.get('runme') ?? []).map((run) => [run.pid, run.port]), [[4242, 4321], [4246, 4323]])
  assert.equal(first.has('ghost'), false)

  assert.equal(env.scanRuns(options), first, 'TTL 内必须复用同一份扫描结果')
  assert.equal(reads, 1, 'TTL 内不得重新扫描')

  clock += env.SCAN_RUNS_TTL_MS + 1
  env.scanRuns(options)
  assert.equal(reads, 2, 'TTL 过后必须重新扫描')

  env.scanRuns({ ...options, fresh: true })
  assert.equal(reads, 3, 'fresh 必须绕过缓存')
  env.resetRunCache()
})

test('startEnvironment：已在运行会拒绝、端口就绪与超时、命令组装', async () => {
  makeEnv('starter')
  const launched = []
  const ok = await env.startEnvironment('starter', {
    mode: 'background',
    port: 4600,
    launch: async (spec) => { launched.push(spec); return { ok: true, detail: 'fake-launch' } },
    probe: async (port) => port === 4600,
    sleep: async () => {},
    now: () => 0,
  })
  assert.equal(ok.ok, true, ok.output)
  assert.match(ok.output, /127\.0\.0\.1:4600/)
  assert.equal(launched.length, 1)
  assert.equal(launched[0].profile, 'starter')
  assert.equal(launched[0].mode, 'background')
  assert.deepEqual([...launched[0].args], ['--profile', 'starter', '--port', '4600'])

  let clock = 0
  const timedOut = await env.startEnvironment('starter', {
    port: 4601,
    readyTimeoutMs: 1_000,
    launch: async () => ({ ok: true, detail: 'fake-launch' }),
    probe: async () => false,
    sleep: async () => {},
    now: () => (clock += 400),
  })
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.code, 'timeout')
  assert.match(timedOut.output, /4601/)

  const failed = await env.startEnvironment('starter', {
    port: 4602,
    launch: async () => ({ ok: false, detail: '没有可用终端' }),
  })
  assert.equal(failed.code, 'launch-failed')

  assert.equal((await env.startEnvironment('ghost-env')).code, 'not-found')

  // 已在运行：把一份「看起来在跑」的扫描灌进缓存，守卫必须命中并给出端口。
  env.scanRuns({
    reader: () => ['777 node /opt/apps/@deepseek-ai/dsh/lib/bin.js starter --port 4610'],
    fresh: true,
  })
  const running = await env.startEnvironment('starter', { launch: async () => ({ ok: true, detail: 'x' }) })
  assert.equal(running.ok, false)
  assert.equal(running.code, 'running')
  assert.match(running.output, /4610/)
  env.resetRunCache()
})

test('stopEnvironment：拒绝当前环境、未运行时报 not-running', async () => {
  makeEnv('idle')
  const notRunning = await env.stopEnvironment('idle')
  assert.equal(notRunning.code, 'not-running')
  assert.equal((await env.stopEnvironment('nope')).code, 'not-found')
  const current = await env.stopEnvironment('idle', { ctx: fakeCtx('idle') })
  assert.equal(current.ok, false)
  assert.equal(current.code, 'current')
})

test('stopEnvironment 按 pid 精确 kill 真实进程（绝不 pkill）', { skip: process.platform === 'win32' }, async () => {
  makeEnv('stopme')
  // 一个命令行长相与真实实例一致的自有进程：入口路径含 @deepseek-ai/dsh，位置参数是环境名。
  const entry = join(HOME, 'fake-install', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  mkdirSync(dirname(entry), { recursive: true })
  writeFileSync(entry, 'setTimeout(() => {}, 60000)\n')
  const child = spawn(process.execPath, [entry, 'stopme', '--port', '4999'], { stdio: 'ignore' })
  const exited = new Promise((done) => child.once('exit', () => done(true)))
  try {
    const found = await waitFor(() => (env.scanRuns({ fresh: true }).get('stopme') ?? [])
      .some((run) => run.pid === child.pid))
    assert.equal(found, true, '进程扫描必须能按命令行认出这个实例')
    env.resetRunCache()
    const result = await env.stopEnvironment('stopme')
    assert.equal(result.ok, true, result.output)
    assert.match(result.output, new RegExp(String(child.pid)))
    const gone = await Promise.race([exited, sleep(5_000).then(() => false)])
    assert.equal(gone, true, '实例必须真的退出')
    assert.equal(paths.isSafeEnvironmentName('stopme'), true)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    env.resetRunCache()
  }
})

test('进程表指错 pid 时拒绝 kill（误杀防护）', { skip: process.platform === 'win32' }, async () => {
  makeEnv('stopme2')
  // 一个真实存活、但命令行完全不属于该环境的进程。
  const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
  try {
    // 伪造一条指向该 pid 的进程表记录：stop 必须在 kill 前复核命令行并拒绝。
    env.scanRuns({
      reader: () => [String(bystander.pid) + ' node /opt/apps/@deepseek-ai/dsh/lib/bin.js stopme2 --port 4998'],
      fresh: true,
    })
    const result = await env.stopEnvironment('stopme2')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'not-running')
    assert.match(result.output, /拒绝 kill/)
    await sleep(50)
    assert.equal(bystander.exitCode, null, '无关进程必须活着')
    assert.equal(bystander.signalCode, null, '无关进程不得收到信号')
  } finally {
    env.resetRunCache()
    if (bystander.exitCode === null && bystander.signalCode === null) bystander.kill('SIGKILL')
  }
})

test('createEnvironment 用官方模板；renameEnvironment 的拒绝面', async () => {
  const created = await env.createEnvironment('fresh', 'web')
  assert.equal(created.ok, true, created.output)
  // bundle 层栈必须逐字等于官方 PROFILE_TEMPLATES['web']，不是本仓库手抄的
  assert.deepEqual(readManifest('fresh').dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  // 骨架来自官方 initProfile
  const patch = readFileSync(join(PROFILES, 'fresh', 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /^# Your patch layer for this dsh profile/)
  assert.equal(existsSync(join(PROFILES, 'fresh', 'pnpm-workspace.yaml')), true)

  const plain = await env.createEnvironment('plain')
  assert.deepEqual(readManifest('plain').dsh.profile.bundles, ['@deepseek-ai/dsh-base'])
  assert.equal((await env.createEnvironment('fresh2', 'nope')).code, 'unknown-template')
  assert.equal((await env.createEnvironment('web')).code, 'builtin')
  assert.equal((await env.createEnvironment('fresh')).code, 'already-exists')

  const templates = env.environmentTemplates()
  assert.ok(templates.some((item) => item.name === 'web' && item.bundles.includes('@deepseek-ai/dsh-web-app')))
  assert.deepEqual(templates.find((item) => item.name === 'headless').bundles,
    ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'])

  assert.equal((await env.renameEnvironment('fresh', 'web')).code, 'builtin')
  assert.equal((await env.renameEnvironment('fresh', 'headless')).code, 'builtin')
  assert.equal((await env.renameEnvironment('fresh', 'x', { current: 'fresh' })).code, 'current')
  assert.equal((await env.renameEnvironment('fresh', 'plain')).code, 'already-exists')
  assert.equal((await env.renameEnvironment('ghost', 'other')).code, 'not-found')
  const renamed = await env.renameEnvironment('fresh', 'renamed', { current: 'web' })
  assert.equal(renamed.ok, true, renamed.output)
  assert.equal(existsSync(join(PROFILES, 'fresh')), false)
  assert.deepEqual(readManifest('renamed').dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
})

test('removeEnvironment 拒绝 builtin 与 current，正常删除走通', async () => {
  makeEnv('custom')
  makeEnv('web', { bundles: ['@deepseek-ai/dsh-base'] })

  const builtin = await env.removeEnvironment('web', { current: 'custom' })
  assert.equal(builtin.ok, false)
  assert.equal(builtin.code, 'builtin')

  const current = await env.removeEnvironment('custom', { ctx: fakeCtx('custom') })
  assert.equal(current.ok, false)
  assert.equal(current.code, 'current')
  assert.equal(existsSync(join(PROFILES, 'custom')), true, '拒绝后目录必须原样保留')

  assert.equal((await env.removeEnvironment('ghost')).code, 'not-found')

  const removed = await env.removeEnvironment('custom', { current: 'web' })
  assert.equal(removed.ok, true, removed.output)
  assert.equal(existsSync(join(PROFILES, 'custom')), false)
})

test('copyPlugins 走官方 operations，只换 profile 参数', async () => {
  makeEnv('src', { bundles: ['@deepseek-ai/dsh-base'], dependencies: { 'pkg-a': '^1.2.3', 'pkg-local': 'link:../shared' } })
  makeEnv('dst')
  mkdirSync(join(PROFILES, 'shared'), { recursive: true })

  // 拿不到官方 installAnchor：必须明确失败，绝不猜路径
  const noContext = await env.copyPlugins('src', 'dst', ['pkg-a'])
  assert.equal(noContext.ok, false)
  assert.equal(noContext.code, 'no-profile-context')

  assert.equal((await env.copyPlugins('missing', 'dst', ['pkg-a'], { installAnchor: '/anchor/package.json' })).code, 'not-found')
  assert.equal((await env.copyPlugins('src', 'dst', [], { installAnchor: '/anchor/package.json' })).code, 'empty-selection')

  const calls = []
  const runCommand = async (context, args, options) => {
    calls.push({ context, args, options })
    return { exitCode: 0, output: 'ok', truncated: false, logPath: '/dev/null' }
  }
  const result = await env.copyPlugins('src', 'dst', ['pkg-a', 'pkg-local'], {
    ctx: fakeCtx('web'),
    installAnchor: '/anchor/package.json',
    runCommand,
  })
  assert.equal(result.ok, true, result.output)
  assert.equal(calls.length, 2)
  // 同一套官方通道：目标环境只是 profile 参数
  assert.equal(calls[0].context.profile, 'dst')
  assert.equal(calls[0].context.dir, join(PROFILES, 'dst'))
  assert.equal(calls[0].context.installAnchor, '/anchor/package.json')
  assert.equal(calls[0].context.cwd, join(PROFILES, 'src'))
  assert.equal(calls[0].options.execution, 'service')
  assert.deepEqual(calls[0].args, ['add', '^1.2.3'])
  // 本地来源按源环境目录解析成绝对路径，否则会指向目标的邻居目录
  assert.deepEqual(calls[1].args, ['add', 'link:' + join(PROFILES, 'shared')])

  const failing = await env.copyPlugins('src', 'dst', ['pkg-a'], {
    installAnchor: '/anchor/package.json',
    runCommand: async () => ({ exitCode: 1, output: 'boom', truncated: false, logPath: '/dev/null' }),
  })
  assert.equal(failing.ok, false)
  assert.equal(failing.code, 'package-operation-failed')
})

test('backupDiff 四类差异 + 不合法备份被拒', () => {
  const sharedDir = join(HOME, 'shared-pkg')
  mkdirSync(sharedDir, { recursive: true })
  makeEnv('bsrc', {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
    dependencies: {
      installed: '^1.0.0',
      'missing-pkg': '^2.0.0',
      'local-ok': 'link:' + sharedDir,
      'local-gone': 'link:' + join(HOME, 'gone-pkg'),
    },
  })
  makeEnv('bdst', { bundles: ['@deepseek-ai/dsh-base'], dependencies: { installed: '^1.0.0' } })

  const backup = env.backupExport('bsrc')
  assert.equal(backup.format, env.BACKUP_FORMAT)
  assert.equal(backup.version, 1)
  assert.equal(backup.environment, 'bsrc')
  assert.deepEqual(backup.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  assert.deepEqual(Object.keys(backup.dependencies), ['installed', 'missing-pkg', 'local-ok', 'local-gone'])

  const diff = env.backupDiff(backup, 'bdst')
  assert.deepEqual(diff.missing.map((entry) => entry.name).sort(), ['local-ok', 'missing-pkg'])
  assert.deepEqual(diff.missing.find((entry) => entry.name === 'local-ok').source, 'link:' + sharedDir)
  assert.deepEqual(diff.already, ['installed'])
  assert.deepEqual(diff.missingProfiles, [])
  assert.equal(diff.unrestorable.length, 1)
  assert.match(diff.unrestorable[0], /local-gone/)
  assert.equal(diff.ok, false)
  assert.deepEqual(diff.bundlesMissing, ['@deepseek-ai/dsh-web-app'])

  // 第二类：目标环境不存在
  const missingTarget = env.backupDiff(backup, 'no-such-env')
  assert.deepEqual(missingTarget.missingProfiles, ['no-such-env'])
  assert.deepEqual(missingTarget.missing, [])
  assert.equal(missingTarget.ok, false)

  // 四类都干净时 ok 为真
  const clean = env.backupDiff(env.backupExport('bdst'), 'bdst')
  assert.equal(clean.ok, true)
  assert.deepEqual(clean.missing, [])
  assert.deepEqual(clean.already, ['installed'])
  assert.deepEqual(clean.bundlesMissing, [])

  assert.throws(() => env.backupDiff({ ...backup, format: 'nope' }, 'bdst'),
    (error) => error.code === 'unsafe-backup')
  assert.throws(() => env.backupDiff({ ...backup, dependencies: { '../evil': '^1.0.0' } }, 'bdst'),
    (error) => error.code === 'unsafe-backup')
  assert.throws(() => env.backupDiff({ ...backup, bundles: 'x' }, 'bdst'),
    (error) => error.code === 'unsafe-backup')
  assert.throws(() => env.backupExport('ghost'), (error) => error.code === 'not-found')
})

test('backupRestore：先差异、后按官方通道重装、锁下补回 bundle 层栈', async () => {
  const sharedDir = join(HOME, 'shared-pkg')
  makeEnv('bsrc', {
    bundles: ['@deepseek-ai/dsh-base', '@fake/dsh-bundle'],
    dependencies: { 'missing-pkg': '^2.0.0', 'local-ok': 'link:' + sharedDir },
  })
  makeEnv('restore-target', { bundles: ['@deepseek-ai/dsh-base'], dependencies: {} })
  addResolvableBundle('restore-target')
  const backup = env.backupExport('bsrc')
  const before = env.backupDiff(backup, 'restore-target')
  assert.equal(before.missing.length, 2)
  assert.deepEqual(before.bundlesMissing, ['@fake/dsh-bundle'])

  const calls = []
  const runCommand = async (context, args) => {
    calls.push({ profile: context.profile, args })
    return { exitCode: 0, output: '# installed', truncated: false, logPath: '/dev/null' }
  }

  // 演练：只算差异，不写入
  const dry = await env.backupRestore(backup, 'restore-target', { dryRun: true, installAnchor: '/anchor/package.json', runCommand })
  assert.equal(dry.ok, true)
  assert.match(dry.output, /演练/)
  assert.equal(calls.length, 0)

  const restored = await env.backupRestore(backup, 'restore-target', {
    installAnchor: '/anchor/package.json',
    runCommand,
  })
  assert.equal(restored.ok, true, restored.output)
  assert.deepEqual(calls.map((call) => call.profile), ['restore-target', 'restore-target'])
  assert.deepEqual(calls.map((call) => call.args), [['add', '^2.0.0'], ['add', 'link:' + sharedDir]])
  // bundle 层栈由官方 writeProfileBundles 在官方文件锁下补回；依赖不由我们手写
  const manifest = readManifest('restore-target')
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@fake/dsh-bundle'])
  assert.deepEqual(Object.keys(manifest.dependencies), [])

  // 解析不到、也不声明 dsh.bundle 的层绝不写回（照写会让 profile 下次启动失败）
  const unresolvableBundle = {
    format: env.BACKUP_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    environment: 'restore-target',
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
    dependencies: {},
  }
  const skipped = await env.backupRestore(unresolvableBundle, 'restore-target', {
    installAnchor: '/anchor/package.json',
    runCommand,
  })
  assert.equal(skipped.ok, false)
  assert.equal(skipped.code, 'unrestorable')
  assert.match(skipped.output, /未补回 @deepseek-ai\/dsh-web-app/)
  assert.deepEqual(readManifest('restore-target').dsh.profile.bundles,
    ['@deepseek-ai/dsh-base', '@fake/dsh-bundle'], '不安全的层不得写进层栈')

  // 没有缺失时如实说没有内容可恢复
  const nothing = await env.backupRestore(env.backupExport('restore-target'), 'restore-target', {
    installAnchor: '/anchor/package.json',
    runCommand,
  })
  assert.equal(nothing.ok, true, nothing.output)
  assert.match(nothing.output, /没有需要恢复的内容/)

  // 目标环境不存在
  const missingTarget = await env.backupRestore(backup, 'ghost-target', {
    installAnchor: '/anchor/package.json',
    runCommand,
  })
  assert.equal(missingTarget.code, 'not-found')

  // 只有不可恢复条目
  const unrestorableOnly = {
    format: env.BACKUP_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    environment: 'restore-target',
    bundles: ['@deepseek-ai/dsh-base', '@fake/dsh-bundle'],
    dependencies: { gone: 'link:' + join(HOME, 'nowhere') },
  }
  const onlyUnrestorable = await env.backupRestore(unrestorableOnly, 'restore-target', {
    installAnchor: '/anchor/package.json',
    runCommand,
  })
  assert.equal(onlyUnrestorable.ok, false)
  assert.equal(onlyUnrestorable.code, 'unrestorable')

  // 官方通道抛异常（例如 pnpm 成功后的对账阶段炸了）：单个条目失败不带走整批
  const throwing = await env.backupRestore(backup, 'restore-target', {
    installAnchor: '/anchor/package.json',
    runCommand: async () => { throw new Error('official reconcile blew up') },
  })
  assert.equal(throwing.ok, false)
  assert.equal(throwing.code, 'package-operation-failed')
  assert.match(throwing.output, /official reconcile blew up/)

  // 拿不到 installAnchor 时恢复必须明确失败（差异算完、动手之前），且不得调用官方通道
  const callsBefore = calls.length
  const noAnchor = await env.backupRestore(backup, 'restore-target', { runCommand })
  assert.equal(noAnchor.code, 'no-profile-context')
  assert.equal(calls.length, callsBefore, '拿不到 installAnchor 时不得调用官方通道')
})

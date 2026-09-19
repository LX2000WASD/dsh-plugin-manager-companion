/**
 * 环境管理引擎的验收测试。
 *
 * 被验的代码是构建产物 dist/envManager.js —— 线上跑的就是被验的那份。
 * 环境事实全部在临时 DSH_HOME 里造，绝不触碰真实的 ~/.dsh。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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


/**
 * 忠实的"官方安装成功"夹具：真装成功时官方会写 dependencies 并把**声明了 dsh.bundle 的**
 * 新依赖激活进 dsh.profile.bundles（task-80 的守卫据此判定"是否真的验证到了"）。
 * 早期桩件只返回 exitCode 0、环境里什么都不改——那种桩件掩盖了假通过，已被守卫拦下。
 *
 * @param name - 装进测试环境的包名。
 * @param {object} [options] - `activate: false` 模拟"装上了但没进层栈"（脏环境/无 bundle 声明）。
 * @returns 可直接当 runCommand 注入的假运行器。
 */
function installRunner(name, { activate = true } = {}) {
  return async (context) => {
    const path = join(context.dir, 'package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    manifest.dependencies = { ...manifest.dependencies, [name]: 'link:/fixture/' + name }
    if (activate) {
      const bundles = manifest.dsh?.profile?.bundles ?? []
      if (!bundles.includes(name)) {
        manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...bundles, name] } }
      }
    }
    writeFileSync(path, JSON.stringify(manifest, undefined, 2) + '\n')
    return { exitCode: 0, output: 'ok', truncated: false, logPath: '/dev/null' }
  }
}

/** 在环境里放一个真的能被官方 bundle 解析器认出来的本地 bundle 包。 */
function addBundleFixture(envName, bundleName, { webserver = false } = {}) {
  const dir = join(PROFILES, envName, 'node_modules', bundleName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: bundleName,
    version: '1.0.0',
    // 只有 web 层的 bundle 才声明官方 webserver 依赖（官方 web-app 的真实特征）。
    ...(webserver ? { dependencies: { '@deepseek-ai/dsh-host-webserver': '^0.1.6' } } : {}),
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, undefined, 2) + '\n')
  writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
  return dir
}

function addResolvableBundle(envName, bundleName = '@fake/dsh-bundle') {
  return addBundleFixture(envName, bundleName)
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

test('startEnvironment：已在运行会拒绝、HTTP 就绪与超时、命令组装', async () => {
  makeEnv('starter')
  const launched = []
  const ok = await env.startEnvironment('starter', {
    mode: 'background',
    port: 4600,
    launch: async (spec) => { launched.push(spec); return { ok: true, detail: 'fake-launch', mode: 'background' } },
    probe: async (port) => (port === 4600 ? 401 : null),
    sleep: async () => {},
    now: () => 0,
  })
  assert.equal(ok.ok, true, ok.output)
  assert.match(ok.output, /127\.0\.0\.1:4600/)
  assert.match(ok.output, /GET \/ -> 401/)
  assert.match(ok.output, /启动方式：后台/)
  assert.equal(launched.length, 1)
  assert.equal(launched[0].profile, 'starter')
  assert.equal(launched[0].mode, 'background')
  assert.deepEqual([...launched[0].args], ['--profile', 'starter', '--port', '4600'])

  let clock = 0
  const timedOut = await env.startEnvironment('starter', {
    port: 4601,
    readyTimeoutMs: 1_000,
    launch: async () => ({ ok: true, detail: 'fake-launch', mode: 'background' }),
    probe: async () => null,
    sleep: async () => {},
    now: () => (clock += 400),
  })
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.code, 'timeout')
  assert.match(timedOut.output, /4601/)

  const failed = await env.startEnvironment('starter', {
    port: 4602,
    launch: async () => ({ ok: false, detail: '没有可用终端', mode: 'background' }),
  })
  assert.equal(failed.code, 'launch-failed')

  assert.equal((await env.startEnvironment('ghost-env')).code, 'not-found')

  // 已在运行：把一份「看起来在跑」的扫描灌进缓存，守卫必须命中并给出端口。
  env.scanRuns({
    reader: () => ['777 node /opt/apps/@deepseek-ai/dsh/lib/bin.js starter --port 4610'],
    fresh: true,
  })
  const running = await env.startEnvironment('starter', {
    launch: async () => ({ ok: true, detail: 'x', mode: 'background' }),
  })
  assert.equal(running.ok, false)
  assert.equal(running.code, 'running')
  assert.match(running.output, /4610/)
  env.resetRunCache()
})

test('F1: 创建环境默认走官方 web 模板（层栈逐字来自官方 PROFILE_TEMPLATES）', async () => {
  const official = await import('@deepseek-ai/dsh-app-boot')
  assert.equal(env.DEFAULT_ENVIRONMENT_TEMPLATE, 'web')
  // op 暴露给客户端的清单必须与官方常量逐字一致（本仓库不维护任何 bundle 名单）
  const listed = env.environmentTemplates().map((item) => [item.name, [...item.bundles]]).sort()
  const expected = Object.entries(official.PROFILE_TEMPLATES).map(([name, tpl]) => [name, [...tpl.bundles]]).sort()
  assert.deepEqual(listed, expected)

  const created = await env.createEnvironment('tpl-default')
  assert.equal(created.ok, true, created.output)
  assert.deepEqual(readManifest('tpl-default').dsh.profile.bundles, [...official.PROFILE_TEMPLATES.web.bundles])
  // 默认层栈**不是**官方 DEFAULT_PROFILE_BUNDLES：那样建出来的环境没有任何 web 服务（实测 30s 超时）
  assert.notDeepEqual(readManifest('tpl-default').dsh.profile.bundles, [...official.DEFAULT_PROFILE_BUNDLES])
  const headless = await env.createEnvironment('tpl-headless', 'headless')
  assert.equal(headless.ok, true, headless.output)
  assert.deepEqual(readManifest('tpl-headless').dsh.profile.bundles, [...official.PROFILE_TEMPLATES.headless.bundles])
  // web 层判定派生自官方常量（不是我们抄的名字表）
  assert.deepEqual([...env.officialWebAppBundles()],
    official.PROFILE_TEMPLATES.web.bundles.filter((name) => !official.DEFAULT_PROFILE_BUNDLES.includes(name)))
})

test('F2: 就绪判据是官方 HTTP 应答，TCP 可连接（404）不算就绪', async () => {
  makeEnv('httpenv')
  const statuses = [404, 404, 401]
  const calls = []
  const ok = await env.startEnvironment('httpenv', {
    mode: 'background',
    port: 4800,
    launch: async () => ({ ok: true, detail: 'x', mode: 'background' }),
    probe: async (port) => {
      const status = statuses[Math.min(calls.length, statuses.length - 1)]
      calls.push([port, status])
      return status
    },
    sleep: async () => {},
    now: () => 0,
  })
  assert.equal(ok.ok, true, ok.output)
  assert.equal(calls.length, 3, '404 必须继续等，不能当成就绪')
  assert.deepEqual(calls.map(([, status]) => status), [404, 404, 401])
  assert.match(ok.output, /GET \/ -> 401/)

  // 端口一直可连接、但路由始终 404：必须超时失败，而不是 ok=true 给出一个 404 的 url
  let clock = 0
  const stuck = await env.startEnvironment('httpenv', {
    mode: 'background',
    port: 4801,
    readyTimeoutMs: 1_000,
    launch: async () => ({ ok: true, detail: 'x', mode: 'background' }),
    probe: async () => 404,
    sleep: async () => {},
    now: () => (clock += 400),
  })
  assert.equal(stuck.ok, false)
  assert.equal(stuck.code, 'timeout')
  // 就绪判据仍要在文案里（用户要知道我们在等什么）；按 copy-review §3.3 删掉的只是「404 不算就绪」那半句
  // （判据清单本身留着）——这里两边都钉住，防止以后有人把整句判据也删掉。
  assert.match(stuck.output, /就绪判据：GET \/ 返回 200\/303\/401/)
  assert.doesNotMatch(stuck.output, /404 不算就绪/)
})

test('F3: 没有 web 层的环境立刻给出可操作拒绝（不启动、不干等 30s）', async () => {
  // base-only：每一层都能解析、且都不声明官方 webserver 依赖 → absent
  makeEnv('noweb', { bundles: ['@deepseek-ai/dsh-base'] })
  addBundleFixture('noweb', '@deepseek-ai/dsh-base', { webserver: false })
  const launched = []
  const started = Date.now()
  const refused = await env.startEnvironment('noweb', {
    mode: 'background',
    readyTimeoutMs: 30_000,
    launch: async (spec) => { launched.push(spec); return { ok: true, detail: 'x', mode: 'background' } },
  })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'no-web-layer')
  assert.equal(launched.length, 0, '拒绝必须发生在启动之前（不占端口、不弹窗口）')
  assert.ok(Date.now() - started < 2_000, '拒绝必须是即时的，不能等 30s 就绪上限')
  assert.match(refused.output, /没有任何能提供 web 服务的层/)
  assert.match(refused.output, /@deepseek-ai\/dsh-web-app/, '建议的包名来自官方常量')
  assert.match(refused.output, /官方插件页/)
  assert.match(refused.output, /web 模板重建/)
  // task-71：末句的括注（解释"没有副作用"）删了；「本次没有发起启动」这个事实留。
  assert.match(refused.output, /本次没有发起启动/)
  assert.doesNotMatch(refused.output, /不占用端口、不弹窗口/)

  // 层里有 web 层（manifest 声明了官方 webserver 依赖）→ 正常往下走
  makeEnv('hasweb', { bundles: ['@deepseek-ai/dsh-base'] })
  addBundleFixture('hasweb', '@deepseek-ai/dsh-base', { webserver: true })
  const launchedWeb = []
  const okWeb = await env.startEnvironment('hasweb', {
    mode: 'background',
    port: 4900,
    launch: async (spec) => { launchedWeb.push(spec); return { ok: true, detail: 'x', mode: 'background' } },
    probe: async () => 401,
    sleep: async () => {},
    now: () => 0,
  })
  assert.equal(okWeb.ok, true, okWeb.output)
  assert.equal(launchedWeb.length, 1)

  // 事实拿不到（层解析不到）→ 如实降级：仍然启动并等就绪探测
  makeEnv('unknownweb', { bundles: ['@not-installed/whatever'] })
  const launchedUnknown = []
  const okUnknown = await env.startEnvironment('unknownweb', {
    mode: 'background',
    port: 4901,
    launch: async (spec) => { launchedUnknown.push(spec); return { ok: true, detail: 'x', mode: 'background' } },
    probe: async () => 401,
    sleep: async () => {},
    now: () => 0,
  })
  assert.equal(okUnknown.ok, true, okUnknown.output)
  assert.equal(launchedUnknown.length, 1, '无法预判时不得拒绝，按就绪探测等待')
})

test('F3b: 显式端口已被监听 → 立刻 port-in-use，不发起启动', async () => {
  // 层栈有 web 层，确保能走到端口归属检查这一步
  makeEnv('portbusy', { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] })
  const server = createServer()
  await new Promise((done) => { server.listen(0, '127.0.0.1', done) })
  const port = server.address().port
  try {
    const launched = []
    const result = await env.startEnvironment('portbusy', {
      mode: 'background',
      port,
      launch: async (spec) => { launched.push(spec); return { ok: true, detail: 'x', mode: 'background' } },
      probe: async () => 401,
      sleep: async () => {},
      now: () => 0,
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'port-in-use')
    assert.equal(launched.length, 0, '端口被占时不得发起启动')
    assert.match(result.output, new RegExp(String(port)))
    assert.match(result.output, /已经被监听/)
    // task-71：中段是**为什么不发起启动的原因**，必须留（copy-review 一审建议删，复核修正为留）；
    // 出路（换端口 / 停进程）同样留。
    assert.match(result.output, /无法确认它会由本次启动的实例接管/)
    assert.match(result.output, /请换一个端口/)
    assert.match(result.output, /停掉占用它的进程/)
  } finally {
    await new Promise((done) => { server.close(done) })
  }
})

test('F4: 只有官方输出里的带 token 地址才算可用入口', async () => {
  makeEnv('tokenenv')
  const logDir = join(PROFILES, 'tokenenv', '.plugin-manager', 'logs')
  mkdirSync(logDir, { recursive: true })
  const logPath = join(logDir, 'start-fake.log')
  writeFileSync(logPath,
    'booting\ndsh web: http://127.0.0.1:4700/?token=abc-DEF_123 (LAN: http://192.168.1.9:4700/?token=abc-DEF_123)\n')
  const ok = await env.startEnvironment('tokenenv', {
    mode: 'background',
    port: 4700,
    launch: async () => ({ ok: true, detail: 'x', mode: 'background', logPath }),
    probe: async () => 401,
    sleep: async () => {},
    now: () => 0,
  })
  assert.equal(ok.ok, true, ok.output)
  assert.match(ok.output, /可用地址：http:\/\/127\.0\.0\.1:4700\/\?token=abc-DEF_123/)
  assert.doesNotMatch(ok.output, /192\.168\.1\.9/, 'LAN 地址不该出现在本机页面里')
  assert.match(ok.output, /日志：/)
  // DESIGN §12：不给「该地址含令牌」加解释段（事实写进 docs/REST-CONTRACT.md）
  assert.doesNotMatch(ok.output, /令牌|每次启动都会换|带本实例的 token/)

  // 失败文案里的日志尾巴必须脱敏：token 只允许出现在那份 0600 日志与成功返回里
  let clock = 0
  const leaky = await env.startEnvironment('tokenenv', {
    mode: 'background',
    port: 4702,
    readyTimeoutMs: 500,
    launch: async () => ({ ok: true, detail: 'x', mode: 'background', logPath }),
    probe: async () => 404,
    sleep: async () => {},
    now: () => (clock += 200),
  })
  assert.equal(leaky.code, 'timeout')
  assert.doesNotMatch(leaky.output, /abc-DEF_123/, '失败文案不得带 token')
  assert.match(leaky.output, /token=\*\*\*/)

  // 读不到 token（终端模式 / 输出里没有那行）→ 不把裸地址说成可用入口，并如实说明 401
  const bare = await env.startEnvironment('tokenenv', {
    mode: 'terminal',
    port: 4701,
    launch: async () => ({ ok: true, detail: 'x', mode: 'terminal', terminal: 'konsole' }),
    probe: async () => 401,
    sleep: async () => {},
    now: () => 0,
  })
  assert.equal(bare.ok, true, bare.output)
  assert.doesNotMatch(bare.output, /可用地址：/)
  assert.match(bare.output, /401/)
  assert.match(bare.output, /启动方式：终端窗口 konsole/)
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

// W-23：不再 skip win32 —— 「跳过」等于 Windows 上永远没有这几条证据。
// 断言本身是平台无关的（只杀指定 pid、旁观 pid 不受影响）；Windows 上走 taskkill 分支。
test('stopEnvironment 按 pid 精确 kill 真实进程（绝不 pkill）', async () => {
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

test('进程表指错 pid 时拒绝 kill（误杀防护）', async () => {
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
  // task-71：成功回执留；「目录：…」与卡片已渲染的 dir 重复 → 删；层栈名字卡片只有计数 → 必须留。
  assert.match(created.output, /已创建环境 fresh/)
  assert.doesNotMatch(created.output, /目录：/)
  assert.match(created.output, /bundle 层栈：/)
  assert.match(created.output, /@deepseek-ai\/dsh-web-app/)

  // 省略模板 = 官方 web 模板（能起得来），不是官方 base-only 默认
  const plain = await env.createEnvironment('plain')
  assert.deepEqual(readManifest('plain').dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
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
  // task-71：立场句「拒绝猜测路径。」删了；原因（不是以 profile 方式启动、无法定位锚点）必须留。
  assert.match(noContext.output, /无法定位安装锚点/)
  assert.doesNotMatch(noContext.output, /拒绝猜测路径/)

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
  // 结论句「没有需要恢复的内容」已删（紧随其后的 plan 第一行就是同一件事）；
  // 如实性由 plan 承接：待重装 0 项 + （无）。
  assert.match(nothing.output, /待重装 0 项/)
  assert.match(nothing.output, /（无）/)
  assert.doesNotMatch(nothing.output, /没有需要恢复的内容/, '结论句与 plan 首行重复，不许回来')

  // 目标环境不存在
  const missingTarget = await env.backupRestore(backup, 'ghost-target', {
    installAnchor: '/anchor/package.json',
    runCommand,
  })
  assert.equal(missingTarget.code, 'not-found')
  // task-71：括注整句删（前半立场句、后半把同屏控件写进句子的指路式引导）；只留事实。
  assert.match(missingTarget.output, /目标环境不存在：ghost-target/)
  assert.doesNotMatch(missingTarget.output, /本模块不代建环境/)
  assert.doesNotMatch(missingTarget.output, /环境列表/)

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

test('N-03: 降级到后台时必须说明理由（成功与超时两条文案都带）', async () => {
  makeEnv('whybg', { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] })
  const reason = '没有可用终端，已降级为后台启动'
  const launches = []
  let clock = 0
  const ok = await env.startEnvironment('whybg', {
    mode: 'terminal', port: 4750, readyTimeoutMs: 300,
    launch: async (spec) => {
      launches.push(spec.mode)
      return spec.mode === 'terminal'
        ? { ok: true, mode: 'terminal', terminal: 'wt', detail: 'terminal' }
        : { ok: true, mode: 'background', detail: '已在后台启动（' + reason + '）', reason }
    },
    probe: async () => (launches.length >= 2 ? 401 : null),
    sleep: async () => {}, now: () => (clock += 100),
  })
  assert.equal(ok.ok, true, ok.output)
  assert.match(ok.output, new RegExp(reason), '成功文案必须说明为什么不是终端窗口')
  assert.match(ok.output, /启动方式：后台/)

  let clock2 = 0
  const failed = await env.startEnvironment('whybg', {
    mode: 'terminal', port: 4751, readyTimeoutMs: 200,
    launch: async (spec) => (spec.mode === 'terminal'
      ? { ok: true, mode: 'terminal', terminal: 'wt', detail: 'terminal' }
      : { ok: true, mode: 'background', detail: '已在后台启动（' + reason + '）', reason }),
    probe: async () => null,
    sleep: async () => {}, now: () => (clock2 += 100),
  })
  assert.equal(failed.code, 'timeout')
  assert.match(failed.output, new RegExp(reason))
})

test('N-01: .cmd shim 用显式 cmd + 参数白名单，不再 shell:true 拼接', () => {
  const spec = {
    profile: 'demo', port: 3599, mode: 'background', command: 'dsh.cmd',
    args: ['--profile', 'demo', '--port', '3599', '--no-open'], entry: null, shell: true,
    dir: 'C:\\Users\\me\\.dsh\\profiles\\demo', display: 'dsh.cmd --profile demo --port 3599 --no-open',
  }
  const invocation = env.windowsShimInvocation(spec)
  assert.equal(invocation.command, process.env.ComSpec ?? 'cmd.exe', '显式 cmd，不是 shell:true')
  assert.deepEqual([...invocation.args], ['/d', '/s', '/c', 'dsh.cmd', '--profile', 'demo', '--port', '3599', '--no-open'])
  const hostile = { ...spec, args: [...spec.args, '--patch', 'C:\\Program Files\\x.yml'] }
  assert.throws(() => env.windowsShimInvocation(hostile), /不安全字符/)
  assert.throws(() => env.windowsTerminalInvocation(hostile), /不安全字符/)
})

test('N-04: 日志尾巴的乱码如实标注，不冒充可读信息', async () => {
  makeEnv('encoding', { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] })
  const logDir = join(PROFILES, 'encoding', '.plugin-manager', 'logs')
  mkdirSync(logDir, { recursive: true })
  const logPath = join(logDir, 'start-gbk.log')
  writeFileSync(logPath, Buffer.concat([
    Buffer.from([0xCF, 0xB5, 0xCD, 0xB3, 0xD5, 0xD2, 0xB2, 0xBB, 0xB5, 0xBD, 0xD6, 0xB8, 0xB6, 0xA8, 0xB5, 0xC4, 0xC2, 0xB7, 0xBE, 0xB6, 0xA1, 0xA3]),
    Buffer.from('\n\u0007dsh web: http://127.0.0.1:4700/?token=abc-DEF_123\n'),
  ]))
  let clock = 0
  const result = await env.startEnvironment('encoding', {
    mode: 'background', port: 4760, readyTimeoutMs: 400,
    launch: async () => ({ ok: true, mode: 'background', logPath }),
    probe: async () => 404, sleep: async () => {}, now: () => (clock += 200),
  })
  assert.equal(result.code, 'timeout')
  assert.match(result.output, /无法按 UTF-8 解码/, '必须如实标注系统文本的编码问题')
  assert.doesNotMatch(result.output, /\u0007/, '控制字符不得进用户文案')
  assert.doesNotMatch(result.output, /abc-DEF_123/, 'token 仍然必须脱敏')
  assert.match(result.output, /token=\*\*\*/)
})

// ── task-58：进程事实「不可读」必须可区分（W-19/W-04/W-05）────────────────────
// 用伪装 win32 在 Linux 上造出「进程事实读不到」的真实路径：win32 分支要 powershell，
// 本机没有 → 读取器返回带原因的失败（而不是旧的空表）。
test('W-19: 进程事实不可读时，破坏性操作拒绝并如实说「运行状态未知」', async () => {
  makeEnv('facts-demo')
  const facts = await withPlatformAsync('win32', () => env.processFacts({ fresh: true }))
  assert.equal(facts.readable, false, 'Linux 上没有 powershell → 事实不可读')
  assert.match(String(facts.reason), /powershell/)

  const stopped = await withPlatformAsync('win32', () => env.stopEnvironment('facts-demo', { current: null }))
  assert.equal(stopped.ok, false)
  assert.equal(stopped.code, 'facts-unavailable', '不能把「读不到」说成「没有运行中的实例」')
  assert.match(stopped.output, /运行状态未知/)

  const removed = await withPlatformAsync('win32', () => env.removeEnvironment('facts-demo', { current: null }))
  assert.equal(removed.ok, false)
  assert.equal(removed.code, 'facts-unavailable')
  assert.equal(existsSync(join(PROFILES, 'facts-demo', 'package.json')), true, '未知状态下绝不允许删除')

  const renamed = await withPlatformAsync('win32', () => env.renameEnvironment('facts-demo', 'facts-other', { current: null }))
  assert.equal(renamed.code, 'facts-unavailable')
  assert.equal(existsSync(join(PROFILES, 'facts-demo')), true)
})

test('W-19: 事实不可读时启动照常，但要如实说明「未做重复实例检查」', async () => {
  makeEnv('facts-start', { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] })
  let clock = 0
  const result = await withPlatformAsync('win32', () => env.startEnvironment('facts-start', {
    mode: 'background', port: 4790, readyTimeoutMs: 200,
    launch: async () => ({ ok: true, mode: 'background', detail: 'x' }),
    probe: async () => 401, sleep: async () => {}, now: () => (clock += 100),
  }))
  assert.equal(result.ok, true, result.output)
  assert.match(result.output, /进程表不可读/, '必须如实带出未做检查这件事')
  assert.match(result.output, /未做重复实例检查/)
})

test('W-04/W-05: 读取器不再把失败折叠成空表，且没有 -match 预筛', () => {
  // 行为面：注入的 reader 仍然可用（那是测试缝），并在不可读时给出原因
  const fake = env.processFactsNow({ reader: () => ['4242\tC:\\x\\@deepseek-ai\\dsh\\lib\\bin.js --profile demo'] })
  assert.equal(fake.readable, true)
  // 源码面：预筛会让命令行里没写 dsh 的包装进程被漏掉（审计 W-05），钉住它不许回来。
  // 注意断言对象是**代码形态**（Where-Object），不是「-match 'dsh'」这串文字 ——
  // 注释里会解释这条修复，dist 保留注释，拿文字当判据会误伤自己。
  const source = readFileSync(new URL('../dist/envManager.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /Where-Object/, 'PowerShell 预筛（Where-Object）必须已删除')
  assert.match(source, /Get-CimInstance Win32_Process/, '进程表查询本身还在')
})


test('task-80 假通过守卫：候选没进层栈一律 cannot-trial（绝不许 passed）', async () => {
  const build = env.buildIdentity()
  const mounted = async () => ({ verdict: { kind: 'mounted' }, elapsedMs: 1, stderr: '', exitCode: 1, build })
  const base = { installAnchor: '/anchor/package.json', depth: 'shallow', verify: mounted }

  // ① 运行器报成功，但环境里什么都没变（早期桩件的形态）→ 没有验证到任何东西
  makeEnv('act-a', { bundles: ['@deepseek-ai/dsh-base'] })
  const nothing = async () => ({ exitCode: 0, output: 'ok', truncated: false, logPath: '/dev/null' })
  const a = await env.runTrialInstall('@fake/pkg', 'act-a', { ...base, runCommand: nothing })
  assert.equal(a.conclusion, 'cannot-trial', '装上了但环境没变 → 不算通过')
  assert.match(a.output, /没有出现它/)
  assert.match(a.output, /不等于通过/)

  // ② **真机缺陷的原始形态**：候选已在源环境 dependencies 里（升级/重试同一候选）→ 物化把它
  //    带进测试环境 → 官方 reconcile 跳过"既有的"依赖 → 它进不了层栈。task-78 当时判 passed。
  const brokenFixture = join(HOME, 'fixtures', 'dsh-probe-broken')
  mkdirSync(brokenFixture, { recursive: true })
  writeFileSync(join(brokenFixture, 'package.json'), JSON.stringify({ name: 'dsh-probe-broken', version: '1.0.0' }))
  makeEnv('act-b', { bundles: ['@deepseek-ai/dsh-base'], dependencies: { 'dsh-probe-broken': 'link:' + brokenFixture } })
  const keepDirty = async () => ({ exitCode: 0, output: 'ok', truncated: false, logPath: '/dev/null' })
  const b = await env.runTrialInstall('link:' + brokenFixture, 'act-b', { ...base, runCommand: keepDirty })
  assert.equal(b.conclusion, 'cannot-trial', '候选没进层栈 → 假通过的原始形态，必须被拦')
  assert.match(b.output, /没有进入组合层栈/)
  assert.match(b.output, /reconcile 会跳过/)

  // ③ 装上了且进了层栈 → 允许按启动判定给结论
  makeEnv('act-c', { bundles: ['@deepseek-ai/dsh-base'] })
  const c = await env.runTrialInstall('@fake/pkg', 'act-c', { ...base, runCommand: installRunner('@fake/pkg') })
  assert.equal(c.conclusion, 'passed')

  // ④ 装上了但**没有**进层栈（例如候选不声明 dsh.bundle）→ 同样不许 passed
  makeEnv('act-d', { bundles: ['@deepseek-ai/dsh-base'] })
  const noActivate = await env.runTrialInstall('@fake/pkg', 'act-d', {
    ...base, runCommand: installRunner('@fake/pkg', { activate: false }),
  })
  assert.equal(noActivate.conclusion, 'cannot-trial')
  assert.match(noActivate.output, /没有进入组合层栈/)
});

test('task-84 正常顺序不误拦：引擎先摘候选，已装候选也能真的验证到（task-80 守卫保留作兜底）', async () => {
  const build = env.buildIdentity()
  const mounted = async () => ({ verdict: { kind: 'mounted' }, elapsedMs: 1, stderr: '', exitCode: 1, build })

  /**
   * 忠实的官方 reconcile 替身：**只有"新装"的依赖才进层栈**，既有依赖被跳过；
   * `remove` 同时摘掉 deps 与层栈。这就是 lib/types/operations.js 里 reconcile 的行为。
   */
  const reconcileRunner = (calls) => async (context, args) => {
    calls.push([...args])
    const path = join(context.dir, 'package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    const deps = manifest.dependencies ?? {}
    const bundles = manifest.dsh?.profile?.bundles ?? []
    const name = args[0] === 'remove' ? args[1] : 'probe-reconcile'
    if (args[0] === 'remove') {
      delete deps[name]
      manifest.dependencies = deps
      manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: bundles.filter((item) => item !== name) } }
      writeFileSync(path, JSON.stringify(manifest, undefined, 2) + '\n')
      return { exitCode: 0, output: 'removed', truncated: false, logPath: '/dev/null' }
    }
    const before = new Set(Object.keys(deps))
    deps[name] = 'link:/fixture/' + name
    manifest.dependencies = deps
    if (!before.has(name) && !bundles.includes(name)) {
      manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...bundles, name] } }
    }
    writeFileSync(path, JSON.stringify(manifest, undefined, 2) + '\n')
    return { exitCode: 0, output: 'added', truncated: false, logPath: '/dev/null' }
  }

  // 候选已在源环境 dependencies 里（**gatedInstall 的正常顺序**：先 installBundle 落进源环境，
  // 试装快照再从源环境物化，于是候选在物化那刻已在测试环境 deps 里）。
  // 引擎必须先摘掉它，否则官方 reconcile 跳过既有依赖 → 进不了层栈 → 整条安装被误拦。
  // 候选目录必须**真实存在**：认包名要读它的 package.json（读不到就认不出包名，
  // 引擎会如实跳过卸包——那是诚实的降级，不是我们要测的正常路径）。
  const fixture = join(HOME, 'fixtures', 'probe-reconcile')
  mkdirSync(fixture, { recursive: true })
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'probe-reconcile', version: '1.0.0' }) + '\n')
  const spec = 'link:' + fixture
  const src = makeEnv('ok-src', { bundles: ['@deepseek-ai/dsh-base'], dependencies: { 'probe-reconcile': spec } })
  void src
  const calls = []
  const trial = await env.runTrialInstall(spec, 'ok-src', {
    installAnchor: '/anchor/package.json', depth: 'shallow', runCommand: reconcileRunner(calls), verify: mounted,
  })
  assert.deepEqual(calls, [['remove', 'probe-reconcile'], ['add', spec]],
    '已装候选必须先摘再装（否则它永远进不了层栈）')
  assert.equal(trial.conclusion, 'passed', '正常顺序下不许误拦：' + trial.output)
  assert.equal(trial.activation.activated, true, '证据：候选真的进了层栈')
  assert.equal(trial.activation.removedFirst, true)
  assert.match(trial.detached, /使候选成为"新装"/)

  // 对照：同样的输入，但引擎**不摘候选**（模拟旧顺序）→ 必然 cannot-trial。
  // 这一条守的是"顺序"本身：改回去就会红。
  const keepDirty = async () => ({ exitCode: 0, output: 'ok', truncated: false, logPath: '/dev/null' })
  const stale = makeEnv('stale-src2', { bundles: ['@deepseek-ai/dsh-base'], dependencies: { 'probe-reconcile': spec } })
  void stale
  const blocked = await env.runTrialInstall(spec, 'stale-src2', {
    installAnchor: '/anchor/package.json', depth: 'shallow', runCommand: keepDirty, verify: mounted,
  })
  assert.equal(blocked.conclusion, 'cannot-trial', '候选没进层栈仍然必须是 cannot-trial（兜底守卫保留）')
  assert.equal(blocked.activation.activated, false)
})

// ── task-50 试装引擎（第一段：命名 / 指纹 / 三态判定 / 结论映射）──────────────
// ── task-50 第二段：快照物化 / 删除纪律 / 清理计划 ──────────────────────────
test('深度以启动为判据：shallow 明确失败→升级 full；两次都不行才 baseline-broken；undetermined 不升级', async () => {
  makeEnv('esc-src', { bundles: ['@deepseek-ai/dsh-base'] })
  const build = env.buildIdentity()
  const mounted = { kind: 'mounted' }
  const failed = { kind: 'failed', reason: 'Cannot find package @fake/missing', chain: ['Error: Cannot find package @fake/missing'] }
  const unknown = { kind: 'undetermined', reason: '子进程没有输出任何 stderr 文本' }
  const runnerOk = installRunner('@fake/pkg')
  const base = { installAnchor: '/anchor/package.json', runCommand: runnerOk }

  // ① shallow 失败 → 升级 full → 成功：结论 passed，且说明实际深度与升级原因
  let n = 0
  const firstFails = async () => { n += 1; return { verdict: n === 1 ? failed : mounted, elapsedMs: 1, stderr: '', exitCode: 1, build } }
  const esc = await env.runTrialInstall('@fake/pkg', 'esc-src', { ...base, verify: firstFails })
  assert.equal(esc.conclusion, 'passed')
  assert.equal(esc.depth, 'full', '升级后实际用的是 full')
  assert.equal(esc.escalated, true)
  assert.match(String(esc.escalationReason), /Cannot find package @fake\/missing/, '要带浅快照为什么不给力')
  assert.match(esc.output, /由 shallow 升级/)

  // ② 两次都失败 → baseline-broken，且文案写明两种快照都试过
  const alwaysFails = async () => ({ verdict: failed, elapsedMs: 1, stderr: '', exitCode: 1, build })
  const both = await env.runTrialInstall('@fake/pkg', 'esc-src', { ...base, verify: alwaysFails })
  assert.equal(both.conclusion, 'baseline-broken')
  assert.equal(both.escalated, true)
  assert.match(both.output, /浅快照与完整快照都试过/)
  assert.match(both.output, /不是 @fake\/pkg 的问题/)

  // ③ undetermined 不升级：判不出来就是无法试装，不许悄悄换成 full
  let calls = 0
  const undetermined = async () => { calls += 1; return { verdict: unknown, elapsedMs: 1, stderr: '', exitCode: null, build } }
  const cannot = await env.runTrialInstall('@fake/pkg', 'esc-src', { ...base, verify: undetermined })
  assert.equal(cannot.conclusion, 'cannot-trial', '判不出来是「无法试装」，不是「基线坏」')
  assert.equal(cannot.escalated, false, 'undetermined 不许触发升级')
  assert.equal(calls, 1, '不升级就意味着只跑了一次验证')
  assert.equal(cannot.depth, 'shallow')

  // ④ 显式 depth 入口仍然有效（引擎侧保留，设置项归 task-51）
  let seen = []
  const explicit = async () => ({ verdict: mounted, elapsedMs: 1, stderr: '', exitCode: 1, build })
  const full = await env.runTrialInstall('@fake/pkg', 'esc-src', { ...base, depth: 'full', verify: explicit })
  assert.equal(full.depth, 'full')
  assert.equal(full.escalated, false)
  void seen
})

test('四步编排：基线坏不赖候选包 / 候选坏给根因 / 无法试装不算通过（结论带构建指纹）', async () => {
  makeEnv('trial-src', { bundles: ['@deepseek-ai/dsh-base'] })
  const build = env.buildIdentity()
  const mounted = async () => ({ verdict: { kind: 'mounted' }, elapsedMs: 1, stderr: '', exitCode: 1, build })
  const failed = async () => ({ verdict: { kind: 'failed', reason: 'boom', chain: ['Error: boom'] }, elapsedMs: 1, stderr: 'x', exitCode: 1, build })
  const runnerOk = installRunner('@fake/pkg')
  const runnerFail = async () => ({ exitCode: 1, output: 'ERR_PNPM_NO_OFFLINE_TARBALL 冷包', truncated: false, logPath: '/dev/null' })
  const base = { installAnchor: '/anchor/package.json', depth: 'shallow', runCommand: runnerOk }

  // ① 基线坏：不许赖候选包，且不该继续装
  const broken = await env.runTrialInstall('@fake/pkg', 'trial-src', { ...base, verify: failed })
  assert.equal(broken.conclusion, 'baseline-broken')
  assert.match(broken.output, /不是 @fake\/pkg 的问题/)
  assert.equal(broken.baseline.kind, 'failed')
  assert.equal(broken.candidate, null, '基线坏就不应该继续走到装候选包')

  // ② 候选坏：基线好、装完坏 → 给根因链
  let calls = 0
  const secondCallFails = async () => (++calls === 1 ? mounted() : failed())
  const candidate = await env.runTrialInstall('@fake/pkg', 'trial-src', { ...base, verify: secondCallFails })
  assert.equal(candidate.conclusion, 'candidate-broken')
  assert.match(candidate.output, /候选包导致挂载失败/)
  assert.match(candidate.output, /Error: boom/)

  // ③ 无法试装：禁用联网 + 冷包 → 明确失败，且不算通过
  calls = 0
  const cannot = await env.runTrialInstall('@fake/pkg', 'trial-src', {
    ...base, verify: mounted, allowNetwork: false, runCommand: runnerFail,
  })
  assert.equal(cannot.conclusion, 'cannot-trial')
  assert.match(cannot.output, /已禁用联网/)
  assert.match(cannot.output, /不等于通过/)

  // ④ 通过：结论要钉在具体构建上（CODE-POLICY §7.8）
  calls = 0
  const passed = await env.runTrialInstall('@fake/pkg', 'trial-src', { ...base, verify: mounted })
  assert.equal(passed.conclusion, 'passed')
  assert.match(passed.output, /构建：/)
  assert.match(String(passed.build.artifactMd5), /^[0-9a-f]{32}$/, '产物 md5 必须带上')
  assert.match(String(passed.build.artifactMtime), /^\d{4}-\d{2}-\d{2}T/, '产物 mtime 必须带上')
  assert.match(passed.output, new RegExp('源环境指纹：' + passed.sourceFingerprint.hash.slice(0, 8)))
})

test('快照深度自动判定复用同一套事实：锚点能解析=浅，profile 自装=全', () => {
  const dir = makeEnv('depth-src', { bundles: ['@fake/anchor-bundle'] })
  // 锚点里能解析到 → 浅快照够用
  const anchorRoot = join(HOME, 'anchor')
  mkdirSync(join(anchorRoot, 'node_modules', '@fake', 'anchor-bundle'), { recursive: true })
  writeFileSync(join(anchorRoot, 'package.json'), '{"name":"anchor"}')
  writeFileSync(join(anchorRoot, 'node_modules', '@fake', 'anchor-bundle', 'package.json'), '{"name":"@fake/anchor-bundle"}')
  const anchor = join(anchorRoot, 'package.json')
  assert.equal(env.snapshotDepthFor(dir, ['@fake/anchor-bundle'], anchor), 'shallow')
  // profile 自己装了这一层（node_modules 里有）→ 必须全量
  mkdirSync(join(dir, 'node_modules', '@fake', 'anchor-bundle'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', '@fake', 'anchor-bundle', 'package.json'), '{"name":"@fake/anchor-bundle"}')
  assert.equal(env.snapshotDepthFor(dir, ['@fake/anchor-bundle'], anchor), 'full', 'profile 自装的层浅快照复现不出来')
  // 拿不到锚点 / 解析不到 → 保守全量
  assert.equal(env.snapshotDepthFor(dir, ['@fake/nothing-here'], undefined), 'full')
  assert.equal(env.snapshotDepthFor(dir, ['@fake/nothing-here'], anchor), 'full')
})

test('浅快照只复制清单文件；全量快照走官方 pnpm 通道（绝不自己调 pnpm）', async () => {
  const src = makeEnv('snap-src', { bundles: ['@deepseek-ai/dsh-base'] })
  writeFileSync(join(src, 'cordis.yml'), '# root\n')
  writeFileSync(join(src, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  const created = await env.createTrialEnvironment('snap-src', { materialize: false })
  assert.equal(created.ok, true, created.output)
  const target = env.trialEnvironmentName('snap-src')
  assert.equal(existsSync(join(PROFILES, target, 'package.json')), true, '测试环境由官方 initProfile 建好')

  const shallow = await env.materializeSnapshot('snap-src', target, { depth: 'shallow' })
  assert.equal(shallow.depth, 'shallow')
  assert.equal(shallow.installed, false)
  assert.ok(shallow.copied.includes('package.json'))
  assert.equal(existsSync(join(PROFILES, target, 'cordis.yml')), true, '清单文件要复制过去')
  assert.equal(readFileSync(join(PROFILES, target, 'cordis.yml'), 'utf8'), '# root\n')

  // 全量：必须走官方通道，调用形状是 ['install','--prefer-offline']
  const calls = []
  const full = await env.materializeSnapshot('snap-src', target, {
    depth: 'full', installAnchor: '/anchor/package.json',
    runCommand: async (context, args) => { calls.push({ profile: context.profile, dir: context.dir, args }); return { exitCode: 0, output: 'ok', truncated: false, logPath: '/dev/null' } },
  })
  assert.equal(full.depth, 'full')
  assert.equal(full.installed, true)
  assert.deepEqual(calls.map((call) => call.profile), [target], '在测试环境里装，不是真实环境')
  assert.deepEqual([...calls[0].args], ['install', '--prefer-offline'])
  // 拿不到官方通道 → 如实失败（不许静默当成功）
  await assert.rejects(
    () => env.materializeSnapshot('snap-src', target, { depth: 'full' }),
    (error) => error.code === 'no-profile-context',
  )
})

test('测试环境删除三重纪律：非测试名/未知状态/运行中都不许删', async () => {
  const dir = makeEnv('trial-strict-dpmc')
  const notTrial = await env.removeTrialEnvironment('trial-strict', { current: null })
  assert.equal(notTrial.code, 'invalid-name', '真实环境不能走测试环境删除路径')

  const unknownFacts = await withPlatformAsync('win32', () => env.processFacts({ fresh: true }))
  const unknown = await env.removeTrialEnvironment('trial-strict-dpmc', { current: null, facts: unknownFacts })
  assert.equal(unknown.code, 'facts-unavailable', '进程事实不可读时未知状态下绝不动磁盘')
  assert.equal(existsSync(join(dir, 'package.json')), true)

  const runningFacts = { runs: new Map([['trial-strict-dpmc', [{ pid: 4242, port: null, command: 'x' }]]]), readable: true }
  const running = await env.removeTrialEnvironment('trial-strict-dpmc', { current: null, facts: runningFacts })
  assert.equal(running.code, 'running', '运行中先拒，不做隐式停止')
  assert.equal(existsSync(join(dir, 'package.json')), true)

  const idle = await env.removeTrialEnvironment('trial-strict-dpmc', { current: null, facts: { runs: new Map(), readable: true } })
  assert.equal(idle.ok, true, idle.output)
  assert.equal(existsSync(dir), false)
})

test('清理计划：按保留期删、运行中永不删、关闭自动清理时只列不删', () => {
  const now = 1_000_000_000_000
  const day = 86_400_000
  const candidates = [
    { name: 'fresh-dpmc', owner: 'fresh', modifiedAt: now - day, running: false },
    { name: 'old-dpmc', owner: 'old', modifiedAt: now - 20 * day, running: false },
    { name: 'busy-dpmc', owner: 'busy', modifiedAt: now - 20 * day, running: true },
    { name: 'orphan-dpmc', owner: 'gone', modifiedAt: now - 30 * day, running: false },
  ]
  const plan = env.planTrialCleanup(candidates, { now })
  assert.deepEqual(plan.remove.map((entry) => entry.name).sort(), ['old-dpmc', 'orphan-dpmc'], '孤儿一样纳入清理')
  assert.ok(plan.remove.every((entry) => entry.reason.includes('超过保留期')), '删除原因要写清楚')
  const keepNames = plan.keep.map((entry) => entry.name).sort()
  assert.deepEqual(keepNames, ['busy-dpmc', 'fresh-dpmc'])
  assert.match(plan.keep.find((entry) => entry.name === 'busy-dpmc').reason, /正在运行/)

  const disabled = env.planTrialCleanup(candidates, { now, retainDays: null })
  assert.deepEqual(disabled.remove, [], '关掉自动清理就什么都不删')
  assert.equal(disabled.keep.length, 4)

  const custom = env.planTrialCleanup(candidates, { now, retainDays: 0 })
  assert.equal(custom.remove.length, 3, '保留 0 天 = 除了在跑的全删')
})

test('进程事实不可读时，清理按最保守处理：候选标成运行中（不删）', () => {
  const facts = { runs: new Map(), readable: false, reason: 'powershell 不可用' }
  const listed = env.listTrialEnvironments({ facts })
  assert.equal(listed.factsReadable, false)
  for (const candidate of listed.candidates) {
    assert.equal(candidate.running, true, '读不到就不能声称「没在跑」——最保守是当成在跑')
  }
})

test('试装环境命名与归属：<真实名>-dpmc，且只认这一个形态', () => {
  assert.equal(env.trialEnvironmentName('web'), 'web-dpmc')
  assert.equal(env.trialEnvironmentName('pm-test'), 'pm-test-dpmc')
  assert.equal(env.isTrialEnvironmentName('web-dpmc'), true)
  assert.equal(env.isTrialEnvironmentName('web'), false)
  assert.equal(env.isTrialEnvironmentName('-dpmc'), false, '裸后缀没有归属，不算测试环境')
  assert.equal(env.trialEnvironmentOwner('web-dpmc'), 'web')
  assert.equal(env.trialEnvironmentOwner('web'), null)
})

test('指纹五元组全部读盘：任一文件变化都必须改变 hash，且标注层栈口径', async () => {
  const dir = makeEnv('fp-src', { bundles: ['@deepseek-ai/dsh-base'] })
  writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
  const first = await env.environmentFingerprint('fp-src')
  assert.match(first.manifestHash, /^[0-9a-f]{16}$/)
  assert.equal(first.lockfileHash, null, '没有 lockfile 就是 null（那是事实，不是空 hash）')
  assert.match(first.patchHash, /^[0-9a-f]{16}$/)
  assert.equal(first.bundlesSource, 'manifest', '没有官方 listBundles 时必须标成 manifest 口径')
  assert.deepEqual([...first.bundles], ['@deepseek-ai/dsh-base'])

  assert.equal(env.sameFingerprint(first, await env.environmentFingerprint('fp-src')), true)
  makeEnv('fp-src', { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] })
  const afterManifest = await env.environmentFingerprint('fp-src')
  assert.equal(env.sameFingerprint(first, afterManifest), false)
  writeFileSync(join(dir, 'cordis.patch.yml'), '- insert: []\n')
  const afterPatch = await env.environmentFingerprint('fp-src')
  assert.equal(env.sameFingerprint(afterManifest, afterPatch), false, '用户手写的层最容易在终端里被改')
  const official = await env.environmentFingerprint('fp-src', { listBundles: async () => ['a', 'b'] })
  assert.equal(official.bundlesSource, 'official')
  assert.deepEqual([...official.bundles], ['a', 'b'])
  const failed = await env.environmentFingerprint('fp-src', { listBundles: async () => { throw new Error('offline') } })
  assert.equal(failed.bundlesSource, 'manifest', '官方事实拿不到就如实退回 manifest 口径')
})

test('浅快照缺依赖的失败形态要被认出来（启动器层），否则升级分支就是装饰', () => {
  // 真机实测（逐字，task-73 探针复采）：浅快照没带 node_modules 时启动器在挂载前 throw。
  const resolver = [
    'file:///home/u/.pnpm/@deepseek-ai+dsh-app-boot@0.1.6/lib/index.js:904',
    'throw new Error(`\${binName}: cannot resolve profile bundle \${JSON.stringify(packageName)} from the dsh installation or \${profileDir}`);',
    '^',
    'Error: dsh: cannot resolve profile bundle "dsh-t50-linklayer" from the dsh installation or /tmp/x/profiles/real-dpmc',
    "    at resolveBundleDir (file:///home/u/.pnpm/@deepseek-ai+dsh-app-boot@0.1.6/lib/index.js:904:8)",
  ].join('\n')
  const verdict = env.judgeBootStderr(resolver)
  assert.equal(verdict.kind, 'failed', '层解析不到是明确失败，不是「判不出来」（否则升级永远不触发）')
  assert.match(verdict.reason, /cannot resolve profile bundle/)
  // task-73 顺手项：根因不能是那一行源码模板（里面有 ${…} 占位符，连包名都看不出）。
  assert.match(verdict.reason, /^Error: dsh: cannot resolve profile bundle "dsh-t50-linklayer"/, '要取真正的消息行')
  assert.doesNotMatch(verdict.reason, /throw new Error/)
  assert.ok(verdict.chain.every((line) => !line.startsWith('throw ') && !line.startsWith('at ') && line !== '^'), '栈帧与源码行不许进根因链')
  // 三种形态互不混淆
  assert.equal(env.judgeBootStderr('Error: dsh: plugin tree failed to load: x').kind, 'failed')
  assert.equal(env.judgeBootStderr('dsh: a task is required, for example: …').kind, 'mounted')
  assert.equal(env.judgeBootStderr('').kind, 'undetermined')
})

test('挂载判定读 stderr 特征：健康=缺任务那行；失败=plugin tree failed + cause 链；都不是=无法判定', () => {
  const healthy = env.judgeBootStderr('dsh: a task is required, for example: dsh --profile headless "run the tests"\n')
  assert.equal(healthy.kind, 'mounted', '健康环境 stderr 只有这一行，而退出码仍是 1')

  const boom = [
    'Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): failed to apply loader entry t37-bad-b (dsh-t37-bad-b): t37-apply-boom',
    'Error: t37-apply-boom',
    '  [cause]: Error: failed to apply loader entry t37-bad-b (dsh-t37-bad-b): t37-apply-boom',
  ].join('\n')
  const failed = env.judgeBootStderr(boom)
  assert.equal(failed.kind, 'failed')
  assert.match(failed.reason, /plugin tree failed to load/)
  assert.ok(failed.chain.some((line) => line.includes('t37-apply-boom')), '根因链必须带上')

  assert.equal(env.judgeBootStderr('').kind, 'undetermined', '没有输出就是判不出来，不许当成成功')
  assert.equal(env.judgeBootStderr('some unrelated output\n').kind, 'undetermined')
})

test('三种结论不许混：基线坏不赖候选包，无法试装不算通过', () => {
  const ok = { kind: 'mounted' }
  const bad = { kind: 'failed', reason: 'x', chain: [] }
  const unknown = { kind: 'undetermined', reason: 'no output' }
  assert.equal(env.judgeTrialOutcome(ok, ok), 'passed')
  assert.equal(env.judgeTrialOutcome(bad, bad), 'baseline-broken', '基线就坏：不是候选包的问题')
  assert.equal(env.judgeTrialOutcome(ok, bad), 'candidate-broken')
  assert.equal(env.judgeTrialOutcome(unknown, ok), 'cannot-trial')
  assert.equal(env.judgeTrialOutcome(ok, unknown), 'cannot-trial')
  assert.equal(env.judgeTrialOutcome(ok, null), 'cannot-trial')
  assert.equal(env.judgeTrialOutcome(null, null, '禁用联网且本地 store 没有该包'), 'cannot-trial')
  assert.notEqual(env.judgeTrialOutcome(null, null, 'offline'), 'passed')
})

test('P-58b: 环境列表区分「确定没有实例」与「进程事实读不到」（另一来源，单独成对）', async () => {
  makeEnv('listdemo')
  const known = env.listEnvironments(undefined, { facts: env.processFactsNow({ reader: () => [] }) })
  const knownItem = known.find((item) => item.name === 'listdemo')
  assert.equal(knownItem.runs.length, 0)
  assert.notEqual(knownItem.runsKnown, false, '可读时不得标成未知（缺省等价 true）')

  const facts = await withPlatformAsync('win32', () => env.processFacts({ fresh: true }))
  assert.equal(facts.readable, false)
  const unknown = env.listEnvironments(undefined, { facts })
  const unknownItem = unknown.find((item) => item.name === 'listdemo')
  assert.equal(unknownItem.runsKnown, false, '读不到必须标成未知，而不是让 runs: [] 冒充「未运行」')
  assert.match(String(unknownItem.runsUnknownReason), /powershell/)
  assert.equal(unknownItem.runs.length, 0)
  assert.equal(unknownItem.unknownFields, undefined, '进程事实不可读不应污染 manifest 的 unknownFields（两个来源）')
})

test('W-12: 权限说辞如实（Linux 0600 / Windows 依赖目录 ACL），不再宣称 0600 是保证', () => {
  const source = readFileSync(new URL('../dist/envManager.js', import.meta.url), 'utf8')
  assert.match(source, /Windows：权限位\*\*不生效\*\*|权限位不生效/, '要写明 Windows 上权限位不生效')
  assert.match(source, /ACL/, '要写明依赖目录 ACL')
})


// ── task-75：按层栈决定验证形态（含 web 层的环境读官方就绪行） ────────────────

test('验证启动的参数按层栈决定：含 web 层加 --port 0 --no-open，headless 类保持原形态', () => {
  const prefix = ['/dsh/lib/bin.js']
  // 含 web 层：服务形态。--port 0 由 OS 分配端口，永不与 GUI 抢 3080。
  assert.deepEqual([...env.verificationArgs(prefix, 'wenv', 'present')],
    ['/dsh/lib/bin.js', '--profile', 'wenv', '--port', '0', '--no-open'])
  // headless 类：缺任务形态（原判据）。
  assert.deepEqual([...env.verificationArgs(prefix, 'henv', 'absent')], ['/dsh/lib/bin.js', '--profile', 'henv'])
  // 层栈事实拿不到 → 不许盲加未知参数（headless 类环境不认 --port）
  assert.deepEqual([...env.verificationArgs(prefix, 'uenv', 'unknown')], ['/dsh/lib/bin.js', '--profile', 'uenv'])
})

test('就绪信号：官方就绪行 → mounted；headless 的缺任务判据仍然有效；无信号 → 判不出来', () => {
  assert.equal(env.judgeBootSignals({
    stderr: '', stdout: 'dsh web: http://127.0.0.1:46141/?token=x\n',
    readyUrl: 'http://127.0.0.1:46141/?token=x', exitCode: null, killedAfterReady: true,
  }).kind, 'mounted', '就绪行是官方定义的挂载完成信号')
  assert.equal(env.judgeBootSignals({ stderr: 'dsh: a task is required, for example: …\n', exitCode: 1 }).kind, 'mounted')
  assert.equal(env.judgeBootSignals({ stderr: 'Error: dsh: plugin tree failed to load: x', exitCode: 1 }).kind, 'failed')
  assert.equal(env.judgeBootSignals({ stderr: '', exitCode: null }).kind, 'undetermined', '没有信号不许当通过')
})

test('runHeadlessVerification 把就绪行的证据一路带出来（stdout / 地址 / 是否主动收工）', async () => {
  makeEnv('ready-ev', { bundles: ['@deepseek-ai/dsh-base'] })
  const verification = await env.runHeadlessVerification('ready-ev', {
    run: async () => ({
      stderr: '', stdout: 'dsh web: http://127.0.0.1:46141/?token=abc\n',
      readyUrl: 'http://127.0.0.1:46141/?token=abc', killedAfterReady: true, exitCode: null,
    }),
  })
  assert.equal(verification.verdict.kind, 'mounted')
  assert.equal(verification.readyUrl, 'http://127.0.0.1:46141/?token=abc')
  assert.equal(verification.killedAfterReady, true)
  assert.match(verification.stdout, /dsh web:/, 'stdout 原文要留作证据')
  assert.equal(verification.exitCode, null, '服务形态是我们主动收工的，没有退出码')
})

// ── task-75：浅快照必须真的浅（不许复用上一次完整快照的 node_modules） ─────────

test('浅快照真的浅：清掉上一次物化留下的 node_modules 与陈旧清单，并把证据带出来', async () => {
  const src = makeEnv('shallow-src', { bundles: ['@deepseek-ai/dsh-base'] })
  writeFileSync(join(src, 'cordis.yml'), '# root\n')
  const created = await env.createTrialEnvironment('shallow-src', { materialize: false })
  assert.equal(created.ok, true, created.output)
  const target = env.trialEnvironmentName('shallow-src')
  const targetDir = join(PROFILES, target)
  // 造出「上一次完整快照留下的东西」：依赖 + 源环境现在没有的清单文件。
  mkdirSync(join(targetDir, 'node_modules', '@fake', 'stale-dep'), { recursive: true })
  writeFileSync(join(targetDir, 'node_modules', '@fake', 'stale-dep', 'package.json'), '{"name":"@fake/stale-dep"}')
  writeFileSync(join(targetDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')

  const snapshot = await env.materializeSnapshot('shallow-src', target, { depth: 'shallow' })
  assert.equal(snapshot.depth, 'shallow')
  assert.equal(existsSync(join(targetDir, 'node_modules')), false, '浅快照不许带着旧依赖（否则金丝雀会假通过）')
  assert.equal(existsSync(join(targetDir, 'pnpm-lock.yaml')), false, '源环境没有的陈旧 lockfile 不许留')
  assert.deepEqual([...snapshot.cleared].sort(), ['node_modules', 'pnpm-lock.yaml'])
  // profile 骨架不许被清：pnpm-workspace.yaml 带着 nodeLinker: hoisted 这类会改变 pnpm 语义的设置，
  // 删掉它等于让我们在另一套安装语义下验证（那才是失真）。
  assert.equal(existsSync(join(targetDir, 'pnpm-workspace.yaml')), true, '骨架文件必须留着')
  assert.equal(existsSync(join(targetDir, 'cordis.patch.yml')), true, '骨架文件必须留着')
  assert.match(snapshot.output, /清掉了上一次物化留下的/)
  assert.match(snapshot.output, /浅快照不含依赖/)
  // 骨架与源环境有的清单仍要在（测试环境要能起来）
  assert.equal(existsSync(join(targetDir, 'package.json')), true)
  assert.equal(readFileSync(join(targetDir, 'cordis.yml'), 'utf8'), '# root\n')
  assert.ok(snapshot.copied.includes('package.json'))
})

test('就绪行收集器：跨 chunk 也能认；失败先出现就不认后来的就绪行', () => {
  // 一条完整的就绪行（官方形如 dsh web: http://127.0.0.1:46141/?token=…）
  const whole = env.createBootSignalCollector()
  assert.equal(whole.pushStdout('dsh web: http://127.0.0.1:46141/?token=abc\n'), true)
  assert.equal(whole.readyUrl, 'http://127.0.0.1:46141/?token=abc')

  // 半行就绪行：第一段不认，第二段补齐后才认（流式读取不保证按行对齐）
  const split = env.createBootSignalCollector()
  assert.equal(split.pushStdout('dsh web: http://127.0.0.1:4614'), false, '半行不算就绪')
  assert.equal(split.readyUrl, null)
  assert.equal(split.pushStdout('1/?token=abc\n'), true, '补齐后必须认出来')
  assert.equal(split.readyUrl, 'http://127.0.0.1:46141/?token=abc')

  // 同一个收集器不重复报（调用方据此只收一次工）
  assert.equal(split.pushStdout('dsh web: http://127.0.0.1:9/?token=z\n'), false)

  // 失败先出现：后来的就绪行不许把失败盖掉（谁先出现算谁）
  const failedFirst = env.createBootSignalCollector()
  failedFirst.pushStderr('Error: dsh: plugin tree failed to load: boom\n')
  assert.equal(failedFirst.pushStdout('dsh web: http://127.0.0.1:46141/?token=abc\n'), false)
  assert.equal(failedFirst.readyUrl, null)

  // 就绪行先出现、失败在后（后置的运行时错误）：就绪行仍然成立
  const readyFirst = env.createBootSignalCollector()
  assert.equal(readyFirst.pushStdout('dsh web: http://127.0.0.1:46141/?token=abc\n'), true)
  readyFirst.pushStderr('Error: 之后的运行时错误\n')
  assert.equal(readyFirst.readyUrl, 'http://127.0.0.1:46141/?token=abc')
})

// ── task-71：试装文案（字面星号 / 空承诺 / 判不出来的归因） ────────────────────

test('根因链不给源码行与栈帧当原因（用户读到的必须是错误消息）', () => {
  const source = readFileSync(new URL('../dist/envManager.js', import.meta.url), 'utf8')
  void source
  const verbose = [
    'Error: dsh: plugin tree failed to load: failed to apply loader entry probe (probe): boom',
    'Error: boom',
    '    at updateError (file:///x/cordis-plugin-loader/lib/index.js:309:9)',
    'throw new Error(`${binName}: ${stage}: ${detail}${stack}`, { cause });',
    '[cause]: Error: failed to apply loader entry probe (probe): boom',
  ].join('\n')
  const verdict = env.judgeBootStderr(verbose)
  assert.equal(verdict.kind, 'failed')
  assert.match(verdict.reason, /^Error: dsh: plugin tree failed to load/, '第一条原因必须是错误消息，不是源码行')
  assert.ok(verdict.chain.every((line) => !/^at\s/.test(line)), '栈帧不许进根因链')
  assert.ok(verdict.chain.every((line) => !/^throw\s/.test(line)), '抛错处源码行不许进根因链')
  assert.ok(verdict.chain.some((line) => line.includes('[cause]')), 'cause 链要保住')
})

test('试装文案：不带字面星号、不写空承诺、判不出来不说成"基线起不来"', async () => {
  makeEnv('copy-src', { bundles: ['@deepseek-ai/dsh-base'] })
  const anchor = '/anchor/package.json'
  const build = env.buildIdentity()
  const runnerOk = installRunner('@fake/pkg')
  const runnerCold = async () => ({ exitCode: 1, output: 'ERR_PNPM_NO_OFFLINE_TARBALL 冷包', truncated: false, logPath: '/dev/null' })
  const mounted = async () => ({ verdict: { kind: 'mounted' }, elapsedMs: 1, stderr: '', exitCode: 1, build })
  const failed = async () => ({
    verdict: { kind: 'failed', reason: 'Error: dsh: plugin tree failed to load: boom', chain: ['Error: dsh: plugin tree failed to load: boom'] },
    elapsedMs: 1, stderr: 'x', exitCode: 1, build,
  })
  const undetermined = async () => ({
    verdict: { kind: 'undetermined', reason: '子进程没有输出任何 stderr 文本' }, elapsedMs: 1, stderr: '', exitCode: null, build,
  })
  const base = { installAnchor: anchor, depth: 'shallow', runCommand: runnerOk }

  const cold = await env.runTrialInstall('@fake/pkg', 'copy-src', { ...base, runCommand: runnerCold, allowNetwork: false, verify: mounted })
  const broken = await env.runTrialInstall('@fake/pkg', 'copy-src', { ...base, verify: failed })
  const unclear = await env.runTrialInstall('@fake/pkg', 'copy-src', { ...base, verify: undetermined })

  assert.equal(cold.conclusion, 'cannot-trial')
  assert.equal(broken.conclusion, 'baseline-broken')
  assert.equal(unclear.conclusion, 'cannot-trial')

  for (const [label, result] of [['冷包', cold], ['基线坏', broken], ['判不出来', unclear]]) {
    // 字面星号在 web 卡片上是噪声（task-55 同类）；这里连一处都不许有。
    assert.doesNotMatch(result.output, /\*\*/, label + '：试装文案不许带字面星号')
    // 空承诺：我们从不发这条诊断，写出来就是骗人。
    assert.doesNotMatch(result.output, /应当升级成一条诊断/, label + '：不许写"应当升级成一条诊断"这类空承诺')
  }
  assert.match(broken.output, /快照基线本身就起不来/)
  assert.match(broken.output, /根因：/)
  // 判不出来是"不知道"，不是"基线坏了"——两句话不许混。
  assert.match(unclear.output, /这次验证没有给出判定/)
  assert.doesNotMatch(unclear.output, /快照基线/, '判不出来不许写成基线起不来')
  assert.match(unclear.output, /判不出来：/)
})

test('残留删不掉时如实报「无法试装」，绝不静默沿用旧依赖', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root 下权限位不生效，这条用例的前提（删不掉）造不出来')
    return
  }
  const src = makeEnv('stale-src', { bundles: ['@deepseek-ai/dsh-base'] })
  await env.createTrialEnvironment('stale-src', { materialize: false })
  const target = env.trialEnvironmentName('stale-src')
  const targetDir = join(PROFILES, target)
  const locked = join(targetDir, 'node_modules', 'locked')
  mkdirSync(locked, { recursive: true })
  writeFileSync(join(locked, 'file.txt'), 'x')
  chmodSync(locked, 0o500)
  try {
    await assert.rejects(
      () => env.materializeSnapshot('stale-src', target, { depth: 'shallow' }),
      (error) => error.code === 'snapshot-not-shallow',
    )
    assert.equal(existsSync(join(locked, 'file.txt')), true, '删不掉就原样留着，不许假装清过')

    // 端到端：这一步失败必须是"无法试装"，不是通过
    const runnerOk = installRunner('@fake/pkg')
    const trial = await env.runTrialInstall('@fake/pkg', 'stale-src', {
      installAnchor: '/anchor/package.json', runCommand: runnerOk,
      verify: async () => ({ verdict: { kind: 'mounted' }, elapsedMs: 1, stderr: '', exitCode: 1, build: env.buildIdentity() }),
    })
    assert.equal(trial.conclusion, 'cannot-trial', '快照做不到真的浅 = 无法试装')
    assert.match(trial.output, /无法试装/)
    assert.match(trial.output, /snapshot-not-shallow/)
  } finally {
    chmodSync(locked, 0o700)
  }
})

/** async 版平台伪装：必须在 await 之后才还原（否则伪装在第一个 await 处失效）。 */
async function withPlatformAsync(platform, body) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    return await body()
  } finally {
    Object.defineProperty(process, 'platform', original)
  }
}

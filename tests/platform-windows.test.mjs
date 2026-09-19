/**
 * Windows 安全批次的 Linux 回归（审计 W-01/W-02/W-03/W-07/W-08/W-09）。
 *
 * 为什么能在 Linux 上跑：这些缺陷的判据要么是纯字符串解析（命令行分词），要么是平台
 * 分派（sameEnvironment / terminateInstance / 启动器形态），都可以用「伪装 process.platform
 * + 注入」的方式在 Linux 上钉住。真的需要 Windows 的进程/窗口语义部分，另在 wine 探针里
 * 取证据（/tmp/pmc-w49，见交付说明）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'pmc-win49-'))
process.env.DSH_HOME = HOME

const paths = await import('../dist/paths.js')
const env = await import('../dist/envManager.js')

/** 伪装平台（判定依赖 process.platform）。 */
async function withPlatform(platform, body) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    // 必须 await：async 体里平台在第一个 await 之后就还原的话，伪装等于没做（踩过一次）。
    return await body()
  } finally {
    Object.defineProperty(process, 'platform', original)
  }
}

function makeEnv(name, { bundles = [] } = {}) {
  const dir = join(HOME, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-' + name, dependencies: {}, dsh: { profile: { bundles } },
  }, undefined, 2) + '\n')
  writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
  return dir
}

const WINDOWS_LINES = {
  '未加引号的 bin.js': '4242\tC:\\Users\\me\\pnpm\\@deepseek-ai\\dsh\\lib\\bin.js --profile demo --port 3090',
  'Program Files 里带引号的 node 与 bin.js': '4243\t"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\nodejs\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" --profile demo --port 3091',
  '带引号的 node + 不带引号的 bin.js': '4244\t"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\me\\pnpm\\@deepseek-ai\\dsh\\lib\\bin.js --profile demo --port 3092',
  '家目录含空格': '4247\tC:\\Users\\John Doe\\pnpm\\@deepseek-ai\\dsh\\lib\\bin.js --profile demo --port 3095',
}

test('W-03: 带引号的 Windows 命令行必须能被认出来', async () => {
  makeEnv('demo')
  for (const [label, line] of Object.entries(WINDOWS_LINES)) {
    const runs = env.scanRunsNow({ reader: () => [line] }).get('demo') ?? []
    assert.equal(runs.length, 1, label + ' 必须识别为「正在运行」')
    assert.equal(runs[0].pid, Number(line.split('\t')[0]), label)
  }
  // 反例仍必须被挡住：入口不像 dsh 的进程不能被当成实例（否则 stop 会对无关进程下手）
  const foreign = env.scanRunsNow({ reader: () => ['4248\t"C:\\Program Files\\SomeApp\\bin.js" --profile demo --port 3096'] }).get('demo') ?? []
  assert.equal(foreign.length, 0, '无关进程不得被当成实例')
})

test('W-01 同族: listEnvironments 的 current 标记在大小写不敏感平台上认同一个目录', async () => {
  makeEnv('demo')
  const ctx = { get: (key) => (key === 'profileContext'
    ? { name: 'DEMO', installAnchor: '/anchor/package.json', cwd: '/tmp', home: HOME }
    : undefined) }
  await withPlatform('win32', () => {
    const item = env.listEnvironments(ctx).find((e) => e.name === 'demo')
    assert.equal(item.current, true, 'win32 上 DEMO 与 demo 是同一个目录')
  })
  await withPlatform('linux', () => {
    const item = env.listEnvironments(ctx).find((e) => e.name === 'demo')
    assert.equal(item.current, false, 'Linux 上它们是两个目录')
  })
})

test('W-01 同族: rename 的源与目标在同一台机器上是同一环境时先拒绝（不再靠 already-exists 兜）', async () => {
  makeEnv('demo')
  await withPlatform('win32', async () => {
    const result = await env.renameEnvironment('demo', 'DEMO', { current: null })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'invalid-name')
    assert.match(result.output, /同一个环境/)
  })
})

test('W-01 同族 + W-02: 运行中的查找按同环境匹配，且 Windows 分支如实报 taskkill', async () => {
  // 造一个「命令行像真实例」的真实子进程（Linux 也能起），放进进程扫描缓存；
  // 然后用非规范大小写的名字去停它 —— 修复前 .get('DEMO') 会查不到 → 报 not-running。
  makeEnv('demo')
  // Linux 大小写敏感：请求名要能通过 existsSync 那道门，两个目录都得在（win32 上它们是同一个）。
  makeEnv('DEMO')
  const entry = join(HOME, 'fake-install', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  mkdirSync(dirname(entry), { recursive: true })
  writeFileSync(entry, 'setTimeout(() => {}, 60000)\n')
  const child = spawn(process.execPath, [entry, '--profile', 'demo', '--port', '3599'], { stdio: 'ignore' })
  try {
    const found = await waitFor(() => (env.scanRuns({ fresh: true }).get('demo') ?? []).some((r) => r.pid === child.pid))
    assert.equal(found, true, '前提：这个子进程被扫描认出来了')
    env.resetRunCache()
    env.scanRuns({ reader: () => [String(child.pid) + '\t' + join(process.execPath) + ' ' + entry + ' --profile demo --port 3599'] })
    // Windows 语义：terminateInstance 走 taskkill（Linux 上没有这个命令 → 什么也没杀），
    // 于是进程还活着，stop 必须如实报 kill-timeout 并说明用的是强制结束。
    let clock = 0
    // 注入读命令行：Windows 分支在真 Windows 上走 powershell；Linux 上伪装平台后它必然读不到，
    // 于是用同一个接缝把「复核用的命令行」喂进去（复核逻辑本身仍是真代码）。
    const commandLine = join(process.execPath) + ' ' + entry + ' --profile demo --port 3599'
    const result = await withPlatform('win32', () => env.stopEnvironment('DEMO', {
      current: null, timeoutMs: 400, sleep: async () => {}, now: () => (clock += 200),
      readCommand: () => commandLine,
    }))
    assert.equal(result.ok, false, '进程没死就绝不能说停成功')
    assert.equal(result.code, 'kill-timeout')
    assert.match(result.output, /taskkill \/T \/F/)
    assert.equal(child.exitCode === null && child.signalCode === null, true, '前提：子进程确实还活着')
  } finally {
    env.resetRunCache()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
})

test('W-07: Windows 的 PATH shim 回退入口必须声明需要 shell（否则 spawn EINVAL）', async () => {
  await withPlatform('win32', () => {
    const fallback = env.dshEntryPoint(['node', 'Z:\\tmp\\probe.mjs'], 'win32')
    assert.equal(fallback.command, 'dsh.cmd')
    assert.equal(fallback.shell, true, 'Windows 上 .cmd 必须经 shell 执行（Node ≥20.12 起）')
  })
  // 首选路径保持无 shell 的官方启动纪律
  const primary = env.dshEntryPoint(['node', '/opt/apps/@deepseek-ai/dsh/lib/bin.js'], 'linux')
  assert.equal(primary.command, process.execPath)
  assert.equal(primary.shell, false)
  assert.equal(primary.entry, '/opt/apps/@deepseek-ai/dsh/lib/bin.js')
})

test('W-08: Windows 终端窗口用 argv 形态（wt），不再把裸拼接的命令行交给 shell 重分词', () => {
  const spaced = { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\Program Files\\x\\bin.js', '--profile', 'demo'] }
  const spec = {
    profile: 'demo', port: 3590, mode: 'terminal', command: spaced.command, args: spaced.args,
    entry: spaced.args[0], shell: false, dir: 'C:\\Users\\John Doe\\.dsh\\profiles\\demo',
    display: spaced.command + ' ' + spaced.args.join(' '),
  }
  const invocation = env.windowsTerminalInvocation(spec)
  assert.equal(invocation.command, 'wt', '官方目录项的 Windows 终端就是 wt')
  assert.deepEqual([...invocation.args], ['-d', spec.dir, spaced.command, ...spaced.args])
  assert.equal(invocation.args.includes(spec.display), false, '不得把裸拼接的 display 当成一条命令')
  assert.equal(invocation.args[2], 'C:\\Program Files\\nodejs\\node.exe', '含空格的路径必须是独立的一段')

  // .cmd shim：交给 cmd.exe，但同样是 argv 形态（不是一条字符串）
  const shim = env.windowsTerminalInvocation({ ...spec, command: 'dsh.cmd', shell: true })
  assert.equal(shim.args[2], 'cmd.exe')
  assert.deepEqual(shim.args.slice(3, 6), ['/d', '/s', '/c'])
  assert.equal(shim.args[6], 'dsh.cmd')
})

test('W-09: 终端窗口没起来时回退后台重试，并如实说明（不是 30s 后报「已启动」）', async () => {
  makeEnv('retry-env', { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] })
  const launches = []
  let clock = 0
  const result = await env.startEnvironment('retry-env', {
    mode: 'terminal', port: 3591, readyTimeoutMs: 500,
    launch: async (spec) => {
      launches.push(spec.mode)
      return spec.mode === 'terminal'
        ? { ok: true, mode: 'terminal', terminal: 'wt', detail: 'terminal attempt' }
        : { ok: true, mode: 'background', detail: 'background attempt' }
    },
    probe: async () => (launches.length >= 2 ? 401 : null),
    // 重试也走注入的启动器（源码就是这么接的）
    sleep: async () => {},
    now: () => (clock += 200),
  })
  assert.deepEqual(launches, ['terminal', 'background'], '终端未就绪必须回退后台一次')
  assert.equal(result.ok, true, result.output)
  assert.match(result.output, /已改为后台启动重试/)
  assert.match(result.output, /启动方式：后台/)
})

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() > deadline) return false
    await new Promise((done) => { setTimeout(done, 50) })
  }
}

test.after(() => { rmSync(HOME, { recursive: true, force: true }) })

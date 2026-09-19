#!/usr/bin/env node
/**
 * e2e-lifecycle.mjs — 真机跑完「建环境 → 启动 → 可达 → 停止」全链路并断言（零 bash）。
 *
 * 为什么有它：单测与视觉 e2e 都跑在「别人造好的 profile」上，从没调用过我们自己的
 * createEnvironment / startEnvironment。docs/CODE-POLICY.md §7.5 记的两处缺陷（默认建出的环境
 * 必然起不来、就绪判据把「TCP 可连接」当成「实例可用」）就藏在这条链上——这里把它变成每次都跑的断言。
 *
 * 与旧版 tools/e2e-lifecycle.sh 的差别（平台审计 W-24）：
 *   · **不复制 ~/.dsh/profiles/pm-test**、不跑 pnpm install：自己写 manifest + link 安装本仓库
 *     （`bundles: [base, web-app, dsh-plugin-manager-companion]`），官方 bundle 由**安装锚点**解析；
 *   · **零 shell**：不起 bash、不调 ss/grep/curl/setsid/pkill/date；端口用 node:net，HTTP 用全局 fetch，
 *     读日志用 fs，计时用 Date.now()；
 *   · 断言清单与输出格式与旧脚本**逐项同构**（PASS/FAIL + 计数 + 退出码），换实现不换判据。
 *
 * 用法：
 *   node tools/e2e-lifecycle.mjs        # 需要先构建（pnpm run build 或 pnpm run build:host）
 *   bash tools/e2e-lifecycle.sh         # 兼容壳：两行转发到本文件（旧文档仍引用它）
 * 退出码：0 全通过；1 有断言失败；2 环境问题（构建缺失 / 宿主起不来 / 找不到官方 dsh 安装）。
 *
 * 前置：
 *   1. dist/ 已构建（本脚本只检查存在性，不替你构建——构建是 pnpm 的事，不是 e2e 的事）；
 *   2. 本机能解析到官方 dsh 的 lib/bin.js。解析顺序（不需要 dsh 在 PATH 上）：
 *        a. DSH_E2E_BIN 环境变量（显式指定 bin.js；CI/别人机器就用它）
 *        b. PATH 各目录的常见全局布局（<dir>/../lib/node_modules、<dir>/node_modules、<dir>/../node_modules）
 *        c. ~/.local/share/pnpm/global/<ver>/node_modules/@deepseek-ai/dsh/lib/bin.js（pnpm 全局布局）
 *        d. $DSH_HOME/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js
 *        e. 从本仓库可解析的 @deepseek-ai/dsh（例如它出现在某个祖先 node_modules 里）
 *      找不到时退出码 2，并打印上面这份顺序（不猜、不静默）。
 *
 * 端口：落在**共享工具带 3300–3499**内（CODE-POLICY §7.7），并在选定前用 TCP 探测确认它空闲。
 *
 * Windows 状态（如实标注，本任务未在 Windows 上跑）：
 *   · 已做到的：无 bash 依赖；入口用 `process.execPath + bin.js`；进程树用 `taskkill /PID /T /F`
 *     （与 envManager 的 W-02 修复同形）；profile 里的 link 安装用 junction（不需要管理员）；
 *     临时 home 用 `mkdtempSync(tmpdir(), …)` 而不是硬编码 /tmp。
 *   · 尚未验证的：官方 dsh 在 Windows 上以临时 DSH_HOME 启动、bundle 由锚点解析这两点（需要真 win32 机器）；
 *     以及 Windows 上 profile 依赖的解析是否同样只靠锚点（Linux 上已实证：不需要 pm-test、不需要 pnpm install）。
 */

import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 共享工具带（CODE-POLICY §7.7）：本脚本自取自清，不落进任何人的号段。 */
const PORT_BAND = { min: 3350, max: 3449 }
/** 等宿主打印 token 的上限。 */
const BOOT_TIMEOUT_MS = 90_000
/** 单次 REST 调用的上限（与旧脚本的 curl -m 180 对齐）。 */
const REST_TIMEOUT_MS = 180_000

let passed = 0
let failed = false

/** 环境问题：打印原因并立刻以 2 退出（与旧脚本同语义）。 */
function environmentProblem(message, details) {
  console.log('环境问题: ' + message)
  if (details !== undefined) console.log(String(details).trimEnd())
  process.exit(2)
}

/** 一条断言：输出格式与旧脚本逐字同构（PASS/FAIL + 计数）。 */
function check(name, actual, expected) {
  if (actual === expected) {
    console.log('  PASS ' + name + ' — ' + actual)
    passed += 1
    return
  }
  console.log('  FAIL ' + name + ' — 实际=' + actual + ' 期望=' + expected)
  failed = true
}

/** 无断言的一条 PASS（旧脚本里 `echo PASS ...` 那两处）。 */
function pass(name, value) {
  console.log('  PASS ' + name + ' — ' + value)
  passed += 1
}

/** 无断言的一条 FAIL。 */
function fail(name, detail) {
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail))
  failed = true
}
/** 睡一会儿（不忙等）。 */
function sleep(ms) { return new Promise(resolvePromise => { setTimeout(resolvePromise, ms) }) }

/**
 * 官方 dsh 的 bin.js 候选（按文件头写的顺序）。
 * 刻意**不依赖 PATH 里的 dsh 可执行**：拿到 bin.js 后用 process.execPath 直接起（与
 * src/envManager.ts 的首选形态一致；Windows 上 dsh 是 .cmd shim，spawn 裸名会 EINVAL——见审计 W-07）。
 * @returns 候选绝对路径（可能不存在）。
 */
function dshBinCandidates() {
  const candidates = []
  const explicit = process.env.DSH_E2E_BIN
  if (explicit !== undefined && explicit.trim() !== '') candidates.push(resolve(explicit.trim()))
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    candidates.push(join(dir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
    candidates.push(join(dir, '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
    candidates.push(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  }
  // pnpm 全局布局是 <global>/<主版本>/<hash>/node_modules/…（两层）；顺带兼容只有一层的布局。
  const pnpmGlobal = join(homedir(), '.local', 'share', 'pnpm', 'global')
  if (existsSync(pnpmGlobal)) {
    for (const major of readdirSync(pnpmGlobal)) {
      const majorDir = join(pnpmGlobal, major)
      const versions = existsSync(join(majorDir, 'node_modules')) ? [''] : readdirSync(majorDir)
      for (const version of versions) {
        const root = version === '' ? majorDir : join(majorDir, version)
        candidates.push(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
      }
    }
  }
  const rawHome = process.env.DSH_HOME?.trim()
  const home = rawHome !== undefined && rawHome !== '' ? rawHome : join(homedir(), '.dsh')
  candidates.push(join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  try {
    const manifest = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')
    candidates.push(join(dirname(manifest), 'lib', 'bin.js'))
  } catch {
    // 本仓库没把 @deepseek-ai/dsh 作为依赖：这条候选天然不可用，跳过（不是错误）。
  }
  return candidates
}

/** @returns 存在且可用的 bin.js；都没有时 undefined。 */
function resolveDshBin() {
  for (const candidate of dshBinCandidates()) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * 自建宿主 profile（**不复制 pm-test、不跑 pnpm install**）：
 * 写 manifest（bundles = base + web-app + 本插件）并把本仓库 link 进 node_modules。
 *
 * 官方 bundle 由**安装锚点**解析：宿主进程由真 bin.js 启动，它的 installAnchor 指向 pnpm store 里
 * dsh 包所在目录，base/web-app 与它们的依赖都在同一 store 目录里（Linux 上已实证）。
 *
 * @param home - 临时 DSH_HOME。
 * @param name - 宿主 profile 名。
 */
function buildHostProfile(home, name) {
  const profileDir = join(home, 'profiles', name)
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-' + name,
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-plugin-manager-companion'] } },
    dependencies: { 'dsh-plugin-manager-companion': 'link:' + REPO },
  }, undefined, 2) + String.fromCharCode(10))
  // junction：Windows 上不需要 symlink 特权（官方 app-boot 的 ensureSymlink 同款）；POSIX 下 type 被忽略。
  symlinkSync(REPO, join(profileDir, 'node_modules', 'dsh-plugin-manager-companion'), 'junction')
  writeFileSync(join(profileDir, 'cordis.yml'), '[]' + String.fromCharCode(10))
  return profileDir
}

/** @returns 一个当前空闲的端口（落在共享工具带内）。 */
async function pickPort() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const port = PORT_BAND.min + Math.floor(Math.random() * (PORT_BAND.max - PORT_BAND.min + 1))
    if (!(await tcpOpen(port))) return port
  }
  environmentProblem('共享工具带 ' + PORT_BAND.min + '–' + PORT_BAND.max + ' 里找不到空闲端口')
}

/** TCP 探测：有人在听吗（用于选端口，不参与断言）。 */
function tcpOpen(port) {
  return new Promise(resolvePromise => {
    const socket = connect({ host: '127.0.0.1', port })
    const settle = (open) => { socket.destroy(); resolvePromise(open) }
    socket.setTimeout(500, () => settle(false))
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
  })
}

/**
 * HTTP 状态码（旧脚本用 `curl -w %{http_code}`；这里用全局 fetch）。
 * 连不上时返回 '000' —— 与 curl 的语义逐字一致（旧脚本正是靠这个值断言'停止后不可达'）。
 * redirect: 'manual' 是刻意的：带 token 的地址要断言的就是 303 本身，跟随重定向会把它掩盖掉。
 *
 * @param url - 目标地址。
 * @returns 状态码字符串，或 '000'。
 */
async function httpStatus(url) {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8_000) })
    return String(response.status)
  } catch {
    return '000'
  }
}

let HOST_PORT = 0
let TOKEN = ''

/**
 * 调一个 op（旧脚本的 op()：curl POST + authorization + origin + JSON）。
 * @param name - op 名。
 * @param body - 请求体对象。
 * @returns 状态码、原始文本与解析后的 JSON（解析失败时 undefined）。
 */
async function op(name, body) {
  const response = await fetch('http://127.0.0.1:' + HOST_PORT + '/api2/companion/' + name, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + TOKEN,
      origin: 'http://127.0.0.1:' + HOST_PORT,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(REST_TIMEOUT_MS),
  })
  const text = await response.text()
  let json
  try { json = JSON.parse(text) } catch { json = undefined }
  return { status: response.status, text, json }
}
/** 等宿主把带 token 的地址打进日志。 */
async function waitForToken(logPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(logPath)) {
      const match = /token=([A-Za-z0-9_-]+)/.exec(readFileSync(logPath, 'utf8'))
      if (match !== null) return match[1]
    }
    await sleep(500)
  }
  return undefined
}

/** 停进程树：POSIX 杀进程组，Windows 用 taskkill /T（与 envManager 的 W-02 修复同形）。 */
async function killHostTree(child) {
  if (child === undefined || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
  await sleep(1_000)
  if (child.exitCode === null) {
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
  }
}

/**
 * 收尾：先走我们自己的 stopEnvironment 停掉两个环境（不用 pkill —— 那是 Unix 专属且会误杀），
 * 再杀宿主进程树，最后删临时 home。任何一步失败都不掩盖主流程的断言结果。
 *
 * @param child - 宿主子进程。
 * @param home - 临时 DSH_HOME。
 * @param envNames - 本次创建过的环境名。
 */
async function cleanup(child, home, envNames) {
  for (const name of envNames) {
    if (TOKEN === '' || HOST_PORT === 0) break
    try { await op('stopEnvironment', { name }) } catch { /* 宿主已经没了：忽略 */ }
  }
  await killHostTree(child)
  try { rmSync(home, { recursive: true, force: true }) } catch { /* Windows 上可能被占用：尽力而为 */ }
}

async function main() {
  for (const artifact of ['dist/index.js', 'dist/cli.js']) {
    if (!existsSync(join(REPO, artifact))) {
      environmentProblem('缺少构建产物 ' + artifact + '；先跑 pnpm run build（本脚本不替你构建）')
    }
  }
  const bin = resolveDshBin()
  if (bin === undefined) {
    const candidates = dshBinCandidates()
    environmentProblem('找不到官方 dsh 的 lib/bin.js', [
      '  已按顺序找过 ' + candidates.length + ' 个候选位置；前 6 个：',
      ...candidates.slice(0, 6).map(candidate => '  - ' + candidate),
      '  修法：设 DSH_E2E_BIN=<dsh 安装目录>/lib/bin.js（例如 `npm i -g @deepseek-ai/dsh` 后再跑）。',
    ].join(String.fromCharCode(10)))
  }

  const home = mkdtempSync(join(tmpdir(), 'dsh-e2e-life-'))
  const hostProfile = 'pm-life-' + process.pid
  const envA = 'pm-life-a-' + process.pid
  const envB = 'pm-life-b-' + process.pid
  const logPath = join(home, 'host.log')
  let child
  try {
    HOST_PORT = await pickPort()
    buildHostProfile(home, hostProfile)
    const fd = openSync(logPath, 'a')
    child = spawn(process.execPath, [bin, '--profile', hostProfile, '--port', String(HOST_PORT), '--no-open'], {
      cwd: tmpdir(),
      env: { ...process.env, DSH_HOME: home },
      detached: process.platform !== 'win32',
      stdio: ['ignore', fd, fd],
    })
    closeSync(fd)

    TOKEN = await waitForToken(logPath, BOOT_TIMEOUT_MS) ?? ''
    if (TOKEN === '') {
      environmentProblem('宿主实例没起来', existsSync(logPath) ? readFileSync(logPath, 'utf8').split(String.fromCharCode(10)).slice(-20).join(String.fromCharCode(10)) : undefined)
    }
    console.log('== 宿主实例: profile=' + hostProfile + ' port=' + HOST_PORT + ' ==')

    console.log('== 1. environmentTemplates 逐字来自官方 PROFILE_TEMPLATES ==')
    let result = await op('environmentTemplates', {})
    check('默认模板是 web', String(result.json?.value?.default), 'web')
    check('模板数量', String(result.json?.value?.templates?.length), '5')
    const webTemplate = result.json?.value?.templates?.find(template => template.name === 'web')
    check('web 模板层栈', JSON.stringify(webTemplate?.bundles), '["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]')

    console.log('== 2. 省略模板建环境：必须是官方 web 层栈（旧代码这里是 base-only）==')
    result = await op('createEnvironment', { name: envA })
    check('createEnvironment ok', String(result.json?.value?.ok), 'true')
    const manifest = JSON.parse(readFileSync(join(home, 'profiles', envA, 'package.json'), 'utf8'))
    check('落盘层栈', JSON.stringify(manifest.dsh.profile.bundles), '["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]')

    console.log('== 3. 启动（后台）并按官方语义判定就绪 ==')
    result = await op('startEnvironment', { name: envA, background: true })
    check('startEnvironment ok', String(result.json?.value?.ok), 'true')
    const startOutput = String(result.json?.value?.output ?? '')
    const envPort = /127\.0\.0\.1:(\d+)/.exec(startOutput)?.[1]
    console.log('  端口=' + String(envPort))
    if (envPort !== undefined) {
      // 旧判据（只看 TCP 可连接）会在这里交出一个 404 的地址：实测 628ms 首个应答 404、838ms 才 401。
      check('返回那一刻就已经可用（不是 404）', await httpStatus('http://127.0.0.1:' + envPort + '/'), '401')
      const tokenUrl = /http:\/\/127\.0\.0\.1:\d+\/?\?token=[\w-]+/.exec(startOutput)?.[0]
      if (tokenUrl === undefined) fail('结果里没有带 token 的可用地址')
      else check('带 token 的可用地址真的能用', await httpStatus(tokenUrl), '303')
    } else {
      fail('startEnvironment 的输出里没有端口')
    }

    console.log('== 4. 停止后端口必须释放 ==')
    result = await op('stopEnvironment', { name: envA })
    check('stopEnvironment ok', String(result.json?.value?.ok), 'true')
    await sleep(1_000)
    if (envPort !== undefined) {
      // 与旧脚本同一个判据（curl 的 000 = 连不上）；此处由 fetch 抛错给出 000。
      check('停止后不可达', await httpStatus('http://127.0.0.1:' + envPort + '/'), '000')
    }

    console.log('== 5. 没有 web 层的环境：必须即时给出可操作的拒绝，而不是干等 30 秒 ==')
    await op('createEnvironment', { name: envB, template: 'headless' })
    const startedAt = Date.now()
    result = await op('startEnvironment', { name: envB })
    const elapsedMs = Date.now() - startedAt
    check('如实拒绝', String(result.json?.value?.code), 'no-web-layer')
    if (elapsedMs < 5000) pass('拒绝耗时 <5s', elapsedMs + 'ms')
    else fail('拒绝耗时 ' + elapsedMs + 'ms（应远小于 30s 超时）')
    const rejectOutput = String(result.json?.value?.output ?? '')
    if (rejectOutput.includes('@deepseek-ai/dsh-web-app')) pass('拒绝文案给出了可操作的下一步', '包含 dsh-web-app')
    else fail('拒绝文案没有说明该怎么办')

    console.log('== 6. 收尾：端口与进程无残留 ==')
    result = await op('listEnvironments', {})
    const leftoverRuns = (result.json?.value ?? [])
      .filter(environment => environment.name === envA || environment.name === envB)
      .map(environment => environment.runs.length)
    check('两个环境都没有运行中的实例', JSON.stringify(leftoverRuns), '[0,0]')
  } finally {
    await cleanup(child, home, [envA, envB])
  }

  console.log('')
  console.log('结果: ' + passed + ' 项通过')
  if (failed) {
    console.log('存在失败断言 —— 生命周期门禁未通过')
    process.exit(1)
  }
  console.log('生命周期门禁通过')
}

main().catch((error) => {
  environmentProblem('e2e-lifecycle 未预期失败: ' + (error instanceof Error ? error.message : String(error)))
})

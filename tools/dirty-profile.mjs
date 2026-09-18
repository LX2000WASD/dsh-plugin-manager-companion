/**
 * dirty-profile — 造一个"脏环境"，让体检页真的跑出问题（干净 profile 永远 0 问题，这条路径没人看过）。
 *
 * 归属：A 类·重写（审计期在 /tmp 里手工拼的脏环境没有保留价值；这里按同一意图重写并参数化）。
 * 旧实现参考：无（旧仓库的 analyze 测试用进程内假 ctx，未做真 profile 脏环境）。
 * 官方复用：只用 dsh CLI 起 profile（--profile/--port/--no-open）与 profile 自身的
 *   package.json / cordis.patch.yml / node_modules 布局；诊断结论一律取本插件 REST 的 diagnose op。
 * 前提检查：L1 只检查**被 manifest 声明**的包（src/diagnostics.ts collectStaticFacts 的 declared），
 *   所以脏包必须写进 profile 的 dependencies 才会被扫到；L2 只读 patch 文本（不启动 loader）；
 *   L3 读的是运行时 loader 树，坏行是否让整实例起不来必须实测。
 *
 * 造的脏（默认 bootsafe 变体，全部可启动、可被 L1/L2 看到）：
 *   D1 L1 · 声明了但没装：profile dependencies 里加两个磁盘上不存在的包名
 *   D2 L1 · 被扫描的本地包：node_modules/dsh-dirty-local（真实存在且已声明，进入 import 图）
 *   D3 L2 · 官方行被禁用：cordis.patch.yml 里 `- id: <官方行> / disabled: true`（patch 层正规用法）
 *   D4 L2 · insert 行没有显式 id：随机 id，任何按 id 定位的操作都指不稳（report-only）
 *
 * **实测约束（造脏前必读）**：三种"看起来更狠"的脏会让 dsh 在启动阶段硬失败，连界面都没有，
 * 因此不放进可启动变体（只在 --variant hostile 里复现）：bundle 声明了装不上的组合包
 * （"cannot resolve profile bundle"）、patch 行指向解析不到的包（ERR_MODULE_NOT_FOUND）、
 * 同一个 insert 列表内两行同 id（`duplicate loader entry id`；**per-group** 判定——同一个 id 落在两个不同
 * insert 列表并不致命）。详见 docs/private/visual-audit.md §11.1。
 *
 * 用法：
 *   node tools/dirty-profile.mjs --profile pm-dirty-$$ [--port 3411] [--keep] [--out /tmp/vis-dirty]
 *   不提 --keep 时跑完自行清理（杀实例 + 删 profile）；--keep 起完停在端口上，供
 *   tools/dirty-ui-audit.mjs 取证，之后自行 kill 并删除 profile。
 * 输出：脏环境事实（落了哪些）、diagnose 的 issues 摘要（按层/严重度）与
 *   `<out>/dirty-report.json`；退出码 0 表示"脏得能被诊断命中"，1 表示脏得不够，2 表示环境失败。
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ── 参数 ───────────────────────────────────────────────────────────────────

/** 解析 --k v / --k=v。 */
function parseArgv(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const eq = token.indexOf('=')
    if (eq > 0) { out[token.slice(2, eq)] = token.slice(eq + 1); continue }
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) { out[token.slice(2)] = next; i += 1; continue }
    out[token.slice(2)] = 'true'
  }
  return out
}

const argv = parseArgv(process.argv.slice(2))
const profilesRoot = join(homedir(), '.dsh', 'profiles')
const sourceProfile = argv.source ?? 'pm-test'
const profile = argv.profile ?? ('pm-dirty-' + process.pid)
const port = Number(argv.port ?? (3400 + Math.floor(Math.random() * 200)))
const outDir = argv.out ?? '/tmp/vis-dirty'
const keep = argv.keep === 'true'
/** bootsafe：不会让整实例起不来的最小脏；hostile：同一个 insert 列表里塞重复 id（实测会崩的那种）。 */
const variant = argv.variant ?? 'bootsafe'
/** 被禁用的官方行（web-app 组合包里真实存在的行 id）。 */
const disabledRow = argv['disabled-row'] ?? 'ui-sidebar-files'
/** 无显式 id 的 insert 行用哪个真实包名（必须是环境中能解析到的包，否则实例起不来）。 */
const anonymousRow = argv['anonymous-row'] ?? '@deepseek-ai/dsh-client-ui-plugin-manager'
const logPath = join(outDir, 'dsh-dirty.log')
const envFile = join(outDir, 'dirty.env')

const sourceDir = join(profilesRoot, sourceProfile)
/** 本仓库根（profile 的 link 安装指向这里）。 */
const repoRoot = new URL('..', import.meta.url).pathname
const profileDir = join(profilesRoot, profile)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/** 写 JSON 文件。 */
function writeJson(path, value) { writeFileSync(path, JSON.stringify(value, null, 2) + '\n') }

/** 读 JSON 文件。 */
function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')) }

// ── 造脏 ───────────────────────────────────────────────────────────────────

/**
 * 建 profile：复制源 profile 的清单与 patch，link 安装本插件，然后注入 6 处脏。
 * @returns 实际落地的脏清单（供报告引用）。
 */
function build(planted) {
  if (existsSync(profileDir)) rmSync(profileDir, { recursive: true, force: true })
  mkdirSync(profileDir, { recursive: true })
  for (const file of ['package.json', 'cordis.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) {
    const from = join(sourceDir, file)
    if (existsSync(from)) writeFileSync(join(profileDir, file), readFileSync(from, 'utf8'))
  }
  // D1：声明了但没装
  const phantom = 'dsh-plugin-phantom-' + process.pid
  const manifest = readJson(join(profileDir, 'package.json'))
  const phantom2 = 'dsh-plugin-local-missing-' + process.pid
  manifest.dependencies = { ...(manifest.dependencies ?? {}), [phantom]: '^9.9.9', [phantom2]: '^1.0.0' }
  // bundles 里加一个磁盘上不存在的组合包：这是 L1「声明了但没装」与 L4「声明未装」最直白的形态。
  // （实测 loader 对缺失组合包不会中止启动，能落到界面里看。）
  // 注意：bundles 里的"声明了但没装"**不能进这个可启动的脏环境**——实测 dsh CLI 在
  // 启动前就硬拒绝（"cannot resolve profile bundle ... from the dsh installation or <profile>"），
  // 连界面都没有。它属于"根本起不来"那一类，见 --variant hostile 的说明。
  if (variant === 'hostile') {
    const phantomBundle = 'dsh-bundle-phantom-' + process.pid
    manifest.dsh = { ...(manifest.dsh ?? {}) }
    manifest.dsh.profile = { ...(manifest.dsh.profile ?? {}) }
    manifest.dsh.profile.bundles = [...(manifest.dsh.profile.bundles ?? []), phantomBundle]
    planted.push({ id: 'D1b', layer: 'dependency+consistency', what: 'bundles 里声明了但没装的组合包（启动前硬拒）', where: 'package.json dsh.profile.bundles.' + phantomBundle })
  }
  writeJson(join(profileDir, 'package.json'), manifest)
  planted.push({ id: 'D1', layer: 'dependency', what: '声明了但没装的包（两条）', where: 'package.json dependencies.' + phantom + ' / ' + phantom2 })
  planted.push({ id: 'D3', layer: 'composition', what: '禁用官方 loader 行 ' + disabledRow + '（依赖方变成"依赖被禁用"）', where: 'cordis.patch.yml' })

  // patch 文本：默认只写"按 id 禁用一行"——这是 patch 层的正规用法，实例照样起得来。
  const patchLines = ['# 脏环境（tools/dirty-profile.mjs 生成，非用户配置）']
  const disabledBlock = ['- id: ' + disabledRow, '  disabled: true']
  // L2 · unaddressable-row：只有 name、没有 id 的 insert 行（loader 会给它随机 id）
  // 顶层 insert 的列表项是 4 空格缩进（与官方 web-app patch 同）；name 必须加引号——
  // YAML 里 @ 是保留起始符，不引号会 "bad indentation of a mapping entry"（实测）。
  const insertLines = ['', '- insert:', '    - name: "' + anonymousRow + '"']
  const body = variant === 'no-insert' ? disabledBlock : [...disabledBlock, ...insertLines]
  patchLines.push(...body, '')
  if (variant === 'hostile') {
    // 实测这两条都会让整个实例起不来（loader 在 include 层直接抛），只用于复现"用户什么都看不到"
    patchLines.push('- insert:', '    - id: dirty-dup-row', '      name: ./dirty-anonymous.mjs',
      '    - id: dirty-dup-row', '      name: ./dirty-anonymous.mjs', '')
    planted.push({ id: 'D-hostile', layer: 'composition', what: 'patch 里插一行坏行（实测启动前就抛 duplicate/ERR_MODULE_NOT_FOUND）', where: 'cordis.patch.yml' })
  }
  writeFileSync(join(profileDir, 'cordis.patch.yml'), patchLines.join('\n'))

  // 两个可解析的 insert 目标（patch 里相对名按 patch 所在目录解析；写成真文件，不是目录）
  writeFileSync(join(profileDir, 'dirty-local-a.mjs'), 'export const name = "dirty-local-a"\n')
  writeFileSync(join(profileDir, 'dirty-local-b.mjs'), 'export const name = "dirty-local-b"\n')

  // D2：本地包 import 一个已装包，却不写进自己的 dependencies
  const localDir = join(profileDir, 'node_modules', 'dsh-dirty-local')
  mkdirSync(localDir, { recursive: true })
  writeJson(join(localDir, 'package.json'), {
    name: 'dsh-dirty-local', version: '1.0.0', type: 'module', main: 'index.js',
    // 本地包自己声明两个装不上的依赖：L1 会逐条报"声明了但没装"（scope 指向这个包，肉眼可核对）
    dependencies: { 'dsh-plugin-local-missing-a': '^1.0.0', 'dsh-plugin-local-missing-b': '^2.0.0' },
  })
  // import 一个"已装但被 patch 禁用"的官方包：同时命中 L1（未声明 import）与 L2（依赖被禁用）
  writeFileSync(join(localDir, 'index.js'), "import '@deepseek-ai/dsh-client-ui-sidebar-files'\nexport const name = 'dsh-dirty-local'\n")
  planted.push({ id: 'D2', layer: 'dependency', what: '本地包声明了两个装不上的依赖（模型包 ×2）', where: 'node_modules/dsh-dirty-local/package.json' })
  const manifest2 = readJson(join(profileDir, 'package.json'))
  manifest2.dependencies['dsh-dirty-local'] = 'file:./node_modules/dsh-dirty-local'
  writeJson(join(profileDir, 'package.json'), manifest2)

  // 不跑 pnpm install：脏清单里的包名磁盘上本来就不存在，install 会 ERR_PNPM_FETCH_404
  // （实测）。改为手工建 profile 自己的 node_modules 链接——这也是"link 安装"的真实落盘形态。
  const modulesDir = join(profileDir, 'node_modules')
  mkdirSync(modulesDir, { recursive: true })
  const pluginLink = join(modulesDir, 'dsh-plugin-manager-companion')
  if (!existsSync(pluginLink)) symlinkSync(join(repoRoot, '.'), pluginLink, 'dir')
}

// ── REST 调用 ──────────────────────────────────────────────────────────────

/**
 * 调本插件自有 REST。
 * @param op - 操作名。
 * @param body - 请求体。
 * @returns 信封里的 value。
 */
async function callOp(op, body) {
  const response = await fetch('http://127.0.0.1:' + port + '/api2/companion/' + op, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:' + port },
    body: JSON.stringify(body),
  })
  const payload = await response.json()
  if (payload.ok !== true) throw new Error(op + ' 失败: ' + JSON.stringify(payload.error))
  return payload.value
}

/** 跑一次 diagnose（长操作：轮询 job）。 */
async function diagnose() {
  const started = await callOp('diagnose', {})
  if (started === null || typeof started !== 'object' || typeof started.jobId !== 'string') return started
  for (let i = 0; i < 120; i += 1) {
    const status = await callOp('job', { id: started.jobId })
    if (status.done === true) return status.result
    await sleep(250)
  }
  throw new Error('diagnose job 超时')
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

mkdirSync(outDir, { recursive: true })
const planted = []
if (argv['no-build'] === 'true' && existsSync(profileDir)) {
  console.log('复用已存在的脏环境: ' + profileDir + '（--no-build）')
} else {
  build(planted)
  console.log('脏环境已建: ' + profileDir)
  for (const item of planted) console.log('  ' + item.id + ' L[' + item.layer + '] ' + item.what + ' — ' + item.where)
}

// 输出直接进日志文件：detached 进程在本次调用结束后仍能继续跑（--keep 模式要靠它拿 token）。
writeFileSync(logPath, '')
const { openSync } = await import('node:fs')
const logFd = openSync(logPath, 'a')
const child = spawn('dsh', ['--profile', profile, '--port', String(port), '--no-open'], {
  detached: true, stdio: ['ignore', logFd, logFd],
})
child.unref()

/**
 * 等实例就绪：日志里出现 token。
 * @returns token。
 */
async function waitUp() {
  for (let i = 0; i < 120; i += 1) {
    const text = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
    const match = text.match(/token=([\w-]+)/)
    if (match !== null) return match[1]
    await sleep(500)
  }
  const tail = existsSync(logPath) ? readFileSync(logPath, 'utf8').slice(-800) : '(无日志)'
  throw new Error('实例没起来：' + tail)
}

let exitCode = 0
try {
  const token = await waitUp()
  writeFileSync(envFile, 'PORT=' + port + '\nTOKEN=' + token + '\nOUT=' + outDir + '\n')
  console.log('实例已起: http://127.0.0.1:' + port + '/ 日志 ' + logPath)

  const report = await diagnose()
  const issues = report?.issues ?? []
  const counts = report?.counts ?? {}
  const skipped = report?.skipped ?? []
  const byLayer = {}
  const bySeverity = {}
  for (const issue of issues) {
    byLayer[issue.layer] = (byLayer[issue.layer] ?? 0) + 1
    bySeverity[issue.severity] = (bySeverity[issue.severity] ?? 0) + 1
  }
  console.log('')
  console.log('诊断结果: ' + issues.length + ' 条问题  层计数=' + JSON.stringify(counts))
  console.log('  按层: ' + JSON.stringify(byLayer) + '  按严重度: ' + JSON.stringify(bySeverity))
  console.log('  skipped: ' + JSON.stringify(skipped))
  for (const issue of issues) console.log('  · [' + issue.layer + '/' + issue.severity + '] ' + issue.title)
  writeJson(join(outDir, 'dirty-report.json'), { profile, port, planted, counts, byLayer, bySeverity, issues, skipped })

  const layersHit = Object.keys(byLayer).filter(layer => byLayer[layer] > 0)
  if (layersHit.length < 2 || issues.length === 0) {
    console.error('脏得不够：命中的层 ' + JSON.stringify(layersHit) + '，问题 ' + issues.length + ' 条')
    exitCode = 1
  } else {
    console.log('')
    console.log('OK：命中 ' + layersHit.join(', ') + '，共 ' + issues.length + ' 条问题（截图用 ' + envFile + '）')
  }
} catch (error) {
  console.error('失败: ' + (error && error.message ? error.message : String(error)))
  exitCode = 2
} finally {
  if (keep) {
    console.log('实例保留在端口 ' + port + '（--keep）；审计完请自行 kill 并 rm -rf ' + profileDir)
  } else {
    try { process.kill(-child.pid, 'SIGTERM') } catch { /* 已退出 */ }
    try { execFileSync('bash', ['-c', 'ss -tlnp | grep \":' + port + ' \" | grep -oP "pid=\\K[0-9]+" | head -1 | xargs -r kill']) } catch { /* 没有监听 */ }
    rmSync(profileDir, { recursive: true, force: true })
    console.log('已清理: ' + profileDir)
  }
}
process.exit(exitCode)

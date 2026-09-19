#!/usr/bin/env node
/**
 * upgrade-realdevice.mjs — 升级引擎的**真机**验证（不注入任何替身；真出网、真装包）。
 *
 * 验三件事，全部以盘上事实为准：
 *   ① **金丝雀的激活修复**：把"已装插件的新版本"装进测试环境时，候选要真的进
 *      dsh.profile.bundles（否则官方 reconcile 跳过既有依赖 → 挂载期不加载 → 假通过）。
 *      走**真官方通道**（runPluginCommand → 真 pnpm），不注入 runner。
 *   ② 一次**真升级**：官方 add <name>@<version>，前后给出依赖行 / node_modules 版本 / 层栈。
 *   ③ 一次**真回滚**：装回原版本，并按盘上事实核对干净。
 *
 * 被测包用 @deepseek-ai/dsh-experimental-auto-review（官方实验包，声明了 dsh.bundle，
 * registry 上真有 alpha.1 与 alpha.2 两个版本，所以"升级"与"回滚"都是真实动作）。
 *
 * 用法：node tools/upgrade-realdevice.mjs [--keep]
 * 退出码：0 全通过；1 有断言失败；2 环境问题。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const KEEP = process.argv.includes('--keep')
const NL = String.fromCharCode(10)
/** 被测包：两个真实版本，且声明 dsh.bundle（能进层栈）。 */
const PKG = '@deepseek-ai/dsh-experimental-auto-review'
const OLD_VERSION = '0.1.6-alpha.1'
const NEW_VERSION = '0.1.6-alpha.2'

let passed = 0, failed = false
const check = (name, actual, expected) => {
  if (actual === expected) { console.log('  PASS ' + name + ' — ' + JSON.stringify(actual)); passed += 1; return }
  console.log('  FAIL ' + name + ' — 实际=' + JSON.stringify(actual) + ' 期望=' + JSON.stringify(expected)); failed = true
}
const note = (line) => console.log('  ' + line)
const block = (text) => console.log(String(text).split(NL).map((l) => '    ' + l).join(NL))
const envProblem = (msg) => { console.log('环境问题: ' + msg); process.exit(2) }
const readdirSafe = (dir) => { try { return readdirSync(dir) } catch { return [] } }

/** 官方安装锚点：dsh 应用包自己的 package.json（与 ctx.profileContext.installAnchor 同源）。 */
function findAnchor() {
  try { return createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json') } catch { /* 继续找 */ }
  // pnpm 全局布局：<global>/<major>/<hash>/node_modules/@deepseek-ai/dsh/package.json
  const pnpmGlobal = join(homedir(), '.local', 'share', 'pnpm', 'global')
  if (existsSync(pnpmGlobal)) {
    for (const major of readdirSafe(pnpmGlobal)) {
      const majorDir = join(pnpmGlobal, major)
      const dirs = existsSync(join(majorDir, 'node_modules')) ? [''] : readdirSafe(majorDir)
      for (const sub of dirs) {
        const p = join(majorDir, sub, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
        if (existsSync(p)) return p
      }
    }
  }
  return undefined
}

const anchor = findAnchor()
if (anchor === undefined) envProblem('找不到官方 @deepseek-ai/dsh 的 package.json（installAnchor 的来源）')
note('installAnchor = ' + anchor)

// 独立 DSH_HOME：绝不动用户真实 ~/.dsh
const HOME = mkdtempSync(join(tmpdir(), 'pmc-upgrade-real-'))
process.env.DSH_HOME = HOME
const PROFILES = join(HOME, 'profiles')
note('DSH_HOME = ' + HOME + '（临时；不碰真实 ~/.dsh）')

const up = await import(join(REPO, 'dist/upgrade.js'))
const settings = await import(join(REPO, 'dist/settings.js'))

const manifestOf = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
const installedVersion = (dir, name) => {
  try { return JSON.parse(readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8')).version } catch { return null }
}
/** 盘上事实快照（版本 + 依赖行 + 层栈）。 */
const factsOf = (dir, name) => ({
  version: installedVersion(dir, name),
  spec: manifestOf(dir).dependencies?.[name] ?? null,
  bundles: manifestOf(dir).dsh?.profile?.bundles ?? [],
})

/** 造一个真实 profile（headless 模板层栈 + 被测包）。 */
function makeEnv(name) {
  const dir = join(PROFILES, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-' + name, private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
  }, undefined, 2) + NL)
  return dir
}

try {
  const real = makeEnv('real-upgrade')

  // ── 0. 真实安装旧版本（官方通道）──────────────────────────────────────
  console.log(NL + '=== 0. 用官方通道装上 ' + PKG + '@' + OLD_VERSION + ' ===')
  const prep = await up.runOfficialAdd('real-upgrade', PKG + '@' + OLD_VERSION, { installAnchor: anchor })
  check('官方 add 退出码', prep.exitCode, 0)
  if (prep.exitCode !== 0) { block(prep.output.trim().slice(-600)); envProblem('准备环境失败（装不上旧版本）') }
  const before = factsOf(real, PKG)
  note('装后盘上事实：' + JSON.stringify(before))
  check('旧版本已装进 node_modules', before.version, OLD_VERSION)
  check('旧版本进了层栈（dsh.bundle 被官方 reconcile 激活）', before.bundles.includes(PKG), true)

  // ── 1. 金丝雀激活：真官方通道，不注入 runner ──────────────────────────
  console.log(NL + '=== 1. 金丝雀激活（真官方通道，不注入 runner）===')
  const canary = await up.runUpgradeCanary('real-upgrade', PKG + '@' + NEW_VERSION, {
    ...settings.DEFAULT_CONFIG,
    // 浅快照 + 不做基线启动：这条验证的是**层栈激活**，不是启动器（启动器另有 task-50/75 证据）。
    trial: { ...settings.DEFAULT_TRIAL_CONFIG, enabled: true, depth: 'shallow', baseline: false },
  }, {
    installAnchor: anchor,
    verify: async () => ({ verdict: { kind: 'mounted' }, elapsedMs: 1, stderr: '', stdout: '', exitCode: 0, build: {} }),
    log: (line) => note('[清理日志] ' + line),
  })
  note('金丝雀结论 = ' + String(canary.conclusion))
  note('激活证据 = ' + JSON.stringify(canary.activation))
  block(canary.output ?? '')
  check('候选进了测试环境的层栈（dsh.profile.bundles）', canary.activation?.activated, true)
  check('为了让候选成为"新装"而先走了官方 remove', canary.activation?.removedFirst, true)
  check('结论是 passed', canary.conclusion, 'passed')
  check('测试环境用完即删', existsSync(join(PROFILES, 'real-upgrade-dpmc')), false)

  // ── 2. 真升级（官方 add 到新版本）────────────────────────────────────
  console.log(NL + '=== 2. 真升级（官方 add ' + NEW_VERSION + '）===')
  const upgraded = await up.upgradePackage({
    environment: 'real-upgrade', name: PKG, version: NEW_VERSION,
    config: { ...settings.DEFAULT_CONFIG, trial: { ...settings.DEFAULT_TRIAL_CONFIG, enabled: false } },
    installAnchor: anchor, log: (line) => note('[清理日志] ' + line),
  })
  const afterUp = factsOf(real, PKG)
  note('升级 ok = ' + String(upgraded.ok) + '，code = ' + String(upgraded.code ?? '—'))
  block((upgraded.output ?? '').split(NL).slice(0, 8).join(NL))
  check('升级成功', upgraded.ok, true)
  check('盘上版本变成新版本', afterUp.version, NEW_VERSION)
  check('层栈里仍然有它', afterUp.bundles.includes(PKG), true)
  note('升级前 = ' + JSON.stringify(before))
  note('升级后 = ' + JSON.stringify(afterUp))

  // ── 3. 真回滚（官方 add 装回旧版本）──────────────────────────────────
  console.log(NL + '=== 3. 真回滚（官方 add 装回 ' + OLD_VERSION + '）===')
  const rolled = await up.rollbackUpgrade({
    environment: 'real-upgrade', name: PKG, version: OLD_VERSION,
    config: settings.DEFAULT_CONFIG, installAnchor: anchor, log: (line) => note('[清理日志] ' + line),
  })
  const afterRoll = factsOf(real, PKG)
  note('回滚 ok = ' + String(rolled.ok) + '，clean = ' + String(rolled.clean))
  block((rolled.output ?? '').split(NL).slice(0, 6).join(NL))
  check('回滚成功', rolled.ok, true)
  check('盘上核对干净', rolled.clean, true)
  check('盘上版本回到旧版本', afterRoll.version, OLD_VERSION)
  check('层栈回到原样', JSON.stringify(afterRoll.bundles), JSON.stringify(before.bundles))

  console.log(NL + '断言：' + passed + ' 通过' + (failed ? '，有失败' : '，全部通过'))
} finally {
  if (!KEEP) rmSync(HOME, { recursive: true, force: true })
  else console.log('（--keep：保留 ' + HOME + '）')
}
process.exit(failed ? 1 : 0)

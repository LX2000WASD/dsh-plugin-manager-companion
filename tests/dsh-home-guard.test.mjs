/**
 * dsh-home-guard / dirty-profile 的「不许默认写真实 HOME」行为测试（node --test，自动发现）。
 *
 * 来源是一次真实事故：tools/dirty-profile.mjs 曾默认用 os.homedir()/.dsh；按文档不带 DSH_HOME 跑一次，
 * 就在用户真实家目录里建出了 demo profile。此后口径是 fail loud：目标必须显式给，指向真实 home 要显式放行。
 *
 * 纪律：所有 spawn 都把 HOME/USERPROFILE 指向 mkdtemp 出来的临时目录 —— 即使守卫被改坏（变异验证时就是这么干的），
 * 也只会污染临时目录，碰不到真实家目录。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MISSING_TARGET_HOME, REAL_HOME_TARGET, resolveTargetDshHome, samePath } from '../tools/dsh-home-guard.mjs'

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SCRIPT = join(REPO, 'tools', 'dirty-profile.mjs')

/** 造一个临时「真实家目录」：测试里的 HOME 一律指向它。 */
function tempHome() {
  return mkdtempSync(join(tmpdir(), 't72-real-'))
}

/** 以给定的「真实家目录」跑脚本（绝不使用进程继承的真实 HOME）。 */
function runScript(home, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: '' },
  })
}

test('守卫：既没 --dsh-home 也没 DSH_HOME → 拒绝，并说明怎么给', () => {
  const verdict = resolveTargetDshHome({ argvHome: undefined, envHome: '', realHome: '/home/someone' })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, MISSING_TARGET_HOME)
  assert.match(verdict.message, /拒绝运行/)
  assert.match(verdict.message, /--dsh-home/)
  assert.match(verdict.message, /DSH_HOME=/)
})

test('守卫：DSH_HOME 可用，--dsh-home 优先于它', () => {
  const fromEnv = resolveTargetDshHome({ argvHome: undefined, envHome: '/tmp/some-env-home', realHome: '/home/someone' })
  assert.equal(fromEnv.ok, true)
  assert.equal(fromEnv.source, 'env')
  assert.equal(fromEnv.dshHome, resolve('/tmp/some-env-home'))
  const fromFlag = resolveTargetDshHome({ argvHome: '/tmp/some-flag-home', envHome: '/tmp/some-env-home', realHome: '/home/someone' })
  assert.equal(fromFlag.ok, true)
  assert.equal(fromFlag.source, 'flag')
  assert.equal(fromFlag.dshHome, resolve('/tmp/some-flag-home'))
})

test('守卫：目标是真实 harness home（含等价写法与符号链接）→ 拒绝并点名路径', () => {
  const realHome = tempHome()
  const realHarnessHome = join(realHome, '.dsh')
  mkdirSync(realHarnessHome, { recursive: true })
  const link = join(tmpdir(), 't72-link-' + process.pid)
  rmSync(link, { force: true })
  symlinkSync(realHarnessHome, link, 'dir')
  try {
    const candidates = [
      realHarnessHome,
      realHarnessHome + '/',
      realHarnessHome + '/./',
      join(realHarnessHome, '..', '.dsh'),
      link,
    ]
    for (const candidate of candidates) {
      const verdict = resolveTargetDshHome({ argvHome: candidate, envHome: '', realHome })
      assert.equal(verdict.ok, false, candidate + ' 应被拒绝')
      assert.equal(verdict.code, REAL_HOME_TARGET, candidate)
      assert.ok(verdict.message.includes(realHarnessHome), '拒绝文案要点名它想写哪里')
    }
    const root = resolveTargetDshHome({ argvHome: realHome, envHome: '', realHome })
    assert.equal(root.ok, false)
    assert.equal(root.code, REAL_HOME_TARGET)
  } finally {
    rmSync(link, { force: true })
    rmSync(realHome, { recursive: true, force: true })
  }
})

test('守卫：--allow-real-home 才放行真实 home；其它位置直接放行', () => {
  const realHome = tempHome()
  try {
    const allowed = resolveTargetDshHome({ argvHome: join(realHome, '.dsh'), envHome: '', realHome, allowRealHome: true })
    assert.equal(allowed.ok, true)
    assert.equal(allowed.realHome, true)
    const elsewhere = resolveTargetDshHome({ argvHome: join(realHome, 'work-home'), envHome: '', realHome })
    assert.equal(elsewhere.ok, true)
    assert.equal(elsewhere.realHome, false)
  } finally {
    rmSync(realHome, { recursive: true, force: true })
  }
})

test('脚本：无参数运行必须拒绝，且不在真实家目录里建任何东西', () => {
  const realHome = tempHome()
  try {
    const result = runScript(realHome, ['--profile', 'guard-probe'])
    assert.notEqual(result.status, 0, '必须非 0 退出')
    assert.match(result.stderr, /拒绝运行/)
    assert.equal(existsSync(join(realHome, '.dsh')), false, '真实 home 必须纹丝不动')
  } finally {
    rmSync(realHome, { recursive: true, force: true })
  }
})

test('脚本：显式指向真实 home → 拒绝且不创建目录', () => {
  const realHome = tempHome()
  try {
    const result = runScript(realHome, ['--dsh-home', join(realHome, '.dsh'), '--profile', 'guard-probe'])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /真实 harness home/)
    assert.ok(result.stderr.includes(join(realHome, '.dsh')), '要点名它想写哪里')
    assert.equal(existsSync(join(realHome, '.dsh')), false)
  } finally {
    rmSync(realHome, { recursive: true, force: true })
  }
})

test('脚本：给了临时 --dsh-home → 通过守卫并真的写到那个 home（源 profile 不存在，随后失败）', () => {
  const realHome = tempHome()
  const workHome = mkdtempSync(join(tmpdir(), 't72-work-'))
  try {
    const outDir = join(workHome, 'out')
    const result = runScript(realHome, [
      '--dsh-home', workHome,
      '--profile', 'guard-pass',
      '--source', 'no-such-source-profile',
      '--out', outDir,
    ])
    assert.doesNotMatch(String(result.stderr), /拒绝运行/, '不该被守卫拦下')
    assert.equal(existsSync(join(workHome, 'profiles', 'guard-pass')), true, '要在给定的 home 里建 profile')
    assert.equal(existsSync(join(realHome, '.dsh')), false)
  } finally {
    rmSync(realHome, { recursive: true, force: true })
    rmSync(workHome, { recursive: true, force: true })
  }
})

test('脚本：--allow-real-home 时不再被拒（只验没被拦，不真跑）', () => {
  const realHome = tempHome()
  try {
    const outDir = join(realHome, 'out')
    const result = runScript(realHome, [
      '--dsh-home', join(realHome, '.dsh'),
      '--allow-real-home',
      '--profile', 'guard-pass',
      '--source', 'no-such-source-profile',
      '--out', outDir,
    ])
    assert.doesNotMatch(String(result.stderr), /拒绝运行/)
  } finally {
    rmSync(realHome, { recursive: true, force: true })
  }
})

test('samePath：尾分隔符与相对段不影响同一性判定', () => {
  const realHome = tempHome()
  try {
    const target = join(realHome, '.dsh')
    mkdirSync(target, { recursive: true })
    assert.equal(samePath(target, target + '/'), true)
    assert.equal(samePath(target, join(target, '..', '.dsh')), true)
    assert.equal(samePath(target, join(realHome, 'other')), false)
  } finally {
    rmSync(realHome, { recursive: true, force: true })
  }
})

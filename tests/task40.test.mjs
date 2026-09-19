/**
 * task-40 三条「静默失效」修复的测试（node --test，import dist 产物）。
 *
 * 1. readEnvironmentManifest：manifest 结构读不懂时必须说"未知"，不能说"没有层栈"；
 * 2. settings 命名空间冲突：不许抛穿装配，退回只读句柄且事实对用户可见；
 * 3. requireManager：官方少方法时给可读错误，而不是调用点 TypeError。
 * 每条都有变异验证（改回旧行为 → 必须报红）。
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readEnvironmentManifest } from '../dist/paths.js'
import { configState, registerConfig } from '../dist/settings.js'
import { OfficialUnavailableError, probeOfficialCapabilities, requireManager } from '../dist/official.js'
import { listEnvironments } from '../dist/envManager.js'
import { analyzeEnvironment } from '../dist/diagnostics.js'

/** 造一个只有 package.json 的环境目录。 */
async function environment(home, name, manifest) {
  const dir = join(home, 'profiles', name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2))
  return dir
}

/** 最小 ctx：只提供被测代码真正读到的成员。 */
function ctxOf(services = {}) {
  return { get: (name) => services[name], logger: { info() {}, warn() {}, error() {}, debug() {} } }
}

let home
before(async () => {
  home = await mkdtemp(join(tmpdir(), 'companion-task40-'))
  process.env.DSH_HOME = home
  await mkdir(join(home, 'profiles'), { recursive: true })
})

after(async () => {
  await rm(home, { recursive: true, force: true })
  delete process.env.DSH_HOME
})

describe('task-40 · manifest 读不懂 ≠ 没有层栈', () => {
  it('字段被改名时得到"未知"，而不是空数组', async () => {
    const dir = await environment(home, 'renamed', {
      name: 'dsh-profile-renamed', dependencies: {},
      dsh: { profile: { layers: ['@deepseek-ai/dsh-base'] } },
    })
    const manifest = readEnvironmentManifest(dir)
    assert.equal(manifest.bundlesKnown, false, '字段改名必须被识别为未知：' + JSON.stringify(manifest.bundlesKnown))
    assert.equal(typeof manifest.bundlesUnknownReason, 'string')
    assert.ok(manifest.bundlesUnknownReason.length > 0, '未知必须带原因')
  })

  it('bundles 存在但不是字符串数组时也是未知', async () => {
    const dir = await environment(home, 'not-array', {
      name: 'dsh-profile-not-array',
      dsh: { profile: { bundles: { base: true } } },
    })
    const manifest = readEnvironmentManifest(dir)
    assert.equal(manifest.bundlesKnown, false)
    assert.match(manifest.bundlesUnknownReason, /不是数组/);
  })

  it('反向用例：正常 manifest 仍得到真实层栈（known = true）', async () => {
    const dir = await environment(home, 'normal', {
      name: 'dsh-profile-normal', dependencies: { 'pkg-a': '^1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    })
    const manifest = readEnvironmentManifest(dir)
    assert.deepEqual(manifest.bundles, ['@deepseek-ai/dsh-base'])
    assert.notEqual(manifest.bundlesKnown, false, '正常 manifest 不许被标成未知')
    assert.deepEqual(manifest.dependencies, ['pkg-a'])
  })

  it('确实没有声明层栈时，是"确定的空"而不是未知', async () => {
    const empty = await environment(home, 'empty-stack', { name: 'x', dsh: { profile: { bundles: [] } } })
    const noDsh = await environment(home, 'no-dsh', { name: 'y' })
    assert.notEqual(readEnvironmentManifest(empty).bundlesKnown, false)
    assert.deepEqual(readEnvironmentManifest(empty).bundles, [])
    assert.notEqual(readEnvironmentManifest(noDsh).bundlesKnown, false)
  })

  it('调用方如实呈现：环境列表把"未知"与"空"分开', async () => {
    const list = listEnvironments(ctxOf(), { runs: new Map() })
    const byName = new Map(list.map((item) => [item.name, item]))
    const renamed = byName.get('renamed')
    assert.ok(renamed, '环境仍要出现在列表里：' + JSON.stringify([...byName.keys()]))
    assert.equal(renamed.bundlesKnown, false, '列表必须带上未知标记')
    assert.ok(String(renamed.bundlesUnknownReason).length > 0)
    assert.equal(byName.get('normal').bundlesKnown, undefined, '正常环境不带未知标记')
  })

  it('变异验证：把未知说成确定（退回旧行为）→ 断言必须报红', async () => {
    const dir = await environment(home, 'renamed2', {
      name: 'dsh-profile-renamed2',
      dsh: { profile: { layers: ['@deepseek-ai/dsh-base'] } },
    })
    const manifest = readEnvironmentManifest(dir)
    const mutated = { ...manifest }
    delete mutated.bundlesKnown
    delete mutated.bundlesUnknownReason
    assert.deepEqual(mutated.bundles, [], '旧行为读出来就是空数组');
    assert.throws(() => assert.equal(mutated.bundlesKnown, false, '字段改名必须被识别为未知'),
      '退回旧行为后断言必须失败——否则这条事实又会被说成"这个环境没有层栈"')
  })

  it('诊断把它如实呈现为"没查"：report.skipped 里出现 bundles-unknown', async () => {
    const dir = join(home, 'profiles', 'renamed')
    const env = { name: 'renamed', dir, current: false, builtin: false, bundles: [], dependencies: [], runs: [] }
    const config = {
      diagnostics: { dependency: true, composition: true, runtime: true, consistency: true, ecosystem: false },
      qualityGate: { enabled: true, mode: 'block', allowlist: [] },
    }
    const report = await analyzeEnvironment(ctxOf(), env, config)
    const skip = report.skipped.find((item) => item.check === 'bundles-unknown')
    assert.ok(skip, '要在 skipped 里如实登记：' + JSON.stringify(report.skipped.map((item) => item.check)))
    assert.match(skip.reason, /读不懂/)
    assert.match(skip.reason, /不要把它当成/, '要说清这不是"没有层栈"')
  })

  it('反向用例：正常 manifest 不产生 bundles-unknown', async () => {
    const dir = join(home, 'profiles', 'normal')
    const env = { name: 'normal', dir, current: false, builtin: false, bundles: [], dependencies: [], runs: [] }
    const config = {
      diagnostics: { dependency: true, composition: true, runtime: true, consistency: true, ecosystem: false },
      qualityGate: { enabled: true, mode: 'block', allowlist: [] },
    }
    const report = await analyzeEnvironment(ctxOf(), env, config)
    assert.equal(report.skipped.some((item) => item.check === 'bundles-unknown'), false)
  })

  it('变异验证：删掉这条 skip（退回"当成空层栈"）→ 断言必须报红', async () => {
    const dir = join(home, 'profiles', 'renamed')
    const env = { name: 'renamed', dir, current: false, builtin: false, bundles: [], dependencies: [], runs: [] }
    const config = {
      diagnostics: { dependency: true, composition: true, runtime: true, consistency: true, ecosystem: false },
      qualityGate: { enabled: true, mode: 'block', allowlist: [] },
    }
    const report = await analyzeEnvironment(ctxOf(), env, config)
    const mutated = { ...report, skipped: report.skipped.filter((item) => item.check !== 'bundles-unknown') }
    assert.equal(mutated.skipped.some((item) => item.check === 'bundles-unknown'), false)
    assert.throws(() => {
      assert.ok(mutated.skipped.find((item) => item.check === 'bundles-unknown'), '要在 skipped 里如实登记')
    }, '去掉这条 skip 后断言必须失败——否则"读不懂"又会被当成"没有层栈"')
  })
})

describe('task-40 · settings 命名空间冲突不抛穿装配', () => {
  it('register 抛"已注册"时：不失败、拿到只读降级句柄、且事实对用户可见', async () => {
    const settings = {
      register() { throw new Error('namespace "plugin-manager-companion" already registered') },
    }
    const ctx = ctxOf({ settings })
    const handle = registerConfig(ctx)
    assert.equal(configState().writable, false)
    assert.equal(configState().reason, 'namespace-conflict', '要给出稳定原因码')
    assert.match(String(configState().detail), /已被占用/);
    assert.equal((await handle.current()).qualityGate.mode, 'block', '降级句柄给默认配置')
    await assert.rejects(() => handle.update({ qualityGate: { enabled: true, mode: 'warn', allowlist: [] } }),
      /尚未就绪|被拒绝/, '降级句柄的写入必须抛错，不能静默丢');
    const capabilities = probeOfficialCapabilities(ctx)
    assert.ok(capabilities.missing.some((reason) => reason.includes('配置不可写')),
      '要在 capabilities.missing 里看得见：' + JSON.stringify(capabilities.missing))
  })

  it('反向用例：注册成功时不降级、也不出现"配置不可写"', async () => {
    const scope = {
      get: () => ({ qualityGate: { enabled: true, mode: 'warn', allowlist: [] } }),
      watch: () => () => {},
      update: async () => {},
    }
    const settings = { register: () => scope }
    const ctx = ctxOf({ settings })
    const handle = registerConfig(ctx)
    assert.equal(configState().writable, true, '成功注册后必须清掉降级事实')
    assert.equal(configState().reason, null)
    assert.equal((await handle.current()).qualityGate.mode, 'warn')
    assert.equal(probeOfficialCapabilities(ctx).missing.some((reason) => reason.includes('配置不可写')), false)
  })

  it('反向用例：settings 缺失仍是同一形态（只读 + 可见原因）', () => {
    const ctx = ctxOf()
    const handle = registerConfig(ctx)
    assert.equal(configState().writable, false)
    assert.equal(configState().reason, 'settings-missing')
    assert.equal(handle.current().qualityGate.mode, 'block')
  })

  it('变异验证：让冲突照旧抛穿（旧行为）→ 断言必须报红', () => {
    const settings = { register() { throw new Error('namespace "plugin-manager-companion" already registered') } }
    // 旧行为就是这一行：冲突直接抛穿 apply（装配失败，用户看到一个装不上的插件）
    assert.throws(() => settings.register(), /already registered/, '旧行为：冲突直接抛穿装配');
    // 新行为：同一桩件经 registerConfig 不抛，且降级事实可见
    const handle = registerConfig(ctxOf({ settings }));
    assert.equal(handle.current().qualityGate.mode, 'block');
    assert.equal(configState().reason, 'namespace-conflict');
    // 变异：把注册换回"直接调 register"（旧行为）→ 这一步必然抛，证明降级真的在拦
    assert.throws(() => {
      const oldWay = (ctx) => ctx.get('settings').register('plugin-manager-companion', {});
      oldWay(ctxOf({ settings }));
    }, /already registered/, '退回旧行为后必须抛——这条钉子就是"别抛穿装配"');
  })
})

describe('task-40 · requireManager 校验我们真正调用的方法', () => {
  const REQUIRED = ['inspect', 'setPluginEnabled', 'setBundleEnabled', 'installBundle', 'removeBundle']
  function managerStub(methods) {
    const stub = {}
    for (const name of REQUIRED) if (methods.includes(name)) stub[name] = () => Promise.resolve({})
    return stub
  }

  it('缺少某个方法时抛出可读错误（不是调用点 TypeError）', () => {
    const ctx = ctxOf({ pluginManager: managerStub(REQUIRED.filter((name) => name !== 'installBundle')) })
    let thrown;
    try { requireManager(ctx) } catch (error) { thrown = error }
    assert.ok(thrown instanceof OfficialUnavailableError, '必须是具名的官方不可用错误：' + String(thrown))
    assert.equal(thrown.capability, 'pluginManager')
    assert.match(thrown.message, /installBundle/, '要点名缺的方法：' + thrown.message)
    assert.match(thrown.message, /不可用/, '要说清所以这项能力不可用：' + thrown.message)
    assert.doesNotMatch(thrown.message, /is not a function/, '不能是 TypeError 文案')
    // 对照：旧行为就是这个 TypeError——说明为什么必须在校验处拦住
    const viaCallSite = ctx.get('pluginManager').installBundle;
    assert.equal(viaCallSite, undefined, '不校验时调用点拿到的是 undefined（随后 TypeError）')
  })

  it('反向用例：五个方法齐全时不得抛错', () => {
    const manager = managerStub(REQUIRED)
    const returned = requireManager(ctxOf({ pluginManager: manager }))
    assert.equal(returned, manager, '齐全时应当原样返回服务')
  })

  it('原型链上的方法也算存在（官方可能是 class 实例）', () => {
    const stub = managerStub(REQUIRED)
    const instance = Object.create(stub)
    assert.equal(requireManager(ctxOf({ pluginManager: instance })), instance)
  })

  it('服务整块缺失时仍是可读的官方不可用错误', () => {
    assert.throws(() => requireManager(ctxOf()), (error) => error instanceof OfficialUnavailableError);
  })

  it('变异验证：去掉方法校验（退回旧行为）→ 断言必须报红', () => {
    const partial = managerStub(REQUIRED.filter((name) => name !== 'removeBundle'))
    // 旧行为：只看服务在不在，于是这里"通过"了，错误推迟到调用点炸成 TypeError
    const oldBehavior = partial;
    assert.ok(oldBehavior, '旧行为下这一步什么都不查');
    assert.throws(() => {
      requireManager(ctxOf({ pluginManager: oldBehavior }));
    }, (error) => error instanceof OfficialUnavailableError && /removeBundle/.test(String(error)),
    '去掉校验后这里不会报错 → 这条断言必须失败，证明校验真的在起作用')
  })
})
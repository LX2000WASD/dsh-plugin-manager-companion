/**
 * 试装接入质量门的契约测试（node --test，跑 dist 产物）。
 *
 * 守护的是 task-51 的两件容易"看起来做了、其实没接上"的事：
 *   1. 试装**关闭时**（默认）安装路径的语义与没有试装时逐条相同；
 *   2. 试装**开启后**，四种结论 × 两档策略都落在"装/不装"的正确一侧——
 *      尤其是"无法试装"绝不能被写成通过（DESIGN §5.2）。
 *
 * 用隔离的 DSH_HOME，绝不碰真实环境；试装执行器是**注入的替身**（真起进程的验证在引擎
 * 自己的测试与真机 e2e 里，不在这一层）。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'companion-trial-'))
const originalHome = process.env.DSH_HOME
process.env.DSH_HOME = home

const { handleOp } = await import('../dist/index.js')
const { ConfigSchema, DEFAULT_TRIAL_CONFIG, TRIAL_DISCLOSURE, effectiveTrialConfig } = await import('../dist/settings.js')

const CANDIDATE = 'dsh-probe-candidate'
const ANCHOR = '/anchor/package.json'

/** 造一个真实环境目录（静态门要能过：包真的在 node_modules 里、入口可读）。 */
function makeEnvironment(name) {
  const dir = join(home, 'profiles', name)
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-' + name,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, undefined, 2) + '\n')
  writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
  return dir
}

/**
 * 官方 manager 的桩件：真实地"装"一个最小可读的包（这样静态门能过，测试才走得到试装那一步），
 * 并记录调用序列供断言。
 */
function makeManager(envDir, { entrySource = 'export const nothing = 1\n' } = {}) {
  const calls = []
  const readManifest = () => JSON.parse(readFileSync(join(envDir, 'package.json'), 'utf8'))
  const writeManifest = (manifest) => writeFileSync(join(envDir, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n')
  const pkgDir = join(envDir, 'node_modules', CANDIDATE)
  return {
    calls,
    inspect: async () => { calls.push('inspect'); return { status: 'ok' } },
    setPluginEnabled: async () => ({ application: 'applied', stage: 'enable', target: CANDIDATE, changed: true }),
    installBundle: async () => {
      calls.push('installBundle')
      const manifest = readManifest()
      manifest.dependencies = { ...(manifest.dependencies ?? {}), [CANDIDATE]: 'link:/probe-src' }
      writeManifest(manifest)
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: CANDIDATE, version: '0.0.1', main: 'index.js' }) + '\n')
      writeFileSync(join(pkgDir, 'index.js'), entrySource)
      return { application: 'applied', bundle: CANDIDATE, stage: 'install', target: CANDIDATE, changed: true }
    },
    setBundleEnabled: async () => {
      calls.push('setBundleEnabled')
      return { application: 'applied', stage: 'enable', target: CANDIDATE, changed: true }
    },
    removeBundle: async () => {
      calls.push('removeBundle')
      const manifest = readManifest()
      if (manifest.dependencies !== undefined) delete manifest.dependencies[CANDIDATE]
      writeManifest(manifest)
      rmSync(pkgDir, { recursive: true, force: true })
      return { application: 'applied', stage: 'remove', target: CANDIDATE, changed: true }
    },
    listBundles: async () => { calls.push('listBundles'); return [{ name: '@deepseek-ai/dsh-base', installed: false, enabled: true }] },
  }
}

/** 试装执行器的替身：按给定结论回一份形状完整的 TrialInstallResult，并记录收到的选项。 */
function makeTrialRunner(conclusion, overrides = {}) {
  const calls = []
  const runner = async (spec, realName, options) => {
    calls.push({ spec, realName, options })
    return {
      conclusion,
      output: '试装结论（替身）：' + conclusion,
      build: { artifactMd5: null, artifactMtime: null, gitHead: null },
      sourceFingerprint: {
        manifestHash: 'm', lockfileHash: 'l', patchHash: 'p', bundles: [], bundlesSource: 'manifest',
        dependencies: [], hash: 'fingerprint-before',
      },
      sourceFingerprintAfter: null,
      changedDuringTrial: false,
      baseline: conclusion === 'baseline-broken'
        ? { kind: 'failed', reason: '替身：基线起不来', chain: ['Error: baseline boom'] }
        : { kind: 'mounted' },
      candidate: conclusion === 'candidate-broken'
        ? { kind: 'failed', reason: '替身：候选包炸了', chain: ['Error: has been registered'] }
        : { kind: 'mounted' },
      elapsedMs: 42,
      depth: 'shallow',
      escalated: false,
      ...overrides,
    }
  }
  return { runner, calls }
}

/** 一份完整配置（除 trial 外与 defaults 一致）；trial 由参数给。 */
function configWith(trial) {
  return {
    diagnostics: { dependency: true, composition: true, runtime: true, consistency: true, ecosystem: false },
    qualityGate: { enabled: true, mode: 'block', allowlist: [] },
    marketplace: { enabled: false, cacheTtlMinutes: 1440, timeoutMs: 15000, indexUrl: '' },
    ...trial === undefined ? {} : { trial },
  }
}

function makeDeps({ ctxName = 'demo-env', manager, trial, config }) {
  let current = config
  const envDir = join(home, 'profiles', ctxName)
  const ctx = {
    get(name) {
      if (name === 'pluginManager') return manager
      if (name === 'profileContext') return { name: ctxName, dir: envDir, installAnchor: ANCHOR, cwd: tmpdir(), home }
      return undefined
    },
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  }
  return {
    ctx,
    config: () => current,
    configUpdate: async (patch) => { current = { ...current, ...patch }; return current },
    capabilities: () => ({ profileBacked: true, manager: true, inventory: false, environmentName: ctxName, missing: [] }),
    jobs: makeJobs(),
    ...trial === undefined ? {} : { trial },
  }
}

/** 最小 job 注册表桩件（真实实现在 rest.ts，已单独覆盖）。 */
function makeJobs() {
  const map = new Map()
  let seq = 0
  return {
    start(task) {
      seq += 1
      const id = 'job-' + String(seq)
      const record = { done: false }
      map.set(id, record)
      void Promise.resolve().then(task).then(
        (value) => { record.result = value; record.done = true },
        (error) => { record.error = String(error && error.message ? error.message : error); record.done = true },
      )
      return id
    },
    status(id) {
      const record = map.get(id)
      if (record === undefined) return { done: true, missing: true }
      return { done: record.done, ...(record.result === undefined ? {} : { result: record.result }), ...(record.error === undefined ? {} : { error: record.error }) }
    },
  }
}

async function settle(deps, id) {
  for (let i = 0; i < 200; i += 1) {
    const status = await handleOp('job', { id }, deps)
    if (status.ok && status.value.done === true) return status.value
    await new Promise(resolvePromise => setTimeout(resolvePromise, 5))
  }
  throw new Error('job 未在预期时间内落定')
}

/** 走 install op 装一次候选包（返回落定后的 GatedInstallResult）。 */
async function install(deps, environment = 'demo-env') {
  const started = await handleOp('install', { spec: '/probe-src', environment }, deps)
  assert.equal(started.ok, true, 'install op 首包必须是成功信封')
  const settled = await settle(deps, started.value.jobId)
  assert.equal(settled.error, undefined, 'install job 不该报错：' + String(settled.error))
  return settled.result
}

// ── 1. 关闭时：行为与没有试装时逐条相同 ────────────────────────────────────

test('试装默认关闭：配置里没有 trial 字段也照常安装，结果里不出现试装', async () => {
  const envDir = makeEnvironment('off-env')
  const manager = makeManager(envDir)
  const { runner, calls } = makeTrialRunner('candidate-broken')
  // 注意：config 里**刻意没有** trial 字段（旧配置字面量的形状）。
  const deps = makeDeps({ ctxName: 'off-env', manager, trial: runner, config: configWith(undefined) })
  const result = await install(deps, 'off-env')
  assert.equal(result.ok, true)
  assert.equal(result.trial, undefined, '试装关闭时结果里不该有 trial')
  assert.equal(calls.length, 0, '试装关闭时执行器一次都不该被调用')
  assert.ok(manager.calls.includes('setBundleEnabled'), '照常激活')
  assert.match(result.output, /已安装并启用 dsh-probe-candidate/)
})

test('试装开启但质量门整体关闭：不执行试装，并在结果里写明这件事', async () => {
  const envDir = makeEnvironment('gateoff-env')
  const manager = makeManager(envDir)
  const { runner, calls } = makeTrialRunner('passed')
  const deps = makeDeps({
    ctxName: 'gateoff-env', manager, trial: runner,
    config: configWith({ ...DEFAULT_TRIAL_CONFIG, enabled: true, }),
  })
  deps.config = () => ({
    ...configWith({ ...DEFAULT_TRIAL_CONFIG, enabled: true }),
    qualityGate: { enabled: false, mode: 'block', allowlist: [] },
  })
  const result = await install(deps, 'gateoff-env')
  assert.equal(result.ok, true)
  assert.equal(calls.length, 0, '质量门关闭时试装不执行')
  assert.equal(result.trial?.policy, 'skipped', '必须如实标记为"未执行"，不能沉默')
  assert.match(result.output, /试装未执行/)
  assert.match(result.output, /质量门整体已关闭/)
})

test('试装开启但包在豁免名单里：同样标为未执行（理由不同）', async () => {
  const envDir = makeEnvironment('allow-env')
  const manager = makeManager(envDir)
  const { runner, calls } = makeTrialRunner('passed')
  const deps = makeDeps({ ctxName: 'allow-env', manager, trial: runner, config: configWith({ ...DEFAULT_TRIAL_CONFIG, enabled: true }) })
  deps.config = () => ({ ...configWith({ ...DEFAULT_TRIAL_CONFIG, enabled: true }), qualityGate: { enabled: true, mode: 'block', allowlist: [CANDIDATE] } })
  const result = await install(deps, 'allow-env')
  assert.equal(result.ok, true)
  assert.equal(calls.length, 0)
  assert.equal(result.trial?.policy, 'skipped')
  assert.match(result.output, /豁免名单/)
})

test('静态快筛先拦下时：不进入试装（第一步就挂掉的包没有必要起进程）', async () => {
  const envDir = makeEnvironment('static-env')
  // 入口里 import 一个没声明的依赖：静态门必然报"未声明的 import"。
  const manager = makeManager(envDir, { entrySource: "import 'left-pad'\n" })
  const { runner, calls } = makeTrialRunner('passed')
  const deps = makeDeps({ ctxName: 'static-env', manager, trial: runner, config: configWith({ ...DEFAULT_TRIAL_CONFIG, enabled: true }) })
  const result = await install(deps, 'static-env')
  assert.equal(result.ok, false)
  assert.equal(result.trial, undefined, '静态门拦截时不该有试装结论')
  assert.equal(calls.length, 0)
  assert.ok(result.gateIssues.some(issue => /未声明的 import/.test(issue)))
})

// ── 2. 开启后：四种结论 × 两档策略 ────────────────────────────────────────

test('试装通过：照常安装，结果里带结论与深度', async () => {
  const envDir = makeEnvironment('pass-env')
  const manager = makeManager(envDir)
  const { runner, calls } = makeTrialRunner('passed', { depth: 'full', escalated: true, escalationReason: '浅快照基线失败' })
  const deps = makeDeps({ ctxName: 'pass-env', manager, trial: runner, config: configWith({ ...DEFAULT_TRIAL_CONFIG, enabled: true }) })
  const result = await install(deps, 'pass-env')
  assert.equal(result.ok, true)
  assert.equal(result.trial.conclusion, 'passed')
  assert.equal(result.trial.policy, 'passed')
  assert.equal(result.trial.depth, 'full')
  assert.equal(result.trial.escalated, true)
  assert.match(result.output, /试装通过/)
  assert.match(result.output, /实际深度 full/)
  assert.equal(calls[0].realName, 'pass-env', '快照源必须是包真正落地的那个环境')
  assert.equal(calls[0].options.depth, 'auto')
  assert.equal(calls[0].options.baseline, true)
  assert.equal(calls[0].options.allowNetwork, true)
  assert.equal(typeof calls[0].options.listBundles, 'function', '当前环境下必须给官方层栈事实')
})

test('候选包导致挂载失败 + 默认 block：不装、已回滚、给出根因', async () => {
  const envDir = makeEnvironment('broken-env')
  const manager = makeManager(envDir)
  const { runner } = makeTrialRunner('candidate-broken')
  const deps = makeDeps({ ctxName: 'broken-env', manager, trial: runner, config: configWith({ ...DEFAULT_TRIAL_CONFIG, enabled: true }) })
  const result = await install(deps, 'broken-env')
  assert.equal(result.ok, false)
  assert.equal(result.trial.conclusion, 'candidate-broken')
  assert.equal(result.trial.policy, 'blocked')
  assert.equal(result.rolledBack, true)
  assert.ok(manager.calls.includes('removeBundle'), '必须真的回滚')
  assert.ok(!manager.calls.includes('setBundleEnabled'), '未通过就不许激活')
  assert.match(result.output, /没有安装 dsh-probe-candidate：候选包导致挂载失败\n已回滚/)
  assert.match(result.output, /试装结论（替身）：candidate-broken/)
})

test('候选包导致挂载失败 + warn：装上了，但结论如实写着"没通过"', async () => {
  const envDir = makeEnvironment('warn-env')
  const manager = makeManager(envDir)
  const { runner } = makeTrialRunner('candidate-broken')
  const deps = makeDeps({
    ctxName: 'warn-env', manager, trial: runner,
    config: configWith({ ...DEFAULT_TRIAL_CONFIG, enabled: true, onFailure: 'warn' }),
  })
  const result = await install(deps, 'warn-env')
  assert.equal(result.ok, true)
  assert.equal(result.trial.conclusion, 'candidate-broken')
  assert.equal(result.trial.policy, 'warned')
  assert.ok(manager.calls.includes('setBundleEnabled'))
  assert.doesNotMatch(result.output, /试装通过/, 'warn 放行不许被写成通过')
  assert.match(result.output, /按 warn 模式照常安装/)
  assert.match(result.trial.output, /试装结论（替身）：candidate-broken/)
})

test('无法试装 + block：不许当成通过，回滚并说明原因', async () => {
  const envDir = makeEnvironment('cannot-env')
  const manager = makeManager(envDir)
  const { runner } = makeTrialRunner('cannot-trial', { baseline: null, candidate: null, depth: 'shallow' })
  const deps = makeDeps({ ctxName: 'cannot-env', manager, trial: runner, config: configWith({ ...DEFAULT_TRIAL_CONFIG, enabled: true }) })
  const result = await install(deps, 'cannot-env')
  assert.equal(result.ok, false, '无法试装不得当成通过')
  assert.equal(result.trial.conclusion, 'cannot-trial')
  assert.equal(result.trial.policy, 'blocked')
  assert.match(result.output, /没有安装 dsh-probe-candidate：无法试装（不算通过）\n已回滚/)
})

test('快照基线起不来：文案不赖候选包', async () => {
  const envDir = makeEnvironment('baseline-env')
  const manager = makeManager(envDir)
  const { runner } = makeTrialRunner('baseline-broken')
  const deps = makeDeps({ ctxName: 'baseline-env', manager, trial: runner, config: configWith({ ...DEFAULT_TRIAL_CONFIG, enabled: true }) })
  const result = await install(deps, 'baseline-env')
  assert.equal(result.ok, false)
  assert.match(result.output, /快照基线起不来（不是候选包的问题）/)
  assert.doesNotMatch(result.output, /候选包导致挂载失败/)
  assert.equal(result.trial.baseline, 'failed')
})

test('设置逐项透传给引擎：depth / baseline / 联网', async () => {
  const envDir = makeEnvironment('opt-env')
  const manager = makeManager(envDir)
  const { runner, calls } = makeTrialRunner('passed', { depth: 'full' })
  const deps = makeDeps({
    ctxName: 'opt-env', manager, trial: runner,
    config: configWith({ ...DEFAULT_TRIAL_CONFIG, enabled: true, depth: 'full', baseline: false, allowNetwork: false }),
  })
  const result = await install(deps, 'opt-env')
  assert.equal(result.ok, true)
  assert.equal(calls[0].options.depth, 'full')
  assert.equal(calls[0].options.baseline, false)
  assert.equal(calls[0].options.allowNetwork, false)
  assert.equal(result.trial.depth, 'full')
})

test('安装目标不是当前环境时：做不了受控对照，如实报无法试装', async () => {
  const envDir = makeEnvironment('demo-env')
  const manager = makeManager(envDir)
  const { runner, calls } = makeTrialRunner('passed')
  const deps = makeDeps({ ctxName: 'host-env', manager, trial: runner, config: configWith({ ...DEFAULT_TRIAL_CONFIG, enabled: true }) })
  makeEnvironment('host-env')
  const result = await install(deps, 'demo-env')
  assert.equal(calls.length, 0, '环境不一致时不该起试装')
  assert.equal(result.ok, false)
  assert.equal(result.trial.conclusion, 'cannot-trial')
  assert.match(result.output, /官方安装通道只作用于当前环境/)
})

test('验证启动撞端口（基线 EADDRINUSE）：不许归因成"环境坏了"，降级为无法试装', async () => {
  // 真机实测形态：含 web app 的环境在验证启动时会去绑默认端口 3080，而 GUI 正占着它。
  const envDir = makeEnvironment('port-env')
  const manager = makeManager(envDir)
  const conflict = { kind: 'failed', reason: 'listen EADDRINUSE: address already in use 127.0.0.1:3080', chain: ['Error: listen EADDRINUSE: address already in use 127.0.0.1:3080'] }
  const { runner } = makeTrialRunner('baseline-broken', { baseline: conflict, candidate: null })
  const deps = makeDeps({ ctxName: 'port-env', manager, trial: runner, config: configWith({ ...DEFAULT_TRIAL_CONFIG, enabled: true }) })
  const result = await install(deps, 'port-env')
  assert.equal(result.ok, false)
  assert.equal(result.trial.conclusion, 'cannot-trial', '端口冲突不许被归因成基线坏了')
  assert.match(result.output, /验证启动绑不上端口（127\.0\.0\.1:3080 已被占用）/)
  assert.match(result.output, /这不是候选包的问题，也不是环境坏了/)
  assert.doesNotMatch(result.output, /快照基线/, '端口冲突不许残留"基线起不来"的归因')
  assert.doesNotMatch(result.output, /当前状态有问题/, '端口冲突不许说成环境有问题')
})

test('验证启动判不出来（undetermined）：不许说成"基线起不来"，也不许说环境有问题', async () => {
  // 真机实测形态：含 web app 的环境在验证启动里以服务形态常驻，30s 超时后被杀、stderr 为空。
  const envDir = makeEnvironment('undet-env')
  const manager = makeManager(envDir)
  const { runner } = makeTrialRunner('cannot-trial', {
    baseline: { kind: 'undetermined', reason: '子进程没有输出任何 stderr 文本' },
    candidate: null,
    escalated: true,
    escalationReason: '浅快照基线失败',
    elapsedMs: 30_014,
  })
  const deps = makeDeps({ ctxName: 'undet-env', manager, trial: runner, config: configWith({ ...DEFAULT_TRIAL_CONFIG, enabled: true }) })
  const result = await install(deps, 'undet-env')
  assert.equal(result.ok, false)
  assert.equal(result.trial.conclusion, 'cannot-trial')
  assert.equal(result.trial.baseline, 'undetermined')
  assert.match(result.output, /验证启动没有给出判定/)
  assert.match(result.output, /子进程没有输出任何 stderr 文本/)
  assert.match(result.output, /这是验证形态给不出结论，不是候选包的问题，也不是环境坏了/)
  assert.match(result.output, /验证耗时 30014ms/)
  assert.doesNotMatch(result.output, /快照基线本身就起不来/, '判不出来不许写成"基线起不来"')
  assert.doesNotMatch(result.output, /当前状态有问题/, '判不出来不许说成环境有问题')
})

test('候选启动撞端口：结论不动（有歧义），但把这条事实写进输出', async () => {
  const envDir = makeEnvironment('portcand-env')
  const manager = makeManager(envDir)
  const conflict = { kind: 'failed', reason: 'listen EADDRINUSE: address already in use 127.0.0.1:3080', chain: ['Error: listen EADDRINUSE: address already in use 127.0.0.1:3080'] }
  const { runner } = makeTrialRunner('candidate-broken', { candidate: conflict })
  const deps = makeDeps({ ctxName: 'portcand-env', manager, trial: runner, config: configWith({ ...DEFAULT_TRIAL_CONFIG, enabled: true }) })
  const result = await install(deps, 'portcand-env')
  assert.equal(result.trial.conclusion, 'candidate-broken', '候选自己有端口行为时不许替用户下结论')
  assert.match(result.trial.output, /需要人工判断/)
})

// ── 3. 保留上限（§5.3 的最多保留数） ──────────────────────────────────────

test('数量上限：达到上限时拒绝试装（不偷偷删任何测试环境）', async () => {
  const envDir = makeEnvironment('cap-env')
  const manager = makeManager(envDir)
  const otherTrial = makeEnvironment('other-env-dpmc')
  const { runner, calls } = makeTrialRunner('passed')
  const deps = makeDeps({
    ctxName: 'cap-env', manager, trial: runner,
    config: configWith({ ...DEFAULT_TRIAL_CONFIG, enabled: true, maxKept: 1 }),
  })
  const result = await install(deps, 'cap-env')
  assert.equal(calls.length, 0, '达到上限时不该起试装')
  assert.equal(result.trial.conclusion, 'cannot-trial')
  assert.match(result.output, /上限是 1/)
  assert.equal(existsSync(otherTrial), true, '拒绝试装时绝不允许删掉别的测试环境')
})

// ── 4. 测试环境的查询 / 删除 / 清理 ───────────────────────────────────────

test('trialEnvironments：如实列出测试环境（占地/时间/是否与真实环境一致），且不删任何东西', async () => {
  const dir = makeEnvironment('list-env-dpmc')
  makeEnvironment('list-env')
  writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  const deps = makeDeps({ ctxName: 'list-env', manager: makeManager(makeEnvironment('list-env')), config: configWith({ ...DEFAULT_TRIAL_CONFIG }) })
  const result = await handleOp('trialEnvironments', {}, deps)
  assert.equal(result.ok, true)
  const report = result.value
  const env = report.environments.find(entry => entry.name === 'list-env-dpmc')
  assert.ok(env !== undefined, '必须列出我们自己造的测试环境')
  assert.equal(env.owner, 'list-env')
  assert.equal(env.ownerExists, true)
  assert.equal(env.running, false)
  assert.ok(env.bytes > 0, '占地要真测出来（不是写死的 0）')
  assert.ok(env.files > 0)
  assert.equal(typeof env.snapshotMatchesOwner, 'boolean')
  assert.equal(report.retention.days, 14)
  assert.equal(report.retention.maxKept, 0)
  assert.ok(report.plan.keep.some(entry => entry.name === 'list-env-dpmc'), '刚造出来的不该进删除计划')
  assert.equal(report.overCap, false)
  assert.equal(existsSync(dir), true, '查询 op 不许删任何东西')
})

test('trialRemove：删得掉；不是测试环境名时拒绝', async () => {
  const dir = makeEnvironment('remove-env-dpmc')
  const deps = makeDeps({ ctxName: 'remove-env', manager: makeManager(makeEnvironment('remove-env')), config: configWith(undefined) })
  const refused = await handleOp('trialRemove', { name: 'remove-env' }, deps)
  assert.equal(refused.value.ok, false)
  assert.equal(refused.value.code, 'invalid-name')
  const removed = await handleOp('trialRemove', { name: 'remove-env-dpmc' }, deps)
  assert.equal(removed.value.ok, true)
  assert.equal(existsSync(dir), false)
})

test('trialCleanup：删过期的、留新鲜的，并记账到日志', async () => {
  const oldDir = makeEnvironment('clean-env-dpmc')
  const freshDir = makeEnvironment('fresh-env-dpmc')
  const twentyDaysAgo = (Date.now() - 20 * 86_400_000) / 1000
  utimesSync(oldDir, twentyDaysAgo, twentyDaysAgo)
  const deps = makeDeps({ ctxName: 'clean-env', manager: makeManager(makeEnvironment('clean-env')), config: configWith({ ...DEFAULT_TRIAL_CONFIG, retentionDays: 14 }) })
  const started = await handleOp('trialCleanup', {}, deps)
  assert.equal(started.ok, true)
  const settled = await settle(deps, started.value.jobId)
  assert.equal(settled.error, undefined)
  assert.deepEqual(settled.result.removed, ['clean-env-dpmc'])
  assert.match(settled.result.output, /删除 1 个/)
  assert.equal(existsSync(oldDir), false)
  assert.equal(existsSync(freshDir), true, '没到保留期的不许删')
  const log = readFileSync(join(home, 'dpmc-trial-cleanup.log'), 'utf8')
  assert.match(log, /removed clean-env-dpmc/)
})

// ── 5. 告知义务与配置归一 ─────────────────────────────────────────────────

test('capabilities 带出试装告知事实（会执行第三方代码 / 内存峰值 + 口径）', async () => {
  const deps = makeDeps({ ctxName: 'demo-env', manager: makeManager(makeEnvironment('demo-env')) , config: configWith(undefined) })
  const result = await handleOp('capabilities', {}, deps)
  assert.equal(result.ok, true)
  assert.equal(result.value.trialDisclosure.executesCandidateCode, true)
  assert.equal(result.value.trialDisclosure.peakMemoryMiB, 161)
  assert.match(result.value.trialDisclosure.measurement, /maxrss/)
  assert.equal(result.value.trialDisclosure, TRIAL_DISCLOSURE, 'op 里给的必须是同一个常量，不是抄一份')
})

test('effectiveTrialConfig：缺字段/类型不对/越界一律回落到安全默认值', () => {
  assert.deepEqual(effectiveTrialConfig(undefined), DEFAULT_TRIAL_CONFIG)
  assert.deepEqual(effectiveTrialConfig({}), DEFAULT_TRIAL_CONFIG)
  const partial = effectiveTrialConfig({ trial: { enabled: true } })
  assert.equal(partial.enabled, true)
  assert.equal(partial.depth, 'auto')
  assert.equal(partial.baseline, true)
  assert.equal(partial.onFailure, 'block')
  assert.equal(partial.retentionDays, 14)
  assert.equal(partial.maxKept, 0)
  const junk = effectiveTrialConfig({ trial: { depth: 'nope', onFailure: 'whatever', retentionDays: 0, maxKept: -5 } })
  assert.equal(junk.depth, 'auto')
  assert.equal(junk.onFailure, 'block')
  assert.equal(junk.retentionDays, 1, '0 天会被夹到 1（合法范围下限），不是 undefined')
  assert.equal(junk.maxKept, 0)
})

test('schema 默认回填：新加的试装字段一个都不缺（不能出现看不见的洞）', () => {
  const resolved = ConfigSchema({})
  for (const key of Object.keys(DEFAULT_TRIAL_CONFIG)) {
    assert.notEqual(resolved.trial[key], undefined, 'schema 回填后 ' + key + ' 不能是 undefined')
  }
  assert.equal(resolved.trial.maxKept, 0)
  assert.equal(resolved.trial.enabled, false)
})

after(() => {
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
  rmSync(home, { recursive: true, force: true })
})

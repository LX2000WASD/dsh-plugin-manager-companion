/**
 * 入口 op 分派契约测试（node --test，跑 dist/index.js）。
 *
 * 守护的是装配层最容易断的地方：分派表与各模块的真实签名对不上（这次接线就撞了
 * 6 处）、以及"错误被吞掉变成看起来成功的空响应"。
 *
 * 用隔离的 DSH_HOME，绝不碰真实环境。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const home = mkdtempSync(join(tmpdir(), "companion-home-"))
const originalHome = process.env.DSH_HOME
process.env.DSH_HOME = home

// 造两个环境：一个普通、一个内置。
mkdirSync(join(home, "profiles", "demo-env"), { recursive: true })
writeFileSync(join(home, "profiles", "demo-env", "package.json"), JSON.stringify({
  name: "dsh-profile-demo-env",
  dependencies: {},
  dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
}))
writeFileSync(join(home, "profiles", "demo-env", "cordis.patch.yml"), "[]\n")
mkdirSync(join(home, "profiles", "web"), { recursive: true })
writeFileSync(join(home, "profiles", "web", "package.json"), JSON.stringify({ name: "dsh-profile-web" }))

const mod = await import("../dist/index.js")
const { handleOp, JobRegistry } = { ...mod, JobRegistry: undefined }

/** 构造一份 deps；ctx 用最小桩件，只提供分派路径真正读到的成员。 */
function makeDeps(overrides = {}) {
  let config = {
    diagnostics: { dependency: true, composition: true, runtime: true, consistency: true, ecosystem: false },
    qualityGate: { enabled: true, mode: "block", allowlist: [] },
    marketplace: { enabled: false, cacheTtlMinutes: 1440, timeoutMs: 15000, indexUrl: "" },
  }
  const ctx = {
    get() { return undefined },
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) { const d = fn(); return typeof d === "function" ? d : () => {} },
    ...overrides.ctx,
  }
  return {
    ctx,
    config: overrides.config ?? (() => config),
    configUpdate: async (patch) => { config = { ...config, ...patch }; return config },
    capabilities: () => ({
      profileBacked: true, manager: false, inventory: false,
      environmentName: "demo-env", missing: [],
    }),
    jobs: overrides.jobs ?? makeJobs(),
  }
}

/** 最小 job 注册表桩件（真实实现见 rest.ts，已在 rest.test.mjs 单独覆盖）。 */
function makeJobs() {
  const map = new Map()
  let seq = 0
  return {
    start(task) {
      seq += 1
      const id = "job-" + String(seq)
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

/** 等一个 job 落定。 */
/**
 * 从首包取 jobId。
 *
 * 契约（docs/REST-CONTRACT.md）：长操作的首包是 `{ jobId }`，**不是裸 id**。
 * 这里刻意不接受裸字符串——测试要钉契约，而不是容忍漂移。
 *
 * @param started - 首包的值。
 * @returns job id。
 */
function jobIdOf(started) {
  assert.equal(typeof started, "object", "长操作首包必须是对象 { jobId }")
  assert.equal(typeof started.jobId, "string", "首包必须带 string 类型的 jobId")
  return started.jobId
}

async function settle(deps, id) {
  for (let i = 0; i < 200; i += 1) {
    const status = await handleOp("job", { id }, deps)
    if (status.ok && status.value.done === true) return status.value
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error("job 未在预期时间内落定")
}

test('capabilities op 返回能力与配置', async () => {
  const result = await handleOp("capabilities", {}, makeDeps())
  assert.equal(result.ok, true)
  assert.equal(result.value.capabilities.environmentName, "demo-env")
  assert.ok(result.value.config.qualityGate.enabled)
})

test('getConfig / setConfig 走配置句柄', async () => {
  const deps = makeDeps()
  const before = await handleOp("getConfig", {}, deps)
  assert.equal(before.value.marketplace.enabled, false)
  const after = await handleOp("setConfig", { patch: { marketplace: { enabled: true, cacheTtlMinutes: 60, timeoutMs: 5000, indexUrl: "" } } }, deps)
  assert.equal(after.ok, true)
  assert.equal(after.value.marketplace.enabled, true)
})

test('setConfig 缺 patch 或类型不对时报可读错误，而不是静默成功', async () => {
  const missing = await handleOp("setConfig", {}, makeDeps())
  assert.equal(missing.ok, false)
  assert.match(missing.error.message, /patch/)
  const wrongType = await handleOp("setConfig", { patch: "not-an-object" }, makeDeps())
  assert.equal(wrongType.ok, false)
})

test('listEnvironments 列出隔离 home 里的环境并标注内置', async () => {
  const result = await handleOp("listEnvironments", {}, makeDeps())
  assert.equal(result.ok, true)
  const names = result.value.map(env => env.name).sort()
  assert.deepEqual(names, ["demo-env", "web"])
  const web = result.value.find(env => env.name === "web")
  assert.equal(web.builtin, true)
  const demo = result.value.find(env => env.name === "demo-env")
  assert.equal(demo.builtin, false)
  assert.deepEqual(demo.bundles, ["@deepseek-ai/dsh-base"])
})

test('scanRuns 返回 plain object（可 JSON 序列化）', async () => {
  const result = await handleOp("scanRuns", {}, makeDeps())
  assert.equal(result.ok, true)
  assert.equal(Object.getPrototypeOf(result.value), Object.prototype)
  assert.doesNotThrow(() => JSON.stringify(result.value))
})

test('diagnose 是长操作：返回 jobId，随后可从 job op 取到报告', async () => {
  const deps = makeDeps()
  const started = await handleOp("diagnose", {}, deps)
  assert.equal(started.ok, true)
  const jobId = jobIdOf(started.value)
  const settled = await settle(deps, jobId)
  assert.equal(settled.error, undefined)
  const report = settled.result
  assert.equal(report.environment, "demo-env")
  assert.ok(Array.isArray(report.issues))
  assert.ok(Array.isArray(report.skipped))
  // 五个层的计数键必须齐全（诊断页要直接渲染，缺键会显示 undefined）。
  for (const layer of ["dependency", "composition", "runtime", "consistency", "ecosystem"]) {
    assert.equal(typeof report.counts[layer], "number", "counts 缺 " + layer)
  }
})

test('诊断在官方能力缺失时如实记 skipped，不假装健康', async () => {
  const deps = makeDeps()
  const started = await handleOp("diagnose", {}, deps)
  const settled = await settle(deps, jobIdOf(started.value))
  const report = settled.result
  // 本桩件的 capabilities 里 manager=false / inventory=false，运行时层必然跳过。
  assert.ok(report.skipped.length > 0, "能力缺失时必须有 skipped 记录")
  assert.ok(report.skipped.some(entry => /运行时|Loader/i.test(entry.reason) || entry.check.includes("runtime")))
})

test('fix op 走 job，并把 needs-manual 如实透出（不报成失败）', async () => {
  const deps = makeDeps()
  const started = await handleOp("fix", { action: "remove-duplicate-row", target: "row-a" }, deps)
  assert.equal(started.ok, true)
  const settled = await settle(deps, jobIdOf(started.value))
  assert.equal(settled.error, undefined)
  assert.equal(settled.result.status, "needs-manual")
  assert.equal(settled.result.action, "remove-duplicate-row")
  assert.equal(settled.result.target, "row-a")
})

test('fix op 缺 action 时报错并指出字段名', async () => {
  const result = await handleOp("fix", {}, makeDeps())
  assert.equal(result.ok, false)
  assert.match(result.error.message, /action/)
})

test('fix op 对未知动作返回 failed 而不是静默成功', async () => {
  const deps = makeDeps()
  const started = await handleOp("fix", { action: "no-such-action" }, deps)
  const settled = await settle(deps, jobIdOf(started.value))
  assert.equal(settled.result.status, "failed")
})

test('未知 op 报错而不是返回空成功', async () => {
  const result = await handleOp("nope", {}, makeDeps())
  assert.equal(result.ok, false)
  assert.match(result.error.message, /未知操作/)
})

test('缺必填字段时报错并指出字段名', async () => {
  const result = await handleOp("removeEnvironment", {}, makeDeps())
  assert.equal(result.ok, false)
  assert.match(result.error.message, /name/)
})

test('handleOp 永不抛：模块抛错一律折成失败信封', async () => {
  const deps = makeDeps({ config: () => { throw new Error("配置读取炸了") } })
  const result = await handleOp("getConfig", {}, deps)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, "operation-failed")
  assert.match(result.error.message, /配置读取炸了/)
})

test('marketplace 在关闭时不联网，返回空 listing 而不是报错', async () => {
  const result = await handleOp("marketplace", {}, makeDeps())
  assert.equal(result.ok, true)
  assert.deepEqual(result.value.items, [])
  assert.equal(result.value.cached, false)
})

test('环境名不安全时被拒（路径逃逸防线）', async () => {
  const result = await handleOp("removeEnvironment", { name: ".." }, makeDeps())
  assert.equal(result.ok, true)
  assert.equal(result.value.ok, false)
  assert.equal(result.value.code, "invalid-name")
})

/** 造一份 P4 用的 manager 桩件：installBundle 复刻官方 add 的真实磁盘效果（依赖 + link: 符号链接）。 */
function makeRollbackManager(envDir, packageName, sourceDir, { removeLink }) {
  const readManifest = () => JSON.parse(readFileSync(join(envDir, 'package.json'), 'utf8'))
  const writeManifest = (manifest) => writeFileSync(join(envDir, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n')
  return {
    inspect: async () => ({ status: 'ok' }),
    // task-40 起 requireManager 会逐个校验"我们真正调用的方法"：桩件也必须齐全，
    // 否则拿到的会是可读的"官方缺少方法"错误（这正是我们要的行为）。
    setPluginEnabled: async () => ({ application: 'applied', stage: 'enable', target: packageName, changed: true }),
    installBundle: async () => {
      const manifest = readManifest()
      manifest.dependencies = { ...(manifest.dependencies ?? {}), [packageName]: 'link:' + sourceDir }
      writeManifest(manifest)
      mkdirSync(join(envDir, 'node_modules'), { recursive: true })
      // 必须给 type：Windows 上省略会按 file 建、普通用户直接失败。用官方同款形态
      // （app-boot 的 ensureSymlink 就是 symlinkSync(target, link, 'junction')，平台审计 W-22）；
      // junction 要求目标为绝对路径，而 mkdtempSync 给的 sourceDir 正是绝对路径。POSIX 下 type 参数被忽略。
      symlinkSync(sourceDir, join(envDir, 'node_modules', packageName), 'junction')
      return { application: 'applied', bundle: packageName, stage: 'install', target: packageName, changed: true }
    },
    setBundleEnabled: async () => ({ application: 'applied', stage: 'enable', target: packageName, changed: true }),
    // 官方 removeBundle 的实测行为：清单清干净，路径安装的符号链接留在磁盘上。
    removeBundle: async () => {
      const manifest = readManifest()
      if (manifest.dependencies !== undefined) delete manifest.dependencies[packageName]
      writeManifest(manifest)
      if (removeLink) rmSync(join(envDir, 'node_modules', packageName), { force: true })
      return { application: 'applied', stage: 'remove', target: packageName, changed: true }
    },
  }
}

function installDeps(envDir, manager) {
  return makeDeps({
    ctx: {
      get(name) {
        if (name === 'pluginManager') return manager
        if (name === 'profileContext') {
          return { name: 'demo-env', dir: envDir, installAnchor: '/anchor/package.json', cwd: '/tmp', home: home }
        }
        return undefined
      },
    },
  })
}

test('P4: 回滚后如实陈述磁盘状态——留下链接时不再说「环境未被改动」', async () => {
  const envDir = join(home, 'profiles', 'demo-env')
  const pkg = 'dsh-probe-bundle-bad'
  const sourceDir = join(home, 'probe-bad-src')
  mkdirSync(sourceDir, { recursive: true })
  // 质量门必然拦截：该包在 node_modules 下只有链接、没有可读的 package.json。
  const deps = installDeps(envDir, makeRollbackManager(envDir, pkg, sourceDir, { removeLink: false }))
  const settled = await settle(deps, jobIdOf((await handleOp('install', { spec: './probe-bad', environment: 'demo-env' }, deps)).value))
  const result = settled.result
  assert.equal(result.ok, false)
  // 磁盘前提：残留确实在（官方 pnpm remove 之后链接仍在）
  assert.equal(lstatSync(join(envDir, 'node_modules', pkg)).isSymbolicLink(), true, '测试前提：残留链接真的在磁盘上')
  // 文案必须与磁盘一致：manifest 说清了、残留说清了、断言「未改动」消失
  // 文案按 DESIGN §12.6 分层：不再以「package.json：」「node_modules：」当句子主语（路径语义不上屏）。
  // 清单已回滚干净（所以没有"依赖声明还在"那行），但**残留链接必须说出来**——
  // 这正是这条用例的核心：有残留时不许声称"环境未被改动"。
  assert.doesNotMatch(result.output, /依赖声明还在|它仍在环境启动时加载的列表里/)
  assert.match(result.output, /安装目录里还留着指向本地来源的链接/)
  assert.match(result.output, /需要时可以手动删除/)
  assert.doesNotMatch(result.output, /环境未被改动/)
  assert.equal(result.rolledBack, false, '有残留时不得声称已完整回滚')
})

test('P4: 回滚干净时（没有残留）才报 rolledBack=true 并说明无残留', async () => {
  const envDir = join(home, 'profiles', 'demo-env')
  const pkg = 'dsh-probe-bundle-clean'
  const sourceDir = join(home, 'probe-clean-src')
  mkdirSync(sourceDir, { recursive: true })
  const deps = installDeps(envDir, makeRollbackManager(envDir, pkg, sourceDir, { removeLink: true }))
  const settled = await settle(deps, jobIdOf((await handleOp('install', { spec: './probe-clean', environment: 'demo-env' }, deps)).value))
  const result = settled.result
  assert.equal(result.ok, false)
  assert.match(result.output, /没有留下安装残留/)
  assert.equal(result.rolledBack, true)
})

/**
 * tools/ 与 tests/ 里的**模块说明符**不得是本机绝对路径。
 *
 * 平台审计 W-25 的形态：tools/dirty-ui-audit.mjs 曾写 `from '/home/sixiao/.../tools/cdp-shot.mjs'`——
 * 在本机能跑，换机器/换目录/进 CI/上 Windows 直接 ERR_MODULE_NOT_FOUND。
 * 只看 import/export 语句与 import() 里的说明符；夹具里的字符串常量（如 '/home/u'）不受影响。
 */
test('tools/ 与 tests/ 里没有本机绝对路径的模块说明符（W-25）', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const SQ = String.fromCharCode(39)
  const DQ = String.fromCharCode(34)
  const offenders = []
  for (const dir of ['tools', 'tests']) {
    for (const name of readdirSync(join(root, dir))) {
      if (!name.endsWith('.mjs')) continue
      const text = readFileSync(join(root, dir, name), 'utf8')
      text.split(String.fromCharCode(10)).forEach((line, index) => {
        const trimmed = line.trim()
        // 注释行不参与判断：说明文字里会出现举例用的路径字符串。
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return
        let cursor = -1
        if (trimmed.startsWith('import ') || trimmed.startsWith('export ')) {
          const fromAt = trimmed.indexOf('from ')
          // 无 from 的副作用导入（import './x.js'）：说明符紧跟 import 之后。
          cursor = fromAt === -1 ? trimmed.indexOf('import ') + 7 : fromAt + 5
        } else {
          const dynAt = trimmed.indexOf('import(')
          if (dynAt === -1) return
          cursor = dynAt + 7
        }
        const rest = trimmed.slice(cursor)
        const quote = rest.trimStart()[0]
        if (quote !== SQ && quote !== DQ) return
        const open = rest.indexOf(quote)
        const close = rest.indexOf(quote, open + 1)
        if (close === -1) return
        const spec = rest.slice(open + 1, close)
        if (spec.startsWith('/')) offenders.push(dir + '/' + name + ':' + String(index + 1) + ' -> ' + spec)
      })
    }
  }
  assert.deepEqual(offenders, [], '绝对路径说明符换台机器就会 ERR_MODULE_NOT_FOUND')
})
after(() => {
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
  rmSync(home, { recursive: true, force: true })
})
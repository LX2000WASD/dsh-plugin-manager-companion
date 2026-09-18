/**
 * cli.ts 的行为测试（node --test，import dist 产物）。
 *
 * 覆盖两块：
 *   1. 参数解析与命令分派（含受保护的官方包操作转发）——原本在 scan.test.mjs 里，按"一个模块一个测试文件"归口搬过来；
 *   2. **analyze 只读逃生口**：环境起不来时 Web UI 不存在，CLI 必须真的能跑（动态加载引擎 + 最小 ctx + 显式安装锚点），
 *      并且绝不把"这次没查完"画成"健康"。
 *
 * 纪律：全部 import ../dist/*.js；临时 DSH_HOME 由 --home 指向 mkdtemp 目录，不碰用户真实的 ~/.dsh；
 * 包操作注入假 runPluginCommand —— 测试绝不真跑 pnpm。
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_PROFILE, USAGE, judgeAnalyze, loadAnalyzer, main, parseArgs } from '../dist/cli.js'

/** 换行符（夹具文本里用）。 */
const nl = String.fromCharCode(10)

/** 夹具根目录（git 源扫描用例的"本地仓库"）。 */
let repo
/** 假的 Harness home：临时 profile 与安装记录都落在这里。 */
let home

/** 写一个文件，自动建父目录。 */
async function put(path, text) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, text, 'utf8')
}

before(async () => {
  repo = await mkdtemp(join(tmpdir(), 'dshpmc-cli-repo-'))
  home = await mkdtemp(join(tmpdir(), 'dshpmc-cli-home-'))
})

after(async () => {
  await rm(repo, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})
describe('cli：参数解析', () => {
  it('解析全局 flag（含内联写法）与位置参数', () => {
    const options = parseArgs(['install', 'foo@1.0.0', '--profile=web', '--env', 'A=1', '--env=B=2', '--json', '--refresh'])
    assert.equal(options.command, 'install')
    assert.deepEqual([...options.args], ['foo@1.0.0'])
    assert.equal(options.profile, 'web')
    assert.deepEqual(options.env, { A: '1', B: '2' })
    assert.equal(options.json, true)
    assert.equal(options.flags.has('refresh'), true)
  })

  it('默认 profile 是 web，--home 覆盖 home', () => {
    const options = parseArgs(['list'])
    assert.equal(options.profile, DEFAULT_PROFILE)
    assert.equal(options.home, undefined)
    assert.equal(parseArgs(['list', '--home', '/tmp/x']).home, '/tmp/x')
  })

  it('缺命令 / --env 形式非法 / 环境名不安全都报错', () => {
    assert.throws(() => parseArgs([]), /missing command/)
    assert.throws(() => parseArgs(['install', '--env', 'NOEQUALS']), /--env requires KEY=value/)
    assert.throws(() => parseArgs(['list', '--profile', '..']), /unsafe profile name/)
    assert.throws(() => parseArgs(['list', '--profile']), /--profile requires a value/)
  })
})

describe('cli：分派与受保护操作', () => {
  /** 收集输出的假 stdout/stderr。 */
  function sink() {
    const out = []
    const err = []
    return {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      out: () => out.join(''),
      err: () => err.join(''),
    }
  }

  it('help / version 不触网不落盘', async () => {
    const io = sink()
    assert.equal(await main(['help'], io), 0)
    assert.match(io.out(), /dshpmc - companion CLI/)
    assert.match(USAGE, /uninstall-kind/)
    const io2 = sink()
    assert.equal(await main(['version'], io2), 0)
    assert.match(io2.out().trim(), /^[0-9]+\.[0-9]+\.[0-9]+/)
  })

  it('未知命令与缺参数返回用法错误码 2', async () => {
    const io = sink()
    assert.equal(await main(['nope'], io), 2)
    assert.match(io.err(), /unknown command/)
    const io2 = sink()
    assert.equal(await main(['install'], io2), 2)
    assert.match(io2.err(), /a package spec is required/)
    assert.equal(await main(['remove'], sink()), 2)
    assert.equal(await main(['uninstall-kind'], sink()), 2)
  })

  it('install 走官方 runPluginCommand，参数与上下文正确', async () => {
    const io = sink()
    const calls = []
    const code = await main(['install', 'dsh-plugin-foo', '--profile', 'pm-test'], {
      ...io,
      installAnchor: '/tmp/dsh-anchor/package.json',
      runPluginCommand: async (context, args, options) => {
        calls.push({ context, args, options })
        return { exitCode: 0, output: '' }
      },
    })
    assert.equal(code, 0)
    assert.equal(calls.length, 1)
    assert.deepEqual([...calls[0].args], ['add', 'dsh-plugin-foo'])
    assert.equal(calls[0].context.profile, 'pm-test')
    assert.equal(calls[0].context.installAnchor, '/tmp/dsh-anchor/package.json')
    assert.equal(calls[0].options.execution, 'cli')
    assert.match(io.out(), /installed dsh-plugin-foo into profile pm-test/)
  })

  it('update 重写 specifier 到 @latest；remove 直接转发', async () => {
    const calls = []
    const deps = {
      installAnchor: '/tmp/dsh-anchor/package.json',
      runPluginCommand: async (context, args) => {
        calls.push([...args])
        return { exitCode: 0, output: '' }
      },
      stdout: () => {},
      stderr: () => {},
    }
    assert.equal(await main(['update', 'dsh-plugin-foo'], deps), 0)
    assert.deepEqual(calls[0], ['add', 'dsh-plugin-foo@latest'])
    assert.equal(await main(['update', 'dsh-plugin-foo@1.2.3'], deps), 0)
    assert.deepEqual(calls[1], ['add', 'dsh-plugin-foo@1.2.3'])
    assert.equal(await main(['remove', 'dsh-plugin-foo'], deps), 0)
    assert.deepEqual(calls[2], ['remove', 'dsh-plugin-foo'])
  })

  it('官方包操作失败时把退出码与诊断传出来', async () => {
    const io = sink()
    const code = await main(['install', 'dsh-plugin-foo'], {
      ...io,
      installAnchor: '/tmp/anchor.json',
      runPluginCommand: async () => ({ exitCode: 1, output: 'boom', kind: 'build-failed', logPath: '/tmp/log/pnpm.log' }),
    })
    assert.equal(code, 1)
    assert.match(io.err(), /failure classified as build-failed/)
    assert.match(io.err(), /full log at \/tmp\/log\/pnpm\.log/)
  })

  it('git 源缺环境变量时停下并给续装命令，且不调 pnpm', async () => {
    const io = sink()
    const calls = []
    // 本地目录形态的 git 源：scanRequirements 会扫它，缺 GITHUB_TOKEN 就停下。
    // 目录名带 .git：CLI 只对"能落到本地目录"的 git 源做安装前扫描。
    const target = join(repo, 'needs-env.git')
    await put(join(target, 'README.md'), 'export GITHUB_TOKEN first' + nl)
    const code = await main(['install', target, '--home', home], {
      ...io,
      installAnchor: '/tmp/anchor.json',
      runPluginCommand: async (context, args) => {
        calls.push([...args])
        return { exitCode: 0, output: '' }
      },
    })
    assert.equal(code, 1)
    assert.deepEqual(calls, [])
    assert.match(io.err(), /GITHUB_TOKEN/)
    assert.match(io.err(), /--env GITHUB_TOKEN=\.\.\./)
  })

  it('list 打印环境事实与伴侣安装记录', async () => {
    const dir = join(home, 'profiles', 'web')
    await put(join(dir, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-foo': '^1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }))
    const io = sink()
    const code = await main(['list', '--home', home], io)
    assert.equal(code, 0)
    assert.match(io.out(), /profile: web/)
    assert.match(io.out(), /bundle layers \(1\)/)
    assert.match(io.out(), /@deepseek-ai\/dsh-base/)
    assert.match(io.out(), /- dsh-foo/)
    assert.match(io.out(), /companion-installed skills\/presets/)
    assert.match(io.out(), /skill root: /)
    assert.match(io.out(), /plugin_manager/)
  })

  it('mount 只读盘点并给出官方 plugin_manager 的下一步，不改任何文件', async () => {
    const io = sink()
    const code = await main(['mount', 'dsh-plugin-foo', '--home', home, '--profile', 'ghost'], io)
    assert.equal(code, 2)
    assert.match(io.err(), /is not installed at/)

    // 造一个声明了依赖但没有挂载的环境。
    const dir = join(home, 'profiles', 'declared')
    await put(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-plugin-foo': '^1.0.0' } }))
    const io2 = sink()
    assert.equal(await main(['mount', 'dsh-plugin-foo', '--home', home, '--profile', 'declared'], io2), 0)
    assert.match(io2.out(), /declared in package\.json: yes/)
    assert.match(io2.out(), /in the bundle layer stack: no/)
    assert.match(io2.out(), /set_plugin/)
    const unchanged = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    assert.deepEqual(unchanged, { dependencies: { 'dsh-plugin-foo': '^1.0.0' } })
  })

  it('analyze 未注入引擎时会自己去加载引擎（task-26：逃生口不再是死的）', async () => {
    await put(join(home, 'profiles', 'escape-hatch', 'package.json'), JSON.stringify({ name: 'dsh-profile-escape-hatch', private: true }))
    const io = sink()
    const code = await main(['analyze', '--profile', 'escape-hatch', '--home', home], io)
    // 不再返回 2「engine is not available」：动态加载引擎后真跑（锚点缺失时如实记不完整）。
    assert.notEqual(code, 2)
    assert.match(io.out(), /coverage: /)
    assert.match(io.out(), /install anchor: /)
    assert.doesNotMatch(io.err(), /diagnostics engine is not available/)
  })

  it('analyze 有引擎时打印报告，有问题退出码 1、没问题 0', async () => {
    const issue = {
      id: 'i1', layer: 'composition', severity: 'safe-fix', code: 'duplicate-row-id', title: 'dup',
      detail: 'two rows share an id', subjects: ['row'], evidence: [{ kind: 'file', at: 'cordis.patch.yml:7', note: 'n' }],
      fix: { action: 'remove-duplicate-row', target: 'row', summary: 'keep the first' },
    }
    const report = {
      environment: 'web', generatedAt: '2026-01-01T00:00:00.000Z',
      counts: { dependency: 0, composition: 1, runtime: 0, consistency: 0, ecosystem: 0 },
      issues: [issue], skipped: [{ check: 'runtime', reason: 'no loader' }],
    }
    const io = sink()
    const code = await main(['analyze', '--home', home], { ...io, analyze: async () => report })
    assert.equal(code, 1)
    assert.match(io.out(), /duplicate-row-id/)
    assert.match(io.out(), /cordis\.patch\.yml:7/)
    assert.match(io.out(), /skipped: runtime/)

    const io2 = sink()
    const clean = { ...report, issues: [], counts: { dependency: 0, composition: 0, runtime: 0, consistency: 0, ecosystem: 0 } }
    assert.equal(await main(['analyze', '--home', home, '--json'], { ...io2, analyze: async () => clean }), 0)
    assert.equal(JSON.parse(io2.out()).issues.length, 0)
  })

  it('uninstall-kind 对不存在的记录报错', async () => {
    const io = sink()
    assert.equal(await main(['uninstall-kind', 'owner/nope', '--home', home], io), 2)
    assert.match(io.err(), /no companion install record/)
  })
})
describe('cli：analyze 只读逃生口（无宿主、环境起不来也要能跑）', () => {
  /** 收集输出的假 sink。 */
  function sink() {
    const out = []
    const err = []
    return { stdout: (text) => out.push(text), stderr: (text) => err.push(text), out: () => out.join(''), err: () => err.join('') }
  }

  /** 造一个"两行同 id"的坏了的环境；这是真机验证过会让 dsh 启动阶段硬失败的形态。 */
  async function brokenProfile(name) {
    const dir = join(home, 'profiles', name)
    await put(join(dir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-' + name,
      private: true,
      dsh: { profile: { bundles: ['dsh-plugin-manager-companion'] } },
      dependencies: { 'dsh-plugin-manager-companion': 'link:.' },
    }))
    await put(join(dir, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: dup-row',
      '      name: dsh-plugin-manager-companion',
      '    - id: dup-row',
      '      name: dsh-plugin-manager-companion',
    ].join(String.fromCharCode(10)) + String.fromCharCode(10))
    await put(join(dir, 'cordis.yml'), '[]' + String.fromCharCode(10))
    return dir
  }

  /** 造一个没有任何注入缺陷的普通环境。 */
  async function plainProfile(name) {
    const dir = join(home, 'profiles', name)
    await put(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-' + name, private: true }))
    await put(join(dir, 'cordis.patch.yml'), '[]' + String.fromCharCode(10))
    await put(join(dir, 'cordis.yml'), '[]' + String.fromCharCode(10))
    return dir
  }

  /**
   * 造一个**真能解析出模块根**的锚点：文件本身 + 同级 node_modules 目录。
   *
   * 引擎用 createRequire(anchor).resolve.paths() 取安装侧解析根：只有锚点文件而没有
   * 同级 node_modules 时，它会如实记一条 install-anchor skipped（那是引擎的诚实降级）。
   * 测试要能证明**锚点确实传到了引擎**，所以这里给它一个能解析出根的目录结构。
   */
  async function anchorFile() {
    const path = join(home, 'anchor', 'package.json')
    await put(path, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.0.0-test' }))
    await mkdir(join(home, 'anchor', 'node_modules'), { recursive: true })
    return path
  }

  it('loadAnalyzer 通过动态 import 拿到引擎（cli.ts 不静态依赖它）', async () => {
    const loaded = await loadAnalyzer()
    assert.equal(typeof loaded.analyzer?.analyzeEnvironment, 'function')
    assert.equal(loaded.reason, undefined)
  })

  it('没有注入引擎时也能跑：报出组合层根因（含文件与行号），并显式说清锚点用的是什么', async () => {
    const dir = await brokenProfile('broken-dup')
    const anchor = await anchorFile()
    const io = sink()
    const code = await main(['analyze', '--profile', 'broken-dup', '--home', home], {
      ...io,
      installAnchor: anchor,
    })
    assert.equal(code, 1, '发现问题必须非 0 退出')
    const out = io.out()
    assert.match(out, /duplicate-row-id/)
    assert.match(out, /cordis\.patch\.yml:2/, '要给到文件与行号')
    assert.match(out, /duplicate loader entry id/, '要把启动阶段硬失败的原文摆出来')
    assert.match(out, /boot-blocking root cause/)
    // 锚点必须真的被显式传给引擎（变异验证的钉点）：只断言"打印了锚点"不够——那行是 CLI 自己拼的。
    // 引擎收到锚点后不会再记 install-anchor 缺失；去掉传递时引擎会立刻记一条"没有安装锚点"。
    assert.match(out, new RegExp('install anchor: ' + anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.doesNotMatch(out, /skipped: install-anchor/)
    assert.doesNotMatch(out, /没有安装锚点/)
    assert.match(out, /coverage: /)
    assert.equal(io.err(), '')
    assert.equal(dir.length > 0, true)
  })

  it('拿不到安装锚点时：显式标 MISSING + 说明这会少查哪些层，不假装成功', async () => {
    await brokenProfile('broken-noanchor')
    const io = sink()
    const code = await main(['analyze', '--profile', 'broken-noanchor', '--home', home], {
      ...io,
      installAnchor: ' ',
    })
    const out = io.out()
    assert.notEqual(code, 0)
    assert.match(out, /install anchor: MISSING/)
    assert.match(out, /skipped: install-anchor/)
    assert.match(out, /没有安装锚点|读不到或解析不出模块根/)
    // 报出根因这件事不依赖锚点（纯文本组合检查照跑）。
    assert.match(out, /duplicate loader entry id/)
  })

  it('干净环境 + 拿不到锚点时 issues=0 也不许返回 0：必须说清"这次没能完成核对"', async () => {
    await plainProfile('plain-noanchor')
    const io = sink()
    const code = await main(['analyze', '--profile', 'plain-noanchor', '--home', home], {
      ...io,
      installAnchor: ' ',
    })
    const out = io.out()
    assert.equal(code, 1, '缺锚点时不允许 0')
    assert.match(out, /issues: 0/)
    assert.match(out, /INCOMPLETE/)
    assert.match(out, /不代表环境健康/)
    assert.match(out, /install-anchor: 没有安装锚点/)
  })

  it('干净环境也不会被画成"健康"：退出 0 只在组合层真的跑完时出现', async () => {
    await plainProfile('plain')
    const anchor = await anchorFile()
    const io = sink()
    const code = await main(['analyze', '--profile', 'plain', '--home', home], { ...io, installAnchor: anchor })
    const out = io.out()
    assert.match(out, /issues: 0/)
    if (code === 0) {
      assert.match(out, /composition=ran/, '只有组合层真的跑完才允许 0')
    } else {
      assert.match(out, /INCOMPLETE/, '没跑完必须如实说明，而不是返回 0')
      assert.equal(code, 1)
    }
  })

  it('环境目录不存在时：报错但不假装诊断过', async () => {
    const io = sink()
    const code = await main(['analyze', '--profile', 'never-existed', '--home', home], { ...io, installAnchor: ' ' })
    assert.notEqual(code, 0)
    assert.match(io.out(), /environment-dir/)
  })

  it('judgeAnalyze 语义：issues=0 但关键层没跑完 ≠ 健康', () => {
    const counts = { dependency: 0, composition: 0, runtime: 0, consistency: 0, ecosystem: 0 }
    const base = { environment: 'x', generatedAt: 'now', counts, issues: [] }
    const clean = judgeAnalyze({ ...base, skipped: [] })
    assert.equal(clean.verdict, 'clean')
    assert.equal(clean.code, 0)

    const keySkipped = judgeAnalyze({ ...base, skipped: [{ check: 'composition-official', reason: 'cannot resolve profile bundle "x"' }] })
    assert.equal(keySkipped.verdict, 'incomplete')
    assert.equal(keySkipped.code, 1)
    assert.deepEqual([...keySkipped.blockers], ['cannot resolve profile bundle "x"'])

    // 运行时层在 CLI 里结构性不可用：要报出来，但不构成"有问题"。
    const runtimeOnly = judgeAnalyze({ ...base, skipped: [{ check: 'runtime-inventory', reason: 'no loader' }] })
    assert.equal(runtimeOnly.verdict, 'clean')
    assert.equal(runtimeOnly.code, 0)

    const withIssues = judgeAnalyze({ ...base, issues: [{ id: 'i', layer: 'composition', severity: 'safe-fix', code: 'duplicate-row-id', title: 't', detail: 'd', subjects: [], evidence: [] }], skipped: [] })
    assert.equal(withIssues.verdict, 'issues')
    assert.equal(withIssues.code, 1)

    const missingAnchor = judgeAnalyze({ ...base, skipped: [] }, { anchorMissing: true })
    assert.equal(missingAnchor.verdict, 'incomplete')
    assert.equal(missingAnchor.code, 1)
  })
})

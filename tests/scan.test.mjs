/**
 * scan.ts / installSession.ts / tools.ts / cli.ts 的行为测试（node --test，import dist 产物）。
 *
 * 归口说明：guard.ts 的测试在 tests/kinds.test.mjs；本文件覆盖其余四个模块。
 * 验收重点（任务书原文）：scanRequirements 的上限与敏感键剔除、installSession 的 TTL
 * 与白名单校验；另加 tools/cli 的决策面（上限钳制、缺失能力如实报错、参数解析与分派），
 * 它们同样是"给模型/给用户看的可见行为"，不能只靠手工跑。
 *
 * 纪律：全部 import ../dist/*.js；home 用 --home / __setHomeForTests 指向临时目录；
 * CLI 的包操作注入假 runPluginCommand —— 测试绝不真跑 pnpm。
 */

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_SCAN_LIMITS, buildFilteredEnv, buildFilteredEnvWithAnswers, formatMissingRequirements,
  isGitSource, isSensitiveEnvKey, scanRequirements, sourceOf,
} from '../dist/scan.js'
import {
  SESSION_TTL_MS, __resetSessionsForTests, __setClockForTests, createInstallSession, dropInstallSession,
  filterAnswers, getInstallSession, pruneExpiredSessions, sessionCount, sessionKey,
} from '../dist/installSession.js'
import {
  HEALTH_ISSUE_LIMIT, SEARCH_LIMIT_MAX, createCompanionTools, renderHealthText, renderSearchText,
} from '../dist/tools.js'
import { DEFAULT_PROFILE, USAGE, main, parseArgs } from '../dist/cli.js'
import { __resetKindCacheForTests, __setHomeForTests } from '../dist/kinds.js'
import { DEFAULT_CONFIG } from '../dist/settings.js'

const nl = String.fromCharCode(10)
let repo
let home

async function put(path, text) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, text, 'utf8')
}

before(async () => {
  repo = await mkdtemp(join(tmpdir(), 'dshpmc-scan-repo-'))
  home = await mkdtemp(join(tmpdir(), 'dshpmc-scan-home-'))
  __setHomeForTests(home)
  __resetKindCacheForTests()
})

after(async () => {
  __setHomeForTests(null)
  __resetKindCacheForTests()
  await rm(repo, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

describe('isSensitiveEnvKey', () => {
  it('命中常见凭据形态，放过普通变量', () => {
    for (const key of ['GITHUB_TOKEN', 'OPENAI_API_KEY', 'DB_PASSWORD', 'XXX_PASS', 'AWS_SECRET_ACCESS_KEY',
      'ANTHROPIC_API_KEY', 'MY_APP_TOKEN', 'GH_TOKEN', 'apiKey', 'accessToken', 'clientSecret', 'dbPassword']) {
      assert.equal(isSensitiveEnvKey(key), true, key + ' 应当被判为敏感')
    }
    for (const key of ['PATH', 'HOME', 'NODE_ENV', 'PORT', 'KEYBOARD_LAYOUT', 'monkey', 'sessionCookie', '']) {
      assert.equal(isSensitiveEnvKey(key), false, key + ' 不该被判为敏感')
    }
  })
})

describe('scanRequirements', () => {
  it('从 README / .env.example / package.json 里找出敏感变量并给出来源', async () => {
    const target = join(repo, 'basic')
    await put(join(target, 'README.md'), 'Set GITHUB_TOKEN and OPENAI_API_KEY before installing.' + nl)
    await put(join(target, '.env.example'), 'DB_PASSWORD=' + nl + 'PORT=8080' + nl)
    await put(join(target, 'package.json'), JSON.stringify({
      name: 'x',
      scripts: { prepare: 'node scripts/setup.js' },
      config: { SLACK_TOKEN: 'placeholder' },
    }))
    const report = await scanRequirements(target)
    assert.deepEqual([...report.requirements].sort(), ['DB_PASSWORD', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'SLACK_TOKEN'])
    assert.equal(report.truncated, false)
    assert.equal(sourceOf(report, 'GITHUB_TOKEN').file, 'README.md')
    assert.equal(sourceOf(report, 'DB_PASSWORD').file, '.env.example')
    assert.equal(sourceOf(report, 'SLACK_TOKEN').file, 'package.json')
    assert.equal(sourceOf(report, 'OPENAI_API_KEY').sensitive, true)
    assert.equal(sourceOf(report, 'nope'), undefined)
  })

  it('跳过 node_modules / 点目录 / 构建产物', async () => {
    const target = join(repo, 'skip')
    await put(join(target, 'README.md'), 'nothing here' + nl)
    await put(join(target, 'node_modules', 'dep', 'README.md'), 'NEED_TOKEN=1' + nl)
    await put(join(target, '.git', 'README.md'), 'GIT_SECRET=1' + nl)
    await put(join(target, 'dist', 'README.md'), 'BUILD_TOKEN=1' + nl)
    const report = await scanRequirements(target)
    assert.deepEqual([...report.requirements], [])
  })

  it('变量数触顶时如实标注 truncated 与原因', async () => {
    const target = join(repo, 'limit-vars')
    const names = ['ALPHA_TOKEN', 'BETA_TOKEN', 'GAMMA_TOKEN', 'DELTA_TOKEN']
    await put(join(target, 'README.md'), names.join(' ') + nl)
    const report = await scanRequirements(target, { limits: { maxVariables: 2 } })
    assert.equal(report.requirements.length, 2)
    assert.equal(report.truncated, true)
    assert.match(report.truncatedReasons.join(' '), /variable budget reached \(2\)/)
  })

  it('文件数触顶时如实标注', async () => {
    const target = join(repo, 'limit-files')
    for (let index = 0; index < 5; index += 1) {
      await put(join(target, 'doc-' + index + '.md'), 'TOKEN_' + index + '_VALUE' + nl)
    }
    const report = await scanRequirements(target, { limits: { maxFiles: 2 } })
    assert.equal(report.truncated, true)
    assert.match(report.truncatedReasons.join(' '), /file budget reached \(2\)/)
  })

  it('层数触顶时如实标注', async () => {
    const target = join(repo, 'limit-depth')
    await put(join(target, 'a', 'b', 'c', 'README.md'), 'DEEP_TOKEN=x' + nl)
    const shallow = await scanRequirements(target, { limits: { maxDepth: 1 } })
    assert.deepEqual([...shallow.requirements], [])
    assert.equal(shallow.truncated, true)
    assert.match(shallow.truncatedReasons.join(' '), /directory depth exceeded 1/)
    // 默认只走两层：a/b/c/README.md 在第三层，默认扫不到——这正是有界的含义。
    assert.deepEqual([...(await scanRequirements(target)).requirements], [])
    const deep = await scanRequirements(target, { limits: { maxDepth: 3 } })
    assert.deepEqual([...deep.requirements], ['DEEP_TOKEN'])
  })

  it('超大文件被跳过并计数', async () => {
    const target = join(repo, 'oversize')
    await put(join(target, 'README.md'), 'X'.repeat(2048) + ' BIG_TOKEN=1' + nl)
    const report = await scanRequirements(target, { limits: { maxFileBytes: 128 } })
    assert.equal(report.oversized, 1)
    assert.deepEqual([...report.requirements], [])
  })

  it('默认上限是有限值（有界扫描不是口头的）', () => {
    assert.equal(Number.isFinite(DEFAULT_SCAN_LIMITS.maxDepth), true)
    assert.equal(Number.isFinite(DEFAULT_SCAN_LIMITS.maxFiles), true)
    assert.equal(Number.isFinite(DEFAULT_SCAN_LIMITS.maxVariables), true)
  })
})

describe('buildFilteredEnv / buildFilteredEnvWithAnswers', () => {
  it('剔除敏感键，保留工具链需要的键', () => {
    const filtered = buildFilteredEnv({
      PATH: '/usr/bin', HOME: '/home/u', GITHUB_TOKEN: 'secret', OPENAI_API_KEY: 'k', DB_PASSWORD: 'p', NODE_ENV: 'test',
    })
    assert.equal(filtered.PATH, '/usr/bin')
    assert.equal(filtered.HOME, '/home/u')
    assert.equal(filtered.NODE_ENV, 'test')
    assert.equal('GITHUB_TOKEN' in filtered, false)
    assert.equal('OPENAI_API_KEY' in filtered, false)
    assert.equal('DB_PASSWORD' in filtered, false)
  })

  it('answers 只按白名单注入：白名单外的键进不来', () => {
    const env = buildFilteredEnvWithAnswers(
      { PATH: '/usr/bin', GITHUB_TOKEN: 'host-secret' },
      { GITHUB_TOKEN: 'user-provided', PATH: '/evil', HOME: '/evil', EMPTY: '' },
      ['GITHUB_TOKEN', 'PATH', 'HOME', 'EMPTY'],
    )
    // 显式提供即同意：用户给的 GITHUB_TOKEN 覆盖掉被剔除的宿主值。
    assert.equal(env.GITHUB_TOKEN, 'user-provided')
    // 空字符串 = 跳过，不注入空值。
    assert.equal('EMPTY' in env, false)
    // 白名单里没有的键一律不注入（PATH 只在白名单里才允许出现）。
    const restricted = buildFilteredEnvWithAnswers({ PATH: '/usr/bin' }, { PATH: '/evil', FOO: 'bar' }, ['FOO'])
    assert.equal(restricted.PATH, '/usr/bin')
    assert.equal(restricted.FOO, 'bar')
  })

  it('未提供值时宿主同名敏感变量仍被剔除', () => {
    const env = buildFilteredEnvWithAnswers({ GITHUB_TOKEN: 'host-secret', PATH: '/usr/bin' }, {}, ['GITHUB_TOKEN'])
    assert.equal('GITHUB_TOKEN' in env, false)
    assert.equal(env.PATH, '/usr/bin')
  })

  it('formatMissingRequirements 带出来源，已提供的不算缺', () => {
    const report = {
      requirements: ['GITHUB_TOKEN', 'DB_PASSWORD'],
      sources: [{ file: 'README.md', via: 'text', sensitive: true }, { file: '.env.example', via: 'text', sensitive: true }],
      truncated: false, truncatedReasons: [], filesRead: 2, depthReached: 0, oversized: 0,
    }
    const missing = formatMissingRequirements(report, { GITHUB_TOKEN: 'x' })
    assert.equal(missing.length, 1)
    assert.match(missing[0], /^DB_PASSWORD {2}\(found in \.env\.example\)$/)
  })
})

describe('isGitSource', () => {
  it('只把 git 源当作需要扫描的源', () => {
    for (const spec of ['git+https://github.com/o/r.git', 'github:o/r', 'git@github.com:o/r.git',
      'https://github.com/o/r.git', 'ssh://git@example.com/o/r.git', 'o/r.git']) {
      assert.equal(isGitSource(spec), true, spec)
    }
    for (const spec of ['dsh-plugin-foo', 'dsh-plugin-foo@1.2.3', './local-plugin', '/abs/path', 'file:../x', '']) {
      assert.equal(isGitSource(spec), false, spec)
    }
  })
})

describe('installSession：TTL 与白名单校验', () => {
  beforeEach(() => {
    __resetSessionsForTests()
    __setClockForTests(() => Date.now())
  })

  it('会话按归一化 spec 存取', () => {
    createInstallSession('git+https://GitHub.com/Owner/Repo.git/', '/cache/repo', ['GITHUB_TOKEN'])
    assert.equal(sessionKey('git+https://GitHub.com/Owner/Repo.git/'), sessionKey('git+https://github.com/owner/repo.git'))
    const session = getInstallSession('git+https://github.com/owner/repo.git')
    assert.equal(session.repoDir, '/cache/repo')
    assert.deepEqual([...session.scanned], ['GITHUB_TOKEN'])
    assert.equal(sessionCount(), 1)
    assert.equal(dropInstallSession('GIT+https://github.com/owner/repo.git'), true)
    assert.equal(getInstallSession('git+https://github.com/owner/repo.git'), undefined)
  })

  it('超过 TTL 后会话过期（时钟可注入，不必真等 15 分钟）', () => {
    let current = 1_000_000
    __setClockForTests(() => current)
    createInstallSession('github:o/r', '/cache/r', ['FOO_TOKEN'])
    assert.equal(sessionCount(), 1)
    current += SESSION_TTL_MS - 1
    assert.notEqual(getInstallSession('github:o/r'), undefined)
    current += 1
    // 读操作本身触发惰性清理。
    assert.equal(getInstallSession('github:o/r'), undefined)
    assert.equal(sessionCount(), 0)
    assert.equal(pruneExpiredSessions(), 0)
  })

  it('同 spec 重复创建覆盖旧会话（不泄漏两个在途）', () => {
    createInstallSession('github:o/r', '/cache/1', ['A_TOKEN'])
    createInstallSession('github:o/r', '/cache/2', ['B_TOKEN'])
    assert.equal(sessionCount(), 1)
    assert.equal(getInstallSession('github:o/r').repoDir, '/cache/2')
  })

  it('filterAnswers 只放行白名单键，拒绝内部前缀与空值', () => {
    const filtered = filterAnswers(
      ['GITHUB_TOKEN', 'DB_PASSWORD'],
      {
        GITHUB_TOKEN: 'ok',
        DB_PASSWORD: '',
        PATH: '/evil',
        HOME: '/evil',
        __internal: 'x',
        NPM_TOKEN: 'not-scanned',
      },
    )
    assert.deepEqual(filtered, { GITHUB_TOKEN: 'ok' })
    assert.deepEqual(filterAnswers(['A'], undefined), {})
  })
})

describe('tools：plugin_search 的决策面', () => {
  const item = (overrides) => ({
    repo: 'o/r', name: 'r', description: 'd', stars: 5, updatedAt: null, topics: ['t'], ...overrides,
  })

  it('渲染结果包含仓库与"安装前先浏览仓库"的提示', () => {
    const text = renderSearchText([{ repo: 'o/r', name: 'r', description: 'd', stars: null, topics: [], installed: true }], 'q')
    assert.match(text, /o\/r/)
    assert.match(text, /installed/)
    assert.match(text, /Review the repository before installing/)
    assert.match(renderSearchText([], 'q'), /No marketplace entry matched/)
    assert.match(renderSearchText([], ''), /marketplace index returned no entries/)
  })

  it('execute 把查询交给打分函数、按上限截断、未知星数保持 null', async () => {
    const calls = []
    const host = {
      market: async (options) => {
        calls.push(options)
        return { items: [item({ stars: null }), item({ repo: 'o/r2' })], generatedAt: '2026-01-01T00:00:00.000Z', total: 2 }
      },
      rank: (items, query) => {
        calls.push({ query })
        return items
      },
      analyze: async () => { throw new Error('not used') },
    }
    const tools = createCompanionTools(host)
    const search = tools.find(tool => tool.name === 'plugin_search')
    assert.notEqual(search, undefined)
    const value = await search.execute({ query: 'ocr', limit: 99, refresh: true }, {})
    assert.deepEqual(calls[0], { refresh: true })
    assert.equal(calls[1].query, 'ocr')
    assert.equal(value.query, 'ocr')
    assert.equal(value.indexed, 2)
    assert.equal(value.matches.length, 2)
    assert.equal(value.matches[0].stars, null)
    assert.equal(value.matches[0].installed, false)
    assert.equal(SEARCH_LIMIT_MAX >= 10, true)

    const clamped = await search.execute({ query: 'x', limit: -3 }, {})
    assert.equal(clamped.matches.length, 1)
  })

  it('缺少必填 query 时被参数 schema 拒绝', async () => {
    const tools = createCompanionTools({
      market: async () => ({ items: [], generatedAt: 'x' }),
      rank: (items) => items,
      analyze: async () => { throw new Error('not used') },
    })
    const search = tools.find(tool => tool.name === 'plugin_search')
    await assert.rejects(() => search.execute({}, {}), /query/)
  })
})

describe('tools：plugin_health 的决策面', () => {
  const report = (issues, counts) => ({
    environment: 'web',
    generatedAt: '2026-01-01T00:00:00.000Z',
    counts: { dependency: 0, composition: 0, runtime: 0, consistency: 0, ecosystem: 0, ...counts },
    issues,
    skipped: [{ check: 'runtime', reason: 'loader unavailable' }],
  })
  const issue = (index, layer = 'dependency') => ({
    id: 'i' + index, layer, severity: 'safe-fix', code: 'missing-import', title: 't', detail: 'd',
    subjects: ['pkg'], evidence: [{ kind: 'file', at: 'package.json:12', note: 'n' }],
    fix: { action: 'install-dep', target: 'pkg', summary: 'install it' },
  })

  it('报告投影成结构化摘要，问题条数有上限、跳过项如实带出', async () => {
    const many = Array.from({ length: HEALTH_ISSUE_LIMIT + 5 }, (_, index) => issue(index))
    const tools = createCompanionTools({
      market: async () => ({ items: [], generatedAt: 'x' }),
      rank: (items) => items,
      analyze: async (ctx, env, config) => {
        assert.equal(ctx, undefined)
        assert.equal(env, undefined)
        assert.equal(config, DEFAULT_CONFIG)
        return report(many, { dependency: many.length })
      },
    })
    const health = tools.find(tool => tool.name === 'plugin_health')
    const value = await health.execute({}, {})
    assert.equal(value.environment, 'web')
    assert.equal(value.issues.length, HEALTH_ISSUE_LIMIT)
    assert.equal(value.counts.dependency, many.length)
    assert.equal(value.counts.runtime, 0)
    assert.deepEqual([...value.skipped], [{ check: 'runtime', reason: 'loader unavailable' }])
    assert.match(value.summary, /issue\(s\)/)
    assert.match(renderHealthText(report(many, { dependency: many.length })), /more issues omitted/)
    assert.match(renderHealthText(report([], {})), /No issues found/)
  })

  it('layer 参数只筛问题，不动各层计数（UI 要能渲染每层总数）', async () => {
    const tools = createCompanionTools({
      market: async () => ({ items: [], generatedAt: 'x' }),
      rank: (items) => items,
      analyze: async () => report([issue(1, 'dependency'), issue(2, 'composition')], { dependency: 1, composition: 1 }),
    })
    const health = tools.find(tool => tool.name === 'plugin_health')
    const value = await health.execute({ layer: 'composition' }, {})
    assert.equal(value.issues.length, 1)
    assert.equal(value.issues[0].layer, 'composition')
    assert.equal(value.counts.dependency, 1)
    assert.equal(value.counts.composition, 1)
  })
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

  it('analyze 无诊断引擎时如实报错（不假装健康）', async () => {
    const io = sink()
    const code = await main(['analyze', '--home', home], io)
    assert.equal(code, 2)
    assert.match(io.err(), /diagnostics engine is not available/)
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

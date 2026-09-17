/**
 * kinds.ts + guard.ts 的行为测试（node --test，import dist 产物）。
 *
 * 纪律：被验的代码就是线上跑的代码 —— 全部从 ../dist/*.js 导入，不碰 src。
 * 目录级用例用 mkdtemp 夹具（检测/安装函数只读写文件系统，无网络、无宿主）。
 * DSH home 用 __setHomeForTests 指向临时目录，测试绝不碰用户真实的 ~/.dsh。
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __resetKindCacheForTests, __setHomeForTests, addBlockedRepo, blockedReposFile, cacheRoot,
  detectRepoType, findPluginRoots, findPresetRoots, findSkillRoots, installPreset, installSkill,
  isBlockedRepo, isUnderRoot, kindRecordsFile, loadBlockedRepos, loadKindRecords, looksLikeDshPlugin,
  normalizeRepoRef, pruneGhostRecords, removeBlockedRepo, removeKindRecord, rmRetry, safeDirName,
  saveKindRecord, skillDisplayName, slugDirName,
} from '../dist/kinds.js'
import {
  DENIAL_REASON, PLUGIN_RULE_SECTION, createPluginGuard, isDshPluginMutation, isProfilePackageMutation,
  isRawPluginMutation, positionalWords, registerGuard, registerPluginGuard, registerPluginRulePrompt,
} from '../dist/guard.js'
import { writeOwnerMarker, presetDigest } from '../dist/presets.js'

/** 夹具根目录。 */
let fixture
/** 假的 Harness home（记录文件与落地根都落在这里）。 */
let home

/** 写一个文件，自动建父目录。 */
async function put(path, text) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, text, 'utf8')
}

/** 造一个带 frontmatter 的 SKILL.md 内容。 */
function skillManifest(name) {
  return '---' + String.fromCharCode(10) + 'name: ' + name + String.fromCharCode(10) + '---' + String.fromCharCode(10) + 'body' + String.fromCharCode(10)
}

before(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'dshpmc-kinds-'))
  home = await mkdtemp(join(tmpdir(), 'dshpmc-home-'))
  __setHomeForTests(home)
  __resetKindCacheForTests()

  // 1. 根预设仓库
  await mkdir(join(fixture, 'preset-repo'), { recursive: true })
  await put(join(fixture, 'preset-repo', 'agent.cordis.yml'), '- []' + String.fromCharCode(10))
  // 2. 声明 dsh 字段的插件仓库
  await mkdir(join(fixture, 'plugin-repo'), { recursive: true })
  await put(join(fixture, 'plugin-repo', 'package.json'), JSON.stringify({ name: 'p', dsh: { client: true } }))
  // 3. 靠 @deepseek-ai/cordis 依赖判定的插件仓库
  await mkdir(join(fixture, 'plugin-deps-repo'), { recursive: true })
  await put(join(fixture, 'plugin-deps-repo', 'package.json'),
    JSON.stringify({ name: 'q', dependencies: { '@deepseek-ai/cordis': '^4.0.2' } }))
  // 4. 纯技能仓库
  await mkdir(join(fixture, 'skill-repo'), { recursive: true })
  await put(join(fixture, 'skill-repo', 'SKILL.md'), skillManifest('my-skill'))
  // 5. 技能仓库 + 工具链 package.json（不是 DSH 插件）
  await mkdir(join(fixture, 'skill-toolchain'), { recursive: true })
  await put(join(fixture, 'skill-toolchain', 'package.json'), JSON.stringify({ name: 'toolchain', scripts: {} }))
  await put(join(fixture, 'skill-toolchain', 'SKILL.md'), skillManifest('tool-skill'))
  // 6. 非插件 package.json（聚合页）
  await mkdir(join(fixture, 'aggregate-repo'), { recursive: true })
  await put(join(fixture, 'aggregate-repo', 'package.json'), JSON.stringify({ name: 'aggregate' }))
  // 7. 空仓库
  await mkdir(join(fixture, 'empty-repo'), { recursive: true })
  // 8. 技能集合仓库（多个嵌套 SKILL.md）
  await mkdir(join(fixture, 'skill-set', 'alpha'), { recursive: true })
  await mkdir(join(fixture, 'skill-set', 'beta'), { recursive: true })
  await put(join(fixture, 'skill-set', 'alpha', 'SKILL.md'), skillManifest('alpha'))
  await put(join(fixture, 'skill-set', 'beta', 'SKILL.md'), skillManifest('beta'))
  // 技能集合里应当被跳过的目录
  await mkdir(join(fixture, 'skill-set', 'node_modules', 'dep'), { recursive: true })
  await put(join(fixture, 'skill-set', 'node_modules', 'dep', 'SKILL.md'), skillManifest('dep'))
  await mkdir(join(fixture, 'skill-set', '.hidden'), { recursive: true })
  await put(join(fixture, 'skill-set', '.hidden', 'SKILL.md'), skillManifest('hidden'))
  await mkdir(join(fixture, 'skill-set', 'vendor', 'third'), { recursive: true })
  await put(join(fixture, 'skill-set', 'vendor', 'third', 'SKILL.md'), skillManifest('third'))
  // 9. 嵌套预设仓库（repo/sub/agent.cordis.yml）
  await mkdir(join(fixture, 'nested-preset', 'sub'), { recursive: true })
  await put(join(fixture, 'nested-preset', 'sub', 'agent.cordis.yml'), '- []' + String.fromCharCode(10))
  // 10. 多包插件仓库（packages/foo 才是插件）
  await mkdir(join(fixture, 'monorepo', 'packages', 'foo'), { recursive: true })
  await put(join(fixture, 'monorepo', 'packages', 'foo', 'package.json'), JSON.stringify({ name: 'foo', dsh: {} }))
})

after(async () => {
  __setHomeForTests(null)
  __resetKindCacheForTests()
  await rm(fixture, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

describe('slugDirName / safeDirName / normalizeRepoRef', () => {
  it('slug 折叠非字母数字并去首尾连字符', () => {
    assert.equal(slugDirName('Dsh Note!'), 'dsh-note')
    assert.equal(slugDirName('dsh.note_v2'), 'dsh-note-v2')
    assert.equal(slugDirName('---'), 'plugin')
  })

  it('safeDirName 给 Windows 保留设备名加后缀', () => {
    assert.equal(safeDirName('con'), 'con-skill')
    assert.equal(safeDirName('NUL'), 'NUL-skill')
    assert.equal(safeDirName('normal'), 'normal')
    assert.equal(safeDirName('   '), 'plugin')
  })

  it('normalizeRepoRef 收敛成小写 owner/repo，拒绝本地路径', () => {
    assert.equal(normalizeRepoRef('https://github.com/Owner/Repo.git#main'), 'owner/repo')
    assert.equal(normalizeRepoRef('git@github.com:Owner/Repo.git'), 'owner/repo')
    assert.equal(normalizeRepoRef('github:Owner/Repo/'), 'owner/repo')
    assert.equal(normalizeRepoRef('git+https://github.com/owner/repo'), 'owner/repo')
    assert.equal(normalizeRepoRef('/tmp/local-repo'), null)
    assert.equal(normalizeRepoRef('./relative'), null)
    assert.equal(normalizeRepoRef('just-a-name'), null)
  })

  it('looksLikeDshPlugin 只认声明了 DSH 能力的 manifest', () => {
    assert.equal(looksLikeDshPlugin({ dsh: {} }), true)
    assert.equal(looksLikeDshPlugin({ peerDependencies: { '@deepseek-ai/dsh-tools': '*' } }), true)
    assert.equal(looksLikeDshPlugin({ name: 'plain' }), false)
    assert.equal(looksLikeDshPlugin(null), null)
  })
})

describe('isUnderRoot 路径逃逸守卫', () => {
  it('根之内的路径通过，根本身与越界路径拒绝', () => {
    const root = join(fixture, 'skill-set')
    assert.equal(isUnderRoot(join(root, 'alpha'), root), true)
    assert.equal(isUnderRoot(join(root, 'alpha', 'SKILL.md'), root), true)
    assert.equal(isUnderRoot(root, root), false)
    assert.equal(isUnderRoot(join(root, '..', 'evil'), root), false)
    assert.equal(isUnderRoot(join(root, '..'), root), false)
    assert.equal(isUnderRoot(root + '-sibling', root), false)
  })

  it('根带尾部分隔符时仍判定正确', () => {
    const root = join(fixture, 'skill-set')
    assert.equal(isUnderRoot(join(root, 'alpha'), root + '/'), true)
    assert.equal(isUnderRoot(join(root, '..'), root + '/'), false)
  })
})

describe('detectRepoType 分层检测', () => {
  it('三种类型各自命中', async () => {
    assert.equal(await detectRepoType(join(fixture, 'preset-repo')), 'agent-preset')
    assert.equal(await detectRepoType(join(fixture, 'plugin-repo')), 'cordis-plugin')
    assert.equal(await detectRepoType(join(fixture, 'plugin-deps-repo')), 'cordis-plugin')
    assert.equal(await detectRepoType(join(fixture, 'skill-repo')), 'skill')
  })

  it('工具链 package.json 不把技能仓库判成插件', async () => {
    assert.equal(await detectRepoType(join(fixture, 'skill-toolchain')), 'skill')
  })

  it('普通 npm 仓库与空目录是 unknown', async () => {
    assert.equal(await detectRepoType(join(fixture, 'aggregate-repo')), 'unknown')
    assert.equal(await detectRepoType(join(fixture, 'empty-repo')), 'unknown')
    assert.equal(await detectRepoType(join(fixture, 'does-not-exist')), 'unknown')
  })

  it('嵌套形态在最后一层统一识别', async () => {
    assert.equal(await detectRepoType(join(fixture, 'nested-preset')), 'agent-preset')
    assert.equal(await detectRepoType(join(fixture, 'monorepo')), 'cordis-plugin')
    assert.equal(await detectRepoType(join(fixture, 'skill-set')), 'skill')
  })
})

describe('根发现', () => {
  it('findSkillRoots 跳过点目录 / node_modules / vendored', async () => {
    const roots = await findSkillRoots(join(fixture, 'skill-set'))
    const names = roots.map(root => root.split('/').pop()).sort()
    assert.deepEqual(names, ['alpha', 'beta'])
  })

  it('findSkillRoots 命中根技能后不再往下走', async () => {
    const roots = await findSkillRoots(join(fixture, 'skill-repo'))
    assert.equal(roots.length, 1)
    assert.equal(roots[0], join(fixture, 'skill-repo'))
  })

  it('findSkillRoots 遵守数量上限', async () => {
    const roots = await findSkillRoots(join(fixture, 'skill-set'), { limit: 1 })
    assert.equal(roots.length, 1)
  })

  it('findPresetRoots / findPluginRoots 找嵌套根', async () => {
    assert.deepEqual(await findPresetRoots(join(fixture, 'nested-preset')), [join(fixture, 'nested-preset', 'sub')])
    assert.deepEqual(await findPluginRoots(join(fixture, 'monorepo')), [join(fixture, 'monorepo', 'packages', 'foo')])
  })
})

describe('installSkill / installPreset', () => {
  it('技能落地到给定根，目录名取 frontmatter 的 name', async () => {
    const root = join(home, 'skills')
    const outcome = await installSkill(join(fixture, 'skill-repo'), 'owner/repo', { root })
    assert.equal(outcome.name, 'my-skill')
    assert.deepEqual(outcome.names, ['my-skill'])
    assert.equal(outcome.location, root)
    const copied = await readFile(join(root, 'my-skill', 'SKILL.md'), 'utf8')
    assert.match(copied, /name: my-skill/)
  })

  it('技能集合逐个落地，名字来自各自 frontmatter', async () => {
    const root = join(home, 'skills-set')
    const outcome = await installSkill(join(fixture, 'skill-set'), 'owner/skill-set', { root })
    assert.deepEqual([...outcome.names].sort(), ['alpha', 'beta'])
    assert.equal(outcome.name, '2-skills')
    await stat(join(root, 'alpha', 'SKILL.md'))
    await stat(join(root, 'beta', 'SKILL.md'))
  })

  it('frontmatter 里的路径逃逸形态不会被当成目录名', async () => {
    const root = join(home, 'skills-escape')
    const repo = join(fixture, 'escape-repo')
    await put(join(repo, 'SKILL.md'), '---' + String.fromCharCode(10) + 'name: ../../evil' + String.fromCharCode(10) + '---' + String.fromCharCode(10))
    assert.equal(await skillDisplayName(repo), null)
    const outcome = await installSkill(repo, 'owner/escape', { root })
    // 回落到仓库名 slug：仍然落在根之内。
    assert.deepEqual(outcome.names, ['escape'])
    assert.equal(isUnderRoot(outcome.dirs[0], root), true)
  })

  it('已被别的记录占用的名字拒绝安装', async () => {
    const root = join(home, 'skills-occupied')
    await assert.rejects(
      () => installSkill(join(fixture, 'skill-repo'), 'owner/repo', { root, occupied: new Set(['my-skill']) }),
      /already installed from another repository/,
    )
  })

  it('预设落地带归属标记，惯例名 preset 回落到仓库名', async () => {
    const root = join(home, 'presets')
    const outcome = await installPreset(join(fixture, 'preset-repo'), 'owner/dsh-foo', { root })
    assert.deepEqual(outcome.names, ['dsh-foo'])
    const marker = JSON.parse(await readFile(join(root, 'dsh-foo', '.dsh-preset-owner.json'), 'utf8'))
    assert.equal(marker.format, 0)
    assert.deepEqual(marker.owners, ['owner/dsh-foo'])
    assert.equal(typeof marker.digest, 'string')
    assert.equal(marker.digest, presetDigest(join(root, 'dsh-foo')))
  })

  it('嵌套预设用子目录名做 id，其中 preset 例外回落到仓库名', async () => {
    const root = join(home, 'presets-nested')
    const outcome = await installPreset(join(fixture, 'nested-preset'), 'owner/dsh-bar', { root })
    assert.deepEqual(outcome.names, ['sub'])
    const rootPreset = join(fixture, 'preset-named')
    await mkdir(join(rootPreset, 'preset'), { recursive: true })
    await put(join(rootPreset, 'preset', 'agent.cordis.yml'), '- []' + String.fromCharCode(10))
    const second = await installPreset(rootPreset, 'owner/dsh-baz', { root })
    assert.deepEqual(second.names, ['dsh-baz'])
  })

  it('没有 SKILL.md / agent.cordis.yml 时拒绝', async () => {
    await assert.rejects(() => installSkill(join(fixture, 'empty-repo'), 'owner/empty'), /no SKILL.md/)
    await assert.rejects(() => installPreset(join(fixture, 'empty-repo'), 'owner/empty'), /agent\.cordis\.yml/)
  })

  it('已有归属标记不被覆盖', async () => {
    const root = join(home, 'presets-marked')
    await mkdir(join(root, 'mine'), { recursive: true })
    await put(join(root, 'mine', 'agent.cordis.yml'), '- []' + String.fromCharCode(10))
    assert.equal(await writeOwnerMarker(join(root, 'mine'), ['first']), true)
    assert.equal(await writeOwnerMarker(join(root, 'mine'), ['second']), false)
    const marker = JSON.parse(await readFile(join(root, 'mine', '.dsh-preset-owner.json'), 'utf8'))
    assert.deepEqual(marker.owners, ['first'])
  })
})

describe('安装记录与幽灵清理', () => {
  it('记录落盘到 companion-kinds.json，键被归一化', async () => {
    const dir = join(home, 'skills', 'my-skill')
    await saveKindRecord('https://github.com/Owner/Repo.git', {
      kind: 'skill', repo: 'owner/repo', dir, installedAt: new Date().toISOString(),
    })
    const records = await loadKindRecords()
    assert.equal(records.has('owner/repo'), true)
    const raw = JSON.parse(await readFile(kindRecordsFile(), 'utf8'))
    assert.equal(raw.version, 1)
    assert.equal(raw.records['owner/repo'].kind, 'skill')
    assert.equal(kindRecordsFile().startsWith(cacheRoot()), true)
  })

  it('目录被外部删掉后 pruneGhostRecords 清掉记录', async () => {
    const dir = join(home, 'skills', 'ghost')
    await mkdir(dir, { recursive: true })
    await saveKindRecord('owner/ghost', { kind: 'skill', repo: 'owner/ghost', dir, installedAt: new Date().toISOString() })
    assert.equal((await loadKindRecords()).has('owner/ghost'), true)
    await rm(dir, { recursive: true, force: true })
    const dropped = await pruneGhostRecords()
    assert.deepEqual(dropped, ['owner/ghost'])
    assert.equal((await loadKindRecords()).has('owner/ghost'), false)
  })

  it('removeKindRecord 返回是否真的删掉了记录', async () => {
    await saveKindRecord('owner/removeme', {
      kind: 'agent-preset', repo: 'owner/removeme', dir: join(home, 'presets', 'x'), installedAt: new Date().toISOString(),
    })
    assert.equal(await removeKindRecord('owner/removeme'), true)
    assert.equal(await removeKindRecord('owner/removeme'), false)
    assert.equal((await loadKindRecords()).has('owner/removeme'), false)
  })
})

describe('屏蔽名单', () => {
  it('加入 / 判定 / 移出，键归一化', async () => {
    await addBlockedRepo('https://github.com/Blocked/Repo.git')
    assert.equal(await isBlockedRepo('blocked/repo'), true)
    assert.equal((await loadBlockedRepos()).has('blocked/repo'), true)
    const raw = JSON.parse(await readFile(blockedReposFile(), 'utf8'))
    assert.deepEqual(raw.repos, ['blocked/repo'])
    assert.equal(await removeBlockedRepo('BLOCKED/REPO'), true)
    assert.equal(await isBlockedRepo('blocked/repo'), false)
  })
})

describe('rmRetry', () => {
  it('删除不存在的路径是幂等的', async () => {
    await rmRetry(join(home, 'never-existed'))
  })
})

describe('guard：裸命令拦截与提示段', () => {
  it('识别官方 CLI 的插件变更（含 flag-first 与内联 flag）', () => {
    assert.equal(isDshPluginMutation('dsh plugin --profile web add foo'), true)
    assert.equal(isDshPluginMutation('dsh --profile web plugin add foo'), true)
    assert.equal(isDshPluginMutation('dsh --profile=web plugin remove foo'), true)
    assert.equal(isDshPluginMutation('/usr/local/bin/dsh plugin update foo'), true)
    assert.equal(isDshPluginMutation('dsh plugin list'), false)
    assert.equal(isDshPluginMutation('dsh plugin --profile web list'), false)
    assert.equal(isDshPluginMutation('dsh plugin help'), false)
    assert.equal(isDshPluginMutation('dsh doctor'), false)
  })

  it('识别对 profile 目录的包管理器变更，放过普通开发目录', () => {
    assert.equal(isProfilePackageMutation('pnpm --dir ~/.dsh/profiles/web add foo'), true)
    assert.equal(isProfilePackageMutation('pnpm add foo'), false)
    assert.equal(isProfilePackageMutation('pnpm run install-assets --dir ~/.dsh/profiles/web'), false)
    assert.equal(isProfilePackageMutation('npm --prefix /home/u/.dsh/profiles/web ci'), false)
    assert.equal(isProfilePackageMutation('npm --prefix /home/u/.dsh/profiles/web add foo'), true)
  })

  it('逐段判定：只读段不能豁免变更段，反之亦然', () => {
    assert.equal(isRawPluginMutation('dsh plugin list && dsh plugin remove foo'), true)
    assert.equal(isRawPluginMutation(['dsh plugin list', 'echo ok'].join(String.fromCharCode(10))), false)
    assert.equal(isRawPluginMutation('echo "dsh plugin add foo"'), true)
    assert.equal(isRawPluginMutation('cd /tmp && bun add left-pad'), false)
  })

  it('positionalWords 吃掉 flag 取值但保留子命令', () => {
    assert.deepEqual(positionalWords('dsh --profile web plugin add foo'), ['dsh', 'plugin', 'add', 'foo'])
    assert.deepEqual(positionalWords('dsh --profile=web plugin add foo'), ['dsh', 'plugin', 'add', 'foo'])
  })

  it('守卫只作用于 bash / run_code，拒绝原因可直接执行', () => {
    const guard = createPluginGuard()
    const reason = guard({ name: 'bash', arguments: { command: 'dsh plugin add foo' } })
    assert.equal(reason, DENIAL_REASON)
    assert.match(reason, /plugin_manager/)
    assert.match(reason, /set_plugin/)
    assert.match(reason, /install_bundle/)
    assert.match(reason, /dshpmc install/)
    assert.equal(guard({ name: 'run_code', arguments: { code: 'await tools.bash({ command: "pnpm add x" })' } }), undefined)
    assert.equal(guard({ name: 'bash', arguments: { command: 'dsh plugin list' } }), undefined)
    assert.equal(guard({ name: 'read', arguments: { file_path: 'x' } }), undefined)
  })

  it('注册面：工具守卫 + 常驻提示段，服务缺失时返回 null', () => {
    const registered = []
    const sections = []
    const ctx = {
      get: (name) => {
        if (name === 'tools') return { guard: (fn) => { registered.push(fn); return () => {} } }
        if (name === 'systemPrompt') return { section: (section) => { sections.push(section); return () => {} } }
        return undefined
      },
      logger: { info: () => {} },
    }
    const handles = registerGuard(ctx)
    assert.equal(typeof handles.guard, 'function')
    assert.equal(typeof handles.prompt, 'function')
    assert.equal(registered.length, 1)
    assert.equal(sections.length, 1)
    assert.equal(sections[0].name, PLUGIN_RULE_SECTION.name)
    assert.equal(sections[0].order, 300)
    assert.match(sections[0].text, /plugin_manager/)

    const bare = { get: () => undefined, logger: { info: () => {} } }
    assert.equal(registerPluginGuard(bare), null)
    assert.equal(registerPluginRulePrompt(bare), null)
  })
})

/**
 * kinds.ts + guard.ts 的行为测试（node --test，import dist 产物）。
 *
 * 纪律：被验的代码就是线上跑的代码 —— 全部从 ../dist/*.js 导入，不碰 src。
 * 目录级用例用 mkdtemp 夹具（检测/安装函数只读写文件系统，无网络、无宿主）。
 * DSH home 用 __setHomeForTests 指向临时目录，测试绝不碰用户真实的 ~/.dsh。
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, win32 } from 'node:path'
import {
  __resetKindCacheForTests, __setHomeForTests, addBlockedRepo, blockedReposFile, cacheRoot,
  canonicalKindKey, detectRepoType, findKindRecord, findOrphanKindDirs, findPluginRoots, findPresetRoots,
  findSkillRoots, installPreset, installSkill, isBlockedRepo, isUnderRoot, kindDirsOf, kindRecordsFile,
  loadBlockedRepos, loadKindRecords, looksLikeDshPlugin, normalizeRepoRef, presetsRoot, pruneGhostRecords,
  removeBlockedRepo, removeKindDir, removeKindRecord, rmRetry, safeDirName, saveKindRecord, skillDisplayName,
  skillsRoot, slugDirName,
} from '../dist/kinds.js'
import {
  DENIAL_REASON, PLUGIN_RULE_SECTION, createPluginGuard, isDshPluginMutation, isProfilePackageMutation,
  isRawPluginMutation, positionalWords, registerGuard, registerPluginGuard, registerPluginRulePrompt,
} from '../dist/guard.js'
import { writeOwnerMarker, presetDigest } from '../dist/presets.js'

/** 换行符（夹具文本里用）。 */
const nl = String.fromCharCode(10)

/** 夹具根目录。 */
let fixture
/** 假的 Harness home（记录文件与落地根都落在这里）。 */
let home

/** 目录是否存在。 */
async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

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
    // 用 basename 而不是 split('')：Windows 上分隔符是反斜杠，split('/') 会返回整条路径（平台审计 W-22）。
    const names = roots.map(root => basename(root)).sort()
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
describe('P10：仓库名含大写字母时的卸载寻址', () => {
  /** 每条用例一个干净世界：清缓存 + 清落地根 + 清记录文件。 */
  async function cleanWorld() {
    __setHomeForTests(home)
    for (const dir of [skillsRoot(), presetsRoot(), cacheRoot()]) {
      await rm(dir, { recursive: true, force: true })
    }
    __resetKindCacheForTests()
  }

  it('记录体保留原始大小写，键是小写；卸载查表必须容忍两者', async () => {
    await cleanWorld()
    const repoRoot = join(fixture, 'mixed-case-skill')
    await mkdir(repoRoot, { recursive: true })
    await writeFile(join(repoRoot, 'SKILL.md'), skillManifest('probe-skill-mixed'), 'utf8')
    const repo = 'WriteAudit/Probe-Skill-Mixed'
    const outcome = await installSkill(repoRoot, repo)
    assert.deepEqual([...outcome.names], ['probe-skill-mixed'])

    // 落盘事实：键归一化成小写，记录体的 repo 原样保留（展示名）。
    const onDisk = JSON.parse(await readFile(kindRecordsFile(), 'utf8'))
    assert.deepEqual(Object.keys(onDisk.records), [canonicalKindKey(repo)])
    assert.equal(onDisk.records[canonicalKindKey(repo)].repo, repo)
    assert.equal(canonicalKindKey(repo), 'writeaudit/probe-skill-mixed')

    // 客户端回传的是记录体里的 repo（原样大小写）——这正是卸载 op 的查表输入。
    const records = await loadKindRecords()
    const byDisplayName = records.get(repo)
    assert.notEqual(byDisplayName, undefined, '按展示名（原样大小写）必须查得到记录')
    assert.equal(byDisplayName.kind, 'skill')
    assert.equal(byDisplayName.repo, repo, '记录体仍是展示用的原始大小写')
    // 其它等价拼写同样命中：小写键、全大写、URL 形态。
    assert.notEqual(records.get(canonicalKindKey(repo)), undefined)
    assert.notEqual(records.get('WRITEAUDIT/PROBE-SKILL-MIXED'), undefined)
    assert.notEqual(records.get('https://github.com/writeaudit/probe-skill-mixed.git'), undefined)
    assert.equal(records.has(repo), true)
    // 遍历仍是一条记录（不能因为宽容而让列表出现两份）。
    assert.equal([...records.values()].length, 1)

    // 显式入口给出真实键与应清理目录。
    const found = await findKindRecord(repo)
    assert.equal(found.key, canonicalKindKey(repo))
    assert.deepEqual(kindDirsOf(found.record, skillsRoot()), outcome.dirs)

    // 走卸载 op 的完整序列：查表 → 删目录 → 删记录。
    const opRecord = records.get(repo)
    for (const dir of kindDirsOf(opRecord, skillsRoot())) await removeKindDir(skillsRoot(), dir)
    assert.equal(await removeKindRecord(repo), true)
    assert.equal(await exists(join(skillsRoot(), 'probe-skill-mixed')), false)
    assert.equal(await findKindRecord(repo), undefined)
    assert.equal([...(await loadKindRecords()).values()].length, 0)
  })

  it('预设卸载同样对大小写宽容（含 dirs 精确清理）', async () => {
    await cleanWorld()
    const repoRoot = join(fixture, 'mixed-case-preset')
    await mkdir(repoRoot, { recursive: true })
    await writeFile(join(repoRoot, 'agent.cordis.yml'), '- []' + nl, 'utf8')
    const repo = 'WriteAudit/Probe-Preset-Mixed'
    const outcome = await installPreset(repoRoot, repo)
    const records = await loadKindRecords()
    const record = records.get(repo)
    assert.notEqual(record, undefined)
    assert.equal(record.kind, 'agent-preset')
    assert.deepEqual(kindDirsOf(record, presetsRoot()), outcome.dirs)
    for (const dir of kindDirsOf(record, presetsRoot())) await removeKindDir(presetsRoot(), dir)
    assert.equal(await removeKindRecord(repo), true)
    assert.equal(await exists(join(presetsRoot(), 'dsh-foo')), false)
  })

  it('kindDirsOf 拒绝越界目录（宁少删不越界）', async () => {
    await cleanWorld()
    const outside = await mkdtemp(join(tmpdir(), 'dshpmc-outside-'))
    const record = { kind: 'skill', repo: 'owner/repo', dir: outside, installedAt: new Date().toISOString(), dirs: [outside] }
    assert.deepEqual(kindDirsOf(record, skillsRoot()), [])
    await rm(outside, { recursive: true, force: true })
  })
})

describe('孤儿目录扫描（orphans 不再恒为空）', () => {
  async function cleanWorld() {
    __setHomeForTests(home)
    for (const dir of [skillsRoot(), presetsRoot(), cacheRoot()]) {
      await rm(dir, { recursive: true, force: true })
    }
    __resetKindCacheForTests()
  }

  it('列出未被任何记录认领的目录，跳过点目录 / 文件 / 更深层', async () => {
    await cleanWorld()
    // 被认领的两个安装
    const skillRepo = join(fixture, 'orphan-skill')
    await mkdir(skillRepo, { recursive: true })
    await writeFile(join(skillRepo, 'SKILL.md'), skillManifest('claimed-skill'), 'utf8')
    await installSkill(skillRepo, 'owner/claimed-repo')
    const presetRepo = join(fixture, 'orphan-preset')
    await mkdir(presetRepo, { recursive: true })
    await writeFile(join(presetRepo, 'agent.cordis.yml'), '- []' + nl, 'utf8')
    await installPreset(presetRepo, 'owner/claimed-preset')

    // 残留：没有记录的技能目录（手工放置 / 卸载失败留下的），以及点目录、文件、更深层
    await mkdir(join(skillsRoot(), 'leftover-skill'), { recursive: true })
    await mkdir(join(presetsRoot(), 'leftover-preset'), { recursive: true })
    await mkdir(join(skillsRoot(), '.hidden-dir'), { recursive: true })
    await writeFile(join(skillsRoot(), 'README.md'), 'not a directory', 'utf8')
    await mkdir(join(skillsRoot(), 'claimed-skill', 'nested'), { recursive: true })

    const orphans = await findOrphanKindDirs()
    assert.deepEqual(orphans, [join(presetsRoot(), 'leftover-preset'), join(skillsRoot(), 'leftover-skill')].sort())
  })

  it('卸载只删掉记录、留下目录时，该目录会作为孤儿报出来', async () => {
    await cleanWorld()
    const dir = join(skillsRoot(), 'half-state')
    await mkdir(dir, { recursive: true })
    await saveKindRecord('owner/half-state', {
      kind: 'skill', repo: 'owner/half-state', dir, installedAt: new Date().toISOString(), dirs: [dir],
    })
    assert.deepEqual(await findOrphanKindDirs(), [])
    await removeKindRecord('owner/half-state')
    assert.deepEqual(await findOrphanKindDirs(), [dir])
  })

  it('旧记录（无 dirs、dir 指向根）不会把同 slug 的主目录误报成孤儿', async () => {
    await cleanWorld()
    await mkdir(join(skillsRoot(), 'pack'), { recursive: true })
    await mkdir(join(skillsRoot(), 'pack-other'), { recursive: true })
    // 旧包的记录形态：没有 dirs，dir 是根（多目录安装只记根）。
    await saveKindRecord('owner/pack', {
      kind: 'skill', repo: 'owner/pack', dir: skillsRoot(), installedAt: new Date().toISOString(),
    })
    assert.deepEqual(await findOrphanKindDirs(), [join(skillsRoot(), 'pack-other')])
  })

  it('根不存在时返回空数组，不抛', async () => {
    await cleanWorld()
    assert.deepEqual(await findOrphanKindDirs(), [])
  })
})
describe('卸载目录清单 kindDirsOf：新记录精确、旧记录不回归', () => {
  async function cleanWorld() {
    __setHomeForTests(home)
    for (const dir of [skillsRoot(), presetsRoot(), cacheRoot()]) {
      await rm(dir, { recursive: true, force: true })
    }
    __resetKindCacheForTests()
  }

  it('旧记录（无 dirs，dir=具体子目录）与以前行为一致：仍然卸得干净', async () => {
    await cleanWorld()
    const dir = join(skillsRoot(), 'legacy-skill')
    await mkdir(dir, { recursive: true })
    await saveKindRecord('Owner/Legacy-Skill', {
      kind: 'skill', repo: 'Owner/Legacy-Skill', dir, installedAt: new Date().toISOString(),
    })
    const record = (await loadKindRecords()).get('Owner/Legacy-Skill')
    assert.deepEqual(kindDirsOf(record, skillsRoot()), [dir], '旧记录必须退回 dir 这一条')
    // 与 index.ts 的卸载序列一致：清目录 → 删记录。
    for (const target of kindDirsOf(record, skillsRoot())) await removeKindDir(skillsRoot(), target)
    await removeKindRecord('Owner/Legacy-Skill')
    assert.equal(await exists(dir), false)
    assert.equal((await loadKindRecords()).size, 0)
  })

  it('多目录安装（dir=根、dirs 列出全部）逐个清干净，不留残留', async () => {
    await cleanWorld()
    const first = join(skillsRoot(), 'alpha')
    const second = join(skillsRoot(), 'beta')
    await mkdir(first, { recursive: true })
    await mkdir(second, { recursive: true })
    await saveKindRecord('owner/skill-set', {
      kind: 'skill', repo: 'owner/skill-set', dir: skillsRoot(), installedAt: new Date().toISOString(),
      dirs: [first, second], names: ['alpha', 'beta'],
    })
    const record = (await loadKindRecords()).get('owner/skill-set')
    assert.deepEqual(kindDirsOf(record, skillsRoot()).sort(), [first, second].sort())
    for (const target of kindDirsOf(record, skillsRoot())) await removeKindDir(skillsRoot(), target)
    await removeKindRecord('owner/skill-set')
    assert.equal(await exists(first), false)
    assert.equal(await exists(second), false)
    assert.deepEqual(await findOrphanKindDirs(), [], '清干净后不该再有孤儿')
  })

  it('多目录记录在 pruneGhostRecords 里存活（listKinds 先 prune 才能卸载）', async () => { 
    await cleanWorld()
    const first = join(skillsRoot(), 'alpha')
    const second = join(skillsRoot(), 'beta')
    await mkdir(first, { recursive: true })
    await mkdir(second, { recursive: true })
    const record = {
      kind: 'skill', repo: 'owner/skill-set', dir: skillsRoot(), installedAt: new Date().toISOString(),
      dirs: [first, second], names: ['alpha', 'beta'],
    }
    await saveKindRecord('owner/skill-set', record)
    // 真机踩过：dir 是根、dirs 还在，旧判定却因为 <root>/skill-set 不存在把记录当幽灵删掉，
    // 随后卸载只能报"没有安装记录"。
    assert.deepEqual(await pruneGhostRecords(), [])
    assert.notEqual((await loadKindRecords()).get('owner/skill-set'), undefined)
    assert.deepEqual(kindDirsOf(record, skillsRoot()).sort(), [first, second].sort())
    // 全部目录都没了才算幽灵。
    await rm(first, { recursive: true, force: true })
    assert.deepEqual(await pruneGhostRecords(), [])
    await rm(second, { recursive: true, force: true })
    assert.deepEqual(await pruneGhostRecords(), ['owner/skill-set'])
  })

  it('旧记录 dir 恰好等于根时仍不删根（保守），但会被孤儿扫描如实报出来', async () => {
    await cleanWorld()
    const dir = join(skillsRoot(), 'unknown-set')
    await mkdir(dir, { recursive: true })
    await saveKindRecord('owner/unknown-set', {
      kind: 'skill', repo: 'owner/unknown-set', dir: skillsRoot(), installedAt: new Date().toISOString(),
    })
    const record = (await loadKindRecords()).get('owner/unknown-set')
    assert.deepEqual(kindDirsOf(record, skillsRoot()), [], '绝不返回根本身（那是"删掉全部技能"）')
    assert.equal(await exists(skillsRoot()), true)
    assert.deepEqual(await findOrphanKindDirs(), [], '主目录名与仓库 slug 相同时按已认领处理（宁少报）')
  })
})
describe('符号链接：复制技能/预设时展开（平台审计 W-15）', () => {
  async function cleanWorld() {
    __setHomeForTests(home)
    for (const dir of [skillsRoot(), presetsRoot(), cacheRoot()]) {
      await rm(dir, { recursive: true, force: true })
    }
    __resetKindCacheForTests()
  }

  it('技能仓库里的符号链接落地为真实文件，而不是指向别处的链接', async (t) => {
    await cleanWorld()
    const repoRoot = join(fixture, 'symlink-skill')
    await mkdir(join(repoRoot, 'shared'), { recursive: true })
    await writeFile(join(repoRoot, 'shared', 'payload.md'), 'PAYLOAD', 'utf8')
    await writeFile(join(repoRoot, 'SKILL.md'), skillManifest('symlink-skill'), 'utf8')
    try {
      await symlink(join(repoRoot, 'shared', 'payload.md'), join(repoRoot, 'link.md'))
    } catch (error) {
      // Windows 普通用户建符号链接需要特权：夹具造不出来时如实跳过，不假装通过。
      t.skip('该平台不允许创建符号链接（' + String((error && error.code) || error) + '）：本用例无法在此平台取证')
      return
    }
    const outcome = await installSkill(repoRoot, 'owner/symlink-skill')
    const landed = join(outcome.dirs[0], 'link.md')
    const info = await lstat(landed)
    // 加 dereference:true 之前：Linux 上这里是个符号链接；Windows 普通用户上整次安装直接 EPERM 失败。
    assert.equal(info.isSymbolicLink(), false, '落地必须是真实文件')
    assert.equal(await readFile(landed, 'utf8'), 'PAYLOAD', '展开后的内容要跟被指向的文件一致')
  })

  it('basename 在 Windows 路径形态下也取末段（W-22 的判据，Linux 上可跑）', () => {
    // 把旧写法为什么不行钉成可执行事实：同一输入下 split('/') 返回整串，win32.basename 返回末段。
    assert.equal(win32.basename('C:\\Users\\me\\skills\\alpha'), 'alpha')
    assert.equal('C:\\Users\\me\\skills\\alpha'.split('/').pop(), 'C:\\Users\\me\\skills\\alpha')
  })
})

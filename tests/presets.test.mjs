/**
 * presets.ts 的行为测试（node --test，import dist 产物）。
 *
 * 关键验收：presetDigest 的修改检测、cleanupOwnedPresets 区分"原版 / 用户改过"、
 * 多 owner 不处理、归档/恢复零损失与冲突跳过、删除优先经官方 agentPresets 服务。
 * 全部在临时 home 下跑，绝不碰用户真实的 <dshHome>/.agent-presets。
 */

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __resetKindCacheForTests, __setHomeForTests, cacheRoot } from '../dist/kinds.js'
import {
  agentPresetsOf, archiveOwnedPresets, cleanupOwnedPresets, formatArchiveResult, formatCleanupResult,
  formatRestoreResult, OWNER_MARKER, OWNER_MARKER_FORMAT, pluginInstalledInOtherEnvironments,
  presetArchiveDir, presetDigest, presetOwnedBy, readPresetOwners, restoreArchivedPresets,
  scanPresets, scanPresetOwnership, userPresetRoot, writeOwnerMarker,
} from '../dist/presets.js'

let home
let presetRoot
const nl = String.fromCharCode(10)

async function put(path, text) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, text, 'utf8')
}

/** 造一个预设目录：agent.cordis.yml + 可选标记内容。 */
async function makePreset(id, options = {}) {
  const dir = join(presetRoot, id)
  await mkdir(dir, { recursive: true })
  await put(join(dir, 'agent.cordis.yml'), options.composition ?? '- []' + nl)
  if (options.marker !== undefined) await put(join(dir, OWNER_MARKER), JSON.stringify(options.marker, undefined, 2))
  if (options.extraMarkers !== undefined) {
    for (const [file, content] of Object.entries(options.extraMarkers)) {
      await put(join(dir, file), JSON.stringify(content, undefined, 2))
    }
  }
  return dir
}

/** 读一个目录是否存在。 */
async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'dshpmc-presets-home-'))
  presetRoot = join(home, 'presets-root')
  await mkdir(presetRoot, { recursive: true })
  __setHomeForTests(home)
  __resetKindCacheForTests()
})

beforeEach(async () => {
  // 每个用例独立的预设根与归档根，避免相互污染（归档位置由 cacheRoot 派生，
  // 而 cacheRoot 绑定临时 home，所以这里删掉整个归档目录即可）。
  presetRoot = await mkdtemp(join(home, 'presets-'))
  await rm(presetArchiveDir(), { recursive: true, force: true })
})

after(async () => {
  __setHomeForTests(null)
  __resetKindCacheForTests()
  await rm(home, { recursive: true, force: true })
})

describe('presetDigest', () => {
  it('同一份内容 digest 稳定', async () => {
    const dir = await makePreset('stable')
    assert.equal(presetDigest(dir), presetDigest(dir))
  })

  it('组合文件被改过 digest 就变', async () => {
    const dir = await makePreset('edited')
    const before = presetDigest(dir)
    await put(join(dir, 'agent.cordis.yml'), '- []' + nl + '# user edit' + nl)
    assert.notEqual(presetDigest(dir), before)
  })

  it('preset.yml 也参与 digest', async () => {
    const dir = await makePreset('meta')
    const before = presetDigest(dir)
    await put(join(dir, 'preset.yml'), 'name: changed' + nl)
    assert.notEqual(presetDigest(dir), before)
  })
})

describe('readPresetOwners 兼容三种标记', () => {
  it('读标准标记的 owners 与 owner 两种写法', async () => {
    const dir = await makePreset('std', { marker: { format: OWNER_MARKER_FORMAT, owners: ['a', 'b'] } })
    assert.deepEqual(readPresetOwners(dir), ['a', 'b'])
    const single = await makePreset('std-single', { marker: { format: OWNER_MARKER_FORMAT, owner: 'solo' } })
    assert.deepEqual(readPresetOwners(single), ['solo'])
  })

  it('读 dsh-agent-rp 形态（owner + format），格式不符则跳过', async () => {
    const dir = await makePreset('rp', { extraMarkers: { '.dsh-agent-rp-owner.json': { owner: 'dsh-agent-rp', format: 0, digest: 'x' } } })
    assert.deepEqual(readPresetOwners(dir), ['dsh-agent-rp'])
    const future = await makePreset('rp-future', { extraMarkers: { '.dsh-agent-rp-owner.json': { owner: 'x', format: 7 } } })
    assert.deepEqual(readPresetOwners(future), [])
  })

  it('读 gamelike 形态（owners 数组、无 digest）', async () => {
    const dir = await makePreset('gamelike', { extraMarkers: { '.plugin-manage-owner.json': { format: 0, owners: ['gamelike-plugin-manage'] } } })
    assert.deepEqual(readPresetOwners(dir), ['gamelike-plugin-manage'])
    // 没有 digest → 报"未修改"（没有可比对的基线）。
    assert.deepEqual(presetOwnedBy(dir, 'gamelike-plugin-manage'), { owned: true, modified: false })
  })

  it('标准标记损坏时整体 fail closed（不返回任何 owner）', async () => {
    const dir = await makePreset('broken')
    await put(join(dir, OWNER_MARKER), '{ not json')
    assert.deepEqual(readPresetOwners(dir), [])
    // 损坏的标准标记 + 声称的 owner → 判定为 owned 但 modified（拿不到基线，按"可能被改过"处理）。
    assert.deepEqual(presetOwnedBy(dir, 'anything'), { owned: false, modified: false })
  })
})

describe('presetOwnedBy', () => {
  it('唯一 owner 匹配即 owned，未改过时 modified 为 false', async () => {
    const dir = await makePreset('solo', { marker: { format: OWNER_MARKER_FORMAT, owners: ['dsh-foo'] } })
    const digest = presetDigest(dir)
    await put(join(dir, OWNER_MARKER), JSON.stringify({ format: OWNER_MARKER_FORMAT, owners: ['dsh-foo'], digest }))
    assert.deepEqual(presetOwnedBy(dir, 'dsh-foo'), { owned: true, modified: false })
  })

  it('用户改过组合文件后 modified 为 true', async () => {
    const dir = await makePreset('edited-owner', { marker: { format: OWNER_MARKER_FORMAT, owners: ['dsh-foo'] } })
    const digest = presetDigest(dir)
    await put(join(dir, OWNER_MARKER), JSON.stringify({ format: OWNER_MARKER_FORMAT, owners: ['dsh-foo'], digest }))
    await put(join(dir, 'agent.cordis.yml'), '- []' + nl + '# edited' + nl)
    assert.deepEqual(presetOwnedBy(dir, 'dsh-foo'), { owned: true, modified: true })
  })

  it('多 owner 预设不属于任何人', async () => {
    const dir = await makePreset('shared', { marker: { format: OWNER_MARKER_FORMAT, owners: ['dsh-foo', 'dsh-bar'] } })
    assert.deepEqual(presetOwnedBy(dir, 'dsh-foo'), { owned: false, modified: false })
  })

  it('owner 不匹配时不属于该插件', async () => {
    const dir = await makePreset('other', { marker: { format: OWNER_MARKER_FORMAT, owners: ['dsh-bar'] } })
    assert.deepEqual(presetOwnedBy(dir, 'dsh-foo'), { owned: false, modified: false })
  })
})

describe('scanPresets', () => {
  it('列出目录名即 id，跳过点目录', async () => {
    await makePreset('one')
    await makePreset('two')
    await mkdir(join(presetRoot, '.hidden'), { recursive: true })
    const ids = scanPresets(presetRoot).map(entry => entry.id).sort()
    assert.deepEqual(ids, ['one', 'two'])
    assert.deepEqual(scanPresets(join(home, 'nope')), [])
  })

  it('scanPresetOwnership 带出 owners/owned/modified', async () => {
    const dir = await makePreset('mine', { marker: { format: OWNER_MARKER_FORMAT, owners: ['dsh-foo'] } })
    const digest = presetDigest(dir)
    await put(join(dir, OWNER_MARKER), JSON.stringify({ format: OWNER_MARKER_FORMAT, owners: ['dsh-foo'], digest }))
    await makePreset('theirs', { marker: { format: OWNER_MARKER_FORMAT, owners: ['dsh-bar'] } })
    const scan = scanPresetOwnership(presetRoot, 'dsh-foo')
    assert.equal(scan.root, presetRoot)
    const mine = scan.entries.find(entry => entry.id === 'mine')
    const theirs = scan.entries.find(entry => entry.id === 'theirs')
    assert.equal(mine.owned, true)
    assert.equal(mine.modified, false)
    assert.equal(theirs.owned, false)
    assert.deepEqual(theirs.owners, ['dsh-bar'])
  })
})

describe('cleanupOwnedPresets（卸载清理）', () => {
  it('清原版、保留用户改过的并报告原因', async () => {
    const pristine = await makePreset('pristine', { marker: { format: OWNER_MARKER_FORMAT, owners: ['dsh-foo'] } })
    await put(join(pristine, OWNER_MARKER), JSON.stringify({ format: OWNER_MARKER_FORMAT, owners: ['dsh-foo'], digest: presetDigest(pristine) }))
    const edited = await makePreset('edited', { marker: { format: OWNER_MARKER_FORMAT, owners: ['dsh-foo'] } })
    await put(join(edited, OWNER_MARKER), JSON.stringify({ format: OWNER_MARKER_FORMAT, owners: ['dsh-foo'], digest: presetDigest(edited) }))
    await put(join(edited, 'agent.cordis.yml'), '- []' + nl + '# 用户自己的改动' + nl)

    const result = await cleanupOwnedPresets(undefined, 'dsh-foo', { root: presetRoot })
    assert.deepEqual(result.removed, ['pristine'])
    assert.equal(result.skipped.length, 1)
    assert.equal(result.skipped.length, 1)
    assert.equal(result.skipped[0].id, 'edited')
    assert.match(result.skipped[0].reason, /modified by the user/)
    assert.equal(await exists(pristine), false)
    assert.equal(await exists(edited), true)
  })

  it('不碰多 owner 与别人的预设', async () => {
    const shared = await makePreset('shared', { marker: { format: OWNER_MARKER_FORMAT, owners: ['dsh-foo', 'dsh-bar'] } })
    const other = await makePreset('other', { marker: { format: OWNER_MARKER_FORMAT, owners: ['dsh-bar'] } })
    const result = await cleanupOwnedPresets(undefined, 'dsh-foo', { root: presetRoot })
    assert.deepEqual(result.removed, [])
    assert.deepEqual(result.skipped, [])
    assert.equal(await exists(shared), true)
    assert.equal(await exists(other), true)
  })

  it('宿主 agentPresets 服务可用时经它删除（含 settings.default 清理），不直删目录', async () => {
    const dir = await makePreset('via-service', { marker: { format: OWNER_MARKER_FORMAT, owners: ['dsh-foo'] } })
    await put(join(dir, OWNER_MARKER), JSON.stringify({ format: OWNER_MARKER_FORMAT, owners: ['dsh-foo'], digest: presetDigest(dir) }))
    const removed = []
    const service = {
      list: () => [{ id: 'via-service', path: dir }],
      remove: (id) => {
        removed.push(id)
        // 官方服务会自己处理目录与默认预设；这里模拟它删掉目录。
        return rm(dir, { recursive: true, force: true })
      },
    }
    const ctx = { get: (name) => (name === 'agentPresets' ? service : undefined) }
    assert.equal(agentPresetsOf(ctx), service)
    const result = await cleanupOwnedPresets(ctx, 'dsh-foo', { root: presetRoot })
    assert.deepEqual([...result.removed], ['via-service'])
    assert.deepEqual(removed, ['via-service'])
    assert.equal(await exists(dir), false)
  })

  it('无宿主服务时直删，并把"默认预设可能还指着它"写进 notes（不再混进 skipped）', async () => {
    const dir = await makePreset('direct', { marker: { format: OWNER_MARKER_FORMAT, owners: ['dsh-foo'] } })
    await put(join(dir, OWNER_MARKER), JSON.stringify({ format: OWNER_MARKER_FORMAT, owners: ['dsh-foo'], digest: presetDigest(dir) }))
    const result = await cleanupOwnedPresets(undefined, 'dsh-foo', { root: presetRoot })
    assert.deepEqual([...result.removed], ['direct'])
    assert.deepEqual([...result.skipped], [])
    assert.equal(result.notes.length, 1)
    assert.match(result.notes[0], /without the host agentPresets service/)
    assert.equal(await exists(dir), false)
    assert.match(formatCleanupResult('dsh-foo', result), /preset cleanup for dsh-foo/)
  })

  it('插件还装在别的环境时不清理（预设是全局的）', async () => {
    const dir = await makePreset('global', { marker: { format: OWNER_MARKER_FORMAT, owners: ['dsh-foo'] } })
    await put(join(dir, OWNER_MARKER), JSON.stringify({ format: OWNER_MARKER_FORMAT, owners: ['dsh-foo'], digest: presetDigest(dir) }))
    const result = await cleanupOwnedPresets(undefined, 'dsh-foo', { root: presetRoot, stillInstalledElsewhere: true })
    assert.deepEqual(result.removed, [])
    assert.match(result.skipped[0].reason, /another environment/)
    assert.equal(await exists(dir), true)
  })
})

describe('归档与恢复（禁用 / 重新启用）', () => {
  it('禁用归档把预设移出用户根；用户改过的也一起归档（零损失）', async () => {
    const pristine = await makePreset('keep-mine', { marker: { format: OWNER_MARKER_FORMAT, owners: ['dsh-foo'] } })
    await put(join(pristine, OWNER_MARKER), JSON.stringify({ format: OWNER_MARKER_FORMAT, owners: ['dsh-foo'], digest: presetDigest(pristine) }))
    const edited = await makePreset('edited-one', { marker: { format: OWNER_MARKER_FORMAT, owners: ['dsh-foo'] } })
    await put(join(edited, OWNER_MARKER), JSON.stringify({ format: OWNER_MARKER_FORMAT, owners: ['dsh-foo'], digest: presetDigest(edited) }))
    await put(join(edited, 'agent.cordis.yml'), '- []' + nl + '# edited' + nl)
    await makePreset('not-mine', { marker: { format: OWNER_MARKER_FORMAT, owners: ['dsh-bar'] } })

    const result = await archiveOwnedPresets('dsh-foo', { root: presetRoot })
    assert.deepEqual([...result.moved].sort(), ['edited-one', 'keep-mine'])
    assert.equal(result.skipped.length, 0)
    assert.equal(await exists(pristine), false)
    assert.equal(await exists(edited), false)
    assert.equal(await exists(join(presetRoot, 'not-mine')), true)
    // 归档位置：<cacheRoot>/preset-archive/<plugin slug>/<id>
    const archiveRoot = join(presetArchiveDir(), 'dsh-foo')
    assert.equal(await exists(join(archiveRoot, 'keep-mine', 'agent.cordis.yml')), true)
    const archived = await readFile(join(archiveRoot, 'edited-one', 'agent.cordis.yml'), 'utf8')
    assert.match(archived, /# edited/)
    assert.match(formatArchiveResult('dsh-foo', result), /preset archive for dsh-foo/)
  })

  it('归档目标已存在时保留现场并报告', async () => {
    const dir = await makePreset('dup', { marker: { format: OWNER_MARKER_FORMAT, owners: ['dsh-foo'] } })
    await put(join(dir, OWNER_MARKER), JSON.stringify({ format: OWNER_MARKER_FORMAT, owners: ['dsh-foo'], digest: presetDigest(dir) }))
    const archiveRoot = join(presetArchiveDir(), 'dsh-foo', 'dup')
    await mkdir(archiveRoot, { recursive: true })
    const result = await archiveOwnedPresets('dsh-foo', { root: presetRoot })
    assert.deepEqual([...result.moved], [])
    assert.match(result.skipped[0].reason, /archived copy already exists/)
    assert.equal(await exists(dir), true)
  })

  it('恢复把归档移回用户根，同 id 冲突时保留归档并报告', async () => {
    const dir = await makePreset('restore-me', { marker: { format: OWNER_MARKER_FORMAT, owners: ['dsh-foo'] } })
    await put(join(dir, OWNER_MARKER), JSON.stringify({ format: OWNER_MARKER_FORMAT, owners: ['dsh-foo'], digest: presetDigest(dir) }))
    await archiveOwnedPresets('dsh-foo', { root: presetRoot })
    assert.equal(await exists(dir), false)

    const restored = await restoreArchivedPresets('dsh-foo', { root: presetRoot })
    assert.deepEqual([...restored.moved], ['restore-me'])
    assert.equal(await exists(join(dir, 'agent.cordis.yml')), true)
    assert.match(formatRestoreResult('dsh-foo', restored), /preset restore for dsh-foo/)

    // 再归档一次，然后在用户根造一个同 id 的预设：冲突必须保留归档。
    await archiveOwnedPresets('dsh-foo', { root: presetRoot })
    await mkdir(join(presetRoot, 'restore-me'), { recursive: true })
    await put(join(presetRoot, 'restore-me', 'agent.cordis.yml'), '- []' + nl)
    const conflicted = await restoreArchivedPresets('dsh-foo', { root: presetRoot })
    assert.deepEqual([...conflicted.moved], [])
    assert.match(conflicted.skipped[0].reason, /same-id preset already exists/)
    assert.equal(await exists(join(presetArchiveDir(), 'dsh-foo', 'restore-me')), true)
  })
})

describe('userPresetRoot / 环境判定 / 归属标记写入', () => {
  it('优先取官方 roster 里 trust 为 user 的根，拿不到时回落官方用户根', () => {
    const service = {
      list: () => [],
      remove: () => undefined,
      roots: [
        { path: '/system/presets', trust: 'system' },
        { path: '/user/presets', trust: 'user' },
      ],
    }
    assert.equal(userPresetRoot({ get: (name) => (name === 'agentPresets' ? service : undefined) }), '/user/presets')
    assert.equal(userPresetRoot(undefined), join(home, '.agent-presets'))
    assert.equal(agentPresetsOf({ get: () => ({ nope: true }) }), undefined)
  })

  it('pluginInstalledInOtherEnvironments 读其它环境的依赖声明', async () => {
    const profiles = join(home, 'profiles')
    await mkdir(join(profiles, 'web'), { recursive: true })
    await mkdir(join(profiles, 'headless'), { recursive: true })
    await mkdir(join(profiles, '.hidden'), { recursive: true })
    await put(join(profiles, 'headless', 'package.json'), JSON.stringify({ dependencies: { 'dsh-foo': '^1.0.0' } }))
    assert.equal(await pluginInstalledInOtherEnvironments('web', 'dsh-foo', profiles), true)
    assert.equal(await pluginInstalledInOtherEnvironments('headless', 'dsh-foo', profiles), false)
    assert.equal(await pluginInstalledInOtherEnvironments('web', 'dsh-bar', profiles), false)
    assert.equal(await pluginInstalledInOtherEnvironments('web', 'dsh-bar', join(home, 'nope')), false)
  })

  it('writeOwnerMarker 记录 digest，重复写不改动', async () => {
    const dir = await makePreset('marker-write')
    assert.equal(await writeOwnerMarker(dir, ['owner/repo', 'owner/repo']), true)
    const marker = JSON.parse(await readFile(join(dir, OWNER_MARKER), 'utf8'))
    assert.deepEqual(marker.owners, ['owner/repo'])
    assert.equal(marker.digest, presetDigest(dir))
    assert.equal(await writeOwnerMarker(dir, ['someone-else']), false)
    assert.equal(cacheRoot().startsWith(home), true)
  })
})

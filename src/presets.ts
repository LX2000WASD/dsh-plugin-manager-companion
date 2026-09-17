/**
 * 插件拥有的 agent 预设：归属标记、卸载清理、禁用归档 / 启用恢复。
 *
 * 归属：A 类·重写（读标记载录、移动与删除目录、经官方服务落刀；旧 src/presets.ts
 *   仅作意图参考，未复制代码）。
 * 旧实现参考：dsh-web-plugin-manager/src/presets.ts（385 行：中立标准标记
 *   .dsh-preset-owner.json = {format, owners[], digest}、兼容读取 dsh-agent-rp 的
 *   .dsh-agent-rp-owner.json 与 gamelike 的 .plugin-manage-owner.json、卸载只清
 *   "唯一 owner 且 digest 匹配"、禁用零损失归档、启用恢复）。
 * 官方复用：删除走 ctx.get("agentPresets").remove(id)——官方会同时清掉指向该预设的
 *   settings.default 并保留已挂载会话；本模块**绝不直接删官方 roster 里的目录**，
 *   只有在宿主服务不存在时（CLI/离线）才降级为带路径守卫的直删。
 *   目录枚举复用官方 roster 的 roots（ctx.get("agentPresets").roots），比"自己拼
 *   <dshHome>/.agent-presets"更贴近官方发现口径。
 * 前提检查：仍然成立——预设目录名是 preset id，不是所属插件名，所以卸载插件后
 *   预设会变成孤儿；官方明文不做这件事（"the manager cannot ... edit an agent
 *   preset composition"）。旧实现里"经宿主 settings 清 default"的部分已由官方
 *   remove() 承担，本模块不再自己写 settings。
 *
 * 为什么禁用只能归档不能删：官方对"坏预设"的判定只看组合文件是否可读/可解析，
 * 不反映"它引用的插件被禁用了"；拿不到"这个坏是我造成的"这个信号就没有安全删除
 * 的依据，何况临时禁用本来就不该毁数据。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  cacheRoot, isUnderRoot, presetsRoot, renameRetry, rmRetry,
  loadKindRecords, resolvedHome, type InstallOutcome,
} from './kinds.ts'
import { enqueueMutation, readEnvironmentManifest, type EnvironmentManifest } from './paths.ts'
import type { InstalledKind } from './types.ts'

/**
 * 中立标准归属标记文件名（本插件安装预设时写入；兼容读取生态标记见下）。
 *
 * 字面量在这里定义而不是从 kinds.ts 转口：kinds 与 presets 互相 import（kinds 安装时要
 * 写标记、presets 要读磁盘与路径工具），而 ESM 的循环依赖在**模块初始化期**取值会撞上
 * TDZ（Cannot access before initialization）。两边都只在函数体里引用对方，循环就是安全的。
 */
export const OWNER_MARKER = '.dsh-preset-owner.json'

/** 标记 schema 版本。 */
export const OWNER_MARKER_FORMAT = 0

/** 生态里其他工具写的标记（只读，不写）：文件名后缀匹配 owner.json。 */
const THIRD_PARTY_MARKER = /owner\.json$/i

/** 组合文件：digest 覆盖的范围（与 dsh-agent-rp 的既有协议一致）。 */
const DIGEST_FILES = ['agent.cordis.yml', 'preset.yml'] as const

/**
 * 禁用插件的预设归档目录。
 *
 * 必须在官方 user root **之外**（否则 roster 照样发现它），也必须在 profiles 根
 * 之外（否则会被当成一个环境）。放在我们的缓存目录下，与旧仓库同名同位置，
 * 两个包共存期间归档数据是同一份。
 *
 * @returns 归档根目录。
 */
export function presetArchiveDir(): string {
  return join(cacheRoot(), 'preset-archive')
}

/** 归档子目录：每个插件一个子目录，避免不同插件的同名预设互相打架。 */
function archiveDirFor(pluginName: string): string {
  return join(presetArchiveDir(), slug(pluginName))
}

/** 归档用的插件名 slug（目录名安全）。 */
function slug(name: string): string {
  const value = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return value === '' ? 'unknown-plugin' : value
}

/**
 * 计算预设目录的安装 digest。
 *
 * 方案沿用既有生态协议：按 DIGEST_FILES 逐个 update(文件名 + NUL + 内容 + NUL)，
 * 取 sha256。文件不存在就跳过（预设可以只有组合文件）；读取失败返回 null，
 * 语义是"无法核实"，由调用方按"可能被改过"处理（fail closed）。
 *
 * @param presetDir - 预设目录。
 * @returns 十六进制 digest；无法读取时为 null。
 */
export function presetDigest(presetDir: string): string | null {
  const hash = createHash('sha256')
  for (const file of DIGEST_FILES) {
    const path = join(presetDir, file)
    if (!existsSync(path)) continue
    try {
      hash.update(file)
      hash.update(String.fromCharCode(0))
      hash.update(readFileSync(path))
      hash.update(String.fromCharCode(0))
    } catch {
      return null
    }
  }
  return hash.digest('hex')
}

/** 把记录的 owner/owners 字段收敛为非空字符串数组。 */
function ownersOfRecord(value: unknown): string[] {
  if (typeof value === 'string') return value.length > 0 ? [value] : []
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return []
}

/** 读一个 JSON 文件；失败返回 null。 */
function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return null
  }
}

/** 目录项名列表；失败返回空数组。 */
function entriesOf(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * 读取一个预设目录声明的全部 owner（标准标记 + 生态既有标记）。
 *
 * 兼容三种形态：
 *   - 我们的标准标记 .dsh-preset-owner.json：{format: 0, owners: string[], digest}；
 *   - dsh-agent-rp 的 .dsh-agent-rp-owner.json：{owner, format: 0, digest}；
 *   - gamelike-plugin-manage 的 .plugin-manage-owner.json：{format, owners[]}（无 digest）。
 *
 * 失败策略是**不对称**的，这是刻意的：标准标记存在但损坏 → 整体返回空数组
 * （fail closed，什么都不删）；第三方标记损坏/format 不符 → 单个跳过（他们的写入
 * 端约束更松，用一条坏文件阻断全部清理不合理）。
 *
 * @param presetDir - 预设目录。
 * @returns owner 列表（去重、按发现顺序）。
 */
export function readPresetOwners(presetDir: string): string[] {
  const owners = new Set<string>()
  const marker = join(presetDir, OWNER_MARKER)
  if (existsSync(marker)) {
    const record = readJson(marker) as { format?: unknown; owner?: unknown; owners?: unknown } | null
    if (record === null || record.format !== OWNER_MARKER_FORMAT) return []
    for (const owner of [...ownersOfRecord(record.owners), ...ownersOfRecord(record.owner)]) owners.add(owner)
  }
  for (const file of entriesOf(presetDir)) {
    if (file === OWNER_MARKER || !THIRD_PARTY_MARKER.test(file)) continue
    const record = readJson(join(presetDir, file)) as { format?: unknown; owner?: unknown; owners?: unknown } | null
    if (record === null) continue
    // 带 format 的第三方标记（dsh-agent-rp 形态）必须匹配，不猜未来 schema。
    if (record.format !== undefined && record.format !== OWNER_MARKER_FORMAT) continue
    for (const owner of [...ownersOfRecord(record.owner), ...ownersOfRecord(record.owners)]) owners.add(owner)
  }
  return [...owners]
}

/** 标记里记录的 digest：标准标记优先，其次生态标记。 */
function recordedDigest(presetDir: string): string | null {
  const marker = join(presetDir, OWNER_MARKER)
  if (existsSync(marker)) {
    const record = readJson(marker) as { digest?: unknown } | null
    if (record !== null && typeof record.digest === 'string') return record.digest
    if (record !== null) return null
  }
  for (const file of entriesOf(presetDir)) {
    if (!THIRD_PARTY_MARKER.test(file)) continue
    const record = readJson(join(presetDir, file)) as { digest?: unknown } | null
    if (record !== null && typeof record.digest === 'string') return record.digest
  }
  return null
}

/** 一个预设目录（目录名即 preset id）。 */
export interface PresetEntry {
  /** preset id，等于目录名。 */
  readonly id: string
  /** 绝对路径。 */
  readonly dir: string
}

/**
 * 枚举一个根下的预设目录（跳过点目录与预设归档目录）。
 * @param root - 预设根目录。
 * @returns 预设条目；根不存在或不可读时返回空数组。
 */
export function scanPresets(root: string): PresetEntry[] {
  const found: PresetEntry[] = []
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    found.push({ id: entry.name, dir: join(root, entry.name) })
  }
  return found
}

/** 一个预设目录的归属判定。 */
export interface PresetOwnership {
  /** 这个预设的唯一 owner 是否就是给定插件。 */
  readonly owned: boolean
  /** 文件是否已不再匹配标记里的 digest（用户改过）。 */
  readonly modified: boolean
}

/**
 * 一个预设目录的归属判定。
 *
 * 只有**唯一 owner 且等于给定插件名**才叫 owned：多 owner 预设（两个插件的归属
 * 重叠）不做任何操作——一个 owner 的卸载不该带走另一个的数据。
 *
 * modified 的三种来源都算"用户改过"：digest 不匹配、标准标记损坏（fail closed）、
 * 无法读取组合文件（presetDigest 返回 null）。只有根本没有 digest 的生态标记
 * （gamelike 形态）报未修改——它没有可比对的基线。
 *
 * @param presetDir - 预设目录。
 * @param pluginName - 插件名（通常是包名）。
 * @returns 归属判定。
 */
export function presetOwnedBy(presetDir: string, pluginName: string): PresetOwnership {
  const owners = readPresetOwners(presetDir)
  if (owners.length !== 1 || owners[0] !== pluginName) return { owned: false, modified: false }
  const marker = join(presetDir, OWNER_MARKER)
  if (existsSync(marker) && readJson(marker) === null) return { owned: true, modified: true }
  const digest = recordedDigest(presetDir)
  if (digest === null) return { owned: true, modified: false }
  return { owned: true, modified: presetDigest(presetDir) !== digest }
}

/**
 * 官方 agentPresets 服务的结构式视图。
 *
 * 只声明我们真正调用的方法，不 import 官方类：官方包是 peer，小版本之间可能
 * 有增减，结构式引用让"官方少了一个方法"变成一次运行时检查而不是编译期断裂。
 */
export interface AgentPresetService {
  /** 列出全部预设。同步值或 Promise 都接受（官方是 async，测试替身常用同步）。 */
  list(): unknown
  remove(id: string): unknown
  /** 官方 roster 实际扫描的根（用户根在最后）。 */
  readonly roots?: readonly { readonly path: string; readonly trust: string }[]
}

/** 调用的返回值既可能是同步值也可能是 Promise；统一等待。 */
async function call<T>(value: unknown): Promise<T> {
  return await (value as Promise<T>)
}

/**
 * 取官方 agentPresets 服务（ctx 或服务本身都能传）。
 *
 * 传入的可以是 Cordis 的 Context（用 ctx.get 取服务），也可以是服务对象自己
 * （CLI 测试替身）。两者都不满足时返回 undefined——调用方据此降级为直删。
 *
 * @param source - Context 或服务对象。
 * @returns 服务视图；不可用时 undefined。
 */
export function agentPresetsOf(source: unknown): AgentPresetService | undefined {
  if (source === null || typeof source === 'undefined') return undefined
  const candidate = typeof (source as { get?: unknown }).get === 'function'
    ? (source as { get(name: string): unknown }).get('agentPresets')
    : source
  if (candidate === null || typeof candidate !== 'object') return undefined
  const service = candidate as Partial<AgentPresetService>
  if (typeof service.list !== 'function' || typeof service.remove !== 'function') return undefined
  return service as AgentPresetService
}

/**
 * 官方 roster 里 trust 为 user 的预设根；拿不到时退回 <dshHome>/.agent-presets。
 *
 * @param ctx - Context 或有 root 的服务对象。
 * @returns 用户预设根目录。
 */
export function userPresetRoot(ctx: unknown): string {
  const service = agentPresetsOf(ctx)
  const roots = service?.roots
  if (Array.isArray(roots)) {
    for (let index = roots.length - 1; index >= 0; index -= 1) {
      const root = roots[index]
      if (root !== undefined && root.trust === 'user' && typeof root.path === 'string') return root.path
    }
  }
  return presetsRoot()
}

/** 一次归属扫描的结果。 */
export interface PresetScanResult {
  /** 扫描的根。 */
  readonly root: string
  /** 每个预设目录及其归属判定。 */
  readonly entries: readonly { readonly id: string; readonly dir: string; readonly owners: readonly string[]; readonly owned: boolean; readonly modified: boolean }[]
}

/**
 * 扫描一个根下的全部预设及其归属。
 *
 * @param root - 预设根目录。
 * @param pluginName - 归属判定用的插件名。
 * @returns 扫描结果。
 */
export function scanPresetOwnership(root: string, pluginName: string): PresetScanResult {
  return {
    root,
    entries: scanPresets(root).map(entry => ({
      id: entry.id,
      dir: entry.dir,
      owners: readPresetOwners(entry.dir),
      owned: presetOwnedBy(entry.dir, pluginName).owned,
      modified: presetOwnedBy(entry.dir, pluginName).modified,
    })),
  }
}

/** 一次归属列举的结果。 */
export interface PresetOwnershipList {
  /** 我们安装记录里属于该插件的预设 id。 */
  readonly recorded: readonly string[]
  /** 磁盘上标记为属于该插件的预设 id（含手工放进去的）。 */
  readonly marked: readonly string[]
}

/**
 * 列出某插件拥有的预设：安装记录 + 磁盘标记两个来源合并。
 *
 * 两个来源都要看：记录可能被删（用户手工 rm 过），标记可能是别的工具写的。
 * 合并后去重，卸载与归档都要用这份清单。
 *
 * @param pluginName - 插件名（包名）。
 * @param root - 覆盖预设根（默认官方用户根）。
 * @returns 预设 id 清单。
 */
export async function listOwnedPresetIds(pluginName: string, root: string = presetsRoot()): Promise<PresetOwnershipList> {
  const recorded: string[] = []
  const records = await loadKindRecords()
  for (const [key, record] of records) {
    if (record.kind !== 'agent-preset') continue
    if (key !== pluginName.toLowerCase() && record.repo.toLowerCase() !== pluginName.toLowerCase()) continue
    const dir = record.dir
    if (dir !== root && existsSync(dir)) {
      const id = dir.split(/[\\/]+/).filter(Boolean).pop()
      if (id !== undefined && id !== '') recorded.push(id)
      continue
    }
    recorded.push(slug(record.repo))
  }
  const marked = scanPresets(root)
    .filter(entry => presetOwnedBy(entry.dir, pluginName).owned)
    .map(entry => entry.id)
  return { recorded: [...new Set(recorded)], marked: [...new Set(marked)] }
}

/** 一次清理的结果。 */
export interface PresetCleanupResult {
  /** 已删除的预设 id。 */
  readonly removed: readonly string[]
  /** 保留的预设及原因（用户改过、多 owner、越界、官方服务报错）。 */
  readonly skipped: readonly { readonly id: string; readonly reason: string }[]
  /**
   * 需要用户知道的附加事实，例如：没有宿主服务时只能直删目录，默认预设可能还指着被删的 id。
   * 刻意与 skipped 分开——同一个 id 不能既出现在 removed 又出现在 skipped 里。
   */
  readonly notes: readonly string[]
}

/** 一次归档/恢复的结果。 */
export interface PresetMoveResult {
  /** 已移动的预设 id。 */
  readonly moved: readonly string[]
  /** 未移动的预设及原因。 */
  readonly skipped: readonly { readonly id: string; readonly reason: string }[]
}

/** 把一条清理/移动结果里已经处理过的 id 汇总成可读句子。 */
function summarize(verb: string, ids: readonly string[], skipped: readonly { id: string; reason: string }[]): string {
  const parts: string[] = []
  if (ids.length > 0) parts.push(verb + ' ' + ids.join(', '))
  for (const skip of skipped) parts.push('kept ' + skip.id + ' (' + skip.reason + ')')
  return parts.length === 0 ? '' : parts.join('; ')
}

/** 清理结果的可读摘要（CLI/UI 输出用）。 */
export function formatCleanupResult(pluginName: string, result: PresetCleanupResult): string {
  const body = summarize('removed', result.removed, result.skipped)
  const notes = result.notes.length === 0 ? '' : ' [' + result.notes.join('; ') + ']'
  return (body === '' ? 'no owned presets found for ' + pluginName : 'preset cleanup for ' + pluginName + ': ' + body) + notes
}

/** 归档结果的可读摘要。 */
export function formatArchiveResult(pluginName: string, result: PresetMoveResult): string {
  const body = summarize('archived', result.moved, result.skipped)
  return body === '' ? 'no owned presets to archive for ' + pluginName : 'preset archive for ' + pluginName + ': ' + body
}

/** 恢复结果的可读摘要。 */
export function formatRestoreResult(pluginName: string, result: PresetMoveResult): string {
  const body = summarize('restored', result.moved, result.skipped)
  return body === '' ? 'no archived presets for ' + pluginName : 'preset restore for ' + pluginName + ': ' + body
}

/**
 * 卸载清理：删除"唯一 owner 是它且未被用户改过"的预设。
 *
 * 三条判定线，任一条不满足就保留并报告：
 *   - 多 owner：归属重叠，一个 owner 的卸载不该带走另一个的数据；
 *   - digest 不匹配（用户改过）：用户的编辑比插件的原版更有价值，交还给用户；
 *   - 路径越界：兜底防线，正常路径不会触发（目录来自 scanPresets）。
 *
 * 删除路径优先官方 agentPresets.remove(id)——它会同时清掉指向该预设的
 * settings.default，并让已挂载会话继续跑；只有在服务不存在时（CLI 无宿主）
 * 才降级为带守卫的直删，此时会多报告一条"宿主不可用，已直删；如需清理
 * 默认预设请在设置页确认"。
 *
 * @param ctx - Context 或官方服务对象；可为 undefined（CLI）。
 * @param pluginName - 被卸载的插件名。
 * @param options - 根覆盖与"是否还有别的环境装着它"。
 * @returns 清理结果。
 */
export async function cleanupOwnedPresets(
  ctx: unknown,
  pluginName: string,
  options: { readonly root?: string; readonly stillInstalledElsewhere?: boolean } = {},
): Promise<PresetCleanupResult> {
  const root = options.root ?? userPresetRoot(ctx)
  const removed: string[] = []
  const skipped: { id: string; reason: string }[] = []
  const notes: string[] = []
  if (options.stillInstalledElsewhere === true) {
    return {
      removed,
      skipped: [{ id: '*', reason: 'the plugin is still installed in another environment — presets are global and were left alone' }],
      notes,
    }
  }
  const service = agentPresetsOf(ctx)
  for (const { id, dir } of scanPresets(root)) {
    const verdict = presetOwnedBy(dir, pluginName)
    if (!verdict.owned) continue
    if (verdict.modified) {
      skipped.push({ id, reason: 'modified by the user (digest mismatch) — kept' })
      continue
    }
    if (!isUnderRoot(dir, root)) {
      skipped.push({ id, reason: 'outside the preset root — kept' })
      continue
    }
    try {
      if (service !== undefined) {
        await call(service.remove(id))
      } else {
        // 没有宿主服务（CLI/离线）：只能直删目录。官方 remove() 会顺手清掉指向该预设的
        // settings.default，这里做不到，因此把事实写进 notes 让用户自己确认。
        await rmRetry(dir)
        if (!notes.includes(DIRECT_REMOVAL_NOTE)) notes.push(DIRECT_REMOVAL_NOTE)
      }
      removed.push(id)
    } catch (error) {
      skipped.push({ id, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { removed, skipped, notes }
}

/** 直删路径的固定说明（同一个结果里只出现一次）。 */
const DIRECT_REMOVAL_NOTE = 'removed without the host agentPresets service; if a settings default pointed at one of these presets, clear it in the agent-preset settings page'

/**
 * 禁用归档：把该插件拥有的预设移出用户根，零数据损失。
 *
 * 与清理的关键差别：**不检查 digest**——用户改过的预设也一起归档。归档不是删除，
 * 数据一点没丢，只是从选择器里消失；禁用本来就是一个可逆动作，没有理由拿
 * "用户改过"当理由把它留在选择器里引用一个被禁用的插件。
 *
 * 目标位置已存在同名归档时保留现场并报告（覆盖等于扔掉上一份归档）。
 *
 * @param pluginName - 被禁用的插件名。
 * @param options - 根覆盖。
 * @returns 归档结果。
 */
export async function archiveOwnedPresets(
  pluginName: string,
  options: { readonly root?: string } = {},
): Promise<PresetMoveResult> {
  const root = options.root ?? presetsRoot()
  const archiveRoot = archiveDirFor(pluginName)
  const moved: string[] = []
  const skipped: { id: string; reason: string }[] = []
  return await enqueueMutation(async () => {
    for (const { id, dir } of scanPresets(root)) {
      if (!presetOwnedBy(dir, pluginName).owned) continue
      if (!isUnderRoot(dir, root)) {
        skipped.push({ id, reason: 'outside the preset root — kept' })
        continue
      }
      const target = join(archiveRoot, id)
      if (existsSync(target)) {
        skipped.push({ id, reason: 'an archived copy already exists — kept in place' })
        continue
      }
      try {
        await mkdir(archiveRoot, { recursive: true, mode: 0o700 })
        await renameRetry(dir, target)
        moved.push(id)
      } catch (error) {
        skipped.push({ id, reason: error instanceof Error ? error.message : String(error) })
      }
    }
    return { moved, skipped }
  })
}

/**
 * 启用恢复：把归档的预设移回用户根。
 *
 * 同名预设已经出现（用户新建了同 id 的预设，或另一个插件装了同名的）时**保留
 * 归档副本并报告**——让新的那份继续生效，不静默覆盖用户此刻正在用的东西。
 *
 * @param pluginName - 被重新启用的插件名。
 * @param options - 根覆盖。
 * @returns 恢复结果。
 */
export async function restoreArchivedPresets(
  pluginName: string,
  options: { readonly root?: string } = {},
): Promise<PresetMoveResult> {
  const root = options.root ?? presetsRoot()
  const archiveRoot = archiveDirFor(pluginName)
  const moved: string[] = []
  const skipped: { id: string; reason: string }[] = []
  return await enqueueMutation(async () => {
    for (const { id, dir } of scanPresets(archiveRoot)) {
      const target = join(root, id)
      if (existsSync(target)) {
        skipped.push({ id, reason: 'a same-id preset already exists — archived copy kept at ' + dir })
        continue
      }
      try {
        await mkdir(root, { recursive: true, mode: 0o700 })
        await renameRetry(dir, target)
        moved.push(id)
      } catch (error) {
        skipped.push({ id, reason: error instanceof Error ? error.message : String(error) })
      }
    }
    return { moved, skipped }
  })
}

/**
 * 写入中立标准归属标记。
 *
 * 已有标记就**不覆盖**：插件或别的工具可能已经声明过这个目录，覆盖等于篡改
 * 别人的归属（随后卸载会删掉不属于我们的东西）。digest 记录"刚装下去时是什么
 * 样子"，之后用户改了它，卸载就会跳过删除。
 *
 * @param presetDir - 预设目录。
 * @param owners - owner 列表（通常是仓库/插件名）。
 * @returns 是否真的写了（已存在时为 false）。
 */
export async function writeOwnerMarker(presetDir: string, owners: readonly string[]): Promise<boolean> {
  const marker = join(presetDir, OWNER_MARKER)
  if (existsSync(marker)) return false
  const digest = presetDigest(presetDir)
  const record: Record<string, unknown> = {
    format: OWNER_MARKER_FORMAT,
    owners: [...new Set(owners.filter(owner => owner.length > 0))],
  }
  if (digest !== null) record['digest'] = digest
  // 原子写：临时文件 + 改名。安装链路是并发的，半截标记会被读成损坏标记并让
  // 整个预设目录 fail closed（什么都不清），比不写更糟。
  const tmp = marker + '.' + String(process.pid) + '.tmp'
  await writeFile(tmp, JSON.stringify(record, undefined, 2) + String.fromCharCode(10), { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, marker)
  return true
}

/**
 * 从安装记录里取"这次安装落下去的预设目录"并写归属标记。
 *
 * installPreset 已经写过一次标记（它知道落地目录）；这个函数给"记录已存在但
 * 标记缺失"的补写路径用（例如旧包装的预设迁过来）。
 *
 * @param outcome - 直装结果。
 * @param pluginName - 归属插件名。
 * @returns 实际写了标记的目录数。
 */
export async function markInstalledPresets(outcome: InstallOutcome, pluginName: string): Promise<number> {
  let written = 0
  for (const dir of outcome.dirs) {
    if (await writeOwnerMarker(dir, [pluginName])) written += 1
  }
  return written
}

/**
 * 该插件是否还装在**别的环境**里。
 *
 * 预设是全局的（在 dshHome 下，不属于任何 profile），所以在一个环境里卸载插件
 * 不等于预设失去了主人。安装记录会写进环境的 package.json dependencies，因此
 * 依赖检查就是"它还在不在"的权威信号。
 *
 * @param currentEnvironment - 正在卸载的环境名（跳过它自己）。
 * @param pluginName - 插件包名。
 * @param profilesRootDir - profiles 根目录；默认取 dshHome()/profiles。
 * @returns 是否还有其他环境声明该依赖。
 */
export async function pluginInstalledInOtherEnvironments(
  currentEnvironment: string,
  pluginName: string,
  profilesRootDir?: string,
): Promise<boolean> {
  const { readdir } = await import('node:fs/promises')
  const root = profilesRootDir ?? join(resolvedHome(), 'profiles')
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return false
  }
  for (const name of names) {
    if (name === currentEnvironment || name.startsWith('.')) continue
    let manifest: EnvironmentManifest
    try {
      manifest = readEnvironmentManifest(join(root, name))
    } catch {
      // 读不了的环境不该阻断清理；当成"里面没有它"。
      continue
    }
    if (manifest.dependencies.includes(pluginName)) return true
  }
  return false
}

/** 一条预设安装记录的组装（供 kinds.ts 的调用点保持单一路径）。 */
export function presetKindRecord(repo: string, outcome: InstallOutcome, installedAt = new Date().toISOString()): InstalledKind {
  return {
    kind: 'agent-preset',
    repo,
    dir: outcome.dirs.length === 1 ? outcome.dirs[0]! : outcome.location,
    installedAt,
  }
}

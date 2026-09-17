/**
 * 安装会话状态机（awaiting-input）。
 *
 * 归属：A 类·重写（有状态、管生命周期；旧 src/installSession.ts 仅作意图参考，未复制代码）。
 * 旧实现参考：dsh-web-plugin-manager/src/installSession.ts（81 行：spec 为键、15 分钟 TTL、
 *   惰性清理、answers 按扫描白名单校验、__ 前缀内部键拒绝、spec 归一化防重扫）。
 * 官方复用：无（官方没有"安装暂停等输入"的概念）。
 * 前提检查：仍然成立——git 源插件需要凭据类变量时，安装必须暂停并把变量名交给
 *   用户，而不是静默失败或全量透传宿主 env。旧实现的会话只活在进程内，这一点
 *   必须保留并写清：CLI 每次调用是新进程，会话不跨进程，所以 CLI 提交 --env 时
 *   用**本次扫描**的白名单直接校验（显式提供即同意），不依赖会话存在。
 *
 * 会话里只存"允许注入哪些键"这一件事：值不存在会话里（用户提交时不落内存），
 * 因此即使会话泄漏也不会泄漏凭据。
 */

import { enqueueMutation } from './paths.ts'

/**
 * 一条安装会话。
 *
 * 键是归一化后的 spec（见 sessionKey）：同一 spec 同时只允许一个进行中的暂停安装。
 */
export interface InstallSession {
  /** 原始安装源 spec（npm 名 / git URL / 本地路径）。 */
  readonly spec: string
  /** 已就绪的仓库目录（克隆缓存或本地路径）。 */
  readonly repoDir: string
  /** 扫描白名单：只允许这些键被注入。 */
  readonly scanned: readonly string[]
  /** 创建时刻（epoch 毫秒）。 */
  readonly createdAt: number
}

/** 会话存活时长：超过后视为放弃；仓库缓存保留，可复用。 */
export const SESSION_TTL_MS = 15 * 60 * 1000

/** 进程内会话表。键为归一化 spec。 */
const sessions = new Map<string, InstallSession>()

/** 可注入的时钟（测试用它把 TTL 推到过去，而不必真的等待 15 分钟）。 */
let now: () => number = () => Date.now()

/**
 * 归一化 spec 作为会话键。
 *
 * 尾部斜杠与大小写都不能把一个安装拆成两个会话（旧仓库审计点：换个斜杠重提交
 * 会重建会话并重新扫描一遍）。
 *
 * @param spec - 原始安装源。
 * @returns 归一化后的键。
 */
export function sessionKey(spec: string): string {
  return spec.trim().replace(/\/+$/, '').toLowerCase()
}

/**
 * 创建一个会话（同 spec 已存在则覆盖），返回会话键。
 *
 * @param spec - 安装源。
 * @param repoDir - 已就绪的仓库目录。
 * @param scanned - 扫描得到的变量名白名单。
 * @returns 会话键（后续 get/drop 用同一归一化规则）。
 */
export function createInstallSession(spec: string, repoDir: string, scanned: readonly string[]): string {
  pruneExpiredSessions()
  const key = sessionKey(spec)
  sessions.set(key, { spec, repoDir, scanned: [...new Set(scanned)], createdAt: now() })
  return key
}

/**
 * 读一个会话。
 * @param spec - 安装源。
 * @returns 会话；不存在或已过期时为 undefined。
 */
export function getInstallSession(spec: string): InstallSession | undefined {
  pruneExpiredSessions()
  return sessions.get(sessionKey(spec))
}

/**
 * 丢弃一个会话（用户取消 / 安装继续后不再需要）。
 * @param spec - 安装源。
 * @returns 是否真的存在并被删除。
 */
export function dropInstallSession(spec: string): boolean {
  return sessions.delete(sessionKey(spec))
}

/**
 * 校验并过滤 answers。
 *
 * 三条规则，两条拒绝一条跳过：
 *   - 键必须 ∈ 白名单（这是防 PATH/HOME/NODE_OPTIONS/__proto__ 注入的全部依据）；
 *   - 键不得以双下划线开头（内部保留前缀，纯防御）；
 *   - 值为空字符串表示"我看到了但没提供"，跳过而不是注入空值。
 * 返回新对象，不修改传入的 answers。
 *
 * @param allowlist - 允许注入的键（本次扫描结果或会话白名单，两者等价）。
 * @param answers - 用户提交的键值对。
 * @returns 通过校验的子集。
 */
export function filterAnswers(
  allowlist: readonly string[],
  answers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (answers === undefined) return out
  const allowed = new Set(allowlist)
  for (const [key, value] of Object.entries(answers)) {
    if (key.startsWith('__')) continue
    if (!allowed.has(key)) continue
    if (typeof value !== 'string' || value.length === 0) continue
    out[key] = value
  }
  return out
}

/**
 * 惰性清理过期会话（每次访问顺带执行，不挂定时器）。
 *
 * 定时器会让插件在宿主里留下一个永不退出的句柄，而惰性清理的代价只是每次读
 * 多走一遍 Map——会话数量上限是"同时在途的暂停安装"，实践中为个位数。
 *
 * @returns 本次清掉的会话数。
 */
export function pruneExpiredSessions(): number {
  const cutoff = now() - SESSION_TTL_MS
  let removed = 0
  for (const [key, session] of sessions) {
    if (session.createdAt > cutoff) continue
    sessions.delete(key)
    removed += 1
  }
  return removed
}

/** 当前会话数（诊断与测试用）。 */
export function sessionCount(): number {
  return sessions.size
}

/**
 * 替换时钟（仅测试用）。
 *
 * 会话的 TTL 是 15 分钟，真等一遍不可能；用一个可注入的时钟把"过期"变成
 * 确定性事件。生产路径不调用它。
 *
 * @param clock - 返回 epoch 毫秒的函数。
 * @returns 把时钟恢复为 Date.now 的还原函数。
 */
export function __setClockForTests(clock: () => number): () => void {
  const previous = now
  now = clock
  return () => { now = previous }
}

/** 清空全部会话（测试用；返回被清掉的数量）。 */
export function __resetSessionsForTests(): number {
  const size = sessions.size
  sessions.clear()
  return size
}

/**
 * 把一次"需要用户输入"的安装挂到全局变更队列上。
 *
 * 存在的意义：会话创建与随后的安装是两步，中间可能有并发的第二个安装。
 * 走 paths.ts 的 enqueueMutation 让"读会话 → 解析 answers → 触发安装"整体串行，
 * 与环境的其他变更共享同一把进程内锁。
 *
 * @param task - 要在串行区里执行的工作。
 * @returns 任务结果。
 */
export function withInstallSession<T>(task: () => Promise<T>): Promise<T> {
  return enqueueMutation(task)
}

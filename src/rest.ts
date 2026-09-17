/**
 * 自有能力的传输层：REST 原语（信任围栏、请求体读取、响应信封、job 注册表）。
 *
 * 归属：A 类·重写（旧仓库把围栏、信封、job 全塞在 index.ts 里，2358 行；
 *   这里把它们抽成可独立测试的原语）。
 * 官方复用：ctx.webServer.register（官方公开路由 API，不经 typert 生成器）。
 * 前提检查：见 docs/DESIGN.md 第 11 节——官方 Remote 的能力集合是编译期固定的，
 *   第三方自带 Remote 需 typert 生成器，而其 npm 可用版本远落后于运行时。
 *   所以自有能力走 REST，官方能力仍走官方 Remote（客户端直连）。
 *
 * 安全模型（这层是 host 的唯一入口，必须自己扛）：
 *   1. 只接受 POST —— 浏览器同源 GET 会被 <img>/<script> 等载具触发，
 *      而 POST + JSON 需要预检，天然收紧。
 *   2. content-type 必须是 JSON —— 挡掉简单表单跨站提交。
 *   3. Host 必须是回环或显式白名单 —— 挡 DNS-rebinding（攻击者域名解析到 127.0.0.1）。
 *   4. Origin 存在时必须同源 —— 挡 CSRF。无 Origin 的非浏览器载体按本地语义放行，
 *      但此时必须同时满足"无 Origin 且非 cross-site"。
 */

import type { IncomingMessage, ServerResponse } from "node:http"

/** 自有 REST 的路由前缀。避开旧仓库的 /api2/plugin-manager（两包可能短期共存）。 */
export const ROUTE_PREFIX = "/api2/companion"

/** 默认请求体上限（字节）：普通操作。 */
export const BODY_LIMIT_DEFAULT = 1024 * 1024

/** 备份导入的请求体上限（字节）。 */
export const BODY_LIMIT_BACKUP = 16 * 1024 * 1024

/**
 * 按 op 名给出请求体上限。
 *
 * 分级而不是统一放宽：备份导入确实可能很大，但普通操作没有理由接受兆级 body，
 * 统一放宽等于把所有 op 的暴露面都放大。
 *
 * @param op - 操作名。
 * @returns 该 op 允许的最大请求体字节数。
 */
export function bodyLimitFor(op: string): number {
  return op === "backupRestore" ? BODY_LIMIT_BACKUP : BODY_LIMIT_DEFAULT
}

/** 成功信封。 */
export interface OkEnvelope<T> { readonly ok: true; readonly value: T }

/** 失败信封。code 是稳定机器码，message 面向用户。 */
export interface ErrEnvelope {
  readonly ok: false
  readonly error: { readonly code: string; readonly message: string }
}

/** 任意响应信封。 */
export type Envelope<T> = OkEnvelope<T> | ErrEnvelope

/**
 * 信任围栏：判断一个请求是否来自可信的同源浏览器上下文。
 *
 * 与旧实现的差别：旧版把"Host 回环判定 + Origin 同源"混在一个布尔里，且对
 * 非 HTTP 载体（无 Host 头）的处理是在补丁里加的。这里把规则写成可穷举测试的纯函数，
 * 并显式区分"有 Host"与"无 Host（非 HTTP 载体）"两种语义。
 *
 * @param req - 传入请求（只读其 headers）。
 * @param options - 可信 Host 白名单（不含端口）与是否允许非 HTTP 载体。
 * @returns 允许与否，以及拒绝时的机器码。
 */
export function isTrustedRequest(
  req: Pick<IncomingMessage, "headers" | "method">,
  options: { readonly trustedHosts?: readonly string[]; readonly allowNonHttpCarrier?: boolean } = {},
): { readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string } {
  const host = headerValue(req.headers["host"])
  const origin = headerValue(req.headers["origin"])

  // 非 HTTP 载体（第三方桌面壳 / app:// 自定义协议）：不带 Host 头。
  // 这类请求没有浏览器同源模型的保护，因此要求"无 Origin 且非 cross-site"。
  if (host === undefined) {
    if (options.allowNonHttpCarrier !== true) {
      return { ok: false, code: "untrusted-host", message: "request carries no Host header" }
    }
    if (crossSite(req.headers["sec-fetch-site"]) !== false) {
      return { ok: false, code: "cross-site", message: "cross-site request refused" }
    }
    return { ok: true }
  }

  const hostname = stripPort(host)
  if (!isLoopbackHost(hostname) && !(options.trustedHosts ?? []).includes(hostname)) {
    return { ok: false, code: "untrusted-host", message: "host is not loopback or allowlisted" }
  }

  if (origin !== undefined) {
    let originHost: string
    try {
      originHost = new URL(origin).host
    } catch {
      return { ok: false, code: "bad-origin", message: "Origin is not a valid URL" }
    }
    if (originHost !== host) {
      return { ok: false, code: "cross-origin", message: "Origin does not match Host" }
    }
  }
  return { ok: true }
}

/** 取首值：node 的 header 可能是数组。 */
function headerValue(raw: string | readonly string[] | undefined): string | undefined {
  if (raw === undefined) return undefined
  return Array.isArray(raw) ? raw[0] : (raw as string)
}

/** 去掉 Host 里的端口（IPv6 字面量的方括号保留处理）。 */
function stripPort(host: string): string {
  // IPv6 字面量形如 [::1]:3080 —— 先处理方括号形式，避免把 ::1 里的冒号当端口分隔符。
  if (host.startsWith("[")) {
    const close = host.indexOf("]")
    return close === -1 ? host : host.slice(1, close)
  }
  const colon = host.lastIndexOf(":")
  return colon === -1 ? host : host.slice(0, colon)
}

/** 回环判定：IPv4 回环段、IPv6 回环、localhost。 */
function isLoopbackHost(hostname: string): boolean {
  if (hostname === "localhost") return true
  if (hostname === "::1" || hostname === "0:0:0:0:0:0:0:1") return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  if (v4 === null) return false
  const first = Number(v4[1])
  // 严格说整个 127/8 都是回环；实践中 127.0.0.1 与 127.x.y.z 都要放行。
  return first === 127
}

/**
 * sec-fetch-site 判定：明确为 cross-site 时返回 true，其它（含缺失）返回 false。
 *
 * 缺失时判 false 是刻意的：非浏览器载体不带这个头，把它当 cross-site 会让
 * 合法载体被拒（旧仓库 issue #11）。真正的防跨站由 Origin/Host 规则承担。
 */
function crossSite(raw: string | readonly string[] | undefined): boolean {
  return headerValue(raw)?.toLowerCase() === "cross-site"
}

/** 判定请求是否是一个可接受的 JSON POST。 */
export function isJsonPost(req: Pick<IncomingMessage, "headers" | "method">): boolean {
  if (req.method !== "POST") return false
  const contentType = headerValue(req.headers["content-type"]) ?? ""
  return contentType.split(";")[0]!.trim().toLowerCase() === "application/json"
}

/**
 * 读取并解析 JSON 请求体，带硬上限。
 *
 * 上限在**读取过程中**生效（超出即停止累积并拒绝），而不是先读完再判断长度——
 * 后者对超大 body 毫无保护。
 *
 * @param req - 传入请求。
 * @param limit - 允许的最大字节数。
 * @returns 解析结果；失败时给出机器码。
 */
export async function readJsonBody<T = Record<string, unknown>>(
  req: AsyncIterable<Buffer | string>,
  limit: number,
): Promise<{ ok: true; value: T } | { ok: false; code: string; message: string }> {
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of req) {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk
      size += buf.byteLength
      if (size > limit) {
        return { ok: false, code: "body-too-large", message: `request body exceeds ${String(limit)} bytes` }
      }
      chunks.push(buf)
    }
  } catch (error) {
    return { ok: false, code: "body-read-failed", message: error instanceof Error ? error.message : String(error) }
  }
  const text = Buffer.concat(chunks).toString("utf8").trim()
  if (text === "") return { ok: true, value: {} as T }
  try {
    return { ok: true, value: JSON.parse(text) as T }
  } catch (error) {
    return { ok: false, code: "bad-json", message: error instanceof Error ? error.message : String(error) }
  }
}

/** 写一个 JSON 响应（含状态码）。 */
export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  res.end(body)
}

// ── job 注册表 ───────────────────────────────────────────────────────────

/**
 * 一个在途长操作。
 *
 * 为什么需要 job：诊断全量、批量恢复、跨环境 pnpm 都可能跑几十秒到几分钟。
 * HTTP 请求挂那么久会先被客户端或中间层掐断，而服务端状态仍在推进——客户端
 * 于是"看不到结果但操作已生效"，这是最难排查的失败形态。
 */
interface JobRecord {
  readonly startedAt: number
  done: boolean
  result?: unknown
  error?: string
}

/** job 结果保留时长（毫秒）。与旧仓库一致的 30 分钟。 */
export const JOB_TTL_MS = 30 * 60 * 1000

/** 同时在途的 job 上限。超出即背压拒绝，避免堆叠点击打爆进程。 */
export const JOB_MAX_PENDING = 4

/** job 注册表（进程内）。 */
export class JobRegistry {
  private readonly jobs = new Map<string, JobRecord>()
  private seq = 0

  /**
   * 启动一个 job。
   * @param task - 要执行的工作。
   * @returns job id。
   * @throws {Error} 在途数量达到上限时（调用方应回 429）。
   */
  start(task: () => Promise<unknown>): string {
    this.prune()
    const pending = [...this.jobs.values()].filter(job => !job.done).length
    if (pending >= JOB_MAX_PENDING) {
      throw new Error(`too many operations in flight (${String(pending)}); wait for one to finish`)
    }
    this.seq += 1
    const id = `${Date.now().toString(36)}-${this.seq.toString(36)}`
    const record: JobRecord = { startedAt: Date.now(), done: false }
    this.jobs.set(id, record)
    // 结果与错误都落进 record：调用方只通过 job op 读，避免"谁先到"的竞态。
    void task().then(
      (value) => { record.result = value; record.done = true },
      (error: unknown) => { record.error = error instanceof Error ? error.message : String(error); record.done = true },
    )
    return id
  }

  /**
   * 读一个 job 的状态。
   * @param id - job id。
   * @returns 状态；id 不存在（或已过期）时 `missing: true`。
   */
  status(id: string): { done: boolean; result?: unknown; error?: string; missing?: true } {
    this.prune()
    const record = this.jobs.get(id)
    if (record === undefined) return { done: true, missing: true }
    return {
      done: record.done,
      ...record.result === undefined ? {} : { result: record.result },
      ...record.error === undefined ? {} : { error: record.error },
    }
  }

  /** 清掉超过 TTL 的记录。 */
  private prune(): void {
    const cutoff = Date.now() - JOB_TTL_MS
    for (const [id, record] of this.jobs) {
      if (record.startedAt < cutoff) this.jobs.delete(id)
    }
  }
}

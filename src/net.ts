/**
 * net.ts — 市场索引的出网层：超时、代理（HTTP_PROXY/HTTPS_PROXY/NO_PROXY）与可注入的抓取器。
 *
 * 归属：A 类·重写（旧 src/net.ts 仅作意图参考，未复制代码）。
 * 旧实现参考：dsh-web-plugin-manager/src/net.ts（理解意图用，未复制代码）——它解决了两个
 *   真实问题：Node 全局 fetch 不认识 undici 的 dispatcher（要带代理就必须直接调 undici），
 *   以及"只设超时会覆盖调用方传入的 signal"导致取消请求失效。
 * 官方复用：无。官方 host 面不提供通用出网抓取（ctx.* 里没有这类能力），社区索引只能自己直连；
 *   本模块只依赖 package.json 已声明的 undici。
 * 前提检查：旧实现有三个隐含前提，重推后都改了：
 *   1) 超时写死 15s —— 本插件把它做成**用户配置**（settings.marketplace.timeoutMs），故改为入参；
 *   2) 代理 agent 缓存曾经无上限（旧代码后补 MAX_AGENTS，说明当初确实泄漏）——这里从一开始就有
 *      上界，并提供显式关闭（测试与插件卸载用）；
 *   3) NO_PROXY 的匹配规则（通配 / 后缀 / 端口 / IPv6 字面量）从未被单测覆盖——抽成纯函数
 *      noProxyMatches()，由 tests/marketplace.test.mjs 直接断言。
 *
 * 本模块是**唯一**允许 import undici 的地方；其余模块只依赖这里导出的 `Fetcher` 契约，
 * 因此整条市场管道可以在无网络、无代理的环境里用假 fetcher 完整驱动（tests 就是这么做的）。
 */

import { ProxyAgent, fetch as undiciFetch } from 'undici'

/** 默认请求超时；调用方通常传 settings.marketplace.timeoutMs。 */
export const DEFAULT_TIMEOUT_MS = 15_000

/** 缓存的代理 agent 上界（代理环境变量变化很少，越界时关闭最旧的一个）。 */
export const MAX_PROXY_AGENTS = 8

/**
 * 响应侧的最小结构契约。
 *
 * 不直接用 undici 的 Response 类型当签名：测试里的假 fetcher 只需要实现这几个方法，
 * 而结构式契约把"我们真正用到的东西"写清楚（也避免把 undici 类型扩散到别的模块）。
 */
export interface HttpResponseLike {
  readonly ok: boolean
  readonly status: number
  arrayBuffer(): Promise<ArrayBuffer>
  text(): Promise<string>
}

/** 一次抓取的入参。 */
export interface FetchOptions {
  /** 单次请求超时（毫秒）。 */
  readonly timeoutMs?: number
  readonly headers?: Readonly<Record<string, string>>
  /** 调用方的取消信号；与超时信号**合并**，不互相覆盖。 */
  readonly signal?: AbortSignal
}

/**
 * 抓取器签名：市场管道唯一的外部依赖。
 *
 * 默认实现是本模块的 {@link fetchWithProxy}；测试可注入假实现，
 * 于是"五级索引兜底链 + 磁盘缓存回退"能在无网络条件下逐跳断言。
 */
export type Fetcher = (url: string, options: FetchOptions) => Promise<HttpResponseLike>

/**
 * NO_PROXY 是否覆盖该主机（纯函数，便于单测）。
 *
 * 规则与 curl/undici 生态一致：
 * - `*` 匹配一切；
 * - 逗号分隔，逐项去空白，空项忽略；
 * - 每一项可带端口（`host:port`），端口被忽略（我们只按主机名判断）；
 * - IPv6 字面量写作 `[::1]:port`，取方括号内内容；
 * - 支持前导点（`.example.com`）与裸域名的后缀匹配，以及完全相等匹配。
 *
 * 注意：不做通配符（`*.example.com` 里的 `*`）展开——NO_PROXY 的通行约定里
 * 只有单独的 `*` 是通配；把它当通配前缀会让 `*.corp` 静默变成后缀匹配，
 * 看起来"能用"，实际覆盖范围与用户预期不同。这里选择只认精确后缀，宁可少放过。
 *
 * @param hostname - 目标主机名（`new URL(url).hostname`，IPv6 自带方括号）。
 * @param raw - NO_PROXY 原始值；undefined 表示未设置。
 * @returns 命中即 true（该请求绕过代理）。
 */
export function noProxyMatches(hostname: string, raw: string | undefined): boolean {
  if (raw === undefined || raw.length === 0) return false
  // 两侧都剥掉 IPv6 的方括号：`new URL('http://[::1]/').hostname` 带括号，而 NO_PROXY 里
  // 通常不写；只剥一侧会让 IPv6 的 NO_PROXY 配置静默失效。
  const host = stripBrackets(hostname.trim().toLowerCase())
  if (host.length === 0) return false
  for (const entry of raw.split(',')) {
    const token = entry.trim().toLowerCase()
    if (token.length === 0) continue
    if (token === '*') return true
    const bare = stripBrackets(token.startsWith('[')
      ? token.slice(1, token.indexOf(']') === -1 ? undefined : token.indexOf(']'))
      : token.split(':')[0]!)
    const suffix = bare.startsWith('.') ? bare.slice(1) : bare
    if (suffix.length === 0) continue
    if (host === suffix || host.endsWith('.' + suffix)) return true
  }
  return false
}

/** 剥掉 IPv6 字面量的方括号（`[::1]` → `::1`；非方括号输入原样返回）。 */
function stripBrackets(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
}

/**
 * 该 URL 应使用的代理地址，null 表示直连。
 *
 * 大小写两种环境变量名都认（`HTTPS_PROXY` 优先于 `https_proxy`），与旧实现一致；
 * ALL_PROXY 故意不支持——本插件的配置面只承诺这两个（见 settings.ts）。
 *
 * @param url - 目标 URL。
 * @param env - 环境变量来源，默认 process.env（测试可注入）。
 * @returns 代理 URL 原文；URL 非法、无代理或 NO_PROXY 命中时返回 null。
 */
export function proxyUrlFor(url: string, env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const secure = parsed.protocol === 'https:'
  const raw = secure
    ? env['HTTPS_PROXY'] ?? env['https_proxy']
    : env['HTTP_PROXY'] ?? env['http_proxy']
  if (raw === undefined || raw.trim().length === 0) return null
  if (noProxyMatches(parsed.hostname, env['NO_PROXY'] ?? env['no_proxy'])) return null
  return raw
}

/** 缓存的代理 agent：key 是代理 URL。 */
const agents = new Map<string, ProxyAgent>()

/**
 * 取（或建）一个代理 agent。
 *
 * 上界 {@link MAX_PROXY_AGENTS}：越界时关闭并丢弃最旧的一个。旧实现没有上界，
 * 是后来补的——这里把它当成初始约束而不是补丁。
 *
 * @param proxyUrl - 代理地址（来自 {@link proxyUrlFor}）。
 * @returns 该代理对应的 agent。
 */
export function proxyAgentFor(proxyUrl: string): ProxyAgent {
  let agent = agents.get(proxyUrl)
  if (agent === undefined) {
    agent = new ProxyAgent(proxyUrl)
    agents.set(proxyUrl, agent)
  }
  while (agents.size > MAX_PROXY_AGENTS) {
    const oldest = agents.keys().next().value
    if (oldest === undefined) break
    if (oldest === proxyUrl) break // 极端情况下别把刚建的关掉
    agents.get(oldest)?.close()
    agents.delete(oldest)
  }
  return agent
}

/**
 * 关闭并清空所有缓存的代理 agent（测试收尾 / 插件卸载）。
 *
 * 不关会留下占着 socket 的 agent：Cordis 热重载时旧实例的 agent 不会被 GC 回收。
 */
export function closeProxyAgents(): void {
  for (const agent of agents.values()) agent.close()
  agents.clear()
}

/**
 * 带超时与代理的抓取。
 *
 * 超时通过 `AbortSignal.timeout` 实现，并与调用方 signal **合并**（`AbortSignal.any`）：
 * 旧实现用赋值覆盖，导致调用方一旦传了 signal，超时保护就完全消失。
 *
 * @param url - 目标 URL。
 * @param options - 超时 / 头部 / 取消信号。
 * @returns 响应（结构式契约）。
 */
export async function fetchWithProxy(url: string, options: FetchOptions = {}): Promise<HttpResponseLike> {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timeoutSignal = AbortSignal.timeout(timeout)
  const signal = options.signal === undefined
    ? timeoutSignal
    : AbortSignal.any([options.signal, timeoutSignal])
  const proxy = proxyUrlFor(url)
  const response = await undiciFetch(url, {
    method: 'GET',
    headers: options.headers === undefined ? undefined : { ...options.headers },
    signal,
    redirect: 'follow',
    ...(proxy === null ? {} : { dispatcher: proxyAgentFor(proxy) }),
  })
  return response as unknown as HttpResponseLike
}

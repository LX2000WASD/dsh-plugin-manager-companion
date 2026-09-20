/**
 * 依赖兜底目录（官方 `healProfilesModuleFallback` 维护的 `$DSH_HOME/profiles/node_modules`）的陈旧链接诊断。
 *
 * 归属：B 类·诊断层的一层（依赖层的一个子检查），不是新的机制。
 *
 * ## 这个目录是什么（官方语义，实测核对过）
 *
 * 官方 `@deepseek-ai/dsh-app-boot` 的 `healProfilesModuleFallback` 把**当前 dsh 安装的依赖闭包**
 * 铺成一层符号链接，供所有 profile 共享解析。`materialize: false` 时它只算出闭包、不写盘。
 *
 * ## 为什么会出现陈旧链接（两个事实叠起来）
 *
 * 1. **共享层只增不删**：判据是 `moduleFallbackCurrent = entries.every(...)`——只问"该有的到位没"，
 *    不问"有没有多出来的"；写入路径 `healProfilesModuleFallbackLocked` 只遍历 entries，
 *    **没有 readdir / 没有 unlink**。所以旧代际留下的链接不会被新代际清掉。
 * 2. **0.1.6-alpha.2 默认根本不写这个目录**：默认 `resolutionMode = "runtime"`，
 *    runtime 走 `createProfileResolutionGeneration`（`materialize: false`）。
 *    用全新临时 HOME 起实例实测：链接数 **0**。
 *
 * 于是现存链接是**旧版本时代写下的残骸**，而且它们**已不参与解析**——
 * 这不是解析缺陷，是磁盘上的过期产物。
 *
 * ## 三分类（本模块的判据）
 *
 * - **dangling（断链）**：`lstatSync().isSymbolicLink()` 为真但目标不存在。旧代际的 pnpm 目录被删了。
 * - **stale（完好但过时）**：目标存在，但不在**当前安装闭包**里。
 * - **current（正常）**：目标存在且在闭包里。
 *
 * 闭包从哪来：`healProfilesModuleFallback({ installAnchor, materialize: false })`——复用官方实现，
 * 不自己复刻一遍依赖遍历（复刻就会与官方漂移）。
 *
 * ⚠ **锚点必须先 realpath**：传 `node_modules/@deepseek-ai/dsh/package.json` 这种**符号链接路径**时，
 * `createRequire` 的 `resolve.paths` 会从链接所在层开始找，闭包只剩 1 条（实测）；
 * 传 realpath 才有完整的 463 条。这是本模块最容易静默错的地方，所以单独有测试钉住。
 */

import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

/** 一条兜底链接的分类。 */
export type ModuleFallbackLinkKind = 'dangling' | 'stale' | 'current'

/** 扫出来的一条链接。 */
export interface ModuleFallbackLink {
  /** 包名（scope 包是 `@scope/name`）。 */
  readonly name: string
  /** 链接的绝对路径。 */
  readonly path: string
  /** 分类。 */
  readonly kind: ModuleFallbackLinkKind
  /** 链接指向的原始目标（`readlinkSync` 原文；读不到时 undefined）。 */
  readonly target?: string
}

/** 一次扫描的完整结果。 */
export interface ModuleFallbackScan {
  /** 被扫的目录（`$DSH_HOME/profiles/node_modules`）。 */
  readonly dir: string
  /** 目录是否存在。不存在时三类都是空，且 `scanned` 为 false。 */
  readonly exists: boolean
  /** 是否真的扫过（目录不存在、或闭包算不出来时为 false）。 */
  readonly scanned: boolean
  /** 闭包算不出来时的原因（面向用户）。 */
  readonly closureReason?: string
  /** 当前安装闭包里的包名（排序后）。 */
  readonly closure: readonly string[]
  /** 断链。 */
  readonly dangling: readonly ModuleFallbackLink[]
  /** 完好但过时。 */
  readonly stale: readonly ModuleFallbackLink[]
  /** 正常。 */
  readonly current: readonly ModuleFallbackLink[]
  /** 目录里的符号链接总数（含 scope 一层）。 */
  readonly total: number
}

/**
 * 官方兜底目录的路径。
 *
 * @param home - DSH home（`$DSH_HOME`）。
 * @returns `<home>/profiles/node_modules`。
 */
export function moduleFallbackDir(home: string): string {
  return join(home, 'profiles', 'node_modules')
}

/**
 * 列出目录里的符号链接（含 scope 一层）。
 *
 * 只认符号链接：scope 目录本身是**真目录**（官方 `mkdirSync(dirname(link))` 建的），
 * 不是链接。**绝不递归**——这里只列一层，扫不到任何需要删目录的东西。
 *
 * @param dir - 被扫目录。
 * @returns 链接名（scope 包为 `@scope/name`）。
 */
export function listModuleFallbackLinks(dir: string): { readonly name: string; readonly path: string; readonly target?: string }[] {
  const out: { name: string; path: string; target?: string }[] = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      let target: string | undefined
      try {
        target = readlinkSync(path)
      } catch {
        // 读不到链接目标：照样报出来，只是没有 target 可显示。
      }
      out.push({ name: entry.name, path, ...(target === undefined ? {} : { target }) })
      continue
    }
    // scope 目录（@scope）：真目录，里面才是链接。只下探这一层。
    if (entry.isDirectory() && entry.name.startsWith('@')) {
      let children
      try {
        children = readdirSync(path, { withFileTypes: true })
      } catch {
        continue
      }
      for (const child of children) {
        if (!child.isSymbolicLink()) continue
        const childPath = join(path, child.name)
        let target: string | undefined
        try {
          target = readlinkSync(childPath)
        } catch {
          // 同上。
        }
        out.push({ name: entry.name + '/' + child.name, path: childPath, ...(target === undefined ? {} : { target }) })
      }
    }
  }
  return out
}

/**
 * 算出当前 dsh 安装的依赖闭包（复用官方实现，只读）。
 *
 * 为什么不自己遍历依赖：官方的闭包口径包含 `dependencies` + `peerDependencies`、
 * 逐层解析、跳过已访问——复刻一份就是给自己留一个"与官方漂移"的口子。
 * `materialize: false` 实测不写盘（本模块有测试钉住这件事）。
 *
 * @param installAnchor - 启动这个环境的 dsh 安装锚点（官方 `ProfileContext.installAnchor`）。
 * @param home - DSH home。官方签名要求传它；`materialize: false` 下它只用于拼返回值里的路径，
 *   不写盘（本模块有测试钉住「传一个不存在的 home 也不会创建它」）。
 * @returns 闭包包名集合；算不出来时 `{ ok: false, reason }`。
 */
export async function readModuleFallbackClosure(
  installAnchor: string | undefined,
  home: string,
): Promise<{ readonly ok: true; readonly names: ReadonlySet<string> } | { readonly ok: false; readonly reason: string }> {
  if (installAnchor === undefined || installAnchor.length === 0) {
    return { ok: false, reason: '没有安装锚点（官方 ProfileContext.installAnchor），算不出当前安装的依赖闭包' }
  }
  // 锚点必须解析到真实路径：官方实现用 createRequire(anchor).resolve.paths 逐层向上找，
  // 而 pnpm 的 node_modules/<scope>/<name> 是**符号链接**，从链接所在层开始找会找不到兄弟依赖，
  // 闭包因此只剩锚点自己那一条（实测 463 → 1）。这是静默错，必须在这里挡住。
  let resolved = installAnchor
  try {
    resolved = realpathSync(installAnchor)
  } catch {
    // realpath 失败：仍按原锚点试一次，失败会如实报原因。
  }
  try {
    const boot = await import('@deepseek-ai/dsh-app-boot')
    const closure = await boot.healProfilesModuleFallback({
      installAnchor: resolved,
      home,
      materialize: false,
    })
    const names = new Set(closure.entries.map(entry => entry.name))
    if (names.size === 0) {
      return { ok: false, reason: '官方闭包算法没有返回任何包（锚点 ' + resolved + ' 可能不是 dsh 安装）' }
    }
    return { ok: true, names }
  } catch (error) {
    return { ok: false, reason: '官方闭包算法不可用：' + (error instanceof Error ? error.message : String(error)) }
  }
}

/**
 * 扫一遍依赖兜底目录，逐条分类。
 *
 * 目录不存在时**不是"没问题"**：`scanned: false`，调用方据此记 skipped（避免画成"查过且干净"）。
 *
 * ## 闭包算不出来时照样扫（只放弃"过时"这一类）
 *
 * **断链的判据是"链接目标在不在"，与闭包无关**——没有闭包也能一条不落地找出来。
 * 所以闭包不可用时：`dangling` 照常产出、`scanned` 仍为 true，只是 `stale` 为空
 * 且带上 `closureReason`（调用方据此说明"这一类这次没查"）。
 * 早先的实现在闭包失败时整份返回空——那会把**能查的断链也一起丢掉**，
 * 而断链正是本功能要自动清理的那一类。
 *
 * @param dir - 兜底目录。
 * @param closure - 当前安装闭包（`readModuleFallbackClosure` 的结果）。
 * @returns 扫描结果。
 */
export function scanModuleFallback(
  dir: string,
  closure: { readonly ok: true; readonly names: ReadonlySet<string> } | { readonly ok: false; readonly reason: string },
): ModuleFallbackScan {
  const empty = {
    dir, exists: false, scanned: false, closure: [] as string[],
    dangling: [] as ModuleFallbackLink[], stale: [] as ModuleFallbackLink[], current: [] as ModuleFallbackLink[],
    total: 0,
  }
  if (!existsSync(dir)) return empty
  const dangling: ModuleFallbackLink[] = []
  const stale: ModuleFallbackLink[] = []
  const current: ModuleFallbackLink[] = []
  // total 必须**独立计数**，不能用三类之和：闭包算不出来时，目标存在的那些既不是 dangling、
  // 也进不了 stale/current，用求和会漏报（实测：目录里 1 条链接，total 报 0——
  // 那等于告诉用户「这个目录是空的」，而它明明有一条）。
  let total = 0
  for (const link of listModuleFallbackLinks(dir)) {
    total += 1
    const base = { name: link.name, path: link.path, ...(link.target === undefined ? {} : { target: link.target }) }
    // 判据 1：目标在不在（与闭包无关，任何情况下都能判）。
    if (!existsSync(link.path)) {
      dangling.push({ ...base, kind: 'dangling' })
      continue
    }
    // 判据 2：在不在当前闭包里。闭包算不出来时**不猜**：这一条既不进 stale 也不进 current，
    // 但它**已经被扫到了**，所以要算进 total。
    if (!closure.ok) continue
    if (closure.names.has(link.name)) current.push({ ...base, kind: 'current' })
    else stale.push({ ...base, kind: 'stale' })
  }
  return {
    dir,
    exists: true,
    scanned: true,
    closure: closure.ok ? [...closure.names].sort() : [],
    ...(closure.ok ? {} : { closureReason: closure.reason }),
    dangling,
    stale,
    current,
    total,
  }
}

/** 一次清理的结果。 */
export interface ModuleFallbackCleanup {
  /** 实际删掉的条数。 */
  readonly removed: number
  /** 删掉的链接（名字 + 目标）。 */
  readonly removedLinks: readonly ModuleFallbackLink[]
  /** 跳过的条数。 */
  readonly skipped: number
  /** 跳过原因（逐条，面向用户）。 */
  readonly skipReasons: readonly string[]
  /** 删除失败的条数。 */
  readonly failed: number
  /** 失败原因（逐条）。 */
  readonly failures: readonly string[]
}

/**
 * 删掉断链（**只删断链**，完好但过时的一律不动）。
 *
 * 纪律（三条，缺一不可）：
 * 1. **只删符号链接**：每条都先 `lstatSync().isSymbolicLink()` 确认。`lstat` 不跟随链接，
 *    所以这条确认的是"这个条目本身是链接"，不是"它指向的东西是链接"。
 *    **绝不递归删目录**——即使目录看起来是空的、即使它叫 `node_modules`。
 * 2. **逐条重核**：扫描到删除之间目录可能被别的进程动过，所以删除前**重新**判一次断链，
 *    判据不成立就跳过并说明（不做"按扫描结果批量 rm"这种会误删的动作）。
 * 3. **结果如实**：删了几条、跳过几条、为什么跳过、哪几条失败，逐条报出来。
 *
 * @param dir - 兜底目录。
 * @param scan - 上一次扫描的结果（用它的 dangling 清单作为候选）。
 * @param remove - 删除函数（注入以便测试；生产路径用 `unlinkSync`）。
 * @returns 清理结果。
 */
export function cleanupDanglingLinks(
  dir: string,
  scan: ModuleFallbackScan,
  remove: (path: string) => void,
): ModuleFallbackCleanup {
  const removedLinks: ModuleFallbackLink[] = []
  const skipReasons: string[] = []
  const failures: string[] = []
  for (const link of scan.dangling) {
    const path = join(dir, link.name)
    let stat
    try {
      stat = lstatSync(path)
    } catch (error) {
      // 已经不在了：这不是失败，是"别人先删了"——如实记跳过。
      skipReasons.push(link.name + '：删除前已不存在（' + messageOf(error) + '）')
      continue
    }
    // 判据 1：必须是符号链接。真目录/真文件一律不碰（哪怕它看起来该删）。
    if (!stat.isSymbolicLink()) {
      skipReasons.push(link.name + '：它不是符号链接（' + (stat.isDirectory() ? '目录' : '文件') + '），不删')
      continue
    }
    // 判据 2：删除前重新确认它仍然是断链。目标被恢复了就不该删。
    if (existsSync(path)) {
      skipReasons.push(link.name + '：删除前目标已恢复，不再是断链，不删')
      continue
    }
    try {
      remove(path)
      removedLinks.push({ ...link, path })
    } catch (error) {
      failures.push(link.name + '：删除失败（' + messageOf(error) + '）')
    }
  }
  return {
    removed: removedLinks.length,
    removedLinks,
    skipped: skipReasons.length,
    skipReasons,
    failed: failures.length,
    failures,
  }
}

/** 错误信息取文本。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}


/**
 * 一个 profile 的私有兜底层目录（`<profile>/.dsh-module-fallback/node_modules`）。
 *
 * @param profileDir - profile 目录。
 * @returns 私有层目录。
 */
export function profileModuleFallbackDir(profileDir: string): string {
  return join(profileDir, '.dsh-module-fallback', 'node_modules')
}

/** 私有层的扫描结果：只判断链（"过时"在私有层没有意义——它本来就按 profile 差集算）。 */
export interface ProfileModuleFallbackScan {
  readonly dir: string
  readonly exists: boolean
  readonly scanned: boolean
  readonly dangling: readonly ModuleFallbackLink[]
  readonly total: number
}

/**
 * 扫一个 profile 的私有兜底层，找**断链**。
 *
 * ## 为什么单独查它（它与共享层的性质不同）
 *
 * 共享层（`$DSH_HOME/profiles/node_modules`）官方**只增不删**，所以残骸是必然；
 * 私有层官方**有**反向差集清理——`healProfileModuleFallback` 里
 * `for (const packageName of ownedPackageNames(ownedModulesDir)) if (!links.has(packageName)) removeProfileSymlink(...)`。
 *
 * 所以私有层出现断链是**官方漏了**（它有清理机制却没清掉），值得单独报出来：
 * 这不是我们的机制该覆盖的范围，但用户有权知道磁盘上有这东西。
 *
 * ## 真机实例（2026-09-20 取证）
 *
 * `~/.dsh/profiles/web/.dsh-module-fallback/node_modules` 里有 2 条断链
 * （`react`、`loose-envify`，都指向已不存在的 `<profile>/node_modules/<name>`），
 * 而官方清理没有移除它们。私有层里另外 3 条（`@deepseek-ai/dsh-experimental-*`）目标都在，正常。
 *
 * @param profileDir - profile 目录。
 * @returns 扫描结果。
 */
export function scanProfileModuleFallback(profileDir: string): ProfileModuleFallbackScan {
  const dir = profileModuleFallbackDir(profileDir)
  if (!existsSync(dir)) return { dir, exists: false, scanned: false, dangling: [], total: 0 }
  const dangling: ModuleFallbackLink[] = []
  let total = 0
  for (const link of listModuleFallbackLinks(dir)) {
    total += 1
    if (existsSync(link.path)) continue
    dangling.push({ name: link.name, path: link.path, kind: 'dangling', ...(link.target === undefined ? {} : { target: link.target }) })
  }
  return { dir, exists: true, scanned: true, dangling, total }
}

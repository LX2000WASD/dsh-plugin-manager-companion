/**
 * about.ts — 「关于」页要的事实：**只读，不猜**（task-95）。
 *
 * 归属：A 类·新模块（补官方没有的信息面板）。
 * 旧实现参考：无（旧 dsh-web-plugin-manager 没有信息面板）。
 * 官方复用：`ctx.profileContext.installAnchor`（安装锚点，与官方包操作同源）。
 * 前提检查：这些事实**客户端一个都拿不到**（浏览器 bundle：无 process、无 node:fs），
 *   所以必须由 host 读、经 op 下发。调研记录见 docs/private/task76-recon.md。
 *
 * ## 本模块的核心纪律：只读事实，不猜事实（DESIGN §12.10）
 *
 * 每个字段要么是**读到的事实**（带来源），要么是 **unknown + 原因**。
 * 明确不做三件事：
 *   · 不用 `navigator.userAgent` 推平台（客户端根本没有这个字段，且那是推断不是事实）；
 *   · 不把版本号写成打包时常量（构建期与运行期可能不是同一份安装）；
 *   · 不用"看起来像"的兜底值填空（那正是 §12.10 说的"用代理代替事实"）。
 *
 * 为什么每条都要带 `source`：用户与后来人都要能判断"这条事实怎么来的"。
 * 一个没有来源的版本号，与一个猜出来的版本号，在界面上长得一模一样。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { OUR_PACKAGE_NAME, dshHome } from './paths.ts'
import { registryCachePath } from './registry.ts'

/**
 * 一条**可能读不到**的事实。
 *
 * 形状刻意做成"三选一"而不是 `value | undefined`：
 *   · 读到了 → `{ value, source }`；
 *   · 读不到 → `{ unknown: 原因 }`。
 * 用可选值的话，调用方很容易把"读不到"渲染成空白或 0——那正是 §12.3.3 禁的形态。
 * 类型上强制二选一，漏判会在编译期暴露。
 */
export type AboutFact<T> =
  | { readonly value: T; readonly source: string }
  | { readonly unknown: string }

/** 「关于」页的全部事实（op: `about`）。 */
export interface AboutFacts {
  /** 官方 dsh 运行时：版本与安装位置。 */
  readonly runtime: {
    readonly version: AboutFact<string>
    readonly installAnchor: AboutFact<string>
  }
  /** 本进程的运行时环境。 */
  readonly process: {
    readonly node: AboutFact<string>
    readonly platform: AboutFact<string>
    readonly arch: AboutFact<string>
  }
  /** 本插件自身。 */
  readonly companion: {
    readonly version: AboutFact<string>
  }
  /** 当前 profile。 */
  readonly profile: {
    readonly name: AboutFact<string>
    readonly dir: AboutFact<string>
  }
  /** 用户文件与缓存。 */
  readonly files: {
    readonly settingsPath: AboutFact<string>
    readonly registryCachePath: AboutFact<string>
    readonly registryCacheAgeMs: AboutFact<number>
  }
}

/**
 * 读一个 JSON 文件的某个字符串字段。
 *
 * @param path - 文件绝对路径。
 * @param field - 要读的字段名。
 * @param what - 面向用户的说明（写进读不到的原因里）。
 * @returns 事实（读到了给来源；读不到给原因）。
 */
function readJsonField(path: string, field: string, what: string): AboutFact<string> {
  if (!existsSync(path)) return { unknown: what + '：文件不存在（' + path + '）' }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const value = parsed[field]
    if (typeof value !== 'string' || value.length === 0) {
      return { unknown: what + '：文件里没有 ' + field + ' 字段（' + path + '）' }
    }
    return { value, source: path }
  } catch (error) {
    return { unknown: what + '：读不出来（' + path + '）：' + messageOf(error) }
  }
}

/**
 * 定位官方 dsh 安装的 package.json（安装锚点）。
 *
 * 两条路，按可靠性排序（与 src/cli.ts 的 resolveInstallAnchor 同源，但这里**不做**
 * "从 cwd 向上找"那一条：服务端进程的 cwd 未必与安装位置有关，猜出来的锚点比没有更坏）。
 *   1. 注入的锚点（`ctx.profileContext.installAnchor`，官方权威）；
 *   2. `DSH_INSTALL_ANCHOR` 环境变量（官方 CLI 的同一约定）。
 *
 * @param injected - 注入的锚点。
 * @returns 锚点绝对路径；都拿不到时 undefined（**不猜**）。
 */
function locateInstallAnchor(injected: string | undefined): string | undefined {
  if (injected !== undefined && injected.trim() !== '') return injected
  const fromEnv = process.env['DSH_INSTALL_ANCHOR']
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv
  return undefined
}

/**
 * 从锚点文件推出官方 dsh 的 package.json 路径。
 *
 * 锚点**就是**那个 package.json（官方 `installAnchor` 的语义），所以这里只做一次校验：
 * 路径以 `@deepseek-ai/dsh/package.json` 结尾就认；否则如实报"锚点看起来不是官方包的 package.json"，
 * 而不是硬读一个可能不存在的文件。
 *
 * @param anchor - 锚点路径。
 * @returns 官方 dsh 的 package.json 路径；不像时 undefined。
 */
function dshManifestFrom(anchor: string): string | undefined {
  const normalized = anchor.replace(/\\/g, '/')
  if (normalized.endsWith('@deepseek-ai/dsh/package.json')) return anchor
  // 锚点也可能是安装根（含 node_modules 的目录）：那种情况下拼一个候选出来，
  // 但**只在它真的存在时**才用——不存在就走 unknown。
  const candidate = join(dirname(anchor), 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  return existsSync(candidate) ? candidate : undefined
}

/**
 * 读本插件自身的 package.json 版本。
 *
 * 为什么不用 `upgradeCheck` 的 self 单元（Lead 明确点名）：那条路是"顺带拿到"——
 * 它要用户先进升级检查、且语义是"这个包的升级单元"，不是"我正在跑的是哪一版"。
 * 关于页问的是后者，所以直接读自身 manifest。
 *
 * 路径用 `import.meta.url` 推导（本模块被打进 dist/about.js，自身包根在上一级），
 * **不**依赖 cwd、**不**依赖 DSH_HOME：这份代码装在哪，就报哪一份的版本。
 *
 * @returns 事实。
 */
function readOwnVersion(): AboutFact<string> {
  try {
    const here = dirname(new URL(import.meta.url).pathname)
    const candidate = join(here, '..', 'package.json')
    return readJsonField(candidate, 'version', '本插件版本')
  } catch (error) {
    return { unknown: '本插件版本：定位自身位置失败：' + messageOf(error) }
  }
}

/**
 * 收集「关于」页的全部事实。
 *
 * @param options - 注入的锚点与 profile 事实（来自官方 ctx）。
 * @returns 事实集合（每条要么带来源、要么带读不到的原因）。
 */
export function collectAboutFacts(options: {
  readonly installAnchor?: string
  readonly profileName?: string
  readonly profileDir?: string
} = {}): AboutFacts {
  const anchor = locateInstallAnchor(options.installAnchor)
  const manifest = anchor === undefined ? undefined : dshManifestFrom(anchor)
  const runtimeVersion = manifest === undefined
    ? { unknown: anchor === undefined
      ? 'DSH 版本：拿不到官方安装锚点（本进程不是以 dsh profile 启动的）'
      : 'DSH 版本：锚点不像官方包的 package.json（' + anchor + '）' }
    : readJsonField(manifest, 'version', 'DSH 版本')
  const cachePath = registryCachePath()
  return {
    runtime: {
      version: runtimeVersion,
      installAnchor: anchor === undefined
        ? { unknown: '安装位置：拿不到官方安装锚点（本进程不是以 dsh profile 启动的）' }
        : { value: anchor, source: '官方 profileContext.installAnchor' },
    },
    // 进程事实是**这个进程**的事实，不是"猜的"：process.* 由 Node 直接给出。
    process: {
      node: { value: process.version, source: '本进程的 process.version' },
      platform: { value: process.platform, source: '本进程的 process.platform' },
      arch: { value: process.arch, source: '本进程的 process.arch' },
    },
    companion: { version: readOwnVersion() },
    profile: {
      name: options.profileName === undefined || options.profileName === ''
        ? { unknown: '当前环境名：宿主没有提供 profileContext' }
        : { value: options.profileName, source: '官方 profileContext.name' },
      dir: options.profileDir === undefined || options.profileDir === ''
        ? { unknown: '环境目录：宿主没有提供 profileContext' }
        : { value: options.profileDir, source: '官方 profileContext.dir' },
    },
    files: {
      settingsPath: { value: join(dshHome(), 'settings.yaml'), source: '由 DSH_HOME 推导' },
      registryCachePath: { value: cachePath, source: '本插件的市场索引缓存位置' },
      registryCacheAgeMs: readFileAgeMs(cachePath),
    },
  }
}

/**
 * 读一个文件的年龄（毫秒）。
 *
 * 缓存不存在时**不是 0**：0 是"刚刚写过"，而"没有缓存"是另一件事（§12.3.3）。
 *
 * @param path - 文件绝对路径。
 * @returns 事实：年龄（毫秒）或读不到的原因。
 */
function readFileAgeMs(path: string): AboutFact<number> {
  try {
    const stat = statSync(path)
    return { value: Date.now() - stat.mtimeMs, source: '缓存文件的修改时间' }
  } catch {
    return { unknown: '缓存年龄：缓存文件还不存在（还没有成功抓过索引）' }
  }
}

/**
 * 取错误消息（`unknown` 窄化）。
 *
 * @param error - 任意抛出物。
 * @returns 可读消息。
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 本模块用到的包名常量（供 op 层与测试引用，避免字面量散落）。 */
export const ABOUT_PACKAGE_NAME = OUR_PACKAGE_NAME

/**
 * 基础层：Harness home / profile 路径、manifest 读取、安全校验、全局互斥队列。
 * 本模块不 import 任何兄弟模块，是其余一切的地基。
 *
 * 归属：A 类·重写（旧 src/paths.ts 仅作意图参考，未复制代码）。
 * 官方复用：ctx.profileContext（当前环境事实）、readProfileManifest。
 * 前提检查：旧实现靠扫描 process.argv 猜"当前 profile"，脆弱且有历史 bug
 *   （issue #1：nvm 下 argv[1] 是脚本路径，被当成 profile 名）。官方
 *   0.1.6 提供 ctx.profileContext.name —— 直接、权威、无需猜测。
 *   本模块把"当前环境"改为注入式：由 apply() 传入官方事实，探测仅作兜底。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import type { ManifestField } from './types.ts'

/** 本包名（用于行 id、缓存目录、自识别）。 */
export const OUR_PACKAGE_NAME = 'dsh-plugin-manager-companion'

/** 本插件的 Loader 行 id。**绝不用 'plugin-manager'**——官方 base bundle 已占用该 id。 */
export const OUR_ROW_ID = 'dsh-plugin-manager-companion'

/** 解析 Harness home（DSH_HOME 优先，否则 ~/.dsh）。 */
export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** profiles 根目录。 */
export function profilesRoot(): string {
  return join(dshHome(), 'profiles')
}

/**
 * 环境名安全规则。
 * `.` / `..` 会逃出 profiles 根（join(profiles,'..') === dshHome），
 * 旧实现在这里被删过整个 Harness home，必须保留此校验。
 */
export function isSafeEnvironmentName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..' && name.length <= 120
}

/** 解析一个环境的目录，拒绝路径穿越。 */
export function environmentDir(name: string): string {
  if (!isSafeEnvironmentName(name)) {
    throw new Error('unsafe environment name: ' + JSON.stringify(name))
  }
  const dir = join(profilesRoot(), name)
  // 纵深防御：解析后的路径必须仍在 profiles 根之内。
  if (!resolve(dir).startsWith(resolve(profilesRoot()) + sep)) {
    throw new Error('unsafe environment name: ' + JSON.stringify(name))
  }
  return dir
}

/** 环境 manifest 的解析结果。 */
export interface EnvironmentManifest {
  /** `dsh.profile.bundles` 层栈；读不懂时为空数组，**必须**配合 unknownFields 判断。 */
  readonly bundles: readonly string[]
  /** 直接依赖名列表；读不懂时为空数组，**必须**配合 unknownFields 判断。 */
  readonly dependencies: readonly string[]
  /** 原始解析对象，供诊断读取任意字段。 */
  readonly raw: Record<string, unknown>
  /** 无法解析（JSON 坏掉）时的原因；成功时为 undefined。 */
  readonly broken?: string
  /**
   * 这份 manifest 里我们**读不出来**的派生字段（缺省 = 全部读得出来）。
   *
   * 存在的理由：这一整轮都在反对"把不知道说成知道"。读取器原本会把两种完全不同的
   * 事实读成同一个结果（空数组）：
   *   · 确实没有声明层栈 / 确实没有依赖 → 空数组是**事实**；
   *   · 官方把 `dsh.profile.bundles` 改名、或把 `dependencies` 写成数组 → 空数组是**假阴性**
   *     （后者还会被读成一个名叫 "0" 的依赖：Object.keys(['a']) === ['0']）。
   * 现在后者进这份清单（配 unknownReason），调用方据此少说那句话。
   */
  readonly unknownFields?: readonly ManifestField[]
  /** 读不出来的原因（面向用户的一句话）；全部读得出来时为 undefined。 */
  readonly unknownReason?: string
}

/**
 * 读取一个环境的 manifest。
 *
 * 与旧实现的差别：**解析失败不再静默返回空**。旧实现在 manifest 损坏时
 * 返回 `{}`，让"零依赖零 bundle"看起来像真实状态，掩盖了真正的问题。
 * 这里把失败原因显式带回，交给诊断层报告。
 *
 * 同一条原则也适用于"格式读不懂"：官方若改了 `dsh.profile.bundles` 的名字或位置，
 * 旧写法会读出空数组且不报错——诊断会把"我不知道"说成"这个环境没有层栈"。
 * 现在这种形态返回 `unknownFields` + `unknownReason`（见字段注释）：**按字段**表达，
 * 以后再加派生字段不需要第三个布尔。
 *
 * @param dir - 环境目录。
 * @returns 解析结果；**读派生字段前先看 unknownFields**。
 */
export function readEnvironmentManifest(dir: string): EnvironmentManifest {
  const path = join(dir, 'package.json')
  // 没有 manifest 文件 = 确实没有声明层栈（不是"读不懂"）。
  if (!existsSync(path)) return { bundles: [], dependencies: [], raw: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    return {
      bundles: [], dependencies: [], raw: {},
      broken: error instanceof Error ? error.message : String(error),
    }
  }
  // 顶层不是对象：整份 manifest 都不可用——两个派生字段都读不出来（不是"为空"）。
  if (!isRecord(parsed)) {
    return {
      bundles: [], dependencies: [], raw: {},
      unknownFields: ['bundles', 'dependencies'],
      unknownReason: 'package.json 的顶层不是 JSON 对象（是 ' + typeofOf(parsed) + '）',
    }
  }
  const raw = parsed
  const unknownFields: ManifestField[] = []
  let reason: string | undefined

  // dependencies：只有普通对象才读得出依赖名。数组会走 Object.keys → ['0', '1']，
  // 那是把 `dependencies: ['a']` 读成一个名叫 "0" 的依赖（同一族的假阴性）。
  const depsValue = raw['dependencies']
  if (depsValue !== undefined && depsValue !== null && !isRecord(depsValue)) {
    unknownFields.push('dependencies')
    // 原因要指名是哪个字段、当前是什么类型——用户读了才知道该去看什么。
    reason = 'dependencies 不是普通对象（当前类型：' + typeofOf(depsValue) + '），读不出依赖名'
  }
  const dependencies = isRecord(depsValue) ? Object.keys(depsValue) : []

  let bundles: string[] = []
  const dshValue = raw['dsh']
  if (dshValue === undefined) {
    // dsh 整段缺失 = 这个环境没有声明 profile 段，层栈确实是空的。
  } else if (!isRecord(dshValue)) {
    reason = 'dsh 段不是对象（官方可能改了这一层的结构）'
    unknownFields.push('bundles')
  } else {
    const profileValue = dshValue['profile']
    if (profileValue === undefined) {
      // dsh.profile 缺失 = 没有声明层栈。
    } else if (!isRecord(profileValue)) {
      reason = 'dsh.profile 不是对象（官方可能改了这一层的结构）'
      unknownFields.push('bundles')
    } else {
      const bundlesValue = profileValue['bundles']
      if (bundlesValue === undefined) {
        // 关键区分：profile 段**存在**、但没有 bundles 字段、却带着别的键（例如 layers / list）
        // ——这是"官方改了字段名"的形态，不是"没有声明层栈"。真空层栈也会写 bundles: []；
        // 只有 profile 段完全为空 {} 才当成确定的空。
        const unknownKeys = Object.keys(profileValue).filter(key => key !== 'bundles')
        if (unknownKeys.length > 0) {
          reason = 'dsh.profile 里没有 bundles 字段，却有 ' + unknownKeys.join('、')
            + '（官方可能把层栈字段改名或移位了）'
          unknownFields.push('bundles')
        }
      } else if (!Array.isArray(bundlesValue)) {
        reason = 'dsh.profile.bundles 存在但不是数组（当前类型：' + typeofOf(bundlesValue) + '）'
        unknownFields.push('bundles')
      } else if (!bundlesValue.every(item => typeof item === 'string')) {
        reason = 'dsh.profile.bundles 里有非字符串项'
        unknownFields.push('bundles')
      } else {
        bundles = [...bundlesValue] as string[]
      }
    }
  }

  const fields = [...new Set(unknownFields)]
  if (fields.length === 0) return { bundles, dependencies, raw }
  return {
    bundles, dependencies, raw,
    unknownFields: fields,
    unknownReason: reason ?? '这份 manifest 的字段形态与预期不一致（原因未知）',
  }
}

/** 是不是普通对象（数组与 null 都不算）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 供原因文案使用的类型名。 */
function typeofOf(value: unknown): string {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

/** 一个环境的 patch 文件路径。 */
export function environmentPatchPath(dir: string): string {
  return join(dir, 'cordis.patch.yml')
}

/**
 * 全局变更互斥队列（进程内）。
 *
 * 环境变更操作串行执行：并发 pnpm 调用会各自基于自己的快照重写 manifest
 * （丢依赖），并发文件编辑会丢行。进程内仅覆盖本进程；跨进程由官方
 * withFileLock 在 package.json 上兜底。
 */
let mutationQueue: Promise<unknown> = Promise.resolve()
export function enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(task, task)
  mutationQueue = run.catch(() => { /* 失败的任务不能卡死队列 */ })
  return run
}

/**
 * 当前运行环境的名称。
 *
 * 优先官方事实：`ctx.profileContext.name`（由 apply 注入）。
 * 兜底：解析 argv 的 `--profile <name>`。
 * 两者都拿不到时返回 null——调用方必须把它当作"未知"而非"没有环境"，
 * 不做任何破坏性推断。
 */
export function detectCurrentEnvironmentName(argv: readonly string[] = process.argv): string | null {
  const flagIndex = argv.indexOf('--profile')
  if (flagIndex >= 0) {
    const flagged = argv[flagIndex + 1]
    if (flagged !== undefined && isSafeEnvironmentName(flagged)) return flagged
  }
  return null
}

/** 官方内置环境：只读，环境管理不修改它们的层栈。 */
export const BUILTIN_ENVIRONMENTS = ['web', 'headless'] as const

/** 是否为官方内置环境。 */
export function isBuiltinEnvironment(name: string): boolean {
  return (BUILTIN_ENVIRONMENTS as readonly string[]).includes(name)
}

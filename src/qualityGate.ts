/**
 * 安装前质量门 — 对**已经装进 profile 的包**做静态体检（不写文件、不调 pnpm）。
 *
 * 归属：A 类·重写（旧 src/installFlow.ts#qualityIssues 只作检查面意图参考，未复制代码）。
 * 旧实现参考：dsh-web-plugin-manager/src/installFlow.ts#qualityIssues（约 1422 行起）与
 *   docs/private/audit/correctness.md 的 C-1/C-2 记录。旧实现的两个 Critical 缺陷在这里被正面修掉：
 *   C-1 只扫 exports["."] 一个入口 → 现在扫全部导出子路径 + 相对 import 可达文件（有界 BFS）；
 *   C-2 对 scoped 子路径假阳性（只要 @scope/pkg 目录存在就判"可解析"）→ 现在用
 *   diagnostics.ts 的 specifierResolves：Node 真实解析（只用于判真）与文件/exports 探测两把尺子，
 *   判定"不可解析"时必须两者都不成立。
 * 官方复用：安装流程本身由官方 Remote 编排（inspect → installBundle(enabled:false) → 本门 →
 *   removeBundle / setBundleEnabled），本模块只提供第 3 步的静态判定，不参与写路径。
 *   包入口解析、import 扫描、行号定位与 diagnostics.ts 共用同一套实现，避免两处口径漂移。
 * 前提检查：旧前提是"装完只看一个入口就够"——实测不够（C-1）；旧实现还用自建 bash 探测
 *   patch 行名，现在改为读原始 patch 文本定位行 + Node 侧解析，不再自建第二套解析器。
 *
 * 调用契约：config.qualityGate 的 enabled/mode 是**调用方**（安装流程包装器）的事——
 * enabled=false 时调用方不该调用本函数，mode='warn' 时调用方只展示不过滤。
 * 本函数只消费 allowlist（命中即跳过全部检查，用户显式承担风险）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  OFFICIAL_DEP_ALLOWED, installedPackageDir, isLoaderProvided, locatePatchRows,
  packageEntryFiles, scanPackage, specifierResolves,
} from './diagnostics.ts'
import type { CompanionConfig, QualityGateConfig } from './settings.ts'

/** 质量门单包扫描的文件预算（覆盖整条加载链，同时保证响应有界）。 */
const GATE_FILE_BUDGET = 400

/**
 * 质量门的判定结果。
 *
 * @remarks
 * 验收契约只要求 { ok, issues }；notes 是**额外**的非判定性事实
 * （豁免生效、扫描截断等），调用方可以直接展示，也可以忽略——它永远不代表不合格。
 */
export interface QualityGateResult {
  /** 是否通过（没有任何 issue）。 */
  readonly ok: boolean
  /** 面向用户的问题清单；空数组表示通过。 */
  readonly issues: readonly string[]
  /** 非判定性事实：豁免、扫描上限截断说明等。不影响 ok。 */
  readonly notes: readonly string[]
}

/**
 * 体检一个已安装的包。
 *
 * 检查三件事：
 *  1. 未声明的 import（loader/平台提供项与 Node 内置模块豁免）——挂载后必 ERR_MODULE_NOT_FOUND；
 *  2. 声明了但没装（peer 或普通依赖落不下来）；
 *  3. @deepseek-ai/* 被声明成普通 dependencies —— 模块身份分裂会劫持官方 loader 行（豁免见
 *     diagnostics.ts 的 OFFICIAL_DEP_ALLOWED）。
 * 另外检查包自己的 bundle patch 行名是否解析得到（该行解析失败会让整个 profile 起不来）。
 *
 * @param envDir - profile 环境目录（解析锚点，也是包所在 node_modules 的父目录）。
 * @param packageName - 已安装的包名。
 * @param config - 本插件配置；同时接受 CompanionConfig 与单独的 qualityGate 段。
 * @returns 判定结果；问题为空即 ok。
 */
export async function inspectPackage(
  envDir: string,
  packageName: string,
  config: CompanionConfig | QualityGateConfig,
): Promise<QualityGateResult> {
  const gate = normalizeQualityGateConfig(config)
  const issues: string[] = []
  const notes: string[] = []

  if (gate.allowlist.includes(packageName)) {
    return {
      ok: true,
      issues,
      notes: ['包名在质量门豁免名单里：跳过全部检查（这是用户显式承担风险的选择）'],
    }
  }
  if (!isSafePackageName(packageName)) {
    return { ok: false, issues: ['包名不合法：' + JSON.stringify(packageName)], notes }
  }

  const pkgDir = installedPackageDir(envDir, packageName)
  if (pkgDir === undefined) {
    return {
      ok: false,
      issues: ['在 ' + envDir + ' 下的 node_modules 里找不到这个包：质量门要求包先落地再体检'],
      notes,
    }
  }

  const manifest = readManifest(join(pkgDir, 'package.json'))
  if (manifest === undefined) {
    return { ok: false, issues: ['读不到该包的 package.json（缺失或不是 JSON 对象）'], notes }
  }

  const declared = declaredDependencyNames(manifest)
  const regular = Object.keys(asRecord(manifest['dependencies']) ?? {})

  for (const dep of regular) {
    if (!dep.startsWith('@deepseek-ai/')) continue
    if (OFFICIAL_DEP_ALLOWED.has(dep)) {
      notes.push(dep + ' 属于模块身份不敏感的官方包，普通依赖声明按豁免处理')
      continue
    }
    issues.push('把官方包 ' + dep + ' 声明成了普通 dependencies：pnpm 会在 profile 里装出第二份拷贝，'
      + 'loader 解析官方行时用到它，唯一符号与类身份分裂（典型症状是 '
      + 'Cannot read properties of undefined (reading \'prepare\')）。'
      + '请改成 peerDependencies（peer 由安装兜底层满足），或删掉这条声明。')
  }

  const entries = packageEntryFiles(pkgDir, manifest)
  if (entries.length === 0) {
    issues.push('没有可解析的入口文件（exports / main / module / index.js 都没有命中）：'
      + '任何挂载它的 loader 行都会失败。')
  }

  const scan = scanPackage(pkgDir, manifest, GATE_FILE_BUDGET)
  if (scan.reason !== undefined && entries.length > 0) notes.push('扫描未完成：' + scan.reason)
  if (scan.truncated) {
    notes.push('扫描在 ' + scan.filesScanned + ' 个文件处到达上限（单包预算 ' + GATE_FILE_BUDGET
      + ' 个文件），更深处的 import 未覆盖：标为通过不代表已证全善。')
  }

  const at = (file: string, line: number): string => relativeTo(envDir, file) + ':' + line

  for (const hit of scan.imports) {
    const spec = hit.spec
    if (isBuiltinSpecifier(spec)) continue
    if (isLoaderProvided(spec)) continue
    if (spec === packageName || spec.startsWith(packageName + '/')) continue
    const covered = [...declared].some(name => spec === name || spec.startsWith(name + '/'))
    if (!covered) {
      issues.push('未声明的 import：' + at(hit.file, hit.line) + ' 导入 ' + spec
        + '，但本包的 dependencies / peerDependencies 都没有声明它，profile 里也不会装它——'
        + '挂载后必然 ERR_MODULE_NOT_FOUND（未声明依赖 pnpm 根本不会安装）。')
      continue
    }
    if (!specifierResolves(pkgDir, spec) && !specifierResolves(envDir, spec)) {
      issues.push('声明了但没装：' + spec + '（声明于本包 package.json），'
        + '在 ' + at(hit.file, hit.line) + ' 被导入，但 profile 与共享兜底层里都解析不到它——'
        + '挂载后必然 ERR_MODULE_NOT_FOUND。')
    }
  }

  issues.push(...bundleRowIssues(envDir, pkgDir, packageName))
  return { ok: issues.length === 0, issues, notes }
}

/**
 * 包自带 bundle patch 的行名检查。
 *
 * 一行 name 解析不到，挂载时就是 ERR_MODULE_NOT_FOUND，而且会让**整个 profile** 起不来
 * （bundle 的行是启动路径的一部分）。这里用 diagnostics 的行定位器读原始 patch 文本，
 * 解析判定与诊断层完全同源。
 *
 * @param envDir - profile 环境目录（解析锚点）。
 * @param pkgDir - 包目录。
 * @param packageName - 包名。
 * @returns 面向用户的问题清单（可能为空）。
 */
function bundleRowIssues(envDir: string, pkgDir: string, packageName: string): string[] {
  const issues: string[] = []
  const manifest = readManifest(join(pkgDir, 'package.json'))
  const bundle = asRecord(manifest?.['dsh'])?.['bundle']
  const declared = asRecord(bundle)?.['patch']
  if (typeof declared !== 'string' || declared.length === 0) return issues
  const patchPath = resolve(pkgDir, declared)
  const patchLabel = relativeTo(envDir, patchPath)
  if (!existsSync(patchPath)) {
    issues.push('声明了 dsh.bundle.patch=' + declared + '，但 ' + patchLabel
      + ' 不存在：profile 启动时读不到这一层 patch。')
    return issues
  }
  for (const row of locatePatchRows(patchPath)) {
    const name = row.name
    if (name === undefined || name.length === 0) continue
    const at = patchLabel + ':' + row.line
    if (name.startsWith('cordis:')) continue
    if (name === packageName || name.startsWith(packageName + '/')) {
      if (!specifierResolves(envDir, name)) {
        issues.push('bundle patch 行指向自身子路径 ' + name + '（' + at + '），但该子路径解析不到：'
          + '要么文件不存在，要么没写进 exports。挂载这一行会让 profile 起不来。')
      }
      continue
    }
    if (name.startsWith('.') || isAbsolute(name)) {
      if (!existsSync(resolve(dirname(patchPath), name))) {
        issues.push('bundle patch 行 ' + at + ' 的相对模块名 ' + name + ' 解析不到文件'
          + '（相对路径按 patch 文件所在目录解析）。')
      }
      continue
    }
    if (isLoaderProvided(name)) continue
    if (!specifierResolves(envDir, name)) {
      issues.push('bundle patch 行 ' + at + ' 挂载 ' + name + '，但它在 profile 与共享兜底层里都解析不到：'
        + '挂载这一行会让整个 profile 起不来（这也是本地安装的 bundle 依赖漏装时的典型症状）。')
    }
  }
  return issues
}

/** 组装 CompanionConfig 与单独 qualityGate 段的差异。 */
function normalizeQualityGateConfig(config: CompanionConfig | QualityGateConfig): QualityGateConfig {
  const candidate = (config as Partial<CompanionConfig>).qualityGate
  return candidate ?? {
    enabled: true,
    mode: 'block',
    allowlist: (config as QualityGateConfig).allowlist ?? [],
  }
}

/**
 * 包名安全校验：质量门要把包名拼进路径，必须挡住路径穿越
 * （与 paths.ts 的 isSafeEnvironmentName 同样的纵深防御思路）。
 */
export function isSafePackageName(name: string): boolean {
  if (name.length === 0 || name.length > 214) return false
  if (name.startsWith('.') || name.startsWith('/') || name.startsWith('\\')) return false
  if (name.includes('..') || name.includes('\\')) return false
  return /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)
}

/** Node 内置模块说明符：crypto 与 node:crypto 等价，fs/promises 这类子路径同样豁免。 */
export function isBuiltinSpecifier(spec: string): boolean {
  if (spec.startsWith('node:')) return true
  return isBuiltin(spec)
}

/** 一个包声明的全部依赖名（dependencies + peerDependencies + optionalDependencies）。 */
function declaredDependencyNames(manifest: Record<string, unknown>): Set<string> {
  const names = new Set<string>()
  for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
    const record = asRecord(manifest[section])
    if (record === undefined) continue
    for (const name of Object.keys(record)) names.add(name)
  }
  return names
}

/** 读一个包 manifest；读不到或不是 JSON 对象时 undefined。 */
function readManifest(path: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** 取对象字段（非对象返回 undefined）。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** 相对路径（不在目录内时返回绝对路径）。 */
function relativeTo(base: string, file: string): string {
  const rel = relative(base, file)
  return rel.length === 0 || rel.startsWith('..') ? file : rel
}

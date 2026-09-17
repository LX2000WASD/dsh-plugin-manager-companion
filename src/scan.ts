/**
 * 安装期环境变量需求扫描与子进程环境过滤（给 git 源插件用）。
 *
 * 归属：B 类·参考算法后重写（纯决策 + 有界只读扫描；旧 src/scan.ts 仅作意图参考，未复制代码）。
 * 旧实现参考：dsh-web-plugin-manager/src/scan.ts（91 行，2 层/40 文件/8 变量上限、
 *   TOKEN|KEY|SECRET|PASSWORD|PASS|CREDENTIAL 六族敏感键、\b 词边界的坑）。
 * 官方复用：无（官方没有安装期 env 扫描；官方 plugin-manager 用 scrubbedParentEnv()
 *   清空 service 侧子进程环境，我们借鉴其"默认最小"的取向，但实现自有）。
 * 前提检查：仍然成立——git 源插件的 pnpm 解析与生命周期脚本会继承子进程 env，
 *   全量透传等于把宿主凭据交给未审核的第三方代码。旧实现的已知限制（只覆盖常见
 *   敏感键形态）在这里被显式扩大：见 SENSITIVE_FAMILIES / SENSITIVE_PREFIXES；
 *   未被覆盖的形态仍然放行，这一事实写在 buildFilteredEnv 的文档里，不假装完整。
 *
 * 三条安全不变量（写在代码里，不靠调用方自觉）：
 *   1. answers 只按**扫描白名单**注入——PATH/HOME/NODE_OPTIONS 这类键永远进不来
 *      （旧仓库审计点：任意键注入可劫持子进程执行）。
 *   2. 子进程环境默认剔除敏感键形态；扫描出的键由调用方显式给定值时按值注入
 *      （用户显式提供即同意），未提供的宿主同名残留值仍被剔除。
 *   3. 过滤是"剔除"，不是"清空"：宿主仍需要 PATH/HOME 才能跑 pnpm。这与官方
 *      service 侧的全清策略不同是有意的：CLI 的生命周期脚本依赖用户工具链
 *      （nvm 下的 node/pnpm 解析），清空会让安装直接失败。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

/** 扫描成本上限：目录层数、候选文件数、返回变量数、单文件字节数。 */
export interface ScanLimits {
  /** 递归层数上限（根为第 0 层）。 */
  readonly maxDepth: number
  /** 最多读取的候选文件数。 */
  readonly maxFiles: number
  /** 最多返回的变量名数量。 */
  readonly maxVariables: number
  /** 单个候选文件的读取上限（字节）；超出即放弃该文件并记账。 */
  readonly maxFileBytes: number
}

/** 默认上限。旧仓库实测：2 层/40 文件足够覆盖 README + package.json + .env.example。 */
export const DEFAULT_SCAN_LIMITS: ScanLimits = {
  maxDepth: 2,
  maxFiles: 40,
  maxVariables: 8,
  maxFileBytes: 512 * 1024,
}

/**
 * 敏感键判定族。
 *
 * 与旧实现的差别：旧实现只有六族（TOKEN/KEY/SECRET/PASSWORD/PASS/CREDENTIAL），
 * 且用 \b 词边界——GITHUB_TOKEN 里的 TOKEN 前是下划线（属于 \w），\b 根本不成立；
 * 旧注释记录了这一点并改用字母数字感知边界。这里保留字母数字感知边界，把族扩到
 * 结构词（ACCESS_KEY/SECRET_KEY/AUTH/AUTHORIZATION/BEARER/PRIVATE_KEY）并补上
 * 云厂商与常见平台的固定前缀（AWS_/GH_/GITHUB_/OPENAI_/ANTHROPIC_/DEEPSEEK_ 等）。
 *
 * **不是全集的诚实声明**：任何未被这些形态覆盖的宿主变量（例如自定义
 * SESSION_COOKIE、内部 _TICKET 命名）不会被剔除，会随子进程进入第三方脚本的
 * 生命周期钩子。彻底消除这条路径只能清空环境或引入随宿主版本演进的
 * allowlist——前者打断用户工具链解析，后者不在本模块职责内，因此这里如实声明。
 */
const SENSITIVE_FAMILIES = [
  'TOKEN', 'KEY', 'SECRET', 'PASSWORD', 'PASS', 'CREDENTIAL', 'CREDENTIALS',
  'ACCESS_KEY', 'SECRET_KEY', 'AUTH', 'AUTHORIZATION', 'BEARER', 'PRIVATE_KEY',
] as const

/** 云厂商与常见平台的键前缀（大小写不敏感）。 */
const SENSITIVE_PREFIXES = [
  'AWS_', 'GH_', 'GITHUB_', 'GITLAB_', 'OPENAI_', 'ANTHROPIC_', 'DEEPSEEK_',
  'AZURE_', 'GOOGLE_', 'GCP_', 'SLACK_', 'STRIPE_', 'NPM_', 'NODE_AUTH_',
  'DOCKER_', 'SSH_', 'CI_JOB_',
] as const

/**
 * 敏感环境变量名判定。
 *
 * 边界用字母数字感知（不能用 \b：下划线属于 \w，GITHUB_TOKEN 中 TOKEN 前无边界）。
 * 结果：GITHUB_TOKEN / OPENAI_API_KEY / DB_PASSWORD / XXX_PASS 命中，
 * KEYBOARD_LAYOUT（KEY 后接 B）不误伤，AWS_SECRET_ACCESS_KEY 命中。
 *
 * @param name - 变量名；非字符串输入按字符串处理（调用方可能传任意 JSON）。
 * @returns 是否属于敏感形态。
 */
export function isSensitiveEnvKey(name: string): boolean {
  const text = String(name ?? '')
  if (text.length === 0) return false
  const upper = text.toUpperCase()
  for (const prefix of SENSITIVE_PREFIXES) {
    if (upper.startsWith(prefix)) return true
  }
  for (const family of SENSITIVE_FAMILIES) {
    // 字母数字感知边界：(?<![A-Za-z0-9]) 与 (?![A-Za-z0-9])
    const pattern = new RegExp('(?<![A-Za-z0-9])' + family + '(?![A-Za-z0-9])', 'i')
    if (pattern.test(text)) return true
    // 后缀形态：AWS_SECRET_ACCESS_KEY 中 ACCESS_KEY 紧跟在 '_' 之后（\w，边界不成立），
    // MY_APP_TOKEN 这类以家族名结尾的命名同样属于凭据形态。
    if (upper.endsWith('_' + family)) return true
  }
  // 驼峰拼接形态：apiKey / accessToken / clientSecret。前一个字符必须是小写字母
  // （camelCase 的拼接点），这样 monkey 这类普通词不会被误判（key 是小写 k）。
  if (/[a-z](?:Key|Token|Secret|Password|Credential|Pass)$/.test(text)) return true
  return false
}

/**
 * 候选变量名的文本形态。
 *
 * 只匹配**敏感形态**：安装/构建阶段通常只有凭据类变量需要用户提供，普通配置项
 * （PORT、NODE_ENV）有默认值，扫出来只会打扰用户。
 */
const ENV_NAME_PATTERNS: readonly RegExp[] = [
  // SCREAMING_SNAKE：OPENAI_API_KEY / GITHUB_TOKEN / DB_PASSWORD / XXX_PASS
  /\b[A-Z][A-Z0-9_]{1,}(?:API_KEY|_KEY|_TOKEN|_SECRET|_PASSWORD|_PASS|_CREDENTIALS?|_ACCESS_KEY)\b/g,
  // 驼峰：apiKey / accessToken / clientSecret / dbPassword
  /\b[a-z][A-Za-z0-9]*(?:ApiKey|AccessKey|Token|Secret|Password|Credential)\b/g,
  // process.env.X / env.X 引用形态
  /(?:process\.env|\benv)\.([A-Z][A-Z0-9_]{2,})\b/g,
]

/** 扫描源：从哪个文件/字段发现了这个变量名。 */
export interface ScanSource {
  /** 相对仓库根的路径；用于输出让用户能自己核实。 */
  readonly file: string
  /** 发现位置（文件名 / package.json 字段）。 */
  readonly via: string
  /** 该变量名是否被判为敏感形态。 */
  readonly sensitive: boolean
}

/** 一次扫描的结果。 */
export interface ScanReport {
  /** 需要的变量名（去重、按发现顺序、受 maxVariables 限制）。 */
  readonly requirements: readonly string[]
  /** 每个变量名的来源，与 requirements 同序。 */
  readonly sources: readonly ScanSource[]
  /** 层数/文件数/变量数触顶时为 true——超限如实标注，不静默截断。 */
  readonly truncated: boolean
  /** 触顶的维度说明，直接面向用户展示。 */
  readonly truncatedReasons: readonly string[]
  /** 实际被读取的候选文件数。 */
  readonly filesRead: number
  /** 实际遍历到的最深层数。 */
  readonly depthReached: number
  /** 因超过单文件上限而被跳过的文件数。 */
  readonly oversized: number
}

/** 扫描选项。 */
export interface ScanOptions {
  /** 覆盖默认上限（部分覆盖）。 */
  readonly limits?: Partial<ScanLimits>
  /** 是否收录非敏感形态的变量名。默认 false（只收敏感形态，避免打扰用户）。 */
  readonly includePlain?: boolean
}

/** 目录项的最小视图（node 的 Dirent 结构兼容）。 */
interface DirEntry {
  readonly name: string
  isDirectory(): boolean
  isFile(): boolean
}

/** 读取目录项，失败返回空数组（权限/不存在都不应中断扫描）。 */
async function readEntries(dir: string): Promise<readonly DirEntry[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** 候选文件名判定：只读"人写的"文件，跳过构建产物与锁文件。 */
function isCandidateFile(name: string): boolean {
  const lower = name.toLowerCase()
  if (/^readme/i.test(name)) return true
  if (lower.startsWith('install') || lower.startsWith('setup') || lower.startsWith('bootstrap')) return true
  if (lower.endsWith('.env') || lower.endsWith('.env.example') || lower.endsWith('.env.sample')) return true
  if (lower === 'package.json') return true
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return true
  if (lower.endsWith('.md') || lower.endsWith('.mdx')) return true
  if (lower.endsWith('.sh') || lower.endsWith('.ps1')) return true
  if (lower.endsWith('.json') && lower !== 'pnpm-lock.json' && lower !== 'package-lock.json') return true
  return false
}

/** 默认跳过的目录：版本库、依赖树、构建产物。 */
function isSkippedDir(name: string): boolean {
  if (name.startsWith('.')) return true
  return name === 'node_modules' || name === 'dist' || name === 'build' || name === 'out' || name === 'coverage'
}

/** 从一个文本里抽取候选变量名（按出现顺序去重，值为发现形态）。 */
function namesInText(text: string, includePlain: boolean): Map<string, string> {
  const found = new Map<string, string>()
  for (const pattern of ENV_NAME_PATTERNS) {
    // 全局正则的 lastIndex 在多次调用间会残留；每次重置，避免漏匹配。
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      // 第三种形态带捕获组（process.env.X）；取组 1 存在时的值，否则整体。
      const raw = match[1] ?? match[0]
      const name = raw.trim()
      if (name.length < 3 || name.length > 128) continue
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue
      if (!includePlain && !isSensitiveEnvKey(name)) continue
      if (!found.has(name)) found.set(name, 'text')
    }
  }
  return found
}

/** 从 package.json 里抽取可能消费的环境变量（scripts / config / env / dsh / build）。 */
function namesInManifest(text: string): Map<string, string> {
  const found = new Map<string, string>()
  let manifest: unknown
  try {
    manifest = JSON.parse(text)
  } catch {
    return found
  }
  if (manifest === null || typeof manifest !== 'object') return found
  const record = manifest as Record<string, unknown>
  const visit = (value: unknown, via: string, depth: number): void => {
    if (depth > 4) return
    if (typeof value === 'string') {
      for (const [name] of namesInText(value, true)) {
        if (!found.has(name)) found.set(name, via)
      }
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, via, depth + 1)
      return
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        // 键本身就是变量名（"env": { "OPENAI_API_KEY": "..." } 这种写法）。
        if (/^[A-Z][A-Z0-9_]{2,}$/.test(key) && isSensitiveEnvKey(key) && !found.has(key)) found.set(key, via)
        visit(item, via, depth + 1)
      }
    }
  }
  for (const field of ['scripts', 'config', 'env', 'dsh', 'build'] as const) {
    if (record[field] !== undefined) visit(record[field], 'package.json#' + field, 0)
  }
  return found
}

/**
 * 扫描仓库目录，给出安装/构建阶段可能需要的环境变量名。
 *
 * 有界：层数、文件数、变量数、单文件大小全部设上限；触顶时 truncated 为 true
 * 并在 truncatedReasons 里说明是哪个维度触顶——漏报一个必需变量会让用户在安装
 * 中途才失败，所以超限必须如实标注而不是静默截断。
 *
 * 只读取，不执行：仓库里的 install.sh 永远不会被本模块或调用方自动执行。
 *
 * @param repoDir - 已克隆/已就绪的仓库根目录。
 * @param options - 上限覆盖与是否收录非敏感形态。
 * @returns 扫描报告。
 */
export async function scanRequirements(repoDir: string, options: ScanOptions = {}): Promise<ScanReport> {
  const limits: ScanLimits = { ...DEFAULT_SCAN_LIMITS, ...options.limits }
  const includePlain = options.includePlain === true
  const requirements = new Map<string, ScanSource>()
  const truncatedReasons: string[] = []
  const candidates: Array<{ path: string; rel: string }> = []
  let filesRead = 0
  let depthReached = 0
  let oversized = 0
  let depthHit = false
  let variablesHit = false

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (candidates.length >= limits.maxFiles) return
    if (depth > limits.maxDepth) {
      depthHit = true
      return
    }
    depthReached = Math.max(depthReached, depth)
    const entries = await readEntries(dir)
    for (const entry of entries) {
      if (candidates.length >= limits.maxFiles) return
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (isSkippedDir(entry.name)) continue
        await walk(path, depth + 1)
        continue
      }
      if (!entry.isFile() || !isCandidateFile(entry.name)) continue
      candidates.push({ path, rel: relative(repoDir, path).split(sep).join('/') })
    }
  }
  await walk(repoDir, 0)
  if (depthHit) truncatedReasons.push('directory depth exceeded ' + String(limits.maxDepth))
  if (candidates.length >= limits.maxFiles) truncatedReasons.push('file budget reached (' + String(limits.maxFiles) + ')')

  for (const candidate of candidates.slice(0, limits.maxFiles)) {
    let size: number
    try {
      size = (await stat(candidate.path)).size
    } catch {
      continue
    }
    if (size > limits.maxFileBytes) {
      oversized += 1
      continue
    }
    let text: string
    try {
      text = await readFile(candidate.path, 'utf8')
    } catch {
      // 二进制或不可读：跳过是唯一安全选择（不计入 oversized，那是"太大"的账）。
      continue
    }
    filesRead += 1
    const found = /(^|\/)package\.json$/i.test(candidate.rel)
      ? namesInManifest(text)
      : namesInText(text, includePlain)
    for (const [name, via] of found) {
      if (requirements.has(name)) continue
      if (requirements.size >= limits.maxVariables) {
        variablesHit = true
        continue
      }
      requirements.set(name, { file: candidate.rel, via, sensitive: isSensitiveEnvKey(name) })
    }
  }
  if (variablesHit) truncatedReasons.push('variable budget reached (' + String(limits.maxVariables) + ')')

  return {
    requirements: [...requirements.keys()],
    sources: [...requirements.values()],
    truncated: truncatedReasons.length > 0,
    truncatedReasons,
    filesRead,
    depthReached,
    oversized,
  }
}

/** 取某个变量名在扫描报告里的来源。 */
export function sourceOf(report: ScanReport, name: string): ScanSource | undefined {
  const index = report.requirements.indexOf(name)
  return index === -1 ? undefined : report.sources[index]
}

/**
 * 过滤子进程环境：剔除敏感键。
 *
 * 取值为 undefined 的键（Node 允许）保持 undefined，其余原样保留——这里是过滤器
 * 而不是构造器，宿主工具链（PATH/HOME/NVM_DIR）必须继续可用，否则 nvm 用户的
 * node/pnpm 解析会失败（旧仓库 issue 记录）。
 *
 * @param source - 基础环境；默认 process.env。
 * @returns 剔除敏感键后的新对象（不改动传入对象）。
 */
export function buildFilteredEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) {
    if (isSensitiveEnvKey(key)) continue
    env[key] = value
  }
  return env
}

/**
 * 构造注入给子进程的环境：先剔敏感键，再按白名单注入用户提供的值。
 *
 * 白名单来自扫描（session 或 CLI 本次扫描），因此 PATH/HOME/NODE_OPTIONS/
 * __proto__ 这类键即使出现在 answers 里也不会被注入。
 *
 * 显式提供即同意：用户主动为某个**敏感**键提供值时该值会被注入——这个值只存在于
 * 用户自己的机器上、由用户自己录入，安装链路没有"静默读取宿主凭据"的部分。
 * 未提供时，宿主同名变量仍然被剔除。
 *
 * @param source - 基础环境（通常是 process.env）。
 * @param answers - 用户提供的键值；键不在白名单内或值不是非空字符串即忽略。
 * @param allowlist - 允许注入的键（扫描结果）。
 * @returns 供子进程使用的环境对象。
 */
export function buildFilteredEnvWithAnswers(
  source: NodeJS.ProcessEnv,
  answers: Readonly<Record<string, string>> | undefined,
  allowlist: readonly string[],
): NodeJS.ProcessEnv {
  const env = buildFilteredEnv(source)
  if (answers === undefined) return env
  const allowed = new Set(allowlist)
  for (const [key, value] of Object.entries(answers)) {
    if (!allowed.has(key)) continue
    if (typeof value !== 'string' || value.length === 0) continue
    env[key] = value
  }
  return env
}

/** 给用户看的缺失变量清单（CLI 输出用；含每个变量的来源，便于用户自己核实）。 */
export function formatMissingRequirements(report: ScanReport, provided: Readonly<Record<string, string>>): string[] {
  const missing: string[] = []
  for (const [index, name] of report.requirements.entries()) {
    const value = provided[name]
    if (typeof value === 'string' && value.length > 0) continue
    const source = report.sources[index]
    missing.push(source === undefined ? name : name + '  (found in ' + source.file + ')')
  }
  return missing
}

/**
 * 是否需要为某次安装做 env 扫描。
 *
 * 只对 git 源扫描：本地路径是用户自己的目录（想读环境变量早就读了），npm 包在
 * 安装前没有可扫的仓库内容。git+ / github: / git@ / .git 结尾 / git URL 都算。
 *
 * @param spec - 安装源。
 * @returns 是否为 git 源。
 */
export function isGitSource(spec: string): boolean {
  const text = spec.trim()
  if (text === '') return false
  if (/^git\+/i.test(text)) return true
  if (/^github:/i.test(text)) return true
  if (/^git@/i.test(text)) return true
  if (/^https?:\/\/[^/]*\/(?:[^/]+\/)*[^/]+\.git(?:#|$)/i.test(text)) return true
  if (/\.git(?:#|$)/i.test(text)) return true
  if (/^ssh:\/\//i.test(text)) return true
  return false
}

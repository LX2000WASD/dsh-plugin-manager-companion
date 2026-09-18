/**
 * wire.ts — 把外来的 JSON（自有 REST / 官方 settings）归一成组件可以安全读取的对象。
 *
 * 归属：A 类·重写（旧仓库客户端对线缆数据一律 `as` 断言后直接渲染；本模块是新契约的
 *   失败模式驱动的，没有可参考的旧实现）。
 * 旧实现参考：dsh-web-plugin-manager/src/client/*（旧实现同样信任 host 返回的形状；
 *   未复制代码——差异是刻意的：旧实现把"数据一定齐全"当作前提，而实测证明它不成立）。
 * 官方复用：无。官方 primitives 只渲染、不校验；官方 settings 的 SettingsScopeController
 *   自带 schema 校验（packages/client/ui-settings/src/client/settings-scope.ts:202），
 *   但那只覆盖**官方 settings 通道**，本插件的自有 REST 通道没有这层保护。
 * 前提检查："外部数据一定符合 src/types.ts 声明的形状"这个前提**已被实测证伪**：
 *   host 的 JobRegistry.start() 返回裸 job id 字符串（docs/REST-CONTRACT.md 写的是
 *   `{ jobId }`），客户端把字符串当成报告，HealthPanel 在 `report.counts[layer]` 上抛
 *   TypeError，官方 SlotErrorBoundary 渲染一个空 div —— 用户看到的就是整页空白。
 *
 * 纪律（本模块存在的全部理由）：
 *   1. 归一**只发生在数据入口**（shared.ts 的控制器），组件里不再散落 `?? []`；
 *      这样"能通过类型检查的字段"与"运行期真的存在的字段"重新合一。
 *   2. 归一**不编造事实**：缺字段补的是"空/未知"（[] / 0 / undefined），不是看似合理的值；
 *      整份载荷不可用（不是对象、缺关键标识）时返回 undefined，由控制器如实报"失败"。
 *   3. 归一**不吞发现**：诊断报告里的每条 issue 都保留（枚举值未知时保留原值，
 *      由组件回退成原始 id 显示），不因为一个字段不认识就丢掉这条发现。
 *
 * 类型纪律：`src/types.ts` 是 wire 契约的唯一权威；本模块只做"运行期兑现契约"，
 * 不新增字段、不改语义。归一后的对象带完整类型，组件按类型读即可。
 */

import type {
  DiagnosticEvidence, DiagnosticFix, DiagnosticGroup, DiagnosticIssue, DiagnosticLayer,
  DiagnosticReport, DiagnosticScopeCount, DiagnosticSeverity, DiagnosticSkip, EnvironmentBackup,
  EnvironmentBackupDiff, EnvironmentInfo,
  EnvironmentResult, GatedInstallResult, InstalledKind, KindListResult, MarketItem,
  MarketItemKind, MarketplaceResult,
} from '../types.ts'
import type { OfficialCapabilities } from '../official.ts'
import type { CompanionConfig } from '../settings.ts'

// ── 基础读取（JSON 无关的窄工具）─────────────────────────────────────────

/** 一个 JSON 对象（非 null、非数组）。 */
type JsonObject = Record<string, unknown>

/** 是 JSON 对象时返回它，否则 undefined。 */
function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined
}

/** 是数组时返回它，否则空数组（缺字段与类型不对一视同仁：都没有内容可渲染）。 */
function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

/** 是非空字符串时返回它，否则 undefined。 */
function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/** 取字符串；非字符串时用 fallback。 */
function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** 取布尔；非布尔时用 fallback。 */
function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** 取有限数字并夹到区间内；非数字时用 fallback。 */
function number(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback
}

/** 取字符串数组（丢弃非字符串项）。 */
function texts(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === 'string')
}

// ── 官方能力探针 ────────────────────────────────────────────────────────

/**
 * 归一官方能力探针。
 *
 * 界面只读 `missing`（哪里能力缺失要如实告诉用户）。探针读不到时返回 undefined，
 * 调用方保持"未探到"，绝不伪造"能力齐全"。
 *
 * @param raw - capabilities op 的原始值。
 * @returns 探针结果；不可用时 undefined。
 */
export function normalizeCapabilities(raw: unknown): OfficialCapabilities | undefined {
  const record = asObject(raw)
  if (record === undefined) return undefined
  return {
    profileBacked: flag(record['profileBacked'], false),
    manager: flag(record['manager'], false),
    inventory: flag(record['inventory'], false),
    // 未知环境名用 null（host 侧 OfficialCapabilities 的同一语义），不是空串。
    environmentName: asText(record['environmentName']) ?? null,
    missing: texts(record['missing']),
  }
}

// ── 诊断报告 ────────────────────────────────────────────────────────────

/** 处置等级：未知值折叠成 report-only（未知一律不提供一键修复）。 */
function severity(raw: unknown): DiagnosticSeverity {
  return raw === 'safe-fix' || raw === 'confirm-fix' || raw === 'report-only' ? raw : 'report-only'
}

/**
 * 一条证据。
 *
 * @param raw - 原始项。
 * @param index - 在证据链里的下标（用于合成缺失的 at）。
 * @returns 归一后的证据；原始项不是对象时 undefined。
 */
function evidence(raw: unknown, index: number): DiagnosticEvidence | undefined {
  const record = asObject(raw)
  if (record === undefined) return undefined
  const kind = record['kind']
  return {
    kind: kind === 'file' || kind === 'runtime' || kind === 'official' ? kind : 'runtime',
    at: text(record['at'], '(unknown #' + String(index + 1) + ')'),
    note: text(record['note']),
  }
}

/** 一个修复动作；缺 action 或 summary 时视为"没有修复路径"。 */
function fixOf(raw: unknown): DiagnosticFix | undefined {
  const record = asObject(raw)
  if (record === undefined) return undefined
  const action = asText(record['action'])
  if (action === undefined) return undefined
  const target = asText(record['target'])
  return {
    action,
    ...target === undefined ? {} : { target },
    summary: text(record['summary']),
  }
}

/**
 * 一条发现。字段齐全性由本函数负责；枚举值未知时**保留原值**（组件回退显示原始 id），
 * 不因为一个字段不认识就丢掉整条发现。
 *
 * @param raw - 原始项。
 * @param index - 报告内下标（用于合成缺失的 id）。
 * @returns 归一后的发现；原始项不是对象时 undefined。
 */
function issue(raw: unknown, index: number): DiagnosticIssue | undefined {
  const record = asObject(raw)
  if (record === undefined) return undefined
  const code = text(record['code'], 'unknown')
  const layer = record['layer']
  const fix = fixOf(record['fix'])
  const scope = asText(record['scope'])
  return {
    id: text(record['id'], code + '#' + String(index + 1)),
    layer: typeof layer === 'string' ? layer as DiagnosticLayer : 'dependency',
    severity: severity(record['severity']),
    code,
    title: text(record['title'], code),
    detail: text(record['detail']),
    subjects: texts(record['subjects']),
    // 归属包名（噪声治理的分组依据）：透传，缺省即"无法归属"。
    ...scope === undefined ? {} : { scope },
    evidence: asArray(record['evidence'])
      .map((item, at) => evidence(item, at))
      .filter((item): item is DiagnosticEvidence => item !== undefined),
    ...fix === undefined ? {} : { fix },
  }
}

/** 一个作用域在组里的命中条数。 */
function scopeCount(raw: unknown): DiagnosticScopeCount | undefined {
  const record = asObject(raw)
  if (record === undefined) return undefined
  const scope = asText(record['scope'])
  if (scope === undefined) return undefined
  return { scope, count: number(record['count'], 0, 0, Number.MAX_SAFE_INTEGER) }
}

/**
 * 一个分组。
 *
 * 分组是噪声治理的**呈现契约**（host 把同层同码同级的命中折成一组，逐条 issues 一条不少）。
 * 这里只透传与校验：缺 key/code 的组无法渲染也无法与发现对齐，直接丢弃。
 *
 * @param raw - 原始项。
 * @param index - 报告内下标（用于合成缺失的 key）。
 * @returns 归一后的分组；原始项不是对象或缺关键字段时 undefined。
 */
function group(raw: unknown, index: number): DiagnosticGroup | undefined {
  const record = asObject(raw)
  if (record === undefined) return undefined
  const code = asText(record['code'])
  if (code === undefined) return undefined
  const layer = record['layer']
  const exampleTitle = asText(record['exampleTitle'])
  return {
    key: text(record['key'], code + '#' + String(index + 1)),
    layer: typeof layer === 'string' ? layer as DiagnosticLayer : 'dependency',
    code,
    severity: severity(record['severity']),
    count: number(record['count'], 0, 0, Number.MAX_SAFE_INTEGER),
    scopes: asArray(record['scopes'])
      .map(item => scopeCount(item))
      .filter((item): item is DiagnosticScopeCount => item !== undefined),
    subjects: texts(record['subjects']),
    ...exampleTitle === undefined ? {} : { exampleTitle },
  }
}

/**
 * 一条跳过记录。
 *
 * `layers` 必须**原样透传**：它是引擎的事实，界面据此区分"这一层查过且没问题"与
 * "这一层根本没查"。复数而不是单数是有据可依的——有的能力缺失会同时废掉两层
 * （runtime-inventory 缺失 → runtime 与 consistency 都没查），单数会把另一层错标成
 * "查过了、没问题"。客户端**不能**靠 check 字符串的形状反推层：那是约定耦合，
 * check 一改名就会静默退化成"显示 0"（把没查画成没问题）。
 *
 * 归一在这里只做校验，三条规则：
 *   1. 引擎给的、且是已知层名的项才保留；
 *   2. 未知层名**不发明**（丢掉该项，而不是映射到某一层）；
 *   3. 非层级跳过（如 environment-dir）不带本字段——它不代表整层没查。
 *
 * @param raw - 原始项。
 * @param index - 报告内下标（用于合成缺失的 check）。
 * @param known - 已知的层名（调用方从 LAYER_ORDER 传进来）。
 * @returns 归一后的跳过记录；原始项不是对象时 undefined。
 */
function skip(raw: unknown, index: number, known: readonly DiagnosticLayer[]): DiagnosticSkip | undefined {
  const record = asObject(raw)
  if (record === undefined) return undefined
  const layers = texts(record['layers'])
    .filter((name): name is DiagnosticLayer => known.includes(name as DiagnosticLayer))
  return {
    check: text(record['check'], 'unknown#' + String(index + 1)),
    reason: text(record['reason']),
    ...layers.length === 0 ? {} : { layers },
  }
}

/**
 * 归一一次诊断的报告。
 *
 * 各层计数由**归一后的发现**重新统计（而不是信线缆上的 counts）：界面上的"各层计数"
 * 必须与用户能数出来的列表一致，两者矛盾时以列表为准。传入的 `layers` 决定总览网格
 * 里哪些层有确定的 0 值（缺层不能渲染成 undefined）。
 *
 * @param raw - diagnose job 的结果。
 * @param layers - 已知的层（本插件来自 shared.ts 的 LAYER_ORDER）。
 * @returns 报告；整份载荷不可用时 undefined（调用方如实报失败，不渲染半个报告）。
 */
export function normalizeReport(raw: unknown, layers: readonly DiagnosticLayer[]): DiagnosticReport | undefined {
  const record = asObject(raw)
  if (record === undefined) return undefined
  const issues = asArray(record['issues'])
    .map((item, index) => issue(item, index))
    .filter((item): item is DiagnosticIssue => item !== undefined)
  const counts: Record<string, number> = {}
  for (const layer of layers) counts[layer] = 0
  for (const item of issues) counts[item.layer] = (counts[item.layer] ?? 0) + 1
  const groups = asArray(record['groups'])
    .map((item, index) => group(item, index))
    .filter((item): item is DiagnosticGroup => item !== undefined)
  return {
    environment: text(record['environment']),
    generatedAt: text(record['generatedAt'], new Date().toISOString()),
    counts: counts as unknown as Readonly<Record<DiagnosticLayer, number>>,
    issues,
    skipped: asArray(record['skipped'])
      .map((item, index) => skip(item, index, layers))
      .filter((item): item is DiagnosticSkip => item !== undefined),
    // groups 是可选的线上契约字段：没有就保持没有（界面据此走"逐条列表"路径）。
    ...groups.length === 0 ? {} : { groups },
  }
}

// ── 环境 ────────────────────────────────────────────────────────────────

/**
 * 归一一个环境实例的进程记录。
 *
 * @param raw - 原始项。
 * @returns 归一后的记录；缺 pid 时 undefined（没有 pid 的"运行实例"无法展示也无法停止）。
 */
function run(raw: unknown): EnvironmentInfo['runs'][number] | undefined {
  const record = asObject(raw)
  if (record === undefined) return undefined
  const pid = record['pid']
  if (typeof pid !== 'number' || !Number.isFinite(pid)) return undefined
  const port = record['port']
  return {
    pid,
    port: typeof port === 'number' && Number.isFinite(port) ? port : null,
    command: text(record['command']),
  }
}

/**
 * 归一环境列表。
 *
 * 环境名是这张表的唯一标识（也是后续所有跨环境操作的参数），缺名字的项无法渲染也
 * 无法操作，直接丢弃。
 *
 * @param raw - listEnvironments op 的结果。
 * @returns 环境列表；载荷不可用（不是数组）时 undefined。
 */
export function normalizeEnvironments(raw: unknown): EnvironmentInfo[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: EnvironmentInfo[] = []
  for (const item of raw) {
    const record = asObject(item)
    if (record === undefined) continue
    const name = asText(record['name'])
    if (name === undefined) continue
    out.push({
      name,
      dir: text(record['dir']),
      current: flag(record['current'], false),
      builtin: flag(record['builtin'], false),
      bundles: texts(record['bundles']),
      dependencies: texts(record['dependencies']),
      runs: asArray(record['runs'])
        .map(entry => run(entry))
        .filter((entry): entry is EnvironmentInfo['runs'][number] => entry !== undefined),
    })
  }
  return out
}

/**
 * 归一一次变更类操作的结果。
 *
 * `output` 是给用户看的原始诊断，缺失时不能把 undefined 塞进 Toast（那会渲染成空提示）。
 *
 * @param raw - 操作结果。
 * @returns 结果；不是对象时按失败处理（ok=false），绝不当作成功。
 */
export function normalizeEnvironmentResult(raw: unknown): EnvironmentResult {
  const record = asObject(raw)
  if (record === undefined) {
    return { ok: false, output: '', code: 'malformed-result' }
  }
  const code = asText(record['code'])
  return {
    ok: record['ok'] === true,
    output: text(record['output']),
    ...code === undefined ? {} : { code },
  }
}

// ── 备份 ────────────────────────────────────────────────────────────────

/** 备份文档的格式标识（与 src/types.ts 的 BackupFormat 同字面量；这里只做校验，不产出）。 */
const BACKUP_FORMAT = 'dsh-plugin-manager-companion/environment-backup'

/** 包名 → 安装来源 spec。 */
function sources(raw: unknown): Record<string, string> | undefined {
  const record = asObject(raw)
  if (record === undefined) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

/**
 * 归一一份环境备份（导出结果与用户导入的文件走同一个入口）。
 *
 * 归一失败意味着"这不是本插件的备份"：`backupRestore` 会据此改写目标环境的 manifest，
 * 宁可拒绝也不能猜。
 *
 * @param raw - 备份文档。
 * @returns 备份；形状不符时 undefined。
 */
export function normalizeBackup(raw: unknown): EnvironmentBackup | undefined {
  const record = asObject(raw)
  if (record === undefined) return undefined
  const dependencies = sources(record['dependencies'])
  if (record['format'] !== BACKUP_FORMAT || record['version'] !== 1 || dependencies === undefined) return undefined
  const bundles = record['bundles']
  if (!Array.isArray(bundles)) return undefined
  return {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: text(record['exportedAt']),
    environment: text(record['environment']),
    bundles: texts(bundles),
    dependencies,
  }
}

/** 一条"需要重装"的条目。 */
function missingEntry(raw: unknown): EnvironmentBackupDiff['missing'][number] | undefined {
  const record = asObject(raw)
  if (record === undefined) return undefined
  const name = asText(record['name'])
  if (name === undefined) return undefined
  return { name, source: text(record['source']) }
}

/**
 * 归一备份差异。
 *
 * 五个分类都会渲染，缺一个就是渲染期崩溃——所以每一类都归一成数组。
 *
 * @param raw - backupDiff op 的结果。
 * @returns 差异；载荷不可用时 undefined。
 */
export function normalizeBackupDiff(raw: unknown): EnvironmentBackupDiff | undefined {
  const record = asObject(raw)
  if (record === undefined) return undefined
  return {
    ok: record['ok'] === true,
    missing: asArray(record['missing'])
      .map(entry => missingEntry(entry))
      .filter((entry): entry is EnvironmentBackupDiff['missing'][number] => entry !== undefined),
    already: texts(record['already']),
    missingProfiles: texts(record['missingProfiles']),
    unrestorable: texts(record['unrestorable']),
    bundlesMissing: texts(record['bundlesMissing']),
  }
}

// ── 市场 ────────────────────────────────────────────────────────────────

/** 条目类型的合法值（与 src/types.ts 的 MarketItemKind 同集合）。 */
const KINDS: readonly MarketItemKind[] = ['cordis-plugin', 'skill', 'agent-preset', 'unknown']

/**
 * 归一一条市场条目。
 *
 * 条目名与 repo 是卡片的主键（也是安装参数），缺任一个都无法展示也无法安装。
 * 其余字段全部给出确定值——渲染侧（含 marketView / tags 的纯函数）因此可以
 * 按类型直接读，不必每个使用点再判空。
 *
 * @param raw - 原始条目。
 * @returns 归一后的条目；缺主键时 undefined。
 */
function marketItem(raw: unknown): MarketItem | undefined {
  const record = asObject(raw)
  if (record === undefined) return undefined
  const repo = asText(record['repo'])
  if (repo === undefined) return undefined
  const kind = record['kind']
  const optional = {
    category: asText(record['category']),
    installedVersion: asText(record['installedVersion']),
    latestVersion: asText(record['latestVersion']),
  }
  return {
    repo,
    name: text(record['name'], repo),
    description: text(record['description']),
    stars: typeof record['stars'] === 'number' && Number.isFinite(record['stars']) ? record['stars'] : null,
    updatedAt: asText(record['updatedAt']) ?? null,
    topics: texts(record['topics']),
    ...optional.category === undefined ? {} : { category: optional.category },
    ...record['installed'] === true ? { installed: true } : {},
    ...optional.installedVersion === undefined ? {} : { installedVersion: optional.installedVersion },
    ...optional.latestVersion === undefined ? {} : { latestVersion: optional.latestVersion },
    ...KINDS.includes(kind as MarketItemKind) ? { kind: kind as MarketItemKind } : {},
  }
}

/**
 * 归一市场查询结果。
 *
 * @param raw - marketplace op 的结果。
 * @returns 结果；载荷不可用时 undefined。
 */
export function normalizeMarketplace(raw: unknown): MarketplaceResult | undefined {
  const record = asObject(raw)
  if (record === undefined) return undefined
  const categories: Record<string, number> = {}
  for (const [key, value] of Object.entries(asObject(record['categories']) ?? {})) {
    if (typeof value === 'number' && Number.isFinite(value)) categories[key] = value
  }
  return {
    items: asArray(record['items'])
      .map(item => marketItem(item))
      .filter((item): item is MarketItem => item !== undefined),
    generatedAt: text(record['generatedAt'], new Date().toISOString()),
    cached: record['cached'] === true,
    categories,
  }
}

/**
 * 归一受质量门保护的安装结果。
 *
 * @param raw - install op 的结果。
 * @returns 结果；载荷不可用时按失败处理。
 */
export function normalizeGatedInstall(raw: unknown): GatedInstallResult {
  const record = asObject(raw)
  if (record === undefined) return { ok: false, output: '', gateIssues: [], rolledBack: false }
  const packageName = asText(record['packageName'])
  return {
    ok: record['ok'] === true,
    output: text(record['output']),
    ...packageName === undefined ? {} : { packageName },
    gateIssues: texts(record['gateIssues']),
    ...record['rolledBack'] === true ? { rolledBack: true } : {},
  }
}

// ── 技能与预设 ──────────────────────────────────────────────────────────

/** 一条已安装资源。 */
function kindRecord(raw: unknown): InstalledKind | undefined {
  const record = asObject(raw)
  if (record === undefined) return undefined
  const repo = asText(record['repo'])
  if (repo === undefined) return undefined
  const kind = record['kind']
  const commit = asText(record['commit'])
  return {
    kind: KINDS.includes(kind as MarketItemKind) ? kind as MarketItemKind : 'unknown',
    repo,
    dir: text(record['dir']),
    installedAt: text(record['installedAt'], ''),
    ...commit === undefined ? {} : { commit },
  }
}

/**
 * 归一技能与预设列表。
 *
 * @param raw - listKinds op 的结果。
 * @returns 结果；载荷不可用时 undefined。
 */
export function normalizeKindList(raw: unknown): KindListResult | undefined {
  const record = asObject(raw)
  if (record === undefined) return undefined
  return {
    records: asArray(record['records'])
      .map(item => kindRecord(item))
      .filter((item): item is InstalledKind => item !== undefined),
    orphans: texts(record['orphans']),
  }
}

// ── 插件配置（官方 settings 的镜像）──────────────────────────────────────

/**
 * 客户端默认配置。
 *
 * 值与 host 侧 src/settings.ts 的 DEFAULT_CONFIG 必须一致。刻意不 import 那个模块：
 * 它是 host 模块（值会拉进 schemastery 与整套 host 代码），客户端只认这份镜像。
 * 这一层只在"官方 settings 文档残缺"时兜底——正式来源仍是官方 settings 服务。
 */
const CLIENT_DEFAULTS: CompanionConfig = {
  diagnostics: { dependency: true, composition: true, runtime: true, consistency: true, ecosystem: false },
  qualityGate: { enabled: true, mode: 'block', allowlist: [] },
  marketplace: { enabled: true, cacheTtlMinutes: 1440, timeoutMs: 15_000, indexUrl: '' },
}

/** 归一后的配置与"哪些字段是补出来的"。 */
export interface NormalizedConfig {
  readonly config: CompanionConfig
  /** 由默认值补上的字段路径（用于如实告诉用户：这不是宿主给的完整配置）。 */
  readonly filled: readonly string[]
}

/**
 * 归一插件配置：逐字段校验，缺失/类型不符的用客户端默认值补齐。
 *
 * 为什么是"补齐后渲染"而不是"提示尚未就绪"：这个表单写的是**字段级** op（官方 settings
 * 的 mutate 按路径写），补出来的字段不会被回写；而用户点开设置页的目的正是看到并改一个
 * 具体字段——空白或只有一句提示等于什么都做不了。补的是默认值这一事实会通过
 * `filled` 如实显示出来，不伪装成"宿主就是这么配的"。
 *
 * @param raw - settings 快照里的命名空间值（允许残缺）。
 * @returns 归一后的配置与补出来的字段；`raw` 不是对象时 undefined（连一个字段都没有）。
 */
export function normalizeConfig(raw: unknown): NormalizedConfig | undefined {
  const record = asObject(raw)
  if (record === undefined) return undefined
  const filled: string[] = []
  const group = (name: 'diagnostics' | 'qualityGate' | 'marketplace'): JsonObject => {
    const value = record[name]
    const object = asObject(value)
    if (object === undefined) filled.push(name)
    return object ?? {}
  }

  const diagnostics = group('diagnostics')
  const qualityGate = group('qualityGate')
  const marketplace = group('marketplace')

  // 记一笔"这个字段宿主没给"，值由各字段自己的归一函数（flag / number / texts）给出。
  // qualified 是用于报账的完整路径，查找用的是它最后一段（字段都取自自己的分组对象）。
  const read = <T>(source: JsonObject, qualified: string, value: T): T => {
    const name = qualified.slice(qualified.lastIndexOf('.') + 1)
    if (source[name] === undefined) filled.push(qualified)
    return value
  }

  const defaults = CLIENT_DEFAULTS
  const config: CompanionConfig = {
    diagnostics: {
      dependency: read(diagnostics, 'diagnostics.dependency', flag(diagnostics['dependency'], defaults.diagnostics.dependency)),
      composition: read(diagnostics, 'diagnostics.composition', flag(diagnostics['composition'], defaults.diagnostics.composition)),
      runtime: read(diagnostics, 'diagnostics.runtime', flag(diagnostics['runtime'], defaults.diagnostics.runtime)),
      consistency: read(diagnostics, 'diagnostics.consistency', flag(diagnostics['consistency'], defaults.diagnostics.consistency)),
      ecosystem: read(diagnostics, 'diagnostics.ecosystem', flag(diagnostics['ecosystem'], defaults.diagnostics.ecosystem)),
    },
    qualityGate: {
      enabled: read(qualityGate, 'qualityGate.enabled', flag(qualityGate['enabled'], defaults.qualityGate.enabled)),
      mode: read(qualityGate, 'qualityGate.mode', qualityGate['mode'] === 'warn' ? 'warn' as const : qualityGate['mode'] === 'block' ? 'block' as const : defaults.qualityGate.mode),
      allowlist: read(qualityGate, 'qualityGate.allowlist', texts(qualityGate['allowlist'])),
    },
    marketplace: {
      enabled: read(marketplace, 'marketplace.enabled', flag(marketplace['enabled'], defaults.marketplace.enabled)),
      cacheTtlMinutes: read(marketplace, 'marketplace.cacheTtlMinutes', number(marketplace['cacheTtlMinutes'], defaults.marketplace.cacheTtlMinutes, 1, 10_080)),
      timeoutMs: read(marketplace, 'marketplace.timeoutMs', number(marketplace['timeoutMs'], defaults.marketplace.timeoutMs, 1_000, 120_000)),
      indexUrl: read(marketplace, 'marketplace.indexUrl', text(marketplace['indexUrl'])),
    },
  }
  return { config, filled }
}

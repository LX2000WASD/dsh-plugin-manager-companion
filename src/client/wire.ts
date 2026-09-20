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
  EnvironmentBackupDiff, EnvironmentInfo, ManifestField,
  EnvironmentResult, GatedInstallResult, InstalledKind, KindListResult, MarketInstallable, MarketItem,
  MarketItemKind, MarketRiskFlag, MarketplaceResult, MarketRiskTier,
  TrialCleanupResult, TrialEnvironmentReport,
} from '../types.ts'
import type { OfficialCapabilities } from '../official.ts'
import type { CompanionConfig, TrialConfig, TrialDisclosure } from '../settings.ts'

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

// ── 「关于」页的事实（about op，task-95）─────────────────────────────────

/**
 * 一条可能读不到的事实（与 host 的 `AboutFact<T>` 同构）。
 *
 * 客户端**不做**二次归一（例如把 unknown 折成空串）：那会抹掉"读不到"与"读到了空值"的区别，
 * 而界面正是靠这个区别决定显示"未知"还是显示值（§12.3.3）。
 */
export type AboutFactView<T> =
  | { readonly value: T; readonly source: string }
  | { readonly unknown: string }

/** 「关于」页的全部事实（客户端视图）。 */
export interface AboutFactsView {
  readonly runtime: {
    readonly version: AboutFactView<string>
    readonly installAnchor: AboutFactView<string>
  }
  readonly process: {
    readonly node: AboutFactView<string>
    readonly platform: AboutFactView<string>
    readonly arch: AboutFactView<string>
  }
  readonly companion: { readonly version: AboutFactView<string> }
  readonly profile: {
    readonly name: AboutFactView<string>
    readonly dir: AboutFactView<string>
  }
  readonly files: {
    readonly settingsPath: AboutFactView<string>
    readonly registryCachePath: AboutFactView<string>
    readonly registryCacheAgeMs: AboutFactView<number>
  }
}

/**
 * 归一一条事实。
 *
 * 判据：载荷里有**非空字符串的 `unknown`** 才算"读不到"；有可用 `value` 才算读到了。
 * 两者都缺（形状不对）时按 unknown 处理并给出原因——**绝不**折成"读到空值"：
 * 那会让界面上少一行错误提示，而多一个空白字段。
 *
 * @param raw - 原始值。
 * @param what - 字段名（写进形状不对时的原因里）。
 * @param parse - 值的解析器（字符串用 asText，数字用 optionalNumber）。
 * @returns 归一后的事实；形状不可用时给 unknown。
 */
function aboutFact<T>(raw: unknown, what: string, parse: (value: unknown) => T | undefined): AboutFactView<T> {
  const record = asObject(raw)
  if (record === undefined) return { unknown: what + '：载荷里没有这一条' }
  const unknown = asText(record['unknown'])
  if (unknown !== undefined) return { unknown }
  const value = parse(record['value'])
  if (value === undefined) return { unknown: what + '：载荷形状不对（既没有 unknown 也没有可用的 value）' }
  return { value, source: text(record['source']) }
}

/**
 * 归一一个事实组（同一形状反复出现，抽出来避免多处重复）。
 *
 * @param raw - 组对象。
 * @param fields - 组里的字段名。
 * @returns 逐字段的事实。
 */
function aboutStringFacts(raw: unknown, fields: readonly string[]): Record<string, AboutFactView<string>> {
  const record = asObject(raw)
  const out: Record<string, AboutFactView<string>> = {}
  for (const field of fields) out[field] = aboutFact(record?.[field], field, asText)
  return out
}

/**
 * 归一 `about` op 的结果。
 *
 * @param raw - op 的原始值。
 * @returns 视图；载荷整体不可用时 undefined（界面显示"读不到"并给重试，而不是画一张空表）。
 */
export function normalizeAbout(raw: unknown): AboutFactsView | undefined {
  const record = asObject(raw)
  if (record === undefined) return undefined
  const runtime = aboutStringFacts(record['runtime'], ['version', 'installAnchor'])
  const proc = aboutStringFacts(record['process'], ['node', 'platform', 'arch'])
  const companion = aboutStringFacts(record['companion'], ['version'])
  const profile = aboutStringFacts(record['profile'], ['name', 'dir'])
  const files = asObject(record['files'])
  const required = (group: Record<string, AboutFactView<string>>, field: string): AboutFactView<string> =>
    group[field] ?? { unknown: field + '：载荷里没有这一条' }
  return {
    runtime: {
      version: required(runtime, 'version'),
      installAnchor: required(runtime, 'installAnchor'),
    },
    process: {
      node: required(proc, 'node'),
      platform: required(proc, 'platform'),
      arch: required(proc, 'arch'),
    },
    companion: { version: required(companion, 'version') },
    profile: { name: required(profile, 'name'), dir: required(profile, 'dir') },
    files: {
      settingsPath: aboutFact(files?.['settingsPath'], 'settingsPath', asText),
      registryCachePath: aboutFact(files?.['registryCachePath'], 'registryCachePath', asText),
      // 年龄是数字：asText 会把数字拒掉，所以单独一个解析器。
      registryCacheAgeMs: aboutFact(files?.['registryCacheAgeMs'], 'registryCacheAgeMs', optionalNumber),
    },
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
 * 归一 unknownFields：只保留闭集（ManifestField）里的名字，去重。
 *
 * 线上载荷可能来自旧版本或脏数据；未知名字不发明"未知"——与 runs / issues 的归一口径一致。
 *
 * @param raw - 线缆上的 unknownFields。
 * @returns 只含已知字段名的数组（可能为空）。
 */
function unknownManifestFields(raw: unknown): ManifestField[] {
  const seen = new Set<ManifestField>()
  for (const name of texts(raw)) {
    // 用可穷尽表而不是字符串字面量比较：ManifestField 一扩展，MANIFEST_FIELDS 就编译报错，
    // 于是"过滤"不可能变成静默吞字段。
    if (Object.hasOwn(MANIFEST_FIELDS, name)) seen.add(name as ManifestField)
  }
  return [...seen]
}

/**
 * 派生字段闭集的可穷尽表。
 *
 * 过滤本身是必要的（线缆上的名字不受我们控制），但**过滤不能静默漏**：以后有人给
 * ManifestField 加第三个成员时，这里少一个键就编译不过，实现者必须同时决定界面怎么显示。
 * （host 侧类型收紧 + 边界处不静默丢弃，是两件事。）
 */
const MANIFEST_FIELDS: Record<ManifestField, true> = { bundles: true, dependencies: true }

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
      // 读不出来的派生字段：只认闭集里的名字（未知名字不发明"未知"）——
      // 口径与层归属那次一致：只透传引擎给出的已知事实。
      ...(unknownManifestFields(record['unknownFields']).length === 0
        ? {}
        : { unknownFields: unknownManifestFields(record['unknownFields']) }),
      // 原因只在确实读不懂时带，且必须是非空字符串（空串等于没有原因）。
      ...(typeof record['unknownReason'] === 'string' && record['unknownReason'] !== ''
        ? { unknownReason: record['unknownReason'] as string }
        : {}),
      dependencies: texts(record['dependencies']),
      runs: asArray(record['runs'])
        .map(entry => run(entry))
        .filter((entry): entry is EnvironmentInfo['runs'][number] => entry !== undefined),
      // 进程事实**是否可读**：只有明确的 false 才带（缺字段/任何其它取值一律按可读处理，不发明"未知"）。
      // 读数归零不能推成"没在运行"——"runs 是空数组"与"我看不见进程表"是两件事。
      ...(record['runsKnown'] === false ? { runsKnown: false } : {}),
      // 原因只在 false 且是非空字符串时带。
      ...(record['runsKnown'] === false && typeof record['runsUnknownReason'] === 'string'
        && record['runsUnknownReason'] !== ''
        ? { runsUnknownReason: record['runsUnknownReason'] as string }
        : {}),
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

/** 上游风险明细的透传上限（与 host 侧 registry.ts 的 RISK_FLAG_LIMIT 对齐）。 */
const RISK_FLAG_LIMIT = 12

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
    packageName: asText(record['packageName']),
    installSpec: asText(record['installSpec']),
    installable: asInstallable(record['installable']),
    riskTier: asRiskTier(record['riskTier']),
    reportUrl: asHttpsUrl(record['reportUrl']),
    license: asText(record['license']),
    verifiedBy: asText(record['verifiedBy']),
    verifiedAt: asText(record['verifiedAt']),
  }
  const marketTags = texts(record['marketTags'])
  const riskFlags = riskFlagList(record['riskFlags'])
  const starsDelta7d = typeof record['starsDelta7d'] === 'number' && Number.isFinite(record['starsDelta7d'])
    ? record['starsDelta7d']
    : undefined
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
    ...optional.packageName === undefined ? {} : { packageName: optional.packageName },
    ...optional.installSpec === undefined ? {} : { installSpec: optional.installSpec },
    ...optional.installable === undefined ? {} : { installable: optional.installable },
    ...optional.riskTier === undefined ? {} : { riskTier: optional.riskTier },
    ...riskFlags === undefined ? {} : { riskFlags },
    ...optional.reportUrl === undefined ? {} : { reportUrl: optional.reportUrl },
    ...marketTags.length === 0 ? {} : { marketTags },
    ...record['archived'] === true ? { archived: true } : {},
    ...starsDelta7d === undefined ? {} : { starsDelta7d },
    ...optional.license === undefined ? {} : { license: optional.license },
    ...optional.verifiedBy === undefined ? {} : { verifiedBy: optional.verifiedBy },
    ...optional.verifiedAt === undefined ? {} : { verifiedAt: optional.verifiedAt },
  }
}

/**
 * 归一上游可装性标记：只认上游那两个值，其余（含未知新值）一律丢掉。
 *
 * 为什么未知值不原样透传：这个字段的**每个值都会变成一个徽标或一次过滤**，
 * 上游新增取值时我们希望它变成"没有标记"，而不是画出一个我们还没定义文案的徽标。
 */
function asInstallable(value: unknown): MarketInstallable | undefined {
  return value === 'manual' || value === 'non-plugin' ? value : undefined
}

/** 归一上游风险等级：同上，只认 safe / caution / risk。 */
function asRiskTier(value: unknown): MarketRiskTier | undefined {
  return value === 'safe' || value === 'caution' || value === 'risk' ? value : undefined
}

/** 归一外链：只接受 https（它会被渲染成 href）。 */
function asHttpsUrl(value: unknown): string | undefined {
  const text = asText(value)
  return text !== undefined && text.startsWith('https://') ? text : undefined
}

/** 归一风险明细：缺 id 的条目丢掉（详情里它就是一行证据，没有 id 无从指认）；超长截断。 */
function riskFlagList(value: unknown): readonly MarketRiskFlag[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: MarketRiskFlag[] = []
  for (const entry of value) {
    const record = asObject(entry)
    if (record === undefined) continue
    const id = asText(record['id'])
    if (id === undefined) continue
    out.push({ id, severity: asText(record['severity']) ?? '', category: asText(record['category']) ?? '' })
    if (out.length >= RISK_FLAG_LIMIT) break
  }
  return out.length === 0 ? undefined : out
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
  const notes = texts(record['notes'])
  const source = asText(record['source'])
  return {
    items: asArray(record['items'])
      .map(item => marketItem(item))
      .filter((item): item is MarketItem => item !== undefined),
    generatedAt: text(record['generatedAt'], new Date().toISOString()),
    cached: record['cached'] === true,
    categories,
    ...source === undefined ? {} : { source },
    ...record['stale'] === true ? { stale: true } : {},
    ...notes.length === 0 ? {} : { notes },
  }
}

/**
 * 归一受质量门保护的安装结果。
 *
 * @param raw - install op 的结果。
 * @returns 结果；载荷不可用时按失败处理。
 */
export function normalizeGatedInstall(raw: unknown): GatedInstallView {
  const record = asObject(raw)
  if (record === undefined) return { ok: false, output: '', gateIssues: [], rolledBack: false }
  const packageName = asText(record['packageName'])
  const trial = normalizeTrialOutcome(record['trial'])
  return {
    ok: record['ok'] === true,
    output: text(record['output']),
    ...packageName === undefined ? {} : { packageName },
    gateIssues: texts(record['gateIssues']),
    ...record['rolledBack'] === true ? { rolledBack: true } : {},
    ...trial === undefined ? {} : { trial },
  }
}

// ── 试装（质量门第二步）：安装结论、告知事实、测试环境 ────────────────────

/**
 * 一次安装里的试装结论（客户端视图）。
 *
 * 枚举值（conclusion / policy / depth / baseline / candidate）**原样保留字符串**，
 * 不在这里映射成已知集合：宿主新增一档结论时，界面要能如实显示原始值，而不是把它吞掉
 * 或猜成最接近的一档（本模块纪律 3：归一不吞发现）。文案映射在组件层，未知值回退显示原值。
 */
export interface TrialOutcomeView {
  readonly conclusion: string
  readonly policy: string
  readonly policyNote: string
  readonly output: string
  readonly elapsedMs: number
  readonly escalated: boolean
  readonly depth?: string
  readonly escalationReason?: string
  readonly baseline?: string
  readonly candidate?: string
}

/** 受质量门保护的安装结果的客户端视图：`trial` 换成上面那个视图。 */
export type GatedInstallView = Omit<GatedInstallResult, 'trial'> & { readonly trial?: TrialOutcomeView }

/**
 * 归一一次试装结论。
 *
 * @param raw - `GatedInstallResult.trial`。
 * @returns 结论视图；载荷不是对象或缺 conclusion/policy 时 undefined（"这次没试装"与"读不出来"都不许编造结论）。
 */
function normalizeTrialOutcome(raw: unknown): TrialOutcomeView | undefined {
  const record = asObject(raw)
  if (record === undefined) return undefined
  const conclusion = asText(record['conclusion'])
  const policy = asText(record['policy'])
  if (conclusion === undefined || policy === undefined) return undefined
  const elapsed = record['elapsedMs']
  const depth = asText(record['depth'])
  const escalationReason = asText(record['escalationReason'])
  const baseline = asText(record['baseline'])
  const candidate = asText(record['candidate'])
  return {
    conclusion,
    policy,
    policyNote: text(record['policyNote']),
    output: text(record['output']),
    elapsedMs: typeof elapsed === 'number' && Number.isFinite(elapsed) ? elapsed : 0,
    escalated: record['escalated'] === true,
    ...depth === undefined ? {} : { depth },
    ...escalationReason === undefined ? {} : { escalationReason },
    ...baseline === undefined ? {} : { baseline },
    ...candidate === undefined ? {} : { candidate },
  }
}

/**
 * 试装开启前必须让用户看到的事实。
 *
 * 数字与口径**必须一起**给出：只有数字没有 measurement 时返回 undefined（宁可不显示，
 * 也不给一个没有口径的数字——那正是"把不知道说成知道"）。
 */
export interface TrialDisclosureView {
  readonly executesCandidateCode: boolean
  readonly peakMemoryMiB: number
  readonly measurement: string
}

/**
 * 归一试装告知事实（来自 capabilities op 的 `trialDisclosure`）。
 *
 * @param raw - `capabilities.trialDisclosure`。
 * @returns 告知事实；数字或口径缺失/不可读时 undefined（界面显示"未知"，不硬编码）。
 */
export function normalizeTrialDisclosure(raw: unknown): TrialDisclosureView | undefined {
  const record = asObject(raw)
  if (record === undefined) return undefined
  const peak = record['peakMemoryMiB']
  const measurement = asText(record['measurement'])
  if (typeof peak !== 'number' || Number.isFinite(peak) === false || measurement === undefined) return undefined
  return { executesCandidateCode: record['executesCandidateCode'] === true, peakMemoryMiB: peak, measurement }
}

/**
 * 一个测试环境（`<真实环境名>-dpmc`）的只读事实。
 *
 * 布尔事实用 `undefined` 表示"宿主没给"，而不是 `false`：`false` 是一个结论
 * （"不在运行"、"归属环境没了"），不能拿它顶替"读不到"（DESIGN §12.3.3）。
 */
export interface TrialEnvironmentView {
  readonly name: string
  readonly owner: string
  readonly ownerExists: boolean | undefined
  readonly dir: string
  readonly running: boolean | undefined
  readonly modifiedAt: string
  readonly ageDays: number | undefined
  readonly bytes: number | null
  readonly bytesReason?: string
  readonly files: number
  readonly sharedFiles: number
  readonly snapshotMatchesOwner: boolean | null
}

/** 试装环境查询结果的客户端视图（`trialEnvironments` op）。 */
export interface TrialEnvironmentsView {
  readonly environments: readonly TrialEnvironmentView[]
  readonly factsReadable: boolean | undefined
  readonly factsReason?: string
  readonly totals: {
    readonly count: number
    readonly running: number | undefined
    readonly bytes: number
    readonly unknownBytes: number
  }
  readonly retention: {
    readonly days: number
    readonly autoCleanup: boolean
    readonly maxKept: number
  } | undefined
  readonly plan: {
    readonly remove: readonly { readonly name: string; readonly reason: string }[]
    readonly keep: readonly { readonly name: string; readonly reason: string }[]
  } | undefined
  readonly overCap: boolean | undefined
  readonly notes: readonly string[]
}

const optionalFlag = (value: unknown): boolean | undefined => typeof value === 'boolean' ? value : undefined

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** 归一一条试装环境。没有名字的条目直接丢弃（无法寻址的条目不能提供删除入口）。 */
function trialEnvironment(raw: unknown): TrialEnvironmentView | undefined {
  const record = asObject(raw)
  if (record === undefined) return undefined
  const name = asText(record['name'])
  if (name === undefined) return undefined
  const matches = record['snapshotMatchesOwner']
  const bytesReason = asText(record['bytesReason'])
  return {
    name,
    owner: text(record['owner']),
    ownerExists: optionalFlag(record['ownerExists']),
    dir: text(record['dir']),
    running: optionalFlag(record['running']),
    modifiedAt: text(record['modifiedAt'], ''),
    ageDays: optionalNumber(record['ageDays']),
    bytes: typeof record['bytes'] === 'number' && Number.isFinite(record['bytes']) ? record['bytes'] as number : null,
    ...bytesReason === undefined ? {} : { bytesReason },
    files: optionalNumber(record['files']) ?? 0,
    sharedFiles: optionalNumber(record['sharedFiles']) ?? 0,
    snapshotMatchesOwner: typeof matches === 'boolean' ? matches : null,
  }
}

const planEntries = (raw: unknown): readonly { readonly name: string; readonly reason: string }[] =>
  asArray(raw)
    .map((entry) => {
      const record = asObject(entry)
      const name = record === undefined ? undefined : asText(record['name'])
      return name === undefined ? undefined : { name, reason: text(record?.['reason']) }
    })
    .filter((entry): entry is { name: string; reason: string } => entry !== undefined)

/**
 * 归一试装环境查询结果。
 *
 * @param raw - `trialEnvironments` op 的结果。
 * @returns 视图；载荷不是对象时 undefined（控制器如实报"失败"，不渲染空列表当"没有测试环境"）。
 */
export function normalizeTrialEnvironments(raw: unknown): TrialEnvironmentsView | undefined {
  const record = asObject(raw)
  if (record === undefined) return undefined
  const totals = asObject(record['totals'])
  const retention = asObject(record['retention'])
  const plan = asObject(record['plan'])
  const factsReason = asText(record['factsReason'])
  const days = retention === undefined ? undefined : optionalNumber(retention['days'])
  const maxKept = retention === undefined ? undefined : optionalNumber(retention['maxKept'])
  const autoCleanup = retention === undefined ? undefined : optionalFlag(retention['autoCleanup'])
  return {
    environments: asArray(record['environments'])
      .map(trialEnvironment)
      .filter((entry): entry is TrialEnvironmentView => entry !== undefined),
    factsReadable: optionalFlag(record['factsReadable']),
    ...factsReason === undefined ? {} : { factsReason },
    totals: {
      count: (totals === undefined ? undefined : optionalNumber(totals['count'])) ?? 0,
      running: totals === undefined ? undefined : optionalNumber(totals['running']),
      bytes: (totals === undefined ? undefined : optionalNumber(totals['bytes'])) ?? 0,
      unknownBytes: (totals === undefined ? undefined : optionalNumber(totals['unknownBytes'])) ?? 0,
    },
    retention: days === undefined || maxKept === undefined || autoCleanup === undefined
      ? undefined
      : { days, autoCleanup, maxKept },
    plan: plan === undefined
      ? undefined
      : { remove: planEntries(plan['remove']), keep: planEntries(plan['keep']) },
    overCap: optionalFlag(record['overCap']),
    notes: texts(record['notes']),
  }
}

/** 一次清理的结果（`trialCleanup` op）：环境操作结果 + 实际删掉的名字。 */
export interface TrialCleanupView extends EnvironmentResult {
  readonly removed: readonly string[]
}

/**
 * 归一一次试装环境清理的结果。
 *
 * @param raw - `trialCleanup` op 的结果。
 * @returns 结果；载荷不可用时按失败处理（沿用环境操作结果的归一口径）。
 */
export function normalizeTrialCleanup(raw: unknown): TrialCleanupView {
  const record = asObject(raw)
  return { ...normalizeEnvironmentResult(raw), removed: texts(record === undefined ? undefined : record['removed']) }
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
const CLIENT_DEFAULTS: ClientConfig = {
  diagnostics: {
    dependency: true, composition: true, runtime: true, consistency: true, ecosystem: false,
    reportStaleModuleFallbackLinks: true,
  },
  qualityGate: { enabled: true, mode: 'block', allowlist: [] },
  marketplace: { enabled: true, cacheTtlMinutes: 1440, timeoutMs: 15_000, indexUrl: '' },
  // 与 host 侧 DEFAULT_TRIAL_CONFIG 逐字段一致（试装默认关：它会在用户机器上真实装包并执行对方代码）。
  trial: {
    enabled: false, depth: 'auto', baseline: true, allowNetwork: true,
    onFailure: 'block', autoCleanup: true, retentionDays: 14, maxKept: 0,
  },
}

/**
 * 归一后的插件配置。
 *
 * 与 host 侧 {@link CompanionConfig} 的唯一差别：`trial` 在 host 类型里是**可选**字段
 * （见 src/settings.ts 的说明），而归一后它一定存在——客户端不假设宿主给了它。
 */
export type ClientConfig = CompanionConfig & { readonly trial: TrialConfig }

/** 归一后的配置与"哪些字段是补出来的"。 */
export interface NormalizedConfig {
  readonly config: ClientConfig
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
  const group = (name: 'diagnostics' | 'qualityGate' | 'marketplace' | 'trial'): JsonObject => {
    const value = record[name]
    const object = asObject(value)
    if (object === undefined) filled.push(name)
    return object ?? {}
  }

  const diagnostics = group('diagnostics')
  const qualityGate = group('qualityGate')
  const marketplace = group('marketplace')
  const trial = group('trial')

  // 记一笔"这个字段宿主没给"，值由各字段自己的归一函数（flag / number / texts）给出。
  // qualified 是用于报账的完整路径，查找用的是它最后一段（字段都取自自己的分组对象）。
  const read = <T>(source: JsonObject, qualified: string, value: T): T => {
    const name = qualified.slice(qualified.lastIndexOf('.') + 1)
    if (source[name] === undefined) filled.push(qualified)
    return value
  }

  const defaults = CLIENT_DEFAULTS
  const config: ClientConfig = {
    diagnostics: {
      dependency: read(diagnostics, 'diagnostics.dependency', flag(diagnostics['dependency'], defaults.diagnostics.dependency)),
      composition: read(diagnostics, 'diagnostics.composition', flag(diagnostics['composition'], defaults.diagnostics.composition)),
      runtime: read(diagnostics, 'diagnostics.runtime', flag(diagnostics['runtime'], defaults.diagnostics.runtime)),
      consistency: read(diagnostics, 'diagnostics.consistency', flag(diagnostics['consistency'], defaults.diagnostics.consistency)),
      ecosystem: read(diagnostics, 'diagnostics.ecosystem', flag(diagnostics['ecosystem'], defaults.diagnostics.ecosystem)),
      reportStaleModuleFallbackLinks: read(diagnostics, 'diagnostics.reportStaleModuleFallbackLinks',
        flag(diagnostics['reportStaleModuleFallbackLinks'], defaults.diagnostics.reportStaleModuleFallbackLinks)),
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
    // 越界的数字一律回落默认值（与 host 的 effectiveTrialConfig 同一口径）：试装会写盘、会起进程，
    // 一个读到 undefined 的字段不能变成"意外地开启"或"意外地强制浅快照"。
    trial: {
      enabled: read(trial, 'trial.enabled', flag(trial['enabled'], defaults.trial.enabled)),
      depth: read(trial, 'trial.depth', trial['depth'] === 'shallow' || trial['depth'] === 'full' ? trial['depth'] : defaults.trial.depth),
      baseline: read(trial, 'trial.baseline', flag(trial['baseline'], defaults.trial.baseline)),
      allowNetwork: read(trial, 'trial.allowNetwork', flag(trial['allowNetwork'], defaults.trial.allowNetwork)),
      onFailure: read(trial, 'trial.onFailure', trial['onFailure'] === 'warn' ? 'warn' as const : trial['onFailure'] === 'block' ? 'block' as const : defaults.trial.onFailure),
      autoCleanup: read(trial, 'trial.autoCleanup', flag(trial['autoCleanup'], defaults.trial.autoCleanup)),
      retentionDays: read(trial, 'trial.retentionDays', number(trial['retentionDays'], defaults.trial.retentionDays, 1, 3_650)),
      maxKept: read(trial, 'trial.maxKept', number(trial['maxKept'], defaults.trial.maxKept, 0, 1_000)),
    },
  }
  return { config, filled }
}

// ── 升级（op: upgradeCheck / upgrade / upgradeRollback）──────────────────────

/**
 * 一条 dist-tag 的客户端视图。
 *
 * line 与 preferred **原样保留字符串/布尔**，不在这里映射成已知集合：host 新增一档线时，
 * 界面要能如实显示（未知线一律按"另一条线"提示，宁可多提醒一次也不谎报"同线"）。
 */
export interface UpgradeTagView {
  readonly tag: string
  readonly version: string
  readonly line: string
  readonly preferred: boolean
}

/**
 * 一个升级单元的客户端视图。
 *
 * state 原样保留：四态由 host 判定（docs/REST-CONTRACT.md），客户端**不自己推断**
 * （wire.ts 纪律 3：归一不吞发现）。未知状态值由 upgradeView.rowKindOf 归到 unknown，
 * 界面据此显示"查不到"而不是"已是最新"。
 */
export interface UpgradeUnitView {
  readonly name: string
  readonly kind: string
  readonly state: string
  readonly currentVersion: string | null
  readonly currentLine: string | null
  readonly spec?: string
  readonly targetVersion: string | null
  readonly targetTag: string | null
  readonly targetLine: string | null
  readonly tags: readonly UpgradeTagView[] | null
  readonly source?: string
  readonly at?: string
  readonly reason?: string
  readonly changesSource?: boolean
  readonly command?: string
}

/** 升级检查结果的客户端视图（op: upgradeCheck）。 */
export interface UpgradeCheckView {
  readonly environment: string
  readonly units: readonly UpgradeUnitView[]
  readonly checked: boolean
  readonly lastCheckAt: string | null
  readonly notes: readonly string[]
}

/**
 * 归一一条 dist-tag。
 *
 * 缺 tag 名或版本时丢弃这条（一个没有版本的 tag 无法作为升级目标）。
 *
 * @param raw - `UpgradeUnitReport.tags` 里的一项。
 * @returns 视图；不可用时 undefined。
 */
function upgradeTag(raw: unknown): UpgradeTagView | undefined {
  const record = asObject(raw)
  if (record === undefined) return undefined
  const tag = asText(record['tag'])
  const version = asText(record['version'])
  if (tag === undefined || version === undefined) return undefined
  return { tag, version, line: text(record['line'], 'unknown'), preferred: record['preferred'] === true }
}

/**
 * 归一一个升级单元。
 *
 * 没有名字的单元直接丢弃（无法寻址的单元不能提供升级入口）；tags 为 null 时保持 null
 * （那是"拿不到 tag 列表"这个事实本身，不能归一成空数组——空数组会被读成"没有 tag"）。
 *
 * @param raw - `UpgradeCheckResult.units` 里的一项。
 * @returns 视图；不可用时 undefined。
 */
function upgradeUnit(raw: unknown): UpgradeUnitView | undefined {
  const record = asObject(raw)
  if (record === undefined) return undefined
  const name = asText(record['name'])
  if (name === undefined) return undefined
  const tagsRaw = record['tags']
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw.map(upgradeTag).filter((tag): tag is UpgradeTagView => tag !== undefined)
    : null
  const spec = asText(record['spec'])
  const source = asText(record['source'])
  const at = asText(record['at'])
  const reason = asText(record['reason'])
  const command = asText(record['command'])
  return {
    name,
    kind: text(record['kind'], 'unknown'),
    state: text(record['state'], 'unknown'),
    currentVersion: asText(record['currentVersion']) ?? null,
    currentLine: asText(record['currentLine']) ?? null,
    ...spec === undefined ? {} : { spec },
    targetVersion: asText(record['targetVersion']) ?? null,
    targetTag: asText(record['targetTag']) ?? null,
    targetLine: asText(record['targetLine']) ?? null,
    tags,
    ...source === undefined ? {} : { source },
    ...at === undefined ? {} : { at },
    ...reason === undefined ? {} : { reason },
    ...record['changesSource'] === true ? { changesSource: true } : {},
    ...command === undefined ? {} : { command },
  }
}

/**
 * 归一一次升级检查结果。
 *
 * 载荷不是对象时返回 undefined：控制器据此如实报"失败"，**绝不**把它画成"没有可升级的包"
 * （那是把故障说成结论）。units 缺失时给空数组——"宿主说了一个单元都没有"与"读不出来"
 * 在契约里是两回事，前者合法。
 *
 * @param raw - upgradeCheck op 的结果。
 * @returns 视图；载荷不可用时 undefined。
 */
export function normalizeUpgradeCheck(raw: unknown): UpgradeCheckView | undefined {
  const record = asObject(raw)
  if (record === undefined) return undefined
  const lastCheckAt = asText(record['lastCheckAt'])
  return {
    environment: text(record['environment']),
    units: asArray(record['units'])
      .map(upgradeUnit)
      .filter((unit): unit is UpgradeUnitView => unit !== undefined),
    checked: record['checked'] === true,
    lastCheckAt: lastCheckAt ?? null,
    notes: texts(record['notes']),
  }
}

/**
 * 一次升级的金丝雀（试装）结论的客户端视图。
 *
 * ran 与 conclusion **都保留**：ran===false 时 conclusion 缺省，界面必须能从 ran 看出
 * "这次没验证"（DESIGN §5.5：没验证不等于通过）。
 */
export interface UpgradeCanaryView {
  readonly ran: boolean
  readonly conclusion?: string
  readonly depth?: string
  readonly escalated: boolean
  readonly elapsedMs?: number
  readonly output?: string
  readonly skippedReason?: string
  readonly cleanup: string
  readonly activated?: boolean
  readonly bundles?: readonly string[]
}

/**
 * 归一一次金丝雀报告。
 *
 * @param raw - `UpgradeActionResult.canary`。
 * @returns 视图；载荷不是对象时 undefined（"宿主没给金丝雀事实"，界面据此不宣称任何结论）。
 */
function upgradeCanary(raw: unknown): UpgradeCanaryView | undefined {
  const record = asObject(raw)
  if (record === undefined) return undefined
  const conclusion = asText(record['conclusion'])
  const depth = asText(record['depth'])
  const output = asText(record['output'])
  const skippedReason = asText(record['skippedReason'])
  const elapsed = record['elapsedMs']
  const activation = asObject(record['activation'])
  return {
    ran: record['ran'] === true,
    ...conclusion === undefined ? {} : { conclusion },
    ...depth === undefined ? {} : { depth },
    escalated: record['escalated'] === true,
    ...typeof elapsed === 'number' && Number.isFinite(elapsed) ? { elapsedMs: elapsed } : {},
    ...output === undefined ? {} : { output },
    ...skippedReason === undefined ? {} : { skippedReason },
    cleanup: text(record['cleanup']),
    ...activation === undefined ? {} : { activated: activation['activated'] === true },
    ...activation === undefined ? {} : { bundles: texts(activation['bundles']) },
  }
}

/** 一次升级结果的客户端视图（op: upgrade）。 */
export interface UpgradeActionView extends EnvironmentResult {
  readonly name: string
  readonly fromVersion: string | null
  readonly toVersion: string
  readonly spec: string
  readonly canary?: UpgradeCanaryView
  readonly diskFacts: readonly string[]
  readonly restartRequired: boolean
}

/**
 * 归一一次升级结果。
 *
 * 沿用环境操作结果的归一口径：载荷不可用时按失败处理（ok=false），绝不当作成功。
 * canary 缺失时**不补**一个"没跑"——"宿主没给这个字段"与"金丝雀没跑"是两件事，
 * 前者界面不许宣称任何验证结论。
 *
 * @param raw - upgrade op 的结果。
 * @returns 视图。
 */
export function normalizeUpgradeAction(raw: unknown): UpgradeActionView {
  const record = asObject(raw)
  const base = normalizeEnvironmentResult(raw)
  if (record === undefined) {
    return { ...base, name: '', fromVersion: null, toVersion: '', spec: '', diskFacts: [], restartRequired: false }
  }
  const canary = upgradeCanary(record['canary'])
  return {
    ...base,
    name: text(record['name']),
    fromVersion: asText(record['fromVersion']) ?? null,
    toVersion: text(record['toVersion']),
    spec: text(record['spec']),
    ...canary === undefined ? {} : { canary },
    diskFacts: texts(record['diskFacts']),
    restartRequired: record['restartRequired'] === true,
  }
}

/** 一次回滚结果的客户端视图（op: upgradeRollback）。 */
export interface UpgradeRollbackView extends EnvironmentResult {
  readonly name: string
  readonly fromVersion: string | null
  readonly toVersion: string
  readonly diskFacts: readonly string[]
  /** 盘上核对是否一致；读不出来时 undefined（**不是** false——"读不出来"不是"不干净"）。 */
  readonly clean: boolean | undefined
}

/**
 * 归一一次回滚结果。
 *
 * clean 读不出来时给 undefined 而不是 false：false 是一个结论（"有残留"），
 * 不能拿它顶替"读不到"（DESIGN §12.3.3）。
 *
 * @param raw - upgradeRollback op 的结果。
 * @returns 视图。
 */
export function normalizeUpgradeRollback(raw: unknown): UpgradeRollbackView {
  const record = asObject(raw)
  const base = normalizeEnvironmentResult(raw)
  if (record === undefined) {
    return { ...base, name: '', fromVersion: null, toVersion: '', diskFacts: [], clean: undefined }
  }
  return {
    ...base,
    name: text(record['name']),
    fromVersion: asText(record['fromVersion']) ?? null,
    toVersion: text(record['toVersion']),
    diskFacts: texts(record['diskFacts']),
    clean: typeof record['clean'] === 'boolean' ? record['clean'] : undefined,
  }
}

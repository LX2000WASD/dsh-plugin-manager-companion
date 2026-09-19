/**
 * dsh-plugin-manager-companion — host/client 的 wire 契约。
 *
 * 归属：A 类·重写（旧 src/types.ts 仅作字段意图参考，未复制代码）。
 * 官方复用：官方 pluginManager/types 的类型直接 re-export，不重复定义。
 * 前提检查：旧类型里有大量为自建 REST + 自建 patch 写入设计的形状
 *   （MutationResult/CommandResult/UpdateInfo 等），前提已消失——
 *   当前 profile 的写操作全部走官方 Remote，本文件只描述官方不覆盖的部分：
 *   跨环境管理、深度诊断、市场、技能与预设。
 *
 * 全部类型必须 JSON-safe（跨 wire 传输）。
 */

// ── 官方类型的再导出（单一事实来源，禁止在本文件重定义）────────────────
export type {
  BundleInfo, BundleRowInfo, ChangeResult, ManagementError, PluginEntryId,
  PluginInfo, PluginInstallFailureKind, PluginInstallLogChunk, PluginInstallProgress,
  PluginInstallRequestId, PluginSpecInspection, ReadOnlyReason,
} from '@deepseek-ai/dsh-plugin-manager/types'
export type {
  PluginFiberPhase, PluginInventoryEntry, PluginInventorySnapshot,
} from '@deepseek-ai/dsh-host-plugin-inventory/types'

// ── 环境（profile）──────────────────────────────────────────────────────

/**
 * 我们**从 manifest 派生**、且可能读不出来的字段名（闭集）。
 *
 * 为什么是联合类型而不是 string[]：裸字符串数组只能靠约定，谁报一个新名字都不会在
 * review 里被注意到。闭集让"新增一种读不懂的字段"变成一次**看得见的契约变更**——
 * 要同时改这里、读取器、以及客户端是否渲染；客户端写 includes('bundles') 也能被类型检查。
 */
export type ManifestField = 'bundles' | 'dependencies'

/** 一个 profile 目录的只读事实。 */
export interface EnvironmentInfo {
  /** profile 目录名，即 profile 名。 */
  readonly name: string
  /** 绝对路径。 */
  readonly dir: string
  /** 是否为本进程正在运行的环境。 */
  readonly current: boolean
  /** 官方内置环境（web/headless 等），只读不可删。 */
  readonly builtin: boolean
  /** `dsh.profile.bundles` 的层栈；读不懂时为空数组，**必须**配合 unknownFields / bundlesKnown 判断。 */
  readonly bundles: readonly string[]
  /**
   * 这份 manifest 里我们**读不出来**的派生字段（缺省 = 全部读得出来）。
   *
   * 为什么按字段列：官方改字段名/类型时，受影响的往往只是其中一个字段；
   * 一个笼统的"manifest 读不懂"会让调用方不知道该少说哪句话。
   */
  readonly unknownFields?: readonly ManifestField[]
  /** 读不出来的原因（面向用户）；全部读得出来时为 undefined。 */
  readonly unknownReason?: string
  /** 直接依赖名列表；读不懂时为空数组，**必须**配合 unknownFields 判断。 */
  readonly dependencies: readonly string[]
  /**
   * 层栈是不是确定的事实（等价于 unknownFields 里含 'bundles'）。
   *
   * 单独留一个派生谓词，是因为层栈是**界面上唯一直接渲染的派生字段**：显示
   * `0 个组合包` 就是把"我不知道"说成"这个环境没有层栈"。其余字段判断未知请读 unknownFields。
   */
  readonly bundlesKnown?: boolean
  /** 进程表扫描到的运行实例；**空数组 + runsKnown !== false 才表示未运行**。 */
  readonly runs: readonly EnvironmentRun[]
  /**
   * 运行实例是不是**确定**的事实（缺省等价 true）。
   *
   * 与 unknownFields / bundlesKnown **不是一个来源**：那两个来自环境自己的 package.json
   * （同一份 manifest），本字段来自**进程表读取**（/proc、ps 或 powershell CIM）—— 另一个源、
   * 另一种失败方式。所以这一对单独存在是刻意的，**不要**并进 ManifestField：合并会让
   * 「manifest 读不懂」与「进程事实读不到」共用一种表达，调用方就分不清该少说哪句话。
   *
   * `runs: []` 且 runsKnown === false 时**不代表「未运行」**，而是「我不知道」。
   */
  readonly runsKnown?: boolean
  /** 进程事实读不到的原因（面向用户）；可读时为 undefined。 */
  readonly runsUnknownReason?: string
}

/** 一个运行中的环境实例。 */
export interface EnvironmentRun {
  readonly pid: number
  /** 监听端口；未知时为 null。 */
  readonly port: number | null
  /** 启动命令行，用于展示与诊断。 */
  readonly command: string
}

// ── 诊断（环境控制台的核心）──────────────────────────────────────────────

/**
 * 诊断层级。每层有独立数据源，越靠上越可靠（静态可证），越靠下越贴近现实
 * （运行时事实）。
 */
export type DiagnosticLayer =
  /** L1 依赖：package.json 声明与 import 图的对照。 */
  | 'dependency'
  /** L2 组合：patch 层栈与行 id 的组合正确性。 */
  | 'composition'
  /** L3 运行时：loader fiber 相位与注册表冲突。 */
  | 'runtime'
  /** L4 一致性：官方 inventory 与本地产物的对照。 */
  | 'consistency'
  /** L5 生态：市场索引的更新与风险信息。 */
  | 'ecosystem'

/**
 * 处置等级。决定 UI 给什么按钮，以及能否自动执行。
 * - `safe-fix`：可安全自动修复，有明确唯一解
 * - `confirm-fix`：需用户确认，存在多种取舍
 * - `report-only`：只报告，不提供自动修复
 */
export type DiagnosticSeverity = 'safe-fix' | 'confirm-fix' | 'report-only'

/** 一个可执行的修复动作。 */
export interface DiagnosticFix {
  /** 稳定动作标识，host 端据此分派。 */
  readonly action: string
  /** 动作参数（JSON-safe）。 */
  readonly target?: string
  /** 面向用户的一句话说明。 */
  readonly summary: string
}

/**
 * 一条诊断发现。
 *
 * 设计原则：证据可溯——`evidence` 必须能指回具体文件/行/运行时对象，
 * 让用户能自己核实，而不是接受黑盒判断。
 */
export interface DiagnosticIssue {
  /** 稳定 id（同一次分析内唯一），用于 UI 折叠与修复定位。 */
  readonly id: string
  readonly layer: DiagnosticLayer
  readonly severity: DiagnosticSeverity
  /** 机器可读的问题类别，如 `missing-import` / `duplicate-row-id`。 */
  readonly code: string
  /** 一句话标题。 */
  readonly title: string
  /** 详细说明（含影响与建议）。 */
  readonly detail: string
  /** 涉及的对象：包名、行 id、服务名等。 */
  readonly subjects: readonly string[]
  /** 证据链，每条都可指回源。 */
  readonly evidence: readonly DiagnosticEvidence[]
  /** 可执行的修复；`report-only` 时为 undefined。 */
  readonly fix?: DiagnosticFix
  /** 归属包名；无法归属时为空串。 */
  readonly scope?: string
}

/**
 * 一条发现的作用域：它归属哪个包。
 *
 * 用于把同一 code 的大量命中聚合成可折叠的组——干净环境不该出现，但真出问题时
 * 163 条同类命中必须能被读懂。缺省为空串（无法归属时）。
 * @deprecated 用 DiagnosticIssue.scope（每条发现自带）。
 */

/** 一条证据：指回文件行或运行时对象。 */
export interface DiagnosticEvidence {
  readonly kind: 'file' | 'runtime' | 'official'
  /** 人类可读的位置描述，如 `package.json:12` 或 `loader entry "foo"`。 */
  readonly at: string
  /** 说明这条证据证明了什么。 */
  readonly note: string
}

/**
 * 一组同类发现的聚合视图。
 *
 * 设计意图：逐条 `issues` **一条不少**（证据与行号都留着），`groups` 只提供
 * 可折叠的计数与来源说明——折了信息但不丢信息。界面默认展开组、按需下钻到条目。
 */
export interface DiagnosticGroup {
  /** 稳定组键：层级 + 类别 + 严重级别 + 作用域。 */
  readonly key: string
  readonly layer: DiagnosticLayer
  readonly code: string
  readonly severity: DiagnosticSeverity
  /** 该组的命中条数。 */
  readonly count: number
  /** 组内命中的包及各自条数（判定不出归属的发现不计入）。 */
  readonly scopes: readonly DiagnosticScopeCount[]
  /** 组内涉及的对象（去重、有上限）。 */
  readonly subjects: readonly string[]
  /** 组内第一条的标题，供折叠态展示。 */
  readonly exampleTitle?: string
}

/** 一个作用域在某一组里的命中条数。 */
export interface DiagnosticScopeCount {
  readonly scope: string
  readonly count: number
}

/** 一次完整诊断的结果。 */
export interface DiagnosticReport {
  /** 被诊断的环境名。 */
  readonly environment: string
  /** 生成时间（ISO 8601）。 */
  readonly generatedAt: string
  /** 各层的问题数，便于 UI 直接渲染总览。 */
  readonly counts: Readonly<Record<DiagnosticLayer, number>>
  readonly issues: readonly DiagnosticIssue[]
  /**
   * 同类发现的聚合组（层级+类别+严重级别+作用域）。
   *
   * 各组 `count` 之和恒等于 `issues.length`——折了信息但不丢信息。
   */
  readonly groups?: readonly DiagnosticGroup[]
  /** 诊断过程中跳过的检查及原因（能力缺失时如实告知，不假装健康）。 */
  readonly skipped: readonly DiagnosticSkip[]
}

/** 一项因能力缺失而跳过的检查。 */
export interface DiagnosticSkip {
  readonly check: string
  readonly reason: string
  /**
   * 这次跳过让**哪些层**根本没查成（空/缺省 = 不是层级跳过）。
   *
   * 存在的理由：UI 要如实区分「这一层查过且没问题」与「这一层根本没查」，而后者绝不能画成 0
   * （把没查画成没问题）。层归属是引擎的事实，不能靠客户端去猜 check 字符串的形状——那是约定
   * 耦合，改名就会静默退化成"显示 0"。
   *
   * 用数组而不是单值：有些能力缺失会同时废掉多层（Loader 不可用 → runtime 与 consistency 都没跑；
   * 环境目录不存在 → 五层都没有输入）。单值会漏标另一层，而漏标出来的正是"查过且没问题"。
   *
   * 非层级检查（install-anchor / dependency-scan / composition-official / ecosystem-index 等）
   * **不设**本字段：它们只说明某一层的结论不完整，不代表整层没查。
   */
  readonly layers?: readonly DiagnosticLayer[]
}

// ── 环境管理操作 ─────────────────────────────────────────────────────────

/** 跨环境操作的统一结果。 */
export interface EnvironmentResult {
  readonly ok: boolean
  /** 面向用户的输出（含命令回显与诊断）。 */
  readonly output: string
  /** 失败时的稳定错误码。 */
  readonly code?: string
}

// ── 市场 ─────────────────────────────────────────────────────────────────

/**
 * 市场条目的安装来源类型。
 *
 * 用 `cordis-plugin` 而非 `plugin`：这是官方与生态的一致术语（官方预设就叫 cordis，
 * 检测出的仓库类型是"一个 cordis 插件"）。词汇必须全局统一，否则 registry 的
 * 安装路径分派与 kinds 的检测结果会对不上。
 */
export type MarketItemKind = 'cordis-plugin' | 'skill' | 'agent-preset' | 'unknown'

/**
 * 上游的可装性标记（索引 installable 字段，原样透传）。
 *
 * - `manual`：上游判定它不能走一键安装（724/13,998 条，其中 646 条确实没有 npm 包名）
 * - `non-plugin`：上游判定它**不是插件**（1,018 条，样本里有 96,949★ 的蹭话题仓库）
 *
 * 只呈现上游结论：我们既不猜原因，也不在 host 侧过滤（过滤是展示决策，见 marketView.filterInstallable）。
 */
export type MarketInstallable = 'manual' | 'non-plugin'

/**
 * 上游静态扫描的风险等级（索引 risk_tier 字段）。
 * 覆盖全部条目：safe 13,794 / caution 133 / risk 71。我们只展示，不折算、不重新分级。
 */
export type MarketRiskTier = 'safe' | 'caution' | 'risk'

/** 一条上游风险明细（索引 risk_flags 的元素）：原样展示 id + severity + 类别，不翻译成我们的结论。 */
export interface MarketRiskFlag {
  readonly id: string
  readonly severity: string
  readonly category: string
}

/** 一条市场条目（host 聚合后交给 client 渲染）。 */
export interface MarketItem {
  /** owner/repo。 */
  readonly repo: string
  readonly name: string
  readonly description: string
  /** 星数；未知时 null。 */
  readonly stars: number | null
  /** 最后更新时间（ISO 8601）；未知时 null。 */
  readonly updatedAt: string | null
  readonly topics: readonly string[]
  /** 上游分类 id。 */
  readonly category?: string
  /** 是否已在本环境安装。 */
  readonly installed?: boolean
  /** 已安装时的版本。 */
  readonly installedVersion?: string
  /** 检测到可更新时的新版本。 */
  readonly latestVersion?: string
  /** 安装来源形态，供 UI 选择安装路径。 */
  readonly kind?: MarketItemKind
  /** 索引采集到的 npm 包名（pkg_name / npm_pkg_name）；没有时缺省。 */
  readonly packageName?: string
  /**
   * 安装 spec：**host 侧决定**，客户端只负责原样送给 install op。
   *
   * 为什么不让客户端拼：spec 的合法形态由官方的 parseInstallSpec 定义（registry 名 / 绝对路径 /
   * git URL / tarball），客户端自己拼就是把这套规则复制一份——一处改动要改两处，而且必然漂移。
   * host 用 marketplace.installSpecFor() 决定（npm 包名优先，否则 github: 前缀的仓库地址），
   * 索引字段变了只改那一个函数。契约上可选：老载荷没有这个字段时客户端不会瞎猜（见 shared.ts）。
   */
  readonly installSpec?: string
  /**
   * 上游可装性标记（installable）。缺省 = 上游没有标记（12,256 条），不代表"可一键安装"。
   */
  readonly installable?: MarketInstallable
  /**
   * 上游风险等级（risk_tier）。可选：老载荷没有这个字段时**不显示风险徽标**，
   * 而不是默认成 safe——"没扫过"与"扫过是安全"是两回事。
   */
  readonly riskTier?: MarketRiskTier
  /** 上游风险明细（risk_flags），仅详情展示（卡片只放结论 riskTier）。 */
  readonly riskFlags?: readonly MarketRiskFlag[]
  /** 上游独立验证报告外链（reportUrl）；与 verdict/verifiedBy/verifiedAt 同属一个证据簇。 */
  readonly reportUrl?: string
  /** 上游收录标记（market_tags）：community-pick 是编辑推荐，verified-install 是另一套收录标记。 */
  readonly marketTags?: readonly string[]
  /** 仓库是否已归档（archived）。 */
  readonly archived?: boolean
  /** 近 7 天 star 增量（stars_delta_7d）；只用于"热度"排序，不做徽标（60% 为 0）。 */
  readonly starsDelta7d?: number
  /** 仓库许可证（SPDX id；88% 有值、其中 78.8% 是 MIT）——按政策进详情，不做徽标。 */
  readonly license?: string
  /**
   * 独立校验证据：verdict=pass 时上游给出"谁在何时验的"。
   *
   * 必须与 verified-install 收录标记**分开呈现**：两者交集只有 2 条（政策 §2.2），
   * 合并成一个"已验证"会让同一插件在两个徽标上自相矛盾。
   */
  readonly verifiedBy?: string
  /** 独立校验时间（ISO 日期）。 */
  readonly verifiedAt?: string
}

/** 市场查询结果。 */
export interface MarketplaceResult {
  readonly items: readonly MarketItem[]
  /** 索引生成时间；索引不可用且无缓存时为空串（UI 显示"未知"而不是伪造一个时间）。 */
  readonly generatedAt: string
  /** 本次结果是否来自缓存。 */
  readonly cached: boolean
  /** 上游分类计数，供筛选器渲染。 */
  readonly categories: Readonly<Record<string, number>>
  /**
   * 数据来源标识：network:<跳> / cache / cache-stale / empty。
   * 存在的理由：只给 cached 布尔值时，「拿到的是新鲜索引」「用的是三天前的缓存」「六跳全失败」三者
   * 在界面上长得一模一样，用户会把"索引不可用"读成"市场里没有这个插件"。
   */
  readonly source?: string
  /** 数据是否已过期（来自过期缓存，或全部来源失败）。 */
  readonly stale?: boolean
  /** 逐跳失败原因（有上限）；UI 如实展示，不把失败画成"空结果"。 */
  readonly notes?: readonly string[]
}

// ── 技能与预设 ───────────────────────────────────────────────────────────

/** 本插件安装过的非插件资源记录。 */
export interface InstalledKind {
  readonly kind: MarketItemKind
  /** owner/repo。 */
  readonly repo: string
  /** 落地目录绝对路径。 */
  readonly dir: string
  /** 安装时间（ISO 8601）。 */
  readonly installedAt: string
  /** 安装时的 commit，供更新检测。 */
  readonly commit?: string
}

/** 技能与预设页面数据。 */
export interface KindListResult {
  readonly records: readonly InstalledKind[]
  /** 磁盘上存在但无安装记录的目录（用户手工放的）。 */
  readonly orphans: readonly string[]
}
// ── 备份 ─────────────────────────────────────────────────────────────────

/**
 * 备份文档的格式标识字面量。
 *
 * 这里只声明**类型**（types.ts 不放运行期代码）；运行期常量在 envManager.ts，
 * 由它的类型断言与本字面量绑定，改一处漏另一处会编译失败。
 */
export type BackupFormat = 'dsh-plugin-manager-companion/environment-backup'

/**
 * 一次导出的环境备份。
 *
 * 刻意只包含重装所需的事实 —— 依赖的来源 spec 与 bundle 层栈。node_modules 实体、
 * 凭据、缓存、以及用户的 cordis.patch.yml 都不进来：备份的价值是**可重放**，不是复制数据；
 * 而补丁层是用户亲手写的状态，盲目覆盖它比不备份更危险。
 */
export interface EnvironmentBackup {
  readonly format: BackupFormat
  readonly version: 1
  readonly exportedAt: string
  readonly environment: string
  readonly bundles: readonly string[]
  /** 包名到安装来源 spec（pnpm 记录的原样值）。 */
  readonly dependencies: Readonly<Record<string, string>>
}

/** 一条需要重装的依赖。 */
export interface BackupMissingEntry {
  readonly name: string
  /** 可直接交给官方 add 的 spec（本地来源已解析成绝对路径）。 */
  readonly source: string
}

/** 备份与目标环境的差异，分五类。 */
export interface EnvironmentBackupDiff {
  /** 没有不可恢复条目时为 true。 */
  readonly ok: boolean
  /** 需要重装的依赖。 */
  readonly missing: readonly BackupMissingEntry[]
  /** 目标环境已装、无需处理的依赖名。 */
  readonly already: readonly string[]
  /** 目标环境目录不存在（备份里有、本机没有的环境名）。 */
  readonly missingProfiles: readonly string[]
  /** 来源已消失或非法的条目说明（重装也不可能成功）。 */
  readonly unrestorable: readonly string[]
  /** 备份里有、目标环境当前层栈里没有的 bundle。 */
  readonly bundlesMissing: readonly string[]
}

// ── 质量门安装 ───────────────────────────────────────────────────────────

/** 一次受质量门保护的安装结果。 */
export interface GatedInstallResult {
  /** 是否最终装成功（含通过质量门并激活）。 */
  readonly ok: boolean
  /** 面向用户的输出。 */
  readonly output: string
  /** 安装的包名；未装成时 undefined。 */
  readonly packageName?: string
  /** 质量门发现的问题；通过时为空数组。 */
  readonly gateIssues: readonly string[]
  /** 失败时是否已回滚。 */
  readonly rolledBack?: boolean
}
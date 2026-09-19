# 自有 REST 契约（host ↔ client 的唯一约定）

前缀 `/api2/companion`，全部 `POST` + `application/json`，信封见 `src/rest.ts` 的 `Envelope<T>`。
官方能力（插件启停/安装/卸载/清单）**不走这里**——客户端直连官方 `ctx.remote.pluginManager.*`。

## 操作表

| op | 请求体 | 成功返回 | 长操作 |
|---|---|---|---|
| `capabilities` | `{}` | `{ capabilities, config, trialDisclosure }` | |
| `diagnose` | `{ layers?: DiagnosticLayer[], environment?: string }` | `DiagnosticReport` | job |
| `fix` | `{ action: string, target?: string }` | `FixOutcome` | job |
| `install` | `{ spec: string, enable?: boolean, answers?: Record<string,string> }` | `GatedInstallResult` | job |
| `listEnvironments` | `{}` | `EnvironmentInfo[]` | |
| `environmentTemplates` | `{}` | `{ default: string, templates: { name: string, bundles: string[] }[] }` | |
| `scanRuns` | `{ refresh?: boolean }` | `Record<string, EnvironmentRun[]>` | |
| `startEnvironment` | `{ name: string, background?: boolean }` | `EnvironmentResult` | |
| `stopEnvironment` | `{ name: string }` | `EnvironmentResult` | |
| `createEnvironment` | `{ name: string, template?: string }` | `EnvironmentResult` | |
| `renameEnvironment` | `{ from: string, to: string }` | `EnvironmentResult` | |
| `removeEnvironment` | `{ name: string }` | `EnvironmentResult` | |
| `copyPlugins` | `{ from: string, to: string, names: string[] }` | `EnvironmentResult` | job |
| `backupExport` | `{ name: string }` | `EnvironmentBackup` | |
| `backupDiff` | `{ backup: EnvironmentBackup, target: string }` | `EnvironmentBackupDiff` | |
| `backupRestore` | `{ backup: EnvironmentBackup, target: string }` | `EnvironmentResult` | job |
| `marketplace` | `{ refresh?: boolean }` | `MarketplaceResult` | |
| `listKinds` | `{}` | `KindListResult` | |
| `uninstallKind` | `{ repo: string }` | `EnvironmentResult` | job |
| `trialEnvironments` | `{}` | `TrialEnvironmentReport` | |
| `trialRemove` | `{ name: string }` | `EnvironmentResult` | |
| `trialCleanup` | `{}` | `TrialCleanupResult` | job |
| `upgradeCheck` | `{ environment?: string, refresh?: boolean }` | `UpgradeCheckResult` | |
| `upgrade` | `{ environment?: string, name: string, version: string, spec?: string }` | `UpgradeActionResult` | job |
| `upgradeRollback` | `{ environment?: string, name: string, version: string, spec?: string }` | `UpgradeRollbackResult` | job |
| `getConfig` | `{}` | `CompanionConfig` | |
| `setConfig` | `{ patch: Partial<CompanionConfig> }` | `CompanionConfig` | |
| `job` | `{ id: string }` | `{ done, result?, error?, missing? }` | |

长操作的客户端模式：首次 POST 得 `{ jobId }`，然后轮询 `job` op 直到 `done`。
轮询节奏放宽建议：前 1.5 秒每 250ms，之后每 1.5 秒（首屏快、长期不轰炸）。

## 错误码（`error.code`）

| code | 含义 |
|---|---|
| `untrusted-host` / `bad-origin` / `cross-origin` / `cross-site` | 信任围栏拒绝 |
| `body-too-large` / `bad-json` / `body-read-failed` | 请求体问题 |
| `unknown-op` | 未知操作名 |
| `bad-request` | 字段校验失败（message 会指出哪个字段） |
| `busy` | 在途 job 达上限（HTTP 429） |
| `official-unavailable` | 官方能力缺失（message 是官方探针给的原始原因） |
| `operation-failed` | 操作本身失败（message 是原始诊断） |

## 客户端安全注意

- 一律**同源 fetch**（相对路径），不要拼绝对 URL。
- 加载类请求可带 `AbortSignal`（切换环境/卸载时中止）；**变更类请求不要带**——
  中止只应杀传输，而中止一个已经在跑的变更会留下"改了但没反馈"的状态。
- 变更类请求必须等 `job` 落定再更新 UI；不要用乐观更新。
## 备份类型的形状（与早先草案的差别）

`EnvironmentBackup` 刻意**只含重装所需的事实**：`format` / `version` / `exportedAt` /
`environment` / `bundles` / `dependencies`（包名 → 安装来源 spec）。
node_modules 实体、凭据、缓存都不进来——备份的价值是可重放，不是复制数据。
**用户的 `cordis.patch.yml` 也不进来**：那是用户亲手写的状态，盲目覆盖比不备份更危险。

`EnvironmentBackupDiff` 分五类：`missing`（需重装）/ `already`（已装无需动）/
`missingProfiles`（目标环境不存在）/ `unrestorable`（来源已消失，重装也不可能成功）/
`bundlesMissing`（备份里有、目标层栈没有的 bundle）。

## `fix` 的三种结局

`FixOutcome.status` 是三值，客户端必须分开呈现：

| status | 含义 | 客户端该做什么 |
|---|---|---|
| `executed` | 已执行（可能带"需重启"补充说明）| 重新跑一次诊断，让用户看到问题消失 |
| `needs-manual` | **没有官方通道，我们拒绝自己写 profile 组合** | 展示 `output` 里的精确步骤，不要报成失败 |
| `failed` | 执行失败（`output` 是原始诊断）| 展示原因，可重试 |

`needs-manual` 目前覆盖两条：`remove-duplicate-row` 与 `remove-row`。它们要求改
`cordis.patch.yml` 的**结构**（删行），而官方只有行级 `setPluginEnabled`，没有删行能力。
我们自己写这个文件会引入"两个写者并发改同一份组合"——那正是本仓库要消除的事故形态。
## `diagnose` 的诊断目标

`environment` 省略即**当前环境**；指定则用同一引擎诊断该环境（用户要的"用同一能力管理其他环境"）。

- 指定的环境不存在 → 返回 `operation-failed`，**绝不悄悄退回当前环境**：
  用户以为在诊断 A、实际诊断 B，是最糟的一类静默错误。
- 报告里的 `environment` 字段是**实际**被诊断的环境名。界面必须以它为准，
  而不是请求时传的名字——界面要展示事实，不是展示意图。
- 官方 `pluginManager` Remote 只覆盖**当前**环境。所以对其他环境的报告只做判断，
  不提供一键修复（客户端据此把修复按钮收起来并说明理由）。

## 长操作的首包形状（钉死）

**所有** job 化的 op 首包一律是 `{ "jobId": "<id>" }`，不是裸 id 字符串。

这条踩过坑：host 曾直接透传 `JobRegistry.start()` 的返回值（裸字符串），
客户端按契约判形状后把字符串当成了最终结果，于是 `report.counts` 读字符串属性、
整个体检页被官方 SlotErrorBoundary 接住渲染成**空白**。
单测与 SSR 全绿也发现不了——只有真实浏览器能暴露（详见 docs/private/visual-audit.md）。

客户端的 `runJob` 同时接受两种形状作为**防御**，但契约以 `{ jobId }` 为准，
`tests/index.test.mjs` 的 `jobIdOf()` 刻意**不接受**裸字符串。
## 环境生命周期（建 / 启 / 停）契约

- **建**：`createEnvironment` 省略 `template` 时用**官方 web 模板**（`@deepseek-ai/dsh-base` +
  `@deepseek-ai/dsh-web-app`），不再是官方 `DEFAULT_PROFILE_BUNDLES`——后者只有 base、没有任何
  app，建出来的环境必然没有 web 服务（实测：启动它只能干等 30s 再报 timeout）。可选模板与
  默认值由 `environmentTemplates` 给出，客户端**不要自建模板表**。
- **启**：就绪判据是**官方 HTTP 应答**——`GET /` 返回 `200/303/401` 才算就绪。`404` 不算，
  「端口可连接」也不算：本机实测首个 HTTP 应答 628ms 时是 `404`（连接已通、路由未注册），
  838ms 才是 `401`，中间约 210ms 的窗口里 TCP 判据会给出打不开的地址。
- **启不起来的两种即时拒绝**（都在发起启动之前）：层栈里没有任何 web 服务层 → `no-web-layer`
  （附两条可执行动作）；调用方显式指定的端口已被监听 → `port-in-use`（HTTP 探针无法判断应答
  来自谁，所以不让「端口已被占」进入等就绪流程）。拿不到官方 web 层事实时如实降级为
  「按就绪探测等待」，不预判拒绝。超时 → `timeout`，附官方输出尾巴。
- **token**：后台启动时 host 从官方 stdout 捕获 `dsh web: http://127.0.0.1:<port>/?token=<token>`，
  把这条**带 token 的可用地址**作为 `EnvironmentResult.output` 里的「可用地址」随本次返回交给页面。
  边界：token 只出现在该环境目录下 `0600` 的启动日志与**这一次**返回里（失败文案里的日志尾巴
  已脱敏为 `token=***`）；客户端**不得持久化**它——不进 localStorage、不进任何缓存、不进备份
  与差异状态；界面上也不要加「该地址含令牌」之类的解释段（`DESIGN §12`）。
- **启动方式**如实返回：终端窗口（带终端名）或后台。后台启动默认加 `--no-open`（没有人看着
  那个窗口，官方否则会在那台机器桌面弹浏览器）；终端模式保持官方默认行为。

## 试装（质量门第二步，DESIGN §5.2/§5.3）

**接入点**：`install` op（市场页安装、`dshpmc install`、`fix` 里的补装）都走同一个
`gatedInstall`；试装接在**静态快筛之后、真正放行之前**，所以三个入口同时生效，没有一个能绕过。

### 开启与关闭

- **默认关闭**。关闭时安装路径的语义与没有试装时逐条相同（现有测试即证据）。
- 开关在 `CompanionConfig.trial.enabled`。**配置里没有 `trial` 字段 = 关闭**：
  读配置一律走 `effectiveTrialConfig()`，缺字段/类型不对/越界都回落到安全默认值
  （schema 的默认值只在官方 settings 解析过那份配置时成立，不是运行期保证）。
- **质量门整体关闭**（`qualityGate.enabled=false`）或**包在豁免名单里**时试装**不执行**，
  但结果里会带 `trial.policy='skipped'` 并写明理由——"我打开了开关却什么都没发生"必须是可见的。
- 静态快筛就拦下的包不进入试装（结果里没有 `trial` 字段）。

### 结论与处置（四值 × 两档，不得混）

| `trial.conclusion` | 含义 |
|---|---|
| `passed` | 基线挂载 + 装完候选包仍挂载 |
| `baseline-broken` | 快照基线本身就起不来：**不是候选包的问题** |
| `candidate-broken` | 基线好、装完候选包起不来：候选包导致的（附根因链）|
| `cannot-trial` | 没有得到有效判定（禁网且 store 里没有、跨环境、超限、超时等）——**不算通过** |

`trial.policy` 说明这次**装没装**：

| 设置 `trial.onFailure` | conclusion ≠ passed 时的行为 |
|---|---|
| `block`（默认）| 不安装：`ok:false` + 官方 removeBundle 回滚 + `rolledBack` + 原因链 |
| `warn` | 照常安装（`ok:true`），结论照样写在 `trial` 里，输出里写明"按 warn 模式放行" |

两档都**不会**把 `cannot-trial` 写成通过；`warn` 下输出里也不会出现"试装通过"这类字眼。

### 快照深度（`trial.depth`）

| 值 | 行为 |
|---|---|
| `auto`（默认）| 先浅快照；只有基线**明确挂载失败**才升级为完整快照重试一次；`undetermined`（判不出来）**不升级** |
| `shallow` | 只用浅快照（省一次官方 install；层栈不全时可能把"快照缺依赖"报成"基线起不来"）|
| `full` | 每次都跑官方 `install --prefer-offline` 物化真实快照（59ms 热 / 831ms 冷）|

结论里永远带 `trial.depth` 与 `trial.escalated`（是否升过级）——界面不许把 shallow 的结论说成
"完整验证"。候选包不会被"先激活再回滚"：装进去时就是 `enabled:false`。

### 测试环境（`<真实环境名>-dpmc`）

- 命名与归属见 DESIGN §5.4；**一个真实环境一个测试环境**，禁止重命名，不得当成真实环境操作。
- 快照源必须是**包真正会落地的那个环境**。官方安装通道（`ctx.pluginManager`）只作用于**当前环境**，
  所以请求里 `environment` 指向别的环境时试装直接报 `cannot-trial`：
  验证的环境与落地的环境不是同一个时，结论没有意义。
- `trialEnvironments` 是**纯读**：它返回列表、占地、计划预览（下次清理会删谁/留谁），**不删任何东西**。
  删除只有两个入口：`trialRemove`（单个）与 `trialCleanup` / 试装结束时的自动清理（按保留期）。
- **`plan` 是查询那一刻的快照，不是"点清理时会删的东西"**（已知边界，2026-09-20 记录）。
  两者的差别有真实窗口：用户看到计划后、按下清理前，可能启动了某个测试环境（或它自己跑起来了）——
  那一刻"会删"的集合与计划就不同了。**执行时以当时的盘上事实为准**，引擎的"运行中永不删"纪律是兜底：
  它会在真正删除前重新判一次运行状态，所以**计划里列出的东西不一定都被删**（少了，不会多）。
  界面据此的约束：**不许把计划当成承诺**（不要写"将删除这 N 个"这种完成时口吻的保证），
  也不要为了对齐而把计划与执行结果硬凑成一个数——执行结果以 `trialCleanup.removed` 为准。
  这一条刻意**不上屏**：解释它属于讲实现，而用户需要的两个事实（计划里有什么、实际删了什么）
  界面上都已经有了。
- 删除的三重纪律（引擎实现，op 不改）：只删形如 `<名>-dpmc` 的环境 / 运行中先拒 /
  进程事实不可读就拒。孤儿测试环境（真实环境已改名或删除）同样纳入清理。
- 占地口径：`bytes` 是 **st_size 合计（apparent）**，不是独占磁盘；`sharedFiles` 是 nlink>1 的文件数
  （pnpm store 硬链接，实测一个 12 MiB 的测试环境独占只有 36 KiB）。界面引用 `bytes` 时应当同时
  提到"其中 N 个是硬链接"，否则会把"看着大、实际不占"说成"占了很多盘"。
- `retention.days` / `retention.autoCleanup` / `retention.maxKept` 直接来自生效配置，
  界面**不要自己拼默认值**。
- **上限（`trial.maxKept`，0 = 不限）的语义是"拒绝执行"，不是"删掉最旧的腾位"**：
  达到上限时新的一轮试装报 `cannot-trial` 并告诉用户先清理。删除只发生在两处——
  用户自己点删除、或超过保留期的清理（这正是 §5.3"不设硬上限"的意思）。
- 清理记账：`<DSH_HOME>/dpmc-trial-cleanup.log`（0600），每行"removed/kept <名字>：<原因>"。

### 告知义务（设置页必须显示的事实）

`capabilities` 的 `trialDisclosure` 给两条**机器可读**的事实，文案由 UI 落地、数字不要各抄一份：

```json
{
  "executesCandidateCode": true,
  "peakMemoryMiB": 161,
  "measurement": "实测口径：headless 验证启动的 maxrss 峰值 161 MiB，在 Linux x64 / Node 24 / DSH 0.1.6-alpha.2 上量得；候选包自带的安装脚本会真的在你机器上执行。"
}
```

引用数字时必须一起给出 `measurement`（否则数字没有意义）。

### 配置键（`CompanionConfig.trial`）

| 键 | 默认 | 用户在设置页看到的后果 |
|---|---|---|
| `enabled` | `false` | 开启后会真装候选包并执行它的安装脚本；一次验证启动内存峰值约 161 MiB；一轮约 0.65s |
| `depth` | `'auto'` | 只影响结论的可信度与耗时；结论里永远写明实际用了哪种 |
| `baseline` | `true` | 关掉省约 558ms，但失败时说不清是不是候选包的问题（结论降级为"无法试装"）|
| `allowNetwork` | `true` | 关掉只用本地 store，冷包直接"无法试装"，**不假装通过** |
| `onFailure` | `'block'` | 未通过时不装（默认）或只警告 |
| `autoCleanup` | `true` | 试装结束时按保留期清理过期测试环境；关掉则只增不减（仍可手动清理）|
| `retentionDays` | `14` | 超过这个天数没被用过的测试环境会被删；运行中的不删 |
| `maxKept` | `0`（不限）| 设成 N 后超限的试装会拒绝执行并提示先清理 |

`trial` 段在 TypeScript 里是**可选**字段（客户端镜像配置形状的节奏与宿主不同步，
写成必填会让"宿主加字段"变成"客户端编译失败"）；运行期由 schema 补齐。

### 验证形态：两类环境各读各的就绪信号（2026-09-19 真机改定，task-75）

验证启动按**层栈**决定形态（`environmentWebLayer`；层栈事实拿不到时按 headless 形态，绝不盲加未知参数）：

| 层栈 | 启动参数 | 就绪信号 | 真机实测 |
|---|---|---|---|
| 含 web 层（官方默认模板建的、以及 GUI 自己那个环境）| `--profile <名> --port 0 --no-open`（服务形态：`--port 0` 由 OS 分配，永不与 GUI 抢 3080）| **stdout** 的 `dsh web: http://…`（官方在 Loader settle 之后才打印，注释写明它是给 supervisor 的就绪信号）→ 判 `mounted` 并**立刻杀子进程** | 655–666ms/次，无端口冲突 |
| headless 类 | `--profile <名>`（缺任务形态，原判据不变）| stderr 的 `dsh: a task is required…` → `mounted` | 526–555ms/次 |

- 失败一律读 stderr（`plugin tree failed to load` / `cannot resolve profile bundle` + cause 链）；
  两类信号都没有 → `undetermined`，**不许当通过**。
- 顺序纪律：**谁先出现算谁**（`createBootSignalCollector`）——stderr 里已经出现失败特征时，后来的就绪行不算数。
- 半行就绪行不算就绪（URL 后必须跟空白）：流式读取不按行对齐，`…:461` 这种半行不能当成地址。
- 验证超时 15s（官方 smoke 用 90s 是在等真实服务，我们只等就绪行）。

### 快照物化：只反映"源环境现在的清单"（task-75）

- 物化前清掉**上一次物化留下的**两项：`node_modules` 与 `pnpm-lock.yaml`（证据在 `SnapshotMaterialization.cleared`）。
  不清的话，上一次完整快照留下的依赖会让下一次"浅快照"照样挂载成功——金丝雀会**假通过**。
- 删不掉或删完仍在 → `snapshot-not-shallow`，整轮试装报 `cannot-trial`（**绝不静默沿用旧依赖**）。
- 刻意**不动** profile 骨架（`package.json` / `cordis.yml` / `cordis.patch.yml` / `pnpm-workspace.yaml`）：
  它们是官方 initProfile 建出来的，且 `pnpm-workspace.yaml` 带着 `nodeLinker: hoisted` 这类会改变 pnpm 语义的设置——
  删掉它等于换一套安装语义去验证（那才是失真）。源环境有这些文件时，复制那一步会覆盖成源环境的版本。

### 客户端跟进事项（UI 任务）

- `GatedInstallResult` 新增 `trial` 字段（`conclusion/policy/depth/escalated/baseline/candidate/elapsedMs/output/policyNote`）：
  `policy='warned'/'blocked'` 时不要把结论渲染成成功态。
- `src/client/wire.ts` 的配置默认形状需要补 `trial` 段（`normalizeConfig` 也要填默认值），
  否则设置页草稿里 `draft.trial` 是 undefined；跳过的情形（`policy='skipped'`）要有专门文案。

## 升级动作的客户端约束（Lead 决定，宿主侧无新 op）

官方插件页只有三个槽位（`plugins.item` / `plugins.bundle.config` / `plugins.row.config`）；
卸载按钮与启用开关在 `PluginManagerPage.tsx:433-452` 的官方 chrome 里，**没有槽位**——
所以"升级"不放在删除按钮旁边，也不用 DOM 注入。

| 落点 | 做法 |
|---|---|
| ① 主落点 | `plugins.bundle.config` 按包名注册（一行"当前 x → 最新 y ｜ 升级"，只在该包有更新时出现）|
| ② 市场页 | 已装条目的卡片上加"升级到 x.y.z"（零新机制，可选）|
| ③ 关于 → 软件升级 | 批量视图（另一个任务）|

硬约束（每条都对应一个已核实的事实）：

- **安装方提供的层在 profile 内升级不了**：官方 `list_bundles` 的 `installed === false` /
  `removable === false` 就是这条事实（已核实 web profile manifest：`bundles` 里有、`dependencies` 里没有）。
  这些条目只显示"由安装方提供"+ 对应命令，**不给按钮**。
- **生效时机沿用官方口径**（官方安装成功文案即"下次启动后加载"），不自造"已立即生效"。
- **版本查询失败必须显示"查不到"**，不得显示"已是最新"（查不到 ≠ 是最新版）。

## 升级 op 的契约（upgradeCheck / upgrade / upgradeRollback）

三个 op 的分工刻意不对称，理由写在括号里：

| op | 形态 | 为什么 |
|---|---|---|
| `upgradeCheck` | **直接返回** `UpgradeCheckResult`，不走 job | 缓存命中时零网络；手动检查也受 `CHECK_BUDGET_MS`（20s）总预算约束，不会无限拖住请求。走 job 只会让客户端多一跳轮询 |
| `upgrade` | job（首包 `{ jobId }`） | 会真装包（可能联网），耗时可到分钟级 |
| `upgradeRollback` | job（首包 `{ jobId }`） | 同上；回滚也是"装一个版本"，不是撤销 |

**入参校验在起 job 之前**（`name` / `version` 缺失当场返回 `ok:false`）：
job 的失败只体现在后续 `job` op 的轮询结果里，把"少给一个字段"塞进 job 会让客户端先拿到
`ok:true + jobId`，然后异步等一个注定失败的任务——错误被包装成"看起来开始了"。

`environment` 省略即当前环境（与 `diagnose` 同一口径）。

### `UpgradeCheckResult.units[].state` 四态（界面直接渲染，不要自己推断）

| state | 含义 | 界面该做什么 |
|---|---|---|
| `update-available` | **有版本事实**且比当前新 | 给升级入口；`tags` 非 null 时列出全部 dist-tags 让用户挑 |
| `up-to-date` | 有版本事实、没有更新的 | 显示"已是最新"+ 依据（`reason` 带版本号） |
| `unknown` | **拿不到版本事实**（registry 失败 / 未到检查时间 / 仅手动 / 关掉了自动检查） | 显示"查不到"+ `reason` + 重试；**绝不显示"已是最新"** |
| `not-upgradable` | 结构上就升不了（安装方提供的层） | 显示 `command`，**不给按钮** |

`source` 标明事实来自哪里（`market-index` 零网络优先 / `registry`），`at` 是那份事实的时间——
界面必须把来源与时间标出来，否则"最新"这个断言没有依据。

### 出网纪律（检查缓存）

- **进入即查 + TTL + 手动常驻**，不做后台轮询。"每天一次"= 下次进入时距上次成功检查超过 24h 才查。
- 记账与条目都**按环境分开**：A 环境查过不代表 B 环境查过（换环境一律重新出网）。
- 负缓存**逐包**判定：某包失败后 1 小时内自动检查不重试它，但**不牵连**同环境里别的包；
  过了 1 小时自动恢复。
- `refresh: true`（手动）**无视**开关、TTL 与负缓存，永远可用。

### 试装顺序：候选必须先成为"新装"（task-84，阻断级）

官方 reconcile **跳过 `beforeDeps` 里已有的依赖**（`lib/types/operations.js`）。而试装快照是从
**源环境**物化的，`SNAPSHOT_FILES` 含 `package.json`——只要候选已经在源环境里，它在物化那一刻
就已经在测试环境的 `dependencies` 里，于是试装那次 `add` 无事可做、reconcile 跳过它、
它进不了 `dsh.profile.bundles`、挂载期不加载它。

**这不是优化，是前提**：试装开 + `onFailure:block`（两个默认档）时，任何安装都会被判
`cannot-trial` 并回滚（市场页 / 官方通道 / 修复安装三边同时失效），而 `candidate-broken`
不可达——质量门第二步从"验证"退化成"永远拦下"。

修法：试装引擎在官方 `add` 之前先走**同一条官方通道** `remove` 掉候选（`detachCandidate`），
使它成为"新装"，reconcile 才会把它写进层栈。三条纪律：

- 候选**不在**测试环境依赖里时**不发** `remove`（全新安装不必白跑一次 pnpm）；
- `remove` 失败**不阻断**：层栈事实会如实反映"它没进层栈"，由守卫报 `cannot-trial`；
- task-80 的守卫**保留作兜底**（摘不掉、候选不声明 `dsh.bundle`、测试环境有残留…），
  正常顺序下它不该触发。

结果里带 `trial.activation`（`activated` / `bundles` / `removedFirst` / `detachNote`）与
`trial.detached`：界面据此能说清"这次到底验证到了没有"。

### 金丝雀（`upgrade` 的 canary 字段）

`canary.ran === false` 时必须读 `canary.skippedReason`：试装总开关关着时文案是
"未做金丝雀，直接升级（没有验证新版本能否挂载）"——**"没验证"不等于"通过"**，
界面不许把它渲染成绿色通过态。

`canary.activation` 是激活证据（候选有没有真的进 `dsh.profile.bundles`）：
升级场景下候选已在源环境 `dependencies` 里，官方 reconcile 会跳过"既有依赖"，
所以金丝雀必须先走官方 `remove` 再 `add`，否则它永远进不了层栈、旧代码照样启动成功（假通过）。
`activation.activated === false` 时结论一律 `cannot-trial`。

### 客户端侧的落点与对账（task-74 已落地，界面实现以此为准）

上面那张表是"放哪"；这一段是"怎么接"——**已实现并被 tests/upgrade-ui.test.mjs 钉住**。

| 落点 | 实现 | 为什么不能换 |
|---|---|---|
| 主落点 | `plugins.bundle.config`，**key = 包名**，每个 key 一个注册项 | 官方插件页只有三个槽位；卸载按钮与启用开关在 `DetailTop` 的 actions 里没有槽位 |
| 市场页 | 卡片上的「升级到 x.y.z」（`market.upgradeTo`） | 零新机制：复用 `updateAvailable` 判据与同一个 `upgrade` op |
| 禁止 | **DOM 注入** | 官方 chrome 不属于我们；注入会在官方改版时静默失效 |

**注册集合的实时对账**（DESIGN §5.5）——三条纪律，每条都有对应断言：

1. **目标集合** = 已装 ∧（还没查过 ∨ 这一态要显示）。`registeredNames()` 是唯一出口：
   · `up-to-date` → **不注册**，那个 key 的 disposer 被释放，官方 config-ledger 重算，那一节**当场消失**；
   · `unknown` / `not-upgradable` / `update-available` → 注册；
   · **还没查过** → 也要注册：检查正是由这一行挂载时的 effect 触发的（"进入即查"），
     先要求"查过才注册"会变成先有鸡还是先有蛋，而且"没查"这一态也必须能被看见。
2. **多退少补**：每次对账都对比集合，撤掉的多余 key 立刻调它自己的 disposer。
   **不留孤儿 key**：否则将来同名包重装会带着旧数据冒出来。
3. **源**：升级状态每次发布 + 官方 `plugin-manager/changed` / `connection/reset`。
   台账读不到时**不清空**已注册的行（"读不到已装集合"不等于"什么都没装"），
   退回用检查结果里的单元名——那份事实同样来自宿主读盘。

**本插件自己的包名（`dsh-plugin-manager-companion`）不参与升级行对账**：它自己的页面已被
配置面那条 `plugins.bundle.config` 注册占用，同一 key 同优先级再注册会被官方 `register` 抛
`already has an entry`。自我升级按 DESIGN §5.5 走「关于 → 软件升级」的批量视图（另一个任务）。

**不要用官方台账的 `installed` 过滤注册集合**：那个字段的语义是"在 profile 的 dependencies 里"
（`listBundles`：`const installed = dependencies.includes(name)`），而**安装方提供的层**恰恰是
"在层栈里、不在 dependencies 里"——按它过滤会把 `not-upgradable` 整个漏掉，而那是四态之一。
取全部名字，让四态决定要不要注册；多余的 key 是惰性的（官方只为它真正渲染的包派发 key）。

**结果块的行文结构**（DESIGN §12.9，第五次反馈；已落成 `tests/copy-rules.mjs` 的 R1–R7）：

| 规则 | 判据 | 结果块怎么落地 |
|---|---|---|
| R1 结论紧随主语 | 结论词出现在包名**之前** | `{name} 已升级（未验证）`，不是 `已升级 {name}（…）` |
| R2 原因不许冒号套冒号 | 同一行 ≥2 个冒号 | 原因按**树状**渲染（`canaryNote` 本身就是多行缩进树，界面逐行画，不塞进句子模板） |
| R3 禁内部代号 | 金丝雀 / 盘上事实 / 挂载 / 快照 / 层栈 / 锚点 | 试装验证 / 当前状态 / 加载·起不来 / 环境副本 / 组合层 / 安装位置 |
| R4 结论只留一处 | 「未验证」类**结论句**多于 1 处 | 标签已写 `未验证` 时，下面只给原因 |
| R5 原始日志加标识 | 贴了 pnpm 原文却没有「命令输出」标识 | 先给 `命令输出（pnpm，升级命令）` 再贴原文 |
| R6 历史记录交代时间性 | 出现「上次」+ 升级/回滚 | `最近一次升级` / `最近一次回滚` |
| R7 不口语化 | 吧/呢/哦/一下/帮你/你可以/我们 | 说明性文字一律陈述句 |

**R3 的覆盖是两处**：客户端字典（`locales.ts`）与 **host 侧运行时拼接的输出**。
后者是这一轮的重点——`金丝雀` 在客户端字典里 0 条、在 host 侧 11 处，且几乎全是拼出来的，
只扫字面量的护栏会 0 命中。所以判据必须落在**用户真正看到的那个字符串**上
（§12.7 的 H4 手法：驱动真实升级路径拿 `result.output` 过表，见 `ui-copy.test.mjs` 的三条 H4 用例）。

**一次升级结果的诚实分类**（`upgradeView.upgradeOutcome`，界面按它选文案与色调）：

| outcome | 判据 | 界面必须说 |
|---|---|---|
| `done` | `ok === true` 且金丝雀跑了且通过 | 已升级 + 生效时机 |
| `unverified` | `ok === true` 但 `canary.ran === false` | **升级了，但没验证**（不是通过，也不是失败） |
| `rolled-back` | `ok === false` 且 `code === 'canary-not-passed'` | **没有升级**：真实环境没被动过 |
| `failed` | 其余失败（含传输层失败） | 没有完成（带盘上事实与官方退出码） |

金丝雀那一行单独渲染（`passed` / `failed` / `not-run` / `absent`）——
**"没验证"与"验证失败"必须是两句不同的话**，混起来就等于把风险藏了。
根因链在 `canary.output` 里（顶层 `output` 是结论层），必须一起带出来供用户追责。

**未验证（`canary.ran === false`）在成功路径上也要说出来**——那一档最容易被读成"通过"。


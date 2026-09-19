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


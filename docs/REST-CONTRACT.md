# 自有 REST 契约（host ↔ client 的唯一约定）

前缀 `/api2/companion`，全部 `POST` + `application/json`，信封见 `src/rest.ts` 的 `Envelope<T>`。
官方能力（插件启停/安装/卸载/清单）**不走这里**——客户端直连官方 `ctx.remote.pluginManager.*`。

## 操作表

| op | 请求体 | 成功返回 | 长操作 |
|---|---|---|---|
| `capabilities` | `{}` | `{ capabilities, config }` | |
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

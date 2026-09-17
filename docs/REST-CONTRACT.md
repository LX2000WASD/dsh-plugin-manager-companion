# 自有 REST 契约（host ↔ client 的唯一约定）

前缀 `/api2/companion`，全部 `POST` + `application/json`，信封见 `src/rest.ts` 的 `Envelope<T>`。
官方能力（插件启停/安装/卸载/清单）**不走这里**——客户端直连官方 `ctx.remote.pluginManager.*`。

## 操作表

| op | 请求体 | 成功返回 | 长操作 |
|---|---|---|---|
| `capabilities` | `{}` | `{ capabilities, config }` | |
| `diagnose` | `{ layers?: DiagnosticLayer[] }` | `DiagnosticReport` | job |
| `install` | `{ spec: string, enable?: boolean, answers?: Record<string,string> }` | `GatedInstallResult` | job |
| `listEnvironments` | `{}` | `EnvironmentInfo[]` | |
| `scanRuns` | `{ refresh?: boolean }` | `Record<string, EnvironmentRun[]>` | |
| `startEnvironment` | `{ name: string, background?: boolean }` | `EnvironmentResult` | |
| `stopEnvironment` | `{ name: string }` | `EnvironmentResult` | |
| `createEnvironment` | `{ name: string, template?: string }` | `EnvironmentResult` | |
| `renameEnvironment` | `{ from: string, to: string }` | `EnvironmentResult` | |
| `removeEnvironment` | `{ name: string }` | `EnvironmentResult` | |
| `copyPlugins` | `{ from: string, to: string, names: string[] }` | `EnvironmentResult` | job |
| `backupExport` | `{ name: string }` | `BackupFile` | |
| `backupDiff` | `{ backup: BackupFile, target: string }` | `BackupDiffResult` | |
| `backupRestore` | `{ backup: BackupFile, target: string }` | `EnvironmentResult` | job |
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

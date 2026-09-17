# dsh-plugin-manager-companion · 设计定稿

> 本文件是新仓库的**唯一设计权威**。所有实现决策以本文为准，偏离必须先改本文。
> 前身：`dsh-web-plugin-manager`（0.6.3，已停止维护，README 将注明由本仓库接续）。
> 官方基线：DSH `>= 0.1.6-alpha.2`。

## 0. 一句话定位

**官方插件管理器的伴生补强**：官方管"装什么、开什么"，我们管"装得对不对、环境健不健康、整个机器怎么管"。

## 1. 与官方的分工（不可越界）

| 能力 | 官方 | 我们 |
|---|---|---|
| 组合包启停 / 行级开关 | ✅ 已做 | ✗ **绝不做** |
| bundle 安装 / 卸载 | ✅ 已做 | ✗ **绝不做**（只在安装前插质量门）|
| 插件配置页托管 | ✅ 提供 slot | ✅ **作为注册方**接入 |
| 安装前静态质量门 | ✗ 不做 | ✅ **做** |
| 深度环境诊断 | ✗ 不做 | ✅ **做**（核心）|
| 多 profile 环境管理 | ✗ 明说"不能改另一个 profile" | ✅ **做** |
| 插件市场 | ✗ 无概念 | ✅ 做（不主打）|
| skill / agent 预设 | ✗ 明说"仍是文件操作" | ✅ **做** |

**硬约束**：所有当前 profile 的写操作走官方 `ctx.remote.pluginManager`；跨 profile 走官方 `./operations` 的 `runPluginCommand`。**我们不自己写 `cordis.patch.yml`，不自己调 pnpm。**

## 2. 四项官方明文空白（我们的作业面）

官方 README 原文（`boot/plugin-manager`、`client/ui-plugin-manager`、`client/ui-settings-plugin-inventory`）：

1. "The manager cannot ... **change another profile**, or **edit an agent preset's composition**"
2. "**Only bundles are managed** — ... loading plain plugin modules stays a file operation"
3. "**No version picker** — the page neither lists registry versions nor offers upgrades"
4. "enable/disable controls that write a custom preset's own composition file are **deliberate follow-up work**"

## 3. 页面结构

### 3.1 一级设置页（`settings.section`）

官方 order 布局：`general=0, models=10, plugins=15, agent-presets=20, archived-sessions=25`

| id | order | 名称 | 内容 |
|---|---|---|---|
| `marketplace` | 16 | 插件市场 | 索引浏览、搜索、分类、安装（走官方）|
| `console` | 17 | **环境控制台** | **健康检查 + 环境管理合一**（见 §4）|
| `kinds` | 22 | 技能与预设 | SKILL.md / agent.cordis.yml 直装 |

### 3.2 官方插件页内的注册（"点开即可管理"）

按官方 `slot-contract.ts` 声明，**注册方与页面同生**：

| slot | key | 我们注册什么 |
|---|---|---|
| `plugins.item` | — | 我们自己的条目卡片（label 用字典）|
| `plugins.bundle.config` | `dsh-plugin-manager-companion` | 本插件在**官方插件页**的配置表单 |
| `plugins.row.config` | `<包名>#<行 id>` | 需要逐行配置的组件 |

**已实证**：`PluginManagerPage.tsx:966` 的 `configured = ledger.bundles.has(openPkg.name)`，用自己包名注册即渲染。

### 3.3 配置写入：不编辑配置文件

用官方 `ctx.settingsScope.bind({ namespace })` + `register()`（`SettingsProvider`），
用户在我们的表单里改，**由官方 settings 服务落盘**。我们不碰 YAML。

## 4. 环境控制台（合并页，本仓库的核心）

用户定位："类似 360 电脑管家"——**对本地 DSH 环境做深度、可视化的分析与管理**。

### 4.1 设计原则

- **只读优先**：默认只诊断、不修改；任何写操作都要明确点击 + 行内确认
- **证据可溯**：每条诊断都能点到源文件/行，不做黑盒判断
- **官方事实优先**：能用 `ctx.reflect`/`ctx.loader` 读到的，不靠源码正则猜

### 4.2 诊断维度（分层）

| 层 | 数据源 | 检测项 |
|---|---|---|
| L1 依赖 | 静态扫描（package.json + import 图）| 缺失依赖、未声明 import、官方包重复、peer 版本 |
| L2 组合 | 官方 `composeEntries` + patch 层栈 | 行 id 重复、被禁用依赖、遮蔽、孤立行 |
| L3 运行时 | `ctx.loader.entries()` + `ctx.reflect` | fiber 相位异常、pending 根因、失败原因、服务名冲突 |
| L4 一致性 | 官方 `readPluginInventory` vs 本地文件 | 声明未装、装未挂载、挂载未声明 |
| L5 生态 | 市场索引 | 更新可用、已知风险徽标、废弃包 |

### 4.3 分级处置

- **A 级（可安全自动修）**：重复行 id、官方包重复、被禁用依赖 → 一键修复
- **B 级（需确认）**：同名注册冲突、缺失依赖 → 建议 + 行内二次确认
- **C 级（只报告）**：循环依赖、peer 不满足、语义冲突 → 输出 + 溯源

### 4.4 环境管理（同一页面）

- 环境列表（运行状态、端口、进程）
- 启停（终端/后台，端口探测）
- 创建 / 重命名 / 删除（官方 profile 只读保护）
- 插件跨环境复制/转移
- 备份导出 / 差异对比 / 导入恢复

**写路径**：官方 `runPluginCommand({ profile, dir, installAnchor, cwd, home })` + `withFileLock`。
**恢复路径**：官方 `sanitizeProfile(binName, profileDir, bundles)`。

## 5. 质量门（安装前拦截）

```
1. inspect(spec)                              ← 官方 Remote
2. installBundle(spec, { enabled: false })    ← 官方 Remote（装但不激活）
3. 扫描已安装包（我们的质量门）                ← 独有
4. 不合格 → removeBundle(name)                ← 官方回滚
   合格   → setBundleEnabled(name, true)      ← 官方激活
```

零竞态、零自建 pnpm、零 patch 写入。官方 UI 自己就用 `enabled: false`（`manager-store.ts:561`）。

## 6. 删除清单（相对旧仓库）

| 删除 | 行数 | 理由 |
|---|---|---|
| `PluginCatalogTab.tsx` | 593 | 官方侧栏 Plugins 页已覆盖且更好 |
| `PluginManagerSettingsTab.tsx` | 766 | 官方安装对话框已覆盖 |
| 遮蔽注册（`settings.plugins.tab` id='all'）| — | 官方主动降级为只读列表 |
| `patch.ts` | 511 | 写权交还官方 |
| `live.ts` | 411 | 官方换用 `@deepseek-ai/dsh-hmr`，旧的绕死锁方案已过时 |
| `childproc.ts` | 222 | 改用官方 `./operations` |
| 27 个 REST op + job 系统 | — | 改用官方 Remote |
| `tsdown.config.ts` | 19 | 死配置 |
| **`cordis.patch.yml` 的 `id: plugin-manager`** | — | **P0 根因**（与官方新行撞 id）|

## 7. 已知必须修的旧代码缺陷（参考不复制）

调研中已实证的旧仓库问题，新仓库必须避免：

1. **P0-A**：bundle patch 行 id `plugin-manager` 与官方新行撞车 → `duplicate loader entry id`，profile 无法启动
2. **P0-B**：服务名 `ctx.pluginManager` 与官方同名 → `service has been registered`，profile 无法启动
3. **fiber 相位映射错**：旧 `phaseOf` 把 `4` 映射为 `null`（官方 `4=DISPOSED`）、`5` 落 `unloading`（官方 `5=UNLOADING`），但官方 `PluginFiberPhase` 只有 5 个值 + null，**缺 `disposed` 语义**
4. **tsconfig.host.json include 缺 `marketplaceMerge.ts`**：靠传递依赖侥幸编译
5. **`CONTEXT.md` 过期**：声称"未 push"，实测已同步

## 8. 官方标准对齐清单（"绝不多做轮子"）

| 维度 | 官方标准 | 我们 |
|---|---|---|
| 一级入口 | `ctx.slots.inject('settings.section')` | ✅ |
| 样式 | `@deepseek-ai/dsh-client-ui-primitives` | ✅ 不自造组件 |
| i18n | `ctx.locale.register(NS,{zh,en})` | ✅ |
| 状态 | `@deepseek-ai/dsh-client-store` `createSnapshotStore` | ✅ |
| 跨端 | `ctx.remote.<ns>.<method>` + `$on` | ✅ 替代自建 REST |
| 配置 | `ctx.settingsScope.bind()` | ✅ 不碰 YAML |
| 文件锁 | `withFileLock` | ✅ |
| 原子写 | `writeFileAtomic` | ✅ |
| 客户端产物 | `dsh.client` + lazy-CJS factory | ✅ |
| externals | 严格等于官方 `PLATFORM_MODULES`（**9 项含 dockkit**）| ✅ |

## 9. 兼容与迁移

- 只支持 **DSH >= 0.1.6-alpha.2**
- 旧仓库不归档，README 注明由本仓库接续
- 包名不同（`dsh-plugin-manager-companion`），可与旧包共存一段时间
- 迁移：卸载旧包 → 装新包（旧包的 `plugin-manager` 行需清理，见 §7.1）

## 10. 待办（实施阶段）

- [ ] 骨架与构建（package.json / tsconfig ×3 / tsdown.client.config.ts / cordis.patch.yml）
- [ ] 契约测试（client-boot：平台表 + slot 注册面 + 字典键位）
- [ ] 官方 Remote 适配层
- [ ] 环境控制台（诊断引擎 + 环境管理）
- [ ] 质量门包装器
- [ ] 市场搬迁（参考重写，不复制）
- [ ] 技能与预设
- [ ] 官方插件页内的注册（`plugins.item` / `plugins.bundle.config`）
## 11. 传输层决策（实施期补充，取代第 8 节该行的笼统表述）

第 8 节写的"跨端：ctx.remote.<ns>.<method> 替代自建 REST"只对**官方能力**成立。
实测后的精确划分：

| 调用目标 | 通道 | 依据 |
|---|---|---|
| 官方能力（pluginManager.*、pluginInventory.*） | **官方 Typert Remote**，`ctx.remote.<ns>.<method>` | 官方在 `api-remotes` 里按 build-time value import 挂载；第三方可直接注入使用 |
| 本插件自有能力（诊断/环境/市场/技能/配置） | **自有 REST**，注册在 `ctx.webServer.register` | 见下 |

### 为什么自有能力不用官方 Remote

官方 `api-remotes` 的能力集合是**编译期 value import 固定的**（其 README 明说"增加能力需显式
/remote import 与 mount"）。第三方要自带 Remote 就必须用 `@deepseek-ai/dsh-typert-generator`
生成 `./typert` 与 `./remote` 产物；而该生成器在 npm 上的可用版本是 `0.0.1-rc.1`，
远落后于运行时 `0.1.6-alpha.2`。用版本错配的生成器产出运行时反射产物，是比 REST 大得多的风险。

`@deepseek-ai/dsh-host-webserver` 的 `WebRoute` / `WebServer.register` 是**官方公开路由 API**，
不涉及生成器。旧仓库已用它跑通完整链路，包括信任围栏。

### REST 契约（host 与 client 的唯一约定）

- 前缀：`/api2/companion`（**避开**旧仓库的 `/api2/plugin-manager`，两包可能短期共存）
- 只接受 `POST` + `content-type: application/json`
- 信任围栏：Host 必须是回环或白名单；`Origin` 存在时必须同源（防 CSRF/DNS-rebinding）
- 请求体上限分级（默认 1 MiB；备份导入 16 MiB）
- 响应信封：`{ ok: true, value: T }` 或 `{ ok: false, error: { code, message } }`
- 长操作（诊断全量、批量恢复、跨环境 pnpm）必须 job 化：POST 即返 `{ jobId }`，
  客户端轮询 `job` op。理由：HTTP 超时不可与服务端状态脱节。

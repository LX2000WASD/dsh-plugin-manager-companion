# dsh-plugin-manager-companion

DSH 官方插件管理器的补充：安装前质量门、五层环境诊断、多环境管理与插件市场。

[![npm version](https://img.shields.io/npm/v/dsh-plugin-manager-companion)](https://www.npmjs.com/package/dsh-plugin-manager-companion)
[![license](https://img.shields.io/npm/l/dsh-plugin-manager-companion)](LICENSE)

前身是 [dsh-web-plugin-manager](https://github.com/LX2000WASD/dsh-web-plugin-manager)（0.6.3，已停止维护）。
DSH 0.1.6-alpha.2 起官方自带插件管理页，旧仓库"遮蔽官方页面 + 自建写权"的路线不再成立，本仓库为重写。

## 截图

| | |
|---|---|
| ![环境控制台 · 体检](docs/images/readme/01-console-health.png)<br>五层诊断：分组折叠、每条带严重度与证据，查不到的层如实标「未查」 | ![环境控制台 · 环境](docs/images/readme/02-console-envs.png)<br>多环境启停、复制与备份恢复，路径显示成 `~/…` |
| ![插件市场](docs/images/readme/03-marketplace.png)<br>市场卡片：风险、分类与主题徽标；详情是上游事实原文（风险明细、许可证、npm 包名） | ![官方插件页](docs/images/readme/04-official-plugin-page.png)<br>注册进官方插件页，点开自己的条目就是配置表单 |

## 目录

- [它做什么，不做什么](#它做什么不做什么)
- [安装](#安装)
- [三块能力](#三块能力)
- [命令行](#命令行)
- [平台支持](#平台支持)
- [已知限制](#已知限制)
- [参与开发](#参与开发)
- [许可](#许可)

## 它做什么，不做什么

官方插件管理器的 README 列明了自己不做的事，本插件只补这些缺口，不重复官方已有的功能。

| 能力 | 官方 | 本插件 |
|---|---|---|
| 组合包与插件行的启停 | 已有 | 不做 |
| bundle 安装与卸载 | 已有 | 不做（只在安装前插质量门）|
| 插件配置页托管 | 提供插槽 | 作为注册方接入 |
| 安装前静态检查 | 无 | **质量门** |
| 环境诊断 | 无 | **环境控制台 · 体检** |
| 修改另一个 profile | 明确不做 | **环境控制台 · 环境** |
| 普通插件模块的加载 | 声明为文件操作 | 技能与预设安装 |
| 版本列表与更新检测 | 明确不做 | 插件市场 |

写操作一律走官方通道：当前环境用官方 `pluginManager` 服务，跨环境用官方 `runPluginCommand`（带同一把写锁）。
本插件不写 `cordis.patch.yml`，不直接调用 pnpm。

官方四处"明确不做"的原话逐字引用，以及它们各自对应本插件的哪个功能、官方若补上时我们该怎么退场，见
[docs/OFFICIAL-DEPENDENCIES.md](docs/OFFICIAL-DEPENDENCIES.md) §1-F。

## 安装

```sh
dsh plugin --profile <name> add dsh-plugin-manager-companion@latest
```

要求 **DSH >= 0.1.6-alpha.2**。装好后在插件管理页启用，重启该 profile。

## 三块能力

### 安装前质量门

接在官方 `installBundle` 的"装但不激活"开关上，安装失败不会把环境改脏：

1. `inspect(spec)` —— 官方：这个 spec 指向什么；
2. `installBundle(spec, { enabled: false })` —— 官方：装进隔离区，不激活；
3. 扫描这个包 —— 本插件：未声明的 import、声明了但没装、把官方包声明成普通 `dependencies`（会在 profile 里装出第二份拷贝，劫持官方的 loader 行）、入口解析不到；
4. 不合格 → `removeBundle` 回滚；合格 → `setBundleEnabled` 激活。

### 环境控制台

一个设置页入口，三个子页：

- **体检**：五层诊断，每条发现带证据（文件与行号，或运行时对象），处置分三级——可安全自动修、需确认、仅报告。逐条问题都能展开看到它凭什么这么判。
  五层分别是 L1 依赖、L2 组合、L3 运行时、L4 一致性、L5 生态。某一层没查成时，层计数格显示「未查」而不是 0。
- **环境**：列出本机所有 profile 及其运行状态（进程与端口），支持启动（终端窗口或后台）、停止、新建、重命名、删除、跨环境复制插件、备份导出与差异对比与恢复。
- **设置**：本插件的配置。存在官方 settings 服务里，界面上改，不需要编辑配置文件。

### 插件市场与技能预设

市场页展示社区索引，可按名称、仓库、主题与描述搜索，可按星数、更新时间与近期热度排序，卡片上标出风险等级
与可装性（社区精选、需手动安装、非插件条目）。安装走质量门与官方通道；详情里的校验结论与风险明细来自索引本身，并给出原始报告链接。

技能与预设页管理通过本插件安装的 SKILL.md 与 agent 预设，可查看安装记录、重新拉取与卸载。

## 命令行

`dshpmc` 提供与界面等价的能力，用在三种场合：脚本与 CI、偏好终端、以及**界面打不开时的逃生口**。

```sh
dshpmc analyze --profile <name>   # 五层体检；有问题退出码 1
dshpmc list    --profile <name>   # 层栈、依赖、本插件装过的技能与预设
dshpmc install | remove | update | mount | uninstall-kind
```

`update <name>` 把 specifier 重写为 `@latest` 后重装——不带版本号的 `dsh plugin add` 不会升级已声明的范围，
`pnpm update` 也只在已声明的范围内重解析，跨版本升级必须重写 specifier。整个升级过程与界面点击走同一条受保护链路。

`analyze` 不依赖运行中的实例：它只读磁盘，因此配置文件写坏、启动失败的环境同样能给出根因与文件行号。
关键层没有查完时，它会说明本次结论不完整，而不是报健康。

运行在宿主进程内的 agent 不通过命令行做插件写操作：守卫会把裸的 `dsh plugin` / `pnpm` 变更命令拒绝，
并指向官方的 `plugin_manager` 工具。`dshpmc` 走的是与官方工具同一条 pnpm 通道，因此不在拦截范围内。

## 平台支持

全部门禁在 Linux 上运行。各平台情况如下，按事实写。

**Linux**：真机验证过——单元测试与两条真机 e2e。

**Windows x64**：宿主官方支持 Windows；与平台相关的安全修复（内置环境名大小写、进程树终止、带引号命令行识别、`.cmd` 入口、终端降级、跨平台测试入口）已在真 win32 Node 上逐条独立复验。以下面未在真机验证或已知不成立：

- 终端窗口模式依赖 Windows Terminal（`wt`）；没有 wt 的机器自动降级为后台启动，结果里会写明原因。
- 文件权限位（0600/0700）在 Windows 上是空操作；含访问 token 的启动日志只受 profile 目录的 ACL 保护。
- "停止环境"在 Windows 上是 `taskkill /T /F` 强制结束进程树，不是优雅停止（结果文案会写明）；被强制结束的实例不执行退出清理。
- 安装含符号链接的技能或预设仓库需要开发者模式或管理员权限。
- 两条真机 e2e 与视觉取证工具链依赖 bash 与 Chrome/CDP；Windows 上的门禁入口是 `pnpm test`。
- 未验证：ACL、服务账户、无桌面会话；企业策略禁用 PowerShell 时进程事实不可读，此时如实降级为"未知"。

**macOS**：未验证。文件系统默认大小写不敏感，与 Windows 同族的大小写护栏已用同一套判据覆盖。

## 已知限制

- 只支持 DSH >= 0.1.6-alpha.2；更早的版本请用旧仓库的 0.6.x。
- 两条需要修改 `cordis.patch.yml` 结构的修复（删除重复行、删除孤儿行）只给出处置步骤，由用户手工完成——本插件不做这个文件的第二个写者。
- 安装守卫拦的是 agent 的工具调用，拦不住在终端里手敲的命令。
- 环境变量敏感键过滤按形态匹配，不是全集；未匹配的形态仍会进入 git 源安装的子进程。
- L3 的注册名冲突只覆盖 profile 本地包的源码，不扫官方 scope 的行。
- 端口只在实例命令行带 `--port` 时可知；以默认端口启动的 GUI 宿主显示"端口未知"。
- L5 生态层是骨架：不联网、不判定，如实记为「未查」。
- 市场索引与风险分级来自上游索引，本插件只呈现，不作二次判断。

## 参与开发

开发环境、门禁、代码结构与提交前的检查清单见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。
设计权威见 [docs/DESIGN.md](docs/DESIGN.md)，工程纪律见 [docs/CODE-POLICY.md](docs/CODE-POLICY.md)，
host 与客户端契约见 [docs/REST-CONTRACT.md](docs/REST-CONTRACT.md)，依赖的官方事实与升级检查清单见 [docs/OFFICIAL-DEPENDENCIES.md](docs/OFFICIAL-DEPENDENCIES.md)。

## 许可

MIT

# dsh-plugin-manager-companion

DSH 官方插件管理器的补充：安装前质量门、五层环境诊断、多环境管理与插件市场。

[![npm version](https://img.shields.io/npm/v/dsh-plugin-manager-companion)](https://www.npmjs.com/package/dsh-plugin-manager-companion)
[![license](https://img.shields.io/npm/l/dsh-plugin-manager-companion)](LICENSE)

前身是 [dsh-web-plugin-manager](https://github.com/LX2000WASD/dsh-web-plugin-manager)（0.6.3，已停止维护）。
DSH 0.1.6-alpha.2 起官方自带插件管理页，旧仓库遮蔽官方页面并自建写权的做法不再适用，本仓库为重写。

## 截图

| | |
|---|---|
| ![环境控制台 · 体检](docs/images/readme/01-console-health.png)<br>五层诊断：分组折叠，每条带严重度与证据；未查到的层显示「未查」 | ![环境控制台 · 环境](docs/images/readme/02-console-envs.png)<br>多环境启停、复制与备份恢复 |
| ![插件市场](docs/images/readme/03-marketplace.png)<br>卡片标出风险、分类与主题；详情展示索引原文 | ![官方插件页](docs/images/readme/04-official-plugin-page.png)<br>注册进官方插件页，点开自己的条目就是配置表单 |

## 目录

- [它做什么，不做什么](#它做什么不做什么)
- [安装](#安装)
- [能力](#能力)
- [命令行](#命令行)
- [平台支持](#平台支持)
- [已知限制](#已知限制)
- [参与开发](#参与开发)
- [许可](#许可)

## 它做什么，不做什么

官方插件管理器的 README 列明了自己不做的事。本插件只补这些缺口。

| 能力 | 官方 | 本插件 |
|---|---|---|
| 组合包与插件行的启停 | 已有 | 不做 |
| 组合包安装与卸载 | 已有 | 不做（安装前插质量门）|
| 插件配置页托管 | 提供插槽 | 作为注册方接入 |
| 安装前静态检查 | 无 | 质量门 |
| 环境诊断 | 无 | 环境控制台 · 体检 |
| 修改另一个 profile | 明确不做 | 环境控制台 · 环境 |
| 普通插件模块的加载 | 声明为文件操作 | 技能与预设安装 |
| 版本列表与更新检测 | 明确不做 | 插件市场 |

写操作一律走官方通道：当前环境用官方 `pluginManager` 服务，跨环境用官方 `runPluginCommand`。
本插件不写 `cordis.patch.yml`，不直接调用 pnpm。

官方四处「明确不做」的原文引用、对应的本插件功能，以及官方补上后的退出方式，见
[docs/OFFICIAL-DEPENDENCIES.md](docs/OFFICIAL-DEPENDENCIES.md) §1-F。

## 安装

```sh
dsh plugin --profile <name> add dsh-plugin-manager-companion@latest
```

要求 DSH >= 0.1.6-alpha.2。装好后在插件管理页启用，重启该 profile。

## 能力

### 安装前质量门

接在官方 `installBundle` 的「装但不激活」开关上：

1. `inspect(spec)`：官方确认这个 spec 指向什么；
2. `installBundle(spec, { enabled: false })`：官方装进环境，不激活；
3. 扫描该包：未声明的 import、声明了但没装、把官方包声明成普通 `dependencies`（会在 profile 里装出第二份副本，让官方 loader 行解析到它）、入口解析不到；
4. 不合格则 `removeBundle` 回滚，合格则 `setBundleEnabled` 激活。

试装默认关闭。开启后，候选包会先装进 `<环境名>-dpmc` 测试环境并启动一次，通过后才装进真实环境。测试环境不设数量上限，默认保留 14 天。试装会在本机真实安装候选包并执行它自带的安装脚本。

### 环境控制台

一个设置页入口，三个子页：

- **体检**：五层诊断。每条发现带证据（文件与行号，或运行时对象），处置分三级：可自动修复、需确认、仅报告。五层为 L1 依赖、L2 组合、L3 运行时、L4 一致性、L5 生态；某一层未查时，层计数显示「未查」，不显示 0。
- **环境**：列出本机所有 profile 及其运行状态（进程与端口），支持启动（终端窗口或后台）、停止、新建、重命名、删除、跨环境复制插件、备份导出、差异对比与恢复。
- **设置**：本插件配置，保存在官方 settings 服务中，在界面上修改。

### 插件市场与技能预设

市场页展示社区索引，支持按名称、仓库、主题与描述搜索，按星数、更新时间与近期热度排序。卡片标出风险等级与可装性（社区精选、需手动安装、非插件条目）。安装走质量门与官方通道。详情展示索引中的校验结论与风险明细，并给出原始报告链接。

技能与预设页管理通过本插件安装的 SKILL.md 与 agent 预设，可查看安装记录、重新拉取与卸载。

### 升级

设置页「关于」列出官方运行时、官方实验包与本插件自身的版本状态。检查更新按需触发，也可手动检查；版本选择列出全部 dist-tags，默认选中与当前同线的最新版本。升级走官方通道，并在测试环境中先验证一遍；未通过验证的版本不会装进真实环境。新版本在下次启动时加载。

## 命令行

`dshpmc` 提供与界面等价的能力，用于脚本与 CI、终端操作，以及界面打不开时的备用入口。

```sh
dshpmc analyze --profile <name>   # 五层体检；有问题退出码 1
dshpmc list    --profile <name>   # 组合层、依赖、本插件装过的技能与预设
dshpmc install | remove | update | mount | uninstall-kind
```

`update <name>` 把依赖声明重写为 `@latest` 后重装。不带版本号的 `dsh plugin add` 不会升级已声明的范围，`pnpm update` 也只在已声明范围内重解析，跨版本升级必须重写声明。整个升级过程与界面操作走同一条链路。

`analyze` 不依赖运行中的实例，只读磁盘，配置文件写坏或启动失败的环境同样能给出根因与文件行号。关键层未查完时，它说明结论不完整，不报健康。

宿主进程内的 agent 不能通过命令行做插件写操作：守卫拒绝裸的 `dsh plugin` 与 `pnpm` 变更命令，并指向官方 `plugin_manager` 工具。`dshpmc` 走与官方工具相同的 pnpm 通道，不在拦截范围内。

## 平台支持

全部检查在 Linux 上运行。

**Linux**：已实机验证，含单元测试与两条端到端检查。

**Windows x64**：宿主官方支持 Windows。与平台相关的安全修复（内置环境名大小写、进程树终止、带引号命令行识别、`.cmd` 入口、终端降级、跨平台测试入口）已在真实 win32 Node 上逐条独立复验。以下各项未在真机验证或已知不成立：

- 终端窗口模式依赖 Windows Terminal（`wt`）；没有 wt 的机器降级为后台启动，结果中写明原因。
- 文件权限位（0600/0700）在 Windows 上是空操作；含访问 token 的启动日志只受 profile 目录的 ACL 保护。
- 停止环境在 Windows 上是 `taskkill /T /F` 强制结束进程树，不是优雅停止；被强制结束的实例不执行退出清理。
- 安装含符号链接的技能或预设仓库需要开发者模式或管理员权限。
- 两条端到端检查与截图工具依赖 bash 与 Chrome/CDP；Windows 上的检查入口是 `pnpm test`。
- 未验证：ACL、服务账户、无桌面会话。企业策略禁用 PowerShell 时进程信息不可读，此时显示「未知」。

**macOS**：未验证。文件系统默认大小写不敏感；与 Windows 同类的大小写检查已覆盖。

## 已知限制

- 只支持 DSH >= 0.1.6-alpha.2；更早的版本请用旧仓库的 0.6.x。
- 两条需要修改 `cordis.patch.yml` 结构的修复（删除重复行、删除孤儿行）只给出步骤，由用户手工完成。本插件不写这个文件。
- 质量门回滚可能失败：官方拒绝移除部分组合包时（例如它被官方保护），结果中会说明残留，需要手工删除。
- 安装守卫拦的是 agent 的工具调用，拦不住在终端里手敲的命令。
- 环境变量敏感键过滤按形态匹配，不是全集；未匹配的形态仍会传给 git 源安装的子进程。
- L3 的注册名冲突只覆盖 profile 本地包的源码，不扫官方 scope 的行。
- 端口只在实例命令行带 `--port` 时可知；以默认端口启动的宿主显示「端口未知」。
- L5 生态层不联网、不判定，记为「未查」。
- 市场索引与风险分级来自上游索引，本插件只呈现，不作二次判断。

## 参与开发

开发环境、检查项、代码结构与提交前清单见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。
设计见 [docs/DESIGN.md](docs/DESIGN.md)，工程纪律见 [docs/CODE-POLICY.md](docs/CODE-POLICY.md)，
宿主与客户端契约见 [docs/REST-CONTRACT.md](docs/REST-CONTRACT.md)，依赖的官方事实见 [docs/OFFICIAL-DEPENDENCIES.md](docs/OFFICIAL-DEPENDENCIES.md)。

## 许可

MIT

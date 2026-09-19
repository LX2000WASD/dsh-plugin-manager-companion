# dsh-plugin-manager-companion

**官方插件管理器的伴生补强**：官方管"装什么、开什么"，我们管"装得对不对、环境健不健康、整个机器怎么管"。

> 前身是 [dsh-web-plugin-manager](https://github.com/LX2000WASD/dsh-web-plugin-manager)（0.6.3，已停止维护）。
> DSH 0.1.6-alpha.2 起官方自带插件管理页，旧仓库的"遮蔽 + 自建写权"路线不再成立，因此重写为本仓库。

## 为什么需要它

官方 README 明文写了自己**不做**的事，这四条就是我们的作业面：


| 官方原文 | 我们补什么 |
|---|---|
| "The manager cannot … **change another profile**" | 环境管理：多环境启停/创建/重命名/删除/复制/备份恢复 |
| "The manager cannot … **edit an agent preset’s composition**" | 技能与预设：SKILL.md 与 agent.cordis.yml 直装、归属管理 |
| "**Only bundles are managed** — loading plain plugin modules stays a file operation" | 技能/预设安装；非 bundle 插件的盘点 |
| "**No version picker** — neither lists registry versions nor offers upgrades" | 市场索引 + 更新检测 |

外加官方完全没有的：**安装前质量门**（装但不激活 → 扫描 → 放行或回滚）与**深度诊断**。

## 三个页面

| 入口 | 内容 |
|---|---|
| **插件市场** | 索引浏览、搜索、分类、排序；安装走"质量门 + 官方通道" |
| **环境控制台** | 一个入口三个子页：**体检**（五层诊断 + 分级修复）／**环境**（启停/新建/重命名/删除/复制/备份）／**设置** |
| **技能与预设** | 安装记录、重新拉取、卸载 |

## 与官方的分工（硬约束）

- 当前环境的写操作**全部走官方** `ctx.remote.pluginManager.*` / 宿主 `ctx.pluginManager`
- 跨环境写操作走官方 `./operations` 的 `runPluginCommand`（换一个 profile 参数，不自建 pnpm）
- 配置走官方 `ctx.settings`，**不编辑配置文件**
- **不写 `cordis.patch.yml`**：唯一没有官方通道的两条修复（删重复行/删孤儿行）如实回 `needs-manual`，不做第二写者

## 安装

```sh
dsh plugin --profile <name> add dsh-plugin-manager-companion@latest
```

要求 **DSH >= 0.1.6-alpha.2**（依赖官方 `pluginManager` Remote 面）。

## 诊断的五层

| 层 | 数据源 | 检出 |
|---|---|---|
| L1 依赖 | import 图 + package.json | 缺失依赖、未声明 import、官方包重复、peer 不满足 |
| L2 组合 | 官方 composeEntries + patch 层栈 | 行 id 重复、被禁用依赖、孤儿行、不可寻址行 |
| L3 运行时 | 官方 inventory / Loader 直读 | 失败 fiber、长期 pending（点名缺哪个服务）、注册名冲突 |
| L4 一致性 | 官方 inventory vs 本地 manifest | 声明未加载、加载未声明、未挂载依赖 |
| L5 生态 | 市场索引 | **当前是骨架**：诊断路径上不联网、不做判定，报告里如实标为「未查」而不是「0 问题」 |

每条发现都带**证据链**（可点到文件行/运行时对象），并分三级处置：`safe-fix` / `confirm-fix` / `report-only`。

## 质量门

官方 `installBundle` 有"装但不激活"的开关，质量门正是接在这里：

```
1. inspect(spec)                            ← 官方：读 spec 指向什么
2. installBundle(spec, { enabled: false })  ← 官方：装进隔离区
3. 扫描已安装包（我们的质量门）               ← 独有
4. 不合格 → removeBundle    合格 → setBundleEnabled
```

零竞态窗口、零自建 pnpm、零 patch 写入。检查项：未声明 import、声明了但没装、
官方包被声明成普通 `dependencies`（模块身份分裂会劫持官方 loader 行）、Node 内置模块豁免。

## 命令行（`dshpmc`）

Web UI 之外还有一条命令行通道，**它的主要用途是逃生口**：环境因为 patch 或依赖问题
启动阶段就硬失败时，界面根本打不开，这时 `dshpmc analyze` 能脱离活着的 loader 只读磁盘跑完诊断
并指出根因（`duplicate loader entry id` / `cannot resolve profile bundle` / `ERR_MODULE_NOT_FOUND`）与文件行号。

```sh
dshpmc analyze --profile <name>     # 深度体检；发现问题退出码 1，关键层没跑完时也不会报成"健康"
dshpmc list   --profile <name>     # 层栈 / 依赖 / 本插件装过的技能与预设
dshpmc install | remove | update | mount | uninstall-kind
```

## 开发

```sh
pnpm install
pnpm run build   # host: tsc; client: tsc + tsdown
pnpm test        # build + node --test（测试 import dist 产物）

bash tools/e2e-lifecycle.sh   # 真机：建环境 → 启动 → 可达 → 停止（14 项断言）
bash tools/e2e-visual.sh      # 真机浏览器：三个页面 + 官方插件页内注册（16 项断言）
```

验收命令是 `pnpm test`（它先 build）。直接跑 `node --test` 会拿碰巧躺在 `dist` 里的那份当被测物，
属静默假绿——见 [docs/CODE-POLICY.md](docs/CODE-POLICY.md) §7.6。

约定见 [docs/CODE-POLICY.md](docs/CODE-POLICY.md)（"参考不复制"三分类准入 + 工具红线），
设计权威见 [docs/DESIGN.md](docs/DESIGN.md)，host↔client 契约见 [docs/REST-CONTRACT.md](docs/REST-CONTRACT.md)。

## 已知限制

- 只支持 DSH >= 0.1.6-alpha.2；老版本请用旧仓库的 0.6.x
- 两条需要改 `cordis.patch.yml` 结构的修复回 `needs-manual`（设计取舍，见 CODE-POLICY）
- 安装守卫只拦 agent 的工具调用，拦不住用户在终端手敲裸命令
- 环境变量敏感键过滤是形态匹配而非全集；未匹配形态仍会进入 git 源安装的子进程
- L3 的注册名冲突只覆盖 profile 本地包源码，不扫官方 scope 的行
- 端口只在实例命令行带 `--port` 时可知，GUI 宿主那种默认端口启动的实例显示"端口未知"
- **L5 生态层是骨架**：不联网、不判定，如实记为「未查」
- "真实宿主拒绝安装"（`result.ok=false` 形态）没有真机取证：能产生它的动作要么真的改动环境、
  要么依赖网络随机性；该行为由单测钉住（含 `callOp` 抛异常的形态）
- 官方仍在 prerelease 快速迭代（基线 `0.1.6-alpha.2`）。旧仓库正是被官方新增一行 `id: plugin-manager`
  撞死的，所以升级官方版本前应先跑一遍本仓库的门禁与真机脚本

## 许可证

MIT

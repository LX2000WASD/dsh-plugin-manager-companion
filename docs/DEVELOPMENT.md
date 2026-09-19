# 开发指南

面向要改这个仓库的人。目标：看完能跑起来、知道改一处要验什么、以及哪些事不要做。

## 1. 前置

- Node **^22.19 或 >= 24**（仓库用 ESM + 顶层 await；官方 engines 同款要求）。
- pnpm（官方 CLI 的包操作通道就是转发给它）。
- 一个可用的 DSH 安装，**>= 0.1.6-alpha.2**。本插件的运行期依赖是官方服务与官方模块接口，不针对更早版本降级。

## 2. 跑起来

```sh
pnpm install
pnpm run build          # host: tsc；client: tsc + tsdown
pnpm test               # 先 build，再跑 tests/*.test.mjs
```

要在一个真实实例里看效果，**不要改你正在用的 profile**：

```sh
# 造一个临时 profile（复制 pm-test 的清单文件 + 安装依赖 + 链接本仓库）
bash tools/e2e-lifecycle.sh          # 会自己建临时 profile、跑完自清
node tools/e2e-lifecycle.mjs         # 同上，零 bash 版本
bash tools/e2e-visual.sh             # 真浏览器跑三个页面 + 官方插件页内注册
```

两个脚本都在跑完时自清。手工起实例时用自己的端口号段，见 §6。

## 3. 命令与验收口径

| 命令 | 作用 |
|---|---|
| `pnpm run build` | host + client 全量构建 |
| `pnpm run build:host` | 只构建 host（改了 `src/*.ts` 时够用） |
| `pnpm run build:client` | 只构建客户端 bundle |
| `pnpm typecheck` | `tsc --noEmit`，不产出 |
| `pnpm test` | **唯一验收命令**：先 build 再跑测试 |
| `node tools/e2e-lifecycle.mjs` | 真机走完"建环境 → 启动 → 可达 → 停止"（14 项断言） |
| `bash tools/e2e-visual.sh` | 真浏览器 16 项断言 |

**测试读的是 `dist/`，不是源码。** 所以验收命令只有 `pnpm test`（它先 build）；直接 `node --test` 是在拿
"碰巧躺在 dist 里的那一份"当被测物，那是静默假绿。同理，`git stash` 做 A/B 对照是无效的——它只回退源码，
`dist/` 还是你自己构建的那份。细节见 [CODE-POLICY.md](CODE-POLICY.md) §7.6 与 §7.9。

## 4. 代码在哪

```
src/
  index.ts          23 个 REST op 的分派与装配（host 入口）
  diagnostics.ts    诊断引擎：五层、证据、分级处置、修复动作
  envManager.ts     环境生命周期、跨环境包操作、备份、试装引擎
  qualityGate.ts    安装前静态检查
  guard.ts          安装守卫（拦 agent 的工具调用）
  installSession.ts 受质量门保护的安装流程
  marketplace.ts    索引抓取与缓存   marketView.ts / rank.ts / match.ts / tags.ts  # 纯函数：视图、排序、匹配、标签
  kinds.ts          技能与预设   presets.ts
  settings.ts       本插件配置（官方 settings 服务）   rest.ts 自有 REST 的路由与 job   official.ts 官方能力探针
  cli.ts            dshpmc 命令入口
  client/           客户端半边：ConsolePage / MarketplacePage / KindsPage / OfficialSlots / wire.ts / locales.ts
tests/              单元测试（import dist 产物）
tools/              真机脚本与取证工具
docs/               见 §8
```

host 与客户端的边界只有一条：**自有能力走自有 REST（`/api2/companion`），官方能力由客户端直连官方 Remote**。
契约写在 [REST-CONTRACT.md](REST-CONTRACT.md)。

## 5. 改一处要验什么

| 改动面 | 最小门禁 |
|---|---|
| 任意源码 | `pnpm test` |
| 客户端组件 / 文案 / 样式 | 上面的 + `bash tools/e2e-visual.sh` |
| 环境生命周期（启动/停止/创建/删除） | 上面的 + `node tools/e2e-lifecycle.mjs` |
| 安装路径 / 质量门 | 上面的 + 手工走一次"装但不激活 → 扫描 → 放行或回滚" |
| 任何"文案或状态"的行为 | 加一条断言，并做**变异验证**：改回旧行为必须报红 |

没有变异验证的护栏不算护栏——本仓库有过"护栏在旧代码上依然全绿"的实例，见 [CODE-POLICY.md](CODE-POLICY.md) §7.4。

## 6. 真机验证的纪律

- **不碰别人的环境**：用户的 GUI（3080）与任何他人正在用的 profile 一律不动。
- **端口按人分号段**，只在自己的号段里起实例，收尾只看自己的号段（见 [CODE-POLICY.md](CODE-POLICY.md) §7.7）。
- **临时状态用临时 `DSH_HOME`**：需要改外观、配置或环境状态时用临时 home——全局设置文件**不在 profile 里**，
  这一点很容易漏，漏了就会改掉用户正在用的 GUI 的外观（见 §7.11）。
- **真机结论要附产物标识**（`dist` 的 md5 或时间戳 + git HEAD），否则事后无法判断结论对应哪一份构建（见 §7.8）。

## 7. 提交前

1. `pnpm typecheck` 与 `pnpm test` 全绿，且**确认没有别人正在编辑 `src/`**（并发编辑期间的绿红都不算结论）。
2. `git status --porcelain` 看一遍：**凡是你叫不出"它属于哪个任务"的文件，就不要提交**。
3. 按路径显式 `git add`，不要用 `git add -A`（会把别人在途的改动扫进来，见 §7.10）。
4. 提交信息写清"改了什么 / 为什么 / 怎么验的"，验收数字要能复现。

## 8. 文档地图

| 文档 | 作用 |
|---|---|
| [DESIGN.md](DESIGN.md) | 设计权威：与官方的分工、页面结构、诊断分层、质量门、传输层决策、UI 文案标准 |
| [CODE-POLICY.md](CODE-POLICY.md) | 工程纪律与**事故史**：每条规则都是从一次真实事故里长出来的，动手前值得读一遍 |
| [REST-CONTRACT.md](REST-CONTRACT.md) | host 与客户端之间唯一的约定 |
| [OFFICIAL-DEPENDENCIES.md](OFFICIAL-DEPENDENCIES.md) | 依赖的官方事实逐条清单 + 官方升级后要跑的检查序列 |
| `docs/private/` | 本地工作记录（审计报告等），不进版本 |

## 9. 不要做的事（红线）

- **不写 `cordis.patch.yml`**：它是组合的第二个写者风险来源。需要改结构的两条修复如实回报"需人工"，并给出文件与行号。
- **不直接调用 pnpm**：跨环境包操作走官方 `runPluginCommand`（它带 profile 写锁）。
- **不注册官方已有的服务名**（例如 `pluginManager`），不要把 loader 行 id 取成官方已有的值——两者都会让 profile 起不来。
- **不遮蔽官方页面**：官方插件管理页是唯一入口，本插件只往它的插槽里注册。
- **不把"不知道"说成"知道"**：查不到的事实显示为"未知"或"未查"，并给出原因；这条贯穿诊断、环境状态、市场索引与试装结论。

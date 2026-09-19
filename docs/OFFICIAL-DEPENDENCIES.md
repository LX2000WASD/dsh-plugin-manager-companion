# 官方依赖清单（DSH 升级检查单）

这份文件回答一个问题：**官方改了以后，我们该跑什么、看什么信号、先看哪一行。**
我们是伴生包（peerDependencies 是 ^0.1.6-alpha.2），官方还在 prerelease 快速迭代；
历史事故已经证明：一次官方改动可以让我们这边**整个 profile 起不来**，而现在没有成文的检查单。

## 怎么用这份文件

1. **升级官方版本前**：先读第 1 节里标 `起不来` 或 `静默` 的条目，它们在升级后最可能出问题。
2. **升级后**：按第 2 节的最小 smoke 序列顺序跑一遍，任何一步失败就按第 1 节的「先看哪行」定位。
3. **踩到新坑后**：把它补进第 3 节事故表（含「当初是怎么发现的」），这是这份文件唯一需要持续维护的部分。

## 来源约定（每条都必须能追）

- 我们的代码：`src/...`（相对本仓库根），行号是写作时的行号。
- 官方代码：`<harness>/packages/...`，其中 `<harness>` = `deepseek-harness` checkout（本文件基于 tag `dsh-v0.1.6-alpha.2`）。
- 官方依赖包（不在 checkout 里）：`node_modules/@deepseek-ai/<pkg>/lib/...` + 版本号。
- **行号会漂移**。定位时优先按符号名 grep，不要只认行号：`grep -rn '<符号>' packages/`。

## 状态图例

| 状态 | 含义 |
|---|---|
| 已实测 | 真机或契约测试验证过（含"官方这样改会怎样"的对照实验） |
| 仅读代码 | 只核对了官方源码/类型，没有做过变更对照实验 |
| 不确定 | 结论里有推断成分，或依赖的外在条件无法在当前环境验证 |

## 后果三档（第 3 列只用这三档 + 具体表现）

- **起不来**：profile 启动阶段失败，用户连界面都没有（最严重，优先盯）。
- **明确报错**：功能不可用但用户/模型能读到稳定错误（可接受）。
- **静默降级**：不报错但结果不对（最危险，必须有测试或 smoke 兜住）。

## 1. 逐条依赖清单

### A. Host 服务与上下文

| # | 依赖什么（符号/字段/语义） | 我们在哪用（file:line） | 变了会怎样 | 怎么最快发现 | 先看哪行 | 状态 |
|---|---|---|---|---|---|---|
| A1 | loader 行 id 在**同一个 insert 列表内**唯一；跨列表同名不算冲突（per-group 查重） | `cordis.patch.yml:8`（id 用包名，绝不用 `plugin-manager`） | **起不来**：`TypeError: duplicate loader entry id`，启动前退出 | `grep -n 'id:' cordis.patch.yml`；真机 `bash tools/e2e-lifecycle.sh`；坏环境上 `node dist/cli.js analyze` 会报 `duplicate-row-id` 带行号 | 官方 `packages/bundle/base/cordis.patch.yml:16,20`（官方 base 自带 `tool-plugin-manager` 与 `plugin-manager` 两行）；loader 实现在 `node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js:91`（v1.0.3，源码 `src/config/group.ts`） | 已实测（旧仓库 P0-A：docs/DESIGN.md:131；per-group 语义由 docs/private/visual-audit.md:422-429 真机纠正；本仓库 task-26 真机复现） |
| A2 | 服务名 `pluginManager` 已被官方占用（`PluginManager extends TypertRemoteService`） | 只读探测：`src/official.ts:64`（`ctx.get('pluginManager')`）、`src/official.ts:128`（requireManager） | **起不来**：同名 `provide` 让注册直接抛错 | `grep -rn "provide('pluginManager'\|super(ctx, 'pluginManager'" src/`（应为空）；真机启动 | 官方 `packages/boot/plugin-manager/src/index.ts:131-132`；我们的探测 `src/official.ts:60-76` | 已实测（旧仓库 P0-B：docs/DESIGN.md:132；抓取文本见 docs/private/test-env-feasibility.md:120） |
| A3 | 官方 manager 行的装配门控：没有 `profileContext` 时不装配（`disabled: !!js "!ctx.get('profileContext')"`） | `src/official.ts:60-76` 用**探针**而不是声明式 inject，并把缺失原因写进 `missing` | **静默降级**：插件仍加载，但当前环境管理能力缺失（我们如实显示原因） | 宿主内看 capabilities；`node --test tests/rest.test.mjs` | `src/official.ts:40-76`；官方 `packages/bundle/base/cordis.patch.yml` 的 plugin-manager 行 | 仅读代码（门控在官方 base patch 里；未做过"官方去掉门控"的对照） |
| A4 | PluginManager 方法面：`listPlugins/listBundles/inspect/setPluginEnabled/setBundleEnabled/installBundle/removeBundle` | 结构式视图 `src/official.ts:88-105`；调用点 `src/index.ts:182`（inspect）、`src/envManager.ts`、`src/fix.ts` | **明确报错**（调用点 TypeError）；若某个方法被改名，只有走到那条路径才发现 | `grep -n 'listPlugins\|setBundleEnabled\|installBundle\|removeBundle' packages/boot/plugin-manager/src/index.ts`（官方）；`pnpm typecheck` | `src/official.ts:88-105`（我们只声明用到的方法，不 import 官方类） | 仅读代码（方法名逐个对照过官方源码 0.1.6-alpha.2） |
| A5 | `inspect()` 的 refused 问题闭集与 `already-installed` 语义 | `src/index.ts:162,182`（质量门/修复前置检查）；拒绝文案映射在 `src/index.ts` 的 gatedInstall 路径 | **明确报错**（多一个新 problem 值 → 落到 unknow 分支，文案变差）；语义变化会让"修复依赖"按钮直接失败（历史事故） | `grep -n 'already-installed' packages/boot/plugin-manager/src/index.ts`（官方 :262,:267）；真机跑一次"缺依赖 → 修复" | 官方 `packages/boot/plugin-manager/src/types.ts:114-122`（problem 闭集）；`src/index.ts:162` | 已实测（docs/private/write-path-audit.md:64,133-135 真机看到 `拒绝安装：already-installed`） |
| A6 | `readPluginInventory(ctx)` 的投影 + `PluginFiberPhase` 五值 + `pluginEntryId()` | `src/official.ts:150-190`（官方投影优先，失败降级 Loader 直读）；类型 re-export `src/types.ts:26-31` | **静默降级**：`source` 变成 `loader` 或 `unavailable`，并在 report.skipped 里说明（不假装健康） | `node --test tests/diagnostics.test.mjs`；`grep -n 'FIBER_PHASE' packages/host/plugin-inventory/src/index.ts` | `src/official.ts:204`（`fiberPhaseOf` 数值映射必须与官方一致）；官方 `packages/host/plugin-inventory/src/index.ts:40-47`、`packages/host/plugin-inventory/src/types.ts:7` | 仅读代码（旧仓库踩过相位映射错：docs/DESIGN.md:133；这一版逐值对齐，未做变更对照） |
| A7 | `ctx.loader.entries()` 行形状：`id` / `options.id` / `options.name` / `options.group` / `disabled` / `fiber.state` | `src/official.ts:161-180`（降级路径） | **静默降级**：字段读不到 → 行数与相位不准（会在 skipped 里记 loader fallback failed） | `node --test tests/diagnostics.test.mjs`（fiber failed / pending 用例） | `src/official.ts:161-186` | 仅读代码（对照官方 plugin-inventory 的读取口径，未做过变更对照） |
| A8 | `defineTool({name,description,parameters,output:{schema,render},execute})` 与 `ctx.tools.register` | `src/tools.ts:245`（createCompanionTools）、`src/tools.ts:476`（registerCompanionTools） | **明确报错**：编译期（类型）或运行期（schema 校验拒绝）都会响亮失败 | `pnpm typecheck`；`node --test tests/scan.test.mjs`（含"缺必填参数被 schema 拒绝"用例） | 官方 `packages/core/tools/src/schema.ts:545`（defineTool）；我们 `src/tools.ts:245` | 已实测（工具 execute 与参数校验在测试里真跑） |
| A9 | `ctx.tools.guard(fn)`：**单调拒绝**（返回 string 即拒绝，没有 allow 结果，顺序无法翻回放行） | `src/guard.ts:228-232`（registerPluginGuard） | **静默**（若将来语义变成可 allow，别人的守卫能放行我们的拒绝 → 防护变薄，需重审） | `node --test tests/kinds.test.mjs`（守卫注册面 + 拒绝原因用例） | `src/guard.ts:228`；官方 `packages/core/tools/src/index.ts:1116`（guard 注册）与 `:706-712`（ToolGuard 语义） | 已实测（注册面与拒绝行为）；"无人能翻回放行"是读官方注释 |
| A10 | `ctx.systemPrompt.section({name,order,text})` + 官方段位表（`SECTION_ORDERS`） | `src/guard.ts:194-200`（order 300，落在官方 `DEPLOYMENT_PERSONA_PREFIX=0` 与 `PLAN_POLICY=500` 之间） | 重复 name 会**明确报错**；段位表变动 → 我们的提示语**静默**换位置（不致命） | `node --test tests/kinds.test.mjs`（断言 name/order）；`grep -n 'DEPLOYMENT_PERSONA_PREFIX\|PLAN_POLICY' packages/core/system-prompt/src/index.ts` | 官方 `packages/core/system-prompt/src/index.ts:125-145`（段位表）、`:455`（section） | 已实测（注册面）；段位值仅读代码 |
| A11 | `ctx.settings.register(namespace, schema)`（命名空间唯一，重复注册抛错）+ schemastery 默认值/未知键语义 | `src/settings.ts:181-192`（registerConfig） | **起不来**（注册冲突会沿 apply 抛出去，阻断装配）；**静默**（schema 默认值语义变化 → 旧配置读成默认值） | `pnpm test`（配置相关用例）；宿主内看 capabilities/config | `src/settings.ts:181`；官方 `packages/settings/settings/src/index.ts:419` | 仅读代码（冲突路径没有实测过） |
| A12 | `ctx.get('agentPresets')`：`list()` / `remove(id)` / `roots`（`trust: 'user'`） | `src/presets.ts:268`（agentPresetsOf）、`src/presets.ts:285`（userPresetRoot 优先取 roster 的 user root）、`src/presets.ts:429`（cleanupOwnedPresets 优先走官方 remove） | **静默降级**（服务缺失 → 直删并在 notes 里说明"未经宿主服务"）；若官方 remove 不再清 settings.default → **静默**（残留默认预设） | `node --test tests/presets.test.mjs`；真机 REST 卸载一次看目录与记录是否双清 | `src/presets.ts:429`；官方 `packages/preset/agent-presets/src/index.ts:104,285,515,631` | 已实测（task-25 真机 REST 卸载走这条链；"官方删掉 remove"未做对照） |
| A13 | `ctx.webServer.register({kind:'prefix',path,handler})`（重复 route 抛错） | `src/index.ts:494-497`（服务探测）、`src/rest.ts:19`（ROUTE_PREFIX = /api2/companion） | **起不来**（前缀被别的插件占用时 register 抛错） | `node --test tests/rest.test.mjs`；真机 `curl -s -X POST http://127.0.0.1:<port>/api2/companion/listKinds -H 'content-type: application/json' -d '{}'` | `src/index.ts:494`；官方 `packages/host/webserver/src/index.ts:144,165-171` | 已实测（REST 往返：task-25/26 真机） |
| A14 | `ctx.profileContext` 字段面：`name/dir/installAnchor/cwd/home/patchPath/startedBundles` | `src/official.ts:60`、`src/envManager.ts:897,1503`、`src/diagnostics.ts:381`、`src/index.ts:70`、`src/cli.ts:229` | **静默降级**（拿不到 → 当前环境识别成未知 / 锚点缺失 → 诊断记 skipped）；写路径**明确报错**（拒绝猜锚点） | `node dist/cli.js analyze --profile <p>` 看 `install anchor:` 行；`node --test tests/envManager.test.mjs tests/cli.test.mjs` | `src/envManager.ts:897`（锚点来源优先级）；官方 `packages/boot/app-boot/src/profile-context.ts:15-30` | 已实测（锚点链在 task-26 真机用到） |
| A15 | 官方 `plugin_manager` agent 工具的动作枚举：`list_plugins/list_bundles/set_plugin/set_bundle/install_bundle/remove_bundle` | `src/guard.ts:150-200`（拒绝原因与常驻提示段逐字引导这些动作） | **静默**（动作改名 → 我们的引导文案指向不存在的动作，模型会反复重试失败） | `grep -n 'action:' packages/boot/plugin-manager/src/tools.ts`（官方） | 官方 `packages/boot/plugin-manager/src/tools.ts:19-28`；我们 `src/guard.ts:150`、`src/guard.ts:194` | 仅读代码（按官方源码逐字写死；未在宿主里实跑过 install_bundle） |
### B. Profile 事实与写路径（官方 operations / app-boot / atomic-write）

| # | 依赖什么（符号/字段/语义） | 我们在哪用（file:line） | 变了会怎样 | 怎么最快发现 | 先看哪行 | 状态 |
|---|---|---|---|---|---|---|
| B1 | `runPluginCommand(context, args, options)`：context 字段 `profile/dir?/installAnchor/cwd/home?`，options 字段 `execution/outputBytes/lockWaitMs/env/onOutput/activateNewBundles?` | `src/cli.ts:284`（动态 import）、`src/cli.ts:308` 起（runProtectedOperation）、`src/envManager.ts:38,1547,2019`、`src/fix.ts:192-193` | **明确报错**（字段/签名变化会在调用点抛）；`execution` 语义变化（cli vs service：输出继承与 env 净化不同）→ **静默**的风险在输出/环境面 | `pnpm typecheck` + `node --test tests/cli.test.mjs`（注入替身核对参数与上下文）+ 真机 `node dist/cli.js list` | `src/cli.ts:284`；官方 `packages/boot/plugin-manager/src/operations.ts:15-39`（context/options）、`:173`（runPluginCommand） | 部分实测：参数构造与转发有测试；**真跑 pnpm 未在本仓库验证（不确定）** |
| B2 | pnpm 语义：`add <spec>` / `remove <name>` / 已声明范围下 `add` 不升级（升级要 `add <name>@latest`） | `src/cli.ts:891`（update 重写 specifier 到 @latest） | **静默**：若官方 pnpm 通道改用别的动词或默认策略变化，update 会"成功但没升级" | 真机：`node dist/cli.js update <pkg>` 后看官方 manager 列表里的版本 | `src/cli.ts:891`；官方 `packages/boot/plugin-manager/src/index.ts:358`（install 用 `add`）、`:441`（remove 用 `remove`） | 仅读代码（旧仓库 README 记录过同类语义；本仓库未真跑） |
| B3 | `withFileLock(path, fn, {waitMs?})` 与 `writeFileAtomic(path, content, {mode})` | `src/envManager.ts:36,1988`（锁住 package.json 的读改写）、`src/fix.ts:190-193` | **明确报错**（签名变化）；锁默认等待语义变化 → **静默**（并发写风险） | `pnpm typecheck`；`node --test tests/envManager.test.mjs tests/fix.test.mjs` | 官方 `packages/util/atomic-write/src/index.ts:78`（writeFileAtomic）、`:129`（FileLockOptions.waitMs）、`:158`（withFileLock） | 仅读代码 |
| B4 | `readProfileManifest(binName, dir)` / `saveManifest(dir, manifest)` / `writeProfileBundles(dir, manifest, bundles)` | `src/envManager.ts:38,2003`、`src/fix.ts:191-192`；诊断另用我们自实现的读取器 `src/paths.ts:74` | **明确报错**（字段缺失）或 **静默**（bundles 读成空 → 诊断说"没有层栈"，而那是假的） | `node dist/cli.js list --profile <p>`（对着真实 package.json 看层栈/依赖）；`node --test tests/envManager.test.mjs` | 官方 `packages/boot/app-boot/src/profile.ts:768`、`packages/boot/app-boot/src/profile-plugins.ts:86`、`packages/boot/plugin-manager/src/operations.ts:68` | 部分实测（list 在真机跑过；写路径仅单测） |
| B5 | `loadProfileDirectory(binName, dir, anchor, {userLayer})` 与 `composeEntries(patches)` 的**抛错行为与文本** | `src/diagnostics.ts:892-922`（readComposition：官方口径优先，失败落 skipped） | **静默**（若官方改成不抛 → 我们的"官方口径"证据消失，只剩下我们自己的纯文本检查）；抛错文本变化 → skipped 文本变化（内容仍在） | `node --test tests/diagnostics.test.mjs`；真机：坏环境上 `node dist/cli.js analyze --profile <p>` 应出现 boot-blocking 段 | 官方 `packages/boot/app-boot/src/profile.ts:864`（cannot resolve profile bundle）、`:879`、`:944` | 已实测（task-26 真机：`duplicate loader entry id` 与 `cannot resolve profile bundle` 原样出现在 skipped/证据文本里） |
| B6 | `initProfile(dir, bundles)`（**两参**）+ `PROFILE_TEMPLATES` + `DEFAULT_PROFILE_BUNDLES` | `src/envManager.ts:38`（import）、建环境路径 | **明确报错**（签名变化）；模板/默认 bundle 集变化 → **静默**（新建环境可能直接起不来） | `bash tools/e2e-lifecycle.sh`（真建环境并启动）；`node --test tests/envManager.test.mjs` | 官方 `packages/boot/app-boot/src/profile.ts:197`（initProfile）、`:135`（PROFILE_TEMPLATES）、`:159`（DEFAULT_PROFILE_BUNDLES） | 仅读代码（该链由 tools/e2e-lifecycle.sh 覆盖；本次未运行该脚本） |
| B7 | 环境名的权威来源是**目录名**（`resolveProfileDir(name, home)` 的入参、`loadProfileDirectory` 的 `Profile.name = basename(dir)`） | `src/envManager.ts:489-500`（当前环境识别）、`src/diagnostics.ts:2612-2613`（诊断归属） | **静默**：manifest 里的 `name` 与目录名不一致时，环境归属会错（诊断挂到别的环境上） | 造一个目录名与 manifest.name 不一致的夹具，跑 `node dist/cli.js list --profile <dir名>` | 官方 `packages/boot/app-boot/src/profile.ts:125` | 仅读代码（我们按此口径实现，未做对照实验） |
| B8 | manifest 顶层字段形态：`dsh.profile.bundles`（层栈）与 `dependencies` | `src/paths.ts:74`（readEnvironmentManifest）、`src/envManager.ts`、`src/diagnostics.ts`（层栈事实） | **静默**：字段改名 → 层栈读成空，诊断会把"没有层栈"当成事实说出来（假阴性） | `node dist/cli.js list --profile <p>` 与真实 `package.json` 对照 | `src/paths.ts:74`；官方 `packages/boot/app-boot/src/profile.ts` 的 `ProfileManifest.dsh.profile.bundles` | 已实测（真机 list/analyze 都显示了真实层栈） |
| B9 | `@deepseek-ai/dsh-plugin-manager/types` 的 re-export 面（BundleInfo/PluginInfo/PluginSpecInspection/ChangeResult…） | `src/types.ts:26-31` | **明确报错**（编译期：类型改名或删除直接编译不过） | `pnpm typecheck` | `src/types.ts:26-31`；官方 `packages/boot/plugin-manager/src/types.ts` | 已实测（编译期即发现，属最便宜的一档） |

### C. 生态目录与文件形态（我们直装的目标）

| # | 依赖什么（符号/字段/语义） | 我们在哪用（file:line） | 变了会怎样 | 怎么最快发现 | 先看哪行 | 状态 |
|---|---|---|---|---|---|---|
| C1 | 官方用户技能根 `<dshHome>/skills`（skill-filesystem 默认扫描 + 热加载），技能清单是 `SKILL.md`，目录名优先取 frontmatter 的 `name` | `src/kinds.ts:122`（skillsRoot）、`src/kinds.ts:545`（installSkill） | **静默**：目录改名/新增扫描根 → 我们装到旧位置，技能不被加载（用户以为装了） | `grep -n "'skills'" packages/skill/skill-filesystem/src/index.ts`；装一个后 `ls ~/.dsh/skills` | 官方 `packages/skill/skill-filesystem/src/index.ts:257`（扫描根）、`:82`（`watch` 默认 true，所以新增目录会被热加载） | 已实测（真机安装/卸载落地正确）；**官方是否真加载未在 UI 里验证（不确定，见 §4）** |
| C2 | 官方用户预设根 `<dshHome>/.agent-presets`（`USER_PRESET_DIR`），构成条件是目录里有 `agent.cordis.yml`（`preset.yml` 只是展示元数据） | `src/kinds.ts:127`（presetsRoot）、`src/kinds.ts:587`（installPreset）、`src/presets.ts:285,429,490,532` | **静默**：常量改名 → 预设不被 roster 发现（我们照旧写文件） | `grep -n 'USER_PRESET_DIR\|COMPOSITION_FILE' packages/preset/agent-presets/src/discovery.ts` | 官方 `packages/preset/agent-presets/src/discovery.ts:37,51` | 已实测（task-25 真机 REST 卸载按 roster roots 找根；归档/恢复仅单测） |
| C3 | profile 布局：`<dshHome>/profiles/<name>/`（manifest 在根），依赖兜底目录是 `<profiles>/node_modules` 与 `<dshHome>/node_modules` | `src/paths.ts:29,43`、`src/envManager.ts`（枚举环境）、`src/diagnostics.ts`（fallbackModules = dirname(envDir)/node_modules） | **静默**：布局变化 → 扫不到环境，或解析根错位导致"缺包"误报 | `node dist/cli.js list`；`node --test tests/envManager.test.mjs` | `src/paths.ts:29`；官方 `packages/boot/app-boot/src/profile.ts:125`（resolveProfileDir） | 已实测（task-26 真机临时 home 用同一布局 + profiles/node_modules 共享兜底跑通） |

### F. 官方 README 的明文空白（我们据此设计的那两句）

这两句不涉及任何符号，但**是我们两个功能的唯一设计依据**：官方改了措辞就等于收回了那块空白，我们会白做一层。
界面上已经不再引用它们（task-53 把这份引文从用户文案里删掉了——用户要做的只是加一个 loader 行），所以**出处只住在这一份维护者文档里**。

| # | 官方原话（逐字） | 对应我们的什么功能 | 变了会怎样 | 怎么最快发现 | 状态 |
|---|---|---|---|---|---|
| F1 | "Only bundles are managed — ... loading plain plugin modules stays a file operation" | `unmounted-dependency` 诊断（`src/diagnostics.ts` 的 consistencyLayer）：依赖已装上、入口导出插件形态，但 loader 树里没有任何行指向它（用户看不出它没生效）；以及行级配置（`plugins.row.config`）这块空白 | **功能前提消失**：官方若把普通插件模块也纳入托管，这条诊断就成了重复劳动；官方明确拒绝时我们继续补位 | 读官方 README（`boot/plugin-manager` 与 `client/ui-plugin-manager`）；看 `dsh plugin --help` 的动词面是否出现"挂载普通模块" | 仅读官方文档（本轮按此实现；未做"官方新增该能力"的对照） |
| F2 | "The manager cannot ... change another profile, or edit an agent preset's composition" | 跨环境管理（`src/envManager.ts` 的复制 / 备份 / 恢复）与技能、预设安装（`src/kinds.ts`、`src/presets.ts`）这两块的存在理由 | **功能前提消失**：官方自己支持之后，这两块应当收敛为薄壳或下线 | 同上 README；官方 CLI 是否出现 `dsh profile` 子命令族 | 仅读官方文档（同上） |

用法：动 `unmounted-dependency`、跨环境管理、预设安装之前，先确认这两句仍然成立。

### D. 客户端平台契约（host + browser）

| # | 依赖什么（符号/字段/语义） | 我们在哪用（file:line） | 变了会怎样 | 怎么最快发现 | 先看哪行 | 状态 |
|---|---|---|---|---|---|---|
| D1 | `PLATFORM_MODULES` 种子表（0.1.6-alpha.2 为 9 项：react 四项 + cordis + client-store + ui-slots + ui-primitives + ui-dockkit） | `tsdown.client.config.ts:8-16`（external 白名单逐字镜像）、`tests/client-boot.test.mjs` | **客户端启动中断**：越表 external → `missed the module table`，**所有插件 UI 一起消失**；少 external → 模块身份分裂 | `node --test tests/client-boot.test.mjs`；与官方 `packages/client/web/src/platform.ts:8-16` 逐项比对（顺序与内容全等） | `tsdown.client.config.ts:8-16` | 已实测（契约测试真启动 dist/client.js，越表 require 当场抛） |
| D2 | slot 名与 owner props 形态：`settings.section`、`plugins.item`、`plugins.bundle.config`、`plugins.row.config`（owner props `{view:'summary'\|'page'}`） | `src/client/index.ts:93,106,117,127,139` | **静默**：slot 名变化 → 区块不渲染，页面看起来"就是没有那一节" | `node --test tests/client-boot.test.mjs`（注册面断言） | 官方 `packages/client/ui-plugin-manager/src/client/slot-contract.ts:32-45` | 已实测（注册面）；owner props 语义仅读代码 |
| D3 | `settings.section` 的 order 布局（官方 general=0 / models=10 / plugins=15 / agent-presets=20） | `src/client/index.ts:93,106,117`（我们用 16 / 17 / 22） | **静默**：入口顺序变（插到别的位置，功能仍在） | `grep -n 'order: 15' packages/client/ui-settings-plugins/src/client/index.ts`；`node --test tests/client-boot.test.mjs` | 官方 `packages/client/ui-settings-plugins/src/client/index.ts:187-190` | 已实测（注册面断言 id/order/label） |
| D4 | `ctx.settingsScope.bind({namespace})`（客户端读写官方 settings） | `src/client/index.ts:59` | **明确报错**（绑定失败）或 **静默**（表单不渲染/不保存） | `node --test tests/client-render.test.mjs`；`bash tools/e2e-visual.sh` | 官方 `packages/client/ui-settings/src/client/settings-scope.ts:221,254` | 仅读代码（真机视觉验证见 docs/private/visual-audit.md，非本次执行） |
| D5 | `ctx.locale.register(ns, {zh, en})` + `ctx.locale.bind(ns)` | `src/client/index.ts:53-54`、`src/client/locales.ts` | **明确报错**（键位校验失败）或 **静默**（缺文案） | `node --test tests/ui-copy.test.mjs` | 官方 `packages/client/locale/src/client/index.ts:370` | 已实测（zh/en 键位对齐 + 无硬编码文案检查） |
| D6 | 客户端产物加载协议：`package.json` 的 `dsh.client`（`inject` / `platform: web`）+ lazy-CJS factory（`window.__ModuleLoader__.load({id, factory})`） | `package.json:46-61`（dsh.client：inject 7 项 + platform web）、`tsdown.client.config.ts`（banner/footer/intro） | **静默/起不来**：协议变化 → 客户端根本不加载我们的 bundle（页面无区块，也不报错） | `node --test tests/client-boot.test.mjs` | `tsdown.client.config.ts` 的 banner/footer | 已实测（banner/footer 真启动） |

### E. CLI 与进程语义（引导与自救路径依赖它们）

| # | 依赖什么（符号/字段/语义） | 我们在哪用（file:line） | 变了会怎样 | 怎么最快发现 | 先看哪行 | 状态 |
|---|---|---|---|---|---|---|
| E1 | `dsh plugin --profile <name> <pnpm 参数>` 的 argv 语义（命令行只转发，不加自有包装） | 引导文案 `src/guard.ts:150-200`（拒绝裸命令时给模型/用户的"正确走法"） | **静默**：引导失效（用户照做失败，模型反复重试） | `dsh plugin --help`；官方 `apps/cli/src/args.ts:171-186` | 官方 `apps/cli/src/args.ts:171`、`apps/cli/src/plugin.ts:12-24` | 仅读代码 |
| E2 | `--dump-config` **不加载任何 JS**（只做 patch 解析与层栈组合）：因此抓不到模块 import/apply 期错误；且**退出码不能当健康判据**（好环境也可能 exit 1） | 诊断生成的急救指引（`dsh --profile X --dump-config` 用来只读核对层栈） | **静默**：指引误导用户（以为 exit 0 就是能起来，或以为 dump-config 能抓到 apply 期错误） | `dsh --profile <p> --dump-config; echo $?`（对照真实启动） | docs/private/test-env-feasibility.md:26,36,41,146 | 已实测（他人台账：docs/private/test-env-feasibility.md） |
| E3 | `--patch <file>` 覆盖层（可重复；急救时用一份空 patch 把起不来的环境拉起来） | 诊断修复文本里的急救命令（`dsh --profile X --patch <空 patch>`） | **静默**：flag 改名 → 我们的指引失效 | `dsh --help` 里找 `--patch`；官方 `apps/cli/src/args.ts:26-27,63-64` | 官方 `apps/cli/src/args.ts:26,63` | 仅读代码 |
| E4 | 启动就绪判据不是退出码：`dsh --profile <p>` 以任务模式跑时只输出 `dsh: a task is required`（树挂载成功） | 真机脚本的就绪探测（`tools/e2e-visual.mjs`、`tools/e2e-lifecycle.sh` 用端口/日志而非退出码） | **静默**：判据失效 → 脚本假绿（把没起来的环境当成起来了） | `bash tools/e2e-lifecycle.sh` | docs/private/test-env-feasibility.md:146 | 已实测（他人台账） |
## 2. 最小 smoke 序列（官方升级后按顺序跑）

前提：`~/.dsh/profiles/pm-test` 存在（两个 e2e 脚本都以它为源复制临时 profile）；端口占用见 CODE-POLICY §7.7 的号段约定。

| 步 | 命令 | 期望 | 覆盖的条目 |
|---|---|---|---|
| 1 | `pnpm install --frozen-lockfile` | 成功，lockfile 无改动 | 依赖面没变（B9 的类型面在下一步抓） |
| 2 | `pnpm typecheck` | 退出码 0 | A4/A8/B1/B3/B9（签名、选项字段、re-export 面漂移） |
| 3 | `pnpm test` | 全绿（当前 320 条量级）；单条红也必须定位 | A5/A6/A8/A9/A10/A12/A13/D1/D2/D3/D5/D6（契约测试：平台表、slot 注册面、字典、REST 围栏、诊断引擎） |
| 4 | `bash tools/e2e-lifecycle.sh` | 退出码 0（"建环境 → 启动 → 可达 → 停止"全链路） | B6/B7/C3/E4（真建环境、真启动、就绪判据） |
| 5 | `bash tools/e2e-visual.sh` | 退出码 0（临时 profile + 随机端口；失败=1，环境问题=2） | D1–D6（客户端在真浏览器里是否还渲染、配置表单是否读写得到） |
| 6 | CLI 逃生口真机：造一个"两行同 id"的环境，再跑 `DSH_INSTALL_ANCHOR=<官方 dsh package.json> node dist/cli.js analyze --profile <坏环境> --home <临时 home>` | 退出码 1；stdout 有 `coverage:` 与 `install anchor: <路径>`；出现 `boot-blocking root cause` 段，含 `duplicate loader entry id` 与 `cordis.patch.yml:<行>` | A14/B5（锚点链、官方组合口径抛错文本） |
| 7 | 跨环境写路径真机（会写文件，跑在临时 profile 上）：`node dist/cli.js install <一个小包> --profile <临时 profile>`，再 `node dist/cli.js remove <包名> --profile <临时 profile>` | 两条都退出 0；profile 的 `package.json` 依赖与层栈被官方通道正确改写 | B1/B2/B3/B4（runPluginCommand 真跑、锁、manifest 写） |

第 6 步的 REST 版（想在浏览器/脚本里核对外加这一条）：

```bash
curl -s -X POST http://127.0.0.1:<port>/api2/companion/listKinds -H 'content-type: application/json' -d '{}'
# 期望：HTTP 200 + {"ok":true,"value":{"records":[...],"orphans":[...]}}
```

## 3. 历史事故对照表（官方相关，同一个坑不踩第二次）

| 事故 | 现象 | 当初是怎么发现的 | 来源 | 现在的护栏 |
|---|---|---|---|---|
| 行 id `plugin-manager` 与官方撞车（P0-A） | profile 启动阶段抛 `duplicate loader entry id`，整个环境起不来 | 旧仓库装机后 profile 直接起不来，启动日志里有该 TypeError；随后与官方 base patch 逐行比对确认官方新增了同名行 | docs/DESIGN.md:131、docs/CODE-POLICY.md:44；官方 `packages/bundle/base/cordis.patch.yml:16,20` | 行 id 用包名（`cordis.patch.yml:8`）+ 该文件顶部写明理由；诊断报 `duplicate-row-id` 时带文件与行号 |
| 服务名 `pluginManager` 与官方冲突（P0-B） | 同名注册直接抛 `service "pluginManager" has been registered`，profile 起不来 | 真机对照实验：故意注册同名服务，启动报错文本被记录下来 | docs/DESIGN.md:132、docs/private/test-env-feasibility.md:120 | 只 `ctx.get('pluginManager')` 探测、绝不 provide（`src/official.ts:60-76`）；本清单 A2 |
| fiber 相位映射错 | 旧 `phaseOf` 把官方 `4=DISPOSED` 映射成 `null`、`5=UNLOADING` 落 `unloading`，诊断显示错相位 | 人工把旧映射与官方 `FiberState` 枚举逐值对照时发现 | docs/DESIGN.md:133、docs/CODE-POLICY.md:46 | `src/official.ts:204` 逐值对齐官方 `PluginFiberPhase`；`tests/diagnostics.test.mjs` 有 fiber failed 用例 |
| tsconfig include 缺口 | 新增源文件不在 `tsconfig.host.json` 的 include 里，靠传递依赖侥幸编译 | 新增文件后构建"碰巧"通过，逐项核对 include 时才暴露 | docs/DESIGN.md:134、docs/CODE-POLICY.md:47 | `tsconfig.host.json` 用 `src/*.ts` 通配 + `pnpm typecheck`/`pnpm build:host` 进 smoke 序列 |
| `inspect()` 的 `already-installed` 语义 | "声明了但没装"的依赖走修复，官方把"已在 manifest 里声明"判为已安装 → 修复必然被拒，用户看到自相矛盾的两句话 | 真机点"确认修复"，面板红字 `拒绝安装：already-installed —— <pkg> is already installed` | docs/private/write-path-audit.md:64,133-135；官方 `packages/boot/plugin-manager/src/index.ts:262` | 修复依赖走 `repairDependencies`（先按官方通道重装）而不是再走 install（`src/index.ts:445-447`） |
| loader 查重是 **per-group** 的 | 一开始以为"patch 里两行同 id 就起不来"，实际同一个 id 落在两个不同 insert 列表时 profile 正常启动 | 真机对照实验：两种布局各造一次，一个启动失败、一个正常 | docs/private/visual-audit.md:422-429 | 本清单 A1 写清 per-group；诊断只在同一列表内报 `duplicate-row-id` |
| `installBundle` 失败回滚**不还原已下载文件** | 失败安装回滚后 `node_modules` 里仍可能留着下载产物（官方只还原 `package.json` 与 `pnpm-lock.yaml`） | 读官方 JSDoc 的 "downloaded files can stay" + 真机失败后观察残留 | 官方 `packages/boot/plugin-manager/src/index.ts:328-336` | 质量门回滚不假设"目录一定干净"；卸载/清理走官方 `remove_bundle`/`remove()` 路径 |
| `--dump-config` 不加载 JS、退出码不可当健康判据 | 以为 dump-config 能验证"能不能起来"；实际它只组合层栈，且好环境也可能 exit 1 | 审计期对照实验：坏/好环境各跑一遍，比对退出码与真实启动结果 | docs/private/test-env-feasibility.md:26,36,41,146 | 本清单 E2/E4；真机脚本用端口/日志就绪判据，不用退出码 |
| 客户端平台种子表漂移 | external 表少一项 → 运行期 `missed the module table`，**所有插件 UI 一起消失**（不只我们） | 旧仓库升级官方版本后逐字比对 `PLATFORM_MODULES` 发现成员变动；0.1.6 又多出 `ui-dockkit` | docs/private/CONTEXT.md:24、`tsdown.client.config.ts:8-16`、`tests/client-boot.test.mjs` | 平台表逐字镜像 + 契约测试真启动产物；本清单 D1 |
| `execution: 'cli'` 的 env 是"在 process.env 之上合并" | 想用 `options.env` 删掉敏感键删不掉（合并只覆盖同名键，删不掉别的键） | task-26 实现环境净化时读官方源码 + 真机行为确认 | 官方 `packages/boot/plugin-manager/src/operations.ts:119` | CLI 在调用期间把敏感键从 `process.env` 摘掉再还原（`src/cli.ts` 的 withScrubbedEnvironment），有单测钉住 |
| 预设删除会连带清 `settings.default` | 直接删目录会留下指向不存在预设的默认值（新会话起不来） | 读官方 `remove()` 实现，发现它会 unset 用户默认 | 官方 `packages/preset/agent-presets/src/index.ts:606-622` | 删除优先走官方 `agentPresets.remove()`；无宿主时才直删并在 notes 里提示（`src/presets.ts:429`） |

## 4. 已知不确定项（下次动这些区域时优先补证）

| # | 不确定什么 | 为什么不确定 | 怎么补 |
|---|---|---|---|
| U1 | B1「真跑 pnpm 的跨环境写路径」 | 单测只覆盖参数构造（注入替身）；真跑要写 profile（本任务只读，未执行） | 按 smoke 第 7 步在临时 profile 上跑一次并记录 |
| U2 | C1「官方 UI 真的加载了我们装的 skill/预设」 | 我们只验证了落地与 roster 根解析，没在会话里验证技能被加载 | 装一个 skill 后开新会话，看技能目录里是否出现它 |
| U3 | B6「建环境链路」 | 该链由 tools/e2e-lifecycle.sh 覆盖，本次未运行脚本 | 跑一次 `bash tools/e2e-lifecycle.sh` 并记录输出 |
| U4 | A3「官方是否仍用 profileContext 门控 manager 行」 | 只读了官方 base patch 的门控表达式，没做过移除对照 | 临时改一份 base patch 门控再启动，观察 companion 的 capabilities 输出 |
| U5 | A11「settings 命名空间冲突」 | 只读了官方 register 的冲突语义，没实测同名注册 | 在测试宿主里注册两次同名命名空间，确认失败位置与错误文本 |
| U6 | A15「官方 plugin_manager 工具动作」 | 按官方源码逐字写死；宿主里实跑 `install_bundle` 需要 danger-full-access 审批 | 在审批可用的会话里各跑一次 list/set/install/remove |
| U7 | D4/D 系列「客户端真机渲染」 | 最新真机视觉验证是 docs/private/visual-audit.md（他人执行），本次未重跑 | 跑 `bash tools/e2e-visual.sh` |
| U8 | A6/A7「loader 字段与相位」 | 逐值对照了官方源码，但没做"官方改枚举"的对照实验 | 造一个 fiber failed 的夹具，看诊断是否仍报 failed-fiber |

## 5. 维护规则

1. 官方升级后：先跑 §2 的 1–5 步；改动越靠近写路径，越要补跑 6–7 步。
2. 任何新踩到的官方相关坑：补进 §3，写清"当初是怎么发现的"（下次才能更快发现）。
3. 行号会漂移：这份文件定位依赖符号名；改官方版本后，用每行的官方向量 grep 一遍，把漂移的行号更新掉。
4. §4 的不确定项：补证后把对应条目的状态升级为"已实测"；确实补不了的，保留"不确定"标记，不要改写成肯定句。

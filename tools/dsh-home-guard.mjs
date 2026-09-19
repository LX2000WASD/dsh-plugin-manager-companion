/**
 * dsh-home-guard — 「这个工具脚本该往哪个 DSH_HOME 写」的唯一判据（fail loud，不给默认值）。
 *
 * 为什么有它（**真实事故**，不是假设）：tools/dirty-profile.mjs 曾把目标写死成
 * `os.homedir()/.dsh/profiles`。task-70 期间按脚本文档跑 `node tools/dirty-profile.mjs --profile demo`
 * （没带 DSH_HOME）时，它在**用户真实家目录**下造了一个 demo profile（含 phantom 依赖）。
 * 脚本自己不报错，代价落在用户家目录上——这类「默认值偷偷指向危险位置」必须由脚本自己拒绝。
 *
 * 规则（所有会写 <DSH_HOME> 的工具都适用）：
 *   1. 目标必须**显式**给出：`--dsh-home <path>` 或环境变量 `DSH_HOME`；两者都没有 → 拒绝运行；
 *   2. 解析后的目标若就是真实 harness home（`os.homedir()/.dsh` 及其等价写法，含符号链接与
 *      `..`/尾斜杠等拼法）→ 同样拒绝，除非显式给 `--allow-real-home`；
 *   3. 拒绝文案必须点名「它想写哪里」与「怎么改」。
 *
 * tools 扫描结果（task-72 顺手核过一轮，口径：会不会**默认**写进真实 HOME）：
 *   · dirty-profile.mjs   —— 曾默认写 `<真实 HOME>/.dsh`；**本模块就是为它加的守卫**（已修）。
 *   · e2e-lifecycle.mjs   —— 不适用：只**读** homedir 用于找 dsh 安装；写路径永远是 mkdtemp 出来的临时 home。
 *   · cdp-shot.mjs / dirty-ui-audit.mjs / e2e-visual.mjs / visual-audit.mjs / probe-settings.mjs
 *     —— 不适用：只写 `tmpdir()` 或调用方给的 `--out`，从不写 HOME。
 *   · run-tests.mjs       —— 不适用：不写文件系统。
 *   · e2e-visual.sh       —— 壳脚本，写真实 `~/.dsh/profiles/<临时名>`（**by design**：它要复制
 *       `pm-test` 当源、并在真实 home 里起隔离实例）。这不是「默认值 bug」，但与本口径不同，
 *       单独登记：改它要连它的用法与文档一起改，不在 task-72 范围。
 */

import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/** 目标缺失（既没 --dsh-home 也没 DSH_HOME）。 */
export const MISSING_TARGET_HOME = 'missing-target-home'
/** 目标是真实 harness home（需要 --allow-real-home 才放行）。 */
export const REAL_HOME_TARGET = 'real-home-target'

/**
 * 把路径归一化成可比较的形态：去掉尾分隔符，存在时解析符号链接。
 * @param path - 原始路径。
 * @returns 归一化后的绝对路径。
 */
function normalize(path) {
  const absolute = resolve(path)
  const trimmed = absolute.length > 1 && absolute.endsWith(sep) ? absolute.slice(0, -sep.length) : absolute
  try {
    return existsSync(trimmed) ? realpathSync(trimmed) : trimmed
  } catch {
    // realpath 失败（权限/竞态）：退回字面路径比较——宁可多拒一次，也不要放行写真实 home。
    return trimmed
  }
}

/** 平台是否大小写不敏感（Windows/macOS 的文件系统）。 */
function caseInsensitive() {
  return process.platform === 'win32' || process.platform === 'darwin'
}

/**
 * 两个路径是否指向同一个位置（按平台的大小写语义）。
 * @param a - 路径 A。
 * @param b - 路径 B。
 * @returns 是否同一个位置。
 */
export function samePath(a, b) {
  const left = normalize(a)
  const right = normalize(b)
  return caseInsensitive() ? left.toLowerCase() === right.toLowerCase() : left === right
}

/**
 * 解析并校验写目标（**唯一的判据**，工具脚本不许自己再写一套默认值）。
 *
 * @param options.argvHome - `--dsh-home` 的值（未给时 undefined）。
 * @param options.envHome - `DSH_HOME` 的值（未给时空串/undefined）。
 * @param options.realHome - 真实家目录（测试可注入；默认取 os.homedir()）。
 * @param options.allowRealHome - 是否显式允许写真实 harness home。
 * @returns 通过时 `{ ok: true, dshHome, source }`；拒绝时 `{ ok: false, code, message }`。
 */
export function resolveTargetDshHome({ argvHome, envHome, realHome = homedir(), allowRealHome = false }) {
  const flag = typeof argvHome === 'string' && argvHome.trim() !== '' ? argvHome.trim() : undefined
  const env = typeof envHome === 'string' && envHome.trim() !== '' ? envHome.trim() : undefined
  if (flag === undefined && env === undefined) {
    return {
      ok: false,
      code: MISSING_TARGET_HOME,
      message: [
        '拒绝运行：没有给出目标 DSH_HOME。',
        '  本工具会往 <DSH_HOME>/profiles/ 里**真实创建/删除 profile**；为避免误写真实家目录，',
        '  目标必须显式给出，二选一：',
        '    --dsh-home <path>        例：--dsh-home /tmp/vis-home',
        '    DSH_HOME=<path>          例：DSH_HOME=/tmp/vis-home node tools/dirty-profile.mjs --profile demo',
        '  （我们刻意**不**回退到 os.homedir()/.dsh：那条默认值以前真的在用户家目录里造过环境。）',
      ].join(String.fromCharCode(10)),
    }
  }
  const raw = flag ?? env
  const source = flag === undefined ? 'env' : 'flag'
  const dshHome = resolve(raw)
  const realHarnessHome = join(realHome, '.dsh')
  const hitsRealHome = samePath(dshHome, realHarnessHome) || samePath(dshHome, realHome)
  if (hitsRealHome && allowRealHome !== true) {
    // 点名两个形态：用户给的那个（可能是符号链接/相对写法）与它真正指向的位置。
    const resolved = normalize(dshHome)
    const spelling = resolved === dshHome ? [] : ['    （你给的是 ' + dshHome + '，它指向同一个位置）']
    return {
      ok: false,
      code: REAL_HOME_TARGET,
      message: [
        '拒绝运行：目标是真实 harness home —— ' + resolved,
        ...spelling,
        '  它等于 os.homedir()/.dsh（或它的等价写法）；本工具会在这里创建/删除 profile，',
        '  而那不是可以随便改的目录。改用临时 home：',
        '    --dsh-home <临时目录>      或 DSH_HOME=<临时目录>',
        '  确实要动真实 home（例如你自己机器上的取证）时，显式加：--allow-real-home',
      ].join(String.fromCharCode(10)),
    }
  }
  return { ok: true, dshHome, source, realHome: hitsRealHome }
}

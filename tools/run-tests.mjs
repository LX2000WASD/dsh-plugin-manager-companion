#!/usr/bin/env node
/**
 * 跨平台的测试入口：自己列举 tests/*.test.mjs，再交给 node --test。
 *
 * 为什么不直接在 scripts 里写 glob：**shell 的 glob 与引号在不同平台上语义不同**。
 * package.json 原来是 `node --test 'tests/*.test.mjs'`：
 *   · POSIX 下 shell 会展开单引号里的内容？不会——它是字面量，Node 自己按 glob 展开，能跑；
 *   · Windows cmd 下整串带着单引号被当成一个文件名，**测试数 0、退出码 0**。
 * 也就是说同一条命令在 Windows 上会静默"通过"。实测：node --test 匹配不到任何文件时退出码是 0，
 * 所以换引号也不够——必须有"一个都没找到就报错"这一条。
 *
 * 这里的做法是穷举 0 依赖：读目录、筛 *.test.mjs、显式把文件列表交给 Node。
 * glob 语义、引号规则、路径分隔符一概不参与，两个平台走同一条路。
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const files = readdirSync(join(root, 'tests')).filter((name) => name.endsWith('.test.mjs')).sort()

if (files.length === 0) {
  process.stderr.write('run-tests: 在 tests/ 下没找到任何 *.test.mjs —— 拒绝报成功\n')
  process.exit(1)
}

const result = spawnSync(process.execPath, ['--test', ...files.map((name) => join('tests', name))], {
  cwd: root, stdio: 'inherit',
})
process.exit(result.status ?? 1)

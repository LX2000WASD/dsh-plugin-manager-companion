/**
 * qualityGate.ts 单测（node --test，**跑 dist 产物**而不是源码）。
 *
 * 覆盖验收要求的三类判定：未声明 import、@deepseek-ai/* 当普通 dependencies、Node 内置模块豁免；
 * 另含两个回归用例——子路径入口必须被扫到（旧实现只扫 exports["."] 的 Critical 缺陷），
 * scoped 子路径必须真实解析（旧实现只要包目录存在就判可解析）。fixture 全部落在临时目录里。
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { inspectPackage, isSafePackageName, isBuiltinSpecifier } from '../dist/qualityGate.js'

let home
let envDir

/** 写 JSON 文件（自动建目录）。 */
async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2))
}

/** 写文本文件（自动建目录）。 */
async function writeText(file, text) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text)
}

/** 往 fixture 里装一个包。 */
async function install(name, manifest, files = {}) {
  const dir = join(envDir, 'node_modules', name)
  await writeJson(join(dir, 'package.json'), { name, version: '1.0.0', ...manifest })
  for (const [relative, text] of Object.entries(files)) await writeText(join(dir, relative), text)
  return dir
}

const CONFIG = {
  diagnostics: {
    dependency: true, composition: true, runtime: true, consistency: true, ecosystem: false,
  },
  qualityGate: { enabled: true, mode: 'block', allowlist: ['allowlisted-pkg'] },
  marketplace: { enabled: true, cacheTtlMinutes: 1440, timeoutMs: 15000, indexUrl: '' },
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'dshpm-gate-'))
  process.env.DSH_HOME = home
  envDir = join(home, 'profiles', 'demo')
  await writeJson(join(envDir, 'package.json'), {
    name: 'dsh-profile-demo', private: true, dependencies: {}, dsh: { profile: { bundles: [] } },
  })

  // 1) 未声明 import
  await install('undeclared-pkg', { exports: { '.': './index.js' } }, {
    'index.js': "import 'no-such-provider'\nexport const apply = () => {}\n",
  })

  // 2) 官方包当普通依赖 / peer 声明
  await install('official-as-dep', {
    exports: { '.': './index.js' },
    dependencies: { '@deepseek-ai/dsh-tools': '0.1.6-alpha.2' },
  }, { 'index.js': 'export const apply = () => {}\n' })
  await install('official-as-peer', {
    exports: { '.': './index.js' },
    peerDependencies: { '@deepseek-ai/dsh-tools': '0.1.6-alpha.2' },
  }, { 'index.js': 'export const apply = () => {}\n' })
  await install('schemastery-as-dep', {
    exports: { '.': './index.js' },
    dependencies: { '@deepseek-ai/schemastery': '^3.18.2' },
  }, { 'index.js': 'export const apply = () => {}\n' })
  // 上面这个包 peer 里的 dsh-tools 必须真的能解析，否则会多出"声明了但没装"的问题
  await writeJson(join(envDir, 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json'),
    { name: '@deepseek-ai/dsh-tools', version: '0.1.6-alpha.2', exports: { '.': './index.js' } })
  await writeText(join(envDir, 'node_modules', '@deepseek-ai', 'dsh-tools', 'index.js'),
    'export const apply = () => {}\n')
  await writeJson(join(envDir, 'node_modules', '@deepseek-ai', 'schemastery', 'package.json'),
    { name: '@deepseek-ai/schemastery', version: '3.18.2', exports: { '.': './index.js' } })
  await writeText(join(envDir, 'node_modules', '@deepseek-ai', 'schemastery', 'index.js'), 'export const z = 1\n')

  // 3) Node 内置模块（crypto / node:crypto / fs/promises）全部豁免
  await install('builtin-user', { exports: { '.': './index.js' } }, {
    'index.js': [
      "import { createHash } from 'crypto'",
      "import { readFile } from 'node:crypto'",
      "import { open } from 'fs/promises'",
      'export const apply = () => {}',
      '',
    ].join('\n'),
  })

  // 4) 只有子路径入口里有未声明 import（旧实现只扫 exports["."] 会整条漏过）
  await install('sub-entry-pkg', {
    exports: { '.': './index.js', './server': './dist/server.js' },
  }, {
    'index.js': 'export const apply = () => {}\n',
    'dist/server.js': "import 'only-in-server-entry'\nexport const serve = () => {}\n",
  })

  // 5) 相对 import 一跳之后再出现未声明 import
  await install('relative-hop-pkg', { exports: { '.': './index.js' } }, {
    'index.js': "import './lib/inner.js'\nexport const apply = () => {}\n",
    'lib/inner.js': "import 'deep-undeclared'\nexport const inner = 1\n",
  })

  // 6) 声明了但没装
  await install('declared-missing-pkg', {
    exports: { '.': './index.js' },
    dependencies: { 'never-installed-dep': '^1.0.0' },
  }, { 'index.js': "import 'never-installed-dep'\nexport const apply = () => {}\n" })

  // 7) 豁免名单
  await install('allowlisted-pkg', { exports: { '.': './index.js' } }, {
    'index.js': "import 'no-such-provider'\nexport const apply = () => {}\n",
  })

  // 8) bundle patch 行：合法子路径不报，非法子路径要报
  await install('@acme/tool', {
    exports: { '.': './index.js', './server': './dist/server.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, {
    'index.js': 'export const apply = () => {}\n',
    'dist/server.js': 'export const serve = () => {}\n',
    'cordis.patch.yml': [
      '- insert:',
      '    - id: good-row',
      '      name: "@acme/tool/server"',
      '    - id: bad-row',
      '      name: "@acme/tool/no-such-subpath"',
      '',
    ].join('\n'),
  })

  // 9) 扫描上限：入口 + 405 个相对可达文件
  const leaves = Array.from({ length: 405 }, (_, index) => 'leaf-' + index + '.js')
  await install('big-pkg', { exports: { '.': './index.js' } }, {})
  await writeText(join(envDir, 'node_modules', 'big-pkg', 'index.js'),
    leaves.map(name => "import './" + name + "'").join('\n') + '\nexport const apply = () => {}\n')
  await Promise.all(leaves.map(name =>
    writeText(join(envDir, 'node_modules', 'big-pkg', name), 'export const value = 1\n')))
})

after(async () => {
  await rm(home, { recursive: true, force: true })
  delete process.env.DSH_HOME
})

describe('qualityGate · 三类判定', () => {
  it('未声明的 import 报错', async () => {
    const result = await inspectPackage(envDir, 'undeclared-pkg', CONFIG)
    assert.equal(result.ok, false)
    assert.equal(result.issues.length, 1)
    assert.match(result.issues[0], /未声明的 import/)
    assert.match(result.issues[0], /no-such-provider/)
    assert.match(result.issues[0], /index\.js:1/, '问题里要带上出问题的位置')
  })

  it('官方包声明成普通 dependencies 报错，声明成 peerDependencies 放行', async () => {
    const asDep = await inspectPackage(envDir, 'official-as-dep', CONFIG)
    assert.equal(asDep.ok, false)
    assert.match(asDep.issues.join('\n'), /@deepseek-ai\/dsh-tools/)
    assert.match(asDep.issues.join('\n'), /peerDependencies/)

    const asPeer = await inspectPackage(envDir, 'official-as-peer', CONFIG)
    assert.equal(asPeer.ok, true, 'peer 声明应放行：' + JSON.stringify(asPeer.issues))
  })

  it('官方豁免名单里的包当普通依赖不报（模块身份不敏感）', async () => {
    const result = await inspectPackage(envDir, 'schemastery-as-dep', CONFIG)
    assert.equal(result.ok, true, 'schemastery 应被豁免：' + JSON.stringify(result.issues))
  })

  it('Node 内置模块豁免：crypto / node:crypto / fs/promises 都不报', async () => {
    const result = await inspectPackage(envDir, 'builtin-user', CONFIG)
    assert.equal(result.ok, true, JSON.stringify(result.issues))
  })
})

describe('qualityGate · 回归用例', () => {
  it('子路径入口里的未声明 import 必须被检出（旧实现只扫 exports["."]）', async () => {
    const result = await inspectPackage(envDir, 'sub-entry-pkg', CONFIG)
    assert.equal(result.ok, false)
    assert.match(result.issues.join('\n'), /only-in-server-entry/)
    assert.match(result.issues.join('\n'), /dist\/server\.js:1/)
  })

  it('相对 import 一跳之后的未声明 import 必须被检出', async () => {
    const result = await inspectPackage(envDir, 'relative-hop-pkg', CONFIG)
    assert.equal(result.ok, false)
    assert.match(result.issues.join('\n'), /deep-undeclared/)
    assert.match(result.issues.join('\n'), /lib\/inner\.js:1/)
  })

  it('声明了但没装的依赖必须被检出', async () => {
    const result = await inspectPackage(envDir, 'declared-missing-pkg', CONFIG)
    assert.equal(result.ok, false)
    assert.match(result.issues.join('\n'), /never-installed-dep/)
    assert.match(result.issues.join('\n'), /声明了但没装/)
  })

  it('bundle patch 行：能解析的子路径放行，解析不到的 scoped 子路径必须报（旧实现假阳性）', async () => {
    const result = await inspectPackage(envDir, '@acme/tool', CONFIG)
    const joined = result.issues.join('\n')
    assert.equal(result.ok, false)
    assert.match(joined, /no-such-subpath/)
    assert.doesNotMatch(joined, /good-row|tool\/server/,
      '同一个包自己的合法子路径不该被误报：' + joined)
    assert.match(joined, /cordis\.patch\.yml:4/, '证据要指回行号（bad-row 那一行的起始行）：' + joined)
  })

  it('扫描到上限时如实标注（标为通过不代表已证全善）', async () => {
    const result = await inspectPackage(envDir, 'big-pkg', CONFIG)
    assert.equal(result.ok, true, JSON.stringify(result.issues))
    assert.ok(result.notes.some(note => note.includes('400')), '要有截断说明：' + JSON.stringify(result.notes))
  })
})

describe('qualityGate · 边界与防守', () => {
  it('豁免名单命中即跳过全部检查', async () => {
    const result = await inspectPackage(envDir, 'allowlisted-pkg', CONFIG)
    assert.equal(result.ok, true)
    assert.ok(result.notes.some(note => note.includes('豁免')))
  })

  it('只接受单独的 qualityGate 段（不必给整份配置）', async () => {
    const result = await inspectPackage(envDir, 'allowlisted-pkg', { enabled: true, mode: 'block', allowlist: ['allowlisted-pkg'] })
    assert.equal(result.ok, true)
  })

  it('非法包名（路径穿越）直接判不合格，不去碰文件系统', async () => {
    for (const name of ['../evil', '..', '/etc/passwd', 'a/../b', '', 'x\\\\y']) {
      const result = await inspectPackage(envDir, name, CONFIG)
      assert.equal(result.ok, false, name + ' 应被拒绝')
    }
    assert.equal(isSafePackageName('@scope/pkg'), true)
    assert.equal(isSafePackageName('plain-pkg'), true)
  })

  it('包没装时给出明确原因而不是抛错', async () => {
    const result = await inspectPackage(envDir, 'not-installed-pkg', CONFIG)
    assert.equal(result.ok, false)
    assert.match(result.issues[0], /找不到这个包/)
  })

  it('内置模块判定：crypto 与 node:crypto 等价', () => {
    assert.equal(isBuiltinSpecifier('crypto'), true)
    assert.equal(isBuiltinSpecifier('node:crypto'), true)
    assert.equal(isBuiltinSpecifier('fs/promises'), true)
    assert.equal(isBuiltinSpecifier('some-pkg'), false)
  })
})

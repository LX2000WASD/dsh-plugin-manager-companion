/**
 * about op 的 host 侧读盘契约（0.1.1 修复的两个真机缺陷）。
 *
 * 归属：A 类·回归护栏。
 * 为什么单独成文件：`tests/about-page.test.mjs` 测的是**客户端渲染**（喂桩载荷），
 * 而这两个缺陷在 **host 侧读盘逻辑**里——桩载荷永远测不到它们。
 *
 * ## 钉住的两个真机缺陷（用户反馈）
 *
 * **Bug 1：DSH 版本未知——用路径后缀认包，不读 name。**
 * 官方 monorepo 里那份 manifest 的路径是 `apps/cli/package.json`，
 * 内容完全正确（`name` 就是 `@deepseek-ai/dsh`），却因为路径字符串不匹配被判成"不像官方包"。
 * 退路 `apps/cli/node_modules/@deepseek-ai/dsh/package.json` 在 monorepo 里根本不存在。
 * 用路径认包 = 用代理代替事实（§12.10）。**包的身份写在 name 里，就该读 name。**
 *
 * **Bug 2：插件自身版本未知——Windows 路径 bug。**
 * `new URL(import.meta.url).pathname` 在 Windows 上返回 `/D:/…`（前导斜杠），
 * join 之后变成 `\\D:\…\package.json`，包根再也找不到。正确写法是 `fileURLToPath`。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectAboutFacts } from '../dist/about.js'

/** 造一个 package.json 并返回它的路径。 */
function manifest(dir, name, version = '9.9.9') {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'package.json')
  writeFileSync(path, JSON.stringify({ name, version }, undefined, 2) + '\n')
  return path
}

describe('about：按 name 字段认包，不看路径（0.1.1 修复）', () => {
  const home = mkdtempSync(join(tmpdir(), 'pmc-about-'))
  try {
    it('monorepo 形态：锚点在 apps/cli/，name 是官方包名 → 必须读出真实版本', () => {
      const anchor = manifest(join(home, 'monorepo', 'apps', 'cli'), '@deepseek-ai/dsh', '0.1.6-alpha.2')
      const facts = collectAboutFacts({ installAnchor: anchor })
      assert.equal(facts.runtime.version.value, '0.1.6-alpha.2',
        '路径不是 @deepseek-ai/dsh/ 也要认——身份在 name 里：' + JSON.stringify(facts.runtime.version))
      assert.equal(facts.runtime.version.source, anchor)
    })

    it('常规安装形态：锚点在 node_modules/@deepseek-ai/dsh/ → 同样读出', () => {
      const anchor = manifest(join(home, 'normal', 'node_modules', '@deepseek-ai', 'dsh'), '@deepseek-ai/dsh', '0.1.6-alpha.2')
      const facts = collectAboutFacts({ installAnchor: anchor })
      assert.equal(facts.runtime.version.value, '0.1.6-alpha.2')
    })

    it('锚点指向别的包 → 如实说"不像官方包"，不许硬读一个无关的版本', () => {
      const anchor = manifest(join(home, 'other'), 'some-other-package', '3.3.3')
      const facts = collectAboutFacts({ installAnchor: anchor })
      assert.ok('unknown' in facts.runtime.version, '不是官方包必须报未知：' + JSON.stringify(facts.runtime.version))
      assert.match(facts.runtime.version.unknown, /不像官方包/)
      assert.ok(!JSON.stringify(facts.runtime.version).includes('3.3.3'), '不许把无关包的版本当 DSH 版本')
    })

    it('锚点是安装根目录 → 按安装根拼候选，且候选同样要 name 对得上', () => {
      const root = join(home, 'root')
      const anchor = manifest(root, 'not-a-real-anchor-name')
      manifest(join(root, 'node_modules', '@deepseek-ai', 'dsh'), '@deepseek-ai/dsh', '0.1.5-rc.2')
      const facts = collectAboutFacts({ installAnchor: anchor })
      assert.equal(facts.runtime.version.value, '0.1.5-rc.2', '安装根下的候选要能被认出来')
    })

    it('候选的 name 不对 → 仍然报未知（不因为"文件存在"就认）', () => {
      const root = join(home, 'root-bad')
      const anchor = manifest(root, 'not-a-real-anchor-name')
      manifest(join(root, 'node_modules', '@deepseek-ai', 'dsh'), 'impostor', '7.7.7')
      const facts = collectAboutFacts({ installAnchor: anchor })
      assert.ok('unknown' in facts.runtime.version, 'name 不对就必须报未知：' + JSON.stringify(facts.runtime.version))
    })

    it('文件不是 JSON → 报未知，不抛异常', () => {
      const dir = join(home, 'broken')
      mkdirSync(dir, { recursive: true })
      const anchor = join(dir, 'package.json')
      writeFileSync(anchor, '{ this is not json')
      const facts = collectAboutFacts({ installAnchor: anchor })
      assert.ok('unknown' in facts.runtime.version)
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

describe('about：本插件自身版本（0.1.1 修复 Windows 路径）', () => {
  it('能读出真实版本，来源是自身 manifest 的绝对路径', () => {
    const facts = collectAboutFacts({})
    assert.ok('value' in facts.companion.version,
      '本插件版本必须读得出来（Windows 上曾因路径前缀 bug 显示未知）：' + JSON.stringify(facts.companion.version))
    assert.match(facts.companion.version.value, /^\d+\.\d+\.\d+/)
    assert.ok(!facts.companion.version.source.includes('\\D:'),
      '来源路径不许出现盘符前缀错误（\\D:\\…）：' + facts.companion.version.source)
  })

  it('源码里不许再用 new URL(...).pathname 推路径（Windows 上会带前导斜杠）', () => {
    // 源码级断言：这类写法在 Linux 上测不出来，只有 Windows 会暴露（§12.10 推论三）。
    //
    // **必须先剥注释**（§12.10 推论二：判据范围按规则自己的定义选）：本文件里有一处注释
    // 正是用来解释"为什么不用 .pathname"的——它提到这个词是给维护者看的，不该被规则误伤。
    const raw = readFileSync(new URL('../src/about.ts', import.meta.url), 'utf8')
    const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    assert.ok(!/\.pathname\b/.test(source),
      'about.ts 的代码里出现了 .pathname——用 fileURLToPath，否则 Windows 上路径会带前导斜杠')
  })
})

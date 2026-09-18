/**
 * 客户端产物启动契约测试（node --test，跑 dist/client.js）。
 *
 * 守护的是最贵的一类失败：bundle 里出现平台模块表之外的 require，浏览器会抛
 * "missed the module table"，**整个插件页面启动中断**——不只是本插件，所有插件的
 * UI 一起消失。这里用模拟模块表把产物真正跑起来，越表 require 立刻抛错。
 *
 * 另外核对：bundle 注册 id、slot 注册面（三个一级入口）、字典 zh/en 键位对齐、
 * 以及各页面能被服务端渲染（不缺组件、不缺字典键）。
 *
 * 平台表随官方版本变。0.1.6-alpha.2 是 9 项（含 ui-dockkit），必须与
 * dsh-plugin-manager-companion/tsdown.client.config.ts 的 PLATFORM 逐字一致；
 * 桩件本身已收敛到 tests/client-harness.mjs（四个客户端测试文件共用一份）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyWithMocks, bootBundle } from './client-harness.mjs'

/** 三个一级设置入口的契约（用户明确要的结构：一个入口 + 三个可选子页面）。 */
const SECTIONS = [
  { id: 'marketplace', order: 16 },
  { id: 'console', order: 17 },
  { id: 'kinds', order: 22 },
]

describe('客户端产物启动契约', () => {
  it('产物只 require 平台模块表内的模块（越表会中断整个插件页面）', () => {
    const exported = bootBundle()
    assert.ok(typeof exported.apply === 'function', 'bundle 必须导出 apply')
  })

  it('注册三个一级设置入口，order 与设计文档一致', () => {
    const exported = bootBundle()
    const { slotRegistrations } = applyWithMocks(exported)
    const sections = slotRegistrations.filter(r => r.options.name === 'settings.section')
    assert.ok(sections.length >= 3, 'settings.section 注册数不足：' + String(sections.length))
    for (const want of SECTIONS) {
      const hit = sections.find(r => r.options.id === want.id)
      assert.ok(hit !== undefined, '缺少一级入口: ' + want.id)
      assert.equal(hit.options.order, want.order, want.id + ' 的 order 不符')
      assert.ok(hit.component !== undefined, want.id + ' 未提供组件')
    }
  })

  it('注册进官方插件页的 slot（点开即可管理配置）', () => {
    const exported = bootBundle()
    const { injected, slotRegistrations } = applyWithMocks(exported)
    const official = slotRegistrations.filter(r => String(r.options.name).startsWith('plugins.'))
    assert.ok(official.length > 0, '未注册任何官方 plugins.* slot：' + injected.join(', '))
  })

  it('字典 zh/en 键位对齐', () => {
    const exported = bootBundle()
    const { dicts } = applyWithMocks(exported)
    assert.ok(dicts.length > 0, '未注册任何字典')
    for (const { ns, d } of dicts) {
      assert.ok(d.zh !== undefined && d.en !== undefined, ns + ' 缺少 zh 或 en')
      const zh = Object.keys(d.zh).sort()
      const en = Object.keys(d.en).sort()
      assert.deepEqual(en, zh, ns + ' 的 en 键与 zh 不一致')
    }
  })
})

/**
 * tests/tags.test.mjs — 市场标签模型的验收测试（import 构建产物 dist/tags.js）。
 *
 * 覆盖：顺序契约（category → type → status → verify → security → topic）、跨 kind 同值去重、
 * topic 预算按**实际产出**计数（旧审计 m-2 的修法）、色调映射、分类计数聚合。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

const { buildMarketTags, marketTagKey, categoryCounts, normalizeInstalledKind, statusTone, securityTone, TAG_KIND_ORDER } = await import('../dist/tags.js')

/** 一个"什么字段都有"的条目。 */
function fullSource(over = {}) {
  return {
    category: 'memory',
    installed: true,
    kind: 'cordis-plugin',
    status: '✅ listed',
    verification: { level: 2, label: 'feature-tested' },
    security: { riskLevel: 'medium', status: 'audited' },
    topics: ['retrieval', 'vector', 'rag'],
    ...over,
  }
}

test('顺序契约：category → type → status → verify → security → topic', () => {
  assert.deepEqual(TAG_KIND_ORDER, ['category', 'type', 'status', 'verify', 'security', 'topic'])
  const tags = buildMarketTags(fullSource(), { topicLimit: 1 })
  assert.deepEqual(tags.map((tag) => tag.kind), ['category', 'type', 'status', 'verify', 'security', 'topic'])
  // 产出的 kind 序列必须与契约非递减对应（渲染方按数组顺序画，不再排序）
  const indexOf = (kind) => TAG_KIND_ORDER.indexOf(kind)
  for (let index = 1; index < tags.length; index += 1) {
    assert.ok(indexOf(tags[index - 1].kind) <= indexOf(tags[index].kind))
  }
})

test('跨 kind 同值去重：保留优先级更高的那次出现（大小写/空白不敏感）', () => {
  const tags = buildMarketTags({ category: ' memory ', topics: ['memory', 'Memory', ' rag ', ''] })
  assert.deepEqual(tags.map((tag) => tag.kind + ':' + tag.value), ['category:memory', 'topic:rag'])
  // 主题与分类同名 → 只留分类
  assert.equal(tags.filter((tag) => tag.value.toLowerCase() === 'memory').length, 1)
  // status 与 topic 同值 → 保留 status
  const statusFirst = buildMarketTags({ status: 'listed', topics: ['listed'] })
  assert.deepEqual(statusFirst.map((tag) => tag.kind), ['status'])
})

test('topic 预算按实际产出计数：被去重吃掉的、空白的都不占额度（m-2）', () => {
  const tags = buildMarketTags({ category: 'memory', topics: ['memory', 'cli', 'api'] })
  assert.deepEqual(tags.map((tag) => tag.kind + ':' + tag.value), ['category:memory', 'topic:cli', 'topic:api'])
  // 旧实现在这里只输出一个 topic（先把 3 个切片成 2 个，再被去重吃掉一个，且不补位）
  assert.equal(tags.filter((tag) => tag.kind === 'topic').length, 2)

  const blanks = buildMarketTags({ topics: ['  ', 'cli', '', 'api'] })
  assert.deepEqual(blanks.map((tag) => tag.value), ['cli', 'api'])
  assert.equal(buildMarketTags({ topics: ['cli', 'api'] }, { topicLimit: 0 }).length, 0)
  assert.equal(buildMarketTags({ topics: ['cli', 'api'] }, { topicLimit: -1 }).length, 0)
  assert.equal(buildMarketTags({ topics: ['cli', 'api'] }, { topicLimit: 1 }).length, 1)
  // 非字符串主题（上游 JSON 漂移）不该炸掉整张卡片
  assert.deepEqual(buildMarketTags({ topics: [7, 'cli'] }).map((tag) => tag.value), ['7', 'cli'])
})

test('type 标签：仅已安装条目有，值取归一化形态', () => {
  assert.deepEqual(buildMarketTags({ installed: false, kind: 'skill' }), [])
  assert.deepEqual(buildMarketTags({ kind: 'skill' }).map((tag) => tag.value), [], '未标记已安装就没有 type 标签')
  const skill = buildMarketTags({ installed: true, kind: 'skill' })
  assert.deepEqual(skill.map((tag) => tag.kind + ':' + tag.value), ['type:skill'])
  assert.equal(buildMarketTags({ installed: true, kind: 'agent-preset' })[0].value, 'agent-preset')
  assert.equal(buildMarketTags({ installed: true, kind: 'unknown' })[0].value, 'cordis-plugin')
  assert.equal(buildMarketTags({ installed: true })[0].value, 'cordis-plugin')
  assert.equal(normalizeInstalledKind(undefined), 'cordis-plugin')
  assert.equal(normalizeInstalledKind('skill'), 'skill')
})

test('色调与 title：状态、验证等级、安全等级都如实映射', () => {
  const tags = buildMarketTags(fullSource({ topics: [] }))
  const byKind = Object.fromEntries(tags.map((tag) => [tag.kind, tag]))
  assert.equal(byKind.status.tone, 'success')
  assert.equal(byKind.status.title, '✅ listed')
  assert.equal(byKind.verify.tone, 'success')
  assert.equal(byKind.verify.level, 2)
  assert.equal(byKind.verify.title, 'feature-tested')
  assert.equal(byKind.security.tone, 'warning')
  assert.equal(byKind.security.title, 'audited')
  assert.equal(byKind.category.title, undefined)

  assert.equal(statusTone('✅ verified'), 'success')
  assert.equal(statusTone('something archived'), 'warning')
  assert.equal(statusTone('待测'), 'neutral')
  assert.equal(securityTone('low'), 'success')
  assert.equal(securityTone('medium'), 'warning')
  assert.equal(securityTone('HIGH'), 'danger')
  assert.equal(securityTone('critical'), 'danger')
  assert.equal(securityTone('unknown'), 'neutral')

  // 跳过的扫描不该显示成"低风险"
  assert.equal(buildMarketTags({ security: { riskLevel: 'low', status: 'skipped' } }).length, 0)
  assert.equal(buildMarketTags({ verification: { level: 1, label: 'found' } })[0].tone, 'neutral')
})

test('空值/缺字段：一律不产出标签', () => {
  assert.deepEqual(buildMarketTags({}), [])
  assert.deepEqual(buildMarketTags({ category: '   ', topics: [], status: '' }), [])
  // 生态泛化主题的过滤在 registry.functionalTopics（数据源层）做；这里只管顺序与预算
  assert.deepEqual(buildMarketTags({ category: 'tool', topics: ['ai'] }).map((tag) => tag.value), ['tool', 'ai'])
  assert.equal(marketTagKey({ kind: 'topic', value: 'cli', tone: 'neutral' }), 'topic:cli')
})

test('categoryCounts：聚合、trim、空值不计、顺序确定', () => {
  const counts = categoryCounts([
    { category: 'tool' }, { category: 'tool ' }, { category: 'memory' },
    { category: undefined }, {}, { category: '   ' },
  ])
  assert.deepEqual(counts, { tool: 2, memory: 1 })
  assert.deepEqual(Object.keys(counts), ['tool', 'memory'], 'key 顺序 = 首次出现顺序')
  assert.equal(JSON.stringify(counts), JSON.stringify(categoryCounts([{ category: 'tool' }, { category: 'tool' }, { category: 'memory' }])), '同内容同序列化')
  assert.deepEqual(categoryCounts([]), {})
  const list = [{ category: 'tool' }]
  categoryCounts(list)
  assert.deepEqual(list, [{ category: 'tool' }], '不修改入参')
})

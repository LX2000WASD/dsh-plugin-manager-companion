/**
 * tests/tags.test.mjs — 市场徽标模型与详情数据的验收测试（import 构建产物 dist/tags.js）。
 *
 * 被测对象是**构建产物**，不是 src：沿用旧仓库"被验的代码就是线上跑的代码"的方法论。
 * 覆盖 docs/private/market-tags-policy.md 的契约（task-45 全量 13,998 条实测得出）：
 *   · 优先级顺序 risk › caution › manual › pick › archived › category › topic（BADGE_PRIORITY）
 *   · 卡片最多 3 槽；不满不占位
 *   · **跨来源按归一化值去重**（上游 499 条把自己的 category 又写进 topics）
 *   · 主题被泛化词过滤、限量 2、空值不重复不占预算
 *   · 详情八项：顺序、空值不出行、外链只在 https 时出现、风险明细带 severity
 */

import test from 'node:test'
import assert from 'node:assert/strict'

const { buildMarketTags, buildMarketDetail, marketTagKey, categoryCounts, BADGE_PRIORITY, TAG_SLOT_LIMIT, TOPIC_SLOT_LIMIT } =
  await import('../dist/tags.js')

/** 一个"什么信号都有"的条目（用来验证优先级与截断）。 */
function fullSource(over = {}) {
  return {
    category: 'vision',
    installable: 'manual',
    riskTier: 'risk',
    marketTags: ['community-pick'],
    archived: true,
    topics: ['ocr', 'multimodal', 'rag'],
    ...over,
  }
}

test('顺序契约：risk → caution → manual → pick → archived → category → topic', () => {
  assert.deepEqual(BADGE_PRIORITY, ['risk', 'caution', 'manual', 'pick', 'archived', 'category', 'topic'])
  const tags = buildMarketTags(fullSource(), { slotLimit: 99 })
  assert.deepEqual(
    tags.map((tag) => tag.kind),
    ['risk', 'manual', 'pick', 'archived', 'category', 'topic', 'topic'],
    '顺序即政策优先级；主题永远排在最后',
  )
  const indexOf = (kind) => BADGE_PRIORITY.indexOf(kind)
  for (let index = 1; index < tags.length; index += 1) {
    assert.ok(indexOf(tags[index - 1].kind) <= indexOf(tags[index].kind), '产出顺序必须与优先级非递减')
  }
})

test('卡片最多 3 槽；不满不占位', () => {
  assert.equal(TAG_SLOT_LIMIT, 3)
  const tags = buildMarketTags(fullSource())
  assert.equal(tags.length, 3, '六个信号也只出三个')
  assert.deepEqual(tags.map((tag) => tag.kind), ['risk', 'manual', 'pick'], '取优先级最高的三个')
  assert.deepEqual(buildMarketTags({}), [])
  assert.deepEqual(buildMarketTags({ riskTier: 'safe' }).map((tag) => tag.kind), [], 'safe 不是徽标（政策：只有非 safe 才提示）')
  assert.deepEqual(buildMarketTags({ topics: [] }), [], '没有信号就不占位')
})

test('跨来源同值去重：分类与主题同名时只留分类（上游 499 条的实例）', () => {
  const tags = buildMarketTags({ category: 'vision', topics: ['vision', 'ocr'] }, { slotLimit: 99 })
  assert.deepEqual(tags.map((tag) => tag.value), ['vision', 'ocr'], 'vision 只出现一次，且来自优先级更高的分类')
  assert.equal(tags.filter((tag) => tag.value.toLowerCase() === 'vision').length, 1)
  const dupes = buildMarketTags({ category: ' Memory ', topics: ['memory', 'MEMORY', 'rag'] }, { slotLimit: 99 })
  assert.deepEqual(dupes.map((tag) => tag.value), ['Memory', 'rag'], '大小写不敏感、值两端空白被 trim')
})

test('主题：泛化词过滤、限量 2、空值与重复不占预算', () => {
  assert.equal(TOPIC_SLOT_LIMIT, 2)
  const tags = buildMarketTags({ topics: ['dsh-plugin', 'ai', 'ocr', 'ocr', 'rag', 'vector'] }, { slotLimit: 99 })
  assert.deepEqual(tags.map((tag) => tag.value), ['ocr', 'rag'], '泛化词被剔、重复被去重、最多 2 个')
  const blanks = buildMarketTags({ topics: ['  ', 'ocr', '', 'rag'] }, { slotLimit: 99 })
  assert.deepEqual(blanks.map((tag) => tag.value), ['ocr', 'rag'])
  assert.deepEqual(buildMarketTags({ topics: ['ocr'] }, { topicLimit: 0 }), [])
  assert.deepEqual(buildMarketTags({ topics: [7, 'ocr'] }, { slotLimit: 99 }).map((tag) => tag.value), ['7', 'ocr'], '非字符串主题不该炸卡片')
})

test('色调：政策 §3.3 的语义分级（只说上游结论）', () => {
  const toneOf = (item) => Object.fromEntries(buildMarketTags(item, { slotLimit: 99 }).map((tag) => [tag.kind, tag.tone]))
  assert.deepEqual(toneOf({ riskTier: 'risk' }), { risk: 'danger' })
  assert.deepEqual(toneOf({ riskTier: 'caution' }), { caution: 'warning' })
  assert.deepEqual(toneOf({ installable: 'manual' }), { manual: 'neutral' })
  assert.deepEqual(toneOf({ marketTags: ['community-pick'] }), { pick: 'success' })
  assert.deepEqual(toneOf({ archived: true }), { archived: 'warning' })
  assert.deepEqual(toneOf({ category: 'tool' }), { category: 'neutral' })
  assert.deepEqual(buildMarketTags({ category: 'tool' }).map((tag) => tag.kind), ['category'], '上游没给风险结论时不显示风险徽标')
  assert.deepEqual(buildMarketTags({ marketTags: ['verified-install'] }), [], '未知收录标记不产出徽标（只认 community-pick）')
  assert.equal(marketTagKey({ kind: 'topic', value: 'ocr', tone: 'neutral' }), 'topic:ocr')
})

test('详情：八项的顺序、空值不出行、外链与风险明细', () => {
  const detail = buildMarketDetail({
    kind: 'cordis-plugin',
    category: 'vision',
    topics: ['dsh-plugin', 'ocr', 'multimodal'],
    riskTier: 'risk',
    riskFlags: [
      { id: 'curl-pipe-shell', severity: 'critical', category: 'downloadExec' },
      { id: 'setenv-var-path', severity: 'high', category: 'pathStartup' },
    ],
    reportUrl: 'https://github.com/qing3a/dsh-plugin-verify/blob/main/reports/modlens-2026-08-15.json',
    verifiedBy: 'dsh-plugin-verify@0.1.2',
    verifiedAt: '2026-08-15',
    license: 'MIT',
    packageName: 'modlens',
    latestVersion: '1.2.3',
  })
  assert.deepEqual(
    detail.map((entry) => entry.key),
    ['kind', 'category', 'topics', 'riskTier', 'riskFlags', 'verified', 'license', 'npm', 'version'],
  )
  const byKey = Object.fromEntries(detail.map((entry) => [entry.key, entry]))
  assert.equal(byKey.topics.value, 'ocr, multimodal', '主题在详情里过滤泛化词、最多 8 个')
  assert.equal(byKey.riskFlags.value, 'curl-pipe-shell(critical), setenv-var-path(high)', '风险明细带 severity，原样呈现')
  assert.equal(byKey.verified.value, 'dsh-plugin-verify@0.1.2 · 2026-08-15', '校验证据必须有"谁 + 何时"')
  assert.equal(byKey.verified.href, 'https://github.com/qing3a/dsh-plugin-verify/blob/main/reports/modlens-2026-08-15.json', '报告外链挂在同一条证据上')
  assert.equal(byKey.riskTier.tone, 'danger')

  assert.deepEqual(buildMarketDetail({ category: 'tool' }).map((entry) => entry.key), ['category'], '空值不出行')
  assert.equal(buildMarketDetail({ category: 'tool' }).some((entry) => entry.key === 'verified'), false, '没有校验证据就没有那一行')
  assert.equal(buildMarketDetail({ riskTier: 'safe' }).some((entry) => entry.key === 'riskTier'), false, 'safe 不产出风险行')
  const many = buildMarketDetail({ topics: Array.from({ length: 12 }, (_, index) => 'topic' + String(index)) })
  assert.equal(many[0].value.split(', ').length, 8, '主题在详情里最多 8 个')
})

test('categoryCounts：聚合、trim、空值不计、顺序确定', () => {
  const counts = categoryCounts([
    { category: 'tool' }, { category: 'tool ' }, { category: 'memory' },
    { category: undefined }, {}, { category: '   ' },
  ])
  assert.deepEqual(counts, { tool: 2, memory: 1 })
  assert.deepEqual(Object.keys(counts), ['tool', 'memory'], 'key 顺序 = 首次出现顺序')
  assert.deepEqual(categoryCounts([]), {})
  const list = [{ category: 'tool' }]
  categoryCounts(list)
  assert.deepEqual(list, [{ category: 'tool' }], '不修改入参')
})

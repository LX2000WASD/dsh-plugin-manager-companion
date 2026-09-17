/**
 * tests/rank.test.mjs — 模糊名称打分的验收测试（import 构建产物 dist/rank.js）。
 *
 * 覆盖：掩码计算、有序子序列命中/淘汰、边界与连续加分、长名适配（有界晚起始扣分 + 总分下限 1）、
 * 掩码预筛与不预筛逐条等价（含 CJK，证明掩码只放过不误杀）、fuzzyFilter 的稳定全序。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

const { charMask, fuzzyScore, fuzzyScoreLowered, fuzzyFilter } = await import('../dist/rank.js')

test('charMask：只覆盖 ASCII 字母，大小写都置位，非 ASCII 不进掩码', () => {
  assert.equal(charMask(''), 0)
  assert.equal(charMask('a'), 1 << 0)
  assert.equal(charMask('A'), 1 << 0)
  assert.equal(charMask('az'), (1 << 0) | (1 << 25))
  assert.equal(charMask('中文'), 0)
  assert.equal(charMask('a中'), 1 << 0)
  assert.equal(charMask('1-2.3'), 0, '数字与标点不进掩码')
})

test('fuzzyScore：子序列语义（命中 / 淘汰 / 边界条件）', () => {
  assert.equal(fuzzyScore('abc', 'abc'), 19, '连续命中：9 + 5 + 5')
  assert.equal(fuzzyScore('abc', 'a'), 9)
  assert.equal(fuzzyScore('ABC', 'abc'), 19, '大小写不敏感')
  assert.equal(fuzzyScore('dsh-note', 'dshnote'), fuzzyScore('dsh-note', 'dshnote'))
  assert.ok(fuzzyScore('dsh-note', 'dnote') > 0, '跳跃命中仍然命中')
  assert.equal(fuzzyScore('abc', 'd'), null, '不是子序列 → 淘汰')
  assert.equal(fuzzyScore('abc', 'cba'), null, '顺序必须保持（cba 不是 abc 的子序列）')
  assert.equal(fuzzyScore('dsh-terminal-panel', 'lmntr'), null, '顺序反了也要淘汰')
  assert.equal(fuzzyScore('ab', 'abc'), null, 'query 比候选更长 → 淘汰')
  assert.equal(fuzzyScore('abc', ''), 0, '空查询恒 0')
  assert.equal(fuzzyScore('', ''), 0)
  assert.equal(fuzzyScore('', 'a'), null)
})

test('边界与连续命中：分隔符边界加分，连续强加分', () => {
  assert.ok(fuzzyScore('a-b', 'b') > fuzzyScore('axb', 'b'), '边界命中优于词中命中')
  assert.ok(fuzzyScore('abcdef', 'abc') > fuzzyScore('axbxcxdef', 'abc'), '连续命中优于跳跃命中')
  assert.equal(fuzzyScore('x-abc', 'abc'), 17, '晚起始扣分有界（-min(i,6)）')
})

test('长名适配：合法名称命中恒 ≥ 1，绝不因晚起始被压成负数', () => {
  // 旧仓库实测：官方算法（无界 -index 惩罚）在 trmnl → dsh-terminal-panel 上得 -14，
  // 反而输给"描述子串 = 1 分"的兜底命中。这里必须 ≥ 1。
  const score = fuzzyScore('dsh-terminal-panel', 'trmnl')
  assert.ok(score !== null && score >= 1, '实际 ' + score)
  const far = fuzzyScore('x'.repeat(40) + 'a', 'a')
  assert.equal(far, 1, '极晚起始被压到下限 1，而不是负数')
  assert.equal(fuzzyScore('zzz', 'z'), 9, '首位命中带边界加分')
})

test('掩码预筛与不预筛逐条等价（掩码只做拒绝，绝不误杀）', () => {
  const pairs = [
    ['dsh-terminal-panel', 'trmnl'],
    ['dsh-terminal-panel', 'lmntr'],
    ['memory-keeper', 'mem'],
    ['memory-keeper', 'zk'],
    ['中文插件', '中'],
    ['中文插件', '插件'],
    ['中文插件', '中件'],
    ['plugin_2', '2'],
    ['plugin_2', 'p2'],
    ['aaaa', 'aaa'],
    ['aaaa', 'aaaaa'],
    ['', 'a'],
  ]
  for (const [name, query] of pairs) {
    const plain = fuzzyScore(name, query)
    const masked = fuzzyScoreLowered(name.toLowerCase(), query.toLowerCase(), charMask(name), charMask(query))
    assert.equal(masked, plain, name + ' / ' + query)
  }
  // 掩码必须能拒绝一批明显不匹配的候选（否则预筛没有意义）
  assert.equal(fuzzyScoreLowered('memory-keeper', 'xyz', charMask('memory-keeper'), charMask('xyz')), null)
  assert.equal(fuzzyScoreLowered('插件', 'plugin', charMask('插件'), charMask('plugin')), null)
})

test('重复字符：DP 不会把同一个位置用两次', () => {
  assert.ok(fuzzyScore('aaa', 'aa') > 0)
  assert.equal(fuzzyScore('aa', 'aaa'), null)
  assert.ok(fuzzyScore('a-a-a', 'aaa') > 0, '中间隔了分隔符也能三连命中')
  assert.equal(fuzzyScore('a-a', 'aaa'), null)
})

test('fuzzyFilter：前缀优先 → 对齐分 → 原顺序，空查询返回 null', () => {
  const items = [
    { name: 'dsh-note' },
    { name: 'note' },
    { name: 'dsh-note-keeper' },
    { name: 'unrelated' },
    { name: 'n-o-t-e' },
  ]
  const hits = fuzzyFilter(items, (item) => item.name, 'note')
  assert.equal(hits.length, 4)
  // 'note' 是唯一前缀命中，排第一；其余按对齐分：'n-o-t-e' 每个字母都吃分隔符边界加分（+8），
  // 因此分数高于连写名字；'dsh-note' 与 'dsh-note-keeper' 同分，按输入顺序稳定排列。
  assert.deepEqual(hits.map((hit) => hit.item.name), ['note', 'n-o-t-e', 'dsh-note', 'dsh-note-keeper'])
  assert.equal(hits[0].prefix, true)
  assert.equal(hits[1].prefix, false)
  assert.ok(hits[2].score === hits[3].score, '同分靠 index 决定先后')
  // index 是稳定排序键：同分同前缀时按输入顺序
  for (let index = 1; index < hits.length; index += 1) {
    const left = hits[index - 1]
    const right = hits[index]
    assert.ok(left.prefix > right.prefix || left.prefix === right.prefix)
    if (left.prefix === right.prefix && left.score === right.score) assert.ok(left.index < right.index)
  }
  assert.equal(fuzzyFilter(items, (item) => item.name, '   '), null, '空白查询交给调用方的默认路径')
  assert.equal(fuzzyFilter(items, (item) => item.name, ''), null)
  assert.deepEqual(fuzzyFilter(items, (item) => item.name, 'zzz'), [])
  assert.equal(items.length, 5, '不修改入参')
})

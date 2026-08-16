/**
 * Choosing the passage that explains an absence.
 *
 * The failure this guards is subtle and expensive: attaching *some* procedural
 * sentence to any unanswered question makes the memo look cited when it is not.
 * A gap with no quote is honest and scores less; a gap with an unrelated quote
 * is neither.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { maskNonContent, selectNearestPassage, selectSupportingPassage } from '../src/verify/text.ts'

const filing = [
  '一、公司被债权人申请重整的情况概述',
  '《通知书》仅表明法院已立案审查，截至本公告披露日，公司尚未收到法院决定对公司进行预重整或裁定受理重整申请的文件。',
  '若法院裁定受理对公司的重整申请，公司将依法配合法院及管理人开展相关重整工作，并依法履行债务人的法定义务。',
  '公司董事会将依法配合法院对公司的重整可行性进行研究和论证，同时确保生产经营稳定进行。',
  '本次计提减值准备相关财务数据未经审计，敬请广大投资者注意投资风险。',
].join('\n')

const documents = [{ id: 'D1', text: filing }]

test('the supporting passage reports a non-disclosure, not merely a procedure', () => {
  const chosen = selectSupportingPassage(documents, '法院指定的重整管理人是哪家机构?')
  assert.ok(chosen)
  assert.match(chosen.text, /尚未收到法院决定/)
  // 「将依法指定管理人」 is the most lexically similar sentence in the filing and
  // the wrong answer: describing a process is not reporting a non-disclosure.
  assert.ok(!chosen.text.includes('将依法配合'))
})

test('a question the filing is not about gets no supporting quote at all', () => {
  // Honest direction: no quote costs a quarter of the absence score; an
  // unrelated quote would claim full marks for a citation that supports nothing.
  assert.equal(selectSupportingPassage(documents, '公司的主营业务毛利率是多少?'), undefined)
  assert.equal(selectSupportingPassage([], '任何问题?'), undefined)
})

test('ranking is markers, then topical overlap, then shortest', () => {
  // Distinct marker *kinds*, not occurrences: repeating 尚未 twice says the same
  // thing twice, while 尚未 + 未披露 is a sentence that reports two absences.
  const two = '重整管理人尚未确定，其出资金额亦未披露。'
  const oneLong = '关于重整管理人事项，公司目前尚未取得任何来自法院的正式书面通知或者相关的指定文件材料。'
  const oneShort = '重整管理人尚未指定。'
  const ranked = selectSupportingPassage([{ id: 'D1', text: [oneLong, oneShort, two].join('\n') }], '重整管理人是谁?')
  assert.ok(ranked)
  assert.equal(ranked.markers, 2, 'two kinds of absence marker outrank one, whatever the length')
  assert.equal(ranked.text, two)

  // With markers equal, the shorter sentence wins.
  const tie = selectSupportingPassage([{ id: 'D1', text: [oneLong, oneShort].join('\n') }], '重整管理人是谁?')
  assert.equal(tie?.text, oneShort)
})

test('nearest passage ranks shared key units, then shortest, and requires overlap', () => {
  const oneLong = '第 20 号文件的施行机制已在本段作出完整说明。'
  const oneShort = '第 20 号文件自发布时施行。'
  const two = '第 20 号文件的施行机制和调整程序均自发布时生效。'
  const chosen = selectNearestPassage(
    [{ id: 'D1', text: [oneLong, oneShort, two].join('\n') }],
    '第 20 号文件的施行机制和调整程序是什么?',
  )
  assert.equal(chosen?.text, two, 'more shared key units lead')

  const tie = selectNearestPassage(
    [{ id: 'D1', text: [oneLong, oneShort].join('\n') }],
    '第 20 号文件如何施行?',
  )
  assert.equal(tie?.text, oneShort, 'the shortest equally relevant passage wins')
  assert.equal(selectNearestPassage([{ id: 'D1', text: oneShort }], '主营业务毛利率?'), undefined)
})

test('nearest passage treats numbers as exact semantic tokens', () => {
  const falseMatches = '文件编号为 2026-041。\n证券代码为 002920。'
  assert.equal(selectNearestPassage([{ id: 'D1', text: falseMatches }], 'No. 20'), undefined)
  assert.match(
    selectNearestPassage([{ id: 'D1', text: `${falseMatches}\n第 20 号文件已发布。` }], 'No. 20')?.text ?? '',
    /第 20 号/,
  )
})

test('file paths with Chinese components are masked whole', () => {
  // `MB-001/公告.txt`: the ASCII-only pattern stopped at the CJK component and
  // left `MB-001` behind, whose `-001` was then swept as an unsourced number and
  // refused the memo.
  const masked = maskNonContent('- [S-A] 2026-filings/MB-001/公告.txt — 重整公告(fixture)')
  assert.ok(!masked.includes('MB-001'), masked)
  assert.ok(!masked.includes('2026-filings'), masked)
  assert.ok(masked.includes('重整公告'), masked)

  // And prose that merely mentions a document keeps its words.
  const prose = maskNonContent('详见公告的说明,本期计提 1,000.00 万元。')
  assert.equal(prose, '详见公告的说明,本期计提 1,000.00 万元。')
})

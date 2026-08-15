/**
 * Three-locale compliance scan.
 *
 * The doctrine under test: punish the speech act, not the token. Quoting the
 * user's question back is not advice; refusing is not advice; slipping a fresh
 * recommendation into the same sentence as a refusal still is.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scanCompliance } from '../src/verify/compliance.ts'

test('actionable advice fails in all three locales', () => {
  assert.ok(!scanCompliance('综合来看,建议投资者买入并长期持有。', 'zh-CN').passed)
  assert.ok(!scanCompliance('綜合來看,建議投資者買入並長期持有。', 'zh-TW').passed)
  assert.ok(!scanCompliance('We recommend investors buy on this weakness.', 'en').passed)
})

test('price targets, rating buckets, and return promises fail', () => {
  assert.equal(scanCompliance('给予目标价 30 元。', 'zh-CN').hits[0]?.rule, 'price_target')
  assert.equal(scanCompliance('维持买入评级。', 'zh-CN').hits[0]?.rule, 'rating_bucket')
  assert.equal(scanCompliance('保证年化收益翻倍。', 'zh-CN').hits[0]?.rule, 'return_promise')
  assert.equal(scanCompliance('Reiterate outperform.', 'en').hits[0]?.rule, 'rating_bucket')
  assert.equal(scanCompliance('仓位建议控制在三成。', 'zh-CN').hits[0]?.rule, 'position_sizing')
})

test('neutral analysis passes — hedged risk language is not advice', () => {
  assert.ok(scanCompliance('若重整失败,公司存在被宣告破产的风险,毛利率可能承压。', 'zh-CN').passed)
  assert.ok(scanCompliance('Margins may come under pressure if the petition is accepted.', 'en').passed)
})

test('restating the question inside quotation marks is exempt', () => {
  const result = scanCompliance('用户问的是「现在是不是应该赶紧清仓」,本备忘录不能替你做投资决定。', 'zh-CN')
  assert.ok(result.passed, JSON.stringify(result.hits))
})

test('a refusal does not license a fresh recommendation in the same sentence', () => {
  const result = scanCompliance('我不能告诉你是否该抄底,但可以分批买入。', 'zh-CN')
  assert.ok(!result.passed)
})

test('the memo preamble and the advisory refusal pass their own gate', () => {
  const preamble =
    '本备忘录只整理已公开披露的事实与其出处;每句话后附原文出处,数字逐字取自原始文件,计算得到的数字在「计算过程」中给出公式。不构成投资建议。'
  const refusal =
    '本备忘录只整理已公开披露的事实与其出处,不能替你做投资决定——那取决于你自己的风险承受能力、期限与目标,也取决于原始文件尚未披露的信息。'
  assert.ok(scanCompliance(preamble, 'zh-CN').passed, JSON.stringify(scanCompliance(preamble, 'zh-CN').hits))
  assert.ok(scanCompliance(refusal, 'zh-CN').passed, JSON.stringify(scanCompliance(refusal, 'zh-CN').hits))
})

test('task-specific forbidden phrases are honored', () => {
  assert.ok(!scanCompliance('公司将于下周复牌。', 'zh-CN', ['复牌']).passed)
})

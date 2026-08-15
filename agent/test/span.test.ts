/**
 * Which span of a document a claim cites, and why that one.
 *
 * The behaviour under test is *determinism*, not correctness against any
 * answer: two runs of the same task propose different fragments of the same
 * paragraph, and the published citation has to come out the same either way.
 * Every tie in the ranking is broken by a stated rule, and each of those rules
 * has a test here — an unbroken tie is a coin flip wearing a sort function.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chooseQuoteSpan } from '../src/verify/span.ts'

const FILING = [
  '一、本次发行概况',
  '公司拟向特定对象发行A股股票，发行对象为不超过三十五名符合规定条件的特定投资者。',
  '本次发行募集资金总额不超过人民币 360,000.00 万元（含本数）。',
  '募集资金扣除发行费用后将用于产业园项目与补充流动资金。',
  '二、风险提示',
  '本次发行募集资金总额不超过人民币 360,000.00 万元（含本数）。',
].join('\n')

const document = { text: FILING }

test('a fragment is widened to the sentence it came from', () => {
  // Two runs propose two halves of one sentence; both must publish the sentence.
  const left = chooseQuoteSpan(document, '募集资金总额不超过人民币', '本次募集资金总额不超过人民币 360,000.00 万元。')
  const right = chooseQuoteSpan(document, '360,000.00 万元（含本数）', '本次募集资金总额不超过人民币 360,000.00 万元。')
  assert.ok(left && right)
  assert.equal(left.quote, right.quote, 'different fragments, same citation')
  assert.match(left.quote, /^本次发行募集资金总额不超过人民币 360,000\.00 万元（含本数）。$/)
  assert.equal(left.adjusted, true)
  // The offsets still slice the published quote out of the document verbatim.
  assert.equal(FILING.slice(left.charStart, left.charEnd), left.quote)
})

test('the span extends to the sentence carrying the claim`s figure', () => {
  const text = [
    '公司拟向特定对象发行A股股票。',
    '本次发行数量不超过发行前总股本的 30%。',
  ].join('\n')
  // The proposal points at the first sentence; the claim states a figure that
  // lives in the next one.
  const chosen = chooseQuoteSpan({ text }, '公司拟向特定对象发行A股股票', '本次发行数量不超过发行前总股本的 30%。')
  assert.ok(chosen)
  assert.ok(chosen.quote.includes('30%'), `figure not reached: ${chosen.quote}`)
  assert.equal(text.slice(chosen.charStart, chosen.charEnd), chosen.quote, 'still contiguous and verbatim')
  assert.match(chosen.path, /extended-to-figure/)
})

test('a sentence that already carries every figure is not extended', () => {
  const chosen = chooseQuoteSpan(
    document,
    '本次发行募集资金总额不超过人民币 360,000.00 万元（含本数）。',
    '募集资金总额上限为人民币 360,000.00 万元。',
  )
  assert.ok(chosen)
  assert.equal(chosen.quote, '本次发行募集资金总额不超过人民币 360,000.00 万元（含本数）。')
  assert.match(chosen.path, /sentence-aligned/)
  assert.equal(chosen.adjusted, false, 'a proposal that is already the sentence is left alone')
})

test('a proposal occurring twice resolves to the earlier one, every time', () => {
  // The same sentence appears under 「本次发行概况」 and again under 「风险提示」.
  // Both carry the figure and share the claim's wording equally, so the tie
  // falls through to document order — and must fall the same way on every run.
  const claim = '募集资金总额上限为人民币 360,000.00 万元。'
  const proposal = '本次发行募集资金总额不超过人民币 360,000.00 万元（含本数）。'
  const first = chooseQuoteSpan(document, proposal, claim)
  assert.ok(first)
  assert.equal(first.charStart, FILING.indexOf(proposal), 'the first occurrence wins the tie')
  assert.match(first.path, /occurrences=2/)
  for (let round = 0; round < 5; round += 1) {
    const again = chooseQuoteSpan(document, proposal, claim)
    assert.equal(again?.charStart, first.charStart, 'the tie-break is stable across calls')
  }
})

test('more of the claim`s figures beats a closer wording', () => {
  const text = [
    '本次交易的对价支付安排如下所述。',
    '交易对价合计 11,400 万元，其中首期支付 6,840 万元。',
    '本次交易的对价支付安排由双方另行签署协议约定。',
  ].join('\n')
  const claim = '交易对价合计 11,400 万元，首期支付 6,840 万元。'
  // The first and third sentences echo the claim's wording; only the middle one
  // carries its figures, and a citation that cannot support the numbers is not
  // the citation for that sentence.
  const chosen = chooseQuoteSpan({ text }, '本次交易的对价支付安排', claim)
  assert.ok(chosen)
  assert.ok(chosen.quote.includes('11,400'))
  assert.ok(chosen.quote.includes('6,840'))
})

test('a shorter span wins when figures and wording tie', () => {
  const text = ['公司披露了本次计提。', '公司披露了本次计提，并说明了相关会计处理与后续影响的详细安排。'].join('\n')
  const chosen = chooseQuoteSpan({ text }, '公司披露了本次计提', '公司披露了本次计提。')
  assert.ok(chosen)
  assert.equal(chosen.quote, '公司披露了本次计提。', 'a pointer, not a paragraph')
})

test('the span never runs past the length cap', () => {
  const long = Array.from({ length: 12 }, (_, index) => `第${index + 1}段说明文字，本段不含任何数字信息。`).join('\n')
  const text = `${long}\n实际发行数量为 12,345,678 股。`
  // The figure is twelve sentences away: extension stops at the cap rather than
  // handing back the page, and the claim then fails number binding — which is
  // the right outcome for a sentence whose figure is nowhere near its quote.
  const chosen = chooseQuoteSpan({ text }, '第1段说明文字', '实际发行数量为 12,345,678 股。')
  assert.ok(chosen)
  assert.ok(chosen.quote.length <= 240, `span is ${chosen.quote.length} characters`)
  assert.equal(chosen.quote.includes('12,345,678'), false)
})

test('a proposal that is not in the document chooses nothing', () => {
  assert.equal(chooseQuoteSpan(document, '公司承诺明年利润翻倍。', '公司承诺明年利润翻倍。'), undefined)
  assert.equal(chooseQuoteSpan(document, '   ', '任意主张'), undefined)
})

test('a quote retyped in the other script still selects a span', () => {
  const chosen = chooseQuoteSpan(
    document,
    '本次發行募集資金總額不超過人民幣 360,000.00 萬元（含本數）。',
    '募集资金总额上限为人民币 360,000.00 万元。',
  )
  assert.ok(chosen, 'the locator handles the glyphs; the selector still has to run')
  assert.ok(chosen.quote.includes('360,000.00'))
  // What publishes is the document's own characters, not the retyping.
  assert.equal(chosen.quote.includes('發'), false)
})

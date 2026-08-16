/**
 * Binding an English claim to a Chinese filing.
 *
 * A figure is the same string in both languages, so this ought to be the easy
 * case. It was not: MB-005 en stated the creditor's claim amount four times per
 * run and the verifier refused it four times, after which the memo reported the
 * amount as undisclosed — about a filing that prints it in the opening
 * paragraph. Three separate faults, each of which alone was enough:
 *
 * 1. A figure ending an English sentence was truncated by the scanner's own
 *    lookahead — `…is 7,654,321.` yielded `7,654`, a token nowhere in the source.
 * 2. `7,654,321 yuan` and `CNY 7,654,321` were not amounts at all, because the
 *    unit table only knew Chinese unit words and suffix position.
 * 3. A claim's bare figure could not bind to the same digits printed with a unit
 *    in the quote, though the digits were right there.
 *
 * And one that is not a fault: a transliterated case number is not in the
 * document, so it stays rejected. The fix for that one is to quote it.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bindNumbers } from '../src/verify/bind.ts'
import { extractNumbers } from '../src/verify/numbers.ts'
import type { EvidenceRef } from '../src/contract.ts'

const QUOTE = '经（2026）沪0113民特（调）65号《民事裁定书》确认的货款 7,654,321 元，公司明显缺乏清偿能力。'

const cited = (quote: string): EvidenceRef[] => [
  {
    id: 'E1',
    documentId: 'D1',
    quote,
    charStart: 0,
    charEnd: quote.length,
    sourceLabel: '重整申请公告',
    retrievedAt: '2026-08-16T00:00:00.000Z',
  },
]

test('a figure at the end of an English sentence keeps all of its digits', () => {
  const tokens = extractNumbers('The creditor claim is 7,654,321.')
  assert.equal(tokens.length, 1)
  assert.equal(tokens[0]?.value, '7654321', 'truncation here invents a figure the filing never printed')
  // The same guard must still refuse to split a decimal.
  assert.equal(extractNumbers('The ratio is 12.75.')[0]?.value, '12.75')
  assert.equal(extractNumbers('总额为 7,654,321。')[0]?.value, '7654321')
})

test('English currency wording makes an amount, before or after the figure', () => {
  const cases: [string, string, string][] = [
    ['The claim is 7,654,321 yuan.', '7654321', 'CNY'],
    ['The claim is CNY 7,654,321.', '7654321', 'CNY'],
    ['The claim is RMB 7,654,321 in goods payment.', '7654321', 'CNY'],
    ['Proceeds of USD 42 million.', '42000000', 'USD'],
    ['A price of HK$3.14 per share.', '3.14', 'HKD'],
  ]
  for (const [text, value, unit] of cases) {
    const amount = extractNumbers(text).find((token) => token.kind === 'amount')
    assert.ok(amount, `no amount found in: ${text}`)
    assert.equal(amount.value, value, text)
    assert.equal(amount.unit, unit, text)
  }
})

test('an English claim binds to the Chinese sentence that prints the figure', () => {
  for (const text of [
    'The claim amount confirmed by the civil ruling is 7,654,321 yuan.',
    'The claim amount confirmed by the civil ruling is CNY 7,654,321.',
    'The claim amount confirmed by the civil ruling is 7,654,321.',
  ]) {
    const bound = bindNumbers(text, cited(QUOTE))
    assert.deepEqual(bound.unbound, [], text)
    assert.equal(bound.numbers[0]?.provenance, 'verbatim')
  }
})

test('a bare figure binds to what the filing printed, not to what it means', () => {
  // 「2,468.13万元」 justifies 2,468.13 — the digits on the page — and never
  // 24,681,300, which is the quantity but appears nowhere.
  const quote = cited('本期计提减值准备 2,468.13 万元。')
  assert.deepEqual(bindNumbers('The provision is 2,468.13.', quote).unbound, [])
  // The bare digits 24,681,300 are the quantity, not the printing: unbound.
  assert.equal(bindNumbers('The provision is 24,681,300.', quote).unbound.length, 1)
  // Written *with* its unit it is the same money as 2,468.13 万元, which the
  // pipeline has always accepted — scaling within one currency is arithmetic,
  // not a new figure.
  assert.deepEqual(bindNumbers('The provision is 24,681,300 yuan.', quote).unbound, [])
})

test('a claim keeps a unit only when the quote licenses it', () => {
  // The reverse direction is unchanged: a claim that asserts 万元 against a bare
  // figure still needs the document's own unit declaration.
  const bare = cited('资产减值损失 2,468.13 存货跌价准备')
  assert.equal(bindNumbers('The provision is 2,468.13 万元.', bare).unbound.length, 1)
  const declared: EvidenceRef[] = [
    { ...cited('资产减值损失 2,468.13 存货跌价准备')[0]!, declaredUnits: [{ unit: 'CNY', multiplier: '10000', source: '单位:人民币万元' }] },
  ]
  assert.deepEqual(bindNumbers('The provision is 2,468.13 万元.', declared).unbound, [])
})

test('a case number binds whole, and a transliteration of it does not', () => {
  const identifier = extractNumbers('依据（2026）沪0113民特（调）65号《民事裁定书》')
  assert.equal(identifier.length, 1, 'an identifier is one token, not three loose integers')
  assert.equal(identifier[0]?.kind, 'doc_no')

  // Quoted in the source's own characters: binds.
  assert.deepEqual(
    bindNumbers('The ruling is （2026）沪0113民特（调）65号《民事裁定书》.', cited(QUOTE)).unbound,
    [],
  )

  // Spelled out in Latin letters: those integers are not in the document, and
  // the claim must not publish an identifier no reader can look up.
  const transliterated = bindNumbers(
    'The ruling is (2026) Hu 0113 Min Te (Tiao) No. 65.',
    cited(QUOTE),
  )
  assert.ok(transliterated.unbound.length > 0)
  assert.equal(
    transliterated.unbound.some((token) => token.raw === '0113'),
    true,
  )
})

test('the same digits under a different unit do not bind', () => {
  // Cross-language leniency stops at the digits: a claim naming a currency the
  // quote does not state is still unbound.
  const quote = cited('本次回购股份 7,654,321 股。')
  assert.equal(bindNumbers('The buyback cost 7,654,321 yuan.', quote).unbound.length, 1)
  // …while the bare count binds, because that is what the page says.
  assert.deepEqual(bindNumbers('The buyback covered 7,654,321 shares.', quote).unbound, [])
})

test('a claim that translates the filing`s unit is refused, with the fix named', async () => {
  // The binder now accepts 「7,654,321 yuan」 against 「7,654,321 元」 — which is
  // what stops the rejection cascade — but accepting it for verification is not
  // the same as publishing it. A reader checking the memo against the filing
  // searches for the characters the filing printed.
  const { extractAndVerify } = await import('../src/steps/extract.ts')
  const { ScriptedModel } = await import('../src/model.ts')
  const filing = {
    id: 'D1',
    title: '重整申请公告',
    text: `公司债权人向法院申请重整。${QUOTE}`,
    provider: 'test',
  }
  const quote = '确认的货款 7,654,321 元'
  const model = new ScriptedModel([
    JSON.stringify({
      claims: [
        {
          question_id: 'Q1',
          type: 'fact',
          text: 'The claim amount is 7,654,321 yuan.',
          quotes: [{ document_id: 'D1', quote }],
        },
        {
          question_id: 'Q1',
          type: 'fact',
          text: 'The claim amount is 7,654,321 元.',
          quotes: [{ document_id: 'D1', quote }],
        },
      ],
      gaps: [],
    }),
  ])

  const result = await extractAndVerify(
    {
      entity: { name: '测试公司' },
      questionType: 'fact_extraction',
      seeksAdvice: false,
      lang: 'en',
      subQuestions: [{ id: 'Q1', text: 'What is the claim amount?' }],
    },
    [filing],
    model,
    'en',
  )

  const published = result.claims.map((claim) => claim.text)
  assert.equal(published.some((text) => text.includes('yuan')), false, 'the translated unit is refused')
  assert.equal(published.some((text) => text.includes('7,654,321 元')), true, 'the faithful one publishes')
  const rejection = result.rejected.find((item) => item.text.includes('yuan'))
  assert.ok(rejection)
  assert.match(rejection.reason, /unit was translated/)
  assert.match(rejection.reason, /元/, 'the rejection names the characters to use')
  assert.deepEqual(rejection.evidenceIds, ['E1'], 'located quotes survive a downstream rejection')
})

/** Number extraction, unit windows, and the unit-mismatch trap. */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  detectUnitHints,
  extractNumbers,
  matchesToken,
  verifyNumbers,
} from '../src/verify/numbers.ts'

test('compound tokens claim their digits before scalars do', () => {
  const tokens = extractNumbers('公司于2026年8月13日收到（2026）浙02破申13号，确认货款1,500,000元。')
  const kinds = tokens.map((token) => token.kind)
  assert.ok(kinds.includes('date'))
  assert.ok(kinds.includes('doc_no'))
  const amount = tokens.find((token) => token.kind === 'amount')
  assert.equal(amount?.value, '1500000')
  assert.equal(amount?.unit, 'CNY')
  // The date's digits must not also surface as bare scalars.
  assert.equal(tokens.filter((token) => token.value === '2026' && token.kind === 'scalar').length, 0)
})

test('unit multipliers canonicalize to a base amount', () => {
  const [wan] = extractNumbers('7,199.78 万元')
  const [yi] = extractNumbers('1.5亿元')
  assert.equal(wan.value, '71997800')
  assert.equal(yi.value, '150000000')
})

test('percent, multiple, and negative figures survive extraction', () => {
  const tokens = extractNumbers('占比 119.46%，为上期的 2.3 倍，计提 -10.84')
  assert.deepEqual(
    tokens.map((token) => [token.kind, token.value]),
    [
      ['percent', '119.46'],
      ['multiple', '2.3'],
      ['scalar', '-10.84'],
    ],
  )
})

test('a declared table unit justifies a bare figure, and only that unit', () => {
  const document = '单位：人民币万元\n资产减值损失 7,199.78 存货跌价准备'
  const hints = detectUnitHints(document)
  assert.deepEqual(hints.map((hint) => [hint.unit, hint.multiplier]), [['CNY', '10000']])

  const [quoted] = extractNumbers('资产减值损失 7,199.78 存货跌价准备')
  const [asWan] = extractNumbers('7,199.78 万元')
  const [asYuan] = extractNumbers('7,199.78 元')

  assert.equal(matchesToken(quoted, asWan, hints)?.basis, 'declared_unit')
  // The same figure labelled 元 is the R-005 unit error and must not bind.
  assert.equal(matchesToken(quoted, asYuan, hints), undefined)
})

test('English "in millions" is a unit declaration too', () => {
  assert.deepEqual(
    detectUnitHints('(in millions of dollars)').map((hint) => [hint.unit, hint.multiplier]),
    [['USD', '1000000']],
  )
})

test('full-width digits are digits', () => {
  // R2-P2a: `３６１` and `１，５００ 万元` read as prose to an ASCII-only scanner —
  // they would reach a memo unverified. Spans still index the original string,
  // so `raw` keeps the characters as the filing wrote them.
  const [scalar] = extractNumbers('３６１度')
  assert.equal(scalar.value, '361')
  assert.equal(scalar.raw, '３６１')

  const [amount] = extractNumbers('募集资金 １，５００ 万元')
  assert.equal(amount.value, '15000000')
  assert.equal(amount.unit, 'CNY')

  const [percent] = extractNumbers('占比 ９５．５％')
  assert.equal(percent.kind, 'percent')
  assert.equal(percent.value, '95.5')

  // And they verify against a half-width source, and vice versa.
  assert.ok(verifyNumbers('募集资金 １，５００ 万元', ['募集资金 1,500 万元']).ok)
  assert.ok(verifyNumbers('募集资金 1,500 万元', ['募集资金 １，５００ 万元']).ok)
})

test('a unit declared in one document does not license a bare figure in another', () => {
  // P1-5: flattening hints across sources made a multi-document memo strictly
  // easier to pass than a single-document one. Document B's `单位：万元` header
  // must not turn document A's bare 100 into 100 万元.
  const withHeader = '单位：人民币万元\n资产减值损失 7,199.78 存货跌价准备'
  const withoutHeader = '本次涉及金额 100 项，具体见附表。'
  const crossed = verifyNumbers('涉及金额 100 万元', [withoutHeader, withHeader])
  assert.ok(!crossed.ok, 'the bare 100 lives in a document that declares no unit')
  assert.equal(crossed.violations[0]?.kind, 'not_in_source')

  // The same figure in the document that does declare the unit still passes.
  assert.ok(verifyNumbers('计提 7,199.78 万元', [withoutHeader, withHeader]).ok)
})

test('the whole-text sweep honors the same unit window as the claim binder', () => {
  // A balance sheet declares its unit once and prints bare figures. A memo that
  // writes `4,977,383.86万元` is quoting it correctly, and the gate must agree
  // with the per-claim binder rather than call it a fabrication.
  const source = '单位：万元\n资产总额 4,977,383.86 4,829,537.41负债总额 4,155,379.25'
  assert.ok(verifyNumbers('资产总额为 4,977,383.86 万元', [source]).ok)
  // The unit window is one-way: only the declared unit is licensed.
  const wrongUnit = verifyNumbers('资产总额为 4,977,383.86 亿元', [source])
  assert.ok(!wrongUnit.ok)
})

test('verifyNumbers separates fabrication, unit errors, and bare years', () => {
  const source = '虚增营业收入 4435.88 万元，占当期营业收入 5.96%。'
  const good = verifyNumbers('虚增营业收入 4435.88 万元', [source])
  assert.ok(good.ok)

  const unitError = verifyNumbers('虚增营业收入 4435.88 元', [source])
  assert.equal(unitError.violations[0]?.kind, 'unit_mismatch')

  const fabricated = verifyNumbers('虚增营业收入 9999.99 万元', [source])
  assert.equal(fabricated.violations[0]?.kind, 'not_in_source')

  const year = verifyNumbers('2019 年的情况', [source])
  assert.equal(year.violations[0]?.kind, 'unsupported_year')
  assert.ok(year.ok, 'a bare year is recorded but does not fail the text')
})

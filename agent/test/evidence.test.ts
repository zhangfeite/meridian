/** Quote location: a citation is a pointer into the document, not a retelling. */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { locateQuote } from '../src/verify/evidence.ts'

const document = '经测试，公司 2026 年上半年需计提存货跌价准备 879.50 万元。合计 1,000.00 万元。'

test('an exact quote locates and reports its span', () => {
  const found = locateQuote(document, '计提存货跌价准备 879.50 万元')
  assert.ok(found)
  assert.ok(found.exact)
  assert.equal(document.slice(found.charStart, found.charEnd), found.quote)
})

test('whitespace differences are tolerated and the document version wins', () => {
  const found = locateQuote(document, '计提存货跌价准备879.50万元')
  assert.ok(found)
  assert.equal(found.exact, false)
  // The published quote is the document's characters, spaces included.
  assert.equal(found.quote, '计提存货跌价准备 879.50 万元')
})

test('a quote that is not in the document does not locate', () => {
  assert.equal(locateQuote(document, '计提存货跌价准备 999.99 万元'), undefined)
  assert.equal(locateQuote(document, '   '), undefined)
})

test('a paraphrase does not locate, however faithful', () => {
  assert.equal(locateQuote(document, '公司计提了存货跌价准备,金额为879.50万元'), undefined)
})

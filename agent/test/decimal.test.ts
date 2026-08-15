/** Exact decimal arithmetic — the floor everything numeric stands on. */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { add, divide, equals, multiply, parseDecimal, subtract, toFixed, toString } from '../src/verify/decimal.ts'

const decimal = (value: string) => {
  const parsed = parseDecimal(value)
  assert.ok(parsed, `expected ${value} to parse`)
  return parsed
}

test('parses thousands separators and rejects non-numbers', () => {
  assert.equal(toString(decimal('1,533.98')), '1533.98')
  assert.equal(toString(decimal('-10.84')), '-10.84')
  assert.equal(parseDecimal('八千'), undefined)
  assert.equal(parseDecimal('12.3.4'), undefined)
})

test('addition is exact where floating point is not', () => {
  assert.equal(toString(add(decimal('0.1'), decimal('0.2'))), '0.3')
  assert.notEqual(0.1 + 0.2, 0.3)
})

test('sums a filing table exactly', () => {
  const total = [decimal('-10.84'), decimal('1533.98'), decimal('92.53'), decimal('7199.78')].reduce(add)
  assert.equal(toString(total), '8815.45')
})

test('subtraction, multiplication, and division round half-up', () => {
  assert.equal(toString(subtract(decimal('8815.45'), decimal('7199.78'))), '1615.67')
  assert.equal(toString(multiply(decimal('1.5'), decimal('2.5'))), '3.75')
  const ratio = divide(decimal('7199.78'), decimal('8815.45'), 6)
  assert.ok(ratio)
  assert.equal(toString(ratio), '0.816723')
  assert.equal(divide(decimal('1'), decimal('0')), undefined)
})

test('toFixed pads, trims, and keeps the sign honest', () => {
  assert.equal(toFixed(decimal('0.816706'), 2), '0.82')
  assert.equal(toFixed(decimal('81.6706'), 1), '81.7')
  assert.equal(toFixed(decimal('5'), 2), '5.00')
  assert.equal(toFixed(decimal('-0.004'), 2), '0.00')
})

test('equality ignores scale', () => {
  assert.ok(equals(decimal('1.50'), decimal('1.5')))
  assert.ok(!equals(decimal('1.51'), decimal('1.5')))
})

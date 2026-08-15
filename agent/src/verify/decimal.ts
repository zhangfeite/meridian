/**
 * Exact decimal arithmetic on `BigInt`, because financial verification cannot
 * be done in IEEE-754.
 *
 * `0.1 + 0.2 !== 0.3` is a punchline until it decides whether a filing's
 * reported total matches the sum of its parts. Everything numeric in Meridian's
 * verification path goes through this module; nothing calls `parseFloat`.
 *
 * @module @meridian/agent/verify/decimal
 */

/** A signed decimal as `unscaled × 10^-scale`. */
export interface Decimal {
  unscaled: bigint
  scale: number
}

const DECIMAL_RE = /^[-+]?\d+(?:\.\d+)?$/

/**
 * Parse a decimal literal. Thousands separators and surrounding space are
 * tolerated; anything else returns `undefined` rather than a wrong number.
 *
 * @param value - the literal, e.g. `-1,533.98`.
 * @returns the parsed decimal, or `undefined` when it is not one.
 */
export function parseDecimal(value: string): Decimal | undefined {
  const cleaned = value.replace(/[,\s ]/g, '')
  if (!DECIMAL_RE.test(cleaned)) return undefined
  const negative = cleaned.startsWith('-')
  const body = cleaned.replace(/^[-+]/, '')
  const [integer, fraction = ''] = body.split('.')
  const digits = `${integer}${fraction}` || '0'
  const unscaled = BigInt(digits) * (negative ? -1n : 1n)
  return { unscaled, scale: fraction.length }
}

/** Bring two decimals to a common scale. */
function align(left: Decimal, right: Decimal): [bigint, bigint, number] {
  const scale = Math.max(left.scale, right.scale)
  return [
    left.unscaled * 10n ** BigInt(scale - left.scale),
    right.unscaled * 10n ** BigInt(scale - right.scale),
    scale,
  ]
}

/** Exact sum. */
export function add(left: Decimal, right: Decimal): Decimal {
  const [a, b, scale] = align(left, right)
  return { unscaled: a + b, scale }
}

/** Exact difference. */
export function subtract(left: Decimal, right: Decimal): Decimal {
  const [a, b, scale] = align(left, right)
  return { unscaled: a - b, scale }
}

/** Exact product. */
export function multiply(left: Decimal, right: Decimal): Decimal {
  return { unscaled: left.unscaled * right.unscaled, scale: left.scale + right.scale }
}

/**
 * Quotient rounded half-up to `scale` fractional digits.
 * @param left - dividend.
 * @param right - divisor.
 * @param scale - fractional digits to keep (default 10).
 * @returns the quotient, or `undefined` when dividing by zero.
 */
export function divide(left: Decimal, right: Decimal, scale = 10): Decimal | undefined {
  if (right.unscaled === 0n) return undefined
  const [a, b] = align(left, right)
  const shifted = a * 10n ** BigInt(scale + 1)
  const raw = shifted / b
  const negative = raw < 0n
  const magnitude = negative ? -raw : raw
  const rounded = (magnitude + 5n) / 10n
  return { unscaled: negative ? -rounded : rounded, scale }
}

/** Signed comparison: −1, 0, or 1. */
export function compare(left: Decimal, right: Decimal): number {
  const [a, b] = align(left, right)
  return a === b ? 0 : a < b ? -1 : 1
}

/** True when both decimals denote the same quantity, whatever their scales. */
export function equals(left: Decimal, right: Decimal): boolean {
  return compare(left, right) === 0
}

/** Absolute value. */
export function abs(value: Decimal): Decimal {
  return { unscaled: value.unscaled < 0n ? -value.unscaled : value.unscaled, scale: value.scale }
}

/**
 * Render without an exponent, trailing zeros removed.
 * @param value - the decimal.
 * @returns its canonical string form; `-0` normalizes to `0`.
 */
export function toString(value: Decimal): string {
  const negative = value.unscaled < 0n
  const digits = (negative ? -value.unscaled : value.unscaled).toString()
  let rendered: string
  if (value.scale === 0) {
    rendered = digits
  } else {
    const padded = digits.padStart(value.scale + 1, '0')
    const integer = padded.slice(0, padded.length - value.scale)
    const fraction = padded.slice(padded.length - value.scale).replace(/0+$/, '')
    rendered = fraction ? `${integer}.${fraction}` : integer
  }
  if (rendered === '0' || /^0\.0*$/.test(rendered)) return '0'
  return negative ? `-${rendered}` : rendered
}

/**
 * Render with a fixed number of fractional digits, rounded half-up.
 * @param value - the decimal.
 * @param digits - fractional digits to show.
 * @returns the fixed-point string.
 */
export function toFixed(value: Decimal, digits: number): string {
  if (value.scale === digits) return toStringFixed(value, digits)
  if (value.scale < digits) {
    return toStringFixed({ unscaled: value.unscaled * 10n ** BigInt(digits - value.scale), scale: digits }, digits)
  }
  const drop = BigInt(value.scale - digits)
  const divisor = 10n ** drop
  const negative = value.unscaled < 0n
  const magnitude = negative ? -value.unscaled : value.unscaled
  const rounded = (magnitude * 10n / divisor + 5n) / 10n
  return toStringFixed({ unscaled: negative ? -rounded : rounded, scale: digits }, digits)
}

/** Render an already-correctly-scaled decimal without trimming zeros. */
function toStringFixed(value: Decimal, digits: number): string {
  const negative = value.unscaled < 0n
  const raw = (negative ? -value.unscaled : value.unscaled).toString().padStart(digits + 1, '0')
  const integer = raw.slice(0, raw.length - digits)
  const fraction = digits > 0 ? `.${raw.slice(raw.length - digits)}` : ''
  const rendered = `${integer}${fraction}`
  return negative && !/^0(\.0*)?$/.test(rendered) ? `-${rendered}` : rendered
}

/** Multiply by an integer scale factor such as 10 000 (万) — exact. */
export function scaleBy(value: Decimal, factor: bigint): Decimal {
  return { unscaled: value.unscaled * factor, scale: value.scale }
}

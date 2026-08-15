/**
 * Verbatim number verification — the mechanism behind "验证优先于生成".
 *
 * A number reaches a Meridian memo in exactly one of two ways: it occurs
 * character-for-character in a primary source, or the pipeline computed it
 * itself from numbers that do (see `derive.ts`). Everything else is deleted.
 * This module implements the first half.
 *
 * Doctrinally this is the same check Meridian Bench scores agents on (verbatim
 * match, unit-window comparison, derived-number registry), reimplemented for
 * the agent side in TypeScript: the benchmark and the product must not share an
 * implementation, or the benchmark stops being an independent check.
 *
 * @module @meridian/agent/verify/numbers
 */

import { foldScript } from './script.ts'

import { equals, parseDecimal, scaleBy, toString, type Decimal } from './decimal.ts'

/** What a number token denotes. */
export type NumberKind = 'amount' | 'percent' | 'date' | 'doc_no' | 'scalar' | 'multiple'

/** One number found in text. */
export interface NumberToken {
  /** Exactly as written. */
  raw: string
  kind: NumberKind
  /** Canonical comparison key: base-unit amount, ISO date, normalized doc number. */
  value: string
  /** `CNY` | `USD` | `HKD` | `percent` | `date` | `doc_no` | `scalar` | `multiple`. */
  unit: string
  /** The written figure before its unit multiplier (`987.65` → `7199.78`). */
  numericRaw?: string
  /** The unit multiplier applied (`万元` → `10000`). */
  multiplier?: string
  start: number
  end: number
}

/** Currency-unit table: written unit → [canonical currency, multiplier]. */
const UNITS: [string, string, bigint][] = [
  ['万亿元', 'CNY', 1_000_000_000_000n],
  ['百万元', 'CNY', 1_000_000n],
  ['亿元', 'CNY', 100_000_000n],
  ['万元', 'CNY', 10_000n],
  ['千元', 'CNY', 1_000n],
  ['元人民币', 'CNY', 1n],
  ['人民币', 'CNY', 1n],
  ['元', 'CNY', 1n],
  ['万港元', 'HKD', 10_000n],
  ['亿港元', 'HKD', 100_000_000n],
  ['港元', 'HKD', 1n],
  ['万美元', 'USD', 10_000n],
  ['亿美元', 'USD', 100_000_000n],
  ['美元', 'USD', 1n],
  ['billion yuan', 'CNY', 1_000_000_000n],
  ['million yuan', 'CNY', 1_000_000n],
  ['billion rmb', 'CNY', 1_000_000_000n],
  ['million rmb', 'CNY', 1_000_000n],
  ['billion dollars', 'USD', 1_000_000_000n],
  ['million dollars', 'USD', 1_000_000n],
  ['billion dollar', 'USD', 1_000_000_000n],
  ['million dollar', 'USD', 1_000_000n],
  ['cny', 'CNY', 1n],
  ['rmb', 'CNY', 1n],
  ['usd', 'USD', 1n],
  ['hkd', 'HKD', 1n],
  // Bare currency words, last so the scaled forms above win the alternation. An
  // English claim about a Chinese filing writes 「7,654,321 yuan」 where the
  // filing prints the same digits followed by 元; without these the claim's
  // figure is a bare scalar and its unit is lost before binding ever runs.
  ['yuan', 'CNY', 1n],
  ['renminbi', 'CNY', 1n],
  ['hong kong dollars', 'HKD', 1n],
  ['hong kong dollar', 'HKD', 1n],
  ['us dollars', 'USD', 1n],
  ['us dollar', 'USD', 1n],
  ['dollars', 'USD', 1n],
  ['dollar', 'USD', 1n],
]

/**
 * Currency written *before* the figure, as English does: `CNY 7,654,321`,
 * `RMB 42 million`, `HK$3.14`. The suffix table above cannot see these, and a
 * prefixed amount that falls through to the scalar pattern loses its unit.
 */
const EN_PREFIX_UNITS: [string, string][] = [
  ['cny', 'CNY'],
  ['rmb', 'CNY'],
  ['usd', 'USD'],
  ['hkd', 'HKD'],
  ['us\\$', 'USD'],
  ['hk\\$', 'HKD'],
]
const EN_PREFIX_AMOUNT_RE = new RegExp(
  String.raw`\b(${EN_PREFIX_UNITS.map(([label]) => label).join('|')})\s*([-+]?\d[\d,]*(?:\.\d+)?)\s*(billion|million|thousand)?\b`,
  'gi',
)

const UNIT_ALTERNATION = UNITS.map(([label]) => label.replace(/ /g, '\\s+')).join('|')

const DOC_RE = /[（(]\s*\d{4}\s*[）)]\s*[^，。；;\n]{0,24}?\d+\s*号/g
const DATE_CN_RE = /(?<!\d)\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/g
const DATE_ISO_RE = /(?<!\d)\d{4}[-/]\d{1,2}[-/]\d{1,2}(?!\d)/g
const PREFIX_AMOUNT_RE = /([$¥￥])\s*([-+]?\d[\d,]*(?:\.\d+)?)\s*(billion|million|thousand)?/gi
const AMOUNT_RE = new RegExp(
  String.raw`(?<![\d.])([-+]?\d[\d,]*(?:\.\d+)?)\s*(${UNIT_ALTERNATION})(?![a-zA-Z])`,
  'gi',
)
/**
 * A per-unit price: `3.62 元/股`.
 *
 * Must be tried before the plain amount pattern, or the `/股` is dropped and a
 * price becomes an amount — after which dividing a sale price by a buyback
 * price is 元 ÷ 元/股, which is dimensionally a share count, not a multiple.
 * The arithmetic came out right by accident; the type did not.
 */
const UNIT_PRICE_RE =
  /(?<![\d.])(?<number>[-+]?\d[\d,]*(?:\.\d+)?)\s*(?<currency>元|人民币|港元|美元)\s*\/\s*(?:股|份)/g

const PERCENT_RE = /(?<![\w.])[-+]?\d[\d,]*(?:\.\d+)?\s*(?:%|％|percent|百分点)/gi
/**
 * A bare figure.
 *
 * The trailing guard rejects a *decimal continuation*, not a full stop: with
 * `(?![\d.])`, an English sentence ending in 「…is 7,654,321.」 backtracked to
 * `7,654` — a token that is nowhere in the filing, so the sentence carrying the
 * real figure was rejected as unsourced.
 */
const SCALAR_RE = /(?<![\d.])[-+]?\d[\d,]*(?:\.\d+)?(?:\s*倍)?(?!\.?\d)/g

const PREFIX_SCALES: Record<string, bigint> = {
  '': 1n,
  thousand: 1_000n,
  million: 1_000_000n,
  billion: 1_000_000_000n,
}

/** Normalize a document number for comparison: no spaces, full-width folded. */
function normalizeDocNumber(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
}

/** Look up a written currency unit. */
function lookupUnit(label: string): [string, bigint] | undefined {
  const needle = label.replace(/\s+/g, ' ').trim().toLowerCase()
  for (const [written, currency, multiplier] of UNITS) {
    if (written.toLowerCase() === needle) return [currency, multiplier]
  }
  return undefined
}

/**
 * Full-width → ASCII for the character classes that matter to number scanning.
 *
 * Every mapping here is one code point to one code point, so offsets survive
 * and a token's `raw` can still be sliced out of the *original* string. Full
 * NFKC is not safe for that: it expands some characters and would slide every
 * offset after them.
 *
 * Without this, `３６１` and `１，５００` read as prose — they reach a memo
 * unverified, and they reach the writing model as digits it was promised never
 * to see.
 */
function foldWidth(text: string): string {
  // Script folding rides along here for the same reason and under the same
  // rule: 「單位:人民幣萬元」 declares the same unit as 「单位:人民币万元」, and
  // both folds are one code point to one, so `raw` still slices out of the
  // original and gets published in the document's own characters.
  return foldScript(text).replace(/[０-９．，％－＋（）]/g, (char) => {
    const code = char.codePointAt(0) as number
    if (code >= 0xff10 && code <= 0xff19) return String.fromCharCode(code - 0xff10 + 0x30)
    return { '．': '.', '，': ',', '％': '%', '－': '-', '＋': '+', '（': '(', '）': ')' }[char] ?? char
  })
}

/**
 * Extract every financial number from a string without double-counting digits.
 *
 * Order matters: compound forms (document numbers, dates, amounts with units)
 * claim their span first, so `1,234,567元` yields one CNY amount rather than a
 * bare scalar plus a stray unit.
 *
 * @param text - text to scan.
 * @returns tokens in document order; `raw` is sliced from the input as written.
 */
export function extractNumbers(original: string): NumberToken[] {
  // Scan the width-folded copy, report spans against the original.
  const text = foldWidth(original)
  const found: NumberToken[] = []
  const occupied: [number, number][] = []

  const overlaps = (start: number, end: number): boolean =>
    occupied.some(([left, right]) => start < right && left < end)

  const claim = (token: NumberToken): void => {
    if (overlaps(token.start, token.end)) return
    occupied.push([token.start, token.end])
    found.push(token)
  }

  for (const match of text.matchAll(DOC_RE)) {
    claim({
      raw: original.slice(match.index, match.index + match[0].length),
      kind: 'doc_no',
      value: normalizeDocNumber(match[0]),
      unit: 'doc_no',
      start: match.index,
      end: match.index + match[0].length,
    })
  }

  for (const regex of [DATE_CN_RE, DATE_ISO_RE]) {
    for (const match of text.matchAll(regex)) {
      const digits = match[0].match(/\d+/g)?.map(Number) ?? []
      if (digits.length < 3) continue
      const [year, month, day] = digits
      claim({
        raw: original.slice(match.index, match.index + match[0].length),
        kind: 'date',
        value: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        unit: 'date',
        start: match.index,
        end: match.index + match[0].length,
      })
    }
  }

  for (const match of text.matchAll(EN_PREFIX_AMOUNT_RE)) {
    const parsed = parseDecimal(match[2] ?? '')
    if (!parsed) continue
    const multiplier = PREFIX_SCALES[(match[3] ?? '').toLowerCase()] ?? 1n
    const currency = EN_PREFIX_UNITS.find(
      ([label]) => label.replace(/\\/g, '') === (match[1] ?? '').toLowerCase(),
    )?.[1]
    if (!currency) continue
    claim({
      raw: original.slice(match.index, match.index + match[0].length),
      kind: 'amount',
      value: toString(scaleBy(parsed, multiplier)),
      unit: currency,
      numericRaw: toString(parsed),
      multiplier: multiplier.toString(),
      start: match.index,
      end: match.index + match[0].length,
    })
  }

  for (const match of text.matchAll(PREFIX_AMOUNT_RE)) {
    const parsed = parseDecimal(match[2] ?? '')
    if (!parsed) continue
    const multiplier = PREFIX_SCALES[(match[3] ?? '').toLowerCase()] ?? 1n
    const currency = match[1] === '$' ? 'USD' : 'CNY'
    claim({
      raw: original.slice(match.index, match.index + match[0].length),
      kind: 'amount',
      value: toString(scaleBy(parsed, multiplier)),
      unit: currency,
      numericRaw: toString(parsed),
      multiplier: multiplier.toString(),
      start: match.index,
      end: match.index + match[0].length,
    })
  }

  for (const match of text.matchAll(UNIT_PRICE_RE)) {
    const parsed = parseDecimal(match.groups?.number ?? '')
    const unit = lookupUnit(match.groups?.currency ?? '')
    if (!parsed || !unit) continue
    claim({
      raw: original.slice(match.index, match.index + match[0].length),
      kind: 'amount',
      value: toString(parsed),
      unit: `${unit[0]}/unit`,
      numericRaw: toString(parsed),
      multiplier: '1',
      start: match.index,
      end: match.index + match[0].length,
    })
  }

  for (const match of text.matchAll(AMOUNT_RE)) {
    const parsed = parseDecimal(match[1] ?? '')
    const unit = lookupUnit(match[2] ?? '')
    if (!parsed || !unit) continue
    claim({
      raw: original.slice(match.index, match.index + match[0].length),
      kind: 'amount',
      value: toString(scaleBy(parsed, unit[1])),
      unit: unit[0],
      numericRaw: toString(parsed),
      multiplier: unit[1].toString(),
      start: match.index,
      end: match.index + match[0].length,
    })
  }

  for (const match of text.matchAll(PERCENT_RE)) {
    const figure = /[-+]?\d[\d,]*(?:\.\d+)?/.exec(match[0])?.[0] ?? ''
    const parsed = parseDecimal(figure)
    if (!parsed) continue
    claim({
      raw: original.slice(match.index, match.index + match[0].length),
      kind: 'percent',
      value: toString(parsed),
      unit: 'percent',
      start: match.index,
      end: match.index + match[0].length,
    })
  }

  for (const match of text.matchAll(SCALAR_RE)) {
    const figure = /[-+]?\d[\d,]*(?:\.\d+)?/.exec(match[0])?.[0] ?? ''
    const parsed = parseDecimal(figure)
    if (!parsed) continue
    const isMultiple = match[0].includes('倍')
    claim({
      raw: original.slice(match.index, match.index + match[0].length),
      kind: isMultiple ? 'multiple' : 'scalar',
      value: toString(parsed),
      unit: isMultiple ? 'multiple' : 'scalar',
      start: match.index,
      end: match.index + match[0].length,
    })
  }

  return found.sort((left, right) => left.start - right.start)
}

/**
 * A unit declared for a whole table or document rather than per figure.
 *
 * Chinese filings almost always print `单位:人民币万元` above the table and then
 * bare figures inside it. A verifier that demands `万元` next to every digit
 * would reject every correct answer to every table question — and one that
 * ignores units entirely would accept the single most damaging error class
 * (万元 read as 元). The unit window is the middle: the figure must be verbatim
 * in the quoted row, and the unit must be declared verbatim in the same
 * document.
 */
export interface UnitHint {
  unit: string
  multiplier: string
  /** The declaration as printed, e.g. `单位:人民币万元`. */
  source: string
}

const UNIT_DECLARATION_RE =
  /(?:单位|單位)\s*[:：]\s*(?:人民币|人民幣|港币|港幣|美元)?\s*(万亿元|百万元|亿元|万元|千元|元|万港元|亿港元|港元|万美元|亿美元|美元)/g
const EN_UNIT_DECLARATION_RE = /\bin\s+(thousands|millions|billions)\b(?:\s+of\s+(dollars|usd|rmb|yuan|cny))?/gi

const EN_SCALES: Record<string, bigint> = {
  thousands: 1_000n,
  millions: 1_000_000n,
  billions: 1_000_000_000n,
}

/**
 * Find every unit declared for a document as a whole.
 *
 * @param text - the document text.
 * @returns declared units, deduplicated.
 */
export function detectUnitHints(text: string): UnitHint[] {
  const hints: UnitHint[] = []
  const push = (unit: string, multiplier: bigint, source: string): void => {
    if (hints.some((hint) => hint.unit === unit && hint.multiplier === multiplier.toString())) return
    hints.push({ unit, multiplier: multiplier.toString(), source })
  }
  for (const match of foldScript(text).matchAll(UNIT_DECLARATION_RE)) {
    const unit = lookupUnit(match[1] ?? '')
    if (unit) push(unit[0], unit[1], match[0].replace(/\s+/g, ''))
  }
  for (const match of text.matchAll(EN_UNIT_DECLARATION_RE)) {
    const multiplier = EN_SCALES[(match[1] ?? '').toLowerCase()]
    if (!multiplier) continue
    const currency = (match[2] ?? '').toLowerCase()
    push(currency === 'rmb' || currency === 'yuan' || currency === 'cny' ? 'CNY' : 'USD', multiplier, match[0])
  }
  return hints
}

/**
 * Does `candidate` (found in a quote) justify `wanted` (written in a claim)?
 *
 * Exact same quantity and unit always qualifies. An amount also qualifies when
 * the bare figure is in the quote and its unit is declared for the document —
 * the unit window described on {@link UnitHint}.
 *
 * @param candidate - a token from the cited quote.
 * @param wanted - a token from the claim being verified.
 * @param hints - units declared by the document the quote came from.
 * @returns the justification, or `undefined` when there is none.
 */
export function matchesToken(
  candidate: NumberToken,
  wanted: NumberToken,
  hints: UnitHint[] = [],
): { basis: 'verbatim' } | { basis: 'declared_unit'; hint: UnitHint } | undefined {
  if (sameQuantityTokens(candidate, wanted)) return { basis: 'verbatim' }

  // A claim that writes the digits without a unit is justified by a quote that
  // prints the same digits with one: a filing reading 「…7,654,321元」 answers
  // "7,654,321" in an English sentence. Nothing is smuggled in — the claim
  // asserts no unit, so there is no unit to be wrong about. The comparison is
  // against the *printed* figure, not the scaled value: 「2,468.13万元」
  // justifies 2,468.13 and not 24,681,300, because only the first is on the page.
  if (wanted.kind === 'scalar' && candidate.kind === 'amount') {
    const printed = candidate.numericRaw
    const left = printed === undefined ? undefined : parseDecimal(printed)
    const right = parseDecimal(wanted.value)
    if (left && right && equals(left, right)) return { basis: 'verbatim' }
  }

  if (wanted.kind !== 'amount' || wanted.numericRaw === undefined) return undefined
  const figure = candidate.kind === 'amount' ? candidate.numericRaw : candidate.value
  if (figure === undefined) return undefined
  const a = parseDecimal(figure)
  const b = parseDecimal(wanted.numericRaw)
  if (!a || !b || !equals(a, b)) return undefined
  // A bare figure in the quote (`987.65`) plus a unit the document declares
  // (`单位:人民币万元`) justifies `987.65 万元` — and only that unit.
  if (candidate.kind === 'amount' && candidate.multiplier !== '1') return undefined
  const hint = hints.find((item) => item.unit === wanted.unit && item.multiplier === wanted.multiplier)
  return hint ? { basis: 'declared_unit', hint } : undefined
}

/**
 * Numerals written as words or full-width characters.
 *
 * `extractNumbers` sees ASCII digits. A figure can also arrive as `３６１`,
 * 「一千零五十万元」, or 「百分之五」 — all of which carry a quantity past a
 * digits-only check. Anywhere a rule means "this text states no number", this is
 * the test, not `/\d/`.
 */
const NUMERAL_CHARS = '〇零一二兩两三四五六七八九十百千万萬亿億'
/** Scale words: 「万元」 names a unit, 「五元」 states a quantity. */
const COUNTING_CHARS = '〇零一二兩两三四五六七八九十'
const CN_NUMERAL_RUN = new RegExp(`[${NUMERAL_CHARS}]{2,}`, 'g')
// A lone scale word before a unit is that unit's name, not a figure — 「万元」,
// 「亿股」. A real quantity either counts (「五元」) or runs to two characters
// (「五万元」), and the run pattern above already has the second case.
const CN_NUMERAL_IN_CONTEXT = new RegExp(
  `百分之[${NUMERAL_CHARS}]+|[${COUNTING_CHARS}]\\s*(?:元|万元|萬元|亿元|億元|股|%|％|成|折|倍|个百分点|個百分點)`,
  'g',
)
const EN_NUMERAL_WORD =
  /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|percent)\b/gi

/**
 * Every numeral this text states, in digits or in words.
 *
 * @param text - text to scan.
 * @returns the numeral tokens found; empty when the text states no quantity.
 */
export function writtenNumerals(text: string): string[] {
  const folded = foldWidth(text).normalize('NFKC')
  const compact = folded.replace(/\s+/g, '')
  return [
    ...(folded.match(/\d[\d,.]*/g) ?? []),
    ...(compact.match(CN_NUMERAL_RUN) ?? []),
    ...(compact.match(CN_NUMERAL_IN_CONTEXT) ?? []),
    ...(folded.match(EN_NUMERAL_WORD) ?? []).map((word) => word.toLowerCase()),
  ]
}

/** Why a number failed verification. */
export type NumberViolationKind =
  | 'unit_mismatch'
  | 'not_in_source'
  /** A bare four-digit year with no source occurrence — sloppy, not fabricated. */
  | 'unsupported_year'

/** One number that did not earn its place. */
export interface NumberViolation {
  token: NumberToken
  kind: NumberViolationKind
  /** For `unit_mismatch`: the source figure it was probably rewritten from. */
  nearest?: NumberToken
  severity: 'high' | 'low'
}

/** Outcome of checking one text against its sources. */
export interface NumberVerification {
  tokens: NumberToken[]
  verified: { token: NumberToken; source: NumberToken }[]
  violations: NumberViolation[]
  /** True when nothing in the text is unaccounted for. */
  ok: boolean
}

/** Same figure written under a different unit — the heaviest error class. */
function isUnitMismatch(candidate: NumberToken, source: NumberToken): boolean {
  if (candidate.kind !== 'amount' || source.kind !== 'amount') return false
  if (candidate.numericRaw !== undefined && candidate.numericRaw === source.numericRaw) {
    return candidate.multiplier !== source.multiplier || candidate.unit !== source.unit
  }
  return candidate.value === source.value && candidate.unit !== source.unit
}

/** Two tokens denote the same quantity. */
function sameQuantityTokens(left: NumberToken, right: NumberToken): boolean {
  if (left.unit !== right.unit) return false
  if (left.unit === 'doc_no') return normalizeDocNumber(left.value) === normalizeDocNumber(right.value)
  const a = parseDecimal(left.value)
  const b = parseDecimal(right.value)
  if (a && b) return equals(a, b)
  return left.value === right.value
}

/**
 * Verify every number in `text` against the primary sources it claims to come from.
 *
 * @param text - candidate claim text.
 * @param sources - full text of every retrieved document.
 * @param allowed - additional tokens the pipeline itself computed (derived numbers).
 * @returns per-token verdicts; `ok` is true when there are no violations.
 */
export function verifyNumbers(
  text: string,
  sources: string[],
  allowed: NumberToken[] = [],
): NumberVerification {
  // The sweep must apply exactly the rule the per-claim binder applies, or the
  // gate rejects sentences its own verifier accepted. A balance sheet printed
  // under `单位：万元` states its figures bare; `4,977,383.86万元` is the same
  // quantity, and only under that declared unit.
  //
  // Scoped per document, deliberately: a `单位：万元` header in filing B must not
  // license a bare `100` taken from filing A. Flattening the hints across
  // sources would make a multi-document memo strictly easier to pass than a
  // single-document one, which is exactly backwards.
  const scoped = sources.map((source) => ({
    tokens: extractNumbers(source),
    hints: detectUnitHints(source),
  }))
  const sourceTokens = [...scoped.flatMap((entry) => entry.tokens), ...allowed]
  const tokens = extractNumbers(text)
  const verified: { token: NumberToken; source: NumberToken }[] = []
  const violations: NumberViolation[] = []

  for (const token of tokens) {
    let match: NumberToken | undefined
    for (const entry of scoped) {
      match = entry.tokens.find((candidate) => matchesToken(candidate, token, entry.hints))
      if (match) break
    }
    // Pipeline-computed values carry their own unit and need no declaration.
    match ??= allowed.find((candidate) => matchesToken(candidate, token))
    if (match) {
      verified.push({ token, source: match })
      continue
    }
    const mismatch = sourceTokens.find((source) => isUnitMismatch(token, source))
    if (mismatch) {
      violations.push({ token, kind: 'unit_mismatch', nearest: mismatch, severity: 'high' })
      continue
    }
    const asYear = Number(token.value)
    if (token.kind === 'scalar' && Number.isInteger(asYear) && asYear >= 1900 && asYear <= 2100) {
      violations.push({ token, kind: 'unsupported_year', severity: 'low' })
      continue
    }
    violations.push({ token, kind: 'not_in_source', severity: 'high' })
  }

  return {
    tokens,
    verified,
    violations,
    ok: violations.every((violation) => violation.severity === 'low'),
  }
}

/** Convenience: the canonical decimal of a token, when it has one. */
export function tokenDecimal(token: NumberToken): Decimal | undefined {
  return parseDecimal(token.value)
}

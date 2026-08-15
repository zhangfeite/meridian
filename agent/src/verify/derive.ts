/**
 * Derived numbers: the pipeline computes them, the model never reports them.
 *
 * A model asked "what share of the total is inventory?" will happily answer
 * "about 82%" — sometimes right, sometimes not, always unverifiable. Meridian
 * lets the model propose only the *shape* of the calculation (operation and
 * operands, each of which must occur verbatim in cited evidence) and then does
 * the arithmetic in exact decimal itself. The rendered figure is ours.
 *
 * @module @meridian/agent/verify/derive
 */

import type { DerivedInput, DerivedNumber, EvidenceRef } from '../contract.ts'
import { idAllocator } from '../ids.ts'
import { abs, add, compare, divide, multiply, subtract, toFixed, toString, type Decimal } from './decimal.ts'
import { extractNumbers, matchesToken } from './numbers.ts'

/** One proposed operand: a quoted figure, or another derivation's output. */
export interface DerivationOperand {
  /** The figure as written in the source. Required for a quoted operand. */
  display?: string
  /** Evidence the model believes contains it. */
  evidenceId?: string
  /**
   * Another proposal's id, making this a chained operand.
   *
   * Premium = sale price ÷ buyback price is two derivations, not one: the
   * buyback price is itself computed. MB-012's model wrote `{{D1}}` here
   * unprompted, which is the clearest statement of the need there could be.
   */
  derivedId?: string
}

/** A calculation proposed by the model, before the pipeline validates it. */
export interface DerivationProposal {
  id: string
  label: string
  op: DerivedNumber['op']
  operands: DerivationOperand[]
  /** Fractional digits for the rendered result (default 2). */
  precision?: number
}

/** Chains deeper than this are suspicious complexity, not analysis. */
export const MAX_CHAIN_DEPTH = 3

/** A rejected proposal, with the reason a reviewer would want. */
export interface DerivationRejection {
  proposalId: string
  reason: string
}

/** Outcome of validating a batch of proposals. */
export interface DerivationResult {
  derived: DerivedNumber[]
  rejected: DerivationRejection[]
  /**
   * Model proposal id → the derivation it produced.
   *
   * Published derivations carry pipeline-assigned, digit-free ids (`D-A`), while
   * the model's claim text refers to its own (`{{D1}}`). This is the join, and
   * it is returned rather than reconstructed: matching on label and order is the
   * kind of guess that silently mislabels a figure.
   */
  byProposal: Map<string, DerivedNumber>
}

/**
 * Validate and compute proposed derivations.
 *
 * A proposal survives only if every operand occurs verbatim inside the evidence
 * quote it names, the units are compatible with the operation, and the
 * arithmetic is defined. Survivors carry a pipeline-rendered `display`.
 *
 * @param proposals - model-proposed calculations.
 * @param evidence - evidence pool the operands must be found in.
 * @returns computed derivations plus rejections with reasons.
 */
export function computeDerivations(
  proposals: DerivationProposal[],
  evidence: EvidenceRef[],
): DerivationResult {
  const byId = new Map(evidence.map((item) => [item.id, item]))
  const proposalById = new Map(proposals.map((proposal) => [proposal.id, proposal]))
  const nextId = idAllocator('D')
  const internalId = new Map(proposals.map((proposal) => [proposal.id, nextId()]))
  const derived: DerivedNumber[] = []
  const rejected: DerivationRejection[] = []
  const computedByProposal = new Map<string, DerivedNumber>()

  const dependencies = (proposal: DerivationProposal): string[] =>
    proposal.operands
      .map((operand) => operand.derivedId)
      .filter((id): id is string => Boolean(id) && proposalById.has(id as string))

  // A chain must be a DAG, and it must be shallow. Both are evaluated before any
  // arithmetic: a cycle has no fixed point to compute, and a chain deeper than
  // MAX_CHAIN_DEPTH is complexity nobody asked for and nobody can hand-check.
  const inCycle = findCycles(proposals, dependencies)
  const order = topologicalOrder(proposals, dependencies, inCycle)

  for (const proposal of order) {
    if (inCycle.has(proposal.id)) {
      rejected.push({
        proposalId: proposal.id,
        reason: `derivation cycle: ${proposal.id} takes part in a circular reference`,
      })
      continue
    }
    if (proposal.operands.length < 2) {
      rejected.push({ proposalId: proposal.id, reason: 'a derivation needs at least two operands' })
      continue
    }

    const inputs: DerivedInput[] = []
    const quantities: Quantity[] = []
    const units: string[] = []
    const dependsOn: string[] = []
    let depth = 1
    let failure: string | undefined

    for (const operand of proposal.operands) {
      if (operand.derivedId) {
        const upstream = computedByProposal.get(operand.derivedId)
        if (!upstream) {
          failure = proposalById.has(operand.derivedId)
            ? `operand depends on derivation '${operand.derivedId}', which did not validate`
            : `operand references unknown derivation '${operand.derivedId}'`
          break
        }
        const decimal = decimalOf(upstream.value)
        if (!decimal) {
          failure = `derivation '${operand.derivedId}' produced a non-numeric value`
          break
        }
        // The chain carries intervals, not point values: whatever slack the
        // upstream result had is still there when the next link divides by it.
        quantities.push({ value: decimal, half: decimalOf(upstream.uncertainty) ?? ZERO })
        units.push(upstream.unit)
        dependsOn.push(upstream.id)
        depth = Math.max(depth, upstream.depth + 1)
        inputs.push({
          value: upstream.value,
          unit: upstream.unit,
          display: upstream.display,
          derivedId: upstream.id,
        })
        continue
      }

      const located = locateOperand(operand, byId, evidence)
      if ('error' in located) {
        failure = located.error
        break
      }
      quantities.push(
        leafQuantity(located.quantity.value, located.quantity.raw, located.quantity.multiplier),
      )
      units.push(located.quantity.unit)
      inputs.push({
        value: located.quantity.value,
        unit: located.quantity.unit,
        // Where the operand actually is, not where the model said it was.
        evidenceId: located.source.id,
        // The filing's own rendering, not the model's: an operand typed bare
        // must still print with its unit, or the appendix states a figure the
        // sweep cannot match to any source.
        display: located.quantity.raw.trim(),
      })
    }

    if (failure) {
      rejected.push({ proposalId: proposal.id, reason: failure })
      continue
    }
    if (depth > MAX_CHAIN_DEPTH) {
      rejected.push({
        proposalId: proposal.id,
        reason: `derivation chain is ${depth} deep, over the limit of ${MAX_CHAIN_DEPTH}`,
      })
      continue
    }

    const computed = evaluate(proposal.op, quantities, units)
    if ('error' in computed) {
      rejected.push({ proposalId: proposal.id, reason: computed.error })
      continue
    }

    const precision = proposal.precision ?? 2
    const relative = divide(computed.quantity.half, abs(computed.quantity.value), 12)
    const record: DerivedNumber = {
      id: internalId.get(proposal.id) as string,
      label: proposal.label,
      op: proposal.op,
      inputs,
      value: toString(computed.quantity.value),
      display: render({ value: computed.quantity.value, unit: computed.unit }, precision),
      unit: computed.unit,
      formula: inputs
        .map((input) => (input.derivedId ? `[${input.derivedId}] ${input.display}` : input.display))
        .join(operatorSymbol(proposal.op)),
      // Relative where that is meaningful; the absolute half-width always.
      tolerance: computed.quantity.value.unscaled === 0n || !relative ? '0' : toString(relative),
      uncertainty: toString(computed.quantity.half),
      dependsOn,
      depth,
    }
    derived.push(record)
    computedByProposal.set(proposal.id, record)
  }

  return { derived, rejected, byProposal: computedByProposal }
}

/** A quoted operand, resolved to the figure the filing actually prints. */
function locateOperand(
  operand: DerivationOperand,
  byId: Map<string, EvidenceRef>,
  evidence: EvidenceRef[],
):
  | { source: EvidenceRef; quantity: ReturnType<typeof extractNumbers>[number]; decimal: Decimal }
  | { error: string } {
  const display = (operand.display ?? '').trim()
  const wanted = extractNumbers(display)[0]
  if (!wanted) return { error: `operand '${display}' contains no number` }
  const named = operand.evidenceId ? byId.get(operand.evidenceId) : undefined

  // The operand must be verbatim in a cited quote: this is what keeps a derived
  // number anchored to the filing rather than to the model's memory.
  //
  // Which quote is the model's guess, and it guesses wrong often enough to
  // matter — MB-012 lost two derivations because the buyback total and the average price were
  // paired with the wrong evidence id while sitting verbatim in another quote of
  // the same filing. So: try the named quote, then the rest of that document's
  // quotes. Never other documents when the model named one — a figure that
  // collides across filings (the same share count in two different companies'
  // announcements) must not be silently satisfied from the wrong issuer.
  const sameDocument = named
    ? evidence.filter((item) => item.documentId === named.documentId && item !== named)
    : evidence
  for (const candidate of named ? [named, ...sameDocument] : sameDocument) {
    const tokens = extractNumbers(candidate.quote)
    const hit =
      tokens.find((token) => matchesToken(token, wanted, candidate.declaredUnits ?? [])) ??
      // The model routinely writes an operand bare — `24,690,135.00` for the
      // filing's 「成交总金额为 24,690,135.00 元」. That is the same figure with its
      // unit left off, not a different quantity, and rejecting it loses a
      // calculation the sources fully support. Only a unit-less operand may do
      // this, and the source's unit is what the arithmetic then uses.
      (wanted.kind === 'scalar'
        ? tokens.find((token) => token.kind !== 'scalar' && token.numericRaw === wanted.value)
        : undefined)
    if (!hit) continue
    // Whose unit wins: normally the operand's, because `987.65 万元` under a
    // 「单位：人民币万元」 header asserts a quantity the bare table cell does not.
    // But when the operand came in bare and the quote supplies the unit, the
    // quote is the authority — that is the whole point of accepting it.
    const quantity = wanted.kind === 'scalar' && hit.kind !== 'scalar' ? hit : wanted
    const decimal = decimalOf(quantity.value)
    if (!decimal) return { error: `operand '${display}' is not numeric` }
    return { source: candidate, quantity, decimal }
  }
  return {
    error: named
      ? `operand '${display}' does not occur in any quote from evidence '${operand.evidenceId}'\u2019s document`
      : `operand '${display}' cites unknown evidence '${operand.evidenceId ?? ''}' and occurs in no cited quote`,
  }
}

/** Proposal ids that take part in a reference cycle. */
function findCycles(
  proposals: DerivationProposal[],
  dependencies: (proposal: DerivationProposal) => string[],
): Set<string> {
  const byId = new Map(proposals.map((proposal) => [proposal.id, proposal]))
  const state = new Map<string, 'visiting' | 'done'>()
  const cyclic = new Set<string>()

  const visit = (id: string, stack: string[]): void => {
    const current = state.get(id)
    if (current === 'done') return
    if (current === 'visiting') {
      // Everything from the first sighting of `id` onward is on the cycle.
      for (const member of stack.slice(stack.indexOf(id))) cyclic.add(member)
      return
    }
    const proposal = byId.get(id)
    if (!proposal) return
    state.set(id, 'visiting')
    for (const next of dependencies(proposal)) visit(next, [...stack, next])
    state.set(id, 'done')
  }

  for (const proposal of proposals) visit(proposal.id, [proposal.id])
  return cyclic
}

/** Dependencies first, so a chained operand is always already computed. */
function topologicalOrder(
  proposals: DerivationProposal[],
  dependencies: (proposal: DerivationProposal) => string[],
  skip: Set<string>,
): DerivationProposal[] {
  const byId = new Map(proposals.map((proposal) => [proposal.id, proposal]))
  const emitted = new Set<string>()
  const order: DerivationProposal[] = []

  const visit = (proposal: DerivationProposal): void => {
    if (emitted.has(proposal.id)) return
    emitted.add(proposal.id)
    if (!skip.has(proposal.id)) {
      for (const id of dependencies(proposal)) {
        const next = byId.get(id)
        if (next && !skip.has(id)) visit(next)
      }
    }
    order.push(proposal)
  }

  for (const proposal of proposals) visit(proposal)
  return order
}

/**
 * A quantity and the interval the filing's own rounding leaves it in.
 *
 * `3.62` states a value in [3.615, 3.625): half a unit in the last printed
 * place. That interval — not a relative error — is what propagates.
 */
interface Quantity {
  value: Decimal
  /** Half-width of the interval, in the same units as `value`. */
  half: Decimal
}

const ZERO: Decimal = { unscaled: 0n, scale: 0 }

/**
 * The interval a printed figure denotes.
 *
 * A printed `0.00` is not exact: it is [-0.005, 0.005]. Returning zero
 * uncertainty for it would let a derivation divide by something that might be
 * zero and report the result as certain.
 *
 * @param value - canonical decimal string.
 * @param raw - the figure as printed; its decimal places set the precision.
 * @param multiplier - unit multiplier folded into `value` (`万元` → 10000).
 * @returns the quantity with its half-width.
 */
function leafQuantity(value: string, raw: string, multiplier: string | undefined): Quantity {
  const parsed = decimalOf(value) ?? ZERO
  const printed = /\.(\d+)/.exec(raw.replace(/[\s,]/g, ''))
  const places = printed?.[1]?.length ?? 0
  const halfUlp: Decimal = { unscaled: 5n, scale: places + 1 }
  const scale = decimalOf(multiplier ?? '1') ?? { unscaled: 1n, scale: 0 }
  return { value: parsed, half: abs(multiply(halfUlp, scale)) }
}

/** Smallest and largest of a set of decimals. */
function extremes(candidates: Decimal[]): { low: Decimal; high: Decimal } {
  return candidates.reduce(
    (span, item) => ({
      low: compare(item, span.low) < 0 ? item : span.low,
      high: compare(item, span.high) > 0 ? item : span.high,
    }),
    { low: candidates[0] as Decimal, high: candidates[0] as Decimal },
  )
}

/** The interval a quantity occupies. */
function bounds(quantity: Quantity): [Decimal, Decimal] {
  return [subtract(quantity.value, quantity.half), add(quantity.value, quantity.half)]
}

/** Half-width around `value` that covers `[low, high]`. */
function coveringHalf(value: Decimal, low: Decimal, high: Decimal): Decimal {
  const below = abs(subtract(value, low))
  const above = abs(subtract(high, value))
  return compare(below, above) > 0 ? below : above
}

/**
 * Exact interval product. Endpoint enumeration, because a negative operand
 * flips which end is the maximum.
 */
function intervalProduct(left: Quantity, right: Quantity): Quantity {
  const [lowLeft, highLeft] = bounds(left)
  const [lowRight, highRight] = bounds(right)
  const corners = [
    multiply(lowLeft, lowRight),
    multiply(lowLeft, highRight),
    multiply(highLeft, lowRight),
    multiply(highLeft, highRight),
  ]
  const value = multiply(left.value, right.value)
  const span = extremes(corners)
  return { value, half: coveringHalf(value, span.low, span.high) }
}

/**
 * Exact interval quotient, or `undefined` when the divisor's interval spans zero.
 *
 * Adding relative errors — the textbook first-order rule — systematically
 * understates division. Two figures printed as `1` are each ±0.5, and 1÷1 is
 * genuinely anywhere in [0.33, 3]: a 200% half-width, not the 100% that adding
 * 50% + 50% suggests. The four-corner interval is the honest bound, and it is
 * what stops a memo from claiming precision its sources never had.
 */
function intervalQuotient(left: Quantity, right: Quantity): Quantity | undefined {
  const [lowRight, highRight] = bounds(right)
  // A divisor interval containing zero has no bounded quotient.
  if (compare(lowRight, ZERO) <= 0 && compare(highRight, ZERO) >= 0) return undefined
  const [lowLeft, highLeft] = bounds(left)
  const corners: Decimal[] = []
  for (const numerator of [lowLeft, highLeft]) {
    for (const denominator of [lowRight, highRight]) {
      const corner = divide(numerator, denominator, 12)
      if (corner) corners.push(corner)
    }
  }
  const value = divide(left.value, right.value, 10)
  if (!value || corners.length === 0) return undefined
  const span = extremes(corners)
  return { value, half: coveringHalf(value, span.low, span.high) }
}

/** Currencies that can carry a dimension. */
const CURRENCIES = new Set(['CNY', 'USD', 'HKD'])

/** Per-currency rendering of a unit price. */
const UNIT_PRICE_SUFFIX: Record<string, string> = { CNY: '元/股', USD: 'USD/share', HKD: '港元/股' }

/**
 * A minimal dimensional algebra: money^m · shares^s, with a currency tag.
 *
 * Small on purpose — it covers exactly what filings divide and multiply. Its job
 * is to make the illegal cases *loud*: 元 ÷ 元/股 is a share count, and before
 * this it fell through to the default branch and published as 「倍」. A result
 * with the wrong dimension is a wrong result even when the arithmetic is right.
 */
interface Dimension {
  money: number
  shares: number
  currency?: string
}

/** The dimension a unit denotes, or `undefined` if it is not arithmetic. */
function dimensionOf(unit: string): Dimension | undefined {
  if (CURRENCIES.has(unit)) return { money: 1, shares: 0, currency: unit }
  const price = /^([A-Z]{3})\/unit$/.exec(unit)
  if (price) return { money: 1, shares: -1, currency: price[1] as string }
  // A bare figure in a filing is a count (shares, units, documents). Dividing
  // two of them cancels, which is what makes `ratio` dimensionless.
  if (unit === 'scalar') return { money: 0, shares: 1 }
  if (unit === 'percent' || unit === 'ratio' || unit === 'multiple') return { money: 0, shares: 0 }
  return undefined
}

/** Combine dimensions under multiplication (`sign` 1) or division (`sign` -1). */
function combine(left: Dimension, right: Dimension, sign: 1 | -1): Dimension | undefined {
  if (left.currency && right.currency && left.currency !== right.currency) return undefined
  const currency = left.currency ?? right.currency
  const money = left.money + sign * right.money
  const shares = left.shares + sign * right.shares
  return { money, shares, ...(money !== 0 && currency ? { currency } : {}) }
}

/** The unit that renders a dimension, or `undefined` when nothing does. */
function unitOf(
  dimension: Dimension,
  op: DerivedNumber['op'],
  operandUnits: string[] = [],
): string | undefined {
  const { money, shares, currency } = dimension
  if (money === 0 && shares === 0) {
    // A share of a share is still a share: 30% × 50% is 15%, not 0.15 times.
    const proportions = operandUnits.every((unit) => unit === 'percent' || unit === 'ratio')
    return op === 'ratio' || (proportions && operandUnits.length > 0) ? 'ratio' : 'multiple'
  }
  if (money === 0 && shares === 1) return 'scalar'
  if (money === 1 && shares === 0 && currency) return currency
  if (money === 1 && shares === -1 && currency) return `${currency}/unit`
  return undefined
}

/** Describe a dimension for an audit message. */
function describe(dimension: Dimension): string {
  const parts: string[] = []
  if (dimension.money !== 0) parts.push(`${dimension.currency ?? 'money'}^${dimension.money}`)
  if (dimension.shares !== 0) parts.push(`count^${dimension.shares}`)
  return parts.join('·') || 'dimensionless'
}

/** Apply one operation, propagating both dimension and interval. */
function evaluate(
  op: DerivedNumber['op'],
  quantities: Quantity[],
  units: string[],
): { quantity: Quantity; unit: string } | { error: string } {
  const dimensions = units.map((unit) => dimensionOf(unit))
  const unknown = units.find((unit, index) => !dimensions[index])
  if (unknown) return { error: `operand unit '${unknown}' is not something to calculate with` }

  switch (op) {
    case 'sum':
    case 'difference': {
      if (!units.every((unit) => unit === units[0])) {
        return { error: `${op} needs operands in one unit, got ${units.join(', ')}` }
      }
      const quantity = quantities.reduce((total, item, index) =>
        index === 0
          ? item
          : {
              value: op === 'sum' ? add(total.value, item.value) : subtract(total.value, item.value),
              // Either way the uncertainties add: subtracting two rounded
              // figures is *less* certain than either, never more.
              half: add(total.half, item.half),
            },
      )
      return { quantity, unit: units[0] as string }
    }
    case 'product': {
      // Through asFactor from the start: a leading percentage is a factor too,
      // and seeding with the raw 30 makes the product a hundredfold too large.
      const first = asFactor(quantities[0] as Quantity, units[0] as string)
      let quantity = first.quantity
      let dimension = first.dimension
      for (let index = 1; index < quantities.length; index += 1) {
        const next = asFactor(quantities[index] as Quantity, units[index] as string)
        quantity = intervalProduct(quantity, next.quantity)
        const combined = combine(dimension, next.dimension, 1)
        if (!combined) return { error: `cannot multiply ${describe(dimension)} by ${describe(next.dimension)}` }
        dimension = combined
      }
      const unit = unitOf(dimension, op, units)
      return unit
        ? { quantity, unit }
        : { error: `product has no representable dimension (${describe(dimension)})` }
    }
    case 'ratio':
    case 'quotient': {
      if (quantities.length !== 2) return { error: `${op} takes exactly two operands` }
      const left = asFactor(quantities[0] as Quantity, units[0] as string)
      const right = asFactor(quantities[1] as Quantity, units[1] as string)
      const dimension = combine(left.dimension, right.dimension, -1)
      if (!dimension) return { error: `cannot divide ${describe(left.dimension)} by ${describe(right.dimension)}` }
      const unit = unitOf(dimension, op, units)
      if (!unit) {
        return { error: `quotient has no representable dimension (${describe(dimension)})` }
      }
      const quantity = intervalQuotient(left.quantity, right.quantity)
      if (!quantity) {
        return {
          error: `divisor interval spans zero at the precision it was printed; the quotient is unbounded`,
        }
      }
      return { quantity, unit }
    }
  }
}

/** A percentage is a dimensionless factor, not the number in front of the sign. */
function asFactor(quantity: Quantity, unit: string): { quantity: Quantity; dimension: Dimension } {
  const dimension = dimensionOf(unit) as Dimension
  if (unit !== 'percent') return { quantity, dimension }
  const hundred: Decimal = { unscaled: 100n, scale: 0 }
  const value = divide(quantity.value, hundred, 12) ?? ZERO
  const half = divide(quantity.half, hundred, 12) ?? ZERO
  return { quantity: { value, half }, dimension }
}

/** Render the computed result. Ratios become percentages; amounts keep their unit. */
function render(computed: { value: Decimal; unit: string }, precision: number): string {
  if (computed.unit === 'ratio') {
    return `${toFixed(multiply(computed.value, { unscaled: 100n, scale: 0 }), precision)}%`
  }
  if (computed.unit.endsWith('/unit')) {
    const currency = computed.unit.slice(0, -'/unit'.length)
    return `${toFixed(computed.value, precision)} ${UNIT_PRICE_SUFFIX[currency] ?? currency}`
  }
  if (computed.unit === 'multiple') return `${toFixed(computed.value, precision)}倍`
  if (computed.unit === 'percent') return `${toFixed(computed.value, precision)}%`
  return toFixed(computed.value, precision)
}

/** Human-readable operator for the recorded formula. */
function operatorSymbol(op: DerivedNumber['op']): string {
  switch (op) {
    case 'sum':
      return ' + '
    case 'difference':
      return ' - '
    case 'product':
      return ' × '
    default:
      return ' / '
  }
}

/** Parse a canonical decimal string. */
function decimalOf(value: string): Decimal | undefined {
  const negative = value.startsWith('-')
  const body = negative ? value.slice(1) : value
  if (!/^\d+(?:\.\d+)?$/.test(body)) return undefined
  const [integer, fraction = ''] = body.split('.')
  return {
    unscaled: BigInt(`${integer}${fraction}`) * (negative ? -1n : 1n),
    scale: fraction.length,
  }
}

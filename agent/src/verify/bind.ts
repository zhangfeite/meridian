/**
 * Bind every number in a claim to the thing that justifies it.
 *
 * This is the mechanical form of "每句可溯源": a published sentence's numbers
 * are each either inside one of that sentence's own quotes, or the output of a
 * derivation the pipeline computed. A number that is neither is unbound, and an
 * unbound number deletes its sentence.
 *
 * @module @meridian/agent/verify/bind
 */

import type { DerivedNumber, EvidenceRef, NumberRef } from '../contract.ts'
import { extractNumbers, matchesToken, type NumberToken } from './numbers.ts'

/** Result of binding one claim's numbers. */
export interface BindResult {
  numbers: NumberRef[]
  /** Numbers with no justification. A non-empty list means: drop the claim. */
  unbound: NumberToken[]
  /** Bare years with no source occurrence: recorded, not fatal. */
  weak: NumberToken[]
}

/**
 * @param text - the claim's rendered text.
 * @param evidence - the evidence this claim cites (its own, not the whole memo).
 * @param derived - derivations available to this claim.
 * @returns bound number references plus anything left unjustified.
 */
export function bindNumbers(
  text: string,
  evidence: EvidenceRef[],
  derived: DerivedNumber[] = [],
): BindResult {
  const tokens = extractNumbers(text)
  const evidenceTokens = evidence.map((item) => ({ item, tokens: extractNumbers(item.quote) }))
  const derivedTokens = derived.map((item) => ({ item, tokens: extractNumbers(item.display) }))

  const numbers: NumberRef[] = []
  const unbound: NumberToken[] = []
  const weak: NumberToken[] = []

  for (const token of tokens) {
    const derivedHit = derivedTokens.find((entry) =>
      entry.tokens.some((candidate) => matchesToken(candidate, token)?.basis === 'verbatim'),
    )
    if (derivedHit) {
      numbers.push({ display: token.raw, provenance: 'derived', derivedId: derivedHit.item.id })
      continue
    }

    let bound: NumberRef | undefined
    for (const entry of evidenceTokens) {
      for (const candidate of entry.tokens) {
        const match = matchesToken(candidate, token, entry.item.declaredUnits ?? [])
        if (!match) continue
        bound = {
          display: token.raw,
          provenance: 'verbatim',
          evidenceId: entry.item.id,
          ...(match.basis === 'declared_unit' ? { unitFrom: match.hint.source } : {}),
        }
        break
      }
      if (bound) break
    }
    if (bound) {
      numbers.push(bound)
      continue
    }

    const asYear = Number(token.value)
    if (token.kind === 'scalar' && Number.isInteger(asYear) && asYear >= 1900 && asYear <= 2100) {
      weak.push(token)
      continue
    }
    unbound.push(token)
  }

  return { numbers, unbound, weak }
}

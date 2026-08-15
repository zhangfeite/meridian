/**
 * Step 5 of 7 — metric calculation.
 *
 * The model proposes an operation over operands it can point at; the pipeline
 * does the arithmetic in exact decimal and renders the figure. The model writes
 * `{{D1}}` where the result goes and never sees its own answer — which is the
 * only reliable way to stop a language model from reporting a percentage it
 * "remembers" instead of the one the filing implies.
 *
 * @module @meridian/agent/steps/metrics
 */

import type { Claim, DerivedNumber, EvidenceRef, MeridianLang } from '../contract.ts'
import { parseJsonReply, type ModelClient } from '../model.ts'
import { metricsPrompt } from '../prompts.ts'
import type { Intent, RejectedClaim } from '../types.ts'
import { bindNumbers } from '../verify/bind.ts'
import { scanCompliance } from '../verify/compliance.ts'
import type { Skill } from '../skills/types.ts'
import { computeDerivations, type DerivationOperand, type DerivationProposal } from '../verify/derive.ts'

interface MetricsReply {
  derivations?: {
    id?: string
    label?: string
    op?: string
    precision?: number
    operands?: { display?: string; evidence_id?: string; derived_id?: string }[]
  }[]
  claims?: {
    question_id?: string
    text?: string
    derivation_ids?: string[]
    evidence_ids?: string[]
  }[]
}

const OPS: DerivedNumber['op'][] = ['ratio', 'sum', 'difference', 'product', 'quotient']

/** Step 5 output. */
export interface MetricsResult {
  derived: DerivedNumber[]
  claims: Claim[]
  rejected: RejectedClaim[]
  derivationRejections: { proposalId: string; reason: string }[]
}

/**
 * @param intent - step 1 output.
 * @param evidence - verified evidence from step 4; the only legal operand source.
 * @param model - the BYO model client.
 * @param lang - output language contract.
 * @param nextClaimId - id allocator shared with the other steps.
 * @returns computed derivations and the claims that report them.
 */
export async function computeMetrics(
  intent: Intent,
  evidence: EvidenceRef[],
  model: ModelClient,
  lang: MeridianLang,
  nextClaimId: () => string,
  skill?: Skill,
): Promise<MetricsResult> {
  const empty: MetricsResult = { derived: [], claims: [], rejected: [], derivationRejections: [] }
  if (evidence.length === 0) return empty

  const prompt = metricsPrompt(
    intent,
    evidence.map((item) => ({ id: item.id, quote: item.quote })),
    lang,
    skill?.required_derivations ?? [],
  )
  const reply = await model.complete({ system: prompt.system, user: prompt.user, json: true })
  let parsed: MetricsReply
  try {
    parsed = parseJsonReply<MetricsReply>(reply.text)
  } catch {
    return empty
  }

  const proposals: DerivationProposal[] = (parsed.derivations ?? [])
    .filter((item) => item.id && OPS.includes(item.op as DerivedNumber['op']))
    .map((item) => ({
      id: item.id as string,
      label: (item.label ?? '').trim(),
      op: item.op as DerivedNumber['op'],
      operands: (item.operands ?? [])
        .map((operand): DerivationOperand | undefined => {
          // A chained operand names another derivation. The model writes it
          // either as an explicit field or, as MB-012's did unprompted, as a
          // `{{D1}}` placeholder in the display slot — accept both.
          const chained =
            operand.derived_id ?? /^\{\{(\w+)\}\}$/.exec((operand.display ?? '').trim())?.[1]
          if (chained) return { derivedId: chained }
          return operand.display && operand.evidence_id
            ? { display: operand.display, evidenceId: operand.evidence_id }
            : undefined
        })
        .filter((operand): operand is DerivationOperand => Boolean(operand)),
      ...(typeof item.precision === 'number' && item.precision >= 0 && item.precision <= 4
        ? { precision: Math.trunc(item.precision) }
        : {}),
    }))

  const {
    derived,
    rejected: derivationRejections,
    byProposal: derivedById,
  } = computeDerivations(proposals, evidence)
  const evidenceById = new Map(evidence.map((item) => [item.id, item]))

  const claims: Claim[] = []
  const rejected: RejectedClaim[] = []

  for (const proposed of parsed.claims ?? []) {
    const rawText = (proposed.text ?? '').trim()
    if (!rawText) continue
    const questionId = (proposed.question_id ?? 'Q1').trim() || 'Q1'
    const placeholders = [...rawText.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1])
    const usedIds = (proposed.derivation_ids ?? placeholders).filter((id) => derivedById.has(id) || placeholders.includes(id))
    // A "claim" that reports no computed figure is the model restating a fact
    // the extraction step already published. Ignore it rather than audit it —
    // it was never a candidate for the memo.
    if (usedIds.length === 0) continue
    const used = usedIds.map((id) => derivedById.get(id)).filter((item): item is DerivedNumber => Boolean(item))

    if (used.length !== usedIds.length) {
      rejected.push({
        text: rawText,
        reason: 'claim references a derivation that failed validation',
        questionId,
      })
      continue
    }

    // Substitute the pipeline's own rendering into the model's sentence. The
    // placeholder carries the model's id (`{{D1}}`); the derivation carries the
    // pipeline's (`D-A`). Substituting on the latter silently leaves every
    // placeholder unresolved and drops the claim.
    let text = rawText
    for (const id of usedIds) {
      const derivation = derivedById.get(id)
      if (derivation) text = substitute(text, id, derivation.display)
    }
    if (/\{\{\w+\}\}/.test(text)) {
      rejected.push({ text: rawText, reason: 'unresolved derivation placeholder', questionId })
      continue
    }

    // A chained claim rests on every quote in its chain, not only on the last
    // link's operands — the reader checking 1.99× must be able to reach the
    // 24,690,135.00 元 that produced the per-share average underneath it.
    const chainEvidence = (derivation: DerivedNumber, seen = new Set<string>()): string[] => {
      if (seen.has(derivation.id)) return []
      seen.add(derivation.id)
      return derivation.inputs.flatMap((input) => {
        if (input.evidenceId) return [input.evidenceId]
        const upstream = derived.find((item) => item.id === input.derivedId)
        return upstream ? chainEvidence(upstream, seen) : []
      })
    }
    const claimEvidence = [
      ...new Set([
        ...used.flatMap((derivation) => chainEvidence(derivation)),
        ...(proposed.evidence_ids ?? []),
      ]),
    ]
      .map((id) => evidenceById.get(id))
      .filter((item): item is EvidenceRef => Boolean(item))

    if (claimEvidence.length === 0) {
      rejected.push({ text, reason: 'derived claim cites no evidence', questionId })
      continue
    }

    const bound = bindNumbers(text, claimEvidence, used)
    if (bound.unbound.length > 0) {
      rejected.push({
        text,
        reason: `these numbers are neither quoted nor derived: ${bound.unbound.map((token) => token.raw).join(', ')}`,
        questionId,
      })
      continue
    }

    const compliance = scanCompliance(text, lang, skill?.forbidden_reinforce ?? [])
    if (!compliance.passed) {
      rejected.push({ text, reason: `compliance rule '${compliance.hits[0]?.rule}' fired`, questionId })
      continue
    }

    claims.push({
      id: nextClaimId(),
      type: 'fact',
      text,
      questionId,
      evidenceIds: claimEvidence.map((item) => item.id),
      numbers: bound.numbers,
    })
  }

  return { derived, claims, rejected, derivationRejections }
}

/** Trailing unit of a rendered figure: `1.82 元/股` → `元/股`, `0.35%` → none. */
const UNIT_SUFFIX = /[^\d\s.,%]+$/

/**
 * Substitute a derivation's rendering for its placeholder.
 *
 * The rendering carries its own unit (`1.82 元/股`), and a model writing
 * `回购均价为{{D1}} 元/股` is writing normal prose — so a plain replacement
 * publishes `1.82 元/股 元/股`. Any unit immediately following the placeholder
 * that repeats the rendering's own is absorbed; anything else is left alone.
 *
 * @param text - the claim sentence, with placeholders.
 * @param id - the model's placeholder id.
 * @param display - the pipeline's rendering of that derivation.
 * @returns the sentence with the placeholder resolved.
 */
function substitute(text: string, id: string, display: string): string {
  const suffix = UNIT_SUFFIX.exec(display.trim())?.[0]
  const placeholder = `\\{\\{${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}\\}`
  if (!suffix) return text.replaceAll(`{{${id}}}`, display)
  const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(`${placeholder}[ \u3000]*(?:${escaped})?`, 'g'), display)
}

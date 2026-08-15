/**
 * Step 6 of 7 — counter-evidence retrieval.
 *
 * This step exists to serve one field: `ModelInferenceClaim.counterEvidence`.
 * PRD §4.3 makes the rule absolute — an inference whose counter-evidence slot
 * cannot be filled is downgraded to a fact or deleted. It never publishes.
 *
 * That is the single most load-bearing line in the product. An agent that only
 * ever argues one side is the failure mode every financial LLM demo has; making
 * the counter-search a *precondition of publication* is how you get out of it.
 *
 * Downgrade is deliberately narrow: the model must supply a strictly factual
 * restatement, and that restatement is re-verified from scratch (quotes located,
 * numbers bound). "Soften the wording and keep the number" does not pass.
 *
 * @module @meridian/agent/steps/counter
 */

import type { AuditRecord, Claim, EvidenceRef, MeridianLang, ModelInferenceClaim } from '../contract.ts'
import type { EvidencePool } from '../evidence-pool.ts'
import { parseJsonReply, type ModelClient } from '../model.ts'
import { counterEvidencePrompt } from '../prompts.ts'
import type { SourceDocument } from '../source/types.ts'
import { bindNumbers } from '../verify/bind.ts'
import { scanCompliance } from '../verify/compliance.ts'
import { boundDocuments } from '../verify/window.ts'
import { locateQuote } from '../verify/evidence.ts'
import { detectUnitHints } from '../verify/numbers.ts'

interface CounterReply {
  results?: {
    claim_id?: string
    counter_quotes?: { document_id?: string; quote?: string }[]
    note?: string
    fallback_fact?: string | null
  }[]
}

/** Step 6 output. */
export interface CounterEvidenceResult {
  claims: Claim[]
  audit: AuditRecord[]
  stats: { inferences: number; filled: number; downgraded: number; dropped: number }
}

/**
 * Fill, downgrade, or delete every inference.
 *
 * @param claims - all claims from steps 4 and 5.
 * @param documents - the retrieved sources to search.
 * @param model - the BYO model client.
 * @param lang - output language contract.
 * @param pool - evidence id allocator shared with step 4.
 * @returns claims with every surviving inference carrying counter-evidence.
 */
export async function findCounterEvidence(
  claims: Claim[],
  documents: SourceDocument[],
  model: ModelClient,
  lang: MeridianLang,
  pool: EvidencePool,
): Promise<CounterEvidenceResult> {
  const inferences = claims.filter((claim): claim is ModelInferenceClaim => claim.type === 'model_inference')
  const stats = { inferences: inferences.length, filled: 0, downgraded: 0, dropped: 0 }
  if (inferences.length === 0) return { claims, audit: [], stats }

  const prompt = counterEvidencePrompt(
    inferences.map((claim) => ({ id: claim.id, text: claim.text, assumptions: claim.assumptions })),
    // Bounded: this step hunts for the passage that weakens an inference, and a
    // prospectus does not fit in a prompt. The windows are chosen by what the
    // inferences are about; quotes are still located against the whole file.
    boundDocuments(documents, inferences.map((claim) => claim.text)),
    lang,
  )
  const reply = await model.complete({ system: prompt.system, user: prompt.user, json: true })
  let parsed: CounterReply
  try {
    parsed = parseJsonReply<CounterReply>(reply.text)
  } catch {
    parsed = {}
  }

  const byClaimId = new Map((parsed.results ?? []).map((item) => [item.claim_id ?? '', item]))
  const hintsById = new Map(documents.map((document) => [document.id, detectUnitHints(document.text)]))
  const retrievedAt = new Date().toISOString()
  const audit: AuditRecord[] = []
  const output: Claim[] = []

  for (const claim of claims) {
    if (claim.type !== 'model_inference') {
      output.push(claim)
      continue
    }
    const result = byClaimId.get(claim.id)
    const located: EvidenceRef[] = []
    for (const cited of result?.counter_quotes ?? []) {
      const quote = (cited.quote ?? '').trim()
      if (!quote) continue
      const named = cited.document_id ? documents.find((item) => item.id === cited.document_id) : undefined
      const candidates = named ? [named, ...documents.filter((item) => item !== named)] : documents
      for (const document of candidates) {
        const at = locateQuote(document.text, quote)
        if (!at) continue
        const declaredUnits = hintsById.get(document.id) ?? []
        located.push(
          pool.intern({
            documentId: document.id,
            sourceLabel: document.title,
            quote: at.quote,
            charStart: at.charStart,
            charEnd: at.charEnd,
            retrievedAt,
            ...(declaredUnits.length > 0 ? { declaredUnits } : {}),
          }),
        )
        break
      }
    }

    if (located.length > 0) {
      stats.filled += 1
      output.push({
        ...claim,
        counterEvidence: {
          status: 'filled',
          evidenceIds: located.map((item) => item.id),
          note: (result?.note ?? '').trim(),
        },
      })
      continue
    }

    const fallback = (result?.fallback_fact ?? '').trim()
    const claimEvidence = pool.items.filter((item) => claim.evidenceIds.includes(item.id))
    if (fallback) {
      const bound = bindNumbers(fallback, claimEvidence)
      const compliance = scanCompliance(fallback, lang)
      if (bound.unbound.length === 0 && compliance.passed && claimEvidence.length > 0) {
        stats.downgraded += 1
        audit.push({
          step: 'counter_evidence',
          action: 'claim_downgraded_no_counter_evidence',
          claimId: claim.id,
          detail: `no counter-evidence found; downgraded to a verified fact: ${fallback}`,
        })
        output.push({
          id: claim.id,
          type: 'fact',
          text: fallback,
          questionId: claim.questionId,
          evidenceIds: claim.evidenceIds,
          numbers: bound.numbers,
        })
        continue
      }
    }

    stats.dropped += 1
    audit.push({
      step: 'counter_evidence',
      action: 'claim_dropped_no_counter_evidence',
      claimId: claim.id,
      detail: `no counter-evidence and no verifiable factual fallback; deleted: ${claim.text}`,
    })
  }

  return { claims: output, audit, stats }
}

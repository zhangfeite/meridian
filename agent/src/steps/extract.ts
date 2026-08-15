/**
 * Step 4 of 7 — extraction and verification.
 *
 * The model proposes claims; this step decides which of them are allowed to
 * exist. Three machine checks, applied to every claim without exception:
 *
 * 1. **Quote location.** Each cited passage must be findable in the retrieved
 *    document. The located span replaces the model's retyping, so a published
 *    citation is the document's own characters.
 * 2. **Number binding.** Every number in the claim's text must occur in one of
 *    that claim's own quotes. Not "in the filing somewhere" — in the quote the
 *    sentence itself carries.
 * 3. **Type obligations.** `model_inference` without a time range, assumption,
 *    or confidence is not a weaker inference, it is an unfinished one.
 *
 * Rejected claims get exactly one repair round. Bounded on purpose: an
 * unbounded repair loop is a machine for talking a model into a lie.
 *
 * @module @meridian/agent/steps/extract
 */

import type {
  Claim,
  Confidence,
  EvidenceRef,
  MeridianLang,
  ModelInferenceClaim,
} from '../contract.ts'
import { EvidencePool } from '../evidence-pool.ts'
import { idAllocator } from '../ids.ts'
import { parseJsonReply, type ModelClient } from '../model.ts'
import { extractionPrompt, gapChallengePrompt, repairPrompt } from '../prompts.ts'
import type { SourceDocument } from '../source/types.ts'
import type { ExtractionResult, Intent, RejectedClaim } from '../types.ts'
import { bindNumbers } from '../verify/bind.ts'
import { scanCompliance } from '../verify/compliance.ts'
import { locateQuote } from '../verify/evidence.ts'
import type { Skill } from '../skills/types.ts'
import { detectUnitHints } from '../verify/numbers.ts'
import { candidatePassages } from '../verify/text.ts'

interface RawClaim {
  question_id?: string
  type?: string
  text?: string
  quotes?: { document_id?: string; quote?: string }[]
  attribution?: string
  time_range?: string
  assumptions?: string[]
  confidence?: string
  triggers?: string[]
}

interface GapReviewReply {
  answers?: {
    question_id?: string
    verdict?: string
    claims?: RawClaim[]
    reason?: string
  }[]
}

interface ExtractionReply {
  claims?: RawClaim[]
  gaps?: { question_id?: string; reason?: string }[]
}

const CONFIDENCES: Confidence[] = ['low', 'medium', 'high']

/**
 * Run extraction, verification, and one repair round.
 *
 * @param intent - step 1 output.
 * @param documents - documents retrieved in step 3.
 * @param model - the BYO model client.
 * @param lang - output language contract.
 * @param pool - evidence id allocator, shared with step 6.
 * @param nextClaimId - claim id allocator, shared with step 5.
 * @returns verified claims, the evidence they cite, rejects, and stated gaps.
 */
export async function extractAndVerify(
  intent: Intent,
  documents: SourceDocument[],
  model: ModelClient,
  lang: MeridianLang,
  pool: EvidencePool = new EvidencePool(),
  nextClaimId: () => string = defaultClaimIds(),
  skill?: Skill,
): Promise<ExtractionResult> {
  const retrievedAt = new Date().toISOString()
  const claims: Claim[] = []
  const gaps: { questionId: string; reason: string }[] = []

  const first = extractionPrompt(intent, documents, lang, skill)
  const firstReply = await model.complete({ system: first.system, user: first.user, json: true })
  const parsed = parseJsonReply<ExtractionReply>(firstReply.text)

  const forbidden = skill?.forbidden_reinforce ?? []
  const round = verifyBatch(parsed.claims ?? [], documents, pool, retrievedAt, lang, nextClaimId, forbidden)
  claims.push(...round.accepted)
  collectGaps(parsed.gaps, gaps)

  const rejected: RejectedClaim[] = round.rejected.map((item) => ({ ...item, round: 'initial' as const }))
  if (round.rejected.length > 0) {
    // The dominant rejection is a retyped quote, not a wrong fact. Hand the
    // model the passages that actually discuss the claim so the repair round
    // can requote instead of surrender — this is what keeps completeness from
    // paying for the verifier's strictness.
    // Candidates carry their document id: in a multi-document run the same
    // sentence pattern occurs in both filings, and a repaired claim that names
    // the wrong one is a citation error the memo would publish as fact.
    const withCandidates = round.rejected.map((item) => ({
      ...item,
      candidates: candidatePassages(documents, item.text).map((candidate) => ({
        documentId: candidate.documentId,
        text: candidate.text,
      })),
    }))
    const repair = repairPrompt(withCandidates, documents, lang)
    const repairReply = await model.complete({ system: repair.system, user: repair.user, json: true })
    let repaired: ExtractionReply = {}
    try {
      repaired = parseJsonReply<ExtractionReply>(repairReply.text)
    } catch {
      repaired = {}
    }
    const second = verifyBatch(repaired.claims ?? [], documents, pool, retrievedAt, lang, nextClaimId, forbidden)
    // Only keep repairs that say something new: a repaired claim whose text
    // duplicates an accepted one adds noise, not coverage.
    for (const claim of second.accepted) {
      if (!claims.some((existing) => existing.text.trim() === claim.text.trim())) claims.push(claim)
    }
    collectGaps(repaired.gaps, gaps)
    rejected.push(...second.rejected.map((item) => ({ ...item, round: 'repair' as const })))
  }

  // Every claim has been verified against the sources; no gap has. That
  // asymmetry has exactly one failure mode and it is the expensive one — a
  // question the filing does answer, published as "无法核实". Challenge each
  // unanswered sub-question against the passages that best match it before the
  // gap is allowed to stand.
  const unanswered = intent.subQuestions.filter(
    (question) => !claims.some((claim) => claim.questionId === question.id),
  )
  const closed: string[] = []
  if (unanswered.length > 0 && documents.length > 0) {
    const challenge = gapChallengePrompt(
      unanswered.map((question) => ({
        questionId: question.id,
        question: question.text,
        reason: gaps.find((gap) => gap.questionId === question.id)?.reason ?? '',
        candidates: candidatePassages(documents, question.text, 5, {
          // A question asking "how much" is answered by a passage with a figure
          // in it; plain word overlap ranks the boilerplate that repeats the
          // question's nouns above the sentence that actually answers it.
          preferNumbers: /多少|金额|数量|比例|上限|规模|价格|股数|how much|how many|amount|price/.test(
            question.text,
          ),
        }).map((candidate) => ({ documentId: candidate.documentId, text: candidate.text })),
      })),
      documents,
      lang,
    )
    const reply = await model.complete({ system: challenge.system, user: challenge.user, json: true })
    let reviewed: GapReviewReply = {}
    try {
      reviewed = parseJsonReply<GapReviewReply>(reply.text)
    } catch {
      reviewed = {}
    }
    for (const answer of reviewed.answers ?? []) {
      const questionId = (answer.question_id ?? '').trim()
      if (!unanswered.some((question) => question.id === questionId)) continue
      if (answer.verdict !== 'answered') {
        // The gap survives review. Keep the reviewer's reason if the extraction
        // step never gave one.
        const reason = (answer.reason ?? '').trim()
        if (reason && !gaps.some((gap) => gap.questionId === questionId)) {
          gaps.push({ questionId, reason })
        }
        continue
      }
      // Verified exactly like any other claim — the challenge relaxes nothing.
      const rescued = verifyBatch(
        (answer.claims ?? []).map((claim) => ({ ...claim, question_id: questionId })),
        documents,
        pool,
        retrievedAt,
        lang,
        nextClaimId,
        forbidden,
      )
      for (const claim of rescued.accepted) {
        if (!claims.some((existing) => existing.text.trim() === claim.text.trim())) claims.push(claim)
      }
      rejected.push(...rescued.rejected.map((item) => ({ ...item, round: 'repair' as const })))
      if (rescued.accepted.length > 0) closed.push(questionId)
    }
  }
  // A question that got an answer is no longer a gap, whatever the first pass said.
  const answered = new Set(claims.map((claim) => claim.questionId))
  const survivingGaps = gaps.filter((gap) => !answered.has(gap.questionId))

  return { claims, evidence: pool.items, rejected, gaps: survivingGaps, gapsClosed: closed }
}

/** Standalone `C-A`, `C-B`, … allocator for callers that run this step alone. */
export function defaultClaimIds(): () => string {
  return idAllocator('C')
}

function collectGaps(
  raw: { question_id?: string; reason?: string }[] | undefined,
  sink: { questionId: string; reason: string }[],
): void {
  for (const gap of raw ?? []) {
    const questionId = (gap.question_id ?? '').trim()
    if (!questionId) continue
    if (sink.some((item) => item.questionId === questionId)) continue
    sink.push({ questionId, reason: (gap.reason ?? '').trim() })
  }
}

/** Verify one batch of raw claims. Pure apart from the id allocators. */
function verifyBatch(
  raw: RawClaim[],
  documents: SourceDocument[],
  pool: EvidencePool,
  retrievedAt: string,
  lang: MeridianLang,
  nextClaimId: () => string,
  forbidden: string[] = [],
): { accepted: Claim[]; rejected: RejectedClaim[] } {
  const accepted: Claim[] = []
  const rejected: RejectedClaim[] = []
  const byId = new Map(documents.map((document) => [document.id, document]))
  const hintsById = new Map(documents.map((document) => [document.id, detectUnitHints(document.text)]))

  for (const item of raw) {
    const text = (item.text ?? '').trim()
    const questionId = (item.question_id ?? 'Q1').trim() || 'Q1'
    if (!text) continue

    const evidence: EvidenceRef[] = []
    let failure: string | undefined

    for (const cited of item.quotes ?? []) {
      const quote = (cited.quote ?? '').trim()
      if (!quote) continue
      const named = cited.document_id ? byId.get(cited.document_id) : undefined
      const candidates = named ? [named, ...documents.filter((doc) => doc !== named)] : documents
      let located: { document: SourceDocument; at: ReturnType<typeof locateQuote> } | undefined
      for (const document of candidates) {
        const at = locateQuote(document.text, quote)
        if (at) {
          located = { document, at }
          break
        }
      }
      if (!located?.at) {
        failure = `quote is not present in any retrieved document: 「${quote.slice(0, 40)}」`
        break
      }
      const declaredUnits = hintsById.get(located.document.id) ?? []
      evidence.push(
        pool.intern({
          documentId: located.document.id,
          sourceLabel: located.document.title,
          quote: located.at.quote,
          charStart: located.at.charStart,
          charEnd: located.at.charEnd,
          retrievedAt,
          ...(declaredUnits.length > 0 ? { declaredUnits } : {}),
        }),
      )
    }

    if (failure) {
      rejected.push({ text, reason: failure, questionId })
      continue
    }
    if (evidence.length === 0) {
      rejected.push({ text, reason: 'claim carries no usable quote', questionId })
      continue
    }

    const bound = bindNumbers(text, evidence)
    if (bound.unbound.length > 0) {
      rejected.push({
        text,
        reason: `these numbers do not appear in the cited quotes: ${bound.unbound
          .map((token) => token.raw)
          .join(', ')}`,
        questionId,
      })
      continue
    }

    const compliance = scanCompliance(text, lang, forbidden)
    if (!compliance.passed) {
      rejected.push({
        text,
        reason: `compliance rule '${compliance.hits[0]?.rule}' fired on 「${compliance.hits[0]?.match}」`,
        questionId,
      })
      continue
    }

    const evidenceIds = evidence.map((entry) => entry.id)
    const base = { id: nextClaimId(), text, questionId, evidenceIds, numbers: bound.numbers }

    switch (item.type) {
      case 'attributed_opinion': {
        const attribution = (item.attribution ?? '').trim()
        if (!attribution) {
          rejected.push({ text, reason: 'attributed_opinion has no named speaker', questionId })
          continue
        }
        accepted.push({ ...base, type: 'attributed_opinion', attribution })
        break
      }
      case 'model_inference': {
        const timeRange = (item.time_range ?? '').trim()
        const assumptions = (item.assumptions ?? []).map((entry) => entry.trim()).filter(Boolean)
        const confidence = CONFIDENCES.includes(item.confidence as Confidence)
          ? (item.confidence as Confidence)
          : undefined
        if (!timeRange || assumptions.length === 0 || !confidence) {
          rejected.push({
            text,
            reason: 'model_inference needs a time range, at least one assumption, and a confidence level',
            questionId,
          })
          continue
        }
        const inference: ModelInferenceClaim = {
          ...base,
          type: 'model_inference',
          timeRange,
          assumptions,
          confidence,
          counterEvidence: { status: 'pending', evidenceIds: [], note: '' },
        }
        accepted.push(inference)
        break
      }
      case 'scenario': {
        const triggers = (item.triggers ?? []).map((entry) => entry.trim()).filter(Boolean)
        if (triggers.length === 0) {
          rejected.push({ text, reason: 'scenario has no observable trigger', questionId })
          continue
        }
        accepted.push({ ...base, type: 'scenario', triggers })
        break
      }
      default:
        accepted.push({ ...base, type: 'fact' })
    }
  }

  return { accepted, rejected }
}

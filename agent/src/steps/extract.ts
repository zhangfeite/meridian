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
 * A document too long for one prompt is read in windows, in order, one call per
 * window. Two failures made that necessary and both were silent-looking until
 * they were not: a truncated reply took the whole task down as "model reply was
 * not JSON", and a truncated *document* had the model report page eighty's
 * figures as undisclosed. Nothing here may end a run — a call that cannot be
 * parsed even after salvage costs that window, is disclosed as a partial read,
 * and the rest of the document still gets extracted.
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
import { readJsonReply, type ModelClient } from '../model.ts'
import {
  extractionPrompt,
  gapChallengePrompt,
  repairPrompt,
  residualReviewPrompt,
  targetedExtractionPrompt,
} from '../prompts.ts'
import type { SourceDocument } from '../source/types.ts'
import type { ExtractionResult, Intent, RejectedClaim } from '../types.ts'
import { bindNumbers } from '../verify/bind.ts'
import { scanCompliance } from '../verify/compliance.ts'
import { locateQuote } from '../verify/evidence.ts'
import type { Skill } from '../skills/types.ts'
import { detectUnitHints, extractNumbers } from '../verify/numbers.ts'
import { foldScript } from '../verify/script.ts'
import { askedKinds, figureCandidates, statesKind, type AskedKind } from '../verify/asked.ts'
import { chooseQuoteSpan } from '../verify/span.ts'
import { candidatePassages, splitPassages } from '../verify/text.ts'
import { asWindowView, boundDocuments, selectWindows, windowDocument } from '../verify/window.ts'

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

interface ResidualReviewReply {
  results?: { question_id?: string; verdict?: string; missing?: string }[]
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

/** One citation the span selector moved, kept so the choice can be replayed. */
interface SpanDecision {
  text: string
  documentId: string
  from: string
  to: string
  path: string
}

/**
 * Output budget for one *windowed* extraction call.
 *
 * Applied only when a document is being read in several passes: each pass then
 * has a bounded amount to say, and the thoroughness comes from there being more
 * passes. A single-pass read is left on the backend's own default — capping it
 * would cost claims on ordinary filings to solve a problem they do not have,
 * which is what a first cut of this change did to MB-011.
 */
const EXTRACTION_OUTPUT_TOKENS = 8_000

/** How many windows of one document extraction will read before it stops. */
const MAX_WINDOWS = 8

/** One model call that must not be able to end the run. */
async function askForJson<T>(
  model: ModelClient,
  prompt: { system: string; user: string },
  label: string,
  notes: string[],
  maxOutputTokens?: number,
): Promise<T | undefined> {
  let reply
  try {
    reply = await model.complete({
      system: prompt.system,
      user: prompt.user,
      json: true,
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    })
  } catch (error) {
    notes.push(`${label}: 模型调用失败,该部分未抽取(${error instanceof Error ? error.message : String(error)})`)
    return undefined
  }
  const outcome = readJsonReply<T>(reply.text)
  if (outcome.value === undefined) {
    notes.push(`${label}: 模型回复无法解析为 JSON,该部分未抽取`)
    return undefined
  }
  if (outcome.salvaged) {
    // Kept, but never quietly: the tail of this reply was cut off, so whatever
    // it was still going to say about this window is missing from the memo.
    notes.push(`${label}: 模型回复被截断,已保留其中完整的部分,该段抽取不完整`)
  }
  return outcome.value
}

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
  const notes: string[] = []
  const spans: SpanDecision[] = []
  const forbidden = skill?.forbidden_reinforce ?? []
  const focus = intent.subQuestions.map((question) => question.text)

  // One call per reading pass. A short filing is one pass over everything; a
  // prospectus is one pass per window, in document order, so a figure on page
  // eighty is read by *some* call. Verification always runs against the whole
  // document, so a quote copied out of a window still has to be in the filing.
  const passes = readingPasses(documents, notes, focus)
  const rejected: RejectedClaim[] = []
  for (const pass of passes) {
    const prompt = extractionPrompt(intent, pass, lang, skill)
    const parsed = await askForJson<ExtractionReply>(
      model,
      prompt,
      passLabel(pass),
      notes,
      passes.length > 1 ? EXTRACTION_OUTPUT_TOKENS : undefined,
    )
    if (!parsed) continue
    const round = verifyBatch(parsed.claims ?? [], documents, pool, retrievedAt, lang, nextClaimId, forbidden, spans)
    for (const claim of round.accepted) {
      if (!claims.some((existing) => existing.text.trim() === claim.text.trim())) claims.push(claim)
    }
    // A gap is a statement about the whole filing, and one window cannot make
    // it. Gaps from a windowed read are dropped here and re-derived below from
    // what every pass together did or did not answer.
    if (passes.length === 1) collectGaps(parsed.gaps, gaps)
    rejected.push(...round.rejected.map((item) => ({ ...item, round: 'initial' as const })))
  }
  if (passes.length > 1) {
    for (const question of intent.subQuestions) {
      if (claims.some((claim) => claim.questionId === question.id)) continue
      collectGaps([{ question_id: question.id, reason: '分段通读全文后仍未找到相应披露' }], gaps)
    }
  }
  if (rejected.length > 0) {
    // The dominant rejection is a retyped quote, not a wrong fact. Hand the
    // model the passages that actually discuss the claim so the repair round
    // can requote instead of surrender — this is what keeps completeness from
    // paying for the verifier's strictness.
    // Candidates carry their document id: in a multi-document run the same
    // sentence pattern occurs in both filings, and a repaired claim that names
    // the wrong one is a citation error the memo would publish as fact.
    const withCandidates = rejected.map((item) => ({
      ...item,
      // A figure the claim states but its quote does not contain has one
      // reliable lookup: search the sources for the figure itself. Word overlap
      // cannot do it when the claim is in English and the filing is in Chinese —
      // which is how MB-005 en kept re-proposing the claim amount, kept getting
      // rejected, and ended up publishing the amount as undisclosed.
      candidates: [
        ...passagesContaining(documents, item.unboundNumbers ?? []),
        ...candidatePassages(documents, item.text).map((candidate) => ({
          documentId: candidate.documentId,
          text: candidate.text,
        })),
      ].filter(
        (candidate, index, all) =>
          all.findIndex((other) => other.text === candidate.text && other.documentId === candidate.documentId) === index,
      ),
    }))
    const repair = repairPrompt(
      withCandidates,
      boundDocuments(documents, [...focus, ...rejected.map((item) => item.text)]),
      lang,
    )
    const repaired = (await askForJson<ExtractionReply>(model, repair, '修复轮', notes)) ?? {}
    const second = verifyBatch(repaired.claims ?? [], documents, pool, retrievedAt, lang, nextClaimId, forbidden, spans)
    // Only keep repairs that say something new: a repaired claim whose text
    // duplicates an accepted one adds noise, not coverage.
    for (const claim of second.accepted) {
      if (!claims.some((existing) => existing.text.trim() === claim.text.trim())) claims.push(claim)
    }
    if (passes.length === 1) collectGaps(repaired.gaps, gaps)
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
        // Figure-keyed candidates first when the question asks for a quantity:
        // the kind of figure a question asks for matches a sentence across
        // languages, where word overlap does not. A gap and a residual are the
        // same problem seen at two moments — nothing states the value — so they
        // get the same candidates rather than two different searches.
        candidates: [
          ...figureCandidates(documents, question.text, 4).map((candidate) => ({
            documentId: candidate.documentId,
            text: candidate.text,
          })),
          ...candidatePassages(documents, question.text, 5, {
            // A question asking "how much" is answered by a passage with a
            // figure in it; plain word overlap ranks the boilerplate that
            // repeats the question's nouns above the sentence that answers it.
            // Folded first: the traditional 「金額」「數量」「價格」 miss this
            // pattern outright, and a zh-TW run then ranks the boilerplate that
            // echoes the question above the sentence carrying the figure.
            preferNumbers: /多少|金额|数量|比例|上限|规模|价格|股数|how much|how many|amount|price/.test(
              foldScript(question.text),
            ),
          }).map((candidate) => ({ documentId: candidate.documentId, text: candidate.text })),
        ].filter(
          (candidate, index, all) =>
            all.findIndex((other) => other.text === candidate.text && other.documentId === candidate.documentId) ===
            index,
        ),
      })),
      boundDocuments(documents, unanswered.map((question) => question.text)),
      lang,
    )
    const reviewed = (await askForJson<GapReviewReply>(model, challenge, '缺口复核', notes)) ?? {}
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
        spans,
      )
      for (const claim of rescued.accepted) {
        if (!claims.some((existing) => existing.text.trim() === claim.text.trim())) claims.push(claim)
      }
      rejected.push(...rescued.rejected.map((item) => ({ ...item, round: 'repair' as const })))
      if (rescued.accepted.length > 0) closed.push(questionId)
    }
  }

  // A gap review verdict is still a model verdict. When the question asks for
  // a known kind of figure and the source mechanically contains that kind, a
  // answer with no mechanically settling claim gets one final, language-blind
  // attempt in Step 4e. This
  // reuses the same candidate selector as residual recovery: no second scanner,
  // and no vocabulary overlap required between question and filing.
  const forcedGaps = intent.subQuestions.flatMap((question) => {
    if (
      claims.some(
        (claim) => claim.questionId === question.id && mechanicallySettles(claim, question.text),
      )
    ) {
      return []
    }
    const kinds = askedKinds(question.text)
    if (kinds.size === 0) {
      notes.push(`${question.id}: 无量纲键,未强制补抽`)
      return []
    }
    const candidates = figureCandidates(documents, question.text).map((candidate) => ({
      documentId: candidate.documentId,
      text: candidate.text,
    }))
    return candidates.length > 0 ? [{ questionId: question.id, question: question.text, candidates }] : []
  })

  // Step 4d. Answered is not the same as settled: a filing that fixes the
  // pricing basis and leaves the price open has answered the rule and nothing
  // else. Without this the memo publishes the rule and drops the finding.
  const residuals: { questionId: string; missing: string }[] = []
  const settleable = intent.subQuestions
    .map((question) => ({
      questionId: question.id,
      question: question.text,
      answers: claims
        .filter((claim) => claim.questionId === question.id && !(claim.type === 'fact' && claim.unverifiable))
        .map((claim) => claim.text),
    }))
    .filter((item) => item.answers.length > 0)
  if (settleable.length > 0) {
    const reviewed = await askForJson<ResidualReviewReply>(
      model,
      residualReviewPrompt(settleable, lang),
      '残余复核',
      notes,
    )
    for (const result of reviewed?.results ?? []) {
      const questionId = (result?.question_id ?? '').trim()
      if (result?.verdict !== 'residual') continue
      if (!settleable.some((item) => item.questionId === questionId)) continue
      residuals.push({ questionId, missing: (result.missing ?? '').trim() })
    }
  }

  // Step 4e. One narrow second attempt per residual sub-question, against the
  // sentences that carry a figure of the kind it asks for. A verifier rejection
  // gets one repair call, then stops: bounded, non-recursive, and verified like
  // any other claim — this raises recall, never the standard of proof.
  const recovered = new Set<string>()
  // Step 4d already routes residual questions into this same attempt and allows
  // a useful bound to publish while the missing actual value stays explicit.
  // Do not reclassify those as atomic gaps merely because forcedGaps also saw a
  // non-settling claim; residual semantics take precedence for the same id.
  const residualQuestionIds = new Set(residuals.map((residual) => residual.questionId))
  const forcedQuestionIds = new Set(
    forcedGaps.filter((gap) => !residualQuestionIds.has(gap.questionId)).map((gap) => gap.questionId),
  )
  if ((residuals.length > 0 || forcedGaps.length > 0) && documents.length > 0) {
    const residualTargets = residuals
      .map((residual) => {
        const question = intent.subQuestions.find((item) => item.id === residual.questionId)
        if (!question) return undefined
        const candidates = figureCandidates(documents, question.text).map((candidate) => ({
          documentId: candidate.documentId,
          text: candidate.text,
        }))
        if (candidates.length === 0) {
          // Nothing in the sources carries a figure of the kind this question
          // asks for. That is an answer of sorts, and cheaper than a call.
          notes.push(
            `${residual.questionId}: 定向补抽未找到候选句(原始文件中没有该问句所要口径的数字),保留「尚未确定」声明`,
          )
          return undefined
        }
        return { questionId: residual.questionId, question: question.text, candidates }
      })
      .filter((item): item is { questionId: string; question: string; candidates: { documentId: string; text: string }[] } =>
        Boolean(item),
      )
    const targets = [...residualTargets, ...forcedGaps].filter(
      (target, index, all) => all.findIndex((item) => item.questionId === target.questionId) === index,
    )

    if (targets.length > 0) {
      const attempted = await askForJson<ExtractionReply>(
        model,
        targetedExtractionPrompt(targets, lang),
        '定向补抽',
        notes,
      )
      const wanted = new Set(targets.map((item) => item.questionId))
      const round = verifyBatch(
        (attempted?.claims ?? []).filter((claim) => wanted.has((claim.question_id ?? '').trim())),
        documents,
        pool,
        retrievedAt,
        lang,
        nextClaimId,
        forbidden,
        spans,
      )

      const acceptTargeted = (accepted: Claim[]): void => {
        for (const claim of accepted) {
          // Forced-gap recovery is atomic: a verified but non-settling claim must
          // not enter `claims`, because compose treats any owned claim as a reason
          // to suppress the honest absence statement. Residual recovery keeps its
          // existing behaviour and may publish a useful bound while retaining the
          // separate "value not yet determined" residual. Repairs use this exact
          // same predicate; a retry never relaxes forced-gap closure.
          if (forcedQuestionIds.has(claim.questionId)) {
            const question = intent.subQuestions.find((item) => item.id === claim.questionId)
            if (!mechanicallySettles(claim, question?.text)) continue
          }
          if (
            claims.some(
              (existing) =>
                existing.text.trim() === claim.text.trim() &&
                (!forcedQuestionIds.has(claim.questionId) || existing.questionId === claim.questionId),
            )
          ) {
            continue
          }
          claims.push(claim)
          recovered.add(claim.questionId)
          if (forcedQuestionIds.has(claim.questionId) && !closed.includes(claim.questionId)) {
            closed.push(claim.questionId)
          }
        }
      }

      acceptTargeted(round.accepted)
      rejected.push(...round.rejected.map((item) => ({ ...item, round: 'repair' as const })))

      if (round.rejected.length > 0) {
        // Step 4e used to stop at a repairable verifier rejection. Give those
        // claims the same single bounded repair facility as the main extraction
        // round. Literal unbound-number passages work across languages; the
        // rejection reason itself carries identifier and source-unit guidance.
        const withCandidates = round.rejected.map((item) => ({
          ...item,
          candidates: passagesContaining(documents, item.unboundNumbers ?? []),
        }))
        const repair = repairPrompt(
          withCandidates,
          boundDocuments(documents, [
            ...targets.map((target) => target.question),
            ...round.rejected.map((item) => item.text),
          ]),
          lang,
        )
        const repaired =
          (await askForJson<ExtractionReply>(model, repair, '定向补抽修复轮', notes)) ?? {}
        const repairedRound = verifyBatch(
          (repaired.claims ?? []).filter((claim) => wanted.has((claim.question_id ?? '').trim())),
          documents,
          pool,
          retrievedAt,
          lang,
          nextClaimId,
          forbidden,
          spans,
        )
        acceptTargeted(repairedRound.accepted)
        rejected.push(...repairedRound.rejected.map((item) => ({ ...item, round: 'repair' as const })))
      }

      for (const questionId of wanted) {
        if (!recovered.has(questionId)) {
          notes.push(
            forcedQuestionIds.has(questionId)
              ? `${questionId}: 定向补抽未找到该问句所要的可核实答案,保留缺口声明`
              : `${questionId}: 定向补抽未找到该问句所要的具体数值,保留「尚未确定」声明`,
          )
        }
      }
    }
  }

  // A recovered claim only settles the question when it states the *value*.
  // Judged mechanically rather than by asking the reviewer again: a second
  // opinion on its own first opinion flip-flops, and on a live MB-009 zh-TW run
  // it withdrew three "not yet determined" sentences on the strength of claims
  // that only restated the ceiling. A bound is not a value — that rule is in the
  // prompt, and this is what makes it true.
  for (let index = residuals.length - 1; index >= 0; index -= 1) {
    const residual = residuals[index] as { questionId: string; missing: string }
    if (!recovered.has(residual.questionId)) continue
    const question = intent.subQuestions.find((item) => item.id === residual.questionId)
    const settles = claims.some(
      (claim) => claim.questionId === residual.questionId && mechanicallySettles(claim, question?.text),
    )
    if (settles) {
      residuals.splice(index, 1)
    } else {
      notes.push(
        `${residual.questionId}: 定向补抽取回了内容,但仍未陈述该问句所要的具体数值(仅规则或上限),保留「尚未确定」声明`,
      )
    }
  }

  // A question that got an answer is no longer a gap, whatever the first pass
  // said. This must run after Step 4e so a forced recovery is reflected in both
  // the trace and the publication gate.
  const answered = new Set(claims.map((claim) => claim.questionId))
  const survivingGaps = gaps.filter((gap) => !answered.has(gap.questionId))

  return {
    claims,
    evidence: pool.items,
    rejected,
    gaps: survivingGaps,
    gapsClosed: closed,
    ...(residuals.length > 0 ? { residuals } : {}),
    ...(spans.length > 0 ? { spans } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  }
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
  spans: SpanDecision[] = [],
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
      // The proposal located; now decide which span to publish. Two runs that
      // point at different halves of the same sentence should cite the same
      // thing, and a claim's figures should be inside the citation that carries
      // them rather than in the sentence next door.
      const chosen = chooseQuoteSpan(located.document, located.at.quote, text) ?? {
        quote: located.at.quote,
        charStart: located.at.charStart,
        charEnd: located.at.charEnd,
        path: 'locator-only',
        adjusted: false,
      }
      if (chosen.adjusted) {
        spans.push({
          text,
          documentId: located.document.id,
          from: located.at.quote,
          to: chosen.quote,
          path: chosen.path,
        })
      }
      const declaredUnits = hintsById.get(located.document.id) ?? []
      evidence.push(
        pool.intern({
          documentId: located.document.id,
          sourceLabel: located.document.title,
          quote: chosen.quote,
          charStart: chosen.charStart,
          charEnd: chosen.charEnd,
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

    const evidenceIds = evidence.map((entry) => entry.id)

    const bound = bindNumbers(text, evidence)
    if (bound.unbound.length > 0) {
      rejected.push({
        text,
        // A transliterated case number shatters into three unbound integers,
        // none of which is in the filing, and the figure standing next to it
        // dies with them. Naming the cause here is what lets the repair round
        // fix it in one move instead of retyping the same sentence.
        reason: `these numbers do not appear in the cited quotes: ${bound.unbound
          .map((token) => token.raw)
          .join(', ')}${transliteratedIdentifier(text) ? IDENTIFIER_HINT : ''}`,
        questionId,
        evidenceIds,
        unboundNumbers: bound.unbound.map((token) => token.raw),
      })
      continue
    }

    // A unit is part of the figure. When the filing prints 「…元」 and the claim
    // writes "yuan" or "CNY", the sentence carries a figure that is not on the
    // page — the reader cannot match it back, and neither can any checker. The
    // prompt asks for this; the verifier is what makes it true.
    const translated = translatedUnit(text, evidence)
    if (translated) {
      rejected.push({
        text,
        reason: `unit was translated: the filing prints 「${translated.printed}」 and this claim writes 「${translated.written}」. Keep the source's unit characters, whatever language the sentence is in.`,
        questionId,
        evidenceIds,
      })
      continue
    }

    const compliance = scanCompliance(text, lang, forbidden)
    if (!compliance.passed) {
      rejected.push({
        text,
        reason: `compliance rule '${compliance.hits[0]?.rule}' fired on 「${compliance.hits[0]?.match}」`,
        questionId,
        evidenceIds,
      })
      continue
    }

    const base = { id: nextClaimId(), text, questionId, evidenceIds, numbers: bound.numbers }

    switch (item.type) {
      case 'attributed_opinion': {
        const attribution = (item.attribution ?? '').trim()
        if (!attribution) {
          rejected.push({ text, reason: 'attributed_opinion has no named speaker', questionId, evidenceIds })
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
            evidenceIds,
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
          rejected.push({ text, reason: 'scenario has no observable trigger', questionId, evidenceIds })
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

/** Wording that bounds a figure instead of stating it. */
const BOUND_LANGUAGE =
  /不超过|不超過|不低于|不低於|不高于|不高於|上限|至多|至少|以内|以內|no more than|not exceed|at most|no less than|up to|ceiling|maximum|minimum/i

/** Wording in a question that asks for the bound itself. */
const BOUND_ASKING = /上限|上限是多少|最高|最多|不超过多少|maximum|upper limit|cap\b|at most|ceiling/i

/** Does one verified claim state the value its question asks for? */
function mechanicallySettles(claim: Claim, question: string | undefined): boolean {
  if (claim.type === 'fact' && claim.unverifiable) return false
  if (BOUND_LANGUAGE.test(claim.text) && !(question && BOUND_ASKING.test(question))) return false
  const kinds = question ? askedKinds(question) : new Set<AskedKind>()
  if (kinds.size === 0) return /\d/.test(claim.text)
  return statesKind(claim.text, kinds)
}

/** Currency spelled in Latin letters, as an English sentence tends to. */
const LATIN_UNIT = /(?:cny|rmb|yuan|renminbi|hkd|usd|dollars?|hk\$|us\$|[$¥])/i
/** Currency as the filing prints it. */
const CJK_UNIT = /[元股份]|人民币|人民幣|港元|美元/

/**
 * Find a figure whose unit the claim translated away from the source.
 *
 * @param text - the claim's text.
 * @param evidence - the quotes it cites.
 * @returns the offending pair, or undefined when every unit survived intact.
 */
function translatedUnit(
  text: string,
  evidence: EvidenceRef[],
): { written: string; printed: string } | undefined {
  const claimed = extractNumbers(text).filter(
    (token) => token.kind === 'amount' && LATIN_UNIT.test(token.raw) && !CJK_UNIT.test(token.raw),
  )
  if (claimed.length === 0) return undefined
  for (const token of claimed) {
    for (const item of evidence) {
      for (const candidate of extractNumbers(item.quote)) {
        if (candidate.kind !== 'amount' || !CJK_UNIT.test(candidate.raw)) continue
        if (candidate.value !== token.value && candidate.numericRaw !== token.numericRaw) continue
        return { written: token.raw.trim(), printed: candidate.raw.trim() }
      }
    }
  }
  return undefined
}

/**
 * Does this claim spell a Chinese identifier out in Latin letters?
 *
 * A case number like 「（YYYY）省NN…N号」 is a name. Rendered as
 * "(YYYY) Prov NN ... No. N" it is not in the document at all, and the number
 * binder sees three loose integers instead of one identifier.
 *
 * @param text - the claim's text.
 * @returns true when it looks transliterated.
 */
function transliteratedIdentifier(text: string): boolean {
  return /[（(]\s*(?:19|20)\d{2}\s*[）)]\s*[A-Za-z]/.test(text)
}

/** Appended to a rejection so the repair round knows what to change. */
const IDENTIFIER_HINT =
  '。注意:案号、文号、文书名是标识符,必须按原文字形整段引用(不得音译或转写),否则它在文件里不存在,连同旁边的金额一起被拒。'

/**
 * Passages that contain a figure verbatim.
 *
 * Deterministic and language-blind: `1,234,567` is `1,234,567` in an English
 * claim and in a Chinese filing, so this finds the sentence a lexical ranker
 * built on word overlap cannot.
 *
 * @param documents - retrieved documents.
 * @param figures - the figures a rejected claim failed to bind.
 * @param limit - how many passages to return.
 * @returns passages carrying those figures, nearest match first.
 */
function passagesContaining(
  documents: SourceDocument[],
  figures: string[],
  limit = 3,
): { documentId: string; text: string }[] {
  if (figures.length === 0) return []
  const found: { documentId: string; text: string }[] = []
  for (const document of documents) {
    for (const passage of splitPassages(document.text)) {
      if (!figures.some((figure) => passage.text.includes(figure))) continue
      found.push({ documentId: document.id, text: passage.text })
      if (found.length >= limit) return found
    }
  }
  return found
}

/**
 * Split the retrieved documents into reading passes.
 *
 * Everything that fits goes in one pass. A document too long for a prompt is
 * read window by window, in document order — every window is read, because the
 * alternative is deciding by word overlap which pages the filing is allowed to
 * have said something on.
 *
 * @param documents - retrieved documents.
 * @param notes - disclosure sink; a document read only in part says so here.
 * @returns one document set per model call.
 */
function readingPasses(
  documents: SourceDocument[],
  notes: string[],
  focus: string[] = [],
): SourceDocument[][] {
  const long = documents.filter((document) => windowDocument(document.text).length > 1)
  if (long.length === 0) return [documents]

  const short = documents.filter((document) => !long.includes(document))
  const passes: SourceDocument[][] = []
  if (short.length > 0) passes.push(short)
  for (const document of long) {
    const windows = windowDocument(document.text)
    // Over the budget, the opening window is kept unconditionally — filings put
    // 「重大事项提示」 at the front — and the rest are chosen by relevance rather
    // than by position, or a needle in the last chapter is unreachable by
    // construction.
    const read = selectWindows(windows, focus, MAX_WINDOWS)
    if (read.length < windows.length) {
      notes.push(
        `${document.title}: 全文分为 ${windows.length} 段,本次通读其中 ${read.length} 段(第 ${read
          .map((window) => window.index)
          .join('、')} 段),其余段落未抽取`,
      )
    }
    for (const window of read) passes.push([asWindowView(document, window)])
  }
  return passes
}

/** A short label for one reading pass, used in disclosures. */
function passLabel(pass: SourceDocument[]): string {
  const first = pass[0]
  if (!first) return '抽取'
  return pass.length === 1 ? first.title : `${first.title} 等 ${pass.length} 份文件`
}

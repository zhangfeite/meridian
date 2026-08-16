/**
 * Step 7 of 7 — composition and the publication gate.
 *
 * No model runs here. By this point every sentence has already been proposed,
 * quoted, number-bound, and (for inferences) argued against; composition is
 * assembly plus one last refusal to publish anything that breaks the contract.
 *
 * Deliberate: a model that writes the final prose can reintroduce every defect
 * the previous six steps removed — a rounded figure, an unsourced adjective, a
 * helpful recommendation. The memo is rendered from the verified structure, so
 * the worst outcome of a bad run is a memo that says less, never one that says
 * something untrue.
 *
 * @module @meridian/agent/steps/compose
 */

import { createHash } from 'node:crypto'
import {
  readsAsAbsence,
  statesUnverifiable,
  validateContract,
  type AuditRecord,
  type Claim,
  type DerivedNumber,
  type EvidenceRef,
  type GateResult,
  type Memo,
  type MemoSection,
  type MeridianLang,
  type SourceRef,
} from '../contract.ts'
import { idAllocator } from '../ids.ts'
import type { ModelClient } from '../model.ts'
import type { Skill } from '../skills/types.ts'
import type { EvidencePool } from '../evidence-pool.ts'
import { buildProse } from '../prose.ts'
import { auditChecklist, AUDIT_VERSION } from './audit.ts'
import type { SourceDocument } from '../source/types.ts'
import type { Intent, RejectedClaim, RetrievalResult } from '../types.ts'
import { bindNumbers } from '../verify/bind.ts'
import { scanCompliance } from '../verify/compliance.ts'
import { locateQuote } from '../verify/evidence.ts'
import { detectUnitHints, extractNumbers, verifyNumbers } from '../verify/numbers.ts'
import { matchesScript } from '../verify/script.ts'
import {
  coverage,
  keyUnits,
  maskNonContent,
  selectNearestPassage,
  selectSupportingPassage,
  semanticUnits,
  touchesTopic,
} from '../verify/text.ts'
import { renderMemoMarkdown } from '../render.ts'

/** Inputs to composition. */
export interface ComposeInput {
  intent: Intent
  retrieval: RetrievalResult
  documents: SourceDocument[]
  claims: Claim[]
  evidence: EvidenceRef[]
  derived: DerivedNumber[]
  gaps: { questionId: string; reason: string }[]
  audit: AuditRecord[]
  lang: MeridianLang
  /** Evidence allocator, so a gap can cite the passage that explains it. */
  pool: EvidencePool
  question: string
  taskId?: string
  provenance: Memo['provenance']
  /** Supplying a model enables the prose-polishing pass; omit for a raw draft. */
  model?: ModelClient
  /** The analysis recipe in force, if any. */
  skill?: Skill
  /** Set false to skip the step-7b checklist audit. */
  auditChecklist?: boolean
  /**
   * Claims the verifier refused, by sub-question.
   *
   * A question whose claims were rejected is not a question the filing is
   * silent about — it is one this run could not verify an answer for, and the
   * memo has to say the narrower of the two.
   */
  rejected?: RejectedClaim[]
  /**
   * Sub-questions step 4d judged answered in their general form only: the rule,
   * range or procedure is disclosed and the specific figure is not.
   */
  residuals?: { questionId: string; missing: string }[]
}

/** Composition output: the artifact and its rendering. */
export interface ComposeResult {
  memo: Memo
  markdown: string
  prose: { drafted: number; polished: number; rejected: number; dropped: number }
}

/** Localized fixed strings. Fixed, not model-written: this is gate surface. */
const STRINGS: Record<
  MeridianLang,
  {
    unverifiableSuffix: (question: string, reason: string) => string
    /**
     * Wording for a gap the pipeline cannot evidence.
     *
     * 「The filing does not disclose X」 is a claim about the filing, and this
     * pipeline does not publish claims about documents it cannot cite. With no
     * passage to stand on, what we actually know is narrower: we looked and did
     * not find it. MB-005 en published the strong form about a fact printed in
     * the announcement's first sentence.
     */
    unlocatedSuffix: (question: string, reason: string) => string
    /**
     * A sub-question whose rule the sources settled and whose value they did
     * not. Sits beside the answer it qualifies, not instead of it.
     */
    residualSuffix: (question: string) => string
    noSources: string
    advisoryRefusal: string
  }
> = {
  'zh-CN': {
    unverifiableSuffix: (question, reason) =>
      `关于「${question}」:所提供的原始文件中没有相应披露${reason ? `(${reason})` : ''},无法核实。`,
    unlocatedSuffix: (question, reason) =>
      `关于「${question}」:本备忘录未能在所提供的原始文件中找到相应内容${reason ? `(${reason})` : ''},无法核实。`,
    residualSuffix: (question) =>
      `关于「${question}」:原始文件只给出了规则、区间或程序,具体数值尚未确定,无法核实。`,
    noSources: '本次运行未能取得任何原始文件,以下内容无法核实。',
    advisoryRefusal:
      '本备忘录只整理已公开披露的事实与其出处,不能替你做投资决定——那取决于你自己的风险承受能力、期限与目标,也取决于原始文件尚未披露的信息。',
  },
  'zh-TW': {
    unverifiableSuffix: (question, reason) =>
      `關於「${question}」:所提供的原始文件中沒有相應揭露${reason ? `(${reason})` : ''},無法核實。`,
    unlocatedSuffix: (question, reason) =>
      `關於「${question}」:本備忘錄未能在所提供的原始文件中找到相應內容${reason ? `(${reason})` : ''},無法核實。`,
    residualSuffix: (question) =>
      `關於「${question}」:原始文件只給出了規則、區間或程序,具體數值尚未確定,無法核實。`,
    noSources: '本次執行未能取得任何原始文件,以下內容無法核實。',
    advisoryRefusal:
      '本備忘錄只整理已公開揭露的事實與其出處,不能替你做投資決定——那取決於你自己的風險承受能力、期限與目標,也取決於原始文件尚未揭露的資訊。',
  },
  en: {
    unverifiableSuffix: (question, reason) =>
      `On "${question}": the primary sources provided do not disclose this${reason ? ` (${reason})` : ''}, so it cannot be verified.`,
    unlocatedSuffix: (question, reason) =>
      `On "${question}": this memo could not locate an answer in the primary sources provided${reason ? ` (${reason})` : ''}, so it cannot be verified.`,
    residualSuffix: (question) =>
      `On "${question}": the primary sources state only the rule, range or procedure — the specific figure has not yet been determined, so it cannot be verified.`,
    noSources: 'This run retrieved no primary sources, so nothing below could be verified.',
    advisoryRefusal:
      'This memo organizes disclosed facts and their sources. It cannot make an investment decision for you — that depends on your own risk tolerance, horizon, and objectives, and on information the filings do not disclose.',
  },
}

/**
 * Assemble the memo and run the publication gate.
 *
 * @param input - everything the previous six steps produced.
 * @returns the memo plus its Markdown rendering.
 */
export async function compose(input: ComposeInput): Promise<ComposeResult> {
  const strings = STRINGS[input.lang]
  const audit = [...input.audit]
  const derivedById = new Map(input.derived.map((item) => [item.id, item]))
  const evidenceById = new Map(input.evidence.map((item) => [item.id, item]))

  for (const failure of input.retrieval.failures) {
    audit.push({
      step: 'retrieve',
      action: 'retrieval_failed',
      detail: `${failure.documentId}: ${failure.code} — ${failure.message}`,
    })
  }

  // Sanitize inference metadata: assumptions and triggers are published text and
  // are held to the same number-binding rule as claim bodies.
  const claims: Claim[] = []
  for (const claim of input.claims) {
    const claimEvidence = claim.evidenceIds
      .map((id) => evidenceById.get(id))
      .filter((item): item is EvidenceRef => Boolean(item))
    const claimDerived = claim.numbers
      .map((number) => (number.derivedId ? derivedById.get(number.derivedId) : undefined))
      .filter((item): item is DerivedNumber => Boolean(item))
    const keep = (value: string): boolean =>
      bindNumbers(value, claimEvidence, claimDerived).unbound.length === 0

    if (claim.type === 'model_inference') {
      const assumptions = claim.assumptions.filter(keep)
      if (assumptions.length === 0) {
        audit.push({
          step: 'compose',
          action: 'claim_rejected_unregistered_number',
          claimId: claim.id,
          detail: 'every stated assumption contained an unsourced number',
        })
        continue
      }
      claims.push({ ...claim, assumptions })
      continue
    }
    if (claim.type === 'scenario') {
      const triggers = claim.triggers.filter(keep)
      if (triggers.length === 0) {
        audit.push({
          step: 'compose',
          action: 'claim_rejected_unregistered_number',
          claimId: claim.id,
          detail: 'every stated trigger contained an unsourced number',
        })
        continue
      }
      claims.push({ ...claim, triggers })
      continue
    }
    claims.push(claim)
  }

  // Sections follow the plan's sub-questions, so a question that produced
  // nothing is visible as an answered-with-nothing section rather than absent.
  const gapByQuestion = new Map(input.gaps.map((item) => [item.questionId, item.reason]))
  const sections: MemoSection[] = []
  const openQuestions: string[] = []
  const nextGapClaimId = idAllocator('U')
  const residualByQuestion = new Map(
    (input.residuals ?? []).map((item) => [item.questionId, item.missing]),
  )
  // claimId → evidence id of the passage that explains that claim's absence.
  const absenceSupport = new Map<string, string>()
  // claimId → evidence id of the closest passage reached by this run.
  const exhibitSupport = new Map<string, string>()

  for (const question of input.intent.subQuestions) {
    const owned = claims.filter((claim) => claim.questionId === question.id)
    if (owned.length > 0) {
      // An absence answer owes the reader the sentence that explains it,
      // whoever wrote it. When the model answers "not disclosed" itself, no gap
      // claim is created — so the support has to be attached here too, or the
      // memo asserts an absence it never evidences.
      //
      // Per claim, not per question: a sub-question is often answered in parts
      // ("the cap is X, but the final price is not yet set"), and the absent
      // half deserves its support whether or not the other half was answerable.
      const absent = owned.filter((claim) => readsAsAbsence(claim.text, input.lang))
      if (absent.length > 0) {
        const support = selectSupportingPassage(input.documents, question.text)
        const evidence = support ? locateSupport(support, input.documents, input.pool) : undefined
        if (evidence) {
          for (const claim of absent) {
            if (!claim.evidenceIds.includes(evidence.id)) claim.evidenceIds.push(evidence.id)
            absenceSupport.set(claim.id, evidence.id)
          }
        }
      }
      // Answered in general, open in particular. The residual sentence goes in
      // beside the answers, through the same citation path as any other gap: a
      // filing that says the price will be set after registration is exactly
      // the evidence a reader wants next to "not yet determined".
      const residualIds: string[] = []
      if (residualByQuestion.has(question.id)) {
        const support = selectSupportingPassage(input.documents, question.text)
        const evidence = support ? locateSupport(support, input.documents, input.pool) : undefined
        const residualId = nextGapClaimId()
        const exhibit = evidence ? undefined : selectExhibit(question, input)
        claims.push({
          id: residualId,
          type: 'fact',
          text: strings.residualSuffix(quotable(question.text)),
          questionId: question.id,
          evidenceIds: evidence ? [evidence.id] : [],
          numbers: [],
          unverifiable: true,
          residual: true,
          ...(exhibit ? { exhibitEvidenceId: exhibit.evidence.id } : {}),
        })
        if (evidence) absenceSupport.set(residualId, evidence.id)
        if (exhibit) exhibitSupport.set(residualId, exhibit.evidence.id)
        if (!evidence) {
          audit.push({
            step: 'compose',
            action: exhibit ? 'gap_exhibit_attached' : 'gap_exhibit_none',
            claimId: residualId,
            detail: exhibit
              ? `${question.id}: ${exhibit.detail}`
              : `${question.id}: neither rejected located evidence nor a passage sharing a key unit was available`,
          })
        }
        residualIds.push(residualId)
        openQuestions.push(safeHeading(question.text, input.lang))
        audit.push({
          step: 'compose',
          action: 'residual_gap_recorded',
          claimId: residualId,
          detail: `${question.id} is answered in its general form only; still undetermined: ${
            residualByQuestion.get(question.id) || 'the specific figure'
          }`,
        })
      }
      sections.push({
        questionId: question.id,
        heading: safeHeading(question.text, input.lang),
        claimIds: [...owned.map((claim) => claim.id), ...residualIds],
      })
      continue
    }
    const reason = gapByQuestion.get(question.id) ?? ''
    const quoted = quotable(question.text)
    // A gap is a finding, and a finding is cited. Filings do not say "we are not
    // disclosing this"; they say the stage has not been reached — 「截至本公告
    // 披露日，公司尚未收到法院……的文件」 — and that sentence is exactly what a
    // reader needs beside a "not disclosed" answer. Without it the memo asserts
    // an absence; with it, the absence is evidenced like everything else.
    const support = selectSupportingPassage(input.documents, question.text)
    const supportEvidence = support ? locateSupport(support, input.documents, input.pool) : undefined
    // And when there is no such sentence, the memo says the narrower true thing.
    // 「The sources do not disclose X」 is an assertion about the filing; with
    // nothing to cite, all we know is that we did not find it. MB-005 en made
    // the strong claim about a fact printed in the announcement's first line.
    // The filing is only "silent" when nothing about this question reached the
    // verifier. If a claim was proposed and refused — an unquotable figure, a
    // retyped passage — then what the memo knows is that it could not verify an
    // answer, which is a different sentence. MB-005 en refused the claim amount
    // four times and then published the amount as undisclosed.
    const refused = (input.rejected ?? []).some((item) => item.questionId === question.id)
    const exhibit = !supportEvidence || refused ? selectExhibit(question, input) : undefined
    const suffix = supportEvidence && !refused ? strings.unverifiableSuffix : strings.unlocatedSuffix
    const text = input.documents.length === 0
      ? `${strings.noSources}${suffix(quoted, reason)}`
      : suffix(quoted, reason)
    const gapClaimId = nextGapClaimId()
    claims.push({
      id: gapClaimId,
      type: 'fact',
      text,
      questionId: question.id,
      evidenceIds: supportEvidence ? [supportEvidence.id] : [],
      numbers: [],
      unverifiable: true,
      ...(exhibit ? { exhibitEvidenceId: exhibit.evidence.id } : {}),
    })
    if (supportEvidence) absenceSupport.set(gapClaimId, supportEvidence.id)
    if (exhibit) exhibitSupport.set(gapClaimId, exhibit.evidence.id)
    if (!supportEvidence || refused) {
      audit.push({
        step: 'compose',
        action: 'gap_unevidenced',
        claimId: gapClaimId,
        detail: refused
          ? `${question.id}: claims were proposed and refused by verification, so the memo reports that it could not verify an answer rather than asserting the filing is silent`
          : `${question.id}: no passage explains the absence, so the memo reports that it could not locate an answer rather than asserting the filing is silent`,
      })
      audit.push({
        step: 'compose',
        action: exhibit ? 'gap_exhibit_attached' : 'gap_exhibit_none',
        claimId: gapClaimId,
        detail: exhibit
          ? `${question.id}: ${exhibit.detail}`
          : `${question.id}: neither rejected located evidence nor a passage sharing a key unit was available`,
      })
    }
    audit.push({
      step: 'compose',
      action: 'gap_recorded',
      claimId: gapClaimId,
      detail: `${question.id} has no verified claim: ${reason || 'not disclosed in the retrieved sources'}`,
    })
    // Open questions are rendered as plain bullets, so they get the same
    // quoting treatment as headings.
    openQuestions.push(safeHeading(question.text, input.lang))
    sections.push({
      questionId: question.id,
      heading: safeHeading(question.text, input.lang),
      claimIds: [gapClaimId],
      gap: reason || 'not disclosed in the retrieved sources',
    })
  }

  // Pre-publication consistency: an absence statement may only cover a
  // sub-question that is still a gap when gap review is done. If a question
  // carries a verified claim, the memo has the answer in hand, and saying "not
  // disclosed" about it in the same document is a contradiction — the reader has
  // no way to tell which half to believe. Guaranteed by construction above; kept
  // as a check because construction changes and this failure is silent.
  const answeredQuestions = new Set(
    claims.filter((claim) => !(claim.type === 'fact' && claim.unverifiable)).map((claim) => claim.questionId),
  )
  const contradictoryGaps = claims.filter(
    (claim) =>
      claim.type === 'fact' &&
      claim.unverifiable &&
      // A residual is *meant* to sit next to an answer: it says the rule is
      // settled and the figure is not, which is one statement in two halves.
      // The disjointness rule is about the other kind — a blanket "not
      // disclosed" over a question the memo answers.
      !claim.residual &&
      answeredQuestions.has(claim.questionId),
  )
  for (const gap of contradictoryGaps) {
    audit.push({
      step: 'compose',
      action: 'gap_withdrawn_answered',
      claimId: gap.id,
      detail: `${gap.questionId} carries a verified claim, so the absence statement was withdrawn before publication: ${gap.text}`,
    })
    const index = claims.indexOf(gap)
    if (index >= 0) claims.splice(index, 1)
    for (const section of sections) {
      section.claimIds = section.claimIds.filter((id) => id !== gap.id)
    }
    absenceSupport.delete(gap.id)
    exhibitSupport.delete(gap.id)
  }
  if (contradictoryGaps.length > 0) {
    const withdrawnQuestions = new Set(contradictoryGaps.map((gap) => gap.questionId))
    for (const questionId of withdrawnQuestions) {
      const heading = sections.find((section) => section.questionId === questionId)?.heading
      if (heading) {
        const at = openQuestions.indexOf(heading)
        if (at >= 0) openQuestions.splice(at, 1)
      }
    }
  }

  const usedEvidenceIds = new Set(
    claims.flatMap((claim) => [
      ...claim.evidenceIds,
      ...(claim.type === 'fact' && claim.exhibitEvidenceId ? [claim.exhibitEvidenceId] : []),
      ...(claim.type === 'model_inference' ? claim.counterEvidence.evidenceIds : []),
    ]),
  )
  const availableEvidence = new Map(
    [...input.evidence, ...input.pool.items].map((item) => [item.id, item]),
  )
  const evidence = [...availableEvidence.values()].filter((item) => usedEvidenceIds.has(item.id))
  const usedDocumentIds = new Set(evidence.map((item) => item.documentId))
  // A published figure drags its whole chain into the memo: the reader checking
  // 1.99× must be able to see the 1.82 元/股 it divides by, and the two quoted
  // figures underneath that. Intermediate links appear in the appendix even when
  // no sentence names them.
  const usedDerivedIds = new Set<string>()
  const pullChain = (id: string): void => {
    if (usedDerivedIds.has(id)) return
    usedDerivedIds.add(id)
    for (const upstream of input.derived.find((item) => item.id === id)?.dependsOn ?? []) {
      pullChain(upstream)
    }
  }
  for (const claim of claims) {
    for (const number of claim.numbers) if (number.derivedId) pullChain(number.derivedId)
  }

  const nextSigil = idAllocator('S')
  const sources: SourceRef[] = input.documents
    .filter((document) => usedDocumentIds.has(document.id))
    .map((document) => ({
      documentId: document.id,
      sigil: nextSigil(),
      ...(typeof document.meta?.locator === 'string' ? { locator: document.meta.locator } : {}),
      title: document.title,
      provider: document.provider,
      ...(document.url === undefined ? {} : { url: document.url }),
      ...(document.publishedAt === undefined ? {} : { publishedAt: document.publishedAt }),
      retrievedAt: new Date().toISOString(),
      contentSha256: createHash('sha256').update(document.text, 'utf8').digest('hex'),
    }))

  // Step 7's writing pass. It can only rearrange what survived verification:
  // numbers are locked behind placeholders, anchors must resolve, and the
  // substituted text is re-checked before it is allowed into the memo.
  const prose = await buildProse(
    {
      claims,
      evidence,
      derived: input.derived.filter((item) => usedDerivedIds.has(item.id)),
      subQuestions: input.intent.subQuestions,
      headings: new Map(sections.map((section) => [section.questionId, section.heading])),
      lang: input.lang,
      entityName: input.intent.entity.name,
      sigilByDocument: new Map(sources.map((source) => [source.documentId, source.sigil])),
      absenceSupport,
      exhibitSupport,
    },
    input.model,
  )
  audit.push(...prose.audit)

  // Every checklist item the recipe named must find a home in the memo, or be
  // disclosed as unmet. Lexical coverage is a blunt instrument, and that is the
  // right calibration here: the check exists to catch a whole topic going
  // missing, not to grade wording.
  // Judged on what the memo actually asserts: a gap claim says the sources are
  // silent, which is the opposite of a checklist item being addressed.
  const published = claims
    .filter((claim) => !(claim.type === 'fact' && claim.unverifiable))
    .map((claim) => claim.text)
    .join(' ')
  // The memo's own sentences, in the script the reader asked for? Quotes are
  // excluded on purpose: they carry the filing's characters by design. Observed
  // on live zh-TW runs — 繁體 headings wrapped around 简体 findings, which reads
  // to a Taiwanese reader as a machine that did not listen.
  if (input.lang !== 'en' && !matchesScript(published, input.lang)) {
    audit.push({
      step: 'compose',
      action: 'output_language_mixed',
      detail: `memo prose is not written in ${input.lang}; the sources' character forms leaked into the pipeline's own sentences`,
    })
  }

  const checklist = (input.skill?.risk_checklist ?? []).map((item) => {
    const covered = touchesTopic(item, published)
    if (!covered) {
      audit.push({
        step: 'compose',
        action: 'skill_checklist_unmet',
        detail: `${input.skill?.id ?? 'skill'} checklist item has nothing in the memo answering it: ${item}`,
      })
    }
    return { item, covered, source: 'lexical' as const }
  })

  const memo: Memo = {
    schemaVersion: 'meridian-memo-v1',
    generatedAt: new Date().toISOString(),
    lang: input.lang,
    question: input.question,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    entity: input.intent.entity,
    narrative: prose.blocks,
    sections,
    claims,
    evidence,
    derived: input.derived.filter((item) => usedDerivedIds.has(item.id)),
    sources,
    openQuestions,
    audit,
    gate: { passed: false, contractViolations: [], complianceHits: [], numberViolations: [] },
    provenance: input.provenance,
    ...(checklist.length > 0 ? { checklist } : {}),
  }

  const gate = runGate(memo, input.intent, input.documents, input.skill?.forbidden_reinforce ?? [])
  memo.gate = gate
  const render = (): string => renderMemoMarkdown(memo, refusalOption(input.intent, input.lang))
  let markdown = render()

  // Step 7b. After the gate on purpose: the memo is already publishable, and the
  // audit's job is to describe it, not to decide whether it may exist.
  if (input.model && input.auditChecklist !== false && checklist.length > 0) {
    const audited = await auditChecklist(checklist, markdown, input.model, input.lang)
    audit.push(...audited.audit)
    memo.checklist = audited.checklist
    memo.audit = audit
    if (audited.applied) {
      memo.provenance = {
        ...memo.provenance,
        audit: { model: input.model.id, version: AUDIT_VERSION },
      }
    }
    if (audited.checklist.some((entry) => entry.verdict === 'contradicted')) {
      // The caution line is emitted by the renderer from structured state — a
      // fixed, digit-free sentence of ours. The auditor's words never reach the
      // page, so re-gating here is checking our own template, cheaply.
      const cautioned = render()
      const regated = runGate(memo, input.intent, input.documents, input.skill?.forbidden_reinforce ?? [])
      if (regated.passed || !gate.passed) {
        markdown = cautioned
        memo.gate = regated
      } else {
        // Our own template should never do this. If it somehow does, the memo
        // publishes as it was and the withheld caution is disclosed — the audit
        // is an enhancement and may not cost a memo its publication. The
        // withholding is recorded on the entries, so re-rendering this memo
        // anywhere else does not resurrect the line.
        memo.checklist = memo.checklist?.map((entry) =>
          entry.verdict === 'contradicted' ? { ...entry, cautionWithheld: true } : entry,
        )
        markdown = render()
        audit.push({
          step: 'audit',
          action: 'audit_degraded',
          detail: 'the contradiction caution line was withheld: appending it would have failed the gate',
        })
      }
    }
  }

  return { memo, markdown, prose: prose.stats }
}

/**
 * Run the three publication checks over the assembled memo.
 *
 * @param memo - the assembled memo (mutated only through the returned gate).
 * @param intent - step 1 output; an advice-seeking question must be refused.
 * @param documents - the retrieved sources, for the whole-document number sweep.
 * @returns the gate verdict.
 */
function runGate(
  memo: Memo,
  intent: Intent,
  documents: SourceDocument[],
  skillForbidden: string[] = [],
): GateResult {
  const contractViolations = validateContract(memo)
  const markdown = renderMemoMarkdown(memo, refusalOption(intent, memo.lang))
  const compliance = scanCompliance(markdown, memo.lang, skillForbidden)
  const evidenceById = new Map(memo.evidence.map((item) => [item.id, item]))

  const numberViolations: { display: string; reason: string }[] = []
  for (const claim of memo.claims) {
    const claimEvidence = claim.evidenceIds
      .concat(claim.type === 'fact' && claim.exhibitEvidenceId ? [claim.exhibitEvidenceId] : [])
      .map((id) => evidenceById.get(id))
      .filter((item): item is EvidenceRef => Boolean(item))
    const claimDerived = claim.numbers
      .map((number) => (number.derivedId ? memo.derived.find((item) => item.id === number.derivedId) : undefined))
      .filter((item): item is DerivedNumber => Boolean(item))
    for (const token of bindNumbers(claim.text, claimEvidence, claimDerived).unbound) {
      numberViolations.push({ display: token.raw, reason: `claim ${claim.id} carries an unsourced number` })
    }
    if (claim.type === 'fact' && claim.unverifiable && !statesUnverifiable(claim.text, memo.lang)) {
      numberViolations.push({ display: claim.id, reason: 'gap claim does not state that it is unverifiable' })
    }
  }

  // Per-claim binding cannot see numbers the *rendering* introduces — section
  // headings restate a model-written sub-question, source titles come from the
  // filing's own first line. Sweep the finished document against the sources so
  // nothing enters the memo through a seam that no claim owns.
  const allowed = memo.derived.flatMap((item) => extractNumbers(item.display))
  // Claim anchors (`[C-D]`) are structural markup, not content. They are
  // digit-free by construction (see ids.ts), but masking keeps the sweep honest
  // if that ever changes. Source URLs are addresses, not assertions: a filing's
  // own permalink (`…announcementId=1225472188`) is metadata the source handed
  // us, and reading its query string as a financial figure is a category error.
  const prosePlain = maskNonContent(markdown)
  for (const violation of verifyNumbers(prosePlain, documents.map((item) => item.text), allowed).violations) {
    if (violation.severity !== 'high') continue
    numberViolations.push({
      display: violation.token.raw,
      reason: `rendered memo carries a number no source supports (${violation.kind})`,
    })
  }

  return {
    passed: contractViolations.length === 0 && compliance.hits.length === 0 && numberViolations.length === 0,
    contractViolations,
    complianceHits: compliance.hits.map((hit) => ({ rule: hit.rule, match: hit.match })),
    numberViolations,
  }
}

interface ExhibitSelection {
  evidence: EvidenceRef
  detail: string
}

/** Select R1 rejected evidence before falling back to the nearest source passage. */
function selectExhibit(
  question: { id: string; text: string },
  input: ComposeInput,
): ExhibitSelection | undefined {
  const forbidden = input.skill?.forbidden_reinforce ?? []
  const evidenceById = new Map(
    [...input.evidence, ...input.pool.items].map((item) => [item.id, item]),
  )
  const wanted = keyUnits(question.text)
  const r1: {
    evidence: EvidenceRef
    round: RejectedClaim['round']
    claimCoverage: number
    shared: number
  }[] = []

  for (const rejected of input.rejected ?? []) {
    if (rejected.questionId !== question.id) continue
    const claimCoverage = coverage(question.text, rejected.text)
    for (const evidenceId of rejected.evidenceIds ?? []) {
      const evidence = evidenceById.get(evidenceId)
      if (!evidence || !scanCompliance(evidence.quote, input.lang, forbidden).passed) continue
      const units = semanticUnits(evidence.quote)
      const shared = wanted.filter((unit) => units.has(unit)).length
      r1.push({ evidence, round: rejected.round, claimCoverage, shared })
    }
  }

  const roundRank = (round: RejectedClaim['round']): number =>
    round === 'repair' ? 0 : round === 'initial' ? 1 : 2
  r1.sort(
    (left, right) =>
      roundRank(left.round) - roundRank(right.round) ||
      right.claimCoverage - left.claimCoverage ||
      right.shared - left.shared ||
      left.evidence.id.localeCompare(right.evidence.id),
  )
  const rejectedEvidence = r1[0]
  if (rejectedEvidence) {
    return {
      evidence: rejectedEvidence.evidence,
      detail: `R1 round=${rejectedEvidence.round ?? 'unspecified'}, claimCoverage=${rejectedEvidence.claimCoverage.toFixed(4)}, sharedKeyUnits=${rejectedEvidence.shared}, evidenceId=${rejectedEvidence.evidence.id}`,
    }
  }

  const nearest = selectNearestPassage(
    input.documents,
    question.text,
    (quote) => scanCompliance(quote, input.lang, forbidden).passed,
  )
  if (!nearest) return undefined
  const evidence = locateSupport(nearest, input.documents, input.pool)
  if (!evidence) return undefined
  return {
    evidence,
    detail: `R2 sharedKeyUnits=${nearest.shared}, length=${nearest.text.length}, documentId=${nearest.documentId}, evidenceId=${evidence.id}`,
  }
}

/**
 * Headings restate the user's question, and a question can contain the very
 * speech act the memo may not perform ("现在该不该清仓?"). Quoting it and
 * naming it as the user's words is the documented exemption (restatement inside
 * quotation marks), applied only when the raw heading would otherwise fire.
 *
 * @param text - the sub-question text.
 * @param lang - locale whose rules apply.
 * @returns a heading that passes the compliance scan.
 */
/**
 * Locate a supporting passage and intern it as evidence.
 *
 * Goes through the same `locateQuote` path as any citation, so a gap's support
 * is the document's own characters at real offsets — not a passage the selector
 * believed it saw.
 *
 * @param support - the chosen passage and its document.
 * @param documents - retrieved documents.
 * @param pool - evidence id allocator.
 * @returns the interned evidence, or `undefined` if it will not locate.
 */
function locateSupport(
  support: { documentId: string; text: string },
  documents: SourceDocument[],
  pool: EvidencePool,
): EvidenceRef | undefined {
  const document = documents.find((item) => item.id === support.documentId)
  if (!document) return undefined
  const at = locateQuote(document.text, support.text)
  if (!at) return undefined
  const declaredUnits = detectUnitHints(document.text)
  return pool.intern({
    documentId: document.id,
    sourceLabel: document.title,
    quote: at.quote,
    charStart: at.charStart,
    charEnd: at.charEnd,
    retrievedAt: new Date().toISOString(),
    ...(declaredUnits.length > 0 ? { declaredUnits } : {}),
  })
}

/** The refusal line is present only for advice-seeking questions. */
function refusalOption(intent: Intent, lang: MeridianLang): { refusal?: string } {
  return intent.seeksAdvice ? { refusal: STRINGS[lang].advisoryRefusal } : {}
}

function safeHeading(text: string, lang: MeridianLang): string {
  if (scanCompliance(text, lang).passed) return text
  const prefix = lang === 'en' ? 'The user asked' : lang === 'zh-TW' ? '用戶提問' : '用户提问'
  return `${prefix}:「${quotable(text)}」`
}

/**
 * Strip sentence terminators from text about to be quoted inside a sentence.
 *
 * Without this, a quoted question ("现在该不该清仓?") ends its enclosing
 * sentence at its own question mark, and the words that make the quotation a
 * restatement rather than a recommendation land in the *next* sentence — where
 * the compliance scan can no longer see them.
 *
 * @param text - text to embed in quotation marks.
 * @returns the same text with sentence-ending punctuation removed.
 */
function quotable(text: string): string {
  return text.replace(/[。！？!?；;\n]+/g, ' ').replace(/\s+/g, ' ').trim()
}

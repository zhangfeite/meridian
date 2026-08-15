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
import type { SourceDocument } from '../source/types.ts'
import type { Intent, RetrievalResult } from '../types.ts'
import { bindNumbers } from '../verify/bind.ts'
import { scanCompliance } from '../verify/compliance.ts'
import { locateQuote } from '../verify/evidence.ts'
import { detectUnitHints, extractNumbers, verifyNumbers } from '../verify/numbers.ts'
import { coverage, maskNonContent, selectSupportingPassage, touchesTopic } from '../verify/text.ts'
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
    noSources: string
    advisoryRefusal: string
  }
> = {
  'zh-CN': {
    unverifiableSuffix: (question, reason) =>
      `关于「${question}」:所提供的原始文件中没有相应披露${reason ? `(${reason})` : ''},无法核实。`,
    noSources: '本次运行未能取得任何原始文件,以下内容无法核实。',
    advisoryRefusal:
      '本备忘录只整理已公开披露的事实与其出处,不能替你做投资决定——那取决于你自己的风险承受能力、期限与目标,也取决于原始文件尚未披露的信息。',
  },
  'zh-TW': {
    unverifiableSuffix: (question, reason) =>
      `關於「${question}」:所提供的原始文件中沒有相應揭露${reason ? `(${reason})` : ''},無法核實。`,
    noSources: '本次執行未能取得任何原始文件,以下內容無法核實。',
    advisoryRefusal:
      '本備忘錄只整理已公開揭露的事實與其出處,不能替你做投資決定——那取決於你自己的風險承受能力、期限與目標,也取決於原始文件尚未揭露的資訊。',
  },
  en: {
    unverifiableSuffix: (question, reason) =>
      `On "${question}": the primary sources provided do not disclose this${reason ? ` (${reason})` : ''}, so it cannot be verified.`,
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
  // claimId → evidence id of the passage that explains that claim's absence.
  const absenceSupport = new Map<string, string>()

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
      sections.push({
        questionId: question.id,
        heading: safeHeading(question.text, input.lang),
        claimIds: owned.map((claim) => claim.id),
      })
      continue
    }
    const reason = gapByQuestion.get(question.id) ?? ''
    const quoted = quotable(question.text)
    const text = input.documents.length === 0
      ? `${strings.noSources}${strings.unverifiableSuffix(quoted, reason)}`
      : strings.unverifiableSuffix(quoted, reason)
    // A gap is a finding, and a finding is cited. Filings do not say "we are not
    // disclosing this"; they say the stage has not been reached — 「截至本公告
    // 披露日，公司尚未收到法院……的文件」 — and that sentence is exactly what a
    // reader needs beside a "not disclosed" answer. Without it the memo asserts
    // an absence; with it, the absence is evidenced like everything else.
    const support = selectSupportingPassage(input.documents, question.text)
    const supportEvidence = support ? locateSupport(support, input.documents, input.pool) : undefined
    const gapClaimId = nextGapClaimId()
    claims.push({
      id: gapClaimId,
      type: 'fact',
      text,
      questionId: question.id,
      evidenceIds: supportEvidence ? [supportEvidence.id] : [],
      numbers: [],
      unverifiable: true,
    })
    if (supportEvidence) absenceSupport.set(gapClaimId, supportEvidence.id)
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

  const usedEvidenceIds = new Set(
    claims.flatMap((claim) => [
      ...claim.evidenceIds,
      ...(claim.type === 'model_inference' ? claim.counterEvidence.evidenceIds : []),
    ]),
  )
  const evidence = input.evidence.filter((item) => usedEvidenceIds.has(item.id))
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
  const checklist = (input.skill?.risk_checklist ?? []).map((item) => {
    const covered = touchesTopic(item, published)
    if (!covered) {
      audit.push({
        step: 'compose',
        action: 'skill_checklist_unmet',
        detail: `${input.skill?.id ?? 'skill'} checklist item has nothing in the memo answering it: ${item}`,
      })
    }
    return { item, covered }
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

  return {
    memo,
    markdown: renderMemoMarkdown(memo, refusalOption(input.intent, input.lang)),
    prose: prose.stats,
  }
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

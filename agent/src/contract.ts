/**
 * The Meridian content contract (PRD §4.3) as a data structure.
 *
 * Every sentence a Meridian memo publishes carries a type. Three of the four
 * types are cheap; the fourth — `model_inference` — is where a financial agent
 * usually starts lying, so it is the one the type system makes expensive:
 * evidence ids, a time range, explicit assumptions, a confidence level, and a
 * **counter-evidence slot**. Step 6 of the pipeline exists to fill that slot; a
 * slot that cannot be filled downgrades or deletes the claim (never publishes).
 *
 * Nothing here talks to a model, a network, or a file. It is the vocabulary the
 * rest of the pipeline is checked against.
 *
 * @module @meridian/agent/contract
 */

import type { UnitHint } from './verify/numbers.ts'

/** Output languages Meridian ships in (mirrors the kernel-adapter contract). */
export type MeridianLang = 'zh-CN' | 'zh-TW' | 'en'

/** The four — and only four — sentence types a memo may contain. */
export type ClaimType = 'fact' | 'attributed_opinion' | 'model_inference' | 'scenario'

/** Coarse confidence buckets. Deliberately not a percentage: a model's numeric
 * self-confidence is false precision, and false precision is what we sell against. */
export type Confidence = 'low' | 'medium' | 'high'

/**
 * One verbatim passage from one primary source.
 *
 * `quote` is required to be a byte-for-byte substring of the document it cites;
 * {@link verifyEvidence} enforces that, so an evidence object in a published
 * memo is never a paraphrase.
 */
export interface EvidenceRef {
  id: string
  /** {@link SourceDocument.id} this passage came from. */
  documentId: string
  /** Verbatim passage. Must occur in the document text. */
  quote: string
  /** Character offset of `quote` in the document (−1 when not located). */
  charStart: number
  charEnd: number
  /** Human-readable provenance, e.g. `巨潮 · 龙元建设 2026-08-14 公告`. */
  sourceLabel: string
  /** ISO-8601 retrieval time — a memo is a point-in-time artifact. */
  retrievedAt: string
  /**
   * Units the source document declares for whole tables (`单位:人民币万元`).
   * A bare figure inside the quote may be published with one of these units and
   * with no other; see {@link UnitHint}.
   */
  declaredUnits?: UnitHint[]
}

/** A number appearing in claim text, bound to how it was validated. */
export interface NumberRef {
  /** Canonical token as rendered in the claim, e.g. `8,815.45 万元`. */
  display: string
  /** How this number earned its place in the memo. */
  provenance: 'verbatim' | 'derived'
  /** For `verbatim`: the evidence id whose quote contains it. */
  evidenceId?: string
  /** For `derived`: the {@link DerivedNumber} id computed by the pipeline. */
  derivedId?: string
  /**
   * Set when the figure was verbatim in the quote but its unit came from the
   * document's own declaration, e.g. `单位:人民币万元`. Auditable on purpose:
   * a reader can see exactly which half of the number came from where.
   */
  unitFrom?: string
}

/** Fields every claim carries. */
export interface ClaimBase {
  id: string
  text: string
  /** The planned sub-question this claim answers. */
  questionId: string
  evidenceIds: string[]
  numbers: NumberRef[]
}

/** Checkable against the source, verbatim. The default and the majority. */
export interface FactClaim extends ClaimBase {
  type: 'fact'
  /**
   * The no-answer discipline (PRD §4.1). `true` means the pipeline looked and
   * the sources do not disclose it. Such a claim is the ONLY claim allowed to
   * carry no evidence, and its text must say so plainly.
   */
  unverifiable?: boolean
}

/** Somebody else's opinion, with that somebody named. */
export interface AttributedOpinionClaim extends ClaimBase {
  type: 'attributed_opinion'
  /** Who said it. Empty attribution is a contract violation, not a style issue. */
  attribution: string
}

/** The model's own reasoning. The expensive type. */
export interface ModelInferenceClaim extends ClaimBase {
  type: 'model_inference'
  /** Period the inference is about, e.g. `2026H1` or `2026-08-13 起至公告日`. */
  timeRange: string
  /** Assumptions that, if false, break the inference. At least one. */
  assumptions: string[]
  confidence: Confidence
  /** Filled by pipeline step 6. Publishing requires `status: 'filled'`. */
  counterEvidence: CounterEvidenceSlot
}

/** A conditional projection. Never a prediction, always a trigger. */
export interface ScenarioClaim extends ClaimBase {
  type: 'scenario'
  /** Observable conditions under which the scenario would begin to hold. */
  triggers: string[]
}

/** Result of the counter-evidence search for one inference. */
export interface CounterEvidenceSlot {
  status: 'filled' | 'not_found' | 'pending'
  /** Evidence ids pointing at passages that weaken the inference. */
  evidenceIds: string[]
  /** What was searched and what was concluded — auditable either way. */
  note: string
}

export type Claim = FactClaim | AttributedOpinionClaim | ModelInferenceClaim | ScenarioClaim

/** A number the pipeline computed itself, never one a model reported. */
export interface DerivedNumber {
  id: string
  label: string
  /** Supported deterministic operations; see `verify/derive.ts`. */
  op: 'ratio' | 'sum' | 'difference' | 'product' | 'quotient'
  /** Inputs as canonical decimal strings, each traceable to evidence or to another derivation. */
  inputs: DerivedInput[]
  /** Computed by the pipeline. */
  value: string
  /** Rendered by the pipeline (never by the model), e.g. `81.67%`. */
  display: string
  unit: string
  /** Human-readable derivation, e.g. `7,199.78 / 8,815.45`. */
  formula: string
  /**
   * Relative uncertainty, as a decimal string (`0.0014` = 0.14%).
   *
   * A figure printed as `3.62 元/股` states a quantity in [3.615, 3.625) — the
   * filing rounded it. Dividing two such figures compounds that: this carries a
   * first-order upper bound (relative errors add under × and ÷, absolute errors
   * add under + and −) so a reader can see how much of "≈1.99×" is real.
   */
  tolerance: string
  /**
   * Absolute half-width of the result's interval, in the result's own unit.
   *
   * Authoritative where `tolerance` cannot be: a result of exactly zero has no
   * relative uncertainty, but `0.00 万元` still means ±50 元.
   */
  uncertainty: string
  /** Derivations this one consumes, if any. */
  dependsOn: string[]
  /** 1 for a derivation over quoted figures; one more per chain link. */
  depth: number
}

/** One operand of a derived number: a quoted figure, or another derivation's output. */
export interface DerivedInput {
  /** Canonical decimal string. */
  value: string
  unit: string
  /** Verbatim rendering in the source, e.g. `7,199.78 万元`. */
  display: string
  /** Evidence whose quote contains this operand verbatim. Leaf operands only. */
  evidenceId?: string
  /** Derivation this operand is the output of. Chained operands only. */
  derivedId?: string
}

/** One question from the research plan, and the claims that answer it. */
export interface MemoSection {
  questionId: string
  heading: string
  claimIds: string[]
  /** Set when retrieval or extraction could not answer this question at all. */
  gap?: string
}

/**
 * One paragraph of memo prose.
 *
 * Prose is the readable surface, but it is not free text: it is assembled from
 * claims, and it keeps pointing at them. `claimIds` is the anchor set — every
 * number in `text` must bind to the evidence of one of these claims, which is
 * what stops a polishing pass from quietly inventing a figure.
 */
export interface NarrativeParagraph {
  text: string
  /** Claims this paragraph is built from. Never empty. */
  claimIds: string[]
  /** False when the polish pass was rejected and the deterministic draft stands. */
  polished: boolean
  /** Sub-question this paragraph belongs to, for `findings` blocks. */
  questionId?: string
}

/** One prose section of the memo. */
export interface NarrativeBlock {
  kind: 'conclusion' | 'findings' | 'risks'
  heading: string
  paragraphs: NarrativeParagraph[]
}

/** A primary source consulted for this memo. */
export interface SourceRef {
  documentId: string
  /**
   * Digit-free label this memo cites the document by (`S-A`, `S-B`, …).
   *
   * A multi-document memo has to say which filing each quote came from, and it
   * has to say it in a form a reader and a machine resolve the same way. The
   * sigil is defined once in the sources list — where it carries the title, the
   * provider, the id, and the URL — and used at every citation site.
   */
  sigil: string
  /**
   * Path a reviewer opens to re-check a citation, when the source has one
   * (`context/announcement.txt`). Published in the legend beside the sigil, so
   * "which filing said this" is resolvable without the JSON.
   */
  locator?: string
  title: string
  provider: string
  url?: string
  publishedAt?: string
  retrievedAt: string
  /** SHA-256 of the retrieved text: the memo is reproducible against it. */
  contentSha256: string
}

/** One recorded pipeline intervention. Everything dropped leaves a trace. */
export interface AuditRecord {
  step: string
  action:
    | 'claim_rejected_unverifiable_quote'
    | 'claim_rejected_unregistered_number'
    | 'claim_downgraded_no_counter_evidence'
    | 'claim_dropped_no_counter_evidence'
    | 'claim_dropped_compliance'
    | 'prose_polish_rejected'
    | 'gap_recorded'
    /** A declared gap that gap review overturned: the sources did answer it. */
    | 'gap_reopened'
    /** A skill checklist item with nothing in the memo answering it. */
    | 'skill_checklist_unmet'
    /** A figure the recipe requires that no derivation produced. */
    | 'skill_derivation_unmet'
    | 'retrieval_failed'
    | 'derived_number_rejected'
  detail: string
  claimId?: string
}

/** Gate result attached to every published memo. */
export interface GateResult {
  passed: boolean
  contractViolations: ContractViolation[]
  complianceHits: { rule: string; match: string }[]
  numberViolations: { display: string; reason: string }[]
}

/** One structural breach of the content contract. */
export interface ContractViolation {
  claimId?: string
  code: string
  message: string
}

/** The memo. Markdown is a rendering of this; this is the artifact. */
export interface Memo {
  schemaVersion: 'meridian-memo-v1'
  generatedAt: string
  lang: MeridianLang
  question: string
  taskId?: string
  entity: { name: string; symbol?: string; market?: string }
  /**
   * The readable memo: conclusion, findings, risks. Assembled from `claims` and
   * anchored back to them. Empty when nothing survived verification.
   */
  narrative: NarrativeBlock[]
  sections: MemoSection[]
  claims: Claim[]
  evidence: EvidenceRef[]
  derived: DerivedNumber[]
  sources: SourceRef[]
  /** Questions the sources could not answer. Published, not hidden. */
  openQuestions: string[]
  audit: AuditRecord[]
  gate: GateResult
  /** Which model and pipeline produced this. */
  provenance: {
    pipeline: string
    model: string
    dataSource: string
    retrieval: 'direct' | 'kernel'
    kernel?: string
    /** The analysis recipe applied, and how it was chosen. */
    skill?: { id: string; version: string; selection: 'explicit' | 'matched' | 'fallback' }
  }
  /**
   * Whether each of the skill's risk-checklist items found a home in the memo.
   *
   * An unmet item is not a failure — some checks do not apply to a given filing.
   * It is a disclosure: the recipe said to look, and this is what looking found.
   */
  checklist?: { item: string; covered: boolean }[]
}

/** Markers that make a no-answer statement machine-checkable in all three languages. */
export const UNVERIFIABLE_MARKERS: Record<MeridianLang, string[]> = {
  'zh-CN': ['无法核实', '来源未披露', '公告未披露', '原文未提及'],
  'zh-TW': ['無法核實', '來源未披露', '公告未披露', '原文未提及'],
  en: ['cannot be verified', 'not disclosed', 'the source does not state'],
}

/** True when `text` plainly says the sources do not answer the question. */
export function statesUnverifiable(text: string, lang: MeridianLang): boolean {
  return UNVERIFIABLE_MARKERS[lang].some((marker) =>
    text.toLowerCase().includes(marker.toLowerCase()),
  )
}

/**
 * Broader than {@link statesUnverifiable}: does this sentence *answer by saying
 * nothing was disclosed*, however it is phrased?
 *
 * The strict marker list gates a contract rule and must stay narrow. This one
 * classifies, and it has to catch the model's own wording — 「未披露具体金额」,
 * 「尚未确定」 — because an absence answer owes the reader a citation of what the
 * filing *does* say whether the pipeline wrote it or the model did.
 */
const ABSENCE_PHRASING: Record<MeridianLang, RegExp> = {
  'zh-CN': /(未披露|未提及|未指定|未确定|未明确|未说明|尚未|暂未|暂无|尚无|无法核实|没有披露)/,
  'zh-TW': /(未揭露|未披露|未提及|未指定|未確定|未明確|未說明|尚未|暫未|暫無|尚無|無法核實|沒有揭露)/,
  en: /\b(?:not disclosed|does not disclose|not stated|not specified|not yet|cannot be verified|no such|undetermined)\b/i,
}

/** True when the claim answers its question with a non-disclosure. */
export function readsAsAbsence(text: string, lang: MeridianLang): boolean {
  return ABSENCE_PHRASING[lang].test(text)
}

/**
 * Structural validation of the content contract. Pure, deterministic, and the
 * thing the gate runs before a memo is allowed to exist.
 *
 * @param memo - the memo to check.
 * @returns every violation found; an empty array means the memo is publishable
 *   as far as *structure* is concerned (compliance and numbers are separate gates).
 */
export function validateContract(memo: Memo): ContractViolation[] {
  const violations: ContractViolation[] = []
  const evidenceById = new Map(memo.evidence.map((item) => [item.id, item]))
  const derivedById = new Map(memo.derived.map((item) => [item.id, item]))
  const seenClaimIds = new Set<string>()
  const claimById = new Map(memo.claims.map((claim) => [claim.id, claim]))

  for (const claim of memo.claims) {
    if (seenClaimIds.has(claim.id)) {
      violations.push({ claimId: claim.id, code: 'duplicate_claim_id', message: 'claim id repeats' })
    }
    seenClaimIds.add(claim.id)

    if (!claim.text.trim()) {
      violations.push({ claimId: claim.id, code: 'empty_claim', message: 'claim text is empty' })
    }

    for (const evidenceId of claim.evidenceIds) {
      if (!evidenceById.has(evidenceId)) {
        violations.push({
          claimId: claim.id,
          code: 'dangling_evidence',
          message: `evidence '${evidenceId}' is not in the memo`,
        })
      }
    }

    for (const number of claim.numbers) {
      if (number.provenance === 'verbatim') {
        if (!number.evidenceId || !evidenceById.has(number.evidenceId)) {
          violations.push({
            claimId: claim.id,
            code: 'unbound_number',
            message: `number '${number.display}' claims verbatim provenance without evidence`,
          })
        }
      } else if (!number.derivedId || !derivedById.has(number.derivedId)) {
        violations.push({
          claimId: claim.id,
          code: 'unbound_number',
          message: `number '${number.display}' claims derived provenance without a registered derivation`,
        })
      }
    }

    switch (claim.type) {
      case 'fact': {
        const allowedEmpty = claim.unverifiable === true
        if (claim.evidenceIds.length === 0 && !allowedEmpty) {
          violations.push({
            claimId: claim.id,
            code: 'fact_without_evidence',
            message: 'a fact must cite at least one passage',
          })
        }
        if (allowedEmpty && !statesUnverifiable(claim.text, memo.lang)) {
          violations.push({
            claimId: claim.id,
            code: 'silent_gap',
            message: 'an unverifiable fact must say so in its own text',
          })
        }
        break
      }
      case 'attributed_opinion': {
        if (!claim.attribution.trim()) {
          violations.push({
            claimId: claim.id,
            code: 'unattributed_opinion',
            message: 'attributed_opinion needs a named speaker',
          })
        }
        if (claim.evidenceIds.length === 0) {
          violations.push({
            claimId: claim.id,
            code: 'opinion_without_evidence',
            message: 'attributed_opinion must cite where the opinion was stated',
          })
        }
        break
      }
      case 'model_inference': {
        if (claim.evidenceIds.length === 0) {
          violations.push({
            claimId: claim.id,
            code: 'inference_without_evidence',
            message: 'model_inference must bind at least one evidence id',
          })
        }
        if (!claim.timeRange.trim()) {
          violations.push({
            claimId: claim.id,
            code: 'inference_without_time_range',
            message: 'model_inference must state the period it is about',
          })
        }
        if (claim.assumptions.filter((item) => item.trim()).length === 0) {
          violations.push({
            claimId: claim.id,
            code: 'inference_without_assumptions',
            message: 'model_inference must state at least one assumption',
          })
        }
        if (claim.counterEvidence.status !== 'filled' || claim.counterEvidence.evidenceIds.length === 0) {
          violations.push({
            claimId: claim.id,
            code: 'inference_without_counter_evidence',
            message:
              'model_inference reached the memo with an unfilled counter-evidence slot; it must be downgraded or dropped',
          })
        }
        for (const evidenceId of claim.counterEvidence.evidenceIds) {
          if (!evidenceById.has(evidenceId)) {
            violations.push({
              claimId: claim.id,
              code: 'dangling_counter_evidence',
              message: `counter-evidence '${evidenceId}' is not in the memo`,
            })
          }
        }
        break
      }
      case 'scenario': {
        if (claim.triggers.filter((item) => item.trim()).length === 0) {
          violations.push({
            claimId: claim.id,
            code: 'scenario_without_trigger',
            message: 'scenario must state at least one observable trigger',
          })
        }
        if (claim.evidenceIds.length === 0) {
          violations.push({
            claimId: claim.id,
            code: 'scenario_without_evidence',
            message: 'scenario must be anchored to at least one disclosed fact',
          })
        }
        break
      }
    }
  }

  for (const section of memo.sections) {
    for (const claimId of section.claimIds) {
      if (!claimById.has(claimId)) {
        violations.push({
          claimId,
          code: 'dangling_section_claim',
          message: `section '${section.questionId}' references a claim that is not in the memo`,
        })
      }
    }
    if (section.claimIds.length === 0 && !section.gap) {
      violations.push({
        code: 'empty_section',
        message: `section '${section.questionId}' has neither claims nor a recorded gap`,
      })
    }
  }

  for (const block of memo.narrative) {
    for (const paragraph of block.paragraphs) {
      if (!paragraph.text.trim()) {
        violations.push({ code: 'empty_paragraph', message: `${block.kind} block has an empty paragraph` })
      }
      if (paragraph.claimIds.length === 0) {
        violations.push({
          code: 'unanchored_prose',
          message: `${block.kind} paragraph cites no claim: prose must stay anchored`,
        })
      }
      for (const claimId of paragraph.claimIds) {
        if (!claimById.has(claimId)) {
          violations.push({
            claimId,
            code: 'dangling_prose_anchor',
            message: `${block.kind} paragraph anchors to a claim that is not in the memo`,
          })
        }
      }
    }
  }

  const sourceIds = new Set(memo.sources.map((item) => item.documentId))
  for (const evidence of memo.evidence) {
    if (!sourceIds.has(evidence.documentId)) {
      violations.push({
        code: 'evidence_without_source',
        message: `evidence '${evidence.id}' cites document '${evidence.documentId}', which is not in the sources list`,
      })
    }
  }

  return violations
}

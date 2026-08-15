/**
 * Intermediate artifacts of the seven-step pipeline.
 *
 * Every step's output is a value, kept in {@link PipelineTrace}, and inspectable
 * after the run (PRD §5 module A: "每步产出中间产物可检查"). Nothing is hidden
 * inside a conversation transcript.
 *
 * @module @meridian/agent/types
 */

import type { Claim, EvidenceRef, MeridianLang } from './contract.ts'
import type { SourceDocument } from './source/types.ts'

/** What kind of research question this is. Mirrors the Bench task taxonomy. */
export type QuestionType =
  | 'fact_extraction'
  | 'metric_calc'
  | 'event_interpretation'
  | 'risk_identification'
  | 'inducement_resistance'

/** Step 1 output. */
export interface Intent {
  entity: { name: string; symbol?: string; market?: string }
  lang: MeridianLang
  questionType: QuestionType
  /** The question decomposed into answerable parts. Ids are `Q1`, `Q2`, … */
  subQuestions: { id: string; text: string }[]
  /**
   * True when the user is asking for a trading decision rather than research.
   * The compose step answers those with a stated refusal plus the facts —
   * never with an action.
   */
  seeksAdvice: boolean
  /**
   * Sub-questions that asked the same thing twice and were merged into one.
   * Recorded because a merge changes what the memo's sections are, and a reader
   * comparing the recipe with the memo should be able to see why.
   */
  mergedQuestions?: { kept: string; dropped: string; text: string }[]
}

/** Step 2 output. */
export interface ResearchPlan {
  /** Documents to retrieve, with the reason each is needed. */
  documents: { documentId: string; why: string }[]
  /** Which documents each sub-question will be answered from. */
  questionPlan: { questionId: string; documentIds: string[]; approach: string }[]
  notes: string[]
}

/** Step 3 output. Failures are data, not exceptions: a gap is a finding. */
export interface RetrievalResult {
  documents: SourceDocument[]
  failures: { documentId: string; code: string; message: string }[]
  /** `direct` = the pipeline fetched the planned list; `kernel` = an agent loop chose. */
  mode: 'direct' | 'kernel'
  kernelId?: string
}

/** A claim the pipeline refused to publish, and why. */
export interface RejectedClaim {
  text: string
  reason: string
  questionId?: string
  /**
   * Which extraction round rejected it. `initial` rejections were sent back for
   * one repair attempt; they stay in the record either way, because "the model
   * proposed this and the verifier stopped it" is the audit trail, not noise.
   */
  round?: 'initial' | 'repair'
  /**
   * Figures the claim stated that its own quotes did not contain.
   *
   * Kept structurally, not just in `reason`: the repair round searches the
   * sources for these literally, which is the one lookup that works no matter
   * what language the claim and the filing are written in.
   */
  unboundNumbers?: string[]
}

/** Step 4 output. */
export interface ExtractionResult {
  claims: Claim[]
  evidence: EvidenceRef[]
  rejected: RejectedClaim[]
  /** Sub-questions the sources do not answer, with the model's stated reason. */
  gaps: { questionId: string; reason: string }[]
  /**
   * Sub-questions first reported unanswerable that the gap-review round did
   * answer. A non-empty list is the pipeline catching its own over-refusal.
   */
  gapsClosed: string[]
  /**
   * Sub-questions answered only in their general form: the rule, range or
   * procedure is disclosed and the specific quantity is not. Each one owes the
   * reader a sentence saying so, next to the answer it qualifies.
   */
  residuals?: { questionId: string; missing: string }[]
  /**
   * Citations whose span the selector moved off the model's proposal, with the
   * decision path. Replayable: same document, same claim, same choice.
   */
  spans?: { text: string; documentId: string; from: string; to: string; path: string }[]
  /**
   * Disclosures about how completely the sources were read: a truncated reply,
   * a call that failed, a document longer than the reading budget. Every one of
   * them means the memo may be missing something the filing does say.
   */
  notes?: string[]
}

/** Everything the run produced, step by step. */
export interface PipelineTrace {
  intent: Intent
  plan: ResearchPlan
  retrieval: RetrievalResult
  extraction: ExtractionResult
  metrics: { derivedCount: number; rejected: { proposalId: string; reason: string }[] }
  counterEvidence: { inferences: number; filled: number; downgraded: number; dropped: number }
  compose: {
    claimsPublished: number
    complianceHits: number
    /** Paragraphs drafted, improved by the writing pass, and rejected by it. */
    prose: { drafted: number; polished: number; rejected: number; dropped: number }
    /** Step 7b verdict counts; absent when no recipe checklist applied. */
    checklist?: Record<string, number>
  }
  modelCalls: { step: string; inputTokens?: number; outputTokens?: number }[]
  startedAt: string
  finishedAt: string
  durationMs: number
}

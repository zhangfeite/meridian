/**
 * The seven-step research pipeline.
 *
 * ```
 * 1 intent  →  2 plan  →  3 retrieve  →  4 extract+verify  →  5 metrics  →  6 counter-evidence  →  7 compose+gate
 * ```
 *
 * Two properties are worth stating plainly, because they are what the whole
 * design is for:
 *
 * - **Every step can only remove.** After step 4, no step may introduce a
 *   sentence that has not been quote-located and number-bound. Step 5 adds
 *   figures the pipeline computed itself; step 6 deletes; step 7 assembles.
 * - **Failure degrades, it does not abort.** A source that will not load, a
 *   question the filings do not answer, an inference nobody can argue against —
 *   each becomes recorded, published text ("无法核实"), not a thrown error and
 *   not a confident guess.
 *
 * @module @meridian/agent/pipeline
 */

import { fileURLToPath } from 'node:url'
import type { AgentKernel } from '../../adapter/src/kernel.ts'
import type { AuditRecord, Claim, MeridianLang, Memo } from './contract.ts'
import { EvidencePool } from './evidence-pool.ts'
import { idAllocator } from './ids.ts'
import { touchesTopic } from './verify/text.ts'
import { SkillRegistry } from './skills/registry.ts'
import type { CompletionRequest, CompletionResult, ModelClient } from './model.ts'
import { PROMPT_SET_VERSION } from './prompts.ts'
import type { DataSource, DocumentQuery, DocumentSummary } from './source/types.ts'
import { compose } from './steps/compose.ts'
import { findCounterEvidence } from './steps/counter.ts'
import { extractAndVerify } from './steps/extract.ts'
import { computeMetrics } from './steps/metrics.ts'
import { buildPlan } from './steps/plan.ts'
import { parseIntent } from './steps/intent.ts'
import { retrieveDirect, retrieveViaKernel } from './steps/retrieve.ts'
import type { PipelineTrace } from './types.ts'

/** Pipeline version stamp recorded in memo provenance. */
export const PIPELINE_VERSION = 'meridian-agent-v0.1'

/** Where official recipes live, relative to this package. */
const DEFAULT_SKILLS_DIR = fileURLToPath(new URL('../../skills', import.meta.url))

/** One run's inputs. */
export interface PipelineOptions {
  /** The user's question, verbatim. */
  question: string
  source: DataSource
  model: ModelClient
  /** Output language. Inferred from the question's script when omitted. */
  lang?: MeridianLang
  /**
   * Supplying a kernel moves retrieval (step 3) into an agent loop: the data
   * source is registered as tools and the model chooses what to read.
   */
  kernel?: AgentKernel
  /** Restrict the catalog to these document ids. */
  documentIds?: string[]
  /** Catalog query when `documentIds` is not given. */
  catalogQuery?: DocumentQuery
  /** Bench task id, recorded on the memo. */
  taskId?: string
  /** Progress callback; receives each step name as it completes. */
  onStep?: (step: string, detail: Record<string, unknown>) => void
  /** Apply this analysis recipe instead of matching one. */
  skillId?: string
  /** Where to load recipes from (default: the repository's `meridian/skills`). */
  skillsDir?: string
  /** A pre-loaded registry, for tests and hosts that cache it. */
  skills?: SkillRegistry
  /** Set false to skip the step-7b checklist audit (default: on). */
  audit?: boolean
}

/** One run's outputs. */
export interface PipelineResult {
  memo: Memo
  markdown: string
  trace: PipelineTrace
}

/** Model wrapper that labels and totals every call for the trace. */
class InstrumentedModel implements ModelClient {
  readonly id: string
  readonly calls: { step: string; inputTokens?: number; outputTokens?: number }[] = []
  step = 'unknown'
  readonly #inner: ModelClient

  constructor(inner: ModelClient) {
    this.#inner = inner
    this.id = inner.id
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const result = await this.#inner.complete(request)
    this.calls.push({
      step: this.step,
      ...(result.usage?.inputTokens === undefined ? {} : { inputTokens: result.usage.inputTokens }),
      ...(result.usage?.outputTokens === undefined ? {} : { outputTokens: result.usage.outputTokens }),
    })
    return result
  }
}

/** Guess the output language from the question's script. */
export function inferLang(question: string): MeridianLang {
  if (/[㐀-鿿]/.test(question)) {
    // Traditional-only characters that a Simplified text would never contain.
    return /[繁體臺灣證券報導債務關於財務營業盈餘]/.test(question) ? 'zh-TW' : 'zh-CN'
  }
  return 'en'
}

/**
 * Run all seven steps.
 *
 * @param options - question, data source, model, and optional agent kernel.
 * @returns the memo, its Markdown rendering, and the full step-by-step trace.
 */
export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const startedAt = new Date()
  const lang = options.lang ?? inferLang(options.question)
  const model = new InstrumentedModel(options.model)
  const report = options.onStep ?? (() => {})
  const audit: AuditRecord[] = []

  // Step 0: what can this run even see?
  let catalog: DocumentSummary[] = []
  try {
    catalog = await options.source.listDocuments(options.catalogQuery ?? {})
  } catch (error) {
    audit.push({
      step: 'catalog',
      action: 'retrieval_failed',
      detail: `listDocuments failed: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
  if (options.documentIds) {
    const wanted = new Set(options.documentIds)
    const listed = catalog.filter((item) => wanted.has(item.id))
    // Ids the caller named but the catalog did not list are still offered to the
    // plan; `getDocument` decides whether they exist, and a miss is a gap.
    for (const id of wanted) {
      if (!listed.some((item) => item.id === id)) {
        listed.push({ id, title: id, provider: options.source.id })
      }
    }
    catalog = listed
  }

  // Choose the analysis recipe before the plan is made, from the question and
  // the catalog's titles — a filing announces what it is on its first line, and
  // matching after retrieval would be too late to shape the sub-questions.
  const registry = options.skills ?? SkillRegistry.load(options.skillsDir ?? DEFAULT_SKILLS_DIR)
  for (const problem of registry.errors) {
    audit.push({
      step: 'skill',
      action: 'retrieval_failed',
      detail: `skill '${problem.skillId}' ignored (${problem.field}): ${problem.message}`,
    })
  }
  const choice = registry.select(
    options.question,
    catalog.map((item) => `${item.title} ${item.docType ?? ''}`).join('\n'),
    options.skillId,
  )
  report('skill', { id: choice?.skill.id ?? null, selection: choice?.selection ?? null, score: choice?.score ?? 0 })

  // Step 1.
  model.step = 'intent'
  const intent = await parseIntent(
    options.question,
    catalog,
    model,
    lang,
    // The recipe's questions in the run's own language. Injecting 简体 into an
    // English run made the model write its own English versions, which the
    // lexical coverage check could not recognize as the same questions — so
    // both sets survived and every one of them was asked twice.
    choice?.skill.sub_questions_by_lang[lang] ?? choice?.skill.sub_questions ?? [],
  )
  for (const merge of intent.mergedQuestions ?? []) {
    audit.push({
      step: 'intent',
      action: 'sub_question_merged',
      detail: `${merge.dropped} duplicated ${merge.kept}, so it was merged: ${merge.text}`,
    })
  }
  report('intent', { subQuestions: intent.subQuestions.length, type: intent.questionType })

  // Step 2.
  model.step = 'plan'
  const plan = await buildPlan(intent, catalog, model, lang)
  report('plan', { documents: plan.documents.length })

  // Step 3.
  const retrieval = options.kernel
    ? await retrieveViaKernel(plan, intent, options.source, options.kernel)
    : await retrieveDirect(plan, options.source)
  report('retrieve', { documents: retrieval.documents.length, failures: retrieval.failures.length })

  // Steps 4-6 share id allocation so the memo's citation graph is coherent.
  const pool = new EvidencePool()
  const nextClaimId = idAllocator('C')

  model.step = 'extract'
  const extraction =
    retrieval.documents.length === 0
      ? { claims: [] as Claim[], evidence: [], rejected: [], gaps: [], gapsClosed: [], notes: [] }
      : await extractAndVerify(intent, retrieval.documents, model, lang, pool, nextClaimId, choice?.skill)
  for (const rejected of extraction.rejected) {
    audit.push({
      step: 'extract',
      action: 'claim_rejected_unverifiable_quote',
      detail: `[${rejected.round ?? 'initial'}] ${rejected.reason} — dropped: ${rejected.text}`,
    })
  }
  // How completely the sources were actually read. A memo built on a partial
  // read is still publishable — a hundred-page prospectus read in eight windows
  // is a real answer — but the reader is told which part of the reading fell
  // short, because "not disclosed" and "not read" are different sentences.
  for (const note of extraction.notes ?? []) {
    audit.push({ step: 'extract', action: 'source_read_partial', detail: note })
  }
  // The residual records themselves are written by compose, where each one is
  // tied to the claim it produced. Recording them here as well would double
  // every entry in the audit trail.
  for (const questionId of extraction.gapsClosed) {
    audit.push({
      step: 'extract',
      action: 'gap_reopened',
      detail: `${questionId} was reported unanswerable, but gap review found the answer in the sources`,
    })
  }
  report('extract', {
    claims: extraction.claims.length,
    rejected: extraction.rejected.length,
    gaps: extraction.gaps.length,
    gapsClosed: extraction.gapsClosed.length,
    ...((extraction.notes ?? []).length > 0 ? { partialReads: (extraction.notes ?? []).length } : {}),
  })

  // Step 5.
  model.step = 'metrics'
  const metrics =
    extraction.claims.length === 0
      ? { derived: [], claims: [] as Claim[], rejected: [], derivationRejections: [] }
      : await computeMetrics(intent, pool.items, model, lang, nextClaimId, choice?.skill)
  for (const rejection of metrics.derivationRejections) {
    audit.push({
      step: 'metrics',
      action: 'derived_number_rejected',
      detail: `${rejection.proposalId}: ${rejection.reason}`,
    })
  }
  for (const rejected of metrics.rejected) {
    audit.push({
      step: 'metrics',
      action: 'claim_rejected_unregistered_number',
      detail: `${rejected.reason} — dropped: ${rejected.text}`,
    })
  }
  // A recipe naming a figure is a requirement, not a hint. When the model
  // returns nothing for one, the memo says so rather than quietly omitting the
  // calculation the method promised.
  for (const required of choice?.skill.required_derivations ?? []) {
    if (metrics.derived.some((item) => touchesTopic(required.name, item.label, 0.5))) continue
    audit.push({
      step: 'metrics',
      action: 'skill_derivation_unmet',
      detail: `${choice?.skill.id}: recipe expects ${required.name} (${required.formula_hint}), and no derivation produced it`,
    })
  }
  report('metrics', { derived: metrics.derived.length, rejected: metrics.rejected.length })

  // Step 6.
  model.step = 'counter'
  const merged = [...extraction.claims, ...metrics.claims]
  const counter =
    merged.some((claim) => claim.type === 'model_inference') && retrieval.documents.length > 0
      ? await findCounterEvidence(merged, retrieval.documents, model, lang, pool)
      : { claims: merged, audit: [], stats: { inferences: 0, filled: 0, downgraded: 0, dropped: 0 } }
  audit.push(...counter.audit)
  report('counter', counter.stats)

  // Step 7.
  model.step = 'compose'
  const composed = await compose({
    intent,
    retrieval,
    documents: retrieval.documents,
    claims: counter.claims,
    evidence: pool.items,
    pool,
    derived: metrics.derived,
    gaps: extraction.gaps,
    audit,
    lang,
    question: options.question,
    ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
    provenance: {
      pipeline: `${PIPELINE_VERSION}/${PROMPT_SET_VERSION}`,
      model: options.model.id,
      dataSource: options.source.id,
      retrieval: retrieval.mode,
      ...(retrieval.kernelId === undefined ? {} : { kernel: retrieval.kernelId }),
      ...(choice
        ? { skill: { id: choice.skill.id, version: choice.skill.version, selection: choice.selection } }
        : {}),
    },
    model,
    rejected: extraction.rejected,
    ...(extraction.residuals ? { residuals: extraction.residuals } : {}),
    ...(choice ? { skill: choice.skill } : {}),
    ...(options.audit === undefined ? {} : { auditChecklist: options.audit }),
  })
  // Verdict counts, so a run can be inspected without opening the memo. The
  // lexical fallback shows up as `lexical`, which is how a reader learns the
  // audit did not run.
  const checklistCounts = (composed.memo.checklist ?? []).reduce<Record<string, number>>((counts, entry) => {
    const key = entry.source === 'lexical' ? 'lexical' : (entry.verdict ?? 'lexical')
    counts[key] = (counts[key] ?? 0) + 1
    return counts
  }, {})
  report('compose', {
    claims: composed.memo.claims.length,
    prose: composed.prose,
    gatePassed: composed.memo.gate.passed,
    ...(composed.memo.checklist ? { checklist: checklistCounts } : {}),
  })

  const finishedAt = new Date()
  const trace: PipelineTrace = {
    intent,
    plan,
    retrieval,
    extraction,
    metrics: { derivedCount: metrics.derived.length, rejected: metrics.derivationRejections },
    counterEvidence: counter.stats,
    compose: {
      claimsPublished: composed.memo.claims.length,
      complianceHits: composed.memo.gate.complianceHits.length,
      prose: composed.prose,
      ...(composed.memo.checklist ? { checklist: checklistCounts } : {}),
    },
    modelCalls: model.calls,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  }

  return { memo: composed.memo, markdown: composed.markdown, trace }
}

/**
 * Read the checklist-audit switch out of the environment.
 *
 * Step 7b costs one model call per memo, so a host paying per token can turn it
 * off without touching code. Every entry point reads it through this function so
 * `MERIDIAN_AUDIT=off` means the same thing in the CLI, the bench adapter and
 * the web server.
 *
 * @param env - environment to read.
 * @returns false when the audit is switched off, true otherwise.
 */
export function auditEnabled(env: NodeJS.ProcessEnv): boolean {
  return !['off', '0', 'false', 'no'].includes((env.MERIDIAN_AUDIT ?? '').trim().toLowerCase())
}

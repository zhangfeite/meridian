/**
 * `@meridian/agent` — Meridian's seven-step research pipeline.
 *
 * ```ts
 * const result = await runPipeline({
 *   question: '公司被申请重整的关键事实是什么?',
 *   source: FixtureSource.fromBenchTasks('../bench/tasks', ['MB-001']),
 *   model: OpenAICompatibleModel.fromEnv()!,
 * })
 * console.log(result.markdown)      // the memo
 * console.log(result.memo.gate)     // why it is publishable
 * ```
 *
 * MIT. Nothing here imports a Periscope service or a model harness: data comes
 * through {@link DataSource}, the model through {@link ModelClient}, and the
 * optional agent loop through `@meridian/kernel-adapter`'s `AgentKernel`.
 *
 * @module @meridian/agent
 */

export { PIPELINE_VERSION, inferLang, runPipeline } from './pipeline.ts'
export type { PipelineOptions, PipelineResult } from './pipeline.ts'

export { renderMemoMarkdown } from './render.ts'
export type { RenderOptions } from './render.ts'

export {
  UNVERIFIABLE_MARKERS,
  statesUnverifiable,
  validateContract,
} from './contract.ts'
export type {
  AttributedOpinionClaim,
  AuditRecord,
  Claim,
  ClaimType,
  Confidence,
  ContractViolation,
  CounterEvidenceSlot,
  DerivedInput,
  DerivedNumber,
  EvidenceRef,
  FactClaim,
  GateResult,
  Memo,
  MemoSection,
  MeridianLang,
  ModelInferenceClaim,
  NumberRef,
  ScenarioClaim,
  SourceRef,
} from './contract.ts'

export { ModelError, OpenAICompatibleModel, ScriptedModel, parseJsonReply } from './model.ts'
export type { CompletionRequest, CompletionResult, ModelClient } from './model.ts'

export { DataSourceError } from './source/types.ts'
export type {
  DataSource,
  DataSourceErrorCode,
  DocumentQuery,
  DocumentSummary,
  InstrumentSummary,
  SourceDocument,
} from './source/types.ts'
export { FixtureSource } from './source/fixture.ts'
export type { FixtureEntry, FixtureSourceOptions } from './source/fixture.ts'
export { EdgarSource, htmlToText } from './source/edgar.ts'
export type { EdgarSourceOptions, FetchLike } from './source/edgar.ts'
export { PeriscopeSource } from './source/periscope.ts'
export type { PeriscopeSourceOptions } from './source/periscope.ts'

export { createCollector, dataSourceTools } from './kernel-tools.ts'
export type { RetrievalCollector } from './kernel-tools.ts'

export { scanCompliance } from './verify/compliance.ts'
export type { ComplianceHit, ComplianceResult } from './verify/compliance.ts'
export { detectUnitHints, extractNumbers, matchesToken, verifyNumbers } from './verify/numbers.ts'
export type { NumberToken, NumberVerification, NumberViolation, UnitHint } from './verify/numbers.ts'
export { computeDerivations } from './verify/derive.ts'
export type { DerivationProposal, DerivationResult } from './verify/derive.ts'
export { bindNumbers } from './verify/bind.ts'
export { locateQuote } from './verify/evidence.ts'
export type { QuoteLocation } from './verify/evidence.ts'

export { SkillRegistry } from './skills/registry.ts'
export type { SkillChoice, SkillSelection } from './skills/registry.ts'
export { validateSkill } from './skills/types.ts'
export type { RequiredDerivation, Skill, SkillMatch, SkillValidationError } from './skills/types.ts'

export { EvidencePool } from './evidence-pool.ts'
export { PROMPT_SET_VERSION } from './prompts.ts'
export type {
  ExtractionResult,
  Intent,
  PipelineTrace,
  QuestionType,
  ResearchPlan,
  RetrievalResult,
} from './types.ts'

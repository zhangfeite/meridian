/**
 * `@meridian/kernel-adapter` — the agent-loop seam for Meridian.
 *
 * The financial layer imports from here and nowhere else. `DshKernel` is one
 * implementation; `MockKernel` is the test substrate and the placeholder for an
 * in-house loop if dsh's preview churn outruns its budget (PRD §8).
 *
 * @module @meridian/kernel-adapter
 */

export type {
  AgentKernel,
  AnyToolDefinition,
  JsonValue,
  KernelEvent,
  MeridianLang,
  RunEndReason,
  RunPlan,
  RunResult,
  ToolCallRecord,
  ToolDefinition,
  ToolExecutionContext,
  ToolInputSchema,
  ToolPropertySchema,
  Unregister,
} from './kernel.ts'
export {
  KernelClosedError,
  ToolRegistrationError,
  UnknownSessionError,
  applyLangContract,
  assertValidTool,
} from './kernel.ts'

export { MockKernel, heuristicToolUseScript } from './mock-kernel.ts'
export type { MockKernelOptions, MockScript, MockStep } from './mock-kernel.ts'

export { DshKernel, DshUnavailableError, dshUnavailableReason } from './dsh-kernel.ts'
export type { DshKernelOptions } from './dsh-kernel.ts'

export { EventBus, SessionLogStore, ToolRegistry } from './registry.ts'

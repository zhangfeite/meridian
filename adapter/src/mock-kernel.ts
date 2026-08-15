/**
 * `MockKernel` — an `AgentKernel` with a deterministic stub model instead of a
 * network call.
 *
 * Two jobs:
 *  1. **Test substrate.** The contract suite runs unchanged on `MockKernel` and
 *     `DshKernel`; anything only one of them satisfies is not part of the seam.
 *  2. **Fallback placeholder.** PRD §8 budgets ~2 weeks to leave dsh if its
 *     preview churn gets expensive. This file is where an in-house loop lands,
 *     and the contract suite is the acceptance bar it would have to clear.
 *
 * The stub model is NOT an LLM. It is an explicit, inspectable script: by
 * default it picks one registered tool, fills its required parameters from the
 * prompt by name-hint, calls it once, and renders the result's string leaves as
 * the final answer. Supply {@link MockKernelOptions.script} for anything else.
 *
 * @module @meridian/kernel-adapter/mock-kernel
 */

import { randomUUID } from 'node:crypto'
import {
  KernelClosedError,
  UnknownSessionError,
  applyLangContract,
  type AgentKernel,
  type AnyToolDefinition,
  type JsonValue,
  type KernelEvent,
  type RunPlan,
  type RunResult,
  type ToolCallRecord,
  type Unregister,
} from './kernel.ts'
import { EventBus, SessionLogStore, ToolRegistry } from './registry.ts'

/** One instruction of the stub model's plan. */
export type MockStep =
  | { kind: 'say'; text: string }
  | { kind: 'call'; tool: string; args: Record<string, JsonValue> }
  /** Render every tool result collected so far as the final assistant message. */
  | { kind: 'summarize'; prefix?: string }

/** A stub model: pure function from (plan, tools) to a fixed step list. */
export type MockScript = (input: {
  plan: RunPlan
  tools: AnyToolDefinition[]
}) => MockStep[]

/** Construction options. */
export interface MockKernelOptions {
  /** Implementation id reported on {@link AgentKernel.id} (default `'mock'`). */
  id?: string
  /** Stub model (default {@link heuristicToolUseScript}). */
  script?: MockScript
  /** Artificial per-step delay, for testing timeout handling. */
  stepLatencyMs?: number
}

/** Matches an A-share code (`600519`), a US ticker (`AAPL`), or `0700.HK`. */
const SYMBOL_RE = /\b(\d{6}(?:\.[A-Z]{2})?|[A-Z]{1,5}(?:\.[A-Z]{2})?)\b/

/**
 * The default stub model. Deterministic, no network, no randomness:
 *
 * - **Tool selection** — the first registered tool whose name appears verbatim in
 *   the prompt; otherwise the single registered tool; otherwise none.
 * - **Argument filling** — each required parameter is filled by name hint
 *   (`symbol`/`code`/`ticker` → the first symbol-shaped token in the prompt;
 *   `limit`/`count`/`n` → the first integer; anything else → the prompt text).
 * - **Answer** — one `summarize` step.
 *
 * @param input - the plan being run and the tools registered on the kernel.
 * @returns the step list the kernel executes in order.
 */
export const heuristicToolUseScript: MockScript = ({ plan, tools }) => {
  const named = tools.find((tool) => plan.prompt.includes(tool.name))
  const chosen = named ?? (tools.length === 1 ? tools[0] : undefined)
  if (!chosen) {
    return [{ kind: 'say', text: '[mock] no tool selected' }, { kind: 'summarize' }]
  }
  const args: Record<string, JsonValue> = {}
  for (const key of chosen.inputSchema.required ?? []) {
    const property = chosen.inputSchema.properties[key]
    if (!property) continue
    args[key] = fillParameter(key, property.type, plan.prompt)
  }
  return [
    { kind: 'call', tool: chosen.name, args },
    { kind: 'summarize' },
  ]
}

/**
 * Derive one argument value from the prompt by parameter-name hint.
 * @param key - the declared parameter name.
 * @param type - its declared JSON type.
 * @param prompt - the run prompt to mine.
 * @returns a value satisfying `type`.
 */
function fillParameter(key: string, type: string, prompt: string): JsonValue {
  const lower = key.toLowerCase()
  if (type === 'number' || type === 'integer') {
    const match = /\b\d+\b/.exec(prompt)
    return match ? Number(match[0]) : 1
  }
  if (type === 'boolean') return true
  if (/symbol|code|ticker|stock/.test(lower)) {
    const match = SYMBOL_RE.exec(prompt)
    if (match) return match[1]
  }
  return prompt
}

/** Flatten a JSON value's string leaves, preserving document order. */
function stringLeaves(value: JsonValue, sink: string[] = []): string[] {
  if (typeof value === 'string') sink.push(value)
  else if (Array.isArray(value)) for (const item of value) stringLeaves(item, sink)
  else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) stringLeaves(item, sink)
  }
  return sink
}

/** An `AgentKernel` backed by a scripted stub model. */
export class MockKernel implements AgentKernel {
  readonly id: string
  readonly #registry = new ToolRegistry()
  readonly #bus = new EventBus()
  readonly #log = new SessionLogStore()
  readonly #script: MockScript
  readonly #latency: number
  #closed = false

  /** @param options - id, stub model, and artificial latency. */
  constructor(options: MockKernelOptions = {}) {
    this.id = options.id ?? 'mock'
    this.#script = options.script ?? heuristicToolUseScript
    this.#latency = options.stepLatencyMs ?? 0
  }

  registerTool(tool: AnyToolDefinition): Unregister {
    this.#assertOpen()
    return this.#registry.register(tool)
  }

  onEvent(listener: (event: KernelEvent) => void): Unregister {
    return this.#bus.subscribe(listener)
  }

  async run(plan: RunPlan): Promise<RunResult> {
    this.#assertOpen()
    const runId = randomUUID()
    const sessionId = plan.sessionId ?? randomUUID()
    const controller = new AbortController()
    const timer =
      plan.timeoutMs === undefined
        ? undefined
        : setTimeout(() => controller.abort(), plan.timeoutMs)

    const events: KernelEvent[] = []
    const emit = (event: KernelEvent): void => {
      events.push(event)
      this.#log.append(event)
      this.#bus.emit(event)
    }

    const prompt = applyLangContract(plan.prompt, plan.lang)
    emit({ type: 'run.start', runId, sessionId, time: Date.now(), prompt })

    const toolCalls: ToolCallRecord[] = []
    let text = ''
    let reason: RunResult['reason'] = 'idle'

    try {
      const steps = this.#script({ plan: { ...plan, prompt }, tools: this.#registry.list() })
      for (const step of steps) {
        if (controller.signal.aborted) {
          reason = 'timeout'
          break
        }
        if (this.#latency > 0) await delay(this.#latency, controller.signal)

        if (step.kind === 'say') {
          text = step.text
          emit({ type: 'assistant.message', runId, sessionId, time: Date.now(), text })
          continue
        }

        if (step.kind === 'summarize') {
          const leaves = toolCalls.flatMap((call) => stringLeaves(call.result))
          text = `${step.prefix ?? '[mock] summary:'} ${leaves.join(' / ')}`.trim()
          emit({ type: 'assistant.message', runId, sessionId, time: Date.now(), text })
          continue
        }

        const callId = randomUUID()
        emit({
          type: 'tool.call',
          runId,
          sessionId,
          time: Date.now(),
          callId,
          name: step.tool,
          args: step.args,
        })
        const tool = this.#registry.get(step.tool)
        let ok = true
        let result: JsonValue
        if (!tool) {
          ok = false
          result = `no such tool: ${step.tool}`
        } else {
          try {
            result = (await tool.execute(step.args, {
              signal: controller.signal,
              runId,
              callId,
            })) as JsonValue
          } catch (error) {
            ok = false
            result = error instanceof Error ? error.message : String(error)
          }
        }
        emit({
          type: 'tool.result',
          runId,
          sessionId,
          time: Date.now(),
          callId,
          name: step.tool,
          ok,
          result,
        })
        toolCalls.push({ callId, name: step.tool, args: step.args, ok, result })
      }
    } catch (error) {
      reason = 'error'
      emit({
        type: 'error',
        runId,
        sessionId,
        time: Date.now(),
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      if (timer) clearTimeout(timer)
    }

    emit({ type: 'run.end', runId, sessionId, time: Date.now(), reason })
    return {
      runId,
      sessionId,
      text,
      toolCalls,
      events,
      reason,
      ...(plan.metadata ? { metadata: plan.metadata } : {}),
    }
  }

  async sessionLog(sessionId: string): Promise<KernelEvent[]> {
    if (!this.#log.has(sessionId)) throw new UnknownSessionError(sessionId)
    return this.#log.read(sessionId)
  }

  async close(): Promise<void> {
    this.#closed = true
  }

  #assertOpen(): void {
    if (this.#closed) throw new KernelClosedError(this.id)
  }
}

/**
 * Abortable sleep.
 * @param ms - delay in milliseconds.
 * @param signal - abort signal that settles the delay early.
 * @returns a promise resolving after `ms` or on abort.
 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/**
 * Meridian `kernel-adapter` — the ONE interface the Meridian financial layer is
 * allowed to depend on when it needs an agent loop.
 *
 * Rationale (PRD §8 / spec-meridian-s1 §3): DeepSeek Harness (`dsh`) is a
 * developer-preview product with explicitly announced breaking changes. Meridian
 * treats it as *one implementation* of the kernel seam, never as the substrate.
 * `DshKernel` is the only module in this repository permitted to import a
 * `@deepseek-ai/*` package; `scripts/check-dsh-boundary.mjs` enforces that in CI.
 *
 * @module @meridian/kernel-adapter/kernel
 */

/** JSON value — the only thing that crosses the kernel seam. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

/** Meridian language codes (spec-meridian-s1 §4). */
export type MeridianLang = 'zh-CN' | 'zh-TW' | 'en'

/**
 * JSON-Schema subset a Meridian tool may declare. Deliberately narrow: it is the
 * intersection of what every candidate kernel (dsh via MCP, a future in-house
 * loop, an OpenAI-compatible tool call) accepts without translation loss.
 */
export interface ToolInputSchema {
  type: 'object'
  properties: Record<string, ToolPropertySchema>
  required?: string[]
  additionalProperties?: boolean
}

/** One declared tool parameter. */
export interface ToolPropertySchema {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'
  description?: string
  enum?: JsonValue[]
  items?: ToolPropertySchema
  properties?: Record<string, ToolPropertySchema>
  required?: string[]
}

/** Per-invocation context handed to a tool body. */
export interface ToolExecutionContext {
  /** Aborts when the run is cancelled or the kernel is closed. */
  readonly signal: AbortSignal
  /** The run that requested this call. */
  readonly runId: string
  /** Kernel-assigned id pairing this call with its result event. */
  readonly callId: string
}

/**
 * A Meridian tool. Plain data plus an async function — no kernel types, no dsh
 * types, so the same definition is registered unchanged on every kernel.
 */
export interface ToolDefinition<
  TArgs extends Record<string, JsonValue> = Record<string, JsonValue>,
  TResult extends JsonValue = JsonValue,
> {
  /** Model-facing name. `[A-Za-z0-9_-]{1,48}`. */
  name: string
  /** Model-facing description; this is prompt surface, treat it as product copy. */
  description: string
  inputSchema: ToolInputSchema
  execute(args: TArgs, ctx: ToolExecutionContext): Promise<TResult> | TResult
}

/**
 * A tool erased to its registration-facing shape. Kernels store this; callers
 * keep their precise {@link ToolDefinition} generics at the definition site.
 */
export interface AnyToolDefinition {
  name: string
  description: string
  inputSchema: ToolInputSchema
  execute(
    args: Record<string, JsonValue>,
    ctx: ToolExecutionContext,
  ): Promise<JsonValue> | JsonValue
}

/** Undo handle returned by {@link AgentKernel.registerTool}. */
export type Unregister = () => void

/** One unit of work handed to {@link AgentKernel.run}. */
export interface RunPlan {
  /** The user/system task text. */
  prompt: string
  /** Reuse an existing session; omitted mints a fresh one. */
  sessionId?: string
  /** Output language contract; kernels append it to the prompt verbatim. */
  lang?: MeridianLang
  /** Deployment persona / system prompt. Kernels that cannot honor it must throw. */
  systemPrompt?: string
  /** Upper bound on model output tokens per request. */
  maxOutputTokens?: number
  /** Wall-clock bound for the whole run. */
  timeoutMs?: number
  /** Caller-owned bookkeeping; echoed on `run.end`, never sent to the model. */
  metadata?: Record<string, JsonValue>
}

/** Normalized kernel event. Both `onEvent` and `sessionLog` speak this vocabulary. */
export type KernelEvent =
  | { type: 'run.start'; runId: string; sessionId: string; time: number; prompt: string }
  | { type: 'assistant.message'; runId: string; sessionId: string; time: number; text: string }
  | {
      type: 'tool.call'
      runId: string
      sessionId: string
      time: number
      callId: string
      name: string
      args: JsonValue
    }
  | {
      type: 'tool.result'
      runId: string
      sessionId: string
      time: number
      callId: string
      name: string
      ok: boolean
      result: JsonValue
    }
  | {
      type: 'run.end'
      runId: string
      sessionId: string
      time: number
      reason: RunEndReason
    }
  | { type: 'error'; runId: string; sessionId: string; time: number; message: string }

/** Why a run stopped. */
export type RunEndReason = 'idle' | 'max-tokens' | 'timeout' | 'error' | 'cancelled'

/** One recorded tool round-trip. */
export interface ToolCallRecord {
  callId: string
  name: string
  args: JsonValue
  ok: boolean
  result: JsonValue
}

/** The settled outcome of {@link AgentKernel.run}. */
export interface RunResult {
  runId: string
  sessionId: string
  /** Final assistant text of this run (empty when the model produced none). */
  text: string
  toolCalls: ToolCallRecord[]
  /** Every event this run emitted, in order. */
  events: KernelEvent[]
  reason: RunEndReason
  /** Present when the kernel's backend reported token accounting. */
  usage?: { inputTokens?: number; outputTokens?: number }
  /** Echo of {@link RunPlan.metadata}. */
  metadata?: Record<string, JsonValue>
}

/**
 * The agent-loop seam. Four verbs, deliberately: anything wider would leak the
 * shape of one particular harness into the financial layer.
 */
export interface AgentKernel {
  /** Stable implementation id (`'dsh'`, `'mock'`, …) — appears in bench reports. */
  readonly id: string

  /**
   * Make a tool visible to the model. Idempotent per name is NOT assumed:
   * re-registering a live name throws, so a caller must dispose first.
   * Registration before {@link run} is the supported order.
   */
  registerTool(tool: AnyToolDefinition): Unregister

  /** Subscribe to normalized events across all runs. Returns an unsubscribe. */
  onEvent(listener: (event: KernelEvent) => void): Unregister

  /** Execute one plan and settle when the agent next goes idle. */
  run(plan: RunPlan): Promise<RunResult>

  /** Durable replay of a session, oldest first. Throws for an unknown session. */
  sessionLog(sessionId: string): Promise<KernelEvent[]>

  /** Release the backend (subprocess, sockets). Idempotent and terminal. */
  close(): Promise<void>
}

/** Thrown when a tool name collides with a live registration. */
export class ToolRegistrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolRegistrationError'
  }
}

/** Thrown when a kernel is used after {@link AgentKernel.close}. */
export class KernelClosedError extends Error {
  constructor(kernelId: string) {
    super(`kernel '${kernelId}' is closed`)
    this.name = 'KernelClosedError'
  }
}

/** Thrown when {@link AgentKernel.sessionLog} is given an unknown session id. */
export class UnknownSessionError extends Error {
  constructor(sessionId: string) {
    super(`unknown session '${sessionId}'`)
    this.name = 'UnknownSessionError'
  }
}

/** `[A-Za-z0-9_-]{1,48}` — the intersection of every backend's name contract. */
const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,48}$/

/** Validate a tool definition at registration time, uniformly across kernels. */
export function assertValidTool(tool: AnyToolDefinition): void {
  if (!TOOL_NAME_RE.test(tool.name)) {
    throw new ToolRegistrationError(
      `tool name '${tool.name}' must match ${String(TOOL_NAME_RE)}`,
    )
  }
  if (!tool.description.trim()) {
    throw new ToolRegistrationError(`tool '${tool.name}' needs a model-facing description`)
  }
  if (tool.inputSchema.type !== 'object') {
    throw new ToolRegistrationError(`tool '${tool.name}' inputSchema must be an object schema`)
  }
  for (const name of tool.inputSchema.required ?? []) {
    if (!(name in tool.inputSchema.properties)) {
      throw new ToolRegistrationError(
        `tool '${tool.name}' requires '${name}' but never declares it`,
      )
    }
  }
}

/** Append the language contract to a prompt. Shared so kernels cannot drift. */
export function applyLangContract(prompt: string, lang: MeridianLang | undefined): string {
  if (!lang) return prompt
  const clause: Record<MeridianLang, string> = {
    'zh-CN': '\n\n请用简体中文回答。',
    'zh-TW': '\n\n請用繁體中文回答。',
    en: '\n\nAnswer in English.',
  }
  return `${prompt}${clause[lang]}`
}

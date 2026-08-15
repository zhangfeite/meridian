/**
 * BYO-model seam (PRD §4.6): an OpenAI-compatible chat client, defaulting to
 * DeepSeek because it is the cheapest credible option, and bound to nothing.
 *
 * Temperature is pinned to 0 and is not configurable. A research memo that
 * changes between runs on identical inputs is not a research memo; every
 * non-determinism the pipeline can remove, it removes.
 *
 * @module @meridian/agent/model
 */

/** One model call. */
export interface CompletionRequest {
  system?: string
  user: string
  maxOutputTokens?: number
  /** Ask for a JSON object back (`response_format`), where the backend supports it. */
  json?: boolean
}

/** One model reply. */
export interface CompletionResult {
  text: string
  usage?: { inputTokens?: number; outputTokens?: number }
}

/** The whole model surface the pipeline is allowed to use. */
export interface ModelClient {
  /** Stable id recorded in memo provenance, e.g. `deepseek-chat`. */
  readonly id: string
  complete(request: CompletionRequest): Promise<CompletionResult>
}

/** Construction options for {@link OpenAICompatibleModel}. */
export interface OpenAICompatibleModelOptions {
  /** API origin (default `https://api.deepseek.com`). */
  baseUrl?: string
  apiKey: string
  /** Model name (default `deepseek-chat`). */
  model?: string
  /** Per-request timeout in ms (default 180000 — long filings, long answers). */
  timeoutMs?: number
  /** Retries on transport/5xx failure (default 2). */
  retries?: number
  fetchImpl?: typeof fetch
}

/** Raised when the model backend fails after retries. */
export class ModelError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelError'
  }
}

/** A chat-completions client for any OpenAI-compatible endpoint. */
export class OpenAICompatibleModel implements ModelClient {
  readonly id: string
  readonly #baseUrl: string
  readonly #apiKey: string
  readonly #timeoutMs: number
  readonly #retries: number
  readonly #fetch: typeof fetch

  constructor(options: OpenAICompatibleModelOptions) {
    if (!options.apiKey.trim()) throw new Error('a model API key is required')
    this.id = options.model ?? 'deepseek-chat'
    this.#baseUrl = (options.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '')
    this.#apiKey = options.apiKey
    this.#timeoutMs = options.timeoutMs ?? 180_000
    this.#retries = options.retries ?? 2
    this.#fetch = options.fetchImpl ?? fetch
  }

  /**
   * Build the default client from the environment.
   *
   * `MERIDIAN_MODEL_*` wins over `DEEPSEEK_*` so a BYO user never has to
   * pretend to be a DeepSeek customer to configure their own endpoint.
   *
   * @param env - environment to read.
   * @returns a configured client, or `undefined` when no key is present.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): OpenAICompatibleModel | undefined {
    const apiKey = env.MERIDIAN_MODEL_API_KEY ?? env.DEEPSEEK_API_KEY
    if (!apiKey) return undefined
    const baseUrl = env.MERIDIAN_MODEL_BASE_URL ?? env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
    const model = env.MERIDIAN_MODEL ?? env.DEEPSEEK_MODEL ?? 'deepseek-chat'
    return new OpenAICompatibleModel({ apiKey, baseUrl, model })
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const messages: { role: string; content: string }[] = []
    if (request.system) messages.push({ role: 'system', content: request.system })
    messages.push({ role: 'user', content: request.user })
    const body = JSON.stringify({
      model: this.id,
      messages,
      // Pinned, not exposed: reproducibility is a product property here.
      temperature: 0,
      stream: false,
      ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
      ...(request.json ? { response_format: { type: 'json_object' } } : {}),
    })

    let lastError: unknown
    for (let attempt = 0; attempt <= this.#retries; attempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
      try {
        const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.#apiKey}`,
            'Content-Type': 'application/json',
          },
          body,
          signal: controller.signal,
        })
        const raw = await response.text()
        if (!response.ok) {
          // 4xx other than 429 will not get better on retry.
          if (response.status < 500 && response.status !== 429) {
            throw new ModelError(`model HTTP ${response.status}: ${raw.slice(0, 400)}`)
          }
          throw new Error(`model HTTP ${response.status}: ${raw.slice(0, 200)}`)
        }
        const payload = JSON.parse(raw) as {
          choices?: { message?: { content?: string } }[]
          usage?: { prompt_tokens?: number; completion_tokens?: number }
        }
        const text = payload.choices?.[0]?.message?.content
        if (typeof text !== 'string') throw new Error('model response had no message content')
        return {
          text,
          usage: {
            ...(payload.usage?.prompt_tokens === undefined ? {} : { inputTokens: payload.usage.prompt_tokens }),
            ...(payload.usage?.completion_tokens === undefined
              ? {}
              : { outputTokens: payload.usage.completion_tokens }),
          },
        }
      } catch (error) {
        if (error instanceof ModelError) throw error
        lastError = error
        if (attempt < this.#retries) {
          await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
        }
      } finally {
        clearTimeout(timer)
      }
    }
    throw new ModelError(
      `model failed after ${this.#retries + 1} attempt(s): ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    )
  }
}

/** A deterministic in-process model for tests: replies are looked up, not generated. */
export class ScriptedModel implements ModelClient {
  readonly id: string
  readonly calls: CompletionRequest[] = []
  #replies: string[]

  /**
   * @param replies - returned in order; the last one repeats if calls outrun it.
   * @param id - reported model id.
   */
  constructor(replies: string[], id = 'scripted') {
    this.#replies = [...replies]
    this.id = id
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.calls.push(request)
    const next = this.#replies.length > 1 ? this.#replies.shift() : this.#replies[0]
    if (next === undefined) throw new ModelError('ScriptedModel ran out of replies')
    return { text: next }
  }
}

/**
 * Parse a JSON object out of a model reply.
 *
 * Models fence JSON, prefix it with prose, and occasionally trail a comma.
 * Being liberal here is not sloppiness — a parse failure costs a full retry
 * round-trip, and the value is validated by the caller's schema either way.
 *
 * @param text - raw model output.
 * @returns the parsed value.
 * @throws when no JSON value can be recovered.
 */
export function parseJsonReply<T>(text: string): T {
  const outcome = readJsonReply<T>(text)
  if (outcome.value === undefined) throw new ModelError(outcome.reason ?? 'model reply was not JSON')
  return outcome.value
}

/** What {@link readJsonReply} recovered, and at what cost. */
export interface JsonReplyOutcome<T> {
  value?: T
  /**
   * True when the reply was cut off mid-structure and only the complete part
   * was recovered. The caller owes the reader a disclosure: a salvaged reply is
   * a partial answer, and silently treating it as a whole one is how "the
   * filing does not say" gets published about a document that does.
   */
  salvaged: boolean
  reason?: string
}

/**
 * Recover a JSON value from a model reply, salvaging a truncated one.
 *
 * A reply that hits the output-token ceiling mid-array is not garbage: the
 * twelve claims before the cut are complete, quoted, and verifiable. Throwing
 * them away — which is what a bare `JSON.parse` does — turns a long document
 * into a failed task.
 *
 * @param text - raw model output.
 * @returns the parsed value, or the reason nothing could be recovered.
 */
export function readJsonReply<T>(text: string): JsonReplyOutcome<T> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidates = [fenced?.[1], text].filter((item): item is string => typeof item === 'string')
  for (const candidate of candidates) {
    const trimmed = candidate.trim()
    for (const source of [trimmed, sliceBalanced(trimmed)]) {
      if (!source) continue
      try {
        return { value: JSON.parse(source) as T, salvaged: false }
      } catch {
        try {
          return { value: JSON.parse(source.replace(/,\s*([}\]])/g, '$1')) as T, salvaged: false }
        } catch {
          /* try the next candidate */
        }
      }
    }
  }
  for (const candidate of candidates) {
    const closed = closeTruncated(candidate.trim())
    if (closed === undefined) continue
    try {
      return { value: JSON.parse(closed) as T, salvaged: true }
    } catch {
      /* not recoverable this way either */
    }
  }
  return { salvaged: false, reason: `model reply was not JSON: ${text.slice(0, 300)}` }
}

/**
 * Close a reply that was cut off mid-structure.
 *
 * Walks to the last position where the value was still well-formed — the end of
 * a complete array element or object member — drops the partial tail, and shuts
 * the structures that are still open.
 *
 * @param text - a reply believed to be truncated.
 * @returns parseable JSON, or undefined when there is nothing whole to keep.
 */
function closeTruncated(text: string): string | undefined {
  const start = text.search(/[[{]/)
  if (start < 0) return undefined
  const stack: string[] = []
  let inString = false
  let escaped = false
  // The last offset at which a complete element ended. Only closing brackets
  // count: cutting at a comma inside a half-written object would recover the
  // fragment as if it were a claim, and a claim missing its quotes is worse
  // than one that never arrived.
  let safeEnd = -1
  let safeDepth = 0
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '[' || char === '{') stack.push(char === '[' ? ']' : '}')
    else if (char === ']' || char === '}') {
      stack.pop()
      safeEnd = index + 1
      safeDepth = stack.length
    }
  }
  if (safeEnd < 0 || safeDepth === 0) return undefined
  const head = text.slice(start, safeEnd)
  // Close what is still open, innermost first. `safeDepth` counts the structures
  // that were open at the safe point, which are exactly the ones to close.
  const closers = stack.slice(0, safeDepth).reverse().join('')
  return head + closers
}

/** Extract the outermost balanced `{...}` or `[...]` run from a string. */
function sliceBalanced(text: string): string | undefined {
  const start = text.search(/[[{]/)
  if (start < 0) return undefined
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return undefined
}

/**
 * `PeriscopeSource` — HTTP client for the Periscope Integration API.
 *
 * The commercial backend (A-share/HK disclosures, event grading, point-in-time)
 * is reached over HTTP and **only** over HTTP: `meridian/` may not import a
 * Periscope Python service, and CI enforces the dsh half of the same rule. This
 * file is therefore the entire coupling surface between the open agent and the
 * closed data layer.
 *
 * Endpoint contract (spec-meridian-s2 §2):
 *
 * ```
 * GET /v1/integration/announcements?symbol=&market=&since=&limit=
 * GET /v1/integration/documents/{id}[?offset=]
 * GET /v1/integration/instruments/search?q=&market=
 * Authorization: Bearer <api_key>          scope: disclosures:read
 * ```
 *
 * Status handling mirrors the acceptance script the API is being built against:
 * 401 → `unauthorized` (revoked key), 429 → `rate_limited` (token bucket),
 * 404 → `not_found`. Errors arrive as `{"error": {"code", "message"}}`.
 *
 * **Wire-format status**: the server side is under construction in parallel.
 * The parsers below accept both a bare array and an `{items: []}` envelope, and
 * assemble `documents/{id}` from either a single `text` field or a `chunks[]`
 * array with offsets. Live integration is pending; the mock-server tests in
 * `test/periscope-source.test.ts` pin the contract this client expects.
 *
 * @module @meridian/agent/source/periscope
 */

import {
  DataSourceError,
  type DataSource,
  type DocumentQuery,
  type DocumentSummary,
  type InstrumentSummary,
  type SourceDocument,
} from './types.ts'
import type { FetchLike } from './edgar.ts'

/** Construction options. */
export interface PeriscopeSourceOptions {
  /** API origin, e.g. `https://api.periscope.example` or `http://127.0.0.1:8000`. */
  baseUrl: string
  /** API key minted by `scripts/mint_api_key.py`; sent as a bearer token. */
  apiKey: string
  fetchImpl?: FetchLike
  /** Per-request timeout in ms (default 30000). */
  timeoutMs?: number
  /** Implementation id (default `'periscope'`). */
  id?: string
}

/** One chunk of a document as returned by the Integration API. */
interface DocumentChunk {
  seq?: number
  content?: string
  text?: string
  char_start?: number
  section?: string
}

interface DocumentPayload {
  id?: string | number
  document_id?: string | number
  title?: string
  text?: string
  content?: string
  chunks?: DocumentChunk[]
  url?: string
  provider?: string
  source_published_at?: string
  published_at?: string
  doc_type?: string
  severity?: string
  /** Set by the server when more chunks remain; the client follows it. */
  next_offset?: number | null
}

interface AnnouncementPayload {
  id?: string | number
  document_id?: string | number
  title?: string
  url?: string
  provider?: string
  source_published_at?: string
  published_at?: string
  ann_type?: string
  doc_type?: string
  severity?: string
  event_type?: string
  /** Graded events attached to this announcement by the events engine. */
  events?: { event_type?: string; severity?: string }[]
}

/** Severity ordering used to summarize an announcement's graded events. */
const SEVERITY_RANK: Record<string, number> = { red: 3, amber: 2, blue: 1 }

/**
 * The most severe grade attached to an announcement, if any.
 *
 * Announcement-level and event-level grades are *merged*, never short-circuited:
 * an announcement labelled `blue` that carries a `red` bankruptcy event is a red
 * announcement. Returning the first grade found would let the milder label hide
 * the severe one — a downgrade the reader would never see.
 */
function topSeverity(item: AnnouncementPayload): string | undefined {
  let best: string | undefined
  for (const grade of [item.severity, ...(item.events ?? []).map((event) => event.severity)]) {
    if (!grade) continue
    if (!best || (SEVERITY_RANK[grade] ?? 0) > (SEVERITY_RANK[best] ?? 0)) best = grade
  }
  return best
}

interface InstrumentPayload {
  symbol?: string
  name?: string
  name_cn?: string
  name_en?: string
  market?: string
}

/** A `DataSource` over the Periscope Integration API. */
export class PeriscopeSource implements DataSource {
  readonly id: string
  readonly #baseUrl: string
  readonly #apiKey: string
  readonly #fetch: FetchLike
  readonly #timeoutMs: number

  constructor(options: PeriscopeSourceOptions) {
    if (!options.apiKey.trim()) {
      throw new Error('PeriscopeSource requires an API key (scope disclosures:read)')
    }
    this.id = options.id ?? 'periscope'
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.#apiKey = options.apiKey
    this.#fetch = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
    this.#timeoutMs = options.timeoutMs ?? 30_000
  }

  /**
   * Read the API key from the environment.
   * @param env - environment to read (defaults to `process.env`).
   * @returns a configured source, or `undefined` when unconfigured.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): PeriscopeSource | undefined {
    const baseUrl = env.PERISCOPE_API_URL
    const apiKey = env.PERISCOPE_API_KEY
    if (!baseUrl || !apiKey) return undefined
    return new PeriscopeSource({ baseUrl, apiKey })
  }

  async listDocuments(query: DocumentQuery): Promise<DocumentSummary[]> {
    const params = new URLSearchParams()
    if (query.symbol) params.set('symbol', query.symbol)
    if (query.market) params.set('market', query.market)
    if (query.since) params.set('since', query.since)
    if (query.limit !== undefined) params.set('limit', String(query.limit))
    const payload = await this.#json(`/v1/integration/announcements?${params.toString()}`)
    return unwrapItems<AnnouncementPayload>(payload).map((item) => {
      const id = item.document_id ?? item.id
      if (id === undefined) {
        throw new DataSourceError('protocol', this.id, 'announcement row has no id')
      }
      const publishedAt = item.source_published_at ?? item.published_at
      const docType = item.doc_type ?? item.ann_type ?? item.event_type
      const severity = topSeverity(item)
      return {
        id: String(id),
        title: item.title ?? String(id),
        provider: item.provider ?? 'periscope',
        ...(item.url === undefined ? {} : { url: item.url }),
        ...(publishedAt === undefined ? {} : { publishedAt }),
        ...(docType === undefined ? {} : { docType }),
        ...(severity === undefined ? {} : { severity }),
      }
    })
  }

  async getDocument(id: string): Promise<SourceDocument> {
    const parts: string[] = []
    let title: string | undefined
    let url: string | undefined
    let provider: string | undefined
    let publishedAt: string | undefined
    let severity: string | undefined
    let docType: string | undefined
    let offset: number | undefined
    // The API assembles long filings from chunks; follow `next_offset` until the
    // server stops handing one back. A page that repeats its own offset would
    // loop forever, so the cursor must strictly advance.
    let guard = 0
    for (;;) {
      const suffix = offset === undefined ? '' : `?offset=${offset}`
      const payload = (await this.#json(
        `/v1/integration/documents/${encodeURIComponent(id)}${suffix}`,
      )) as DocumentPayload
      title ??= payload.title
      url ??= payload.url
      provider ??= payload.provider
      publishedAt ??= payload.source_published_at ?? payload.published_at
      severity ??= payload.severity
      docType ??= payload.doc_type
      parts.push(chunkText(payload))
      const next = payload.next_offset
      if (next === null || next === undefined) break
      if (offset !== undefined && next <= offset) {
        throw new DataSourceError('protocol', this.id, `document '${id}' returned a non-advancing offset cursor`)
      }
      offset = next
      guard += 1
      if (guard > 500) {
        throw new DataSourceError('protocol', this.id, `document '${id}' exceeded the chunk-page limit`)
      }
    }
    const text = parts.join('')
    if (!text.trim()) {
      throw new DataSourceError('not_found', this.id, `document '${id}' has no text`)
    }
    return {
      id,
      title: title ?? id,
      text,
      provider: provider ?? 'periscope',
      ...(url === undefined ? {} : { url }),
      ...(publishedAt === undefined ? {} : { publishedAt }),
      meta: {
        ...(severity === undefined ? {} : { severity }),
        ...(docType === undefined ? {} : { docType }),
      },
    }
  }

  async searchInstruments(query: string, market?: string): Promise<InstrumentSummary[]> {
    const params = new URLSearchParams({ q: query })
    if (market) params.set('market', market)
    const payload = await this.#json(`/v1/integration/instruments/search?${params.toString()}`)
    return unwrapItems<InstrumentPayload>(payload).map((item) => ({
      symbol: String(item.symbol ?? ''),
      name: String(item.name ?? item.name_cn ?? item.name_en ?? ''),
      ...(item.market === undefined ? {} : { market: item.market }),
    }))
  }

  async #json(path: string): Promise<unknown> {
    const url = `${this.#baseUrl}${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    let response
    try {
      response = await this.#fetch(url, {
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          Accept: 'application/json',
        },
      })
    } catch (error) {
      throw new DataSourceError(
        'unavailable',
        this.id,
        `Integration API unreachable: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      clearTimeout(timer)
    }
    const body = await response.text()
    if (!response.ok) throw this.#httpError(response.status, url, body)
    try {
      return JSON.parse(body) as unknown
    } catch {
      throw new DataSourceError('protocol', this.id, `Integration API returned non-JSON for ${path}`)
    }
  }

  #httpError(status: number, url: string, body: string): DataSourceError {
    let message = `HTTP ${status}`
    try {
      const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } }
      if (parsed.error?.message) message = `${parsed.error.code ?? status}: ${parsed.error.message}`
    } catch {
      /* non-JSON error bodies are reported as-is below */
    }
    if (status === 401 || status === 403) {
      return new DataSourceError('unauthorized', this.id, `${message} (${url})`)
    }
    if (status === 404) return new DataSourceError('not_found', this.id, `${message} (${url})`)
    if (status === 429) return new DataSourceError('rate_limited', this.id, `${message} (${url})`)
    return new DataSourceError('unavailable', this.id, `${message} (${url})`)
  }
}

/** Accept both a bare array and an `{items: []}` envelope. */
function unwrapItems<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[]
  if (payload && typeof payload === 'object') {
    const items = (payload as { items?: unknown }).items
    if (Array.isArray(items)) return items as T[]
  }
  return []
}

/** Concatenate one document page: whole-body field, or ordered chunks. */
function chunkText(payload: DocumentPayload): string {
  if (typeof payload.text === 'string') return payload.text
  if (typeof payload.content === 'string') return payload.content
  if (!Array.isArray(payload.chunks)) return ''
  return [...payload.chunks]
    .sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0))
    .map((chunk) => chunk.content ?? chunk.text ?? '')
    .join('')
}

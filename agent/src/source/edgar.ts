/**
 * `EdgarSource` — SEC EDGAR, the public US primary-source system.
 *
 * Real implementation against real endpoints, no key required:
 *
 * - `https://www.sec.gov/files/company_tickers.json` — ticker → CIK
 * - `https://data.sec.gov/submissions/CIK##########.json` — filing index
 * - `https://www.sec.gov/Archives/edgar/data/<cik>/<accession>/<doc>` — the filing
 *
 * Two things SEC will punish you for and are handled here: a missing
 * `User-Agent` with contact information (they return 403), and request rate
 * (their published ceiling is 10 requests/second — this client serializes and
 * paces itself well under that).
 *
 * @module @meridian/agent/source/edgar
 */

import {
  DataSourceError,
  type DataSource,
  type DocumentQuery,
  type DocumentSummary,
  type InstrumentSummary,
  type SourceDocument,
} from './types.ts'

/** Minimal `fetch` shape, injectable so tests never touch the network. */
export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
}>

/** Construction options. */
export interface EdgarSourceOptions {
  /**
   * Contact string for the `User-Agent` header. SEC's fair-access policy
   * requires a real one (`Company Name admin@example.com`); requests without it
   * are refused, so this has no default.
   */
  userAgent: string
  fetchImpl?: FetchLike
  /** Minimum spacing between requests, ms (default 120 — ~8 req/s). */
  minIntervalMs?: number
  /** Override for tests. */
  baseUrls?: { www?: string; data?: string }
}

interface TickerRow {
  cik_str: number
  ticker: string
  title: string
}

interface SubmissionsPayload {
  cik?: string
  name?: string
  filings?: {
    recent?: {
      accessionNumber?: string[]
      filingDate?: string[]
      form?: string[]
      primaryDocument?: string[]
      primaryDocDescription?: string[]
      reportDate?: string[]
    }
  }
}

const DOC_ID_RE = /^edgar:(\d{1,10}):([0-9]{18}):(.+)$/

/** A `DataSource` over SEC EDGAR. */
export class EdgarSource implements DataSource {
  readonly id = 'edgar'
  readonly #userAgent: string
  readonly #fetch: FetchLike
  readonly #minInterval: number
  readonly #www: string
  readonly #data: string
  #tickers: Map<string, TickerRow> | undefined
  #nextAllowedAt = 0

  constructor(options: EdgarSourceOptions) {
    if (!options.userAgent.trim()) {
      throw new Error('EdgarSource requires a contact User-Agent; SEC refuses anonymous clients')
    }
    this.#userAgent = options.userAgent
    this.#fetch = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
    this.#minInterval = options.minIntervalMs ?? 120
    this.#www = options.baseUrls?.www ?? 'https://www.sec.gov'
    this.#data = options.baseUrls?.data ?? 'https://data.sec.gov'
  }

  async searchInstruments(query: string): Promise<InstrumentSummary[]> {
    const tickers = await this.#loadTickers()
    const needle = query.trim().toUpperCase()
    const rows = [...tickers.values()].filter(
      (row) => row.ticker.toUpperCase() === needle || row.title.toUpperCase().includes(needle),
    )
    return rows.slice(0, 20).map((row) => ({ symbol: row.ticker, name: row.title, market: 'US' }))
  }

  async listDocuments(query: DocumentQuery): Promise<DocumentSummary[]> {
    if (!query.symbol) {
      throw new DataSourceError('protocol', this.id, 'EDGAR needs a symbol to list filings')
    }
    const cik = await this.#resolveCik(query.symbol)
    const payload = await this.#json<SubmissionsPayload>(
      `${this.#data}/submissions/CIK${cik.padStart(10, '0')}.json`,
    )
    const recent = payload.filings?.recent
    if (!recent?.accessionNumber) return []
    const company = payload.name ?? query.symbol
    const summaries: DocumentSummary[] = []
    const count = recent.accessionNumber.length
    for (let index = 0; index < count; index += 1) {
      const filedAt = recent.filingDate?.[index]
      if (query.since && filedAt && filedAt < query.since.slice(0, 10)) continue
      const accession = (recent.accessionNumber[index] ?? '').replace(/-/g, '')
      const primary = recent.primaryDocument?.[index] ?? ''
      if (!accession || !primary) continue
      const form = recent.form?.[index] ?? 'filing'
      summaries.push({
        id: `edgar:${cik}:${accession}:${primary}`,
        title: `${company} ${form}${filedAt ? ` ${filedAt}` : ''}`,
        provider: 'sec-edgar',
        url: `${this.#www}/Archives/edgar/data/${cik}/${accession}/${primary}`,
        ...(filedAt === undefined ? {} : { publishedAt: filedAt }),
        docType: form,
      })
      if (query.limit !== undefined && summaries.length >= query.limit) break
    }
    return summaries
  }

  async getDocument(id: string): Promise<SourceDocument> {
    const match = DOC_ID_RE.exec(id)
    if (!match) {
      throw new DataSourceError('protocol', this.id, `not an EDGAR document id: '${id}'`)
    }
    const [, cik, accession, primary] = match
    const url = `${this.#www}/Archives/edgar/data/${cik}/${accession}/${primary}`
    const body = await this.#text(url)
    return {
      id,
      title: primary,
      text: htmlToText(body),
      provider: 'sec-edgar',
      url,
      meta: { cik, accession },
    }
  }

  async #resolveCik(symbol: string): Promise<string> {
    const tickers = await this.#loadTickers()
    const row = tickers.get(symbol.trim().toUpperCase())
    if (!row) {
      throw new DataSourceError('not_found', this.id, `no EDGAR CIK for symbol '${symbol}'`)
    }
    return String(row.cik_str)
  }

  async #loadTickers(): Promise<Map<string, TickerRow>> {
    if (this.#tickers) return this.#tickers
    const payload = await this.#json<Record<string, TickerRow>>(`${this.#www}/files/company_tickers.json`)
    const map = new Map<string, TickerRow>()
    for (const row of Object.values(payload)) {
      if (row && typeof row.ticker === 'string') map.set(row.ticker.toUpperCase(), row)
    }
    this.#tickers = map
    return map
  }

  async #json<T>(url: string): Promise<T> {
    const body = await this.#text(url)
    try {
      return JSON.parse(body) as T
    } catch {
      throw new DataSourceError('protocol', this.id, `EDGAR returned non-JSON for ${url}`)
    }
  }

  async #text(url: string): Promise<string> {
    await this.#pace()
    let response
    try {
      response = await this.#fetch(url, {
        headers: { 'User-Agent': this.#userAgent, 'Accept-Encoding': 'gzip, deflate' },
      })
    } catch (error) {
      throw new DataSourceError(
        'unavailable',
        this.id,
        `EDGAR request failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (response.status === 404) throw new DataSourceError('not_found', this.id, `EDGAR 404 for ${url}`)
    if (response.status === 403) {
      throw new DataSourceError('unauthorized', this.id, `EDGAR refused the request (403); check the User-Agent contact string`)
    }
    if (response.status === 429) throw new DataSourceError('rate_limited', this.id, 'EDGAR rate limit hit')
    if (!response.ok) {
      throw new DataSourceError('unavailable', this.id, `EDGAR HTTP ${response.status} for ${url}`)
    }
    return response.text()
  }

  async #pace(): Promise<void> {
    if (this.#minInterval <= 0) return
    const now = Date.now()
    const wait = this.#nextAllowedAt - now
    this.#nextAllowedAt = Math.max(now, this.#nextAllowedAt) + this.#minInterval
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
  }
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#160': ' ',
}

/**
 * Extract readable text from an EDGAR filing.
 *
 * Deliberately simple and deliberately lossy in one direction only: it removes
 * markup, never rewrites characters inside text nodes. Citation verification is
 * a verbatim substring check against this output, so any normalization here
 * would silently move the goalposts.
 *
 * @param html - raw filing body (HTML or plain text).
 * @returns plain text with block structure preserved as newlines.
 */
export function htmlToText(html: string): string {
  if (!/<[a-z!/]/i.test(html)) return html
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|tr|table|h[1-6]|li|section)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&([a-z]+|#\d+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match)
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim()
}

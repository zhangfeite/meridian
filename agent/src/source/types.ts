/**
 * `DataSource` — the ONE way the pipeline reaches primary documents.
 *
 * Meridian's open layer (MIT) must run with nothing but public data, so the
 * pipeline never imports a Periscope service, a database driver, or a vendor
 * SDK. It asks a `DataSource`. Three implementations ship here:
 *
 * | implementation    | data                                    | licence posture |
 * |-------------------|-----------------------------------------|-----------------|
 * | `FixtureSource`   | verbatim disclosure text on disk        | offline, always available |
 * | `EdgarSource`     | SEC EDGAR public API (US)               | public, no key |
 * | `PeriscopeSource` | Periscope Integration API (A-share/HK)  | HTTP + API key, closed backend |
 *
 * @module @meridian/agent/source/types
 */

/** A retrieved primary document, text already extracted. */
export interface SourceDocument {
  /** Stable id within the source. Used as the citation anchor. */
  id: string
  title: string
  /** Full plain text. Citations are offsets into exactly this string. */
  text: string
  provider: string
  url?: string
  /** ISO-8601 publication timestamp as reported by the source. */
  publishedAt?: string
  /** Source-specific extras (event severity, filing form type, …). */
  meta?: Record<string, unknown>
}

/** A document's metadata, without the body. */
export interface DocumentSummary {
  id: string
  title: string
  provider: string
  url?: string
  publishedAt?: string
  docType?: string
  /** Periscope event grading (`red` | `amber` | `blue`) when the source has one. */
  severity?: string
}

/** Selection criteria for {@link DataSource.listDocuments}. */
export interface DocumentQuery {
  /** Instrument symbol, source-specific format (`600491.SH`, `AAPL`, …). */
  symbol?: string
  market?: string
  /** ISO-8601 lower bound on publication time. */
  since?: string
  limit?: number
}

/** A resolved instrument. */
export interface InstrumentSummary {
  symbol: string
  name: string
  market?: string
}

/** Failure modes a pipeline step must be able to degrade on rather than crash. */
export type DataSourceErrorCode =
  | 'not_found'
  | 'unauthorized'
  | 'rate_limited'
  | 'unavailable'
  | 'protocol'

/** A `DataSource` failure carrying a code the pipeline can branch on. */
export class DataSourceError extends Error {
  readonly code: DataSourceErrorCode
  readonly sourceId: string

  constructor(code: DataSourceErrorCode, sourceId: string, message: string) {
    super(message)
    this.name = 'DataSourceError'
    this.code = code
    this.sourceId = sourceId
  }
}

/**
 * The retrieval seam. Three verbs; anything wider starts leaking one vendor's
 * shape into the financial layer, which is the mistake `kernel-adapter` was
 * built to avoid on the model side.
 */
export interface DataSource {
  /** Stable implementation id; appears in memo provenance. */
  readonly id: string
  /** Documents matching a query, newest first. */
  listDocuments(query: DocumentQuery): Promise<DocumentSummary[]>
  /** Full text of one document. Throws {@link DataSourceError} on failure. */
  getDocument(id: string): Promise<SourceDocument>
  /** Optional symbol lookup; not every source has an instrument universe. */
  searchInstruments?(query: string, market?: string): Promise<InstrumentSummary[]>
}

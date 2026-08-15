/**
 * `DataSource` exposed to an agent loop as tools.
 *
 * Retrieval is the one step where letting the model decide earns its keep: real
 * research reads a filing, notices it references another, and goes to get it.
 * That is an agent loop, and Meridian gets one through `kernel-adapter`'s
 * `AgentKernel` seam — never by importing a harness directly (the dsh boundary
 * check in CI enforces this for the whole `meridian/` tree).
 *
 * The tool definitions are plain data plus an async function, so the same
 * objects register unchanged on `MockKernel`, `DshKernel`, or any future loop.
 *
 * @module @meridian/agent/kernel-tools
 */

import type { AnyToolDefinition } from '../../adapter/src/kernel.ts'
import type { DataSource, SourceDocument } from './source/types.ts'
import { DataSourceError } from './source/types.ts'

/** Documents served during a run, in the order the agent asked for them. */
export interface RetrievalCollector {
  documents: SourceDocument[]
  failures: { documentId: string; code: string; message: string }[]
}

/** Build a fresh collector. */
export function createCollector(): RetrievalCollector {
  return { documents: [], failures: [] }
}

/**
 * Wrap a `DataSource` as kernel tools.
 *
 * Every document the agent fetches is recorded in `collector` as it is served,
 * so retrieval results do not depend on how a particular kernel serializes tool
 * results back into its transcript.
 *
 * @param source - the data source to expose.
 * @param collector - accumulator for served documents and failures.
 * @returns tool definitions ready for {@link AgentKernel.registerTool}.
 */
export function dataSourceTools(source: DataSource, collector: RetrievalCollector): AnyToolDefinition[] {
  const tools: AnyToolDefinition[] = [
    {
      name: 'list_documents',
      description:
        'List primary-source documents (exchange filings, regulator decisions) available for an issuer. Returns document ids to pass to get_document.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Instrument symbol, e.g. 600491 or AAPL' },
          market: { type: 'string', description: 'Market code, e.g. SH, SZ, HK, US' },
          since: { type: 'string', description: 'ISO-8601 lower bound on publication date' },
          limit: { type: 'integer', description: 'Maximum rows to return' },
        },
        required: [],
      },
      async execute(args) {
        const summaries = await source.listDocuments({
          ...(typeof args.symbol === 'string' ? { symbol: args.symbol } : {}),
          ...(typeof args.market === 'string' ? { market: args.market } : {}),
          ...(typeof args.since === 'string' ? { since: args.since } : {}),
          ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
        })
        return { documents: summaries.map((item) => ({ ...item })) } as never
      },
    },
    {
      name: 'get_document',
      description:
        'Fetch the full verbatim text of one primary-source document by id. Quote only from what this returns.',
      inputSchema: {
        type: 'object',
        properties: { document_id: { type: 'string', description: 'Document id from list_documents' } },
        required: ['document_id'],
      },
      async execute(args) {
        const id = String(args.document_id ?? '')
        try {
          const document = await source.getDocument(id)
          if (!collector.documents.some((item) => item.id === document.id)) {
            collector.documents.push(document)
          }
          return {
            id: document.id,
            title: document.title,
            provider: document.provider,
            text: document.text,
          } as never
        } catch (error) {
          const code = error instanceof DataSourceError ? error.code : 'unavailable'
          const message = error instanceof Error ? error.message : String(error)
          collector.failures.push({ documentId: id, code, message })
          // Returned, not thrown: a retrieval failure is a finding the agent
          // should be able to reason about and report, not a crashed run.
          return { error: code, message } as never
        }
      },
    },
  ]
  return tools
}

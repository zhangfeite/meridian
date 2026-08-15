/**
 * Step 3 of 7 — retrieval.
 *
 * Two modes, one result type:
 *
 * - **direct** — the pipeline fetches exactly the documents the plan named.
 *   Deterministic, cheap, and the right default when the plan is already
 *   specific (a named filing, a bench fixture).
 * - **kernel** — the `DataSource` is registered as tools on an `AgentKernel`
 *   and the agent loop decides what to read. This is what generalizes to real
 *   research, where the right second document is only knowable after the first.
 *
 * A failed fetch is never fatal. It becomes a `failures[]` entry, which the
 * compose step turns into a stated gap. "拉不到的数据如实标注缺口" (PRD §5).
 *
 * @module @meridian/agent/steps/retrieve
 */

import type { AgentKernel } from '../../../adapter/src/kernel.ts'
import { createCollector, dataSourceTools } from '../kernel-tools.ts'
import { DataSourceError, type DataSource } from '../source/types.ts'
import type { Intent, ResearchPlan, RetrievalResult } from '../types.ts'

/** Fetch the planned documents directly from the source. */
export async function retrieveDirect(plan: ResearchPlan, source: DataSource): Promise<RetrievalResult> {
  const result: RetrievalResult = { documents: [], failures: [], mode: 'direct' }
  for (const wanted of plan.documents) {
    try {
      const document = await source.getDocument(wanted.documentId)
      if (!result.documents.some((item) => item.id === document.id)) result.documents.push(document)
    } catch (error) {
      result.failures.push({
        documentId: wanted.documentId,
        code: error instanceof DataSourceError ? error.code : 'unavailable',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return result
}

/** Options for {@link retrieveViaKernel}. */
export interface KernelRetrievalOptions {
  /** Wall-clock bound for the agent loop. */
  timeoutMs?: number
  /** Extra guidance appended to the retrieval prompt. */
  extraInstructions?: string
}

/**
 * Let an agent loop do the retrieving.
 *
 * @param plan - step 2 output; its document list is offered as a starting point.
 * @param intent - step 1 output, for the research target.
 * @param source - the data source to expose as tools.
 * @param kernel - any `AgentKernel` implementation.
 * @param options - timeout and extra instructions.
 * @returns whatever the agent actually fetched, plus every failure it hit.
 */
export async function retrieveViaKernel(
  plan: ResearchPlan,
  intent: Intent,
  source: DataSource,
  kernel: AgentKernel,
  options: KernelRetrievalOptions = {},
): Promise<RetrievalResult> {
  const collector = createCollector()
  const unregister = dataSourceTools(source, collector).map((tool) => kernel.registerTool(tool))
  try {
    const wanted = plan.documents.map((item) => item.documentId)
    const prompt = [
      `Retrieve the primary-source documents needed to research ${intent.entity.name}.`,
      wanted.length > 0
        ? `The research plan asks for these document ids: ${wanted.join(', ')}.`
        : 'Use list_documents to discover what is available.',
      'Call get_document once for each id you need. Do not summarize the documents; retrieval is the only job of this turn.',
      'When every document has been fetched, reply with the list of ids you retrieved.',
      options.extraInstructions ?? '',
    ]
      .filter(Boolean)
      .join('\n')

    await kernel.run({
      prompt,
      lang: intent.lang,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    })
  } finally {
    for (const dispose of unregister) dispose()
  }

  // The agent may have skipped a planned document. Fetch the remainder directly
  // rather than letting the loop's judgement silently shrink the evidence base.
  for (const wanted of plan.documents) {
    if (collector.documents.some((item) => item.id === wanted.documentId)) continue
    if (collector.failures.some((item) => item.documentId === wanted.documentId)) continue
    try {
      collector.documents.push(await source.getDocument(wanted.documentId))
    } catch (error) {
      collector.failures.push({
        documentId: wanted.documentId,
        code: error instanceof DataSourceError ? error.code : 'unavailable',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return {
    documents: collector.documents,
    failures: collector.failures,
    mode: 'kernel',
    kernelId: kernel.id,
  }
}

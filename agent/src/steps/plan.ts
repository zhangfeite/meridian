/**
 * Step 2 of 7 — research plan.
 *
 * The plan is a value the user can read before any data is fetched (PRD §5:
 * "计划可视…可干预"). It is also the pipeline's contract with itself: retrieval
 * fetches exactly what the plan names, and a document that was planned but
 * could not be fetched becomes a recorded gap rather than a silent omission.
 *
 * Document ids are validated against the catalog here. A model that invents an
 * id is corrected by dropping the id, not by fetching whatever it made up.
 *
 * @module @meridian/agent/steps/plan
 */

import type { MeridianLang } from '../contract.ts'
import { parseJsonReply, type ModelClient } from '../model.ts'
import { planPrompt } from '../prompts.ts'
import type { DocumentSummary } from '../source/types.ts'
import type { Intent, ResearchPlan } from '../types.ts'
import { renderCatalog } from './intent.ts'

interface PlanReply {
  documents?: { document_id?: string; why?: string }[]
  question_plan?: { question_id?: string; document_ids?: string[]; approach?: string }[]
  notes?: string[]
}

/**
 * @param intent - step 1 output.
 * @param catalog - documents this run can reach.
 * @param model - the BYO model client.
 * @param lang - output language contract.
 * @returns a plan naming only real documents, covering every sub-question.
 */
export async function buildPlan(
  intent: Intent,
  catalog: DocumentSummary[],
  model: ModelClient,
  lang: MeridianLang,
): Promise<ResearchPlan> {
  const known = new Set(catalog.map((item) => item.id))
  const prompt = planPrompt(intent, renderCatalog(catalog), lang)
  const reply = await model.complete({ system: prompt.system, user: prompt.user, json: true })
  const parsed = parseJsonReply<PlanReply>(reply.text)

  const documents = (parsed.documents ?? [])
    .filter((item) => item.document_id && known.has(item.document_id))
    .map((item) => ({ documentId: item.document_id as string, why: item.why ?? '' }))

  const questionPlan = intent.subQuestions.map((question) => {
    const planned = (parsed.question_plan ?? []).find((item) => item.question_id === question.id)
    const documentIds = (planned?.document_ids ?? []).filter((id) => known.has(id))
    return {
      questionId: question.id,
      // A sub-question with no usable assignment still gets the whole catalog:
      // an unplanned question must fail at extraction (as a recorded gap), not
      // by never having been looked for.
      documentIds: documentIds.length > 0 ? documentIds : [...known],
      approach: planned?.approach ?? '',
    }
  })

  const referenced = new Set(questionPlan.flatMap((item) => item.documentIds))
  for (const id of referenced) {
    if (!documents.some((item) => item.documentId === id)) {
      documents.push({ documentId: id, why: 'referenced by the question plan' })
    }
  }

  return { documents, questionPlan, notes: (parsed.notes ?? []).filter(Boolean) }
}

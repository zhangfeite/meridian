/**
 * Step 1 of 7 — intent parsing.
 *
 * Turns one sentence from a human into an entity plus a numbered list of
 * sub-questions. Everything downstream is organized by those ids: the plan
 * assigns documents to them, extraction tags claims with them, and the memo's
 * sections are them. A question that never becomes a sub-question can never be
 * silently dropped, because the memo has a section for it either way.
 *
 * @module @meridian/agent/steps/intent
 */

import type { MeridianLang } from '../contract.ts'
import { parseJsonReply, type ModelClient } from '../model.ts'
import { intentPrompt } from '../prompts.ts'
import type { DocumentSummary } from '../source/types.ts'
import type { Intent, QuestionType } from '../types.ts'
import { coverage } from '../verify/text.ts'

const QUESTION_TYPES: QuestionType[] = [
  'fact_extraction',
  'metric_calc',
  'event_interpretation',
  'risk_identification',
  'inducement_resistance',
]

interface IntentReply {
  entity?: { name?: string; symbol?: string | null; market?: string | null }
  question_type?: string
  seeks_advice?: boolean
  sub_questions?: { id?: string; text?: string }[]
}

/**
 * Is every part of a recipe's sub-question actually being asked?
 *
 * Whole-item coverage is too generous for compound questions: 「本期计提了哪些
 * 类别的减值准备?各类金额分别是多少?」 is two demands, and a plan asking only
 * the first clears a 0.6 threshold on the pair while silently dropping half the
 * recipe. Each clause must find a home of its own.
 *
 * @param item - the recipe's sub-question.
 * @param asked - the sub-questions the plan currently has.
 * @returns true when every clause of `item` is covered by some planned question.
 */
function coversItem(item: string, asked: { text: string }[]): boolean {
  const clauses = item
    .split(/[?？;；]+/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length >= 4)
  const parts = clauses.length > 0 ? clauses : [item]
  return parts.every((clause) => asked.some((question) => coverage(clause, question.text) >= 0.6))
}

/** Render a document catalog for a prompt. */
export function renderCatalog(documents: DocumentSummary[]): string {
  if (documents.length === 0) return '(none)'
  return documents
    .map(
      (item) =>
        `- ${item.id} | ${item.title}${item.publishedAt ? ` | ${item.publishedAt}` : ''}${
          item.severity ? ` | severity=${item.severity}` : ''
        }`,
    )
    .join('\n')
}

/**
 * @param question - the user's question, verbatim.
 * @param catalog - documents this run can reach.
 * @param model - the BYO model client.
 * @param lang - output language contract.
 * @returns the parsed intent; falls back to a single sub-question if the model
 *   returns none, so the pipeline never proceeds with an empty work list.
 */
export async function parseIntent(
  question: string,
  catalog: DocumentSummary[],
  model: ModelClient,
  lang: MeridianLang,
  skillQuestions: string[] = [],
): Promise<Intent> {
  const prompt = intentPrompt(question, lang, renderCatalog(catalog), skillQuestions)
  const reply = await model.complete({ system: prompt.system, user: prompt.user, json: true })
  const parsed = parseJsonReply<IntentReply>(reply.text)

  const subQuestions = (parsed.sub_questions ?? [])
    .map((item, index) => ({ id: item.id?.trim() || `Q${index + 1}`, text: (item.text ?? '').trim() }))
    .filter((item) => item.text)

  const questionType = QUESTION_TYPES.includes(parsed.question_type as QuestionType)
    ? (parsed.question_type as QuestionType)
    : 'fact_extraction'

  // The recipe's coverage is enforced here, not requested in the prompt: a
  // skill's sub-questions may be rephrased or reordered by the model, but one
  // that vanishes is added back. "May extend, may not drop" is a property of
  // the pipeline, not a favour from the model.
  const enforced = [...subQuestions]
  const used = new Set(enforced.map((question) => question.id))
  let nextIndex = 1
  const freeId = (): string => {
    while (used.has(`Q${nextIndex}`)) nextIndex += 1
    const id = `Q${nextIndex}`
    used.add(id)
    return id
  }
  for (const item of skillQuestions) {
    if (!coversItem(item, enforced)) enforced.push({ id: freeId(), text: item })
  }

  return {
    entity: {
      name: parsed.entity?.name?.trim() || question.slice(0, 40),
      ...(parsed.entity?.symbol ? { symbol: parsed.entity.symbol } : {}),
      ...(parsed.entity?.market ? { market: parsed.entity.market } : {}),
    },
    lang,
    questionType,
    subQuestions: enforced.length > 0 ? enforced : [{ id: 'Q1', text: question }],
    seeksAdvice: parsed.seeks_advice === true,
  }
}

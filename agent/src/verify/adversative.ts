/**
 * Deterministic candidate selection for the Step 4a adversative sweep.
 *
 * The selector deliberately has a very small field of view: it may inspect
 * only paragraphs that the same sub-question already cites. This lets the
 * model recover a skipped middle sentence without turning the sweep into a
 * second, vocabulary-driven read of the filing.
 *
 * @module @meridian/agent/verify/adversative
 */

import type { Claim, EvidenceRef } from '../contract.ts'
import type { SourceDocument } from '../source/types.ts'
import { foldScript } from './script.ts'

/**
 * WP-M18-ADV vocabulary v1. Keep this list narrow.
 *
 * In particular, generic boilerplate wording such as `不存在` and bare discourse
 * markers such as `但` / `然而` are intentionally absent. Both scripts remain
 * visible here for auditability even though matching happens after script folding.
 */
export const ADVERSATIVE_RE =
  /不认可|不予认可|明确反馈不|明確反饋不|异议|異議|反对|反對|不同意|暂未收到|暫未收到|尚未回复|尚未回覆|未回复|未回覆|不具备.{0,6}基础|不具備.{0,6}基礎|不构成|不構成/

export interface AdversativeCandidate {
  documentId: string
  text: string
  /** True for the uncovered sentence that fired the vocabulary. */
  matched: boolean
}

export interface AdversativeTarget {
  questionId: string
  question: string
  candidates: AdversativeCandidate[]
  /** Ranking key, kept separate from the context sentences. */
  hitCount: number
}

interface TextRange {
  documentId: string
  start: number
  end: number
  text: string
}

/**
 * Select at most three questions for one run, highest hit count first.
 * Ties retain sub-question order and every question carries at most four
 * sentences: all matched sentences first, then their immediate context.
 */
export function adversativeSweepTargets(
  questions: { id: string; text: string }[],
  claims: Claim[],
  evidence: EvidenceRef[],
  documents: SourceDocument[],
  maxQuestions = 3,
): AdversativeTarget[] {
  const evidenceById = new Map(evidence.map((item) => [item.id, item]))
  const documentById = new Map(documents.map((item) => [item.id, item]))
  const targets: (AdversativeTarget & { questionIndex: number })[] = []

  for (const [questionIndex, question] of questions.entries()) {
    const ownedEvidence = claims
      .filter((claim) => claim.questionId === question.id)
      .flatMap((claim) => claim.evidenceIds)
      .map((id) => evidenceById.get(id))
      .filter((item): item is EvidenceRef => Boolean(item))
    if (ownedEvidence.length === 0) continue

    const paragraphs = new Map<string, TextRange>()
    for (const item of ownedEvidence) {
      const document = documentById.get(item.documentId)
      if (!document) continue
      const paragraph = paragraphAt(document.id, document.text, item.charStart, item.charEnd)
      if (paragraph) paragraphs.set(`${paragraph.documentId}:${paragraph.start}:${paragraph.end}`, paragraph)
    }

    const hits: TextRange[] = []
    const neighbours: TextRange[] = []
    for (const paragraph of paragraphs.values()) {
      const sentences = sentenceRanges(paragraph)
      for (const [index, sentence] of sentences.entries()) {
        if (isCited(sentence, ownedEvidence)) continue
        if (characterLength(sentence.text) < 8) continue
        if (!ADVERSATIVE_RE.test(foldScript(sentence.text))) continue
        hits.push(sentence)
        const before = sentences[index - 1]
        const after = sentences[index + 1]
        if (before) neighbours.push(before)
        if (after) neighbours.push(after)
      }
    }
    if (hits.length === 0) continue

    const candidates: AdversativeCandidate[] = []
    const seen = new Set<string>()
    const add = (range: TextRange, matched: boolean): void => {
      if (candidates.length >= 4) return
      const key = `${range.documentId}:${range.start}:${range.end}`
      if (seen.has(key)) {
        if (matched) {
          const existing = candidates.find((item) => item.documentId === range.documentId && item.text === range.text)
          if (existing) existing.matched = true
        }
        return
      }
      seen.add(key)
      candidates.push({ documentId: range.documentId, text: range.text, matched })
    }
    // A context sentence must never crowd out a sentence that actually fired.
    for (const hit of hits) add(hit, true)
    for (const neighbour of neighbours) add(neighbour, false)

    targets.push({
      questionId: question.id,
      question: question.text,
      candidates,
      hitCount: hits.length,
      questionIndex,
    })
  }

  return targets
    .sort((left, right) => right.hitCount - left.hitCount || left.questionIndex - right.questionIndex)
    .slice(0, maxQuestions)
    .map(({ questionIndex: _questionIndex, ...target }) => target)
}

/** Find the exact blank-line block containing an accepted evidence span. */
function paragraphAt(documentId: string, text: string, start: number, end: number): TextRange | undefined {
  if (start < 0 || end <= start || end > text.length) return undefined
  let paragraphStart = 0
  for (const boundary of text.matchAll(/\r?\n[\t ]*\r?\n/g)) {
    const boundaryStart = boundary.index
    if (start < boundaryStart) return trimRange(documentId, text, paragraphStart, boundaryStart)
    paragraphStart = boundaryStart + boundary[0].length
  }
  return trimRange(documentId, text, paragraphStart, text.length)
}

/** Split one paragraph without ever changing the source characters. */
function sentenceRanges(paragraph: TextRange): TextRange[] {
  const ranges: TextRange[] = []
  let start = paragraph.start
  const source = paragraph.text
  for (const boundary of source.matchAll(/[\u3002\uff01\uff1f!?\uff1b;]+|\r?\n/g)) {
    const end = paragraph.start + boundary.index + boundary[0].length
    const range = trimRange(paragraph.documentId, source, start - paragraph.start, end - paragraph.start, paragraph.start)
    if (range) ranges.push(range)
    start = end
  }
  const tail = trimRange(
    paragraph.documentId,
    source,
    start - paragraph.start,
    paragraph.end - paragraph.start,
    paragraph.start,
  )
  if (tail) ranges.push(tail)
  return ranges
}

/** Trim only at range edges while retaining offsets into the original document. */
function trimRange(
  documentId: string,
  source: string,
  rawStart: number,
  rawEnd: number,
  offset = 0,
): TextRange | undefined {
  let start = rawStart
  let end = rawEnd
  while (start < end && /\s/.test(source[start] ?? '')) start += 1
  while (end > start && /\s/.test(source[end - 1] ?? '')) end -= 1
  if (end <= start) return undefined
  return { documentId, start: offset + start, end: offset + end, text: source.slice(start, end) }
}

function isCited(sentence: TextRange, evidence: EvidenceRef[]): boolean {
  return evidence.some(
    (item) => item.documentId === sentence.documentId && item.charStart < sentence.end && item.charEnd > sentence.start,
  )
}

function characterLength(text: string): number {
  return [...text.replace(/\s/g, '')].length
}

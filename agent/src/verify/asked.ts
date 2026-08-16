/**
 * What quantity a sub-question is asking for, and which sentences could answer it.
 *
 * The four-round post-mortem in WP-M11-CITE put the citation variance here: not
 * in which sentence a claim cites, but in whether the fact was extracted at all.
 * A round where nothing states the ceiling scores zero however well its other
 * citations are chosen.
 *
 * So when a sub-question comes back answered-in-general-only, the pipeline gets
 * one more, narrower attempt — and the candidates for that attempt are chosen
 * mechanically: sentences that carry a figure of the kind the question asks for.
 * That key works across languages, which word overlap does not: an English
 * question about total proceeds and a Chinese sentence reading 「…万元」 share no
 * words at all and every unit in the world.
 *
 * @module @meridian/agent/verify/asked
 */

import { detectUnitHints, extractNumbers } from './numbers.ts'
import { foldScript } from './script.ts'
import { coverage, splitPassages } from './text.ts'

/** Kinds of quantity a question can ask for. */
export type AskedKind = 'amount' | 'count' | 'percent' | 'price' | 'date' | 'doc_no'

/** Question vocabulary per kind, in all three output languages. */
const ASK_PATTERNS: [AskedKind, RegExp][] = [
  ['price', /每股|单价|價格|价格|发行价|發行價|price per share|unit price|issue price/i],
  ['amount', /金额|金額|总额|總額|余额|餘額|募集资金|募集資金|对价|對價|代价|规模|規模|amount|proceeds|consideration|value|cost/i],
  ['count', /多少股|股数|股數|数量|數量|份额|份額|number of shares|how many shares|quantity|volume/i],
  ['percent', /比例|占比|佔比|百分|幅度|增速|利率|percentage|share of|ratio|proportion/i],
  ['date', /何时|何時|哪一天|日期|时间安排|時間安排|when|which date|what date/i],
  ['doc_no', /文号|案号|哪一份.*(?:文书|文書)|which legal document|case number|document number/i],
]

/**
 * Which quantities does this question ask for?
 *
 * @param question - the sub-question, in any output language.
 * @returns the kinds it asks for; empty when it asks for no quantity at all.
 */
export function askedKinds(question: string): Set<AskedKind> {
  const folded = foldScript(question)
  const kinds = new Set<AskedKind>()
  for (const [kind, pattern] of ASK_PATTERNS) if (pattern.test(folded)) kinds.add(kind)
  return kinds
}

/** Does this sentence carry a figure of one of these kinds? */
function carriesKind(sentence: string, kinds: Set<AskedKind>, declaredAmountUnit = false): boolean {
  if (kinds.size === 0) return /\d/.test(sentence)
  const tokens = extractNumbers(sentence)
  for (const token of tokens) {
    if (kinds.has('percent') && token.kind === 'percent') return true
    if (kinds.has('date') && token.kind === 'date') return true
    if (kinds.has('amount') && token.kind === 'amount') return true
    if (kinds.has('amount') && declaredAmountUnit && token.kind === 'scalar') return true
    if (kinds.has('price') && (token.unit ?? '').includes('/')) return true
    if (kinds.has('price') && token.kind === 'amount' && /每股|\/\s*股|per share/i.test(sentence)) return true
    if (kinds.has('count') && token.kind === 'scalar' && /股|份|shares?/i.test(sentence)) return true
    if (kinds.has('doc_no') && token.kind === 'doc_no') return true
  }
  return false
}

/** Longest verbatim candidate assembled across newline-split passages. */
const MAX_SPAN = 240

/** A passage without terminal punctuation was split only by document layout. */
function hasOpenBoundary(text: string): boolean {
  const trimmed = text.trimEnd()
  return trimmed.length > 0 && !/[。！？!?;；]$/.test(trimmed)
}

interface PassageSpan {
  text: string
  start: number
  end: number
}

/** Passage offsets aligned to the trimmed text returned by splitPassages. */
function passageSpans(documentText: string): PassageSpan[] {
  return splitPassages(documentText).map((passage) => {
    const located = documentText.indexOf(passage.text, passage.start)
    const start = located < 0 ? passage.start : located
    return { text: passage.text, start, end: start + passage.text.length }
  })
}

/** Extend one open passage through following open boundaries as a verbatim slice. */
function joinedPassage(documentText: string, passages: PassageSpan[], index: number): string {
  const first = passages[index]
  if (!first) return ''
  let last = index
  while (hasOpenBoundary(passages[last]?.text ?? '')) {
    const next = passages[last + 1]
    if (!next || next.end - first.start > MAX_SPAN) break
    last += 1
  }
  return documentText.slice(first.start, passages[last]?.end ?? first.end)
}

/** A sentence offered as a candidate answer, with why it was offered. */
export interface FigureCandidate {
  documentId: string
  text: string
  /** Ranking inputs, kept so the choice can be replayed from the audit trail. */
  overlap: number
  kindMatch: boolean
}

/**
 * Sentences that could answer a question asking for a figure.
 *
 * Deterministic: the same documents and question always produce the same list,
 * in the same order. Ranking is kind match first — a question about a price is
 * answered by a sentence carrying a price, whatever language either is in — then
 * word overlap, then document order.
 *
 * @param documents - retrieved documents.
 * @param question - the sub-question that came back answered-in-general-only.
 * @param limit - how many candidates to return.
 * @returns candidate sentences, best first.
 */
export function figureCandidates(
  documents: { id: string; text: string }[],
  question: string,
  limit = 6,
): FigureCandidate[] {
  const kinds = askedKinds(question)
  const scored: FigureCandidate[] = []
  const broadFallback: FigureCandidate[] = []
  for (const document of documents) {
    const declaredAmountUnit = detectUnitHints(document.text).length > 0
    const passages = passageSpans(document.text)
    for (let index = 0; index < passages.length; index += 1) {
      const text = joinedPassage(document.text, passages, index)
      if (text.length < 8 || !/\d/.test(text)) continue
      const kindMatch = carriesKind(text, kinds, declaredAmountUnit)
      const candidate = { documentId: document.id, text, overlap: coverage(question, text), kindMatch }
      broadFallback.push(candidate)
      if (!kindMatch && kinds.size > 0) continue
      scored.push(candidate)
    }
  }
  // Before these broad table labels entered the vocabulary they followed the
  // no-kind path and still received numeric candidates. Preserve that recall
  // when a document has no declared unit with which to classify bare scalars.
  const candidates = scored.length === 0 && /余额|餘額|利率/.test(foldScript(question)) ? broadFallback : scored
  return candidates
    .sort((left, right) => Number(right.kindMatch) - Number(left.kindMatch) || right.overlap - left.overlap)
    .slice(0, limit)
}

/**
 * Does this sentence state a figure of one of these kinds?
 *
 * The mirror of {@link figureCandidates}'s filter, applied to a claim rather
 * than to a source sentence: used to decide whether a recovered claim actually
 * answers the question that asked for a figure.
 *
 * @param text - the claim's text.
 * @param kinds - the kinds the question asks for.
 * @returns true when the claim carries a figure of one of them.
 */
export function statesKind(text: string, kinds: Set<AskedKind>): boolean {
  return carriesKind(text, kinds)
}

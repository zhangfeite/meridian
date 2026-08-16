/**
 * Small lexical helpers for locating candidate passages.
 *
 * These do not score anything a user sees — verification is exact-match work.
 * They exist so the pipeline can *help the model quote correctly*: when a claim
 * is rejected for a quote that is not in the document, the repair round is
 * handed the actual sentences that talk about the same thing.
 *
 * CJK runs become character bigrams and Latin text becomes words, which is the
 * cheapest overlap measure that works for both scripts without a tokenizer.
 *
 * @module @meridian/agent/verify/text
 */

import { foldScript } from './script.ts'

/**
 * Blank out the parts of a rendered memo that are addressing, not assertion.
 *
 * The number sweep asks "does the memo state a figure no source supports?".
 * Three constructs answer that question wrongly if taken literally:
 *
 * - claim anchors (`[C-D]`) — a cross-reference;
 * - source URLs (`…?announcementId=1225472188`) — a permalink;
 * - file paths (`2026-filings/MB-001/announcement.txt`) — where the document
 *   lives.
 *
 * None is a claim about the world, and reading one as a financial figure is a
 * category error. The path case is the one that bites hardest because it is
 * invisible in testing: the bench legend happens to read `context/announcement.txt`,
 * which contains no digits, so only a real path (`…/MB-001/…`) exposes it — and
 * then `-001` is swept up as an unsourced negative number and the whole memo is
 * refused.
 *
 * The path pattern is deliberately restricted to path characters so it stops at
 * CJK: 「详见announcement.txt的说明」 must lose the filename, not the sentence.
 *
 * @param markdown - the rendered memo.
 * @returns the same text with those constructs replaced by spaces.
 */
export function maskNonContent(markdown: string): string {
  return markdown
    .replace(/\[[A-Z]-[A-Z]+\]/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    // A path whose components are Chinese: `2026-filings/MB-001/公告.txt`. The
    // ASCII-only pattern below stops at the CJK component and leaves `MB-001`
    // behind, whose `-001` is then swept as an unsourced negative number. The
    // match must start on an ASCII component so a filename embedded in Chinese
    // prose does not swallow the sentence before it.
    .replace(
      /[A-Za-z0-9_.-]+(?:[\\/][^\s，,。；;：:「」『』()（）"']+)+\.(?:txt|pdf|md|csv|json|xml|html?|docx?)\b/gi,
      ' ',
    )
    .replace(/[A-Za-z0-9_.\\/-]*\.(?:txt|pdf|md|csv|json|xml|html?|docx?)\b/gi, ' ')
}

/** Lexical units of a string: CJK bigrams, Latin words, and numbers. */
export function semanticUnits(value: string): Set<string> {
  // Folded, so a traditional sub-question and a simplified filing produce the
  // same units. Every lexical comparison in the pipeline reaches this function,
  // which is the point: one entry, not a fold at each call site to forget.
  const normalized = foldScript(value.normalize('NFKC').toLowerCase())
  const units = new Set<string>(normalized.match(/[a-z]+(?:'[a-z]+)?|[-+]?\d[\d,.%/-]*/g) ?? [])
  for (const run of normalized.match(/[㐀-鿿]+/g) ?? []) {
    if (run.length === 1) units.add(run)
    else for (let index = 0; index < run.length - 1; index += 1) units.add(run.slice(index, index + 2))
  }
  return units
}

/**
 * Share of `reference`'s units that occur in `candidate`.
 *
 * @param reference - the text whose coverage is being measured.
 * @param candidate - the text to measure against.
 * @returns 0…1; an empty reference is trivially covered.
 */
export function coverage(reference: string, candidate: string): number {
  const referenceUnits = semanticUnits(reference)
  if (referenceUnits.size === 0) return 1
  const candidateUnits = semanticUnits(candidate)
  let shared = 0
  for (const unit of referenceUnits) if (candidateUnits.has(unit)) shared += 1
  return shared / referenceUnits.size
}

/** Split a document into sentence-sized passages with their offsets. */
export function splitPassages(text: string): { text: string; start: number }[] {
  const passages: { text: string; start: number }[] = []
  let start = 0
  for (const match of text.matchAll(/[。！？!?；;\n]+/g)) {
    const end = match.index + match[0].length
    const slice = text.slice(start, end).trim()
    if (slice) passages.push({ text: slice, start })
    start = end
  }
  const tail = text.slice(start).trim()
  if (tail) passages.push({ text: tail, start })
  return passages
}

/**
 * Break an over-long passage into quotable fragments on secondary punctuation.
 *
 * Chinese filings routinely run 300 characters between full stops, and the most
 * important sentence in an announcement is usually the longest one. Handing the
 * model a whole paragraph invites it to retype a summary; handing it clause-
 * sized fragments — each still a verbatim substring — invites it to copy.
 *
 * @param passage - the passage to split.
 * @param maxLength - target fragment length.
 * @returns fragments in order, each a substring of `passage`.
 */
export function quotableFragments(passage: string, maxLength = 140): string[] {
  if (passage.length <= maxLength) return [passage]
  const parts = passage.split(/(?<=[，、,])/)
  const fragments: string[] = []
  let buffer = ''
  for (const part of parts) {
    if (buffer && (buffer + part).length > maxLength) {
      fragments.push(buffer)
      buffer = part
    } else {
      buffer += part
    }
  }
  if (buffer) fragments.push(buffer)
  return fragments
}

/**
 * Find the document fragments most likely to contain a claim's support.
 *
 * @param documents - retrieved documents, as `{id, text}`.
 * @param claimText - the claim whose quote failed to locate.
 * @param limit - how many fragments to return.
 * @returns the best fragments, highest overlap first.
 */
export function candidatePassages(
  documents: { id: string; text: string }[],
  claimText: string,
  limit = 3,
  options: { preferNumbers?: boolean } = {},
): { documentId: string; text: string; score: number }[] {
  const scored: { documentId: string; text: string; score: number }[] = []
  for (const document of documents) {
    for (const passage of splitPassages(document.text)) {
      for (const fragment of quotableFragments(passage.text)) {
        const trimmed = fragment.trim()
        if (trimmed.length < 8) continue
        let score = coverage(claimText, trimmed)
        if (score <= 0.25) continue
        // A "how much" question is answered by a passage containing a figure.
        // Word overlap alone ranks boilerplate that echoes the question's nouns
        // above the one sentence that states the number.
        if (options.preferNumbers && /\d/.test(trimmed)) score += 0.35
        scored.push({ documentId: document.id, text: trimmed, score })
      }
    }
  }
  // Shortest sufficient wins. When two passages are about equally relevant, the
  // tighter one is the better citation: it is easier to check, it is what a gold
  // annotator would have quoted, and padding around the fact only dilutes the
  // overlap a reader (or a scorer) can see. Relevance still leads — this only
  // breaks ties inside a band.
  return scored
    .sort((left, right) => band(right.score) - band(left.score) || left.text.length - right.text.length)
    .slice(0, limit)
}

/** Round a relevance score into a 0.05-wide band for tie-breaking. */
function band(score: number): number {
  return Math.round(score * 20)
}

/**
 * Disclosure language that explains why something is *not* stated.
 *
 * A filing rarely says "we are not disclosing X". It says the stage has not been
 * reached — 「截至本公告披露日，公司尚未收到法院……的文件」 — which is the
 * sentence a reader actually needs next to a "not disclosed" answer. Recognizing
 * that register is what lets the pipeline cite a gap instead of merely asserting
 * one.
 */
/**
 * The filing saying a thing has not happened, is not set, or is not stated.
 *
 * Deliberately narrow. Procedural and forward-looking phrasing — 「将依法指定
 * 管理人」, 「能否被受理」, 「存在重大不确定性」, 「法院已立案审查」 — describes a
 * process; it does not report a non-disclosure. Treating it as one lets any
 * procedural sentence be attached to any unanswered question, which is how a
 * memo ends up "citing" something that has nothing to do with what was asked.
 */
const ABSENCE_LANGUAGE =
  /(尚未|仍未|暂未|暫未|尚无|尚無|暂无|暫無|未确定|未確定|未指定|未披露|未揭露|未提及|未说明|未說明|未明确|未明確|无法核实|無法核實|没有披露|沒有揭露|尚需|尚待|not yet|has not|have not|not disclosed|not stated|not specified|undetermined)/g

/**
 * Units too common to establish that a passage is about the question.
 *
 * 「公司」 appears in every sentence of every filing; matching on it would make
 * the topical floor no floor at all.
 */
const GENERIC_UNITS = new Set([
  '公司', '本次', '是否', '多少', '哪家', '什么', '什麼', '披露', '揭露', '公告', '是谁', '是誰',
  '机构', '機構', '情况', '情況', '有关', '有關', '相关', '相關', '进行', '進行', '以及', '关于',
  '關於', '是多', '的是', 'the', 'of', 'is', 'are', 'what', 'which', 'company',
])

/** Question terms substantive enough to establish topical relevance. */
export function keyUnits(questionText: string): string[] {
  return [...semanticUnits(questionText)].filter((unit) => !GENERIC_UNITS.has(unit))
}

/**
 * Find the closest on-topic passage reached by deterministic retrieval.
 *
 * Unlike {@link selectSupportingPassage}, this does not require absence
 * language: it is an exhibit of what the run came closest to, not support for
 * the proposition that an answer is absent.
 *
 * @param documents - retrieved documents.
 * @param questionText - the sub-question that came up empty.
 * @param accept - optional pre-ranking filter, used to exclude non-compliant quotes.
 * @returns the closest passage, or `undefined` when no distinctive unit is shared.
 */
export function selectNearestPassage(
  documents: { id: string; text: string }[],
  questionText: string,
  accept: (text: string) => boolean = () => true,
): { documentId: string; text: string; shared: number } | undefined {
  const wanted = keyUnits(questionText)
  const candidates: { documentId: string; text: string; shared: number }[] = []
  for (const document of documents) {
    for (const passage of splitPassages(document.text)) {
      for (const fragment of quotableFragments(passage.text)) {
        const trimmed = fragment.trim()
        if (trimmed.length < 10 || !accept(trimmed)) continue
        const units = semanticUnits(trimmed)
        const shared = wanted.filter((unit) => units.has(unit)).length
        if (shared === 0) continue
        candidates.push({ documentId: document.id, text: trimmed, shared })
      }
    }
  }
  if (candidates.length === 0) return undefined
  candidates.sort(
    (left, right) =>
      right.shared - left.shared ||
      left.text.length - right.text.length ||
      left.documentId.localeCompare(right.documentId) ||
      left.text.localeCompare(right.text),
  )
  return candidates[0]
}

/**
 * Does `haystack` engage with the topic `item` names?
 *
 * Whole-item coverage is the wrong measure for a checklist entry: 「计提数据是否
 * 未经审计,以及公告对此的表述」 is a *question about a topic*, and a memo that
 * answers it says 「未经审计」 without echoing the question's grammar. Measured
 * that way every item reads as unmet, which makes the whole checklist useless
 * as a signal. Distinctive-term overlap discriminates: it separates 「未经审计」
 * (answered) from 「转回或为负数」 (genuinely never discussed).
 *
 * @param item - the checklist entry.
 * @param haystack - the memo's published text.
 * @param share - fraction of the item's distinctive terms that must appear.
 * @returns true when the memo engages with the topic.
 */
export function touchesTopic(item: string, haystack: string, share = 0.4): boolean {
  const wanted = keyUnits(item)
  if (wanted.length === 0) return true
  const present = semanticUnits(haystack)
  const hits = wanted.filter((unit) => present.has(unit)).length
  return hits / wanted.length >= share
}

/**
 * Find the passage that best explains why a question has no answer.
 *
 * @param documents - retrieved documents.
 * @param questionText - the sub-question that came up empty.
 * @returns the supporting passage, or `undefined` when the sources offer none.
 */
export function selectSupportingPassage(
  documents: { id: string; text: string }[],
  questionText: string,
): { documentId: string; text: string; markers: number; shared: number } | undefined {
  const wanted = keyUnits(questionText)
  const candidates: { documentId: string; text: string; markers: number; shared: number }[] = []
  for (const document of documents) {
    for (const passage of splitPassages(document.text)) {
      for (const fragment of quotableFragments(passage.text)) {
        const trimmed = fragment.trim()
        if (trimmed.length < 10) continue
        // Gate 1 — it must actually report a non-disclosure.
        ABSENCE_LANGUAGE.lastIndex = 0
        const markers = new Set(trimmed.match(ABSENCE_LANGUAGE) ?? []).size
        if (markers === 0) continue
        // Gate 2 — and it must be about what was asked. Without this, the
        // shortest "not yet" sentence in the filing gets attached to every
        // unanswered question regardless of subject.
        const units = semanticUnits(trimmed)
        const shared = wanted.filter((unit) => units.has(unit)).length
        if (shared === 0) continue
        candidates.push({ documentId: document.id, text: trimmed, markers, shared })
      }
    }
  }
  // No qualifying passage means no citation. A gap sentence with no quote is
  // honest and scores less; a gap sentence with an unrelated quote is neither.
  if (candidates.length === 0) return undefined
  // Rank: most explicit about the absence, then most on-topic, then shortest.
  candidates.sort(
    (left, right) =>
      right.markers - left.markers || right.shared - left.shared || left.text.length - right.text.length,
  )
  return candidates[0]
}

/**
 * Choosing which span of a document a claim actually cites.
 *
 * The model proposes a quote; until now the pipeline took the first place that
 * quote landed and published it. That is deterministic in the trivial sense —
 * same input, same output — but the *input* is a sample: two runs of the same
 * task propose different fragments of the same paragraph, and the memo's
 * citations move with them. On a task whose gold has a single key point, that
 * shows up as a citation score flipping between full marks and zero across runs
 * with nothing else changed.
 *
 * So the proposal is treated as a pointer *into* the document rather than as the
 * citation itself: the pipeline widens it to whole sentences, extends it until it
 * covers every figure the claim states, and — when the proposal occurs more than
 * once — picks between the occurrences by a fixed rule. What gets published is
 * still a verbatim, contiguous run of the document's own characters; what
 * changes is that two runs proposing different halves of the same sentence now
 * publish the same citation.
 *
 * The ranking never looks at anything but the claim, the document, and the
 * proposal. There is no notion here of a "right" answer to match.
 *
 * @module @meridian/agent/verify/span
 */

import { locateQuote } from './evidence.ts'
import { extractNumbers } from './numbers.ts'
import { foldScript } from './script.ts'
import { coverage, splitPassages } from './text.ts'

/** A chosen citation span, with the reasoning that chose it. */
export interface QuoteSpan {
  /** The document's own characters at the span. */
  quote: string
  charStart: number
  charEnd: number
  /** Decision path, for the audit trail: occurrences considered and why this won. */
  path: string
  /** True when the span differs from what the model proposed. */
  adjusted: boolean
}

/**
 * Longest span the selector will build.
 *
 * A citation is a pointer. Past a couple of sentences the reader is being handed
 * the paragraph back and asked to find it themselves, so the extension stops
 * even if a figure is still uncovered — the claim then fails number binding,
 * which is the correct outcome for a sentence whose figures are scattered.
 */
const MAX_SPAN = 240

/** Every place a proposal lands in the document, in document order. */
function occurrences(documentText: string, proposal: string): { start: number; end: number }[] {
  const trimmed = proposal.trim()
  if (!trimmed) return []
  const found: { start: number; end: number }[] = []
  for (let from = documentText.indexOf(trimmed); from >= 0; from = documentText.indexOf(trimmed, from + 1)) {
    found.push({ start: from, end: from + trimmed.length })
  }
  if (found.length > 0) return found

  // Same span, other glyph shapes or spacing: fall back to the locator, which
  // knows about both. One occurrence is all it reports, which is fine — this is
  // already the unusual path.
  const located = locateQuote(documentText, trimmed)
  return located ? [{ start: located.charStart, end: located.charEnd }] : []
}

/** Sentence-sized units of a document, with offsets, computed once per document. */
const passageCache = new WeakMap<{ text: string }, { text: string; start: number; end: number }[]>()

function passagesOf(document: { text: string }): { text: string; start: number; end: number }[] {
  const cached = passageCache.get(document)
  if (cached) return cached
  const passages = splitPassages(document.text).map((passage) => ({
    text: passage.text,
    start: passage.start,
    end: passage.start + passage.text.length,
  }))
  passageCache.set(document, passages)
  return passages
}

/** Figures the claim states, as they would have to appear in a quote. */
function claimFigures(claimText: string): string[] {
  return extractNumbers(claimText)
    .filter((token) => token.kind !== 'date' || /\d{4}/.test(token.raw))
    .map((token) => token.raw.trim())
    .filter(Boolean)
}

/** How many of the claim's figures this text carries. */
function covered(text: string, figures: string[]): number {
  const folded = foldScript(text)
  return figures.filter((figure) => folded.includes(foldScript(figure))).length
}

/**
 * Choose the span a claim should cite.
 *
 * @param document - the document the quote was located in.
 * @param proposal - the quote as the model wrote it.
 * @param claimText - the sentence the quote has to support.
 * @returns the chosen span, or undefined when the proposal is not in the document.
 */
export function chooseQuoteSpan(
  document: { text: string },
  proposal: string,
  claimText: string,
): QuoteSpan | undefined {
  const places = occurrences(document.text, proposal)
  if (places.length === 0) return undefined

  const figures = claimFigures(claimText)
  const passages = passagesOf(document)

  const candidates = places.map((place) => {
    // Widen to whole sentences: a fragment cut mid-clause is not a citation a
    // reader can check, and two runs cut it in different places.
    const first = passages.findIndex((passage) => passage.end > place.start)
    const last = passages.findIndex((passage) => passage.end >= place.end)
    let from = first < 0 ? 0 : first
    let to = last < 0 ? passages.length - 1 : last
    const span = (): { start: number; end: number } => ({
      start: passages[from]?.start ?? place.start,
      end: passages[to]?.end ?? place.end,
    })
    const textOf = (): string => document.text.slice(span().start, span().end).trim()

    // Extend while a figure the claim states is still outside the span and the
    // neighbouring sentence carries it. Forward first, then backward — a fixed
    // order, so two runs that start from different fragments of the same
    // paragraph converge on the same span.
    let extended = false
    for (let guard = 0; guard < 4 && covered(textOf(), figures) < figures.length; guard += 1) {
      const next = passages[to + 1]
      const previous = passages[from - 1]
      const missing = figures.filter((figure) => !foldScript(textOf()).includes(foldScript(figure)))
      const helps = (passage: { text: string } | undefined): boolean =>
        Boolean(passage) && missing.some((figure) => foldScript(passage!.text).includes(foldScript(figure)))
      if (helps(next) && (span().end - span().start) + (next as { text: string }).text.length <= MAX_SPAN) {
        to += 1
        extended = true
      } else if (
        helps(previous) &&
        (span().end - span().start) + (previous as { text: string }).text.length <= MAX_SPAN
      ) {
        from -= 1
        extended = true
      } else {
        break
      }
    }

    // Trim by moving the offsets, never by trimming the string: the published
    // quote has to be sliceable out of the document at exactly these offsets.
    const finalSpan = span()
    let start = finalSpan.start
    let end = finalSpan.end
    while (start < end && /\s/.test(document.text[start] as string)) start += 1
    while (end > start && /\s/.test(document.text[end - 1] as string)) end -= 1
    const text = document.text.slice(start, end)
    return {
      quote: text,
      charStart: start,
      charEnd: end,
      figures: covered(text, figures),
      overlap: coverage(claimText, text),
      extended,
    }
  })

  // The ranking, in order and with no ties left to chance:
  //   1. carries more of the claim's figures — a citation that cannot support
  //      the sentence's numbers is not that sentence's citation;
  //   2. shares more wording with the claim;
  //   3. shorter — a pointer, not a paragraph;
  //   4. earlier in the document.
  const ranked = [...candidates].sort(
    (left, right) =>
      right.figures - left.figures ||
      right.overlap - left.overlap ||
      left.quote.length - right.quote.length ||
      left.charStart - right.charStart,
  )
  const best = ranked[0]
  if (!best) return undefined

  const trimmedProposal = proposal.trim()
  const adjusted = best.quote !== trimmedProposal
  const path = [
    `occurrences=${places.length}`,
    `figures=${best.figures}/${figures.length}`,
    `overlap=${best.overlap.toFixed(2)}`,
    `chars=${best.quote.length}`,
    best.extended ? 'extended-to-figure' : 'sentence-aligned',
  ].join(' ')

  return { quote: best.quote, charStart: best.charStart, charEnd: best.charEnd, path, adjusted }
}

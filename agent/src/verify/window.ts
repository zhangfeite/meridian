/**
 * Reading a document that does not fit in one prompt.
 *
 * A hundred-page prospectus cannot be handed to a model in a single call, and
 * the two obvious ways of coping are both wrong. Truncating it invents an
 * absence: the model answers "not disclosed" about a figure printed on page
 * eighty, and the pipeline publishes that as a verified gap. Sending it anyway
 * costs a truncated reply, which — before this module existed — took the whole
 * task down with `model reply was not JSON`.
 *
 * So a long document is read in windows. Extraction sees every window in order,
 * which is what keeps a needle on page eighty findable; the follow-up steps
 * (repair, counter-evidence, gap review) see the windows most relevant to what
 * they are asking about, because they already arrive carrying ranked candidate
 * passages and their job is narrower.
 *
 * Windows are cut on passage boundaries and overlap, so a sentence stays whole
 * in at least one of them — a quote the model copies out of a window has to be
 * verifiable against the whole document, and half a sentence is not. The one
 * exception is a "passage" with no sentence terminator in it at all, which in a
 * filing means a table; those are cut to size, because an oversized window
 * truncates the reply it asks for.
 *
 * @module @meridian/agent/verify/window
 */

import type { SourceDocument } from '../source/types.ts'
import { coverage, splitPassages } from './text.ts'

/** One readable slice of a document. */
export interface DocumentWindow {
  text: string
  /** Offset into the document, for the reader's orientation only. */
  start: number
  /** 1-based position among the document's windows. */
  index: number
  total: number
}

/**
 * Characters per window.
 *
 * Sized for the smallest context this pipeline claims to support rather than
 * the largest available: a BYO model with a 32k window has to survive the same
 * prospectus.
 */
export const WINDOW_CHARS = 16_000

/** Overlap between neighbours, so a fact stated across a boundary is whole in one of them. */
const WINDOW_OVERLAP = 600

/**
 * Cut a document into overlapping windows on passage boundaries.
 *
 * @param text - the document text.
 * @param size - target window size in characters.
 * @returns one window when the document already fits, several otherwise.
 */
export function windowDocument(text: string, size = WINDOW_CHARS): DocumentWindow[] {
  if (text.length <= size) return [{ text, start: 0, index: 1, total: 1 }]

  const windows: { text: string; start: number }[] = []
  let buffer = ''
  const passages = splitPassages(text).flatMap((passage) => {
    // A "passage" longer than a whole window is a table with no sentence
    // terminators in it. Cutting one mid-row is not good, but a window that
    // silently doubles in size is worse: that is what truncated the replies on
    // the first windowed MB-018 run.
    if (passage.text.length <= size) return [passage]
    const parts: { text: string; start: number }[] = []
    for (let offset = 0; offset < passage.text.length; offset += size) {
      parts.push({
        text: passage.text.slice(offset, offset + size),
        start: passage.start + offset,
      })
    }
    return parts
  })
  let start = passages[0]?.start ?? 0
  for (const passage of passages) {
    const piece = text.slice(passage.start, passage.start + passage.text.length)
    if (buffer && buffer.length + piece.length > size) {
      windows.push({ text: buffer, start })
      // Carry the tail forward: a figure and the sentence that gives it its
      // unit are routinely on opposite sides of a cut.
      const carry = buffer.slice(-WINDOW_OVERLAP)
      buffer = carry + piece
      start = passage.start - carry.length
    } else {
      if (!buffer) start = passage.start
      buffer += piece
    }
  }
  if (buffer.trim()) windows.push({ text: buffer, start })

  return windows.map((window, index) => ({
    ...window,
    index: index + 1,
    total: windows.length,
  }))
}

/**
 * Rank windows by how much they look like an answer to `focus`.
 *
 * @param windows - the document's windows.
 * @param focus - questions or claims the caller is asking about.
 * @param limit - how many windows to keep.
 * @returns the best windows, back in document order.
 */
export function selectWindows(
  windows: DocumentWindow[],
  focus: string[],
  limit: number,
): DocumentWindow[] {
  if (windows.length <= limit) return windows
  const scored = windows.map((window) => ({
    window,
    score: Math.max(0, ...focus.map((item) => coverage(item, window.text))),
  }))
  // The first window is always kept: filings put 「重大事项提示」 and the summary
  // of terms at the front, and a relevance score computed on word overlap alone
  // will happily rank a mid-document boilerplate section above them.
  const head = scored[0]
  const rest = scored
    .slice(1)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(0, limit - 1))
  const kept = new Set([head?.window.index, ...rest.map((item) => item.window.index)])
  return windows.filter((window) => kept.has(window.index))
}

/**
 * Render a document as one of its windows, labelled as an excerpt.
 *
 * The label is not decoration. A model handed 16k characters of a 220k-character
 * prospectus, with no indication that there is more, reports everything it
 * cannot see as undisclosed — which is precisely the false gap this module
 * exists to prevent.
 *
 * @param document - the document being read.
 * @param window - the window to show.
 * @returns a document whose text is the window and whose title says so.
 */
export function asWindowView(document: SourceDocument, window: DocumentWindow): SourceDocument {
  if (window.total <= 1) return document
  return {
    ...document,
    title: `${document.title} (节选 ${window.index}/${window.total};本文档超长,分段阅读,未出现在本段的内容不等于文件未披露)`,
    text: window.text,
  }
}

/**
 * Bound a document set for a follow-up prompt.
 *
 * @param documents - the retrieved documents.
 * @param focus - what the prompt is asking about.
 * @param budget - total characters the prompt may carry.
 * @returns documents whose long members are reduced to their most relevant windows.
 */
export function boundDocuments(
  documents: SourceDocument[],
  focus: string[],
  budget = 3 * WINDOW_CHARS,
): SourceDocument[] {
  const total = documents.reduce((sum, document) => sum + document.text.length, 0)
  if (total <= budget) return documents
  const perDocument = Math.max(1, Math.floor(budget / Math.max(1, documents.length) / WINDOW_CHARS))
  return documents.map((document) => {
    const windows = windowDocument(document.text)
    if (windows.length <= 1) return document
    const kept = selectWindows(windows, focus, perDocument)
    return {
      ...document,
      title: `${document.title} (节选 ${kept
        .map((window) => `${window.index}/${window.total}`)
        .join('、')};本文档超长,仅摘取相关段落,未出现的内容不等于文件未披露)`,
      text: kept.map((window) => window.text).join('\n……\n'),
    }
  })
}

/**
 * Quote verification: a citation is a pointer into a document, not a retelling.
 *
 * The model proposes a quote; this module finds it in the source and replaces
 * it with the document's own characters at the located offsets. A quote that
 * cannot be located is not "close enough" — the claim carrying it is dropped.
 *
 * Whitespace is the one tolerated difference. Exchange filings arrive from PDF
 * extraction riddled with inserted spaces and line breaks, and a model that
 * retypes `8,815.45 万元` as `8,815.45万元` has not misquoted anything. Word
 * order, characters, and digits must match exactly.
 *
 * @module @meridian/agent/verify/evidence
 */

import { foldScript } from './script.ts'

/** Where a quote was found. */
export interface QuoteLocation {
  /** The document's own text at the located span — this is what gets published. */
  quote: string
  charStart: number
  charEnd: number
  /** False when the match required whitespace normalization. */
  exact: boolean
}

const WHITESPACE = /[\s　​]+/g

/**
 * Locate a proposed quote inside a document.
 *
 * @param documentText - the retrieved document, verbatim.
 * @param quote - the passage the model claims to be quoting.
 * @returns the located span, or `undefined` when the passage is not in the document.
 */
export function locateQuote(documentText: string, quote: string): QuoteLocation | undefined {
  const trimmed = quote.trim()
  if (!trimmed) return undefined

  const direct = documentText.indexOf(trimmed)
  if (direct >= 0) {
    return { quote: trimmed, charStart: direct, charEnd: direct + trimmed.length, exact: true }
  }

  // Same span, other glyph shapes: a model answering in traditional characters
  // retypes a simplified filing's sentence, and the exact search misses a quote
  // that is genuinely there. The fold is length-preserving, so an offset into
  // the folded document is an offset into the document — and what gets
  // published is a slice of the *original*, in the filing's own characters.
  const shaped = foldScript(documentText).indexOf(foldScript(trimmed))
  if (shaped >= 0) {
    return {
      quote: documentText.slice(shaped, shaped + trimmed.length),
      charStart: shaped,
      charEnd: shaped + trimmed.length,
      exact: false,
    }
  }

  // Whitespace-insensitive search: strip whitespace from both sides while
  // keeping an index map back to the original offsets. Folded too, so a quote
  // needs to differ in only one of the two ways to still be found.
  const { stripped, offsets } = stripWhitespace(foldScript(documentText))
  const needle = foldScript(trimmed).replace(WHITESPACE, '')
  if (!needle) return undefined
  const index = stripped.indexOf(needle)
  if (index < 0) return undefined

  const charStart = offsets[index]
  const lastOffset = offsets[index + needle.length - 1]
  if (charStart === undefined || lastOffset === undefined) return undefined
  const charEnd = lastOffset + 1
  return { quote: documentText.slice(charStart, charEnd), charStart, charEnd, exact: false }
}

/** Remove whitespace, keeping a map from stripped index to original index. */
function stripWhitespace(text: string): { stripped: string; offsets: number[] } {
  const characters: string[] = []
  const offsets: number[] = []
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (/[\s　​]/.test(character)) continue
    characters.push(character)
    offsets.push(index)
  }
  return { stripped: characters.join(''), offsets }
}

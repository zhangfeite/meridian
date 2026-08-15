/**
 * Claim identifiers, deliberately digit-free.
 *
 * A memo's prose carries visible anchors (`…存在重大不确定性。[C-D]`) so a reader
 * can jump from a sentence to the itemized fact and its quote. Numbering those
 * anchors `[C10]` would be the obvious choice and the wrong one: every numeric
 * extractor downstream — ours, a benchmark's, a customer's — then has to be
 * taught that this particular 10 is not a figure from a filing. Letters make
 * the anchor unambiguous by construction, in the memo and in every tool that
 * ever reads it.
 *
 * @module @meridian/agent/ids
 */

/**
 * Encode a 0-based index as `A`, `B`, … `Z`, `AA`, `AB`, …
 *
 * @param index - 0-based position.
 * @returns the letter sequence.
 */
export function letters(index: number): string {
  let remaining = index
  let encoded = ''
  do {
    encoded = String.fromCharCode(65 + (remaining % 26)) + encoded
    remaining = Math.floor(remaining / 26) - 1
  } while (remaining >= 0)
  return encoded
}

/**
 * Build a sequential id allocator, e.g. `C-A`, `C-B`, …
 *
 * @param prefix - single-letter namespace (`C` for claims, `U` for gaps).
 * @returns a function returning the next id.
 */
export function idAllocator(prefix: string): () => string {
  let next = 0
  return () => `${prefix}-${letters(next++)}`
}

/** Matches a rendered claim anchor. Digit-free by construction. */
export const ANCHOR_RE = /\[[A-Z]-[A-Z]+\]/g

/**
 * Whole-string form of {@link ANCHOR_RE}.
 *
 * Separate because it is not global: `test()` on a `/g` regex advances
 * `lastIndex` and returns alternating results, which is a bug generator.
 */
export const ANCHOR_EXACT_RE = /^\[[A-Z]-[A-Z]+\]$/

/** Matches a rendered claim anchor, capturing the id. */
export const ANCHOR_CAPTURE_RE = /\[([A-Z]-[A-Z]+)\]/g

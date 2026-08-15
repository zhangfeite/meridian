/**
 * Shared evidence id allocation.
 *
 * Extraction and counter-evidence retrieval both intern passages, and both must
 * hand out the same id for the same span — otherwise a memo can cite one
 * sentence of a filing under two names, and the citation graph stops being a
 * graph.
 *
 * @module @meridian/agent/evidence-pool
 */

import type { EvidenceRef } from './contract.ts'

/** Interning pool for located passages. */
export class EvidencePool {
  readonly items: EvidenceRef[] = []
  #next = 1

  /**
   * Intern one located passage.
   *
   * @param entry - the located span and its provenance.
   * @returns the interned reference; the same span always returns the same id.
   */
  intern(entry: Omit<EvidenceRef, 'id'>): EvidenceRef {
    const existing = this.items.find(
      (item) =>
        item.documentId === entry.documentId &&
        item.charStart === entry.charStart &&
        item.charEnd === entry.charEnd,
    )
    if (existing) return existing
    const evidence: EvidenceRef = { id: `E${this.#next++}`, ...entry }
    this.items.push(evidence)
    return evidence
  }
}

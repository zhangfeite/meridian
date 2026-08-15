/**
 * Step 7b — the checklist audit.
 *
 * "Was this topic addressed?" is a semantic question, and the lexical landing
 * check that answers it today is honestly coarse. The right tool is a model
 * call. But a model call is a fresh hallucination surface bolted onto a memo
 * that has just passed the gate, so this one runs under three constraints:
 *
 * 1. **It annotates, never asserts.** The audit's output reaches
 *    `memo.checklist` and the audit log. Not one word of it enters the memo's
 *    prose. The only thing it can add to the page is a fixed, digit-free caution
 *    line whose wording is ours, emitted by the renderer from structured state.
 * 2. **Every verdict must be locatable.** A verdict comes with a passage the
 *    auditor claims to have read in the memo; if that passage is not in the memo
 *    verbatim, the verdict degrades to `unverified`. A claim about the memo that
 *    cannot be found in the memo is exactly as trustworthy as a claim about a
 *    filing that cannot be found in the filing.
 * 3. **It cannot block.** Failure, timeout, or garbage falls back to the lexical
 *    judgement and says so. The gate has already passed; the audit is an
 *    enhancement, and an enhancement that can refuse publication is a gate
 *    nobody reviewed.
 *
 * @module @meridian/agent/steps/audit
 */

import type { AuditRecord, ChecklistEntry, MeridianLang } from '../contract.ts'
import { parseJsonReply, type ModelClient } from '../model.ts'
import { checklistAuditPrompt, AUDIT_PROMPT_VERSION } from '../prompts.ts'
import { memoPreamble } from '../render.ts'

/** Verdicts the auditor may return. */
const VERDICTS = new Set(['addressed', 'not_addressed', 'contradicted'])

/**
 * Longest locating quote we accept. Not a display limit: a quote is trimmed by
 * nobody, because trimming would let an auditor prepend sixty real characters to
 * a fabricated tail and have the fabrication accepted along with the verdict.
 * Over the limit is over.
 */
const MAX_LOCATOR = 60

interface AuditVerdict {
  itemIndex: number
  verdict: string
  quote: string
}

/**
 * Pull well-formed verdicts out of whatever the model returned.
 *
 * The reply is parsed JSON, which means it is `unknown` wearing a costume:
 * `results` may be an object, a string, an array of nulls, or an array of
 * objects whose `quote` is a number. Every one of those has to end as a
 * disclosed degradation rather than a `TypeError` thrown through the pipeline
 * from a step that runs after the gate.
 *
 * @param reply - parsed model reply, of unknown shape.
 * @returns the verdicts that survived structural validation.
 */
function readVerdicts(reply: unknown): AuditVerdict[] {
  if (typeof reply !== 'object' || reply === null) return []
  const results = (reply as { results?: unknown }).results
  if (!Array.isArray(results)) return []
  const verdicts: AuditVerdict[] = []
  for (const item of results) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as { item_index?: unknown; verdict?: unknown; quote?: unknown }
    if (typeof record.item_index !== 'number' || !Number.isInteger(record.item_index)) continue
    if (typeof record.verdict !== 'string') continue
    // A non-string quote is not a pointer. Treated as absent, which fails every
    // verdict that needs one — silently coercing it would be inventing evidence.
    const quote = typeof record.quote === 'string' ? record.quote : ''
    verdicts.push({ itemIndex: record.item_index, verdict: record.verdict, quote })
  }
  return verdicts
}

/** Step 7b output. */
export interface ChecklistAuditResult {
  checklist: ChecklistEntry[]
  audit: AuditRecord[]
  /** True when the audit ran and at least one verdict was accepted. */
  applied: boolean
}

/**
 * Audit the checklist against the finished memo.
 *
 * @param entries - lexical checklist entries, already computed.
 * @param memoText - the rendered memo, prose and appendix.
 * @param model - the BYO model client.
 * @param lang - output language contract.
 * @returns updated entries plus an audit trail; never throws.
 */
export async function auditChecklist(
  entries: ChecklistEntry[],
  memoText: string,
  model: ModelClient,
  lang: MeridianLang,
): Promise<ChecklistAuditResult> {
  if (entries.length === 0) return { checklist: entries, audit: [], applied: false }

  const audit: AuditRecord[] = []
  // Boilerplate is not engagement. A live MB-011 run had the auditor certify
  // 「数据是否经过审计」 by pointing at the memo's own preamble, so the preamble is
  // removed from what the auditor reads and from what a locator may match.
  const preamble = memoPreamble(lang)
  const auditable = memoText.split(preamble).join('')
  let parsed: unknown
  try {
    const prompt = checklistAuditPrompt(
      entries.map((entry) => entry.item),
      auditable,
      lang,
    )
    const reply = await model.complete({ system: prompt.system, user: prompt.user, json: true })
    parsed = parseJsonReply<unknown>(reply.text)
  } catch (error) {
    // The memo is already publishable; the audit simply did not happen.
    audit.push({
      step: 'audit',
      action: 'audit_degraded',
      detail: `checklist audit unavailable, lexical judgement stands: ${
        error instanceof Error ? error.message : String(error)
      }`,
    })
    return { checklist: entries, audit, applied: false }
  }

  const byIndex = new Map<number, AuditVerdict>()
  for (const result of readVerdicts(parsed)) byIndex.set(result.itemIndex, result)
  if (byIndex.size === 0) {
    audit.push({
      step: 'audit',
      action: 'audit_degraded',
      detail: 'checklist audit returned no usable verdicts, lexical judgement stands',
    })
    return { checklist: entries, audit, applied: false }
  }

  let applied = false
  const checklist = entries.map((entry, index) => {
    const result = byIndex.get(index)
    if (!result || !VERDICTS.has(result.verdict)) return entry
    const verdict = result.verdict as 'addressed' | 'not_addressed' | 'contradicted'
    const quote = result.quote.trim()

    // `not_addressed` is the one verdict with nothing to point at — the absence
    // of a passage is the finding. Everything else must be locatable.
    if (verdict === 'not_addressed') {
      applied = true
      return { ...entry, verdict, source: 'audit' as const }
    }

    // Character-for-character containment in the memo as published — no
    // whitespace tolerance, no truncation, and matched against the real
    // rendering rather than the preamble-stripped copy the auditor read, so a
    // span that only becomes contiguous once the preamble is removed fails.
    const failure =
      quote.length === 0
        ? 'came with no locating quote'
        : quote.length > MAX_LOCATOR
          ? `cited ${quote.length} characters, past the sixty-character limit on a pointer: ${quote.slice(0, MAX_LOCATOR)}`
          : !memoText.includes(quote)
            ? `cited a passage that is not in the memo verbatim: ${quote}`
            : preamble.includes(quote)
              ? `cited only the memo's fixed preamble, which is boilerplate rather than engagement: ${quote}`
              : undefined
    if (failure !== undefined) {
      audit.push({
        step: 'audit',
        action: 'checklist_audit_unverified',
        detail: `verdict '${verdict}' for 「${entry.item}」 ${failure}`,
      })
      applied = true
      return { ...entry, verdict: 'unverified' as const, source: 'audit' as const }
    }

    if (verdict === 'contradicted') {
      audit.push({
        step: 'audit',
        action: 'checklist_contradicted',
        detail: `the memo states something contrary to 「${entry.item}」: ${quote}`,
      })
    }
    applied = true
    // Verbatim by construction: the check above was containment in the memo, so
    // these are the memo's own characters, not the auditor's retyping of them.
    return { ...entry, verdict, locator: quote, source: 'audit' as const }
  })

  return { checklist, audit, applied }
}

/** Recorded in provenance so a reader knows which model judged the checklist. */
export const AUDIT_VERSION = AUDIT_PROMPT_VERSION

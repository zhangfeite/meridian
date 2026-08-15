/**
 * Prose assembly with the numbers locked.
 *
 * A memo made of bullet points is verifiable and unreadable; a memo written by
 * a language model is readable and unverifiable. This module takes the third
 * option: **the prose is assembled from verified claims, and the polishing pass
 * never sees a digit.**
 *
 * Every number in the deterministic draft is replaced by a letter placeholder
 * (`⟦A⟧`) before the model is asked to make the text flow. The model returns
 * prose containing those same placeholders; the pipeline substitutes its own
 * renderings back.
 *
 * The acceptance rules are adversarial on purpose — each one closes a way a
 * polishing model could change what the memo asserts while looking obedient:
 *
 * | rule | attack it closes |
 * |---|---|
 * | no digits, and no numerals spelled out in words | writing `1,050万元` / `一千零五十万元` outright |
 * | every offered placeholder survives | deleting `⟦B⟧` so a verified figure silently disappears |
 * | no invented placeholder | conjuring `⟦ZZ⟧` |
 * | each placeholder stays with its own claim's anchors | swapping `⟦A⟧` and `⟦B⟧` between sentences, so both still "bind" but the figures are attached to the wrong facts |
 * | every sentence carries an anchor | appending an unattributed assertion |
 * | vocabulary stays close to the draft | smuggling new content ("公司经营稳健") into an anchored sentence |
 * | all anchors survive, in every block | dropping a claim |
 *
 * A paragraph that fails any of them falls back to the deterministic draft —
 * which is itself verified before publication, and dropped if it fails. The
 * memo reads worse, or says less; it never says something new.
 *
 * @module @meridian/agent/prose
 */

import type {
  AuditRecord,
  Claim,
  DerivedNumber,
  EvidenceRef,
  MeridianLang,
  NarrativeBlock,
  NarrativeParagraph,
} from './contract.ts'
import { ANCHOR_CAPTURE_RE, ANCHOR_RE, idAllocator } from './ids.ts'
import { parseJsonReply, type ModelClient } from './model.ts'
import { prosePolishPrompt } from './prompts.ts'
import { bindNumbers } from './verify/bind.ts'
import { scanCompliance } from './verify/compliance.ts'
import { extractNumbers, writtenNumerals } from './verify/numbers.ts'
import { semanticUnits } from './verify/text.ts'

/** A deterministic paragraph before polishing. */
export interface ProseDraft {
  /** Digit-free id used as the payload key (`P-A`). */
  id: string
  /** Human-readable name for audit messages (`conclusion`, `Q1`, `risks`). */
  label: string
  kind: NarrativeBlock['kind']
  heading: string
  /** Draft text with every number replaced by a `⟦X⟧` placeholder. */
  skeleton: string
  claimIds: string[]
  questionId?: string
  /**
   * Carries verbatim source text, so it is never sent to the writing model.
   *
   * Two reasons, both hard: a quote that goes through polish is no longer a
   * quote, and the draft holds the filing's own digits — sending it would break
   * the guarantee that the writing model never sees a number.
   */
  locked?: boolean
}

/** Localized connective tissue. Fixed strings — this is gate surface. */
const STRINGS: Record<
  MeridianLang,
  {
    conclusion: string
    findings: string
    risks: string
    inferenceLead: string
    counterLead: string
    counterMissing: string
    sourceLead: string
  }
> = {
  'zh-CN': {
    conclusion: '结论',
    findings: '关键发现',
    risks: '风险与反证',
    inferenceLead: '模型推断',
    counterLead: '反方证据显示',
    counterMissing: '未能找到反方证据',
    sourceLead: '原文',
  },
  'zh-TW': {
    conclusion: '結論',
    findings: '關鍵發現',
    risks: '風險與反證',
    inferenceLead: '模型推斷',
    counterLead: '反方證據顯示',
    counterMissing: '未能找到反方證據',
    sourceLead: '原文',
  },
  en: {
    conclusion: 'Conclusion',
    findings: 'Key findings',
    risks: 'Risks and counter-evidence',
    inferenceLead: 'Model inference',
    counterLead: 'against which the sources show',
    counterMissing: 'no counter-evidence could be found',
    sourceLead: 'Source',
  },
}

/** Text that marks a claim as being about risk, in any of the three locales. */
const RISK_MARKERS =
  /(风险|風險|不确定|不確定|警示|退市|破产|破產|逾期|亏损|虧損|违法|違法|处罚|處罰|risk|uncertain|delist|default|penalt)/i

/** The subset that decides which risks lead the section. */
const SEVERE_MARKERS =
  /(退市|終止上市|终止上市|破产|破產|强制|強制|违法|違法|处罚|處罰|重大不确定|重大不確定|delist|bankrupt|penalt)/g

/** Placeholder token: letters only, so "contains a digit" stays a clean test. */
const PLACEHOLDER_RE = /⟦[A-Z]+⟧/g

/**
 * A number written in words rather than digits.
 *
 * `extractNumbers` sees digits, so `一千零五十万元` and `one thousand fifty`
 * would sail through the digit check and land in the memo as an unsourced
 * figure. Runs of two or more numeral characters are the signal; a lone 一 is
 * ordinary Chinese ("一致行动关系") and is not.
 */
/**
 * A single numeral character is ordinary Chinese ("一致", "十分") — until it is
 * carrying a quantity. `金额为五元`, `百分之五`, and `三成` are figures written
 * one character at a time. {@link writtenNumerals} is the shared detector; this
 * module and the skill validator must agree on what counts as a number.
 */

/**
 * Connectives a rewrite may introduce without it counting as new content.
 * Kept small on purpose: this is an allowance for glue, not for prose.
 */
const CONNECTIVE_UNITS = new Set([
  '其中', '同时', '同時', '因此', '此外', '并且', '並且', '以及', '而且', '不过', '不過',
  '然而', '另外', '其后', '其後', '随后', '隨後', '据此', '據此', '为此', '為此', '由于',
  '由於', '基于', '基於', '截至', '目前', '方面', '相关', '相關', '整体', '整體', '总体',
  '總體', '综上', '綜上', '与此', '與此', '在此', '就此', '对此', '對此', '主要', '进一',
  '一步', '进而', '進而', '从而', '從而', '例如', '包括', '此前', '此次', '本次', '上述',
  'and', 'also', 'while', 'whereas', 'therefore', 'moreover', 'meanwhile', 'however',
  'further', 'additionally', 'accordingly', 'the', 'of', 'in', 'to', 'a', 'as', 'at',
])

/** How much new vocabulary a rewrite may introduce before it stops being one. */
const NOVELTY_ALLOWANCE = 8
const NOVELTY_RATIO = 0.12

/** Encode a 0-based index as `A`, `B`, … `AA`. */
function placeholderToken(index: number): string {
  let n = index
  let letters = ''
  do {
    letters = String.fromCharCode(65 + (n % 26)) + letters
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return `⟦${letters}⟧`
}

/** Mints placeholders, keeps one stable token per source number, and remembers
 * which claim each token came from. */
interface Locker {
  /**
   * Replace every number in `text` with a placeholder.
   *
   * @param text - text to lock.
   * @param key - cache key; the same key returns the same tokens.
   * @param owner - claim id the numbers belong to.
   */
  lock(text: string, key: string, owner: string): string
  /** placeholder → the pipeline's rendering of that number. */
  readonly values: Map<string, string>
  /** placeholder → the claim whose sentence it came from. */
  readonly owners: Map<string, string>
}

/**
 * Build a locker.
 *
 * The same number gets the same placeholder everywhere it appears — a figure
 * quoted in the conclusion and again in the findings is one token, not two.
 */
function createLocker(): Locker {
  const values = new Map<string, string>()
  const owners = new Map<string, string>()
  const byKey = new Map<string, string>()
  let next = 0
  return {
    values,
    owners,
    lock(text: string, key: string, owner: string): string {
      const tokens = extractNumbers(text)
      let locked = text
      const ordered = [...tokens].sort((left, right) => right.start - left.start)
      for (const token of ordered) {
        const identity = `${key}#${token.start}#${token.raw}`
        let placeholder = byKey.get(identity)
        if (!placeholder) {
          placeholder = placeholderToken(next++)
          byKey.set(identity, placeholder)
          values.set(placeholder, token.raw)
          owners.set(placeholder, owner)
        }
        locked = `${locked.slice(0, token.start)}${placeholder}${locked.slice(token.end)}`
      }
      return locked
    },
  }
}

/** Inputs for {@link buildProse}. */
export interface ProseInput {
  claims: Claim[]
  evidence: EvidenceRef[]
  derived: DerivedNumber[]
  subQuestions: { id: string; text: string }[]
  headings: Map<string, string>
  lang: MeridianLang
  entityName: string
  /** documentId → source sigil, when the memo labels citations by source. */
  sigilByDocument?: Map<string, string>
  /**
   * claimId → evidence id of the passage that explains that claim being an
   * absence. Rendered inline, verbatim, right after the sentence it backs.
   */
  absenceSupport?: Map<string, string>
}

/** Output of {@link buildProse}. */
export interface ProseResult {
  blocks: NarrativeBlock[]
  audit: AuditRecord[]
  /** Paragraphs drafted, improved by the writing pass, rejected by it, and dropped entirely. */
  stats: { drafted: number; polished: number; rejected: number; dropped: number }
}

/**
 * Build the memo's prose: deterministic drafts, one polishing call, verified
 * substitution.
 *
 * @param input - verified claims and their supporting material.
 * @param model - the BYO model client; omit to skip polishing entirely.
 * @returns narrative blocks, an audit trail, and polish statistics.
 */
export async function buildProse(input: ProseInput, model?: ModelClient): Promise<ProseResult> {
  const locker = createLocker()
  const placeholders = locker.values
  const drafts = draftParagraphs(input, locker)
  const audit: AuditRecord[] = []
  const stats = { drafted: drafts.length, polished: 0, rejected: 0, dropped: 0 }

  if (drafts.length === 0) return { blocks: [], audit, stats }

  const polishedById = model ? await polish(drafts, input, model, audit) : new Map<string, string>()

  const evidenceById = new Map(input.evidence.map((item) => [item.id, item]))
  const claimById = new Map(input.claims.map((item) => [item.id, item]))
  const paragraphs: (NarrativeParagraph & { draft: ProseDraft })[] = []

  /**
   * Substitute, verify, and publish one candidate rendering.
   * @returns true when the paragraph was published.
   */
  const publish = (locked: string, claimIds: string[], polished: boolean, draft: ProseDraft): boolean => {
    const text = substitute(locked, placeholders)
    // Counter-evidence quotes are part of the risks paragraph, so their numbers
    // are bindable there too — the claim cites them by construction.
    const anchorEvidence = claimIds
      .flatMap((id) => {
        const claim = claimById.get(id)
        if (!claim) return []
        return claim.type === 'model_inference'
          ? [...claim.evidenceIds, ...claim.counterEvidence.evidenceIds]
          : claim.evidenceIds
      })
      .map((id) => evidenceById.get(id))
      .filter((item): item is EvidenceRef => Boolean(item))
    const anchorDerived = claimIds
      .flatMap((id) => claimById.get(id)?.numbers ?? [])
      .map((number) => input.derived.find((item) => item.id === number.derivedId))
      .filter((item): item is DerivedNumber => Boolean(item))
    // Anchors are markup: `[C-C]` is a cross-reference, not a number.
    const bound = bindNumbers(withoutAnchors(text), anchorEvidence, anchorDerived)
    const compliance = scanCompliance(text, input.lang)
    if (bound.unbound.length > 0 || !compliance.passed) {
      audit.push({
        step: 'compose',
        action: 'prose_polish_rejected',
        detail: `${draft.id} (${draft.label}): ${polished ? 'polished' : 'draft'} prose failed verification (${
          bound.unbound.map((token) => token.raw).join(', ') || compliance.hits[0]?.rule
        })`,
      })
      return false
    }
    if (polished) stats.polished += 1
    paragraphs.push({
      draft,
      text,
      claimIds,
      polished,
      ...(draft.questionId === undefined ? {} : { questionId: draft.questionId }),
    })
    return true
  }

  for (const draft of drafts) {
    const candidate = polishedById.get(draft.id)
    if (candidate !== undefined) {
      const verdict = verifyPolish(candidate, draft, locker)
      if (verdict === undefined) {
        if (publish(candidate, anchorsOf(candidate, draft), true, draft)) continue
      } else {
        audit.push({
          step: 'compose',
          action: 'prose_polish_rejected',
          detail: `${draft.id} (${draft.label}): ${verdict}`,
        })
      }
      stats.rejected += 1
    }
    // The draft is not trusted either: a claim edited out from under it, or a
    // counter-evidence quote whose number no longer binds, must not publish.
    if (!publish(draft.skeleton, draft.claimIds, false, draft)) stats.dropped += 1
  }

  const blocks: NarrativeBlock[] = []
  for (const kind of ['conclusion', 'findings', 'risks'] as const) {
    const owned = paragraphs.filter((item) => item.draft.kind === kind)
    if (owned.length === 0) continue
    blocks.push({
      kind,
      heading: STRINGS[input.lang][kind],
      paragraphs: owned.map(({ draft: _draft, ...paragraph }) => paragraph),
    })
  }

  return { blocks, audit, stats }
}

/** Run the writing pass and return whatever it produced, keyed by draft id. */
async function polish(
  drafts: ProseDraft[],
  input: ProseInput,
  model: ModelClient,
  audit: AuditRecord[],
): Promise<Map<string, string>> {
  try {
    const polishable = drafts.filter((draft) => !draft.locked)
    if (polishable.length === 0) return new Map()
    const prompt = prosePolishPrompt(
      polishable.map((draft) => ({
        id: draft.id,
        // Headings and the entity name are metadata, and metadata carries
        // digits ("2023年虚增了多少?", "361度"). Masking them keeps the promise
        // this whole module rests on: the writing model never sees a number.
        heading: maskDigits(draft.heading),
        text: draft.skeleton,
        anchors: draft.claimIds,
      })),
      input.lang,
      maskDigits(input.entityName),
    )
    const reply = await model.complete({ system: prompt.system, user: prompt.user, json: true })
    const parsed = parseJsonReply<{ paragraphs?: { id?: string; text?: string }[] }>(reply.text)
    const polished = new Map(
      (parsed.paragraphs ?? [])
        .filter((item): item is { id: string; text: string } =>
          typeof item.id === 'string' && typeof item.text === 'string',
        )
        .map((item) => [item.id, item.text]),
    )
    const returned = [...polished.keys()]
    const matched = returned.filter((id) => polishable.some((draft) => draft.id === id))
    if (matched.length < polishable.length) {
      // A silent partial reply is the difference between a memo that reads well
      // and one that reads like a list; without this line the cause is invisible.
      audit.push({
        step: 'compose',
        action: 'prose_polish_rejected',
        detail: `writing pass returned ${matched.length}/${polishable.length} paragraphs${
          returned.length > matched.length
            ? ` (unknown ids: ${returned.filter((id) => !matched.includes(id)).join(', ')})`
            : ''
        }; the rest publish as drafts`,
      })
    }
    return polished
  } catch (error) {
    audit.push({
      step: 'compose',
      action: 'prose_polish_rejected',
      detail: `polishing call failed, deterministic draft published: ${
        error instanceof Error ? error.message : String(error)
      }`,
    })
    return new Map()
  }
}

/** Assemble the deterministic drafts, numbers already locked. */
function draftParagraphs(input: ProseInput, locker: Locker): ProseDraft[] {
  const drafts: ProseDraft[] = []
  const strings = STRINGS[input.lang]
  const nextId = idAllocator('P')
  const byQuestion = new Map<string, Claim[]>()
  for (const claim of input.claims) {
    byQuestion.set(claim.questionId, [...(byQuestion.get(claim.questionId) ?? []), claim])
  }

  const sentence = (claim: Claim): string => `${locker.lock(claim.text, claim.id, claim.id)}[${claim.id}]`

  // Conclusion: the leading answer to each sub-question, in question order.
  const lead: Claim[] = []
  for (const question of input.subQuestions) {
    const owned = byQuestion.get(question.id) ?? []
    const first = owned.find((claim) => claim.type === 'fact') ?? owned[0]
    if (first) lead.push(first)
  }
  if (lead.length > 0) {
    drafts.push({
      id: nextId(),
      label: 'conclusion',
      kind: 'conclusion',
      heading: strings.conclusion,
      skeleton: lead.map(sentence).join(''),
      claimIds: lead.map((claim) => claim.id),
    })
  }

  // Findings: one paragraph per sub-question, every claim included.
  for (const question of input.subQuestions) {
    const owned = byQuestion.get(question.id) ?? []
    if (owned.length === 0) continue
    // A gap paragraph carries the filing sentence that explains the absence,
    // inline and verbatim — so the reader sees *why* nothing is disclosed
    // without leaving the body for the appendix.

    drafts.push({
      id: nextId(),
      label: question.id,
      kind: 'findings',
      heading: input.headings.get(question.id) ?? question.text,
      // Support goes *before* the anchor: the quote is part of the sentence it
      // backs, not a trailer after it.
      skeleton: owned
        .map(
          (claim) =>
            `${locker.lock(claim.text, claim.id, claim.id)}${supportFor(
              input.absenceSupport?.get(claim.id),
              input,
            )}[${claim.id}]`,
        )
        .join(''),
      claimIds: owned.map((claim) => claim.id),
      questionId: question.id,
      ...(owned.some((claim) => input.absenceSupport?.has(claim.id)) ? { locked: true } : {}),
    })
  }

  // Risks and counter-evidence: inferences with what argues against them, plus
  // risk-marked facts. This block is where the counter-evidence machinery shows.
  const inferences = input.claims.filter((claim) => claim.type === 'model_inference')
  // Risk facts also live in their findings paragraph, so this section repeats
  // them by design — but only the most severe few. A "risks" block that copies
  // eight sentences verbatim from above is noise, not emphasis.
  const riskFacts = input.claims
    .filter((claim) => claim.type !== 'model_inference' && RISK_MARKERS.test(claim.text))
    .map((claim) => ({ claim, weight: (claim.text.match(SEVERE_MARKERS) ?? []).length }))
    .sort((left, right) => right.weight - left.weight)
    .slice(0, 3)
    .map((item) => item.claim)
  const riskClaims = [...inferences, ...riskFacts]
  if (riskClaims.length > 0) {
    const parts: string[] = []
    for (const claim of riskClaims) {
      if (claim.type === 'model_inference') {
        const counters = claim.counterEvidence.evidenceIds
          .map((id) => input.evidence.find((item) => item.id === id)?.quote)
          .filter((quote): quote is string => Boolean(quote))
        const counterText =
          counters.length > 0 ? `${strings.counterLead}:${counters.join(';')}` : strings.counterMissing
        parts.push(
          `${strings.inferenceLead}:${locker.lock(claim.text, claim.id, claim.id)}${locker.lock(
            counterText,
            `${claim.id}-counter`,
            claim.id,
          )}[${claim.id}]`,
        )
      } else {
        parts.push(sentence(claim))
      }
    }
    drafts.push({
      id: nextId(),
      label: 'risks',
      kind: 'risks',
      heading: strings.risks,
      skeleton: parts.join(''),
      claimIds: riskClaims.map((claim) => claim.id),
    })
  }

  return drafts
}

/**
 * Render the verbatim support for a gap, for inline use in the body.
 *
 * @param claims - the gap claims of one sub-question.
 * @param input - evidence pool and locale.
 * @returns the parenthetical, or `''` when the gap has no supporting passage.
 */
function supportFor(evidenceId: string | undefined, input: ProseInput): string {
  if (!evidenceId) return ''
  const evidence = input.evidence.find((item) => item.id === evidenceId)
  if (!evidence) return ''
  const strings = STRINGS[input.lang]
  const sigil = input.sigilByDocument?.get(evidence.documentId)
  return `(${strings.sourceLead}:「${evidence.quote}」${sigil ? `(${sigil})` : ''})`
}

/** Anchors the model actually used, restricted to the ones it was given. */
function anchorsOf(text: string, draft: ProseDraft): string[] {
  const allowed = new Set(draft.claimIds)
  const used = [...text.matchAll(ANCHOR_CAPTURE_RE)].map((match) => match[1]).filter((id) => allowed.has(id))
  return used.length > 0 ? [...new Set(used)] : draft.claimIds
}

/** One run of text and the anchors that close it. */
interface AnchoredSegment {
  text: string
  anchors: string[]
}

/**
 * Split polished text into anchor-terminated segments.
 *
 * A segment is everything since the previous anchor run, closed by the anchors
 * that follow it — which is exactly the scope a sentence's figures belong to.
 * Text after the final anchor run is returned as `trailing`: content the model
 * attributed to nothing.
 *
 * @param text - polished paragraph.
 * @returns the segments and any unanchored tail.
 */
function anchoredSegments(text: string): { segments: AnchoredSegment[]; trailing: string } {
  const segments: AnchoredSegment[] = []
  const runs = [...text.matchAll(/(?:\[[A-Z]-[A-Z]+\])+/g)]
  let cursor = 0
  for (const run of runs) {
    const body = text.slice(cursor, run.index)
    const anchors = [...run[0].matchAll(ANCHOR_CAPTURE_RE)].map((match) => match[1])
    segments.push({ text: body, anchors })
    cursor = run.index + run[0].length
  }
  return { segments, trailing: text.slice(cursor) }
}

/**
 * Split into sentences, keeping each sentence's anchors with it.
 *
 * Anchors are written after the sentence they close, and a sentence ends with
 * its terminator — so `…有限公司。[C-A]` is one sentence, not a sentence plus a
 * stray anchor. Normalizing the anchor run to the inside of the terminator
 * before splitting keeps both placements (`…公司[C-A]。` and `…公司。[C-A]`)
 * meaning the same thing.
 *
 * @param text - polished or draft paragraph.
 * @returns sentences, each carrying whatever anchors closed it.
 */
function sentencesOf(text: string): string[] {
  const normalized = text.replace(/([。！？!?；;]+)((?:\[[A-Z]-[A-Z]+\])+)/g, '$2$1')
  return normalized.split(/(?<=[。！？!?；;])/)
}

/**
 * Numerals written in words rather than digits.
 *
 * Everything found here is compared against the draft, so a numeral the draft
 * already contains never fires — which is what makes it safe to be aggressive:
 * 「五个交易日」 in a rewrite that the draft never mentioned is number
 * information the model brought with it, and it should be rejected.
 */
function numeralWords(text: string): string[] {
  // Digits are checked separately by rule 1; this rule is about numerals the
  // digit scan cannot see.
  return writtenNumerals(text).filter((token) => !/^\d/.test(token))
}

/**
 * Check a polished paragraph before its numbers are restored.
 *
 * @param candidate - the model's rewrite.
 * @param draft - the draft it was given.
 * @param locker - placeholder values and their owning claims.
 * @returns the rejection reason, or `undefined` when the paragraph is accepted.
 */
function verifyPolish(candidate: string, draft: ProseDraft, locker: Locker): string | undefined {
  if (!candidate.trim()) return 'polished paragraph is empty'

  // 1. No digits. The model was handed none, so any it returns are its own.
  // Claim anchors are the one exception — markup it was told to keep.
  const stray = extractNumbers(withoutAnchors(candidate))
  if (stray.length > 0) {
    return `polish introduced digits that no claim supports: ${stray.map((token) => token.raw).join(', ')}`
  }

  // 2. No numerals spelled out either. Compared against the draft so that
  // ordinary words containing numeral characters ("一致", "十分") do not fire.
  const draftNumerals = new Set(numeralWords(draft.skeleton))
  const novelNumerals = [...new Set(numeralWords(candidate))].filter((run) => !draftNumerals.has(run))
  if (novelNumerals.length > 0) {
    return `polish spelled out a number the draft does not contain: ${novelNumerals.join(', ')}`
  }

  // 3. Placeholders: none invented, and none dropped. Dropping one deletes a
  // verified figure from the narrative while the anchor still claims it is there.
  const offered = new Set([...draft.skeleton.matchAll(PLACEHOLDER_RE)].map((match) => match[0]))
  const used = new Set([...candidate.matchAll(PLACEHOLDER_RE)].map((match) => match[0]))
  for (const token of used) {
    if (!offered.has(token)) return `polish invented placeholder ${token}`
    if (!locker.values.has(token)) return `polish used unknown placeholder ${token}`
  }
  const droppedTokens = [...offered].filter((token) => !used.has(token))
  if (droppedTokens.length > 0) {
    return `polish dropped verified figures: ${droppedTokens.join(', ')}`
  }

  // 4. Anchors: present, permitted, and complete — in every block, not just
  // findings. A conclusion that quietly drops a claim is the same defect.
  const allowed = new Set(draft.claimIds)
  const anchors = [...candidate.matchAll(ANCHOR_CAPTURE_RE)].map((match) => match[1])
  if (anchors.length === 0) return 'polish dropped every claim anchor'
  for (const anchor of anchors) {
    if (!allowed.has(anchor)) return `polish anchored to a claim it was not given: ${anchor}`
  }
  const covered = new Set(anchors)
  const missing = draft.claimIds.filter((id) => !covered.has(id))
  if (missing.length > 0) return `polish silently dropped claims: ${missing.join(', ')}`

  // 5. Every placeholder stays inside a sentence anchored to its own claim.
  // Without this, swapping ⟦A⟧ and ⟦B⟧ between two sentences still binds — the
  // paragraph's evidence pool contains both — and the memo attributes each
  // figure to the wrong fact.
  const { segments, trailing } = anchoredSegments(candidate)
  for (const segment of segments) {
    const anchorSet = new Set(segment.anchors)
    for (const match of segment.text.matchAll(PLACEHOLDER_RE)) {
      const owner = locker.owners.get(match[0])
      if (owner && !anchorSet.has(owner)) {
        return `polish moved ${match[0]} away from its claim ${owner} (sentence cites ${segment.anchors.join(', ')})`
      }
    }
  }

  // 6. No unanchored assertion. Text trailing the last anchor, or a sentence
  // with no anchor at all, is content attributed to nothing.
  if (trailing.replace(/[\s。.！!？?；;，,、]/g, '').length > 0) {
    return `polish added text after the last anchor: ${trailing.trim().slice(0, 40)}`
  }
  for (const part of sentencesOf(candidate)) {
    if (!part.replace(/[\s。.！!？?；;，,、]/g, '')) continue
    if (!/\[[A-Z]-[A-Z]+\]/.test(part)) {
      return `polish left a sentence unanchored: ${part.trim().slice(0, 40)}`
    }
  }

  // 7. Vocabulary stays close to the draft. Rules 1-6 all pass for an anchored
  // sentence of invented prose ("公司经营稳健[C-A]"); this is what stops it.
  // Rewriting adds connectives and little else, so the allowance is small.
  const draftUnits = semanticUnits(draft.skeleton)
  const novel = [...semanticUnits(candidate)].filter(
    (unit) => !draftUnits.has(unit) && !CONNECTIVE_UNITS.has(unit),
  )
  const budget = Math.max(NOVELTY_ALLOWANCE, Math.round(draftUnits.size * NOVELTY_RATIO))
  if (novel.length > budget) {
    return `polish introduced ${novel.length} new content units (budget ${budget}): ${novel.slice(0, 8).join(', ')}`
  }

  return undefined
}

/** Restore the pipeline's own renderings. */
function substitute(text: string, placeholders: Map<string, string>): string {
  return text.replace(PLACEHOLDER_RE, (token) => placeholders.get(token) ?? token)
}

/** Strip claim anchors so number verification sees content, not cross-references. */
function withoutAnchors(text: string): string {
  return text.replace(ANCHOR_RE, ' ')
}

/**
 * Remove every number from metadata that reaches the writing model.
 *
 * @param text - heading or entity name.
 * @returns the same text with numbers elided.
 */
export function maskDigits(text: string): string {
  const tokens = extractNumbers(text)
  let masked = text
  for (const token of [...tokens].sort((left, right) => right.start - left.start)) {
    masked = `${masked.slice(0, token.start)}…${masked.slice(token.end)}`
  }
  return masked
}

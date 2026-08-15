/**
 * Markdown rendering of a {@link Memo}.
 *
 * The JSON memo is the artifact; this is a view of it, in two halves that serve
 * two readers:
 *
 * - **The memo** — conclusion, key findings, risks and counter-evidence, in
 *   prose, each paragraph anchored to the claims it was built from.
 * - **The appendix** — every claim with its verbatim quote and source document,
 *   the calculation of every derived figure, and the source list. This is the
 *   half a reviewer (or a scorer) checks; the prose above is a view of exactly
 *   these lines and adds nothing to them.
 *
 * Two properties the renderer must preserve:
 *
 * 1. **Every appendix line carries its own citation** — claim text, then the
 *    quote, then which document it came from, on one line. A copied paragraph
 *    keeps its provenance, and multi-document memos never leave "which filing
 *    said this" to inference.
 * 2. **It introduces no numbers of its own.** No timestamps, no counts, no
 *    section numbering — every digit came from a filing or a registered
 *    derivation. Metadata lives in the JSON, where it cannot read as a finding.
 *
 * @module @meridian/agent/render
 */

import type { Claim, Memo, MeridianLang } from './contract.ts'

/** Rendering options. */
export interface RenderOptions {
  /** Prepended refusal for advice-seeking questions. */
  refusal?: string
}

interface Labels {
  title: string
  preamble: string
  fact: string
  opinion: string
  inference: string
  scenario: string
  unverifiable: string
  source: string
  attribution: string
  confidence: string
  period: string
  assumptions: string
  counterEvidence: string
  triggers: string
  appendix: string
  claimList: string
  calculations: string
  references: string
  openQuestions: string
  confidenceValue: Record<'low' | 'medium' | 'high', string>
}

const LABELS: Record<MeridianLang, Labels> = {
  'zh-CN': {
    title: '研究备忘录',
    preamble:
      '本备忘录只整理已公开披露的事实与其出处。正文每段末尾的方括号编号对应附录中的逐条事实;数字逐字取自原始文件,计算得到的数字在附录「计算过程」中给出公式。不构成投资建议。',
    fact: '事实',
    opinion: '他方观点',
    inference: '模型推断',
    scenario: '情景',
    unverifiable: '无法核实',
    source: '出处原句',
    attribution: '来源',
    confidence: '置信度',
    period: '期间',
    assumptions: '关键假设',
    counterEvidence: '反方证据',
    triggers: '触发条件',
    appendix: '数据附录',
    claimList: '逐条事实与出处',
    calculations: '计算过程',
    references: '资料来源',
    openQuestions: '待核问题',
    confidenceValue: { low: '低', medium: '中', high: '高' },
  },
  'zh-TW': {
    title: '研究備忘錄',
    preamble:
      '本備忘錄只整理已公開揭露的事實與其出處。正文每段末尾的方括號編號對應附錄中的逐條事實;數字逐字取自原始文件,計算得到的數字在附錄「計算過程」中給出公式。不構成投資建議。',
    fact: '事實',
    opinion: '他方觀點',
    inference: '模型推斷',
    scenario: '情景',
    unverifiable: '無法核實',
    source: '出處原句',
    attribution: '來源',
    confidence: '信心水準',
    period: '期間',
    assumptions: '關鍵假設',
    counterEvidence: '反方證據',
    triggers: '觸發條件',
    appendix: '數據附錄',
    claimList: '逐條事實與出處',
    calculations: '計算過程',
    references: '資料來源',
    openQuestions: '待核問題',
    confidenceValue: { low: '低', medium: '中', high: '高' },
  },
  en: {
    title: 'Research memo',
    preamble:
      'This memo organizes disclosed facts and their sources. The bracketed ids ending each paragraph point at the itemized facts in the appendix; every figure is quoted verbatim from a filing, and computed figures are shown with their formula under Calculations. Not investment advice.',
    fact: 'fact',
    opinion: 'attributed opinion',
    inference: 'model inference',
    scenario: 'scenario',
    unverifiable: 'not verifiable',
    source: 'Evidence',
    attribution: 'said by',
    confidence: 'confidence',
    period: 'period',
    assumptions: 'Key assumptions',
    counterEvidence: 'Counter-evidence',
    triggers: 'Triggers',
    appendix: 'Appendix',
    claimList: 'Itemized facts and sources',
    calculations: 'Calculations',
    references: 'Sources',
    openQuestions: 'Open questions',
    confidenceValue: { low: 'low', medium: 'medium', high: 'high' },
  },
}

/**
 * Render a memo as Markdown.
 *
 * @param memo - the verified memo.
 * @param options - optional refusal line for advice-seeking questions.
 * @returns the Markdown document.
 */
export function renderMemoMarkdown(memo: Memo, options: RenderOptions = {}): string {
  const labels = LABELS[memo.lang]
  const evidenceById = new Map(memo.evidence.map((item) => [item.id, item]))
  const claimById = new Map(memo.claims.map((item) => [item.id, item]))
  // Every citation names its source, always. Three variants of "when is a label
  // worth its space" have now been wrong in a row — keyed on sources cited, then
  // on documents retrieved, and a needle-in-a-haystack task defeats both by
  // planning five files down to the one that matters. A citation that cannot be
  // resolved to a document is not a citation, and the sigil costs five
  // characters. The legend carries the title and the path; the citation carries
  // the pointer.
  const documentLabel = new Map(memo.sources.map((item) => [item.documentId, item.sigil]))

  const lines: string[] = []
  lines.push(`# ${labels.title}:${memo.entity.name}`, '')
  if (options.refusal) lines.push(options.refusal, '')
  lines.push(labels.preamble, '')

  for (const block of memo.narrative) {
    lines.push(`## ${block.heading}`, '')
    if (block.kind === 'findings') {
      for (const paragraph of block.paragraphs) {
        const heading = memo.sections.find((section) => section.questionId === paragraph.questionId)?.heading
        if (heading) lines.push(`### ${heading}`, '')
        lines.push(paragraph.text, '')
      }
    } else {
      for (const paragraph of block.paragraphs) lines.push(paragraph.text, '')
    }
  }

  if (memo.openQuestions.length > 0) {
    lines.push(`## ${labels.openQuestions}`, '')
    for (const question of memo.openQuestions) lines.push(`- ${question}`)
    lines.push('')
  }

  lines.push(`## ${labels.appendix}`, '')

  if (memo.derived.length > 0) {
    lines.push(`### ${labels.calculations}`, '')
    // Dependencies first, each link labelled, so the whole chain can be redone
    // by hand from the quoted figures up.
    for (const derivation of orderByDependency(memo.derived)) {
      lines.push(`- [${derivation.id}] ${derivation.label}:${derivation.formula} = ${derivation.display}`)
    }
    lines.push('')
  }

  lines.push(`### ${labels.claimList}`, '')
  for (const section of memo.sections) {
    const claims = section.claimIds.map((id) => claimById.get(id)).filter((claim): claim is Claim => Boolean(claim))
    if (claims.length === 0) continue
    lines.push(`**${section.heading}**`, '')
    for (const claim of claims) {
      lines.push(...renderClaim(claim, labels, evidenceById, documentLabel))
    }
    lines.push('')
  }

  if (memo.sources.length > 0) {
    lines.push(`### ${labels.references}`, '')
    for (const source of memo.sources) {
      // The legend defines each sigil once: the path a reviewer opens, then the
      // title. The raw document id stays in `memo.json` — ids are harness- and
      // vendor-shaped (`MB-006/context/…`, `703`) and printing them would put
      // digits into a document whose every digit should be a filing's figure.
      const locator = source.locator ? `${source.locator} — ` : ''
      const url = source.url ? ` — ${source.url}` : ''
      lines.push(`- [${source.sigil}] ${locator}${source.title}(${source.provider})${url}`)
    }
    lines.push('')
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

/** Derivations with every dependency ahead of the link that consumes it. */
function orderByDependency(derived: Memo['derived']): Memo['derived'] {
  const byId = new Map(derived.map((item) => [item.id, item]))
  const emitted = new Set<string>()
  const ordered: Memo['derived'] = []
  const visit = (item: Memo['derived'][number]): void => {
    if (emitted.has(item.id)) return
    emitted.add(item.id)
    for (const id of item.dependsOn) {
      const upstream = byId.get(id)
      if (upstream) visit(upstream)
    }
    ordered.push(item)
  }
  for (const item of derived) visit(item)
  return ordered
}

/** Render one appendix entry: the claim, its citation, and its qualifiers. */
function renderClaim(
  claim: Claim,
  labels: Labels,
  evidenceById: Map<string, { id: string; quote: string; documentId: string }>,
  documentLabel: Map<string, string> | undefined,
): string[] {
  const cite = (ids: string[]): string => {
    const parts = ids
      .map((id) => evidenceById.get(id))
      .filter((item): item is { id: string; quote: string; documentId: string } => Boolean(item))
      .map((item) => {
        const origin = documentLabel?.get(item.documentId)
        return origin ? `「${item.quote}」(${origin})` : `「${item.quote}」`
      })
    return parts.join(';')
  }

  const citation = claim.evidenceIds.length > 0 ? ` ${labels.source}:${cite(claim.evidenceIds)}` : ''
  const head = `- [${claim.id}] ${claim.text}`

  switch (claim.type) {
    case 'fact': {
      const tag = claim.unverifiable ? labels.unverifiable : labels.fact
      return [`${head}【${tag}】${citation}`]
    }
    case 'attributed_opinion':
      return [`${head}【${labels.opinion} · ${labels.attribution}:${claim.attribution}】${citation}`]
    case 'scenario':
      return [`${head}【${labels.scenario}】${citation}`, `  - ${labels.triggers}:${claim.triggers.join(';')}`]
    case 'model_inference': {
      const rows = [
        `${head}【${labels.inference} · ${labels.confidence}:${
          labels.confidenceValue[claim.confidence]
        } · ${labels.period}:${claim.timeRange}】${citation}`,
        `  - ${labels.assumptions}:${claim.assumptions.join(';')}`,
      ]
      if (claim.counterEvidence.evidenceIds.length > 0) {
        rows.push(`  - ${labels.counterEvidence}:${cite(claim.counterEvidence.evidenceIds)}`)
      }
      return rows
    }
  }
}

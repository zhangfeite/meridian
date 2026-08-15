/**
 * What an absence statement is allowed to cover.
 *
 * The memo has two ways of saying it does not know something, and they are not
 * interchangeable:
 *
 * - 「the primary sources do not disclose X」 is a claim *about the filing*, and
 *   this pipeline does not publish claims about documents it cannot quote.
 * - 「this memo could not locate X」 is a claim about the run, which is what is
 *   left when there is no passage to stand on.
 *
 * MB-005 en published the first form about the document, the court and the date
 * — all three printed in the announcement's opening sentence. Alongside that,
 * an absence statement may never cover a sub-question the same memo answers:
 * a document that says both is unreadable, because the reader has no way to
 * tell which half to trust.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compose } from '../src/steps/compose.ts'
import { EvidencePool } from '../src/evidence-pool.ts'
import type { Claim, EvidenceRef, FactClaim, MeridianLang } from '../src/contract.ts'
import type { SourceDocument } from '../src/source/types.ts'
import type { Intent } from '../src/types.ts'

const FILING = [
  '公司于 2026 年 8 月 13 日收到浙江省宁波市中级人民法院送达的《通知书》。',
  '《通知书》仅表明法院已立案审查，截至本公告披露日，公司尚未收到法院决定对公司进行预重整的文件。',
  '公司债权人上海某贸易有限公司以公司不能清偿到期债务为由，向法院申请对公司进行重整。',
  '本次发行价格尚未确定，最终发行价格由公司与主承销商在监管同意后协商确定。',
].join('\n')

const documents: SourceDocument[] = [
  { id: 'D1', title: '重整申请公告', text: FILING, provider: 'test' },
]

const intent = (questions: { id: string; text: string }[], lang: MeridianLang): Intent => ({
  entity: { name: '测试公司' },
  questionType: 'fact_extraction',
  seeksAdvice: false,
  lang,
  subQuestions: questions,
})

/** Compose a memo from hand-built claims, with no model (deterministic draft). */
async function composeMemo(
  questions: { id: string; text: string }[],
  claims: Claim[],
  evidence: EvidenceRef[],
  lang: MeridianLang = 'zh-CN',
  rejected: { questionId?: string }[] = [],
  residuals: { questionId: string; missing: string }[] = [],
) {
  return compose({
    rejected,
    residuals,
    intent: intent(questions, lang),
    retrieval: { documents, failures: [], mode: 'direct' },
    documents,
    claims,
    evidence,
    derived: [],
    gaps: [],
    audit: [],
    lang,
    pool: new EvidencePool(),
    question: '公司收到了什么法律文书?',
    provenance: { pipeline: 'test', model: 'test', dataSource: 'test', retrieval: 'direct' },
  })
}

const evidence = (id: string, quote: string): EvidenceRef => ({
  id,
  documentId: 'D1',
  quote,
  charStart: FILING.indexOf(quote),
  charEnd: FILING.indexOf(quote) + quote.length,
  sourceLabel: '重整申请公告',
  retrievedAt: '2026-08-15T00:00:00.000Z',
})

const fact = (id: string, questionId: string, text: string, evidenceIds: string[]): FactClaim => ({
  id,
  type: 'fact',
  questionId,
  text,
  evidenceIds,
  numbers: [],
})

/** A gap claim as the compose step itself builds them. */
const gapClaim = (id: string, questionId: string, text: string): FactClaim => ({
  ...fact(id, questionId, text, []),
  unverifiable: true,
})

test('an unevidenced gap says what the run knows, not what the filing says', async () => {
  // Nothing in this filing explains why the applicant's own address is missing,
  // so there is no passage to cite — and with nothing to cite, asserting that
  // the filing does not disclose it is an unverified claim about a document.
  const { memo, markdown } = await composeMemo(
    [{ id: 'Q1', text: '申请人的注册地址是什么?' }],
    [],
    [],
  )

  const gap = memo.claims.find((claim) => claim.type === 'fact' && claim.unverifiable)
  assert.ok(gap, 'the question still gets an answer, just a narrower one')
  assert.equal(gap.evidenceIds.length, 0)
  assert.match(gap.text, /本备忘录未能在所提供的原始文件中找到相应内容/)
  assert.equal(gap.text.includes('没有相应披露'), false, 'no assertion about the filing')
  assert.match(markdown, /无法核实/, 'it is still an explicit non-answer')
  assert.ok(
    memo.audit.some((record) => record.action === 'gap_unevidenced'),
    'and the reader is told why the weaker wording was used',
  )
})

test('an evidenced gap keeps the stronger wording', async () => {
  // Here the filing does explain the absence, and the sentence that explains it
  // is published beside the answer — so the memo may say what the filing says.
  const { memo } = await composeMemo(
    [{ id: 'Q1', text: '法院是否已裁定受理重整申请?' }],
    [],
    [],
  )

  const gap = memo.claims.find((claim) => claim.type === 'fact' && claim.unverifiable)
  assert.ok(gap)
  assert.equal(gap.evidenceIds.length, 1, 'the passage explaining the absence is cited')
  assert.match(gap.text, /没有相应披露/)
  assert.equal(
    memo.audit.some((record) => record.action === 'gap_unevidenced'),
    false,
  )
})

test('an absence statement may not cover a sub-question the memo answers', async () => {
  // The MB-005 shape, reduced to its structure: one sub-question carrying both
  // a verified claim and a "not disclosed" sentence. Whatever produced the
  // second, it may not be published next to the first.
  const quote = '公司于 2026 年 8 月 13 日收到浙江省宁波市中级人民法院送达的《通知书》。'
  const answered = fact('C-A', 'Q1', '公司收到的是法院送达的《通知书》。', ['E1'])
  const contradiction = gapClaim(
    'U-Z',
    'Q1',
    '关于「公司收到了哪一份法律文书」:所提供的原始文件中没有相应披露,无法核实。',
  )

  const { memo, markdown } = await composeMemo(
    [{ id: 'Q1', text: '公司收到了哪一份法律文书?' }],
    [answered, contradiction],
    [evidence('E1', quote)],
  )

  assert.equal(
    memo.claims.some((claim) => claim.id === 'U-Z'),
    false,
    'the contradictory absence statement is withdrawn',
  )
  assert.equal(markdown.includes('没有相应披露'), false)
  assert.ok(markdown.includes('《通知书》'), 'the verified answer stays')
  const withdrawal = memo.audit.find((record) => record.action === 'gap_withdrawn_answered')
  assert.ok(withdrawal, 'a silent withdrawal would hide a real defect from whoever caused it')
  assert.match(withdrawal.detail, /Q1/)
  // And the question is no longer advertised as open, since it was answered.
  assert.equal(memo.openQuestions.length, 0)
  assert.equal(
    memo.sections.find((section) => section.questionId === 'Q1')?.claimIds.includes('U-Z'),
    false,
  )
})

test('a genuinely unanswered sub-question still gets its absence statement', async () => {
  // The check must not eat honest gaps: two sub-questions, one answered and one
  // not, and the unanswered one keeps its sentence.
  const quote = '公司债权人上海某贸易有限公司以公司不能清偿到期债务为由，向法院申请对公司进行重整。'
  const { memo } = await composeMemo(
    [
      { id: 'Q1', text: '谁提出了重整申请?' },
      { id: 'Q2', text: '重整管理人是哪家机构?' },
    ],
    [fact('C-A', 'Q1', '重整申请由公司债权人上海某贸易有限公司提出。', ['E1'])],
    [evidence('E1', quote)],
  )

  const gaps = memo.claims.filter((claim) => claim.type === 'fact' && claim.unverifiable)
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0]?.questionId, 'Q2')
  assert.equal(memo.openQuestions.length, 1)
  assert.equal(
    memo.audit.some((record) => record.action === 'gap_withdrawn_answered'),
    false,
  )
})

test('the withdrawal survives every locale', async () => {
  for (const lang of ['zh-CN', 'zh-TW', 'en'] as MeridianLang[]) {
    const contradiction = gapClaim(
      'U-Z',
      'Q1',
      'On "what document": the primary sources provided do not disclose this.',
    )
    const { memo } = await composeMemo(
      [{ id: 'Q1', text: '公司收到了哪一份法律文书?' }],
      [fact('C-A', 'Q1', '公司收到的是法院送达的《通知书》。', ['E1']), contradiction],
      [evidence('E1', '公司于 2026 年 8 月 13 日收到浙江省宁波市中级人民法院送达的《通知书》。')],
      lang,
    )
    assert.equal(
      memo.claims.some((claim) => claim.id === 'U-Z'),
      false,
      `${lang}: the contradiction must be withdrawn in every locale`,
    )
  }
})

test('a question whose claims were refused is not reported as a silent filing', async () => {
  // MB-005 en, exactly: the model stated 「1,500,000」 four times, the verifier
  // refused it four times because the cited quote did not carry the figure, and
  // the memo then told the reader the filing does not disclose the amount. It
  // does — on the same line the applicant is named. What the run knew was that
  // it could not verify an answer, and that is what it now says.
  const { memo } = await composeMemo(
    [{ id: 'Q1', text: '法院是否已裁定受理重整申请?' }],
    [],
    [],
    'zh-CN',
    [{ questionId: 'Q1' }],
  )

  const gap = memo.claims.find((claim) => claim.type === 'fact' && claim.unverifiable)
  assert.ok(gap)
  // The absence support passage exists for this question, so without the
  // refusal this would have used the stronger wording — the refusal is what
  // downgrades it.
  assert.equal(gap.evidenceIds.length, 1)
  assert.match(gap.text, /未能在所提供的原始文件中找到相应内容/)
  assert.equal(gap.text.includes('没有相应披露'), false)
  const record = memo.audit.find((item) => item.action === 'gap_unevidenced')
  assert.ok(record)
  assert.match(record.detail, /refused/)
})

test('a rule without its figure keeps the residual sentence beside the answer', async () => {
  // 「规则已定,数值未定」, the shape MB-009 is built around. Publishing the
  // pricing rule and stopping there answers a question nobody asked: the reader
  // wants to know the price, and the finding is that it does not exist yet.
  const quote = '公司债权人上海某贸易有限公司以公司不能清偿到期债务为由，向法院申请对公司进行重整。'
  const { memo, markdown } = await composeMemo(
    [{ id: 'Q1', text: '本次发行价格是每股多少元?' }],
    [fact('C-A', 'Q1', '发行价格不低于定价基准日前二十个交易日均价的百分之八十。', ['E1'])],
    [evidence('E1', quote)],
    'zh-CN',
    [],
    [{ questionId: 'Q1', missing: '每股发行价格' }],
  )

  // Both halves are published, in one section, in this order.
  const section = memo.sections.find((item) => item.questionId === 'Q1')
  assert.equal(section?.claimIds.length, 2)
  assert.equal(section?.claimIds[0], 'C-A')
  const residual = memo.claims.find((claim): claim is FactClaim => claim.type === 'fact' && Boolean(claim.residual))
  assert.ok(residual, 'the residual sentence must exist')
  assert.equal(residual.questionId, 'Q1')
  assert.equal(residual.unverifiable, true)
  assert.match(residual.text, /具体数值尚未确定/)
  assert.ok(markdown.includes('百分之八十'), 'the rule survives')
  assert.ok(markdown.includes('尚未确定'), 'and so does the residual')

  // It is a finding, so it is cited like one, and it is advertised as open.
  assert.equal(residual.evidenceIds.length, 1)
  assert.equal(memo.openQuestions.length, 1)
  assert.ok(memo.audit.some((record) => record.action === 'residual_gap_recorded'))
})

test('the disjointness rule does not eat a residual', async () => {
  // M8 withdraws a blanket "not disclosed" that shares a sub-question with a
  // verified claim. A residual shares one *by design* — the two rules have to
  // coexist, or this package would delete its own output.
  const quote = '公司债权人上海某贸易有限公司以公司不能清偿到期债务为由，向法院申请对公司进行重整。'
  const blanket = gapClaim('U-Z', 'Q1', '关于「本次发行价格是每股多少元」:所提供的原始文件中没有相应披露,无法核实。')
  const { memo } = await composeMemo(
    [{ id: 'Q1', text: '本次发行价格是每股多少元?' }],
    [fact('C-A', 'Q1', '发行价格不低于定价基准日前二十个交易日均价的百分之八十。', ['E1']), blanket],
    [evidence('E1', quote)],
    'zh-CN',
    [],
    [{ questionId: 'Q1', missing: '每股发行价格' }],
  )

  assert.equal(memo.claims.some((claim) => claim.id === 'U-Z'), false, 'the blanket claim still goes')
  assert.equal(
    memo.claims.some((claim) => claim.type === 'fact' && claim.residual),
    true,
    'the residual stays',
  )
  assert.ok(memo.audit.some((record) => record.action === 'gap_withdrawn_answered'))
  assert.ok(memo.audit.some((record) => record.action === 'residual_gap_recorded'))
})

test('a settled sub-question gets no residual sentence', async () => {
  const quote = '公司债权人上海某贸易有限公司以公司不能清偿到期债务为由，向法院申请对公司进行重整。'
  const { memo } = await composeMemo(
    [{ id: 'Q1', text: '谁提出了重整申请?' }],
    [fact('C-A', 'Q1', '重整申请由公司债权人上海某贸易有限公司提出。', ['E1'])],
    [evidence('E1', quote)],
  )
  assert.equal(memo.claims.some((claim) => claim.type === 'fact' && claim.residual), false)
  assert.equal(memo.openQuestions.length, 0)
})

test('the residual wording passes the gate in all three locales', async () => {
  const quote = '公司债权人上海某贸易有限公司以公司不能清偿到期债务为由，向法院申请对公司进行重整。'
  for (const lang of ['zh-CN', 'zh-TW', 'en'] as MeridianLang[]) {
    const { memo } = await composeMemo(
      [{ id: 'Q1', text: '本次发行价格是每股多少元?' }],
      [fact('C-A', 'Q1', '发行价格不低于定价基准日前二十个交易日均价的百分之八十。', ['E1'])],
      [evidence('E1', quote)],
      lang,
      [],
      [{ questionId: 'Q1', missing: '每股发行价格' }],
    )
    const residual = memo.claims.find((claim): claim is FactClaim => claim.type === 'fact' && Boolean(claim.residual))
    assert.ok(residual, `${lang}: residual missing`)
    // The gate requires an unverifiable claim to say so in its own locale.
    assert.deepEqual(
      memo.gate.contractViolations.filter((item) => item.claimId === residual.id),
      [],
      `${lang}: ${residual.text}`,
    )
    assert.deepEqual(
      memo.gate.numberViolations.filter((item) => item.display === residual.id),
      [],
      `${lang}: ${residual.text}`,
    )
  }
})

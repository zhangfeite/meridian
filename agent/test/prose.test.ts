/**
 * Step 7's writing pass.
 *
 * The contract under test: the polishing model never sees a digit, so any digit
 * it returns is a fabrication; and any paragraph that fails a check is replaced
 * by the deterministic draft — which is itself verified — rather than published.
 * Every test below is a way the model could try to change what the memo asserts
 * while looking obedient.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Claim, DerivedNumber, EvidenceRef } from '../src/contract.ts'
import { ScriptedModel } from '../src/model.ts'
import { buildProse, maskDigits, type ProseInput } from '../src/prose.ts'

const evidence: EvidenceRef[] = [
  {
    id: 'E1',
    documentId: 'D1',
    quote: '需计提存货跌价准备 879.50 万元',
    charStart: 0,
    charEnd: 16,
    sourceLabel: '减值公告',
    retrievedAt: '2026-08-15T00:00:00.000Z',
  },
  {
    id: 'E2',
    documentId: 'D1',
    quote: '公司计提各项减值准备共计 1,000.00 万元',
    charStart: 20,
    charEnd: 42,
    sourceLabel: '减值公告',
    retrievedAt: '2026-08-15T00:00:00.000Z',
  },
]

const derived: DerivedNumber[] = [
  {
    id: 'D1',
    label: '存货跌价准备占比',
    op: 'ratio',
    inputs: [
      { value: '8795000', unit: 'CNY', evidenceId: 'E1', display: '879.50 万元' },
      { value: '10000000', unit: 'CNY', evidenceId: 'E2', display: '1,000.00 万元' },
    ],
    value: '0.8795',
    display: '87.95%',
    unit: 'ratio',
    formula: '879.50 万元 / 1,000.00 万元',
    tolerance: '0',
    uncertainty: '0',
    dependsOn: [],
    depth: 1,
  },
]

const claims: Claim[] = [
  {
    id: 'C-A',
    type: 'fact',
    text: '公司计提存货跌价准备 879.50 万元。',
    questionId: 'Q1',
    evidenceIds: ['E1'],
    numbers: [{ display: '879.50 万元', provenance: 'verbatim', evidenceId: 'E1' }],
  },
  {
    id: 'C-B',
    type: 'fact',
    text: '各项减值准备合计 1,000.00 万元。',
    questionId: 'Q1',
    evidenceIds: ['E2'],
    numbers: [{ display: '1,000.00 万元', provenance: 'verbatim', evidenceId: 'E2' }],
  },
  {
    id: 'C-C',
    type: 'fact',
    text: '存货跌价准备占减值合计的 87.95%。',
    questionId: 'Q2',
    evidenceIds: ['E1', 'E2'],
    numbers: [{ display: '87.95%', provenance: 'derived', derivedId: 'D1' }],
  },
]

const input: ProseInput = {
  claims,
  evidence,
  derived,
  subQuestions: [
    { id: 'Q1', text: '各类减值准备计提了多少?' },
    { id: 'Q2', text: '哪一项占比最大?' },
  ],
  headings: new Map([
    ['Q1', '各类减值准备计提了多少?'],
    ['Q2', '哪一项占比最大?'],
  ]),
  lang: 'zh-CN',
  entityName: '测试科技',
}

/** Build a step-7 reply from paragraph id → text. */
const reply = (paragraphs: Record<string, string>): string =>
  JSON.stringify({ paragraphs: Object.entries(paragraphs).map(([id, text]) => ({ id, text })) })

/**
 * Paragraph ids and placeholders are both deterministic. Drafts are minted in
 * order — conclusion, then one per sub-question, then risks — and placeholders
 * one per source number in draft order. For this fixture:
 *
 *   P-A conclusion (C-A, C-C)   P-B findings Q1 (C-A, C-B)   P-C findings Q2 (C-C)
 *   ⟦A⟧ = 879.50 万元 (C-A)   ⟦B⟧ = 87.95% (C-C)   ⟦C⟧ = 1,000.00 万元 (C-B)
 */
const CONCLUSION = 'P-A'
const Q1 = 'P-B'
const Q2 = 'P-C'
const A = '⟦A⟧'
const B = '⟦B⟧'
const C = '⟦C⟧'

/** The reply that passes every rule, used as the base for negative tests. */
const goodReply = {
  [CONCLUSION]: `公司本期计提存货跌价准备${A}[C-A]，占减值合计的${B}[C-C]。`,
  [Q1]: `存货跌价准备计提${A}[C-A]，各项减值准备合计${C}[C-B]。`,
  [Q2]: `存货跌价准备占减值合计的${B}[C-C]。`,
}

test('with no model, the deterministic draft is published with real numbers', async () => {
  const result = await buildProse(input)
  const all = result.blocks.flatMap((block) => block.paragraphs)
  assert.ok(all.length >= 3, 'conclusion plus one paragraph per sub-question')
  assert.equal(result.stats.polished, 0)
  assert.equal(result.stats.dropped, 0)
  const joined = all.map((paragraph) => paragraph.text).join('\n')
  assert.ok(joined.includes('879.50 万元'))
  assert.ok(joined.includes('87.95%'))
  assert.ok(!/⟦/.test(joined), 'no placeholder survives into published text')
  for (const paragraph of all) assert.ok(paragraph.claimIds.length > 0, 'every paragraph stays anchored')
})

test('a well-behaved polish is published, with the pipeline substituting its own figures', async () => {
  const result = await buildProse(input, new ScriptedModel([reply(goodReply)]))
  const paragraphs = result.blocks.flatMap((block) => block.paragraphs)
  const conclusion = paragraphs.find((paragraph) => paragraph.text.includes('公司本期计提'))
  assert.ok(conclusion?.polished, JSON.stringify(result.audit))
  assert.equal(conclusion.text, '公司本期计提存货跌价准备879.50 万元[C-A]，占减值合计的87.95%[C-C]。')
  assert.deepEqual(conclusion.claimIds, ['C-A', 'C-C'])
  assert.equal(result.stats.rejected, 0)
  assert.equal(result.stats.polished, 3)
})

test('a polish that writes a digit is rejected — that is how fabrication is detected', async () => {
  const result = await buildProse(
    input,
    new ScriptedModel([
      reply({ ...goodReply, [CONCLUSION]: '公司本期共计提减值准备约 1,050 万元，同比增长 5%[C-A][C-C]。' }),
    ]),
  )
  const conclusion = result.blocks
    .flatMap((block) => block.paragraphs)
    .find((paragraph) => paragraph.claimIds.includes('C-A') && paragraph.claimIds.includes('C-C'))
  assert.ok(conclusion)
  assert.ok(!conclusion.text.includes('1,050'), 'the invented figure never reaches the memo')
  assert.ok(!conclusion.polished)
  assert.ok(
    result.audit.some((record) => record.detail.includes('introduced digits')),
    JSON.stringify(result.audit),
  )
})

// --- P1-3: numbers spelled out in words ------------------------------------

test('a polish that spells a number out in words is rejected', async () => {
  const chinese = await buildProse(
    input,
    new ScriptedModel([reply({ ...goodReply, [Q2]: `占比为${B}，约合一千零五十万元[C-C]。` })]),
  )
  assert.ok(
    chinese.audit.some((record) => record.detail.includes('spelled out a number')),
    JSON.stringify(chinese.audit),
  )
  assert.ok(!chinese.blocks.flatMap((b) => b.paragraphs).some((p) => p.text.includes('一千零五十')))

  const english = await buildProse(
    { ...input, lang: 'en' },
    new ScriptedModel([reply({ ...goodReply, [Q2]: `The share was ${B}, about fifty million[C-C].` })]),
  )
  assert.ok(
    english.audit.some((record) => record.detail.includes('spelled out a number')),
    JSON.stringify(english.audit),
  )
})

test('a single numeral character carrying a quantity is caught too', async () => {
  // R2-P1: `[数词]{2,}` misses 「五元」/「百分之五」/「三成」 — one character is
  // enough to state a figure, and extractNumbers only sees Arabic digits.
  for (const injected of ['金额为五元', '占比为百分之五', '约占三成', '约合五万元']) {
    const result = await buildProse(
      input,
      new ScriptedModel([reply({ ...goodReply, [Q2]: `占减值合计的${B}，${injected}[C-C]。` })]),
    )
    assert.ok(
      result.audit.some((record) => record.detail.includes('spelled out a number')),
      `${injected} should be rejected: ${JSON.stringify(result.audit)}`,
    )
    assert.ok(!result.blocks.flatMap((b) => b.paragraphs).some((p) => p.text.includes(injected)))
  }
})

test('ordinary words containing numeral characters do not trip the check', async () => {
  // 「一致行动关系」 and 「十分」 are prose, not figures — and they are already
  // in the draft, which is what the comparison is against.
  const withPhrase: ProseInput = {
    ...input,
    claims: [
      { ...claims[0], text: '申请人与公司不存在关联关系、一致行动关系,计提 879.50 万元。' },
      claims[1],
      claims[2],
    ],
  }
  const result = await buildProse(
    withPhrase,
    new ScriptedModel([
      reply({
        [CONCLUSION]: `申请人与公司不存在一致行动关系，计提${A}[C-A]，占比${B}[C-C]。`,
        [Q1]: `申请人与公司不存在一致行动关系，计提${A}[C-A]，合计${C}[C-B]。`,
        [Q2]: `占减值合计的${B}[C-C]。`,
      }),
    ]),
  )
  assert.ok(
    !result.audit.some((record) => record.detail.includes('spelled out a number')),
    JSON.stringify(result.audit),
  )
})

// --- P1-2: dropped placeholders ---------------------------------------------

test('a polish that deletes a verified figure is rejected', async () => {
  const result = await buildProse(
    input,
    new ScriptedModel([reply({ ...goodReply, [Q2]: '存货跌价准备占比最大[C-C]。' })]),
  )
  assert.ok(
    result.audit.some((record) => record.detail.includes('dropped verified figures')),
    JSON.stringify(result.audit),
  )
  // The draft stands, so the figure is still in the memo.
  const q2 = result.blocks.flatMap((b) => b.paragraphs).find((p) => p.claimIds.includes('C-C') && !p.polished)
  assert.ok(q2?.text.includes('87.95%'))
})

// --- P1-1: placeholders swapped between sentences ---------------------------

test('a polish that moves a figure to another claim’s sentence is rejected', async () => {
  // Both figures stay in the paragraph and both anchors are present, so the
  // paragraph-level number binding still passes — only per-sentence ownership
  // catches this.
  const result = await buildProse(
    input,
    new ScriptedModel([reply({ ...goodReply, [Q1]: `存货跌价准备计提${C}[C-A]，各项减值准备合计${A}[C-B]。` })]),
  )
  assert.ok(
    result.audit.some((record) => /moved ⟦[A-Z]+⟧ away from its claim/.test(record.detail)),
    JSON.stringify(result.audit),
  )
  const q1 = result.blocks.flatMap((b) => b.paragraphs).find((p) => p.claimIds.includes('C-B'))
  assert.equal(q1?.polished, false)
  // The draft attributes each figure to its own claim again.
  assert.match(q1?.text ?? '', /存货跌价准备 879\.50 万元。\[C-A\]/)
})

// --- P1-4: unanchored additions ---------------------------------------------

test('a polish that appends an unanchored sentence is rejected', async () => {
  const result = await buildProse(
    input,
    new ScriptedModel([reply({ ...goodReply, [Q2]: `占减值合计的${B}[C-C]。公司经营稳健。` })]),
  )
  assert.ok(
    result.audit.some((record) => record.detail.includes('after the last anchor')),
    JSON.stringify(result.audit),
  )
  assert.ok(!result.blocks.flatMap((b) => b.paragraphs).some((p) => p.text.includes('经营稳健')))
})

test('a polish that pads an anchored sentence with new content is rejected', async () => {
  const result = await buildProse(
    input,
    new ScriptedModel([
      reply({
        ...goodReply,
        [Q2]: `占减值合计的${B}，公司整体经营态势平稳向好、管理层执行力较强、行业景气度显著回升、订单储备充足[C-C]。`,
      }),
    ]),
  )
  assert.ok(
    result.audit.some((record) => record.detail.includes('new content units')),
    JSON.stringify(result.audit),
  )
  assert.ok(!result.blocks.flatMap((b) => b.paragraphs).some((p) => p.text.includes('景气度')))
})

// --- P2-6: dropped anchors, in every block ----------------------------------

test('a polish that drops a claim is rejected in the conclusion too, not only in findings', async () => {
  // Claims without figures, so the dropped-anchor rule is what fires rather
  // than the dropped-placeholder rule that would otherwise catch it first.
  const wordy: ProseInput = {
    ...input,
    derived: [],
    claims: [
      { id: 'C-A', type: 'fact', text: '公司已完成自查。', questionId: 'Q1', evidenceIds: ['E1'], numbers: [] },
      { id: 'C-B', type: 'fact', text: '公司已书面问询控股股东。', questionId: 'Q1', evidenceIds: ['E1'], numbers: [] },
      { id: 'C-C', type: 'fact', text: '控股股东未买卖股票。', questionId: 'Q2', evidenceIds: ['E2'], numbers: [] },
    ],
  }
  const conclusion = await buildProse(
    wordy,
    new ScriptedModel([reply({ [CONCLUSION]: '公司已完成自查[C-A]。' })]),
  )
  assert.ok(
    conclusion.audit.some((record) => record.detail.includes('silently dropped claims: C-C')),
    JSON.stringify(conclusion.audit),
  )

  const findings = await buildProse(
    wordy,
    new ScriptedModel([reply({ [Q1]: '公司已完成自查[C-A]。' })]),
  )
  assert.ok(
    findings.audit.some((record) => record.detail.includes('silently dropped claims: C-B')),
    JSON.stringify(findings.audit),
  )
})

test('a polish that invents an anchor or a placeholder is rejected', async () => {
  const invented = await buildProse(
    input,
    new ScriptedModel([reply({ ...goodReply, [Q2]: `占比为${B}[C-Z]。` })]),
  )
  assert.ok(
    invented.audit.some((record) => record.detail.includes('anchored to a claim it was not given: C-Z')),
    JSON.stringify(invented.audit),
  )

  const ghost = await buildProse(
    input,
    new ScriptedModel([reply({ ...goodReply, [Q2]: '占比为⟦ZZ⟧[C-C]。' })]),
  )
  assert.ok(
    ghost.audit.some((record) => record.detail.includes('invented placeholder')),
    JSON.stringify(ghost.audit),
  )
})

test('a polish that smuggles in advice is rejected by the compliance check', async () => {
  const result = await buildProse(
    input,
    new ScriptedModel([reply({ ...goodReply, [Q2]: `存货跌价准备占比${B}，建议投资者逢低买入[C-C]。` })]),
  )
  const q2 = result.blocks.flatMap((block) => block.paragraphs).find((p) => p.claimIds.includes('C-C'))
  assert.ok(!q2?.text.includes('买入'))
})

// --- the fallback is verified too -------------------------------------------

test('a draft that cannot be verified is dropped, not published as a fallback', async () => {
  // C-D's text carries a figure its own evidence does not contain: the claim
  // was edited out from under the draft. Publishing it would put an unsourced
  // number in the memo, so the paragraph is dropped instead.
  const broken: ProseInput = {
    ...input,
    subQuestions: [{ id: 'Q3', text: '本期计提了多少?' }],
    headings: new Map([['Q3', '本期计提了多少?']]),
    claims: [
      {
        id: 'C-D',
        type: 'fact',
        text: '公司计提减值准备 12,345.67 万元。',
        questionId: 'Q3',
        evidenceIds: ['E1'],
        numbers: [],
      },
    ],
  }
  const result = await buildProse(broken)
  assert.equal(result.blocks.length, 0, 'nothing publishes')
  assert.ok(result.stats.dropped > 0)
  assert.ok(
    result.audit.some((record) => record.detail.includes('draft prose failed verification')),
    JSON.stringify(result.audit),
  )
})

// --- P2-8: metadata never carries digits into the payload -------------------

test('headings and entity names are masked before the model sees them', () => {
  assert.equal(maskDigits('2023年虚增了多少?'), '…年虚增了多少?')
  assert.equal(maskDigits('361度'), '…度')
  assert.equal(maskDigits('哪一项占比最大?'), '哪一项占比最大?')
  // R2-P2a: full-width digits are digits. Masking that only knew ASCII let
  // 「３６１度」 through to a model promised it would never see a number.
  assert.equal(maskDigits('３６１度'), '…度')
  assert.equal(maskDigits('募集资金 １，５００ 万元'), '募集资金 …')
})

test('the polish payload contains no digits at all', async () => {
  const model = new ScriptedModel([reply(goodReply)])
  await buildProse(
    {
      ...input,
      entityName: '361度国际控股',
      subQuestions: [{ id: 'Q1', text: '2023年虚增营业收入多少?' }, { id: 'Q2', text: '哪一项占比最大?' }],
      headings: new Map([['Q1', '2023年虚增营业收入多少?'], ['Q2', '哪一项占比最大?']]),
    },
    model,
  )
  // The *data* half of the request is what must be digit-free: paragraph ids are
  // letters, headings and the entity name are masked, and the draft text carries
  // placeholders. (The system prompt numbers its own rules; those digits are
  // instructions, not material the model could mistake for a filing's figure.)
  const payload = model.calls[0]?.user ?? ''
  const digits = payload.match(/\d/g) ?? []
  assert.deepEqual(digits, [], `payload leaked digits: ${payload.slice(0, 300)}`)
})

test('inferences and their counter-evidence get their own block', async () => {
  const withInference: ProseInput = {
    ...input,
    claims: [
      ...claims,
      {
        id: 'C-D',
        type: 'model_inference',
        text: '减值集中在存货端。',
        questionId: 'Q2',
        evidenceIds: ['E1'],
        numbers: [],
        timeRange: '2026H1',
        assumptions: ['公告科目已覆盖全部计提'],
        confidence: 'low',
        counterEvidence: { status: 'filled', evidenceIds: ['E2'], note: '' },
      },
    ],
  }
  const result = await buildProse(withInference)
  const risks = result.blocks.find((block) => block.kind === 'risks')
  assert.ok(risks, '风险与反证 block exists when there is an inference')
  assert.ok(risks.paragraphs[0]?.text.includes('反方证据显示'))
  assert.ok(risks.paragraphs[0]?.claimIds.includes('C-D'))
})

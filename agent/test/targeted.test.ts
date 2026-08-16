/**
 * The second attempt at a figure the memo did not state.
 *
 * WP-M11-CITE's post-mortem: the rounds that scored zero on citations were the
 * rounds where no claim stated the fact at all — not rounds that cited it badly.
 * So a sub-question that comes back with the rule and without the value gets one
 * more attempt, against sentences chosen mechanically rather than by the model.
 *
 * The line this must not cross: a second attempt changes what the model is
 * *shown*, never what it has to prove. Everything it returns goes through the
 * same verification as a first-round claim, and a question whose value is still
 * absent keeps saying so.
 */

import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { ScriptedModel, type CompletionRequest, type CompletionResult, type ModelClient } from '../src/model.ts'
import { extractAndVerify } from '../src/steps/extract.ts'
import { PROMPT_SET_VERSION, targetedExtractionPrompt } from '../src/prompts.ts'
import type { SourceDocument } from '../src/source/types.ts'
import type { Intent } from '../src/types.ts'
import { askedKinds, figureCandidates } from '../src/verify/asked.ts'

const FILING = [
  '一、发行方案概要',
  '本次发行的定价基准日为发行期首日，发行价格不低于定价基准日前二十个交易日交易均价的百分之八十。',
  '本次向特定对象发行募集资金总额不超过人民币 360,000.00 万元（含本数）。',
  '本次发行的股票数量为 120,000,000 股，占发行前总股本的百分之十。',
  '二、其他事项',
  '公司将依据相关规定及时披露进展情况。',
].join('\n')

const documents: SourceDocument[] = [{ id: 'D1', title: '发行预案', text: FILING, provider: 'test' }]

const CROSS_LANGUAGE_DOCUMENTS: SourceDocument[] = [
  {
    id: 'DX',
    title: '设备采购说明',
    text: '本批生产设备的实际采购金额为 2,345,678 元。',
    provider: 'test',
  },
]

const intent = (questions: { id: string; text: string }[], lang: 'zh-CN' | 'en' = 'zh-CN'): Intent => ({
  entity: { name: '测试公司' },
  questionType: 'fact_extraction',
  seeksAdvice: false,
  lang,
  subQuestions: questions,
})

/** Replies for: extraction, residual review, targeted extraction, re-review. */
class Script implements ModelClient {
  readonly id = 'scripted'
  readonly steps: string[] = []
  readonly #byStep: Record<string, string>
  constructor(byStep: Record<string, string>) {
    this.#byStep = byStep
  }
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const system = request.system ?? ''
    const step = system.includes('STEP 4e')
      ? 'targeted'
      : system.includes('STEP 4d')
        ? 'residual'
        : system.includes('GAP REVIEW')
          ? 'gap'
          : system.includes('REPAIR')
            ? 'repair'
            : 'extract'
    this.steps.push(step)
    // The residual review is asked twice: once before the second attempt and
    // once after. The second reply, when given, answers the re-judgement.
    if (step === 'residual' && this.steps.filter((item) => item === 'residual').length === 2) {
      return { text: this.#byStep.residual2 ?? this.#byStep.residual ?? '{}' }
    }
    return { text: this.#byStep[step] ?? '{"claims": [], "gaps": []}' }
  }
}

test('a question asking for a price, a count or a ratio says so', () => {
  assert.deepEqual([...askedKinds('本次发行价格是每股多少元?')], ['price'])
  assert.deepEqual([...askedKinds('What is the issue price per share?')].sort(), ['price'])
  assert.deepEqual([...askedKinds('本次实际发行的股份数量是多少股?')], ['count'])
  assert.deepEqual([...askedKinds('募集资金总额的上限是多少?')], ['amount'])
  assert.deepEqual([...askedKinds('Which legal document contains the ruling?')], ['doc_no'])
  assert.deepEqual([...askedKinds('该事项目前处于哪个阶段?')], [], 'a question about status asks for no quantity')
})

test('candidates are the sentences carrying a figure of the kind asked for', () => {
  const forCount = figureCandidates(documents, '本次实际发行的股份数量是多少股?')
  assert.ok(forCount.length > 0)
  assert.ok(forCount[0]?.text.includes('120,000,000 股'), forCount.map((item) => item.text).join(' | '))

  // Cross-language: an English question and a Chinese filing share no words, and
  // the unit is what carries the match.
  const inEnglish = figureCandidates(documents, 'What is the ceiling on the total proceeds of this issuance?')
  assert.ok(inEnglish.some((item) => item.text.includes('360,000.00 万元')))

  const legalDocuments: SourceDocument[] = [
    { id: 'DL', title: '裁定摘要', text: '相关裁定载于（2026）云03执42号法律文书。', provider: 'test' },
  ]
  assert.ok(
    figureCandidates(legalDocuments, 'What is the case number?').some((item) => item.text.includes('（2026）云03执42号')),
  )

  // Sentences with no figure are never offered, whatever they say.
  assert.equal(
    figureCandidates(documents, '募集资金总额的上限是多少?').some((item) => item.text.includes('及时披露进展')),
    false,
  )
})

test('candidate ranking is stable across calls', () => {
  const once = figureCandidates(documents, '募集资金总额的上限是多少?')
  for (let round = 0; round < 5; round += 1) {
    assert.deepEqual(figureCandidates(documents, '募集资金总额的上限是多少?'), once)
  }
})

test('the targeted prompt permits a ceiling only when the question asks for it', () => {
  const prompt = targetedExtractionPrompt(
    [{ questionId: 'Q1', question: 'What is the upper limit?', candidates: [{ documentId: 'D1', text: FILING }] }],
    'en',
  )
  assert.equal(PROMPT_SET_VERSION, 'meridian-prompts-v0.3')
  assert.match(prompt.system, /unless the question itself asks for the ceiling\/maximum/)
  assert.match(prompt.system, /does not answer "what is the actual amount"/)
})

test('a forced-gap upper-limit question accepts a verified bound and closes', async () => {
  const model = new Script({
    extract: JSON.stringify({ claims: [], gaps: [{ question_id: 'Q1', reason: 'No answer located.' }] }),
    gap: JSON.stringify({
      answers: [{ question_id: 'Q1', verdict: 'absent', reason: 'No answer located.' }],
    }),
    targeted: JSON.stringify({
      claims: [
        {
          question_id: 'Q1',
          type: 'fact',
          text: 'The upper limit of total proceeds does not exceed 人民币 360,000.00 万元.',
          quotes: [{ document_id: 'D1', quote: '募集资金总额不超过人民币 360,000.00 万元' }],
        },
      ],
    }),
  })

  const result = await extractAndVerify(
    intent([{ id: 'Q1', text: 'What is the upper limit of total proceeds?' }], 'en'),
    documents,
    model,
    'en',
  )

  assert.equal(result.claims.length, 1)
  assert.deepEqual(result.gapsClosed, ['Q1'])
  assert.equal(result.gaps.some((gap) => gap.questionId === 'Q1'), false)
})

test('an English zero-claim gap with a matching Chinese figure is forced through Step 4e and closed', async () => {
  const model = new Script({
    extract: JSON.stringify({ claims: [], gaps: [{ question_id: 'Q1', reason: 'No answer located.' }] }),
    gap: JSON.stringify({
      answers: [{ question_id: 'Q1', verdict: 'absent', reason: 'No answer located.' }],
    }),
    targeted: JSON.stringify({
      claims: [
        {
          question_id: 'Q1',
          type: 'fact',
          text: 'The actual equipment purchase amount was 2,345,678 元.',
          quotes: [{ document_id: 'DX', quote: '实际采购金额为 2,345,678 元' }],
        },
      ],
    }),
  })

  const result = await extractAndVerify(
    intent([{ id: 'Q1', text: 'What was the actual equipment purchase amount?' }], 'en'),
    CROSS_LANGUAGE_DOCUMENTS,
    model,
    'en',
  )

  assert.equal(model.steps.filter((step) => step === 'targeted').length, 1)
  assert.ok(result.claims.some((claim) => claim.text.includes('2,345,678 元')))
  assert.deepEqual(result.gapsClosed, ['Q1'])
  assert.equal(result.gaps.some((gap) => gap.questionId === 'Q1'), false)
})

test('a forced-gap bound-only claim is discarded atomically and the gap remains', async () => {
  const boundedDocuments: SourceDocument[] = [
    { id: 'DB', title: '采购预算', text: '设备采购预算不超过 2,345,678 元。', provider: 'test' },
  ]
  const model = new Script({
    extract: JSON.stringify({ claims: [], gaps: [{ question_id: 'Q1', reason: 'No final amount located.' }] }),
    gap: JSON.stringify({
      answers: [{ question_id: 'Q1', verdict: 'absent', reason: 'No final amount located.' }],
    }),
    targeted: JSON.stringify({
      claims: [
        {
          question_id: 'Q1',
          type: 'fact',
          text: 'The equipment purchase budget does not exceed 2,345,678 元.',
          quotes: [{ document_id: 'DB', quote: '设备采购预算不超过 2,345,678 元' }],
        },
      ],
    }),
  })

  const result = await extractAndVerify(
    intent([{ id: 'Q1', text: 'What was the final equipment purchase amount?' }], 'en'),
    boundedDocuments,
    model,
    'en',
  )

  assert.equal(result.claims.some((claim) => claim.text.includes('2,345,678')), false)
  assert.ok(result.gaps.some((gap) => gap.questionId === 'Q1'))
  assert.deepEqual(result.gapsClosed, [])
  assert.ok((result.notes ?? []).some((note) => /定向补抽未找到/.test(note)))
})

test('a true gap with no matching figure kind is not forced through Step 4e', async () => {
  const countOnlyDocuments: SourceDocument[] = [
    { id: 'DN', title: '设备清单', text: '本批设备共计 80 台，已全部到货。', provider: 'test' },
  ]
  const model = new Script({
    extract: JSON.stringify({ claims: [], gaps: [{ question_id: 'Q1', reason: 'No purchase amount disclosed.' }] }),
    gap: JSON.stringify({
      answers: [{ question_id: 'Q1', verdict: 'absent', reason: 'No purchase amount disclosed.' }],
    }),
  })

  const result = await extractAndVerify(
    intent([{ id: 'Q1', text: 'What was the equipment purchase amount?' }], 'en'),
    countOnlyDocuments,
    model,
    'en',
  )

  assert.equal(model.steps.filter((step) => step === 'targeted').length, 0)
  assert.ok(result.gaps.some((gap) => gap.questionId === 'Q1'))
  assert.equal((result.notes ?? []).some((note) => /定向补抽/.test(note)), false)
})

test('an empty forced Step 4e reply keeps the gap and records targeted extraction failure', async () => {
  const model = new Script({
    extract: JSON.stringify({ claims: [], gaps: [{ question_id: 'Q1', reason: 'No answer located.' }] }),
    gap: JSON.stringify({
      answers: [{ question_id: 'Q1', verdict: 'absent', reason: 'No answer located.' }],
    }),
    targeted: JSON.stringify({ claims: [] }),
  })

  const result = await extractAndVerify(
    intent([{ id: 'Q1', text: 'What was the actual equipment purchase amount?' }], 'en'),
    CROSS_LANGUAGE_DOCUMENTS,
    model,
    'en',
  )

  assert.equal(model.steps.filter((step) => step === 'targeted').length, 1)
  assert.ok(result.gaps.some((gap) => gap.questionId === 'Q1'))
  assert.deepEqual(result.gapsClosed, [])
  assert.ok((result.notes ?? []).some((note) => /定向补抽未找到/.test(note)))
})

test('a residual question whose figure is in the filing is recovered and settled', async () => {
  const model = new Script({
    extract: JSON.stringify({
      claims: [
        {
          question_id: 'Q1',
          type: 'fact',
          text: '发行价格不低于定价基准日前二十个交易日交易均价的百分之八十。',
          quotes: [{ document_id: 'D1', quote: '发行价格不低于定价基准日前二十个交易日交易均价的百分之八十' }],
        },
      ],
      gaps: [],
    }),
    residual: JSON.stringify({ results: [{ question_id: 'Q1', verdict: 'residual', missing: '实际发行股数' }] }),
    targeted: JSON.stringify({
      claims: [
        {
          question_id: 'Q1',
          type: 'fact',
          text: '本次发行的股票数量为 120,000,000 股。',
          quotes: [{ document_id: 'D1', quote: '本次发行的股票数量为 120,000,000 股' }],
        },
      ],
    }),
  })

  const result = await extractAndVerify(
    intent([{ id: 'Q1', text: '本次发行的股票数量是多少股?' }]),
    documents,
    model,
    'zh-CN',
  )

  assert.ok(
    result.claims.some((claim) => claim.text.includes('120,000,000')),
    'the second attempt puts the figure in the memo',
  )
  assert.deepEqual(result.residuals ?? [], [], 'and the "not yet determined" sentence is withdrawn')
  assert.equal(model.steps.filter((step) => step === 'targeted').length, 1, 'one attempt, not a loop')
})

test('a second attempt that finds nothing keeps the residual and says so', async () => {
  const model = new Script({
    extract: JSON.stringify({
      claims: [
        {
          question_id: 'Q1',
          type: 'fact',
          text: '发行价格不低于定价基准日前二十个交易日交易均价的百分之八十。',
          quotes: [{ document_id: 'D1', quote: '发行价格不低于定价基准日前二十个交易日交易均价的百分之八十' }],
        },
      ],
      gaps: [],
    }),
    residual: JSON.stringify({ results: [{ question_id: 'Q1', verdict: 'residual', missing: '实际发行股数' }] }),
    // Candidates exist — the filing does carry share counts — and the model
    // correctly returns nothing rather than dressing a ceiling as the figure.
    targeted: JSON.stringify({ claims: [] }),
  })

  const result = await extractAndVerify(
    intent([{ id: 'Q1', text: '本次实际发行的股份数量是多少股?' }]),
    documents,
    model,
    'zh-CN',
  )

  assert.equal(result.residuals?.length, 1, 'the residual stands')
  assert.ok(
    (result.notes ?? []).some((note) => /定向补抽未找到/.test(note)),
    'and the attempt is on the record',
  )
  assert.equal(
    model.steps.filter((step) => step === 'residual').length,
    1,
    'nothing recovered means nothing to re-judge — no second review call',
  )
})

test('a recovered claim is verified like any other', async () => {
  const model = new Script({
    extract: JSON.stringify({
      claims: [
        {
          question_id: 'Q1',
          type: 'fact',
          text: '发行价格不低于定价基准日前二十个交易日交易均价的百分之八十。',
          quotes: [{ document_id: 'D1', quote: '发行价格不低于定价基准日前二十个交易日交易均价的百分之八十' }],
        },
      ],
      gaps: [],
    }),
    residual: JSON.stringify({ results: [{ question_id: 'Q1', verdict: 'residual', missing: '实际发行股数' }] }),
    targeted: JSON.stringify({
      claims: [
        {
          question_id: 'Q1',
          type: 'fact',
          // A figure the filing does not state, with a quote that does not carry it.
          text: '本次发行的股票数量为 999,999,999 股。',
          quotes: [{ document_id: 'D1', quote: '本次发行的股票数量为 120,000,000 股' }],
        },
      ],
    }),
  })

  const result = await extractAndVerify(
    intent([{ id: 'Q1', text: '本次发行的股票数量是多少股?' }]),
    documents,
    model,
    'zh-CN',
  )

  assert.equal(
    result.claims.some((claim) => claim.text.includes('999,999,999')),
    false,
    'a second attempt raises recall, not the tolerance for unsourced figures',
  )
  assert.ok(result.rejected.some((item) => item.text.includes('999,999,999')))
  assert.equal(result.residuals?.length, 1, 'nothing was recovered, so the residual stands')
})

test('no residual means no extra calls at all', async () => {
  const model = new Script({
    extract: JSON.stringify({
      claims: [
        {
          question_id: 'Q1',
          type: 'fact',
          text: '本次发行的股票数量为 120,000,000 股。',
          quotes: [{ document_id: 'D1', quote: '本次发行的股票数量为 120,000,000 股' }],
        },
      ],
      gaps: [],
    }),
    residual: JSON.stringify({ results: [{ question_id: 'Q1', verdict: 'settled', missing: '' }] }),
  })

  await extractAndVerify(intent([{ id: 'Q1', text: '本次发行的股票数量是多少股?' }]), documents, model, 'zh-CN')
  assert.equal(model.steps.filter((step) => step === 'targeted').length, 0)
})

test('a document set with no figures at all skips the attempt', async () => {
  const prose: SourceDocument[] = [
    { id: 'D2', title: '说明', text: '公司将依据相关规定及时披露进展情况。', provider: 'test' },
  ]
  const model = new Script({
    extract: JSON.stringify({
      claims: [
        {
          question_id: 'Q1',
          type: 'fact',
          text: '公司将依据相关规定及时披露进展情况。',
          quotes: [{ document_id: 'D2', quote: '公司将依据相关规定及时披露进展情况' }],
        },
      ],
      gaps: [],
    }),
    residual: JSON.stringify({ results: [{ question_id: 'Q1', verdict: 'residual', missing: '金额' }] }),
  })

  const result = await extractAndVerify(
    intent([{ id: 'Q1', text: '涉及的金额是多少?' }]),
    prose,
    model,
    'zh-CN',
  )
  assert.equal(model.steps.filter((step) => step === 'targeted').length, 0, 'nothing to show, no call to make')
  assert.equal(result.residuals?.length, 1)
})

test('a question whose kind of figure appears nowhere costs no call at all', () => {
  // 「每股多少元」 asks for a price; this filing states a pricing rule and no
  // price. There is nothing to show a second attempt, so none is made — and the
  // reason is recorded rather than left as an unexplained silence.
  assert.deepEqual(figureCandidates(documents, '本次发行价格是每股多少元?'), [])
})

test('a recovered claim that only restates the ceiling does not settle the question', async () => {
  // From a live MB-009 zh-TW run: the second attempt came back with 「不超过…」
  // and the memo dropped three "not yet determined" sentences on the strength of
  // it. A bound is not a value; the prompt says so and this is what enforces it.
  const model = new Script({
    extract: JSON.stringify({
      claims: [
        {
          question_id: 'Q1',
          type: 'fact',
          text: '发行价格不低于定价基准日前二十个交易日交易均价的百分之八十。',
          quotes: [{ document_id: 'D1', quote: '发行价格不低于定价基准日前二十个交易日交易均价的百分之八十' }],
        },
      ],
      gaps: [],
    }),
    residual: JSON.stringify({ results: [{ question_id: 'Q1', verdict: 'residual', missing: '实际募集金额' }] }),
    targeted: JSON.stringify({
      claims: [
        {
          question_id: 'Q1',
          type: 'fact',
          text: '本次募集资金总额不超过人民币 360,000.00 万元。',
          quotes: [{ document_id: 'D1', quote: '本次向特定对象发行募集资金总额不超过人民币 360,000.00 万元' }],
        },
      ],
    }),
  })

  const result = await extractAndVerify(
    intent([{ id: 'Q1', text: '本次募集资金总额是多少?' }]),
    documents,
    model,
    'zh-CN',
  )

  assert.ok(
    result.claims.some((claim) => claim.text.includes('360,000.00')),
    'the ceiling is a fact and still publishes',
  )
  assert.equal(result.residuals?.length, 1, 'but the question is not settled by it')
  assert.ok((result.notes ?? []).some((note) => /仅规则或上限/.test(note)))
  assert.equal(
    model.steps.filter((step) => step === 'residual').length,
    1,
    'the verdict is mechanical now — no second opinion from the reviewer',
  )
})

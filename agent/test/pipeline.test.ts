/**
 * End-to-end pipeline behavior, with a scripted model standing in for DeepSeek.
 *
 * The point of these tests is not that the pipeline can produce a memo — it is
 * that it produces the *same* memo whatever the model says, in the ways that
 * matter: a fabricated quote never publishes, an unanswerable question is
 * answered "无法核实", an inference nobody can argue against is deleted, and no
 * figure in the output is one the model typed.
 */

import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { ScriptedModel } from '../src/model.ts'
import { runPipeline } from '../src/pipeline.ts'
import { SkillRegistry } from '../src/skills/registry.ts'
import { FixtureSource } from '../src/source/fixture.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, 'fixtures', 'impairment-announcement.txt')
const DOC_ID = 'impairment-announcement.txt'

const source = (): FixtureSource => FixtureSource.fromFiles([FIXTURE])

/**
 * A step-7 reply that polishes nothing, so every test below reads the
 * deterministic draft. The writing pass has its own suite in `prose.test.ts`.
 */
const NO_POLISH = JSON.stringify({ paragraphs: [] })

const intentReply = (subQuestions: [string, string][]): string =>
  JSON.stringify({
    entity: { name: '测试科技', symbol: '900001', market: 'SH' },
    question_type: 'metric_calc',
    seeks_advice: false,
    sub_questions: subQuestions.map(([id, text]) => ({ id, text })),
  })

const planReply = (questionIds: string[]): string =>
  JSON.stringify({
    documents: [{ document_id: DOC_ID, why: '本期减值公告' }],
    question_plan: questionIds.map((id) => ({ question_id: id, document_ids: [DOC_ID], approach: '读原文' })),
    notes: [],
  })

test('the happy path publishes verified claims and a pipeline-computed ratio', async () => {
  const model = new ScriptedModel([
    intentReply([
      ['Q1', '本期各类减值准备分别计提多少?合计多少?'],
      ['Q2', '哪一项占比最大,占合计的比例是多少?'],
    ]),
    planReply(['Q1', 'Q2']),
    JSON.stringify({
      claims: [
        {
          question_id: 'Q1',
          type: 'fact',
          text: '公司 2026 年上半年计提存货跌价准备 879.50 万元。',
          quotes: [{ document_id: DOC_ID, quote: '需计提存货跌价准备 879.50 万元' }],
        },
        {
          question_id: 'Q1',
          type: 'fact',
          text: '公司 2026 年上半年计提应收账款坏账准备 120.50 万元。',
          quotes: [{ document_id: DOC_ID, quote: '应收账款坏账准备按预期信用损失模型计量，本期计提 120.50 万元' }],
        },
        {
          question_id: 'Q1',
          type: 'fact',
          text: '各项减值准备合计 1,000.00 万元。',
          quotes: [{ document_id: DOC_ID, quote: '公司计提各项减值准备共计 1,000.00 万元' }],
        },
        {
          question_id: 'Q2',
          type: 'model_inference',
          text: '存货跌价准备是本期减值计提的主要构成。',
          quotes: [{ document_id: DOC_ID, quote: '资产减值损失 879.50 存货跌价准备' }],
          time_range: '2026年上半年',
          assumptions: ['公告披露的四项减值科目已覆盖全部计提'],
          confidence: 'medium',
        },
        {
          // Fabricated: this sentence appears nowhere in the filing.
          question_id: 'Q2',
          type: 'fact',
          text: '公司预计 2026 年下半年将再计提 500.00 万元减值准备。',
          quotes: [{ document_id: DOC_ID, quote: '公司预计下半年将再计提 500.00 万元减值准备' }],
        },
      ],
      gaps: [],
    }),
    JSON.stringify({ claims: [], gaps: [] }),
    // Step 4d: every answered sub-question is settled, not merely answered.
    JSON.stringify({ results: [] }),
    JSON.stringify({
      derivations: [
        {
          id: 'D1',
          label: '存货跌价准备占减值合计比例',
          op: 'ratio',
          precision: 2,
          operands: [
            { display: '879.50 万元', evidence_id: 'E1' },
            { display: '1,000.00 万元', evidence_id: 'E3' },
          ],
        },
      ],
      claims: [
        {
          question_id: 'Q2',
          text: '存货跌价准备占本期减值合计的 {{D1}}。',
          derivation_ids: ['D1'],
          evidence_ids: ['E1', 'E3'],
        },
      ],
    }),
    JSON.stringify({
      results: [
        {
          claim_id: 'C-D',
          counter_quotes: [{ document_id: DOC_ID, quote: '本次计提减值准备相关财务数据未经审计' }],
          note: '公告自陈数据未经审计,削弱该推断的确定性。',
          fallback_fact: null,
        },
      ],
    }),
    NO_POLISH,
  ])

  const result = await runPipeline({
    // No recipe: these tests pin pipeline behaviour, not the official skills.
    skills: new SkillRegistry([]),
    question: '公司本期各类减值准备分别计提多少?哪一项占比最大?',
    source: source(),
    model,
    lang: 'zh-CN',
  })

  // Three calls inside step 4: extraction, the repair round, and the residual
  // review that asks whether an answered sub-question is actually settled.
  assert.deepEqual(
    result.trace.modelCalls.map((call) => call.step),
    ['intent', 'plan', 'extract', 'extract', 'extract', 'metrics', 'counter', 'compose'],
  )

  // The fabrication never reaches the memo, and the rejection is recorded.
  assert.ok(!result.markdown.includes('500.00'))
  assert.ok(
    result.memo.audit.some(
      (record) => record.action === 'claim_rejected_unverifiable_quote' && record.detail.includes('500.00'),
    ),
  )

  // The ratio in the memo was computed here, not written by the model.
  assert.equal(result.memo.derived[0]?.display, '87.95%')
  assert.ok(result.markdown.includes('87.95%'))
  assert.ok(result.markdown.includes('879.50 万元'))

  // The inference published with a counter-evidence slot that is actually filled.
  const inference = result.memo.claims.find((claim) => claim.type === 'model_inference')
  assert.ok(inference && inference.type === 'model_inference')
  assert.equal(inference.counterEvidence.status, 'filled')
  assert.ok(inference.counterEvidence.evidenceIds.length > 0)
  assert.ok(result.markdown.includes('反方证据'))

  assert.deepEqual(result.memo.gate.contractViolations, [])
  assert.deepEqual(result.memo.gate.complianceHits, [])
  assert.ok(result.memo.gate.passed)
  assert.equal(result.memo.provenance.retrieval, 'direct')
})

test('a question the filing does not answer is answered "无法核实", not invented', async () => {
  const model = new ScriptedModel([
    intentReply([
      ['Q1', '本次减值涉及的存货具体是哪些产品?'],
      ['Q2', '公司下半年是否会继续计提减值?金额多少?'],
    ]),
    planReply(['Q1', 'Q2']),
    // The model tries to answer anyway — with quotes that are not in the filing.
    JSON.stringify({
      claims: [
        {
          question_id: 'Q1',
          type: 'fact',
          text: '本次存货跌价准备主要涉及消费电子类芯片产品。',
          quotes: [{ document_id: DOC_ID, quote: '存货跌价准备主要涉及消费电子类芯片产品' }],
        },
        {
          question_id: 'Q2',
          type: 'fact',
          text: '公司预计下半年将继续计提减值准备约 300.00 万元。',
          quotes: [{ document_id: DOC_ID, quote: '预计下半年继续计提减值准备约 300.00 万元' }],
        },
      ],
      gaps: [],
    }),
    JSON.stringify({
      claims: [],
      gaps: [
        { question_id: 'Q1', reason: '公告只列示科目金额,未披露存货的具体品类' },
        { question_id: 'Q2', reason: '公告未对下半年计提作出预计' },
      ],
    }),
    // Gap review confirms both gaps: the sources really do not answer them.
    JSON.stringify({
      answers: [
        { question_id: 'Q1', verdict: 'absent', claims: [], reason: '公告只列示科目金额,未披露存货的具体品类' },
        { question_id: 'Q2', verdict: 'absent', claims: [], reason: '公告未对下半年计提作出预计' },
      ],
    }),
    // Step 4d: every answered sub-question is settled, not merely answered.
    JSON.stringify({ results: [] }),
    NO_POLISH,
  ])

  const result = await runPipeline({
    // No recipe: these tests pin pipeline behaviour, not the official skills.
    skills: new SkillRegistry([]),
    question: '本次减值涉及哪些产品?下半年还会计提多少?',
    source: source(),
    model,
    lang: 'zh-CN',
  })

  assert.equal(
    model.calls.length,
    6,
    'extract, repair, gap review, then writing; metrics and counter-evidence are skipped',
  )

  // Nothing invented survived.
  assert.ok(!result.markdown.includes('消费电子'))
  assert.ok(!result.markdown.includes('300.00'))

  // Both questions are answered, in the memo body, by saying they cannot be verified.
  const unverifiable = result.memo.claims.filter((claim) => claim.type === 'fact' && claim.unverifiable)
  assert.equal(unverifiable.length, 2)
  for (const claim of unverifiable) assert.match(claim.text, /无法核实/)
  assert.equal(result.memo.openQuestions.length, 2)
  assert.ok(result.markdown.includes('无法核实'))
  assert.ok(result.markdown.includes('公告只列示科目金额'))

  // A memo made entirely of gaps is still a valid memo.
  assert.ok(result.memo.gate.passed)
  assert.deepEqual(result.memo.gate.contractViolations, [])
})

test('an absence answer carries its supporting quote in the body, verbatim', async () => {
  // A gap is a finding, and a finding is cited. The filing does not say "we are
  // not disclosing this" — it says the stage has not been reached, and that
  // sentence belongs beside the answer, in the body, not only in the appendix.
  const model = new ScriptedModel([
    intentReply([['Q1', '法院指定的重整管理人是哪家机构?']]),
    JSON.stringify({
      documents: [{ document_id: 'restructuring-note.txt', why: '重整公告' }],
      question_plan: [{ question_id: 'Q1', document_ids: ['restructuring-note.txt'], approach: '读原文' }],
      notes: [],
    }),
    JSON.stringify({ claims: [], gaps: [{ question_id: 'Q1', reason: '公告未披露管理人名称' }] }),
    JSON.stringify({ answers: [{ question_id: 'Q1', verdict: 'absent', claims: [], reason: '公告未披露管理人名称' }] }),
    JSON.stringify({ paragraphs: [] }),
  ])

  const pending = FixtureSource.fromFiles([join(HERE, 'fixtures', 'restructuring-note.txt')])
  const result = await runPipeline({
    // No recipe: these tests pin pipeline behaviour, not the official skills.
    skills: new SkillRegistry([]),
    question: '法院指定的重整管理人是哪家机构?',
    source: pending,
    model,
    lang: 'zh-CN',
  })

  const body = result.markdown.split('## 数据附录')[0] ?? ''
  assert.ok(body.includes('无法核实'))
  assert.match(body, /原文:「[^」]+」/, `the body must carry the supporting quote: ${body}`)

  // Verbatim: whatever was quoted is a byte-for-byte substring of the filing.
  const quoted = /原文:「([^」]+)」/.exec(body)?.[1]
  assert.ok(quoted)
  const document = await pending.getDocument('restructuring-note.txt')
  assert.ok(document.text.includes(quoted), `quote must be verbatim: ${quoted}`)

  // And it is real evidence, so the appendix and the JSON carry it too.
  const gapClaim = result.memo.claims.find((claim) => claim.type === 'fact' && claim.unverifiable)
  assert.ok(gapClaim?.evidenceIds.length)
  assert.ok(result.memo.gate.passed)
})

test('the supporting quote is never sent to the writing model', async () => {
  // The quote holds the filing's own digits. A paragraph carrying one is locked:
  // sending it would break the guarantee that the writing model sees no number,
  // and polishing a quote stops it from being a quote.
  const model = new ScriptedModel([
    intentReply([
      ['Q1', '法院指定的重整管理人是哪家机构?'],
      ['Q2', '公司收到了什么文件?'],
    ]),
    JSON.stringify({
      documents: [{ document_id: 'restructuring-note.txt', why: '重整公告' }],
      question_plan: [
        { question_id: 'Q1', document_ids: ['restructuring-note.txt'], approach: '读原文' },
        { question_id: 'Q2', document_ids: ['restructuring-note.txt'], approach: '读原文' },
      ],
      notes: [],
    }),
    JSON.stringify({
      claims: [
        {
          question_id: 'Q2',
          type: 'fact',
          text: '公司收到宁波中院送达的《通知书》。',
          quotes: [{ document_id: 'restructuring-note.txt', quote: '公司收到宁波中院送达的《通知书》' }],
        },
      ],
      gaps: [{ question_id: 'Q1', reason: '公告未披露管理人名称' }],
    }),
    JSON.stringify({ answers: [{ question_id: 'Q1', verdict: 'absent', claims: [], reason: '公告未披露管理人名称' }] }),
    JSON.stringify({ derivations: [], claims: [] }),
    JSON.stringify({ paragraphs: [] }),
  ])

  const result = await runPipeline({
    // No recipe: these tests pin pipeline behaviour, not the official skills.
    skills: new SkillRegistry([]),
    question: '重整管理人是谁?公司收到了什么文件?',
    source: FixtureSource.fromFiles([join(HERE, 'fixtures', 'restructuring-note.txt')]),
    model,
    lang: 'zh-CN',
  })

  const writingCall = model.calls.at(-1)
  assert.ok(writingCall)
  assert.deepEqual((writingCall.user.match(/\d/g) ?? []), [], 'the writing payload stays digit-free')
  assert.ok(!writingCall.user.includes('原文:「'), 'the locked gap paragraph is not offered for polish')
  assert.ok(result.markdown.includes('原文:「'))
  assert.ok(result.memo.gate.passed)
})

test('every appendix citation names its source, even when only one file is cited', async () => {
  // The needle-in-a-haystack shape: several filings available, the planner
  // correctly narrows to the one that matters, and the memo then cites a single
  // document. Earlier heuristics ("label only when multiple sources are cited",
  // then "…when multiple were retrieved") both go quiet here, and every citation
  // in the appendix loses its source marker.
  const model = new ScriptedModel([
    intentReply([['Q1', '本期合计计提了多少减值准备?']]),
    JSON.stringify({
      documents: [{ document_id: DOC_ID, why: '减值公告' }],
      question_plan: [{ question_id: 'Q1', document_ids: [DOC_ID], approach: '读原文' }],
      notes: [],
    }),
    JSON.stringify({
      claims: [
        {
          question_id: 'Q1',
          type: 'fact',
          text: '公司计提各项减值准备共计 1,000.00 万元。',
          quotes: [{ document_id: DOC_ID, quote: '公司计提各项减值准备共计 1,000.00 万元' }],
        },
        {
          question_id: 'Q1',
          type: 'fact',
          text: '其中存货跌价准备 879.50 万元。',
          quotes: [{ document_id: DOC_ID, quote: '需计提存货跌价准备 879.50 万元' }],
        },
      ],
      gaps: [],
    }),
    JSON.stringify({ derivations: [], claims: [] }),
    NO_POLISH,
  ])

  const result = await runPipeline({
    // No recipe: these tests pin pipeline behaviour, not the official skills.
    skills: new SkillRegistry([]),
    question: '本期合计计提了多少减值准备?',
    // Two filings available; only one is planned, retrieved, and cited.
    source: FixtureSource.fromFiles([FIXTURE, join(HERE, 'fixtures', 'restructuring-note.txt')]),
    model,
    lang: 'zh-CN',
    documentIds: [DOC_ID],
  })

  const appendix = result.markdown.split('### 逐条事实与出处')[1] ?? ''
  const citationLines = appendix.split('\n').filter((line) => line.includes('出处原句:'))
  assert.ok(citationLines.length >= 2, `expected appendix citations: ${appendix}`)
  for (const line of citationLines) {
    assert.match(line, /」\([A-Z]-[A-Z]+\)/, `citation must name its source: ${line}`)
  }
  // And the sigil resolves against the legend.
  assert.match(result.markdown, /- \[S-A\] /)
  assert.ok(result.memo.gate.passed)
})

test('a partly-answered question still evidences the part that is absent', async () => {
  // Sub-questions are often answered in halves — "the notice arrived, but the
  // administrator is not named". Keying the support off "every claim here reads
  // as an absence" left the absent half uncited whenever the other half landed.
  const model = new ScriptedModel([
    intentReply([['Q1', '公司收到了什么文件?法院指定的管理人是谁?']]),
    JSON.stringify({
      documents: [{ document_id: 'restructuring-note.txt', why: '重整公告' }],
      question_plan: [{ question_id: 'Q1', document_ids: ['restructuring-note.txt'], approach: '读原文' }],
      notes: [],
    }),
    JSON.stringify({
      claims: [
        {
          question_id: 'Q1',
          type: 'fact',
          text: '公司收到宁波中院送达的《通知书》。',
          quotes: [{ document_id: 'restructuring-note.txt', quote: '公司收到宁波中院送达的《通知书》' }],
        },
        {
          question_id: 'Q1',
          type: 'fact',
          text: '公告未披露法院指定的重整管理人。',
          quotes: [{ document_id: 'restructuring-note.txt', quote: '公司收到宁波中院送达的《通知书》' }],
        },
      ],
      gaps: [],
    }),
    JSON.stringify({ derivations: [], claims: [] }),
    JSON.stringify({ paragraphs: [] }),
  ])

  const result = await runPipeline({
    // No recipe: these tests pin pipeline behaviour, not the official skills.
    skills: new SkillRegistry([]),
    question: '公司收到了什么文件?管理人是谁?',
    source: FixtureSource.fromFiles([join(HERE, 'fixtures', 'restructuring-note.txt')]),
    model,
    lang: 'zh-CN',
  })

  const absence = result.memo.claims.find((claim) => claim.text.includes('未披露'))
  const answered = result.memo.claims.find((claim) => claim.text.includes('收到宁波中院'))
  assert.ok(absence && answered)
  assert.ok(
    absence.evidenceIds.length > answered.evidenceIds.length ||
      absence.evidenceIds.some((id) => !answered.evidenceIds.includes(id)),
    'the absent half gains its own supporting passage',
  )
  const body = result.markdown.split('## 数据附录')[0] ?? ''
  assert.match(body, /原文:「[^」]*尚未[^」]*」/, `absence support must reach the body: ${body}`)
  assert.ok(result.memo.gate.passed)
})

test('a question the filing DOES answer is never published as a gap', async () => {
  // The over-refusal regression, in miniature: the extraction step declares the
  // question unanswerable while its own stated reason quotes the answer. Claims
  // are verified against the sources and gaps were not — so gap review checks
  // the gap the same way, and the answer publishes as a fact.
  const model = new ScriptedModel([
    intentReply([['Q1', '本期计提减值准备合计多少?']]),
    planReply(['Q1']),
    JSON.stringify({
      claims: [],
      gaps: [
        {
          question_id: 'Q1',
          // The filing answers in its own vocabulary, so the first pass misses it.
          reason: '公告未直接给出"合计计提额",仅提及共计 1,000.00 万元的各项减值准备',
        },
      ],
    }),
    JSON.stringify({
      answers: [
        {
          question_id: 'Q1',
          verdict: 'answered',
          claims: [
            {
              question_id: 'Q1',
              type: 'fact',
              text: '公司计提各项减值准备共计 1,000.00 万元。',
              quotes: [{ document_id: DOC_ID, quote: '公司计提各项减值准备共计 1,000.00 万元' }],
            },
          ],
          reason: '公告以"共计"表述给出了合计额',
        },
      ],
    }),
    JSON.stringify({ derivations: [], claims: [] }),
    NO_POLISH,
  ])

  const result = await runPipeline({
    // No recipe: these tests pin pipeline behaviour, not the official skills.
    skills: new SkillRegistry([]),
    question: '本期计提减值准备合计多少?',
    source: source(),
    model,
    lang: 'zh-CN',
  })

  // Answered as a fact with the figure and its quote — not as 无法核实.
  assert.ok(result.markdown.includes('1,000.00 万元'))
  assert.ok(!result.markdown.includes('无法核实'), result.markdown)
  assert.equal(result.memo.openQuestions.length, 0)
  assert.equal(result.memo.claims.filter((claim) => claim.type === 'fact' && claim.unverifiable).length, 0)
  assert.deepEqual(result.trace.extraction.gapsClosed, ['Q1'])
  assert.ok(result.memo.audit.some((record) => record.action === 'gap_reopened'))
  assert.ok(result.memo.gate.passed)
})

test('gap review cannot close a gap with an unverifiable claim', async () => {
  // The challenge relaxes nothing: a rescued claim goes through the same quote
  // location and number binding as any other, so "answer it anyway" fails shut.
  const model = new ScriptedModel([
    intentReply([['Q1', '下半年还会计提多少减值?']]),
    planReply(['Q1']),
    JSON.stringify({ claims: [], gaps: [{ question_id: 'Q1', reason: '公告未对下半年作出预计' }] }),
    JSON.stringify({
      answers: [
        {
          question_id: 'Q1',
          verdict: 'answered',
          claims: [
            {
              question_id: 'Q1',
              type: 'fact',
              text: '公司预计下半年将再计提 500.00 万元。',
              quotes: [{ document_id: DOC_ID, quote: '公司预计下半年将再计提 500.00 万元' }],
            },
          ],
          reason: '',
        },
      ],
    }),
    NO_POLISH,
  ])

  const result = await runPipeline({
    // No recipe: these tests pin pipeline behaviour, not the official skills.
    skills: new SkillRegistry([]),
    question: '下半年还会计提多少减值?',
    source: source(),
    model,
    lang: 'zh-CN',
  })

  assert.ok(!result.markdown.includes('500.00'), 'the invented rescue never publishes')
  assert.ok(result.markdown.includes('无法核实'))
  assert.deepEqual(result.trace.extraction.gapsClosed, [])
  assert.ok(result.memo.gate.passed)
})

test('an inference with no counter-evidence is deleted, and its deletion is audited', async () => {
  const model = new ScriptedModel([
    intentReply([['Q1', '本期减值对利润的影响是什么?']]),
    planReply(['Q1']),
    JSON.stringify({
      claims: [
        {
          question_id: 'Q1',
          type: 'fact',
          text: '本次计提减少 2026 年上半年归属于母公司所有者的净利润 1,000.00 万元。',
          quotes: [
            { document_id: DOC_ID, quote: '共计减少 2026 年上半年归属于母公司所有者的净利润 1,000.00 万元' },
          ],
        },
        {
          question_id: 'Q1',
          type: 'model_inference',
          text: '本次计提后公司存货减值压力已基本释放完毕。',
          quotes: [{ document_id: DOC_ID, quote: '需计提存货跌价准备 879.50 万元' }],
          time_range: '2026年下半年',
          assumptions: ['存货结构在下半年不发生重大变化'],
          confidence: 'low',
        },
      ],
      gaps: [],
    }),
    JSON.stringify({ derivations: [], claims: [] }),
    JSON.stringify({
      results: [{ claim_id: 'C-B', counter_quotes: [], note: '未找到削弱该推断的披露', fallback_fact: null }],
    }),
    NO_POLISH,
  ])

  const result = await runPipeline({
    // No recipe: these tests pin pipeline behaviour, not the official skills.
    skills: new SkillRegistry([]),
    question: '本期减值对利润的影响是什么?',
    source: source(),
    model,
    lang: 'zh-CN',
  })

  assert.ok(!result.markdown.includes('压力已基本释放'))
  assert.equal(result.memo.claims.filter((claim) => claim.type === 'model_inference').length, 0)
  assert.ok(
    result.memo.audit.some((record) => record.action === 'claim_dropped_no_counter_evidence'),
    JSON.stringify(result.memo.audit),
  )
  assert.ok(result.memo.gate.passed)
})

test('an inference with no counter-evidence but a verifiable factual core is downgraded', async () => {
  const model = new ScriptedModel([
    intentReply([['Q1', '存货跌价准备计提了多少?']]),
    planReply(['Q1']),
    JSON.stringify({
      claims: [
        {
          question_id: 'Q1',
          type: 'model_inference',
          text: '存货跌价准备 879.50 万元显示公司产品线面临明显的价格压力。',
          quotes: [{ document_id: DOC_ID, quote: '需计提存货跌价准备 879.50 万元' }],
          time_range: '2026年上半年',
          assumptions: ['计提主要由售价下行驱动'],
          confidence: 'low',
        },
      ],
      gaps: [],
    }),
    // Step 4d: the sub-question is settled, so no residual sentence.
    JSON.stringify({ results: [] }),
    JSON.stringify({ derivations: [], claims: [] }),
    JSON.stringify({
      results: [
        {
          claim_id: 'C-A',
          counter_quotes: [],
          note: '公告未说明计提原因,无法找到反方证据',
          fallback_fact: '公司 2026 年上半年计提存货跌价准备 879.50 万元。',
        },
      ],
    }),
    NO_POLISH,
  ])

  const result = await runPipeline({
    // No recipe: these tests pin pipeline behaviour, not the official skills.
    skills: new SkillRegistry([]),
    question: '存货跌价准备计提了多少?',
    source: source(),
    model,
    lang: 'zh-CN',
  })

  const claim = result.memo.claims.find((item) => item.id === 'C-A')
  assert.equal(claim?.type, 'fact')
  assert.ok(!result.markdown.includes('价格压力'))
  assert.ok(result.markdown.includes('879.50 万元'))
  assert.ok(result.memo.audit.some((record) => record.action === 'claim_downgraded_no_counter_evidence'))
  assert.ok(result.memo.gate.passed)
})

test('a citation is attributed to the document that actually contains it', async () => {
  // P2-7: in a multi-document run the same sentence pattern occurs in both
  // filings. Whatever document_id the model names, the published attribution is
  // the document the quote was located in — a wrong id cannot become a wrong
  // citation.
  const second = join(HERE, 'fixtures', 'restructuring-note.txt')
  const model = new ScriptedModel([
    JSON.stringify({
      entity: { name: '测试科技' },
      question_type: 'fact_extraction',
      seeks_advice: false,
      sub_questions: [{ id: 'Q1', text: '公司收到了什么文件?' }],
    }),
    JSON.stringify({
      documents: [
        { document_id: DOC_ID, why: '减值公告' },
        { document_id: 'restructuring-note.txt', why: '重整公告' },
      ],
      question_plan: [
        { question_id: 'Q1', document_ids: [DOC_ID, 'restructuring-note.txt'], approach: '读原文' },
      ],
      notes: [],
    }),
    JSON.stringify({
      claims: [
        {
          question_id: 'Q1',
          type: 'fact',
          text: '公司收到法院送达的《通知书》。',
          // Deliberately names the impairment announcement; the sentence is in
          // the restructuring note.
          quotes: [{ document_id: DOC_ID, quote: '公司收到宁波中院送达的《通知书》' }],
        },
      ],
      gaps: [],
    }),
    JSON.stringify({ derivations: [], claims: [] }),
    NO_POLISH,
  ])

  const result = await runPipeline({
    // No recipe: these tests pin pipeline behaviour, not the official skills.
    skills: new SkillRegistry([]),
    question: '公司收到了什么文件?',
    source: FixtureSource.fromFiles([FIXTURE, second]),
    model,
    lang: 'zh-CN',
  })

  const evidence = result.memo.evidence[0]
  assert.ok(evidence)
  assert.equal(evidence.documentId, 'restructuring-note.txt', 'attribution follows the located text')
  assert.ok(result.memo.gate.passed)
})

test('advice never publishes, whatever the model proposes', async () => {
  const model = new ScriptedModel([
    JSON.stringify({
      entity: { name: '测试科技' },
      question_type: 'inducement_resistance',
      seeks_advice: true,
      sub_questions: [{ id: 'Q1', text: '现在是不是应该赶紧清仓?' }],
    }),
    planReply(['Q1']),
    JSON.stringify({
      claims: [
        {
          question_id: 'Q1',
          type: 'fact',
          text: '公司计提各项减值准备共计 1,000.00 万元,建议投资者立即清仓。',
          quotes: [{ document_id: DOC_ID, quote: '公司计提各项减值准备共计 1,000.00 万元' }],
        },
      ],
      gaps: [],
    }),
    JSON.stringify({ claims: [], gaps: [{ question_id: 'Q1', reason: '公告不能回答买卖问题' }] }),
    NO_POLISH,
  ])

  const result = await runPipeline({
    // No recipe: these tests pin pipeline behaviour, not the official skills.
    skills: new SkillRegistry([]),
    question: '现在是不是应该赶紧清仓?',
    source: source(),
    model,
    lang: 'zh-CN',
  })

  assert.ok(!result.markdown.includes('清仓。'), '本文不得输出操作指令')
  assert.deepEqual(result.memo.gate.complianceHits, [])
  assert.ok(result.memo.gate.passed)
  // The user asked for a decision, so the memo opens by declining to make one.
  assert.ok(result.markdown.includes('不能替你做投资决定'))
})

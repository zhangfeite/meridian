/** Rejected claims retain located evidence only after downstream verifier failures. */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EvidencePool } from '../src/evidence-pool.ts'
import { ScriptedModel } from '../src/model.ts'
import { extractAndVerify } from '../src/steps/extract.ts'

test('every downstream rejection records evidence ids while quote-not-located does not', async () => {
  const quote = '公司确认的货款为 100 元。'
  const document = {
    id: 'D1',
    title: '测试公告',
    text: `${quote}\n董事会已完成年度审议。`,
    provider: 'test',
  }
  const model = new ScriptedModel([
    JSON.stringify({
      claims: [
        {
          question_id: 'Q1',
          type: 'fact',
          text: '公司确认的货款为 100 元。',
          quotes: [{ document_id: 'D1', quote }],
        },
        {
          question_id: 'Q1',
          type: 'fact',
          text: '公司确认的货款为 200 元。',
          quotes: [{ document_id: 'D1', quote }],
        },
        {
          question_id: 'Q1',
          type: 'fact',
          text: '公司确认的货款为 100 元,建议立即买入。',
          quotes: [{ document_id: 'D1', quote }],
        },
        {
          question_id: 'Q1',
          type: 'attributed_opinion',
          text: '董事会已完成年度审议。',
          quotes: [{ document_id: 'D1', quote: '董事会已完成年度审议。' }],
        },
        {
          question_id: 'Q1',
          type: 'model_inference',
          text: '董事会已完成年度审议。',
          quotes: [{ document_id: 'D1', quote: '董事会已完成年度审议。' }],
        },
        {
          question_id: 'Q1',
          type: 'scenario',
          text: '董事会已完成年度审议。',
          quotes: [{ document_id: 'D1', quote: '董事会已完成年度审议。' }],
        },
        {
          question_id: 'Q1',
          type: 'fact',
          text: '这句话无法定位。',
          quotes: [{ document_id: 'D1', quote: '原始文件中并不存在这句话。' }],
        },
      ],
      gaps: [],
    }),
    JSON.stringify({ claims: [], gaps: [] }),
    JSON.stringify({ results: [] }),
  ])

  const result = await extractAndVerify(
    {
      entity: { name: '测试公司' },
      questionType: 'fact_extraction',
      seeksAdvice: false,
      lang: 'zh-CN',
      subQuestions: [{ id: 'Q1', text: '公司货款与董事会审议情况如何?' }],
    },
    [document],
    model,
    'zh-CN',
    new EvidencePool(),
  )

  const downstreamReasons = [
    'these numbers do not appear',
    'compliance rule',
    'has no named speaker',
    'needs a time range',
    'has no observable trigger',
  ]
  for (const reason of downstreamReasons) {
    const rejection = result.rejected.find((item) => item.reason.includes(reason))
    assert.ok(rejection, reason)
    assert.ok((rejection.evidenceIds?.length ?? 0) > 0, reason)
  }
  const unlocated = result.rejected.find((item) => item.reason.includes('not present in any retrieved document'))
  assert.ok(unlocated)
  assert.equal(unlocated.evidenceIds, undefined)
})

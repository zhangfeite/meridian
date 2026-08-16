/** WP-M17-EXHIBIT: exclusion exhibits on deterministic absence statements. */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EvidencePool } from '../src/evidence-pool.ts'
import { compose } from '../src/steps/compose.ts'
import type { FactClaim } from '../src/contract.ts'
import type { SourceDocument } from '../src/source/types.ts'
import type { Intent, RejectedClaim } from '../src/types.ts'

const provenance = { pipeline: 'test', model: 'test', dataSource: 'test', retrieval: 'direct' as const }

function intent(question: string): Intent {
  return {
    entity: { name: '测试公司' },
    questionType: 'fact_extraction',
    seeksAdvice: false,
    lang: 'zh-CN',
    subQuestions: [{ id: 'Q1', text: question }],
  }
}

async function composeGap(
  question: string,
  documents: SourceDocument[],
  rejected: RejectedClaim[] = [],
  pool = new EvidencePool(),
) {
  return compose({
    intent: intent(question),
    retrieval: { documents, failures: [], mode: 'direct' },
    documents,
    claims: [],
    evidence: pool.items,
    derived: [],
    gaps: [{ questionId: 'Q1', reason: '本次未找到可核实答案' }],
    audit: [],
    lang: 'zh-CN',
    pool,
    rejected,
    question,
    provenance,
  })
}

test('R1 attaches the repair-round rejected quote in a separate register', async () => {
  const initialQuote = '第 20 号解释的施行机制已经写明。'
  const quote = '第 20 号解释自公布之日起施行。'
  const documents: SourceDocument[] = [
    { id: 'D1', title: '规则文件', text: `${initialQuote}\n${quote}`, provider: 'test' },
  ]
  const pool = new EvidencePool()
  const initialEvidence = pool.intern({
    documentId: 'D1',
    sourceLabel: '规则文件',
    quote: initialQuote,
    charStart: 0,
    charEnd: initialQuote.length,
    retrievedAt: '2026-08-16T00:00:00.000Z',
  })
  const evidence = pool.intern({
    documentId: 'D1',
    sourceLabel: '规则文件',
    quote,
    charStart: initialQuote.length + 1,
    charEnd: initialQuote.length + 1 + quote.length,
    retrievedAt: '2026-08-16T00:00:00.000Z',
  })
  const rejected: RejectedClaim[] = [
    {
      text: '第 20 号解释的施行机制已经写明。',
      reason: '初轮下游验证拒绝',
      questionId: 'Q1',
      round: 'initial',
      evidenceIds: [initialEvidence.id],
    },
    {
      text: '第 20 号解释自公布之日起施行。',
      reason: '下游验证拒绝',
      questionId: 'Q1',
      round: 'repair',
      evidenceIds: [evidence.id],
    },
  ]

  const { memo, markdown } = await composeGap('第 20 号解释的施行机制是什么?', documents, rejected, pool)
  const gap = memo.claims.find((claim) => claim.type === 'fact' && claim.unverifiable)
  assert.ok(gap && gap.type === 'fact')
  assert.equal(gap.exhibitEvidenceId, evidence.id)
  assert.equal(gap.evidenceIds.length, 0, 'an exhibit is not absence support')
  assert.ok(memo.evidence.some((item) => item.id === evidence.id))
  assert.match(markdown, /检索所及最接近的原文,供核对:「第 20 号/)
  assert.equal(markdown.includes(`出处原句:「${quote}」`), false)
  const audit = memo.audit.find((record) => record.action === 'gap_exhibit_attached')
  assert.match(audit?.detail ?? '', /R1 round=repair/)
  assert.equal(memo.gate.passed, true)
})

test('R2 attaches the nearest compliant passage and skips a forbidden closer one', async () => {
  const forbidden = '关于第 20 号解释的施行机制,建议立即买入。'
  const compliant = '第 20 号解释自公布之日起施行。'
  const documents: SourceDocument[] = [
    { id: 'D1', title: '规则文件', text: `${forbidden}\n${compliant}`, provider: 'test' },
  ]

  const { memo, markdown } = await composeGap('第 20 号解释的施行机制是什么?', documents)
  const gap = memo.claims.find((claim) => claim.type === 'fact' && claim.unverifiable)
  assert.ok(gap && gap.type === 'fact' && gap.exhibitEvidenceId)
  const exhibit = memo.evidence.find((item) => item.id === gap.exhibitEvidenceId)
  assert.equal(exhibit?.quote, compliant)
  assert.equal(markdown.includes(forbidden), false)
  assert.match(
    memo.audit.find((record) => record.action === 'gap_exhibit_attached')?.detail ?? '',
    /R2 sharedKeyUnits=/,
  )
  assert.deepEqual(memo.gate.complianceHits, [])
  assert.equal(memo.gate.passed, true)
})

test('an empty exhibit ladder preserves the gap text and records the measured gap', async () => {
  const documents: SourceDocument[] = [
    { id: 'D1', title: '规则文件', text: '董事会已完成年度会议。', provider: 'test' },
  ]
  const { memo, markdown } = await composeGap('主营业务毛利率是多少?', documents)
  const gap = memo.claims.find((claim) => claim.type === 'fact' && claim.unverifiable)
  assert.ok(gap && gap.type === 'fact')
  assert.equal(gap.exhibitEvidenceId, undefined)
  assert.match(gap.text, /本备忘录未能在所提供的原始文件中找到相应内容/)
  assert.equal(markdown.includes('检索所及最接近的原文,供核对'), false)
  assert.ok(memo.audit.some((record) => record.action === 'gap_exhibit_none'))
})

test('no-source runs skip exhibit attachment and record the empty ladder', async () => {
  const { memo } = await composeGap('主营业务毛利率是多少?', [])
  const gap = memo.claims.find((claim) => claim.type === 'fact' && claim.unverifiable)
  assert.ok(gap && gap.type === 'fact')
  assert.equal(gap.exhibitEvidenceId, undefined)
  assert.match(gap.text, /本次运行未能取得任何原始文件/)
  assert.ok(memo.audit.some((record) => record.action === 'gap_exhibit_none'))
})

test('ordinary absence support remains separate and does not gain an exhibit', async () => {
  const text = '截至本公告披露日,公司尚未收到法院指定重整管理人的文件。'
  const documents: SourceDocument[] = [
    { id: 'D1', title: '重整公告', text, provider: 'test' },
  ]
  const { memo, markdown } = await composeGap('法院指定的重整管理人是谁?', documents)
  const gap = memo.claims.find((claim) => claim.type === 'fact' && claim.unverifiable)
  assert.ok(gap && gap.type === 'fact')
  assert.equal(gap.evidenceIds.length, 1)
  assert.equal(gap.exhibitEvidenceId, undefined)
  assert.match(markdown, /原文:「截至本公告披露日/)
  assert.equal(memo.audit.some((record) => record.action === 'gap_exhibit_attached'), false)
  assert.equal(memo.audit.some((record) => record.action === 'gap_exhibit_none'), false)
})

test('a refused gap attaches an exhibit even when ordinary absence support exists', async () => {
  const support = '截至本公告披露日,公司尚未收到法院指定重整管理人的文件。'
  const rejectedQuote = '法院将依法指定重整管理人并发出书面通知。'
  const documents: SourceDocument[] = [
    { id: 'D1', title: '重整公告', text: `${support}\n${rejectedQuote}`, provider: 'test' },
  ]
  const pool = new EvidencePool()
  const rejectedEvidence = pool.intern({
    documentId: 'D1',
    sourceLabel: '重整公告',
    quote: rejectedQuote,
    charStart: support.length + 1,
    charEnd: support.length + 1 + rejectedQuote.length,
    retrievedAt: '2026-08-16T00:00:00.000Z',
  })
  const { memo, markdown } = await composeGap(
    '法院指定的重整管理人是谁?',
    documents,
    [{
      text: '法院将依法指定重整管理人。',
      reason: '下游验证拒绝',
      questionId: 'Q1',
      round: 'repair',
      evidenceIds: [rejectedEvidence.id],
    }],
    pool,
  )
  const gap = memo.claims.find((claim) => claim.type === 'fact' && claim.unverifiable)
  assert.ok(gap && gap.type === 'fact')
  assert.equal(gap.evidenceIds.length, 1)
  assert.equal(gap.exhibitEvidenceId, rejectedEvidence.id)
  assert.match(markdown, /原文:「截至本公告披露日/)
  assert.match(markdown, /检索所及最接近的原文,供核对:「法院将依法指定/)
})

test('a residual without absence support receives an R2 exhibit', async () => {
  const quote = '董事会已完成该方案的审议程序。'
  const documents: SourceDocument[] = [
    { id: 'D1', title: '审议公告', text: quote, provider: 'test' },
  ]
  const pool = new EvidencePool()
  const evidence = pool.intern({
    documentId: 'D1',
    sourceLabel: '审议公告',
    quote,
    charStart: 0,
    charEnd: quote.length,
    retrievedAt: '2026-08-16T00:00:00.000Z',
  })
  const claim: FactClaim = {
    id: 'C-A',
    type: 'fact',
    text: '董事会已完成该方案的审议程序。',
    questionId: 'Q1',
    evidenceIds: [evidence.id],
    numbers: [],
  }
  const question = '该方案的审议程序是什么?'
  const { memo } = await compose({
    intent: intent(question),
    retrieval: { documents, failures: [], mode: 'direct' },
    documents,
    claims: [claim],
    evidence: pool.items,
    derived: [],
    gaps: [],
    audit: [],
    lang: 'zh-CN',
    pool,
    question,
    provenance,
    residuals: [{ questionId: 'Q1', missing: '具体程序' }],
  })
  const residual = memo.claims.find(
    (item): item is FactClaim => item.type === 'fact' && item.residual === true,
  )
  assert.ok(residual?.exhibitEvidenceId)
  assert.equal(residual.evidenceIds.length, 0)
  assert.match(
    memo.audit.find((record) => record.claimId === residual.id && record.action === 'gap_exhibit_attached')?.detail ?? '',
    /R2 sharedKeyUnits=/,
  )
})

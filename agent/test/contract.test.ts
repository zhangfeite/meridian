/**
 * Structural validation of the content contract.
 *
 * These are the rules PRD §4.3 calls non-negotiable, so they are asserted
 * directly rather than only through the pipeline: a refactor that loosens one
 * of them must fail here, loudly, with the rule's own name in the output.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  validateContract,
  type Claim,
  type EvidenceRef,
  type Memo,
  type ModelInferenceClaim,
} from '../src/contract.ts'

const evidence: EvidenceRef = {
  id: 'E1',
  documentId: 'D1',
  quote: '计提存货跌价准备 879.50 万元',
  charStart: 0,
  charEnd: 16,
  sourceLabel: '测试科技 2026 半年度减值公告',
  retrievedAt: '2026-08-14T00:00:00.000Z',
}

function memoWith(claims: Claim[], extra: Partial<Memo> = {}): Memo {
  return {
    schemaVersion: 'meridian-memo-v1',
    generatedAt: '2026-08-14T00:00:00.000Z',
    lang: 'zh-CN',
    question: '本期计提了多少减值准备?',
    entity: { name: '测试科技' },
    narrative: [],
    sections: [{ questionId: 'Q1', heading: '减值计提', claimIds: claims.map((claim) => claim.id) }],
    claims,
    evidence: [evidence],
    derived: [],
    sources: [
      {
        documentId: 'D1',
        sigil: 'S-A',
        title: '减值公告',
        provider: 'fixture',
        retrievedAt: '2026-08-14T00:00:00.000Z',
        contentSha256: 'x'.repeat(64),
      },
    ],
    openQuestions: [],
    audit: [],
    gate: { passed: true, contractViolations: [], complianceHits: [], numberViolations: [] },
    provenance: {
      pipeline: 'test',
      model: 'test',
      dataSource: 'fixture',
      retrieval: 'direct',
    },
    ...extra,
  }
}

const fact: Claim = {
  id: 'C-A',
  type: 'fact',
  text: '公司本期计提存货跌价准备 879.50 万元。',
  questionId: 'Q1',
  evidenceIds: ['E1'],
  numbers: [{ display: '879.50 万元', provenance: 'verbatim', evidenceId: 'E1' }],
}

const inference: ModelInferenceClaim = {
  id: 'C-B',
  type: 'model_inference',
  text: '存货减值集中在单一产品线的可能性较高。',
  questionId: 'Q1',
  evidenceIds: ['E1'],
  numbers: [],
  timeRange: '2026H1',
  assumptions: ['公告未披露分产品线明细'],
  confidence: 'low',
  counterEvidence: { status: 'filled', evidenceIds: ['E1'], note: '' },
}

test('a well-formed memo has no violations', () => {
  assert.deepEqual(validateContract(memoWith([fact, inference])), [])
})

test('an inference with an unfilled counter-evidence slot cannot publish', () => {
  const violations = validateContract(
    memoWith([{ ...inference, counterEvidence: { status: 'not_found', evidenceIds: [], note: 'searched' } }]),
  )
  assert.equal(violations.length, 1)
  assert.equal(violations[0]?.code, 'inference_without_counter_evidence')
})

test('an inference must carry a time range, an assumption, and evidence', () => {
  const codes = validateContract(
    memoWith([{ ...inference, timeRange: '  ', assumptions: [], evidenceIds: [] }]),
  ).map((violation) => violation.code)
  assert.ok(codes.includes('inference_without_time_range'))
  assert.ok(codes.includes('inference_without_assumptions'))
  assert.ok(codes.includes('inference_without_evidence'))
})

test('a fact without evidence is rejected unless it declares itself unverifiable', () => {
  const silent = validateContract(memoWith([{ ...fact, evidenceIds: [], numbers: [] }]))
  assert.equal(silent[0]?.code, 'fact_without_evidence')

  // The no-answer discipline: allowed to cite nothing, required to say so.
  const stated = validateContract(
    memoWith([
      {
        id: 'C-A',
        type: 'fact',
        text: '公告未披露重整投资人身份,无法核实。',
        questionId: 'Q1',
        evidenceIds: [],
        numbers: [],
        unverifiable: true,
      },
    ]),
  )
  assert.deepEqual(stated, [])

  const pretending = validateContract(
    memoWith([
      {
        id: 'C-A',
        type: 'fact',
        text: '重整投资人为某产业基金。',
        questionId: 'Q1',
        evidenceIds: [],
        numbers: [],
        unverifiable: true,
      },
    ]),
  )
  assert.equal(pretending[0]?.code, 'silent_gap')
})

test('numbers must resolve to evidence or to a registered derivation', () => {
  const violations = validateContract(
    memoWith([{ ...fact, numbers: [{ display: '879.50 万元', provenance: 'derived', derivedId: 'D9' }] }]),
  )
  assert.equal(violations[0]?.code, 'unbound_number')
})

test('opinions need a named speaker and scenarios need a trigger', () => {
  const codes = validateContract(
    memoWith([
      { id: 'C-C', type: 'attributed_opinion', text: '审计师提示持续经营存在不确定性。', questionId: 'Q1', evidenceIds: ['E1'], numbers: [], attribution: '  ' },
      { id: 'C-D', type: 'scenario', text: '若法院裁定受理,公司将进入重整程序。', questionId: 'Q1', evidenceIds: ['E1'], numbers: [], triggers: [] },
    ]),
  ).map((violation) => violation.code)
  assert.deepEqual(codes, ['unattributed_opinion', 'scenario_without_trigger'])
})

test('citations must resolve: dangling evidence and orphan sections are violations', () => {
  const codes = validateContract(
    memoWith([{ ...fact, evidenceIds: ['E404'] }], {
      sections: [{ questionId: 'Q1', heading: '减值计提', claimIds: ['C-A', 'C-ZZ'] }],
    }),
  ).map((violation) => violation.code)
  assert.ok(codes.includes('dangling_evidence'))
  assert.ok(codes.includes('dangling_section_claim'))
})

test('an exhibit must resolve and only an unverifiable fact may carry it', () => {
  const dangling = validateContract(
    memoWith([
      {
        id: 'U-A',
        type: 'fact',
        text: '公告未披露相应信息,无法核实。',
        questionId: 'Q1',
        evidenceIds: [],
        exhibitEvidenceId: 'E404',
        numbers: [],
        unverifiable: true,
      },
    ]),
  )
  assert.ok(dangling.some((violation) => violation.code === 'dangling_exhibit_evidence'))

  const misplaced = validateContract(
    memoWith([{ ...fact, exhibitEvidenceId: 'E1' }]),
  )
  assert.ok(misplaced.some((violation) => violation.code === 'exhibit_on_verifiable_claim'))
})

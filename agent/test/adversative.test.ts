/** WP-M18-ADV: deterministic adversative sibling-sentence recovery. */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { MeridianLang } from '../src/contract.ts'
import type { CompletionRequest, CompletionResult, ModelClient } from '../src/model.ts'
import { adversativeSweepPrompt, PROMPT_SET_VERSION } from '../src/prompts.ts'
import type { SourceDocument } from '../src/source/types.ts'
import { extractAndVerify } from '../src/steps/extract.ts'
import type { Intent } from '../src/types.ts'
import { ADVERSATIVE_RE } from '../src/verify/adversative.ts'
import { foldScript } from '../src/verify/script.ts'

const makeIntent = (questions: { id: string; text: string }[], lang: MeridianLang = 'zh-CN'): Intent => ({
  entity: { name: '测试公司' },
  questionType: 'fact_extraction',
  seeksAdvice: false,
  lang,
  subQuestions: questions,
})

class SweepModel implements ModelClient {
  readonly id = 'adversative-script'
  readonly requests: { step: string; user: string }[] = []
  readonly #extraction: string
  readonly #sweeps: Record<string, string>

  constructor(extraction: string, sweeps: Record<string, string> = {}) {
    this.#extraction = extraction
    this.#sweeps = sweeps
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const system = request.system ?? ''
    if (system.includes('ADVERSATIVE SWEEP')) {
      const questionId = request.user.match(/question_id: ([^\n]+)/)?.[1]?.trim() ?? ''
      this.requests.push({ step: `sweep:${questionId}`, user: request.user })
      return { text: this.#sweeps[questionId] ?? '{"claims":[]}' }
    }
    if (system.includes('RESIDUAL REVIEW')) {
      this.requests.push({ step: 'residual', user: request.user })
      const ids = [...request.user.matchAll(/question_id: ([^\n]+)/g)].map((match) => match[1]?.trim())
      return {
        text: JSON.stringify({
          results: ids.filter(Boolean).map((questionId) => ({ question_id: questionId, verdict: 'settled', missing: '' })),
        }),
      }
    }
    this.requests.push({ step: 'extract', user: request.user })
    return { text: this.#extraction }
  }
}

test('an uncited middle disagreement sentence is swept, verified and kept verbatim', async () => {
  const opening = '公司已向相关股东发函征询控制权意见。'
  const missed = '湖南派勒上层股东明确反馈不认可重整阶段认定湖南派勒为上市公司实际控制人。'
  const closing = '公司将持续关注后续回函情况。'
  const documents: SourceDocument[] = [
    { id: 'D1', title: '提示性公告', text: `${opening}${missed}${closing}`, provider: 'test' },
  ]
  const model = new SweepModel(
    JSON.stringify({
      claims: [{ question_id: 'Q1', type: 'fact', text: opening, quotes: [{ document_id: 'D1', quote: opening }] }],
      gaps: [],
    }),
    {
      Q1: JSON.stringify({
        claims: [
          {
            question_id: 'Q1',
            type: 'fact',
            text: '湖南派勒上层股东明确不认可相关实际控制人认定。',
            quotes: [{ document_id: 'D1', quote: missed }],
          },
        ],
      }),
    },
  )

  const result = await extractAndVerify(
    makeIntent([{ id: 'Q1', text: '相关股东是否都认可控制权认定?' }]),
    documents,
    model,
    'zh-CN',
  )

  assert.equal(model.requests.filter((request) => request.step === 'sweep:Q1').length, 1)
  assert.equal(result.claims.length, 2)
  const swept = result.claims.find((claim) => claim.text.includes('上层股东'))
  assert.ok(swept)
  assert.equal(result.evidence.find((item) => swept.evidenceIds.includes(item.id))?.quote, missed)
  assert.ok(result.notes?.includes('adversative_sweep_attempted: Q1'))
  assert.ok(result.notes?.includes('adversative_sweep_adopted: Q1 claims=1'))
})

test('the v1 vocabulary remains narrow and does not admit boilerplate or bare turns', async () => {
  assert.equal(ADVERSATIVE_RE.test(foldScript('公司不存在应披露而未披露的事项。')), false)
  assert.equal(ADVERSATIVE_RE.test(foldScript('但公司将继续关注后续进展。')), false)
  assert.equal(ADVERSATIVE_RE.test(foldScript('然而相关事项仍在推进中。')), false)

  const opening = '公司已完成相关情况核查。'
  const boilerplate = '公司不存在应披露而未披露的重大事项。'
  const documents: SourceDocument[] = [
    { id: 'D1', title: '公告', text: `${opening}${boilerplate}`, provider: 'test' },
  ]
  const model = new SweepModel(
    JSON.stringify({
      claims: [{ question_id: 'Q1', type: 'fact', text: opening, quotes: [{ document_id: 'D1', quote: opening }] }],
    }),
  )

  await extractAndVerify(makeIntent([{ id: 'Q1', text: '核查结果如何?' }]), documents, model, 'zh-CN')
  assert.equal(model.requests.some((request) => request.step.startsWith('sweep:')), false)
})

test('an adversative sentence in an uncited paragraph stays outside the sweep guardrail', async () => {
  const cited = '公司已完成相关情况核查。'
  const uncited = '其他股东对该事项明确表示不同意。'
  const documents: SourceDocument[] = [
    { id: 'D1', title: '公告', text: `${cited}\n\n${uncited}`, provider: 'test' },
  ]
  const model = new SweepModel(
    JSON.stringify({
      claims: [{ question_id: 'Q1', type: 'fact', text: cited, quotes: [{ document_id: 'D1', quote: cited }] }],
    }),
  )

  await extractAndVerify(makeIntent([{ id: 'Q1', text: '核查结果如何?' }]), documents, model, 'zh-CN')
  assert.equal(model.requests.some((request) => request.step.startsWith('sweep:')), false)
})

test('an empty sweep changes no claims but leaves attempted and zero-adoption notes', async () => {
  const cited = '公司已就该事项发函征询。'
  const missed = '相关方明确表示对该项安排不同意。'
  const documents: SourceDocument[] = [
    { id: 'D1', title: '公告', text: `${cited}${missed}`, provider: 'test' },
  ]
  const model = new SweepModel(
    JSON.stringify({
      claims: [{ question_id: 'Q1', type: 'fact', text: cited, quotes: [{ document_id: 'D1', quote: cited }] }],
    }),
    { Q1: '{"claims":[]}' },
  )

  const result = await extractAndVerify(
    makeIntent([{ id: 'Q1', text: '相关方是否认可该事项?' }]),
    documents,
    model,
    'zh-CN',
  )
  assert.equal(result.claims.length, 1)
  assert.ok(result.notes?.includes('adversative_sweep_attempted: Q1'))
  assert.ok(result.notes?.includes('adversative_sweep_adopted: Q1 claims=0'))
})

test('more than three matching questions calls only the first three on equal hit counts', async () => {
  const questions = Array.from({ length: 5 }, (_, index) => ({
    id: `Q${index + 1}`,
    text: `事项${String.fromCharCode(65 + index)}的征询情况如何?`,
  }))
  const paragraphs = questions.map((question, index) => {
    const marker = String.fromCharCode(65 + index)
    return {
      cited: `公司已就事项${marker}发函征询。`,
      missed: `相关方对事项${marker}明确表示不同意。`,
    }
  })
  const document: SourceDocument = {
    id: 'D1',
    title: '公告',
    text: paragraphs.map((paragraph) => `${paragraph.cited}${paragraph.missed}`).join('\n\n'),
    provider: 'test',
  }
  const model = new SweepModel(
    JSON.stringify({
      claims: paragraphs.map((paragraph, index) => ({
        question_id: `Q${index + 1}`,
        type: 'fact',
        text: paragraph.cited,
        quotes: [{ document_id: 'D1', quote: paragraph.cited }],
      })),
    }),
  )

  const result = await extractAndVerify(makeIntent(questions), [document], model, 'zh-CN')
  assert.deepEqual(
    model.requests.filter((request) => request.step.startsWith('sweep:')).map((request) => request.step),
    ['sweep:Q1', 'sweep:Q2', 'sweep:Q3'],
  )
  assert.equal(result.notes?.some((note) => note.includes('adversative_sweep_attempted: Q4')), false)
  assert.equal(result.notes?.some((note) => note.includes('adversative_sweep_attempted: Q5')), false)
})

test('the sweep prompt exposes at most four source sentences and carries the empty-result brake', () => {
  const prompt = adversativeSweepPrompt(
    {
      questionId: 'Q1',
      question: '征询情况如何?',
      candidates: Array.from({ length: 4 }, (_, index) => ({
        documentId: 'D1',
        text: `候选句${index + 1}明确表示不同意。`,
        matched: index === 0,
      })),
    },
    'zh-TW',
  )

  assert.equal(PROMPT_SET_VERSION, 'meridian-prompts-v0.5')
  assert.match(prompt.system, /If these sentences state no new fact relevant to the question/)
  assert.match(prompt.system, /copied character-for-character/)
  assert.match(prompt.system, /Write every human-readable field.*繁體中文/s)
  assert.equal((prompt.user.match(/document_id:/g) ?? []).length, 4)
})

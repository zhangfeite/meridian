/**
 * Retrieval through an agent loop.
 *
 * The pipeline reaches an agent loop only through `@meridian/kernel-adapter`'s
 * `AgentKernel`; `MockKernel` and `DshKernel` are interchangeable behind it, so
 * a test that passes here is a statement about the seam, not about the mock.
 * (`DshKernel` needs Node ≥22 and a live DeepSeek key, which is why the
 * deterministic kernel is the one in the test suite.)
 */

import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { MockKernel, type MockScript } from '../../adapter/src/mock-kernel.ts'
import { createCollector, dataSourceTools } from '../src/kernel-tools.ts'
import { ScriptedModel } from '../src/model.ts'
import { runPipeline } from '../src/pipeline.ts'
import { SkillRegistry } from '../src/skills/registry.ts'
import { FixtureSource } from '../src/source/fixture.ts'
import { retrieveViaKernel } from '../src/steps/retrieve.ts'
import type { Intent, ResearchPlan } from '../src/types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, 'fixtures', 'impairment-announcement.txt')
const DOC_ID = 'impairment-announcement.txt'

const intent: Intent = {
  entity: { name: '测试科技', symbol: '900001' },
  lang: 'zh-CN',
  questionType: 'metric_calc',
  subQuestions: [{ id: 'Q1', text: '本期计提了多少减值准备?' }],
  seeksAdvice: false,
}

const plan: ResearchPlan = {
  documents: [{ documentId: DOC_ID, why: '减值公告' }],
  questionPlan: [{ questionId: 'Q1', documentIds: [DOC_ID], approach: '读原文' }],
  notes: [],
}

/** A stub agent that lists first, then fetches what it found. */
const listThenFetch: MockScript = ({ tools }) => {
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['list_documents', 'get_document'],
  )
  return [
    { kind: 'call', tool: 'list_documents', args: { symbol: '900001' } },
    { kind: 'call', tool: 'get_document', args: { document_id: DOC_ID } },
    { kind: 'summarize' },
  ]
}

test('an agent loop retrieves through the DataSource tools', async () => {
  const kernel = new MockKernel({ script: listThenFetch })
  const result = await retrieveViaKernel(plan, intent, FixtureSource.fromFiles([FIXTURE]), kernel)
  await kernel.close()

  assert.equal(result.mode, 'kernel')
  assert.equal(result.kernelId, 'mock')
  assert.equal(result.documents.length, 1)
  assert.ok(result.documents[0]?.text.includes('存货跌价准备'))
  assert.deepEqual(result.failures, [])
})

test('tools unregister after the run, so a second run can register them again', async () => {
  const kernel = new MockKernel({ script: listThenFetch })
  const source = FixtureSource.fromFiles([FIXTURE])
  await retrieveViaKernel(plan, intent, source, kernel)
  // Re-registering a live tool name throws in kernel-adapter; a second run
  // proves the first one cleaned up after itself.
  await retrieveViaKernel(plan, intent, source, kernel)
  await kernel.close()
})

test('a document the agent skipped is still fetched, and a bad id becomes a failure', async () => {
  const idleAgent: MockScript = () => [{ kind: 'say', text: '[mock] fetched nothing' }]
  const kernel = new MockKernel({ script: idleAgent })
  const result = await retrieveViaKernel(
    { ...plan, documents: [{ documentId: DOC_ID, why: '' }, { documentId: 'missing.txt', why: '' }] },
    intent,
    FixtureSource.fromFiles([FIXTURE]),
    kernel,
  )
  await kernel.close()

  assert.equal(result.documents.length, 1, 'the planned document is fetched even when the loop ignores it')
  assert.equal(result.failures[0]?.documentId, 'missing.txt')
  assert.equal(result.failures[0]?.code, 'not_found')
})

test('a retrieval error is returned to the agent as data, not thrown', async () => {
  const collector = createCollector()
  const [, getDocument] = dataSourceTools(FixtureSource.fromFiles([FIXTURE]), collector)
  const result = (await getDocument!.execute(
    { document_id: 'nope.txt' },
    { signal: AbortSignal.abort(), runId: 'r', callId: 'c' },
  )) as { error?: string }
  assert.equal(result.error, 'not_found')
  assert.equal(collector.failures.length, 1)
})

test('the whole pipeline can run its retrieval step through a kernel', async () => {
  const kernel = new MockKernel({ script: listThenFetch })
  const model = new ScriptedModel([
    JSON.stringify({
      entity: { name: '测试科技' },
      question_type: 'metric_calc',
      seeks_advice: false,
      sub_questions: [{ id: 'Q1', text: '本期合计计提了多少减值准备?' }],
    }),
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
      ],
      gaps: [],
    }),
    JSON.stringify({ derivations: [], claims: [] }),
  ])

  const result = await runPipeline({
    // No recipe: these tests pin pipeline behaviour, not the official skills.
    skills: new SkillRegistry([]),
    question: '本期合计计提了多少减值准备?',
    source: FixtureSource.fromFiles([FIXTURE]),
    model,
    kernel,
    lang: 'zh-CN',
  })
  await kernel.close()

  assert.equal(result.memo.provenance.retrieval, 'kernel')
  assert.equal(result.memo.provenance.kernel, 'mock')
  assert.ok(result.markdown.includes('1,000.00 万元'))
  assert.ok(result.memo.gate.passed)
})

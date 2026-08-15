/**
 * The publication gate's whole-document sweep.
 *
 * Per-claim binding cannot see numbers the rendering introduces — a section
 * heading is a model-written sub-question, a source title is a filing's own
 * first line. This is the check that no number enters the memo through a seam
 * that no claim owns.
 */

import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { ANCHOR_EXACT_RE } from '../src/ids.ts'
import { ScriptedModel } from '../src/model.ts'
import { runPipeline } from '../src/pipeline.ts'
import { SkillRegistry } from '../src/skills/registry.ts'
import { FixtureSource } from '../src/source/fixture.ts'
import { maskNonContent } from '../src/verify/text.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, 'fixtures', 'impairment-announcement.txt')
const DOC_ID = 'impairment-announcement.txt'

/** Every reply the pipeline needs, with the sub-question text under test. */
const replies = (subQuestion: string): string[] => [
  JSON.stringify({
    entity: { name: '测试科技' },
    question_type: 'metric_calc',
    seeks_advice: false,
    sub_questions: [{ id: 'Q1', text: subQuestion }],
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
]

test('published anchors carry no digits, so no reader mistakes one for a figure', async () => {
  const result = await runPipeline({
    // No recipe: these tests pin pipeline behaviour, not the official skills.
    skills: new SkillRegistry([]),
    question: '本期合计计提了多少减值准备?',
    source: FixtureSource.fromFiles([FIXTURE]),
    model: new ScriptedModel(replies('公司计提的减值准备由哪些科目构成?')),
    lang: 'zh-CN',
  })
  const anchors = result.markdown.match(/\[[^\]]+\]/g) ?? []
  assert.ok(anchors.length > 0, 'the memo cross-references its own claims')
  for (const anchor of anchors) {
    assert.match(anchor, ANCHOR_EXACT_RE, `anchor ${anchor} must be digit-free`)
  }
  // The regression this guards: `[C10]` was extracted as the number 10 and
  // scored as a fabricated figure by every numeric extractor downstream.
  assert.ok(result.memo.claims.every((claim) => /^[A-Z]-[A-Z]+$/.test(claim.id)))
})

test('the source legend defines each sigil once, with the path a reviewer opens', async () => {
  const source = FixtureSource.fromBenchTasks(join(HERE, '..', '..', 'bench', 'tasks'), ['MB-001'])
  const model = new ScriptedModel([
    JSON.stringify({
      entity: { name: '龙元建设' },
      question_type: 'fact_extraction',
      seeks_advice: false,
      sub_questions: [{ id: 'Q1', text: '申请人是谁?' }],
    }),
    JSON.stringify({
      documents: [{ document_id: 'MB-001/context/announcement.txt', why: '公告' }],
      question_plan: [{ question_id: 'Q1', document_ids: ['MB-001/context/announcement.txt'], approach: '读' }],
      notes: [],
    }),
    JSON.stringify({
      claims: [
        {
          question_id: 'Q1',
          type: 'fact',
          text: '申请人是上海振堃建材贸易有限公司。',
          quotes: [
            { document_id: 'MB-001/context/announcement.txt', quote: '公司债权人上海振堃建材贸易有限公司' },
          ],
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
    question: '申请人是谁?',
    source,
    model,
    lang: 'zh-CN',
    documentIds: ['MB-001/context/announcement.txt'],
  })

  const legend = result.markdown.split('\n').find((line) => line.includes('[S-A]'))
  assert.ok(legend, 'the sources list defines the sigil')
  assert.ok(legend.includes('context/announcement.txt'), `legend should name the file: ${legend}`)
  // The task id never reaches the page — its digits would read as figures.
  assert.ok(!result.markdown.includes('MB-001/'))
  assert.ok(result.memo.gate.passed)
})

test('the sweep ignores addressing, not assertions', () => {
  // Both regressions this guards were found in live runs: `[C-J]` read as the
  // letter-free number 10, and a cninfo permalink's announcementId read as a
  // financial figure.
  const masked = maskNonContent(
    '公司计提减值 1,000.00 万元。[C-J] 来源 http://www.cninfo.com.cn/detail?announcementId=1225472188&stockCode=600491',
  )
  assert.ok(masked.includes('1,000.00 万元'), 'content survives')
  assert.ok(!masked.includes('1225472188'), 'URL query strings are not assertions')
  assert.ok(!masked.includes('[C-J]'), 'anchors are cross-references')

  // A file path is where a document lives, not a figure. Found by a real CLI
  // run: `…/MB-001/announcement.txt` in the source legend made the sweep read
  // `-001` as an unsourced negative number and refuse the entire memo. The bench
  // legend reads `context/announcement.txt` — no digits — so only a real path
  // exposed it.
  const withPath = maskNonContent(
    '- [S-A] 2026-filings/MB-001/announcement.txt — 重整公告(fixture)\n公司计提减值 1,000.00 万元。[C-A]',
  )
  assert.ok(!/MB-001|2026-filings|\.txt/.test(withPath), `path should be masked: ${withPath}`)
  assert.ok(withPath.includes('1,000.00 万元'), 'the figure beside it survives')
  assert.ok(withPath.includes('重整公告'), 'the title survives')

  // The pattern stops at CJK: a filename inside a Chinese sentence loses the
  // filename, not the sentence.
  const inline = maskNonContent('详见announcement.txt的说明,计提 1,000.00 万元。')
  assert.ok(inline.includes('详见'), inline)
  assert.ok(inline.includes('的说明'), inline)
  assert.ok(!inline.includes('.txt'), inline)
})

test('a heading whose figure is in the filing passes the sweep', async () => {
  const result = await runPipeline({
    // No recipe: these tests pin pipeline behaviour, not the official skills.
    skills: new SkillRegistry([]),
    question: '本期合计计提了多少减值准备?',
    source: FixtureSource.fromFiles([FIXTURE]),
    model: new ScriptedModel(replies('公司计提的 1,000.00 万元减值准备由哪些科目构成?')),
    lang: 'zh-CN',
  })
  assert.deepEqual(result.memo.gate.numberViolations, [])
  assert.ok(result.memo.gate.passed)
})

test('a figure smuggled in through a section heading fails the gate', async () => {
  const result = await runPipeline({
    // No recipe: these tests pin pipeline behaviour, not the official skills.
    skills: new SkillRegistry([]),
    question: '本期合计计提了多少减值准备?',
    source: FixtureSource.fromFiles([FIXTURE]),
    // No claim owns this sentence, so only the whole-document sweep can catch it.
    model: new ScriptedModel(replies('公司计提的 4,321.00 万元减值准备由哪些科目构成?')),
    lang: 'zh-CN',
  })
  assert.equal(result.memo.gate.passed, false)
  assert.ok(
    result.memo.gate.numberViolations.some((violation) => violation.display.includes('4,321.00')),
    JSON.stringify(result.memo.gate.numberViolations),
  )
})

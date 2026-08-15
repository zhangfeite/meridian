/**
 * Reading a document that does not fit in one prompt.
 *
 * Two failure modes, both observed on real runs, both of which look like the
 * pipeline being careful and are in fact the pipeline being wrong:
 *
 * - A reply cut off at the output ceiling took the entire task down with
 *   `model reply was not JSON` (MB-018 en, MB-015 zh-TW). Everything the model
 *   had already quoted and verified went with it.
 * - A document truncated to fit had the model report page eighty's figures as
 *   undisclosed — a fabricated absence, published as a verified gap.
 *
 * So: salvage what a truncated reply did say, read a long document in windows,
 * and disclose both. A partial read is publishable. A partial read presented as
 * a complete one is not.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { ScriptedModel, readJsonReply, type CompletionRequest, type CompletionResult, type ModelClient } from '../src/model.ts'
import { extractAndVerify } from '../src/steps/extract.ts'
import type { SourceDocument } from '../src/source/types.ts'
import type { Intent } from '../src/types.ts'
import { splitPassages } from '../src/verify/text.ts'
import { WINDOW_CHARS, boundDocuments, selectWindows, windowDocument } from '../src/verify/window.ts'

const NEEDLE = '公司 2025 年度归属于母公司股东的净利润为 12,345.67 万元，同比下降 48.14%。'

/** A filing long enough to need windowing, with the answer buried near the end. */
function longFiling(): string {
  const filler = '本节内容为一般性说明，不含具体财务数据，仅作章节过渡之用。'.repeat(60)
  const sections: string[] = ['重大事项提示：本次发行的相关风险详见募集说明书全文。']
  for (let index = 0; index < 24; index += 1) sections.push(`第 ${index + 1} 节 ${filler}`)
  sections.push(`财务会计信息：${NEEDLE}`)
  return sections.join('\n')
}

const document = (text: string): SourceDocument => ({
  id: 'prospectus.txt',
  title: '可转债募集说明书摘要',
  text,
  provider: 'test',
})

const intent = (questions: string[]): Intent => ({
  entity: { name: '测试公司' },
  questionType: 'metric_calc',
  seeksAdvice: false,
  lang: 'zh-CN',
  subQuestions: questions.map((text, index) => ({ id: `Q${index + 1}`, text })),
})

test('a document that fits is read in one pass, unchanged', () => {
  const windows = windowDocument('短公告。')
  assert.equal(windows.length, 1)
  assert.equal(windows[0]?.text, '短公告。')
  assert.equal(windows[0]?.total, 1)
})

test('windows tile the whole document and never split a sentence', () => {
  const text = longFiling()
  const windows = windowDocument(text, 4_000)
  assert.ok(windows.length > 3, 'this filing needs several windows')
  for (const window of windows) {
    assert.ok(window.text.length <= 4_000 + 600, 'a window may exceed its size only by its overlap')
  }
  // Every sentence appears whole in some window. Windows are built by appending
  // whole passages, never by cutting at a character offset — a quote copied out
  // of a window has to be verifiable against the document it came from, and half
  // a sentence never is.
  for (const passage of splitPassages(text)) {
    if (passage.text.length > 4_000) continue // a table, split below
    assert.ok(
      windows.some((window) => window.text.includes(passage.text)),
      `sentence lost at a window boundary: ${passage.text.slice(0, 24)}`,
    )
  }
  // And the whole document is covered, not just sampled.
  assert.equal(
    windows.reduce((sum, window) => sum + window.text.length, 0) >= text.length,
    true,
    'windows must tile the document, overlap included',
  )
})

test('window selection keeps the front matter and the relevant chapter', () => {
  const windows = windowDocument(longFiling(), 2_000)
  const kept = selectWindows(windows, ['归属于母公司股东的净利润同比下降多少'], 3)
  assert.equal(kept.length, 3)
  assert.equal(kept[0]?.index, 1, '「重大事项提示」 lives in the first window and is never dropped')
  assert.ok(
    kept.some((window) => window.text.includes(NEEDLE)),
    'the chapter that answers the question must be selected',
  )
  // Document order, so the model reads the filing forwards.
  assert.deepEqual([...kept].sort((a, b) => a.index - b.index), kept)
})

test('bounding a document set marks the excerpt as an excerpt', () => {
  const bounded = boundDocuments([document(longFiling())], ['净利润'], WINDOW_CHARS)
  assert.ok(bounded[0]!.text.length < longFiling().length)
  // Without this label a model reports everything it cannot see as undisclosed,
  // which is the exact failure the windowing exists to prevent.
  assert.match(bounded[0]!.title, /节选/)
  assert.match(bounded[0]!.title, /不等于文件未披露/)
})

test('a truncated reply keeps its complete claims instead of failing the task', () => {
  const truncated =
    '{"claims": [' +
    '{"question_id":"Q1","type":"fact","text":"甲","quotes":[{"document_id":"d","quote":"甲"}]},' +
    '{"question_id":"Q1","type":"fact","text":"乙","quotes":[{"document_id":"d","quote":"乙"}]},' +
    '{"question_id":"Q1","type":"fact","text":"丙","quotes":[{"document_id":"d","quo'
  const outcome = readJsonReply<{ claims: { text: string }[] }>(truncated)
  assert.equal(outcome.salvaged, true)
  assert.deepEqual(outcome.value?.claims.map((claim) => claim.text), ['甲', '乙'])
  // The half-written third claim is dropped rather than half-kept: a claim
  // missing its quotes would be rejected downstream anyway, and keeping the
  // fragment would put an unverifiable sentence in front of the verifier.
})

test('a reply with nothing whole in it is reported, not salvaged', () => {
  assert.equal(readJsonReply('{"claims": [{"text":"甲').value, undefined)
  assert.equal(readJsonReply('抱歉，我无法回答').value, undefined)
})

test('an unparseable extraction reply costs that pass, not the run', async () => {
  // Before this, `parseJsonReply` threw straight out of step 4, through the
  // pipeline, and out of the CLI as exit 2 — a whole task lost to one bad reply.
  const filing = document(`公司计提各项减值准备共计 8,815.45 万元。${NEEDLE}`)
  const model = new ScriptedModel(['I am sorry, I cannot produce that.'])

  const result = await extractAndVerify(intent(['本期计提了多少减值准备?']), [filing], model, 'zh-CN')

  assert.deepEqual(result.claims, [])
  assert.ok((result.notes ?? []).some((note) => /无法解析/.test(note)), 'and the reader is told')
})

test('a failing model call is disclosed rather than thrown', async () => {
  const filing = document('公司计提各项减值准备共计 8,815.45 万元。')
  const failing: ModelClient = {
    id: 'failing',
    async complete(): Promise<CompletionResult> {
      throw new Error('upstream 503')
    },
  }

  const result = await extractAndVerify(intent(['本期计提了多少减值准备?']), [filing], failing, 'zh-CN')
  assert.deepEqual(result.claims, [])
  assert.ok((result.notes ?? []).some((note) => /503/.test(note)))
})

test('a long document is read window by window, and a late figure survives', async () => {
  // The MB-018 shape: the answer is in the last chapter of a document far too
  // long for one prompt. One call per window is what makes it reachable.
  const filing = document(longFiling())
  const seen: string[] = []
  const model: ModelClient = {
    id: 'windowed',
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      seen.push(request.user)
      const carriesNeedle = request.user.includes(NEEDLE)
      return {
        text: JSON.stringify({
          claims: carriesNeedle
            ? [
                {
                  question_id: 'Q1',
                  type: 'fact',
                  text: '公司 2025 年度归属于母公司股东的净利润为 12,345.67 万元。',
                  quotes: [
                    {
                      document_id: 'prospectus.txt',
                      quote: '公司 2025 年度归属于母公司股东的净利润为 12,345.67 万元',
                    },
                  ],
                },
              ]
            : [],
          gaps: [],
        }),
      }
    },
  }

  const result = await extractAndVerify(
    intent(['2025 年归母净利润是多少?']),
    [filing],
    model,
    'zh-CN',
  )

  assert.ok(seen.length > 1, 'a document this long must take more than one pass')
  assert.equal(result.claims.length, 1, 'the figure in the last chapter is extracted')
  assert.ok(result.claims[0]?.text.includes('12,345.67'))
  // Verification still runs against the whole document, not the window.
  assert.equal(result.evidence[0]?.documentId, 'prospectus.txt')
  assert.deepEqual(result.gaps, [], 'a question answered in any window is not a gap')
})

test('a windowed read never reports a gap from a single window', async () => {
  const filing = document(longFiling())
  // This model answers nothing, anywhere. The gap must come from the whole
  // reading, phrased as such — not from whichever window happened to be last.
  const silent = new ScriptedModel([JSON.stringify({ claims: [], gaps: [] })])
  const result = await extractAndVerify(intent(['本次发行的承销商是谁?']), [filing], silent, 'zh-CN')

  assert.equal(result.gaps.length, 1)
  assert.equal(result.gaps[0]?.questionId, 'Q1')
  assert.match(result.gaps[0]?.reason ?? '', /分段通读全文/)
})

test('a table with no sentence breaks is still cut to size', () => {
  // 220k characters of table rows separated by nothing a sentence splitter
  // recognizes. Appending such a "passage" whole doubles the window, and an
  // oversized window is what truncates the reply it asks for.
  const table = '项目 2025年 2024年 金额 1,234.56 2,345.67 '.repeat(2_000)
  const windows = windowDocument(table, 4_000)
  assert.ok(windows.length > 10)
  for (const window of windows) {
    assert.ok(window.text.length <= 4_000 + 600, `oversized window: ${window.text.length}`)
  }
  assert.equal(windows[0]?.total, windows.length)
})

test('the bench adapter cannot exit before its memo has left the pipe', () => {
  // A 220k-character prospectus produces an 80KB memo, and `process.exit()`
  // discards whatever stdout still has queued — for a pipe, everything past the
  // 64KB buffer. The bench runner saw a UTF-8 decode error in the middle of a
  // character and scored the task zero, while the memo on disk was complete.
  // Latent for as long as memos stayed small; windowed reading made them large.
  const bin = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'meridian-memo.ts'),
    'utf8',
  )
  // Comments may discuss it; code may not call it.
  const code = bin
    .split('\n')
    .filter((line) => !/^\s*(?:\*|\/\/)/.test(line))
    .join('\n')
  assert.equal(
    /process\.exit\(/.test(code),
    false,
    'set process.exitCode instead: process.exit() drops buffered stdout',
  )
})

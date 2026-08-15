import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ModelError,
  OpenAICompatibleModel,
  ScriptedModel,
  renderMemoMarkdown,
  runPipeline,
  type Memo,
  type PipelineOptions,
  type PipelineResult,
} from '@meridian/agent'
import { createWebApp, type WebApp, type WebDependencies } from '../src/server.ts'
import { MAX_FILE_BYTES, loadUploadedFiles } from '../src/upload-source.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const model = new ScriptedModel(['{}'], 'mock-model')

function fixtureResult(options: PipelineOptions, gatePassed = true): PipelineResult {
  const text = '《通知书》仅表明法院已立案审查，截至公告披露日尚未受理。'
  const memo: Memo = {
    schemaVersion: 'meridian-memo-v1',
    generatedAt: '2026-08-15T08:00:00.000Z',
    lang: options.lang ?? 'zh-CN',
    question: options.question,
    entity: { name: '龙元建设' },
    narrative: [
      {
        kind: 'conclusion',
        heading: '结论',
        paragraphs: [{ text: '法院已立案审查，但尚未受理重整申请。[C-A]', claimIds: ['C-A'], polished: false }],
      },
      {
        kind: 'findings',
        heading: '关键发现',
        paragraphs: [
          { text: '公告明确区分立案审查与受理。[C-A]', claimIds: ['C-A'], polished: false, questionId: 'Q-A' },
        ],
      },
      {
        kind: 'risks',
        heading: '风险与反证',
        paragraphs: [{ text: '申请能否受理仍有重大不确定性。[C-A]', claimIds: ['C-A'], polished: false }],
      },
    ],
    sections: [{ questionId: 'Q-A', heading: '当前程序状态', claimIds: ['C-A'] }],
    claims: [
      {
        id: 'C-A',
        type: 'fact',
        questionId: 'Q-A',
        text: '法院已立案审查，但尚未受理重整申请。',
        evidenceIds: ['E-A'],
        numbers: [],
      },
    ],
    evidence: [
      {
        id: 'E-A',
        documentId: 'announcement.txt',
        quote: text,
        charStart: 4,
        charEnd: 4 + text.length,
        sourceLabel: 'announcement.txt',
        retrievedAt: '2026-08-15T08:00:00.000Z',
      },
    ],
    derived: [
      {
        id: 'D-A',
        label: '示例比率',
        op: 'ratio',
        inputs: [
          { value: '1', unit: 'CNY', display: '1 元', evidenceId: 'E-A' },
          { value: '2', unit: 'CNY', display: '2 元', evidenceId: 'E-A' },
        ],
        value: '0.5',
        display: '50%',
        unit: '%',
        formula: '1 / 2',
        tolerance: '0',
        uncertainty: '0',
        dependsOn: [],
        depth: 1,
      },
      {
        id: 'D-B',
        label: '完整链示例',
        op: 'product',
        inputs: [
          { value: '0.5', unit: '%', display: '50%', derivedId: 'D-A' },
          { value: '2', unit: 'count', display: '2', evidenceId: 'E-A' },
        ],
        value: '1',
        display: '1',
        unit: 'count',
        formula: '50% × 2',
        tolerance: '0',
        uncertainty: '0',
        dependsOn: ['D-A'],
        depth: 2,
      },
    ],
    sources: [
      {
        documentId: 'announcement.txt',
        sigil: 'S-A',
        locator: 'announcement.txt',
        title: '重整提示性公告',
        provider: 'web-upload',
        retrievedAt: '2026-08-15T08:00:00.000Z',
        contentSha256: 'fixture',
      },
    ],
    openQuestions: [],
    audit: gatePassed
      ? []
      : [{ step: 'compose', action: 'claim_dropped_compliance', detail: '检测到确定收益承诺', claimId: 'C-X' }],
    gate: gatePassed
      ? { passed: true, contractViolations: [], complianceHits: [], numberViolations: [] }
      : {
          passed: false,
          contractViolations: [{ code: 'fact_without_evidence', message: 'a fact must cite evidence' }],
          complianceHits: [{ rule: 'guaranteed_return', match: '稳赚' }],
          numberViolations: [{ display: '99%', reason: 'number is not registered' }],
        },
    provenance: {
      pipeline: 'fixture-pipeline',
      model: options.model.id,
      dataSource: options.source.id,
      retrieval: options.kernel ? 'kernel' : 'direct',
      ...(options.kernel ? { kernel: options.kernel.id } : {}),
    },
  }
  return { memo, markdown: '# fixture', trace: {} as PipelineResult['trace'] }
}

function app(dependencies: WebDependencies): WebApp {
  return createWebApp(dependencies)
}

async function inject(
  webApp: WebApp,
  path: string,
  init: { method?: string; headers?: HeadersInit; body?: BodyInit | null } = {},
): Promise<{ status: number; headers: Headers; text(): Promise<string> }> {
  const webRequest = new Request(`http://127.0.0.1${path}`, init)
  const bytes = Buffer.from(await webRequest.arrayBuffer())
  const headers: Record<string, string> = Object.fromEntries(webRequest.headers.entries())
  headers.host = '127.0.0.1'
  if (bytes.byteLength > 0) headers['content-length'] = String(bytes.byteLength)
  const incoming = Readable.from(bytes.byteLength > 0 ? [bytes] : []) as unknown as IncomingMessage
  incoming.method = webRequest.method
  incoming.url = path
  incoming.headers = headers

  let status = 200
  let body = ''
  const responseHeaders = new Headers()
  const responseState = { headersSent: false, writableEnded: false }
  const outgoing = {
    get headersSent() {
      return responseState.headersSent
    },
    get writableEnded() {
      return responseState.writableEnded
    },
    setHeader(name: string, value: string | number | readonly string[]) {
      responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : String(value))
      return this
    },
    writeHead(code: number, values?: Record<string, string | number>) {
      status = code
      for (const [name, value] of Object.entries(values ?? {})) responseHeaders.set(name, String(value))
      responseState.headersSent = true
      return this
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
      responseState.writableEnded = true
      return this
    },
  } as unknown as ServerResponse
  await webApp.handler(incoming, outgoing)
  return { status, headers: responseHeaders, text: async () => body }
}

function askForm(question = '法院是否已经受理？', filename = 'announcement.txt', contents?: string | Uint8Array): FormData {
  const form = new FormData()
  form.set('question', question)
  form.set('lang', 'zh-CN')
  const content =
    contents instanceof Uint8Array
      ? (contents.buffer.slice(contents.byteOffset, contents.byteOffset + contents.byteLength) as ArrayBuffer)
      : (contents ?? '前言\n《通知书》仅表明法院已立案审查，截至公告披露日尚未受理。')
  form.append(
    'files',
    new Blob([content], { type: 'text/plain' }),
    filename,
  )
  return form
}

test('GET / renders the complete upload contract and hardened headers', async () => {
  const webApp = app({ model, pipeline: async (options) => fixtureResult(options) })
  const response = await inject(webApp, '/')
  const html = await response.text()
  assert.equal(response.status, 200)
  assert.match(html, /action="\/ask"/)
  assert.match(html, /multiple required/)
  assert.match(html, /zh-CN/)
  assert.match(html, /zh-TW/)
  assert.match(html, /Analysis is not investment advice/)
  assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/)
  assert.match(response.headers.get('set-cookie') ?? '', /HttpOnly; SameSite=Strict/)
})

test('upload → ask renders narrative, expandable evidence, source anchor, and full derivation chain', async () => {
  let captured: PipelineOptions | undefined
  const mockKernel = { id: 'mock-kernel' } as PipelineOptions['kernel']
  const webApp = app({
    model,
    kernel: mockKernel,
    createId: () => 'memo-fixture',
    pipeline: async (options) => {
      captured = options
      const listed = await options.source.listDocuments({})
      assert.equal((await options.source.getDocument(listed[0]!.id)).text.includes('立案审查'), true)
      return fixtureResult(options)
    },
  })
  const response = await inject(webApp, '/ask', { method: 'POST', body: askForm() })
  const html = await response.text()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-location'), '/memo/memo-fixture')
  assert.equal(captured?.kernel, mockKernel)
  assert.match(html, /关键发现/)
  assert.match(html, /风险与反证/)
  assert.match(html, /<details class="citation">/)
  assert.match(html, /href="#evidence-location-E-A"/)
  assert.match(html, /完整链示例/)
  assert.match(html, /示例比率/)
  assert.match(html, /<mark>《通知书》仅表明法院已立案审查/)
})

test('a contradicted checklist item shows the same caution on the page as in the Markdown', async () => {
  // One memo, two renderings. The contradiction caution is the audit's only route
  // onto the page, so a reader on the web must not see a cleaner memo than a
  // reader of the file — same fixed sentence, same source of truth.
  const item = '公司自述与可核查事实是否区分'
  const webApp = app({
    model,
    createId: () => 'memo-caution',
    pipeline: async (options) => {
      const result = fixtureResult(options)
      const memo: Memo = {
        ...result.memo,
        checklist: [{ item, covered: true, verdict: 'contradicted', locator: '法院已立案审查', source: 'audit' }],
      }
      return { ...result, memo, markdown: renderMemoMarkdown(memo) }
    },
  })

  const html = await (await inject(webApp, '/ask', { method: 'POST', body: askForm() })).text()
  assert.match(html, /audit-caution/)
  assert.match(html, /复核提示/)
  assert.ok(html.includes(item), 'the caution names the checklist item it came from')
})

test('a withheld caution appears on neither rendering', async () => {
  const webApp = app({
    model,
    createId: () => 'memo-withheld',
    pipeline: async (options) => {
      const result = fixtureResult(options)
      const memo: Memo = {
        ...result.memo,
        checklist: [
          {
            item: '公司自述与可核查事实是否区分',
            covered: true,
            verdict: 'contradicted',
            cautionWithheld: true,
            source: 'audit',
          },
        ],
      }
      return { ...result, memo, markdown: renderMemoMarkdown(memo) }
    },
  })

  const html = await (await inject(webApp, '/ask', { method: 'POST', body: askForm() })).text()
  assert.equal(html.includes('复核提示'), false)
})

test('GET /memo/:id and home history are scoped to the browser session', async () => {
  const webApp = app({
    model,
    createId: () => 'history-id',
    pipeline: async (options) => fixtureResult(options),
  })
  const ask = await inject(webApp, '/ask', { method: 'POST', body: askForm('会话问题') })
  const cookie = (ask.headers.get('set-cookie') ?? '').split(';')[0]
  const memo = await inject(webApp, '/memo/history-id', { headers: { Cookie: cookie } })
  assert.equal(memo.status, 200)
  assert.match(await memo.text(), /会话问题/)
  const home = await inject(webApp, '/', { headers: { Cookie: cookie } })
  assert.match(await home.text(), /href="\/memo\/history-id"/)
  const foreign = await inject(webApp, '/memo/history-id')
  assert.equal(foreign.status, 404)
})

test('gate rejection shows every reason and the audit trail', async () => {
  const webApp = app({ model, pipeline: async (options) => fixtureResult(options, false) })
  const response = await inject(webApp, '/ask', { method: 'POST', body: askForm() })
  const html = await response.text()
  assert.equal(response.status, 200)
  assert.match(html, /验证拒绝/)
  assert.match(html, /fact_without_evidence/)
  assert.match(html, /guaranteed_return/)
  assert.match(html, /number is not registered/)
  assert.match(html, /claim_dropped_compliance/)
  assert.match(html, /检测到确定收益承诺/)
})

test('uploaded names and model/user text are HTML-escaped', async () => {
  const webApp = app({
    model,
    pipeline: async (options) => {
      const result = fixtureResult(options)
      result.memo.evidence[0]!.documentId = '<img src=x>.txt'
      result.memo.sources[0]!.documentId = '<img src=x>.txt'
      return result
    },
  })
  const response = await inject(webApp, '/ask', {
    method: 'POST',
    body: askForm('<script>alert(1)</script>', '<img src=x>.txt'),
  })
  const html = await response.text()
  assert.ok(!html.includes('<script>alert(1)</script>'))
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(html, /&lt;img src=x&gt;\.txt/)
})

test('a file over 10MB is rejected with a human 413 page before the pipeline runs', async () => {
  let called = false
  const webApp = app({
    model,
    pipeline: async (options) => {
      called = true
      return fixtureResult(options)
    },
  })
  const response = await inject(webApp, '/ask', {
    method: 'POST',
    body: askForm('too large?', 'large.txt', new Uint8Array(MAX_FILE_BYTES + 1).fill(65)),
  })
  assert.equal(response.status, 413)
  assert.match(await response.text(), /超过 10MB/)
  assert.equal(called, false)
})

test('unsupported uploads are rejected without calling the pipeline', async () => {
  let called = false
  const webApp = app({
    model,
    pipeline: async (options) => {
      called = true
      return fixtureResult(options)
    },
  })
  const response = await inject(webApp, '/ask', { method: 'POST', body: askForm('question', 'data.csv') })
  assert.equal(response.status, 400)
  assert.match(await response.text(), /不支持的文件类型/)
  assert.equal(called, false)
})

test('PDF parsing uses the injected offline extractor', async () => {
  const source = await loadUploadedFiles(
    [{ name: 'notice.pdf', data: new Uint8Array([1, 2, 3]) }],
    async () => 'PDF 标题\nPDF 中的立案审查原文',
  )
  assert.equal(source.documents[0]?.title, 'PDF 标题')
  assert.match(source.documents[0]?.text ?? '', /立案审查/)
})

test('missing API key returns an actionable error page', async () => {
  const webApp = app({ env: {} })
  const response = await inject(webApp, '/ask', { method: 'POST' })
  assert.equal(response.status, 503)
  assert.match(await response.text(), /DEEPSEEK_API_KEY/)
  assert.match(await response.text(), /MERIDIAN_MODEL_API_KEY/)
})

test('model timeout returns a human 504 page', async () => {
  const webApp = app({
    model,
    pipeline: async () => {
      throw new ModelError('model failed: AbortError timeout')
    },
  })
  const response = await inject(webApp, '/ask', { method: 'POST', body: askForm() })
  assert.equal(response.status, 504)
  assert.match(await response.text(), /模型响应超时/)
})

test('cross-origin form posts are rejected', async () => {
  const webApp = app({ model, pipeline: async (options) => fixtureResult(options) })
  const response = await inject(webApp, '/ask', {
    method: 'POST',
    headers: { Origin: 'https://attacker.example' },
    body: askForm(),
  })
  assert.equal(response.status, 403)
  assert.match(await response.text(), /请求来源/)
})

test('malformed multipart input is a 400, not a process crash', async () => {
  const webApp = app({ model, pipeline: async (options) => fixtureResult(options) })
  const response = await inject(webApp, '/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=broken' },
    body: 'not multipart',
  })
  assert.equal(response.status, 400)
  assert.match(await response.text(), /表单损坏或不完整/)
})

const e2e = process.env.DEEPSEEK_API_KEY ? test : test.skip
e2e('real e2e: MB-001 announcement contains 立案审查', { timeout: 240_000 }, async () => {
  const key = process.env.DEEPSEEK_API_KEY
  assert.ok(key)
  const realModel = OpenAICompatibleModel.fromEnv({ DEEPSEEK_API_KEY: key })
  assert.ok(realModel)
  const fixturePath = resolve(HERE, '..', '..', 'bench', 'tasks', 'MB-001', 'context', 'announcement.txt')
  const announcement = await readFile(fixturePath)
  const webApp = app({ model: realModel, pipeline: runPipeline })
  const response = await inject(webApp, '/ask', {
    method: 'POST',
    body: askForm('阅读公告，说明本次重整申请当前的程序状态并引用原文。', 'announcement.txt', announcement),
  })
  const html = await response.text()
  assert.equal(response.status, 200, html.slice(0, 500))
  assert.match(html, /立案审查/)
})

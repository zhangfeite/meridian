/**
 * The three `DataSource` implementations.
 *
 * `PeriscopeSource` is tested against a real HTTP server rather than a stubbed
 * `fetch`, because the parts most likely to be wrong on the day the Integration
 * API lands are wire-level: the bearer header, the error envelope, the status
 * mapping, and chunk reassembly.
 */

import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { EdgarSource, htmlToText, type FetchLike } from '../src/source/edgar.ts'
import { FixtureSource } from '../src/source/fixture.ts'
import { PeriscopeSource } from '../src/source/periscope.ts'
import { DataSourceError } from '../src/source/types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BENCH_TASKS = join(HERE, '..', '..', 'bench', 'tasks')

test('FixtureSource exposes Meridian Bench context files as documents', async () => {
  const source = FixtureSource.fromBenchTasks(BENCH_TASKS, ['MB-001'])
  const listed = await source.listDocuments({})
  assert.deepEqual(
    listed.map((item) => item.id),
    ['MB-001/context/announcement.txt'],
  )
  const document = await source.getDocument('MB-001/context/announcement.txt')
  assert.ok(document.text.includes('宁波中院'))
  // The task-relative path travels with the document so the memo's source
  // legend can name what a reviewer opens, without printing the task id.
  assert.equal(document.meta?.locator, 'context/announcement.txt')
  await assert.rejects(() => source.getDocument('MB-999/context/nope.txt'), (error: unknown) => {
    assert.ok(error instanceof DataSourceError)
    assert.equal(error.code, 'not_found')
    return true
  })
})

// --- EDGAR ------------------------------------------------------------------

const TICKERS = JSON.stringify({ '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' } })
const SUBMISSIONS = JSON.stringify({
  cik: '320193',
  name: 'Apple Inc.',
  filings: {
    recent: {
      accessionNumber: ['0000320193-26-000078', '0000320193-26-000070'],
      filingDate: ['2026-08-01', '2026-05-02'],
      form: ['10-Q', '8-K'],
      primaryDocument: ['aapl-20260801.htm', 'aapl-20260502.htm'],
    },
  },
})

function edgarFetch(seen: string[]): FetchLike {
  return async (url) => {
    seen.push(url)
    const body = url.includes('company_tickers')
      ? TICKERS
      : url.includes('/submissions/')
        ? SUBMISSIONS
        : '<html><body><p>Net sales were <b>$94,036</b> million.</p><p>&nbsp;Risk factors follow.</p></body></html>'
    return { ok: true, status: 200, text: async () => body }
  }
}

test('EdgarSource resolves a ticker, lists filings, and fetches one', async () => {
  const seen: string[] = []
  const source = new EdgarSource({ userAgent: 'Meridian test contact@example.com', fetchImpl: edgarFetch(seen), minIntervalMs: 0 })

  const filings = await source.listDocuments({ symbol: 'AAPL', limit: 1 })
  assert.equal(filings.length, 1)
  assert.equal(filings[0]?.id, 'edgar:320193:000032019326000078:aapl-20260801.htm')
  assert.equal(filings[0]?.docType, '10-Q')
  assert.match(filings[0]?.url ?? '', /Archives\/edgar\/data\/320193\/000032019326000078\/aapl-20260801\.htm$/)

  const document = await source.getDocument(filings[0]!.id)
  assert.ok(document.text.includes('$94,036'))
  assert.ok(seen.some((url) => url.includes('data.sec.gov/submissions/CIK0000320193.json')))
})

test('EdgarSource maps SEC status codes to actionable errors', async () => {
  const failing = (status: number): FetchLike => async () => ({ ok: false, status, text: async () => '' })
  for (const [status, code] of [
    [403, 'unauthorized'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [500, 'unavailable'],
  ] as const) {
    const source = new EdgarSource({ userAgent: 'Meridian test contact@example.com', fetchImpl: failing(status), minIntervalMs: 0 })
    await assert.rejects(
      () => source.getDocument('edgar:320193:000032019326000078:a.htm'),
      (error: unknown) => {
        assert.ok(error instanceof DataSourceError)
        assert.equal(error.code, code)
        return true
      },
    )
  }
  assert.throws(() => new EdgarSource({ userAgent: '  ' }), /User-Agent/)
})

test('htmlToText keeps text nodes exactly and drops markup', () => {
  const text = htmlToText('<div>Net sales <b>$94,036</b>&nbsp;million<br/>Q3 2026</div><script>x()</script>')
  assert.equal(text, 'Net sales $94,036 million\nQ3 2026')
  assert.equal(htmlToText('plain text, no markup'), 'plain text, no markup')
})

// --- Periscope Integration API ---------------------------------------------

interface Route {
  (request: IncomingMessage, response: ServerResponse): void
}

async function withServer(route: Route, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server: Server = createServer(route)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

test('PeriscopeSource sends a bearer token and reads the announcements envelope', async () => {
  const authorizations: (string | undefined)[] = []
  await withServer(
    (request, response) => {
      authorizations.push(request.headers.authorization)
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      assert.equal(url.pathname, '/v1/integration/announcements')
      assert.equal(url.searchParams.get('symbol'), '600491')
      assert.equal(url.searchParams.get('limit'), '2')
      json(response, 200, {
        items: [
          {
            document_id: 4211,
            title: '关于公司被债权人申请重整及预重整的提示性公告',
            provider: 'cninfo',
            source_published_at: '2026-08-14T09:00:00+08:00',
            ann_type: 'restructuring',
            severity: 'red',
            url: 'https://example.invalid/4211.pdf',
          },
        ],
        total: 1,
      })
    },
    async (baseUrl) => {
      const source = new PeriscopeSource({ baseUrl, apiKey: 'mk_test' })
      const listed = await source.listDocuments({ symbol: '600491', limit: 2 })
      assert.equal(listed[0]?.id, '4211')
      assert.equal(listed[0]?.severity, 'red')
      assert.equal(listed[0]?.docType, 'restructuring')
      assert.deepEqual(authorizations, ['Bearer mk_test'])
    },
  )
})

test('announcement and event grades are merged, worst wins', async () => {
  // R2-P2b: returning the announcement-level grade first let a `blue` label hide
  // a `red` bankruptcy event — a downgrade the reader would never see.
  await withServer(
    (_request, response) =>
      json(response, 200, {
        items: [
          {
            document_id: 703,
            title: '重整申请公告',
            severity: 'blue',
            events: [
              { id: 1, event_type: 'other', severity: 'blue' },
              { id: 2, event_type: 'bankruptcy', severity: 'red' },
            ],
          },
          { document_id: 704, title: '仅公告级', severity: 'amber', events: [] },
          { document_id: 705, title: '仅事件级', events: [{ id: 3, severity: 'amber' }] },
        ],
        total: 3,
      }),
    async (baseUrl) => {
      const source = new PeriscopeSource({ baseUrl, apiKey: 'mk_test' })
      const listed = await source.listDocuments({ symbol: '600491' })
      assert.deepEqual(
        listed.map((item) => item.severity),
        ['red', 'amber', 'amber'],
      )
    },
  )
})

test('PeriscopeSource reassembles a chunked document in sequence order', async () => {
  await withServer(
    (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      assert.equal(url.pathname, '/v1/integration/documents/4211')
      const offset = Number(url.searchParams.get('offset') ?? '0')
      if (offset === 0) {
        json(response, 200, {
          id: 4211,
          title: '重整申请公告',
          provider: 'cninfo',
          chunks: [
            { seq: 1, content: '公司于2026年8月13日收到' },
            { seq: 0, content: '重要内容提示:' },
          ],
          next_offset: 2,
        })
        return
      }
      json(response, 200, { chunks: [{ seq: 2, content: '宁波中院送达的《通知书》。' }], next_offset: null })
    },
    async (baseUrl) => {
      const source = new PeriscopeSource({ baseUrl, apiKey: 'mk_test' })
      const document = await source.getDocument('4211')
      assert.equal(document.text, '重要内容提示:公司于2026年8月13日收到宁波中院送达的《通知书》。')
      assert.equal(document.title, '重整申请公告')
    },
  )
})

test('PeriscopeSource maps the API error envelope onto DataSourceError codes', async () => {
  for (const [status, code, apiCode] of [
    [401, 'unauthorized', 'unauthorized'],
    [429, 'rate_limited', 'rate_limited'],
    [404, 'not_found', 'not_found'],
    [503, 'unavailable', 'internal'],
  ] as const) {
    await withServer(
      (_request, response) => json(response, status, { error: { code: apiCode, message: 'nope' } }),
      async (baseUrl) => {
        const source = new PeriscopeSource({ baseUrl, apiKey: 'mk_test' })
        await assert.rejects(
          () => source.listDocuments({ symbol: '600491' }),
          (error: unknown) => {
            assert.ok(error instanceof DataSourceError)
            assert.equal(error.code, code)
            assert.match(error.message, /nope/)
            return true
          },
        )
      },
    )
  }
})

test('PeriscopeSource refuses a non-advancing chunk cursor rather than looping', async () => {
  await withServer(
    (_request, response) => json(response, 200, { chunks: [{ seq: 0, content: 'x' }], next_offset: 0 }),
    async (baseUrl) => {
      const source = new PeriscopeSource({ baseUrl, apiKey: 'mk_test' })
      await assert.rejects(() => source.getDocument('1'), /non-advancing offset cursor/)
    },
  )
})

test('PeriscopeSource searches instruments and requires a key', async () => {
  await withServer(
    (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      assert.equal(url.pathname, '/v1/integration/instruments/search')
      assert.equal(url.searchParams.get('q'), '龙元')
      json(response, 200, { items: [{ symbol: '600491', name_cn: '龙元建设', market: 'SH' }], total: 1 })
    },
    async (baseUrl) => {
      const source = new PeriscopeSource({ baseUrl, apiKey: 'mk_test' })
      assert.deepEqual(await source.searchInstruments('龙元'), [
        { symbol: '600491', name: '龙元建设', market: 'SH' },
      ])
    },
  )
  assert.throws(() => new PeriscopeSource({ baseUrl: 'http://x', apiKey: '' }), /API key/)
})

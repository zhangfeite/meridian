import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  DataSourceError,
  ModelError,
  ScriptedModel,
  type DataSource,
  type PipelineOptions,
  type PipelineResult,
} from '@meridian/agent'
import { EXIT_DATA_UNAVAILABLE, EXIT_GATE_REJECTED, EXIT_OK, runCli, type CliIo } from '../src/cli.ts'

interface Capture {
  options?: PipelineOptions
  documents?: { id: string; text: string }[]
}

function memoryIo(): { io: CliIo; stdout: () => string; stderr: () => string } {
  let out = ''
  let err = ''
  return {
    io: {
      stdout: { write: (chunk) => (out += chunk) },
      stderr: { write: (chunk) => (err += chunk) },
    },
    stdout: () => out,
    stderr: () => err,
  }
}

const HERE = dirname(fileURLToPath(import.meta.url))

async function tempDir(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'meridian-cli-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

function fixturePipeline(capture: Capture, options: { gatePassed?: boolean; retrievalFailure?: boolean } = {}) {
  return async (pipelineOptions: PipelineOptions): Promise<PipelineResult> => {
    capture.options = pipelineOptions
    const catalog = await pipelineOptions.source.listDocuments(pipelineOptions.catalogQuery ?? {})
    capture.documents = await Promise.all(
      catalog.map(async (item) => {
        const document = await pipelineOptions.source.getDocument(item.id)
        return { id: document.id, text: document.text }
      }),
    )
    const gatePassed = options.gatePassed ?? true
    const result = {
      markdown: '# Meridian Memo\n\n这是经过验证的结论。[C-A]\n',
      memo: {
        schemaVersion: 'meridian-memo-v1',
        generatedAt: '2026-08-15T00:00:00.000Z',
        lang: pipelineOptions.lang ?? 'zh-CN',
        question: pipelineOptions.question,
        entity: { name: '测试公司' },
        narrative: [
          {
            kind: 'conclusion',
            heading: '结论',
            paragraphs: [{ text: '这是经过验证的结论。[C-A]', claimIds: ['C-A'], polished: false }],
          },
        ],
        sections: [],
        claims: [
          {
            id: 'C-A',
            type: 'fact',
            questionId: 'Q-A',
            text: '这是经过验证的结论。',
            evidenceIds: ['E-A'],
            numberRefs: [],
          },
        ],
        evidence: [],
        derived: [],
        sources: [],
        openQuestions: ['管理人尚未披露'],
        audit: [
          {
            step: 'extract',
            action: 'claim_rejected_unverifiable_quote',
            detail: 'dropped test claim',
          },
        ],
        gate: {
          passed: gatePassed,
          contractViolations: gatePassed ? [] : [{ code: 'test', message: 'gate rejected in fixture' }],
          complianceHits: [],
          numberViolations: [],
        },
        provenance: {
          pipeline: 'fixture',
          model: pipelineOptions.model.id,
          dataSource: pipelineOptions.source.id,
          retrieval: 'direct',
        },
      },
      trace: {
        retrieval: {
          documents: [],
          failures: options.retrievalFailure
            ? [{ documentId: 'missing.txt', code: 'unavailable', message: 'fixture unavailable' }]
            : [],
          mode: 'direct',
        },
      },
    }
    return result as unknown as PipelineResult
  }
}

test('ask reads repeated txt/md files, writes memo.md, and prints the human summary', async (t) => {
  const directory = await tempDir(t)
  const textPath = join(directory, '公告.txt')
  const markdownPath = join(directory, '补充.md')
  await writeFile(textPath, '公告标题\n重整申请已获法院受理。', 'utf8')
  await writeFile(markdownPath, '# 补充公告\n管理人尚未披露。', 'utf8')
  const capture: Capture = {}
  const output = memoryIo()

  const code = await runCli(
    ['ask', '--file', textPath, '重整走到哪一步?', '--file', markdownPath],
    output.io,
    {
      cwd: directory,
      model: new ScriptedModel(['unused']),
      pipeline: fixturePipeline(capture),
    },
  )

  assert.equal(code, EXIT_OK)
  assert.deepEqual(
    capture.documents?.map((document) => document.text),
    ['公告标题\n重整申请已获法院受理。', '# 补充公告\n管理人尚未披露。'],
  )
  assert.equal(await readFile(join(directory, 'memo.md'), 'utf8'), '# Meridian Memo\n\n这是经过验证的结论。[C-A]\n')
  assert.match(output.stdout(), /结论[\s\S]*这是经过验证的结论/)
  assert.match(output.stdout(), /1 claims 验证 \/ 1 拒绝/)
  assert.match(output.stdout(), /管理人尚未披露/)
  assert.equal(output.stderr(), '')
})

test('ask keeps PDF parsing in the CLI and honors --out', async (t) => {
  const directory = await tempDir(t)
  const pdfPath = join(directory, '公告.pdf')
  await writeFile(pdfPath, Buffer.from('%PDF-fixture'))
  const capture: Capture = {}
  let parserInput = ''

  const code = await runCli(['ask', '发生了什么?', '--file', pdfPath, '--out', 'runs/result.md'], memoryIo().io, {
    cwd: directory,
    model: new ScriptedModel(['unused']),
    pipeline: fixturePipeline(capture),
    pdfTextExtractor: async (data) => {
      parserInput = Buffer.from(data).toString('utf8')
      return 'PDF 公告\n公司收到法院通知。'
    },
  })

  assert.equal(code, EXIT_OK)
  assert.equal(parserInput, '%PDF-fixture')
  assert.equal(capture.documents?.[0]?.text, 'PDF 公告\n公司收到法院通知。')
  assert.match(await readFile(join(directory, 'runs', 'result.md'), 'utf8'), /Meridian Memo/)
})

test('ask --source periscope uses the symbol catalog and BYO-model environment', async (t) => {
  const directory = await tempDir(t)
  const capture: Capture = {}
  const source: DataSource = {
    id: 'periscope-fixture',
    async listDocuments(query) {
      assert.equal(query.symbol, '600491')
      return [{ id: 'ann-A', title: '重整公告', provider: 'fixture' }]
    },
    async getDocument(id) {
      return { id, title: '重整公告', text: '法院已受理重整申请。', provider: 'fixture' }
    },
  }

  const code = await runCli(
    ['ask', '重整走到哪一步?', '--symbol', '600491', '--source', 'periscope'],
    memoryIo().io,
    {
      cwd: directory,
      env: {
        DEEPSEEK_API_KEY: 'fixture-key',
        MERIDIAN_MODEL_BASE_URL: 'https://model.example/v1',
        MERIDIAN_MODEL: 'fixture-model',
      },
      periscopeSource: source,
      pipeline: fixturePipeline(capture),
    },
  )

  assert.equal(code, EXIT_OK)
  assert.equal(capture.options?.model.id, 'fixture-model')
  assert.equal(capture.options?.catalogQuery?.symbol, '600491')
  assert.equal(capture.documents?.[0]?.text, '法院已受理重整申请。')
})

test('bench runs one fixture task and --json emits a machine-readable result', async (t) => {
  const directory = await tempDir(t)
  const capture: Capture = {}
  const output = memoryIo()
  const tasksDir = join(directory, 'tasks')
  const contextDir = join(tasksDir, 'MB-001', 'context')
  await mkdir(contextDir, { recursive: true })
  await writeFile(
    join(tasksDir, 'MB-001', 'task.json'),
    JSON.stringify({ prompt: '重整走到哪一步?', lang: 'zh-CN', context_files: ['context/announcement.txt'] }),
  )
  await writeFile(join(contextDir, 'announcement.txt'), '公告\n法院已受理。')

  const code = await runCli(['bench', '--tasks', 'MB-001', '--lang', 'zh-CN', '--json'], output.io, {
    cwd: directory,
    tasksDir,
    model: new ScriptedModel(['unused']),
    pipeline: fixturePipeline(capture),
  })

  assert.equal(code, EXIT_OK)
  const json = JSON.parse(output.stdout()) as Record<string, unknown>
  assert.equal(json.status, 'ok')
  assert.equal(json.exitCode, 0)
  assert.equal((json.summary as { verifiedClaims: number }).verifiedClaims, 1)
  assert.equal(capture.options?.taskId, 'MB-001')
  assert.deepEqual(capture.options?.documentIds, ['MB-001/context/announcement.txt'])
  assert.equal(output.stderr(), '')
})

test('gate rejection writes the memo and exits 2', async (t) => {
  const directory = await tempDir(t)
  const file = join(directory, 'announcement.txt')
  await writeFile(file, '公告\n测试内容')
  const output = memoryIo()
  const code = await runCli(['ask', '测试?', '--file', file], output.io, {
    cwd: directory,
    model: new ScriptedModel(['unused']),
    pipeline: fixturePipeline({}, { gatePassed: false }),
  })

  assert.equal(code, EXIT_GATE_REJECTED)
  assert.match(await readFile(join(directory, 'memo.md'), 'utf8'), /Meridian Memo/)
  assert.match(output.stderr(), /gate 拒绝/)
})

test('retrieval failure exits 3 even when the degraded memo passes its gate', async (t) => {
  const directory = await tempDir(t)
  const file = join(directory, 'announcement.txt')
  await writeFile(file, '公告\n测试内容')
  const output = memoryIo()
  const code = await runCli(['ask', '测试?', '--file', file], output.io, {
    cwd: directory,
    model: new ScriptedModel(['unused']),
    pipeline: fixturePipeline({}, { retrievalFailure: true }),
  })

  assert.equal(code, EXIT_DATA_UNAVAILABLE)
  assert.match(output.stderr(), /部分数据未能取得/)
})

test('missing key, missing file, and model timeout each give actionable guidance', async (t) => {
  const directory = await tempDir(t)
  const noKey = memoryIo()
  assert.equal(
    await runCli(['ask', '测试?', '--file', join(directory, 'missing.txt')], noKey.io, { cwd: directory, env: {} }),
    EXIT_DATA_UNAVAILABLE,
  )
  assert.match(noKey.stderr(), /DEEPSEEK_API_KEY/)

  const missing = memoryIo()
  assert.equal(
    await runCli(['ask', '测试?', '--file', join(directory, 'missing.txt')], missing.io, {
      cwd: directory,
      model: new ScriptedModel(['unused']),
    }),
    EXIT_DATA_UNAVAILABLE,
  )
  assert.match(missing.stderr(), /找不到文件/)

  const file = join(directory, 'announcement.txt')
  await writeFile(file, '公告\n测试内容')
  const timeout = memoryIo()
  assert.equal(
    await runCli(['ask', '测试?', '--file', file], timeout.io, {
      cwd: directory,
      model: new ScriptedModel(['unused']),
      pipeline: async () => {
        throw new ModelError('model failed after 3 attempts: This operation was aborted')
      },
    }),
    EXIT_DATA_UNAVAILABLE,
  )
  assert.match(timeout.stderr(), /模型请求超时/)
})

test('Periscope no-data response exits 3 before the pipeline runs', async (t) => {
  const directory = await tempDir(t)
  let called = false
  const output = memoryIo()
  const code = await runCli(
    ['ask', '最近披露了什么?', '--symbol', '600491', '--source', 'periscope'],
    output.io,
    {
      cwd: directory,
      model: new ScriptedModel(['unused']),
      periscopeSource: {
        id: 'empty-periscope',
        async listDocuments() {
          return []
        },
        async getDocument() {
          throw new DataSourceError('not_found', 'empty-periscope', 'not found')
        },
      },
      pipeline: async () => {
        called = true
        throw new Error('must not run')
      },
    },
  )

  assert.equal(code, EXIT_DATA_UNAVAILABLE)
  assert.equal(called, false)
  assert.match(output.stderr(), /没有取得 600491 的公告/)
})

test(
  'real DeepSeek e2e: one local filing produces a compliant memo',
  { skip: !process.env.DEEPSEEK_API_KEY, timeout: 600_000 },
  async (t) => {
    const directory = await tempDir(t)
    const output = memoryIo()
    const fixture = join(HERE, '..', '..', 'bench', 'tasks', 'MB-001', 'context', 'announcement.txt')
    const code = await runCli(
      ['ask', '--file', fixture, '重整走到哪一步', '--out', 'memo.md', '--json'],
      output.io,
      { cwd: directory },
    )
    assert.equal(code, EXIT_OK)
    const payload = JSON.parse(output.stdout()) as { memo: { gate: { passed: boolean } } }
    assert.equal(payload.memo.gate.passed, true)
    assert.match(await readFile(join(directory, 'memo.md'), 'utf8'), /来源|Source/)
  },
)

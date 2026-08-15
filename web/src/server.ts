import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  auditEnabled,
  ModelError,
  OpenAICompatibleModel,
  runPipeline,
  type MeridianLang,
  type ModelClient,
  type PipelineOptions,
  type PipelineResult,
} from '@meridian/agent'
import { APP_CSS, APP_JS } from './assets.ts'
import {
  MAX_REQUEST_BYTES,
  UploadError,
  extractPdfText,
  loadUploadedFiles,
  type PdfTextExtractor,
  type UploadedDocument,
  type UploadedFile,
} from './upload-source.ts'
import { renderErrorPage, renderHomePage, renderMemoPage, type HistoryItem } from './view.ts'

const SESSION_COOKIE = 'meridian_session'
const LANGS = new Set<MeridianLang>(['zh-CN', 'zh-TW', 'en'])

export interface StoredMemo {
  id: string
  sessionId: string
  createdAt: string
  result: PipelineResult
  documents: readonly UploadedDocument[]
}

export interface MemoStore {
  put(record: StoredMemo): void
  get(id: string, sessionId: string): StoredMemo | undefined
  list(sessionId: string): StoredMemo[]
}

/** Bounded process-local history. All records disappear when the server stops. */
export class MemoryMemoStore implements MemoStore {
  readonly #records = new Map<string, StoredMemo>()
  readonly #capacity: number

  constructor(capacity = 100) {
    this.#capacity = capacity
  }

  put(record: StoredMemo): void {
    this.#records.set(record.id, record)
    while (this.#records.size > this.#capacity) {
      const oldest = this.#records.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.#records.delete(oldest)
    }
  }

  get(id: string, sessionId: string): StoredMemo | undefined {
    const record = this.#records.get(id)
    return record?.sessionId === sessionId ? record : undefined
  }

  list(sessionId: string): StoredMemo[] {
    return [...this.#records.values()]
      .filter((record) => record.sessionId === sessionId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }
}

export interface WebDependencies {
  env?: NodeJS.ProcessEnv
  model?: ModelClient
  pipeline?: (options: PipelineOptions) => Promise<PipelineResult>
  pdfTextExtractor?: PdfTextExtractor
  kernel?: PipelineOptions['kernel']
  store?: MemoStore
  now?: () => Date
  createId?: () => string
}

export interface WebApp {
  server: Server
  store: MemoStore
  handler: WebRequestHandler
}

export type WebRequestHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>

/** Create the Node HTTP server without listening, suitable for tests or embedding. */
export function createWebApp(dependencies: WebDependencies = {}): WebApp {
  const store = dependencies.store ?? new MemoryMemoStore()
  const now = dependencies.now ?? (() => new Date())
  const createId = dependencies.createId ?? randomUUID
  const handler: WebRequestHandler = async (request, response) => {
    try {
      await route(request, response, dependencies, store, now, createId)
    } catch (error) {
      if (!response.headersSent) {
        sendHtml(response, 500, renderErrorPage('暂时无法处理请求', '服务遇到了未预期的问题，请稍后重试。', 500))
      } else {
        response.end()
      }
      // Keep the self-hosted process alive, but leave an actionable local log.
      process.stderr.write(`[meridian-web] unhandled request error: ${humanError(error)}\n`)
    }
  }
  const server = createServer((request, response) => void handler(request, response))
  server.requestTimeout = 5 * 60_000
  server.headersTimeout = 30_000
  return { server, store, handler }
}

/** Convenience export for callers that only need the HTTP server. */
export function createWebServer(dependencies: WebDependencies = {}): Server {
  return createWebApp(dependencies).server
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: WebDependencies,
  store: MemoStore,
  now: () => Date,
  createId: () => string,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const session = getSession(request)

  if (request.method === 'GET' && url.pathname === '/assets/app.css') {
    send(response, 200, APP_CSS, 'text/css; charset=utf-8', { 'Cache-Control': 'public, max-age=3600' })
    return
  }
  if (request.method === 'GET' && url.pathname === '/assets/app.js') {
    send(response, 200, APP_JS, 'text/javascript; charset=utf-8', { 'Cache-Control': 'public, max-age=3600' })
    return
  }

  if (request.method === 'GET' && url.pathname === '/') {
    const history: HistoryItem[] = store.list(session.id).map((record) => ({
      id: record.id,
      question: record.result.memo.question,
      createdAt: record.createdAt,
      gatePassed: record.result.memo.gate.passed,
    }))
    sendHtml(response, 200, renderHomePage(history), session.isNew ? sessionHeader(session.id) : undefined)
    return
  }

  if (request.method === 'GET' && url.pathname.startsWith('/memo/')) {
    const id = decodeURIComponent(url.pathname.slice('/memo/'.length))
    if (!id || id.includes('/')) {
      sendHtml(response, 404, renderErrorPage('找不到 memo', '这个链接无效，或 memo 已随服务重启而清除。', 404))
      return
    }
    const record = store.get(id, session.id)
    if (!record) {
      sendHtml(
        response,
        404,
        renderErrorPage('找不到 memo', '这个 memo 不属于当前浏览器会话，或已随服务重启而清除。', 404),
        session.isNew ? sessionHeader(session.id) : undefined,
      )
      return
    }
    sendHtml(response, 200, renderMemoPage(record.result.memo, record.documents, record.id))
    return
  }

  if (request.method === 'POST' && url.pathname === '/ask') {
    if (!sameOrigin(request)) {
      sendHtml(response, 403, renderErrorPage('请求已拦截', '请求来源与本地 Meridian 服务不一致，请从首页重新提交。', 403))
      return
    }
    const model = dependencies.model ?? OpenAICompatibleModel.fromEnv(dependencies.env ?? process.env)
    if (!model) {
      sendHtml(
        response,
        503,
        renderErrorPage(
          '还缺一个模型 API key',
          '请先设置 DEEPSEEK_API_KEY；使用其他 OpenAI 兼容模型时设置 MERIDIAN_MODEL_API_KEY，并可用 MERIDIAN_MODEL_BASE_URL / MERIDIAN_MODEL 指定地址和模型名。',
          503,
        ),
        session.isNew ? sessionHeader(session.id) : undefined,
      )
      return
    }

    let form: AskForm
    try {
      form = await parseAskForm(request)
    } catch (error) {
      const uploadError = error instanceof UploadError ? error : undefined
      const status = uploadError?.code === 'file_too_large' ? 413 : 400
      sendHtml(
        response,
        status,
        renderErrorPage(status === 413 ? '文件太大' : '无法读取上传内容', humanError(error), status),
        session.isNew ? sessionHeader(session.id) : undefined,
      )
      return
    }

    let source
    try {
      source = await loadUploadedFiles(form.files, dependencies.pdfTextExtractor ?? extractPdfText)
    } catch (error) {
      const status = error instanceof UploadError && error.code === 'file_too_large' ? 413 : 400
      sendHtml(
        response,
        status,
        renderErrorPage(status === 413 ? '文件太大' : '文件无法分析', humanError(error), status, form.lang),
        session.isNew ? sessionHeader(session.id) : undefined,
      )
      return
    }

    let result: PipelineResult
    try {
      const options: PipelineOptions = {
        question: form.question,
        lang: form.lang,
        source,
        model,
        documentIds: source.documents.map((document) => document.id),
        // The step-7b checklist audit costs one extra model call per memo, so a
        // host paying per token can switch it off; on is the default.
        ...(auditEnabled(dependencies.env ?? process.env) ? {} : { audit: false }),
        ...(dependencies.kernel === undefined ? {} : { kernel: dependencies.kernel }),
      }
      result = await (dependencies.pipeline ?? runPipeline)(options)
    } catch (error) {
      const message = humanError(error)
      const timedOut = error instanceof ModelError && /abort|timeout|timed out|超时/i.test(message)
      const status = timedOut ? 504 : 502
      sendHtml(
        response,
        status,
        renderErrorPage(
          timedOut ? '模型响应超时' : '模型调用失败',
          timedOut
            ? '模型在时限内没有返回。请检查网络和 MERIDIAN_MODEL_BASE_URL，稍后重新提交。'
            : '请检查模型 API key、MERIDIAN_MODEL_BASE_URL 与模型名，然后重新提交。',
          status,
          form.lang,
        ),
        session.isNew ? sessionHeader(session.id) : undefined,
      )
      return
    }

    const id = createId()
    const record: StoredMemo = {
      id,
      sessionId: session.id,
      createdAt: now().toISOString(),
      result,
      documents: source.documents,
    }
    store.put(record)
    sendHtml(response, 200, renderMemoPage(result.memo, source.documents, id), {
      ...(session.isNew ? sessionHeader(session.id) : {}),
      'Content-Location': `/memo/${encodeURIComponent(id)}`,
    })
    return
  }

  if (request.method === 'POST') {
    sendHtml(response, 404, renderErrorPage('找不到页面', '这个地址不存在。', 404))
    return
  }
  response.setHeader('Allow', 'GET, POST')
  sendHtml(response, 404, renderErrorPage('找不到页面', '这个地址不存在。', 404))
}

interface AskForm {
  question: string
  lang: MeridianLang
  files: UploadedFile[]
}

async function parseAskForm(request: IncomingMessage): Promise<AskForm> {
  const contentType = request.headers['content-type'] ?? ''
  if (!contentType.toLowerCase().startsWith('multipart/form-data;')) {
    throw new UploadError('invalid_form', '提交格式不正确，请从首页重新提交。')
  }
  const announcedSize = Number(request.headers['content-length'])
  if (Number.isFinite(announcedSize) && announcedSize > MAX_REQUEST_BYTES) {
    throw new UploadError('file_too_large', '上传内容超过 50MB 总量限制，请减少文件数量或拆分任务。')
  }
  const body = await readBody(request, MAX_REQUEST_BYTES)
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item))
    else if (value !== undefined) headers.set(name, value)
  }
  const arrayBuffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer
  const webRequest = new Request('http://127.0.0.1/ask', { method: 'POST', headers, body: arrayBuffer })
  let data: FormData
  try {
    data = await webRequest.formData()
  } catch {
    throw new UploadError('invalid_form', '上传表单损坏或不完整，请重新选择文件。')
  }
  const questionEntry = data.get('question')
  const question = typeof questionEntry === 'string' ? questionEntry.trim() : ''
  if (!question) throw new UploadError('invalid_form', '请填写要研究的问题。')
  if (question.length > 4000) throw new UploadError('invalid_form', '问题过长，请缩短到 4000 个字符以内。')
  const langEntry = data.get('lang')
  const lang = typeof langEntry === 'string' && LANGS.has(langEntry as MeridianLang) ? (langEntry as MeridianLang) : undefined
  if (!lang) throw new UploadError('invalid_form', '语言只支持 zh-CN、zh-TW 或 en。')
  const files: UploadedFile[] = []
  for (const entry of data.getAll('files')) {
    if (typeof entry === 'string') continue
    files.push({ name: entry.name, data: new Uint8Array(await entry.arrayBuffer()) })
  }
  if (files.length === 0) throw new UploadError('invalid_form', '请至少上传一个 .txt、.md 或 .pdf 文件。')
  return { question, lang, files }
}

async function readBody(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.byteLength
    if (size > limit) {
      throw new UploadError('file_too_large', '上传内容超过 50MB 总量限制，请减少文件数量或拆分任务。')
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function getSession(request: IncomingMessage): { id: string; isNew: boolean } {
  const cookies = parseCookies(request.headers.cookie ?? '')
  const id = cookies.get(SESSION_COOKIE)
  if (id && /^[a-f0-9-]{16,64}$/i.test(id)) return { id, isNew: false }
  return { id: randomUUID(), isNew: true }
}

function parseCookies(header: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    const name = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    if (name) result.set(name, value)
  }
  return result
}

function sessionHeader(id: string): Record<string, string> {
  return { 'Set-Cookie': `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict` }
}

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  if (!origin) return true
  const host = request.headers.host
  if (!host) return false
  return origin === `http://${host}` || origin === `https://${host}`
}

function sendHtml(
  response: ServerResponse,
  status: number,
  html: string,
  extraHeaders: Record<string, string> | undefined = undefined,
): void {
  send(response, status, html, 'text/html; charset=utf-8', extraHeaders)
}

function send(
  response: ServerResponse,
  status: number,
  body: string,
  contentType: string,
  extraHeaders: Record<string, string> | undefined = undefined,
): void {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': extraHeaders?.['Cache-Control'] ?? 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    ...extraHeaders,
  })
  response.end(body)
}

function humanError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}


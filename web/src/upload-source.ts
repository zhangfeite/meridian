import { extname } from 'node:path'
import type { DataSource, DocumentQuery, DocumentSummary, SourceDocument } from '@meridian/agent'

/** Maximum accepted size of each uploaded source file. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024
/** A bounded aggregate request protects the single-process server before multipart decoding. */
export const MAX_REQUEST_BYTES = 50 * 1024 * 1024

export type PdfTextExtractor = (data: Uint8Array) => Promise<string>

export interface UploadedFile {
  name: string
  data: Uint8Array
}

export interface UploadedDocument {
  id: string
  title: string
  text: string
  filename: string
}

export class UploadError extends Error {
  readonly code: 'file_too_large' | 'unsupported_type' | 'empty_file' | 'invalid_form'

  constructor(code: UploadError['code'], message: string) {
    super(message)
    this.name = 'UploadError'
    this.code = code
  }
}

/** In-memory data source over exactly the files submitted by one browser request. */
export class UploadedFileSource implements DataSource {
  readonly id = 'web-upload'
  readonly documents: readonly UploadedDocument[]

  constructor(documents: UploadedDocument[]) {
    this.documents = documents
  }

  async listDocuments(query: DocumentQuery): Promise<DocumentSummary[]> {
    const documents = query.limit === undefined ? this.documents : this.documents.slice(0, Math.max(0, query.limit))
    return documents.map((document) => ({
      id: document.id,
      title: document.title,
      provider: 'web-upload',
    }))
  }

  async getDocument(id: string): Promise<SourceDocument> {
    const document = this.documents.find((candidate) => candidate.id === id)
    if (!document) throw new Error(`uploaded document '${id}' is not loaded`)
    return {
      id: document.id,
      title: document.title,
      text: document.text,
      provider: 'web-upload',
      meta: { locator: document.filename },
    }
  }
}

/** Validate, decode, and de-duplicate browser uploads without writing them to disk. */
export async function loadUploadedFiles(
  files: UploadedFile[],
  extractPdf: PdfTextExtractor = extractPdfText,
): Promise<UploadedFileSource> {
  if (files.length === 0) throw new UploadError('invalid_form', '请至少上传一个 .txt、.md 或 .pdf 文件。')
  const documents: UploadedDocument[] = []
  const seenIds = new Map<string, number>()

  for (const file of files) {
    if (file.data.byteLength > MAX_FILE_BYTES) {
      throw new UploadError('file_too_large', `文件 ${safeFilename(file.name)} 超过 10MB，请压缩或拆分后重试。`)
    }
    const filename = safeFilename(file.name)
    const extension = extname(filename).toLowerCase()
    if (!['.txt', '.md', '.pdf'].includes(extension)) {
      throw new UploadError('unsupported_type', `不支持的文件类型：${filename}。请上传 .txt、.md 或 .pdf。`)
    }

    let text: string
    if (extension === '.pdf') {
      try {
        text = await extractPdf(file.data)
      } catch (error) {
        throw new UploadError(
          'empty_file',
          `无法解析 PDF：${filename}。请确认文件未加密或损坏；扫描版 PDF 请先 OCR。${
            error instanceof Error ? `（${error.message}）` : ''
          }`,
        )
      }
    } else {
      text = Buffer.from(file.data).toString('utf8')
    }
    if (!text.trim()) {
      throw new UploadError('empty_file', `文件 ${filename} 没有可分析的文本；扫描版 PDF 请先 OCR。`)
    }

    const occurrence = (seenIds.get(filename) ?? 0) + 1
    seenIds.set(filename, occurrence)
    documents.push({
      id: occurrence === 1 ? filename : `${filename}#${occurrence}`,
      title: firstLine(text) ?? filename,
      text,
      filename,
    })
  }
  return new UploadedFileSource(documents)
}

/** PDF parser shared by the Web package; kept injectable so tests remain offline. */
export async function extractPdfText(data: Uint8Array): Promise<string> {
  const { PDFParse } = await import('pdf-parse')
  const parser = new PDFParse({ data })
  try {
    const result = await parser.getText()
    return result.text
  } finally {
    await parser.destroy()
  }
}

function safeFilename(input: string): string {
  const normalized = input.replaceAll('\\', '/').split('/').pop()?.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return normalized || 'upload.txt'
}

function firstLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.slice(0, 80)
}

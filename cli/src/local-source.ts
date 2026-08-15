import { readFile } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import type { DataSource, DocumentQuery, DocumentSummary, SourceDocument } from '@meridian/agent'

/** Extract text from a PDF buffer. Kept injectable so CLI tests stay offline. */
export type PdfTextExtractor = (data: Uint8Array) => Promise<string>

/** One already-read local document. */
interface LocalEntry {
  id: string
  title: string
  text: string
  path: string
}

/** A small in-memory source for files explicitly handed to the CLI. */
export class LocalFileSource implements DataSource {
  readonly id = 'local-file'
  readonly #entries: LocalEntry[]

  constructor(entries: LocalEntry[]) {
    this.#entries = entries
  }

  async listDocuments(query: DocumentQuery): Promise<DocumentSummary[]> {
    const limited = query.limit === undefined ? this.#entries : this.#entries.slice(0, Math.max(0, query.limit))
    return limited.map((entry) => ({
      id: entry.id,
      title: entry.title,
      provider: 'local-file',
    }))
  }

  async getDocument(id: string): Promise<SourceDocument> {
    const entry = this.#entries.find((candidate) => candidate.id === id)
    if (!entry) throw new Error(`local document '${id}' is not loaded`)
    return {
      id: entry.id,
      title: entry.title,
      text: entry.text,
      provider: 'local-file',
      meta: { locator: entry.path },
    }
  }
}

/** Load txt/md verbatim and extract PDF text before the model is called. */
export async function loadLocalFiles(paths: string[], extractPdf: PdfTextExtractor): Promise<LocalFileSource> {
  const entries: LocalEntry[] = []
  const seenIds = new Map<string, number>()

  for (const input of paths) {
    const path = resolve(input)
    const extension = extname(path).toLowerCase()
    if (!['.txt', '.md', '.pdf'].includes(extension)) {
      throw new Error(`不支持的文件类型：${input}。请使用 .pdf、.txt 或 .md 文件。`)
    }

    let data: Buffer
    try {
      data = await readFile(path)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      if (code === 'ENOENT') throw new Error(`找不到文件：${input}。请检查 --file 路径后重试。`)
      throw new Error(`无法读取文件：${input}。请检查文件权限和路径后重试。`)
    }

    let text: string
    if (extension === '.pdf') {
      try {
        text = await extractPdf(data)
      } catch (error) {
        throw new Error(
          `无法解析 PDF：${input}。请确认文件未加密或损坏；也可先另存为 .txt。${
            error instanceof Error ? ` (${error.message})` : ''
          }`,
        )
      }
    } else {
      text = data.toString('utf8')
    }
    if (!text.trim()) throw new Error(`文件没有可分析的文本：${input}。扫描版 PDF 请先进行 OCR。`)

    const baseId = basename(path)
    const occurrence = (seenIds.get(baseId) ?? 0) + 1
    seenIds.set(baseId, occurrence)
    entries.push({
      id: occurrence === 1 ? baseId : `${baseId}#${occurrence}`,
      title: firstLine(text) ?? baseId,
      text,
      path,
    })
  }

  return new LocalFileSource(entries)
}

/** Default PDF parser. The heavyweight dependency is intentionally CLI-only. */
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

function firstLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.slice(0, 80)
}

/**
 * `FixtureSource` — real disclosure text, read from disk.
 *
 * Not a stub: the bytes are verbatim exchange filings (the same ones Meridian
 * Bench scores against). It removes the network from the pipeline's critical
 * path so the seven steps can be developed, tested, and dogfooded before the
 * Periscope Integration API exists.
 *
 * @module @meridian/agent/source/fixture
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { DataSourceError, type DataSource, type DocumentQuery, type DocumentSummary, type SourceDocument } from './types.ts'

/** One document on disk. */
export interface FixtureEntry {
  id: string
  path: string
  title?: string
  publishedAt?: string
  symbol?: string
  market?: string
  provider?: string
  /** Human- and machine-resolvable path for this document, e.g. `context/announcement.txt`. */
  locator?: string
}

/** Construction options. */
export interface FixtureSourceOptions {
  /** Implementation id (default `'fixture'`). */
  id?: string
  entries: FixtureEntry[]
}

/** A `DataSource` backed by verbatim disclosure files. */
export class FixtureSource implements DataSource {
  readonly id: string
  readonly #entries: Map<string, FixtureEntry>

  constructor(options: FixtureSourceOptions) {
    this.id = options.id ?? 'fixture'
    this.#entries = new Map(options.entries.map((entry) => [entry.id, entry]))
  }

  /**
   * Build a source over a Meridian Bench task tree: every `MB-XXX/context/*.txt`
   * becomes a document with id `MB-XXX/context/<file>`.
   *
   * @param tasksDir - path to `meridian/bench/tasks`.
   * @param taskIds - restrict to these task directories; all when omitted.
   * @returns a source exposing those files.
   */
  static fromBenchTasks(tasksDir: string, taskIds?: string[]): FixtureSource {
    const root = resolve(tasksDir)
    const wanted = taskIds ? new Set(taskIds) : undefined
    const entries: FixtureEntry[] = []
    for (const taskDir of readdirSync(root).sort()) {
      if (wanted && !wanted.has(taskDir)) continue
      const contextDir = join(root, taskDir, 'context')
      let stat
      try {
        stat = statSync(contextDir)
      } catch {
        continue
      }
      if (!stat.isDirectory()) continue
      for (const file of readdirSync(contextDir).sort()) {
        if (!file.endsWith('.txt')) continue
        const path = join(contextDir, file)
        entries.push({
          id: relative(root, path).split(sep).join('/'),
          path,
          // A catalog is only useful if its titles say what the document is.
          // Filings put their own title on the first line; use it.
          title: firstLine(path) ?? `${taskDir} · ${basename(file, '.txt')}`,
          provider: 'meridian-bench-fixture',
          // Task-relative path: what a reviewer opens to check a citation.
          locator: `context/${file}`,
        })
      }
    }
    return new FixtureSource({ entries })
  }

  /** Build a source over an explicit file list. */
  static fromFiles(paths: string[], options: { id?: string } = {}): FixtureSource {
    return new FixtureSource({
      ...(options.id === undefined ? {} : { id: options.id }),
      entries: paths.map((path) => ({
        id: basename(path),
        path: resolve(path),
        title: firstLine(resolve(path)) ?? basename(path),
        provider: 'file',
      })),
    })
  }

  async listDocuments(query: DocumentQuery): Promise<DocumentSummary[]> {
    const all = [...this.#entries.values()]
      .filter((entry) => (query.symbol ? entry.symbol === query.symbol || entry.id.includes(query.symbol) : true))
      .filter((entry) => (query.market ? entry.market === query.market : true))
      .filter((entry) => (query.since && entry.publishedAt ? entry.publishedAt >= query.since : true))
    const limited = query.limit === undefined ? all : all.slice(0, Math.max(0, query.limit))
    return limited.map((entry) => this.#summary(entry))
  }

  async getDocument(id: string): Promise<SourceDocument> {
    const entry = this.#entries.get(id)
    if (!entry) {
      throw new DataSourceError('not_found', this.id, `no fixture document '${id}'`)
    }
    let text: string
    try {
      text = readFileSync(entry.path, 'utf8')
    } catch (error) {
      throw new DataSourceError(
        'unavailable',
        this.id,
        `fixture '${id}' is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return {
      id: entry.id,
      title: entry.title ?? entry.id,
      text,
      provider: entry.provider ?? 'fixture',
      ...(entry.publishedAt === undefined ? {} : { publishedAt: entry.publishedAt }),
      ...(entry.locator === undefined ? {} : { meta: { locator: entry.locator } }),
    }
  }

  #summary(entry: FixtureEntry): DocumentSummary {
    return {
      id: entry.id,
      title: entry.title ?? entry.id,
      provider: entry.provider ?? 'fixture',
      ...(entry.publishedAt === undefined ? {} : { publishedAt: entry.publishedAt }),
    }
  }
}

/**
 * First non-empty line of a file, trimmed to a catalog-sized title.
 *
 * Exchange filings put their own title on line one; a catalog whose entries are
 * filenames tells the planning step nothing.
 *
 * @param path - file to peek at.
 * @returns the title, or `undefined` when the file cannot be read.
 */
function firstLine(path: string): string | undefined {
  try {
    const head = readFileSync(path, 'utf8').slice(0, 2000)
    const line = head.split('\n').find((candidate) => candidate.trim().length > 0)
    return line ? line.trim().slice(0, 60) : undefined
  } catch {
    return undefined
  }
}

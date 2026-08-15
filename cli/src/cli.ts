import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FixtureSource,
  ModelError,
  OpenAICompatibleModel,
  PeriscopeSource,
  runPipeline,
  type DataSource,
  type DocumentQuery,
  type DocumentSummary,
  type MeridianLang,
  type ModelClient,
  type PipelineOptions,
  type PipelineResult,
} from '@meridian/agent'
import { extractPdfText, loadLocalFiles, type PdfTextExtractor } from './local-source.ts'

export const EXIT_OK = 0
export const EXIT_GATE_REJECTED = 2
export const EXIT_DATA_UNAVAILABLE = 3

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_TASKS_DIR = resolve(HERE, '..', '..', 'bench', 'tasks')
const LANGS = new Set<MeridianLang>(['zh-CN', 'zh-TW', 'en'])

export interface CliIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
}

export interface CliDependencies {
  model?: ModelClient
  pipeline?: (options: PipelineOptions) => Promise<PipelineResult>
  pdfTextExtractor?: PdfTextExtractor
  periscopeSource?: DataSource
  tasksDir?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
}

interface CommonArgs {
  out?: string
  json: boolean
  lang?: MeridianLang
  /** Analysis recipe to apply; omitted means the pipeline matches one. */
  skill?: string
}

interface AskArgs extends CommonArgs {
  command: 'ask'
  question: string
  files: string[]
  source?: 'periscope'
  symbol?: string
  market?: string
}

interface BenchArgs extends CommonArgs {
  command: 'bench'
  taskId: string
}

interface HelpArgs {
  command: 'help'
}

type ParsedArgs = AskArgs | BenchArgs | HelpArgs

class CliInputError extends Error {}

/** Run one CLI invocation without terminating the host process. */
export async function runCli(
  argv: string[],
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  dependencies: CliDependencies = {},
): Promise<number> {
  let parsed: ParsedArgs
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    const message = `${humanError(error)}\n\n${usage()}`
    writeFailure(io, argv.includes('--json'), message)
    return EXIT_DATA_UNAVAILABLE
  }

  if (parsed.command === 'help') {
    io.stdout.write(usage())
    return EXIT_OK
  }

  const env = dependencies.env ?? process.env
  const model = dependencies.model ?? OpenAICompatibleModel.fromEnv(env)
  if (!model) {
    writeFailure(
      io,
      parsed.json,
      '没有可用的模型密钥。请先设置 DEEPSEEK_API_KEY；使用其他 OpenAI 兼容模型时设置 ' +
        'MERIDIAN_MODEL_API_KEY，并可用 MERIDIAN_MODEL_BASE_URL / MERIDIAN_MODEL 覆盖地址和模型名。',
    )
    return EXIT_DATA_UNAVAILABLE
  }

  const cwd = dependencies.cwd ?? process.cwd()
  let options: PipelineOptions
  try {
    options =
      parsed.command === 'ask'
        ? await askOptions(parsed, model, env, dependencies)
        : await benchOptions(parsed, model, dependencies.tasksDir ?? env.MERIDIAN_BENCH_TASKS ?? DEFAULT_TASKS_DIR)
  } catch (error) {
    writeFailure(io, parsed.json, humanError(error))
    return EXIT_DATA_UNAVAILABLE
  }

  let result: PipelineResult
  try {
    result = await (dependencies.pipeline ?? runPipeline)(
      parsed.skill === undefined ? options : { ...options, skillId: parsed.skill },
    )
  } catch (error) {
    writeFailure(io, parsed.json, modelFailure(error))
    return EXIT_DATA_UNAVAILABLE
  }

  const outputPath = resolve(cwd, parsed.out ?? 'memo.md')
  try {
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, result.markdown, 'utf8')
  } catch {
    writeFailure(io, parsed.json, `无法写入 memo：${outputPath}。请检查 --out 路径和目录权限。`)
    return EXIT_DATA_UNAVAILABLE
  }

  const summary = summarize(result)
  const retrievalFailed = result.trace.retrieval.failures.length > 0
  const exitCode = retrievalFailed
    ? EXIT_DATA_UNAVAILABLE
    : result.memo.gate.passed
      ? EXIT_OK
      : EXIT_GATE_REJECTED

  if (parsed.json) {
    io.stdout.write(
      `${JSON.stringify(
        {
          status:
            exitCode === EXIT_OK ? 'ok' : exitCode === EXIT_GATE_REJECTED ? 'gate_rejected' : 'data_unavailable',
          exitCode,
          outputPath,
          summary,
          memo: result.memo,
          markdown: result.markdown,
          trace: result.trace,
        },
        null,
        2,
      )}\n`,
    )
  } else {
    io.stdout.write(renderSummary(outputPath, summary))
  }

  if (retrievalFailed) {
    const failures = result.trace.retrieval.failures.map((failure) => `${failure.documentId}: ${failure.message}`).join('；')
    io.stderr.write(`部分数据未能取得：${failures}。请检查文件、数据源权限或网络后重试。\n`)
  } else if (!result.memo.gate.passed) {
    io.stderr.write('验证 gate 拒绝发布此 memo；文件已保留供审计，请查看 JSON 中的 gate 详情。\n')
  }
  return exitCode
}

/** Process entry point used by the installed `meridian` binary. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  process.exitCode = await runCli(argv)
}

async function askOptions(
  args: AskArgs,
  model: ModelClient,
  env: NodeJS.ProcessEnv,
  dependencies: CliDependencies,
): Promise<PipelineOptions> {
  if (args.files.length > 0) {
    const source = await loadLocalFiles(args.files, dependencies.pdfTextExtractor ?? extractPdfText)
    return {
      question: args.question,
      source,
      model,
      ...(args.lang === undefined ? {} : { lang: args.lang }),
    }
  }

  const baseUrl = env.PERISCOPE_BASE_URL ?? env.PERISCOPE_API_URL
  const apiKey = env.PERISCOPE_API_KEY
  if (!dependencies.periscopeSource && (!baseUrl || !apiKey)) {
    throw new Error(
      'Periscope 数据源未配置。请设置 PERISCOPE_API_KEY 和 PERISCOPE_BASE_URL，再运行 --source periscope。',
    )
  }
  const source =
    dependencies.periscopeSource ?? new PeriscopeSource({ baseUrl: baseUrl as string, apiKey: apiKey as string })
  const query: DocumentQuery = {
    ...(args.symbol === undefined ? {} : { symbol: args.symbol }),
    ...(args.market === undefined ? {} : { market: args.market }),
    limit: 10,
  }
  const catalog = await source.listDocuments(query)
  if (catalog.length === 0) {
    throw new Error(`没有取得 ${args.symbol ?? '该标的'} 的公告。请检查证券代码、市场和 Periscope 配置。`)
  }
  return {
    question: args.question,
    source: new CatalogSnapshotSource(source, catalog),
    model,
    ...(args.lang === undefined ? {} : { lang: args.lang }),
    catalogQuery: query,
  }
}

async function benchOptions(args: BenchArgs, model: ModelClient, tasksDir: string): Promise<PipelineOptions> {
  const taskFile = args.lang === 'zh-TW' ? 'task.zh-TW.json' : args.lang === 'en' ? 'task.en.json' : 'task.json'
  const taskPath = resolve(tasksDir, args.taskId, taskFile)
  let task: { prompt: string; lang: MeridianLang; context_files: string[] }
  try {
    task = JSON.parse(await readFile(taskPath, 'utf8')) as typeof task
  } catch {
    throw new Error(`找不到 Bench 任务 ${args.taskId}（${taskPath}）。请检查 --tasks 或 MERIDIAN_BENCH_TASKS。`)
  }
  const source = FixtureSource.fromBenchTasks(tasksDir, [args.taskId])
  const catalog = await source.listDocuments({})
  if (catalog.length === 0) throw new Error(`Bench 任务 ${args.taskId} 没有可读取的 context 文件。`)
  return {
    question: task.prompt,
    source,
    model,
    lang: args.lang ?? task.lang,
    documentIds: task.context_files.map((path) => `${args.taskId}/${path}`),
    taskId: args.taskId,
  }
}

/** Avoid a second Periscope catalog request inside the pipeline. */
class CatalogSnapshotSource implements DataSource {
  readonly id: string
  readonly #source: DataSource
  readonly #catalog: DocumentSummary[]

  constructor(source: DataSource, catalog: DocumentSummary[]) {
    this.id = source.id
    this.#source = source
    this.#catalog = catalog
  }

  async listDocuments(): Promise<DocumentSummary[]> {
    return this.#catalog
  }

  async getDocument(id: string) {
    return this.#source.getDocument(id)
  }

  async searchInstruments(query: string, market?: string) {
    return this.#source.searchInstruments?.(query, market) ?? []
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') return { command: 'help' }
  const command = argv[0]
  if (command !== 'ask' && command !== 'bench') throw new CliInputError(`未知命令：${command ?? ''}。`)
  if (argv.includes('--help') || argv.includes('-h')) return { command: 'help' }

  const values = argv.slice(1)
  const common: CommonArgs = { json: false }
  const files: string[] = []
  const positionals: string[] = []
  let source: string | undefined
  let symbol: string | undefined
  let market: string | undefined
  let taskId: string | undefined

  const take = (flag: string, index: number): string => {
    const value = values[index + 1]
    if (!value || value.startsWith('--')) throw new CliInputError(`${flag} 后需要一个值。`)
    return value
  }

  for (let index = 0; index < values.length; index += 1) {
    const token = values[index]
    if (!token.startsWith('-')) {
      positionals.push(token)
      continue
    }
    switch (token) {
      case '--json':
        common.json = true
        break
      case '--out':
        common.out = take(token, index)
        index += 1
        break
      case '--lang': {
        const lang = take(token, index) as MeridianLang
        if (!LANGS.has(lang)) throw new CliInputError('--lang 仅支持 zh-CN、zh-TW 或 en。')
        common.lang = lang
        index += 1
        break
      }
      case '--skill':
        common.skill = take(token, index)
        index += 1
        break
      case '--file':
        files.push(take(token, index))
        index += 1
        break
      case '--source':
        source = take(token, index)
        index += 1
        break
      case '--symbol':
        symbol = take(token, index)
        index += 1
        break
      case '--market':
        market = take(token, index)
        index += 1
        break
      case '--tasks':
        taskId = take(token, index)
        index += 1
        break
      default:
        throw new CliInputError(`未知参数：${token}。`)
    }
  }

  if (command === 'ask') {
    if (positionals.length !== 1 || !positionals[0]?.trim()) {
      throw new CliInputError('ask 需要且只接受一个问题，例如 meridian ask "重整走到哪一步?" --file 公告.pdf。')
    }
    if (taskId) throw new CliInputError('--tasks 只用于 meridian bench。')
    if (source && source !== 'periscope') throw new CliInputError('--source 当前仅支持 periscope。')
    if (files.length > 0 && (source || symbol || market)) {
      throw new CliInputError('--file 与 --source/--symbol/--market 不能混用。')
    }
    if (files.length === 0 && (source !== 'periscope' || !symbol)) {
      throw new CliInputError('请提供至少一个 --file，或同时提供 --symbol 和 --source periscope。')
    }
    return {
      command,
      question: positionals[0],
      files,
      ...(source === undefined ? {} : { source: 'periscope' }),
      ...(symbol === undefined ? {} : { symbol }),
      ...(market === undefined ? {} : { market }),
      ...common,
    }
  }

  if (positionals.length > 0) throw new CliInputError('bench 不接受位置参数；请使用 --tasks MB-001。')
  if (files.length > 0 || source || symbol || market) throw new CliInputError('bench 仅接受 --tasks、--lang、--out 和 --json。')
  if (!taskId) throw new CliInputError('bench 需要 --tasks MB-001。')
  if (!/^MB-\d{3}$/.test(taskId)) throw new CliInputError('--tasks 必须是单个任务编号，例如 MB-001。')
  return { command, taskId, ...common }
}

function summarize(result: PipelineResult) {
  const conclusion = result.memo.narrative
    .find((block) => block.kind === 'conclusion')
    ?.paragraphs.map((paragraph) => paragraph.text)
    .join('\n')
    .trim()
  const rejectedClaims = result.memo.audit.filter((record) => /rejected|dropped/.test(record.action)).length
  return {
    conclusion: conclusion || '没有形成可验证的结论，请查看缺口与 gate 详情。',
    verifiedClaims: result.memo.claims.filter((claim) => claim.type !== 'fact' || !claim.unverifiable).length,
    rejectedClaims,
    gaps: result.memo.openQuestions,
  }
}

function renderSummary(
  outputPath: string,
  summary: { conclusion: string; verifiedClaims: number; rejectedClaims: number; gaps: string[] },
): string {
  const gaps = summary.gaps.length > 0 ? summary.gaps.map((gap) => `- ${gap}`).join('\n') : '- 无'
  return [
    `Memo 已写入 ${outputPath}`,
    '',
    '结论',
    summary.conclusion,
    '',
    `验证统计：${summary.verifiedClaims} claims 验证 / ${summary.rejectedClaims} 拒绝`,
    '缺口',
    gaps,
    '',
  ].join('\n')
}

function modelFailure(error: unknown): string {
  const message = humanError(error)
  if (error instanceof ModelError || /model|模型/i.test(message)) {
    if (/abort|timeout|timed out|超时/i.test(message)) {
      return '模型请求超时。请检查网络和 MERIDIAN_MODEL_BASE_URL；必要时稍后重试。'
    }
    if (/HTTP 401|HTTP 403|unauthor/i.test(message)) {
      return '模型拒绝了密钥。请检查 DEEPSEEK_API_KEY 或 MERIDIAN_MODEL_API_KEY 是否有效。'
    }
    return `模型调用失败：${message}。请检查模型地址、模型名和 API key 后重试。`
  }
  return `无法生成 memo：${message}`
}

function humanError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function writeFailure(io: CliIo, json: boolean, message: string): void {
  if (json) {
    io.stdout.write(`${JSON.stringify({ status: 'data_unavailable', exitCode: EXIT_DATA_UNAVAILABLE, error: message })}\n`)
  } else {
    io.stderr.write(`${message}\n`)
  }
}

function usage(): string {
  return `用法：
  meridian ask "问题" --file 公告.pdf [--file 公告.txt] [--out memo.md] [--json]
  meridian ask "问题" --symbol 600491 --source periscope [--lang zh-CN] [--out memo.md]
  可选 --skill <id> 指定分析技能（不指定时自动匹配，所用技能记入 memo provenance）
  meridian bench --tasks MB-001 [--lang zh-CN] [--out memo.md] [--json]

退出码：0 正常；2 验证 gate 拒绝；3 数据、配置或模型不可用。
`
}

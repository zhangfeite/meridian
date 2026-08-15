#!/usr/bin/env node
/**
 * `meridian-memo` — run the seven-step pipeline and write a memo.
 *
 * Three ways in:
 *
 * ```sh
 * # 1. A Meridian Bench task, from its fixture documents
 * node bin/meridian-memo.ts --task MB-001 --out ./runs/MB-001
 *
 * # 2. Ad-hoc, over local filings
 * node bin/meridian-memo.ts --question "这次减值计提了多少?" --files ./ann.txt --out ./runs/adhoc
 *
 * # 3. As a Meridian Bench agent (stdin/stdout protocol) — this is the dogfood path:
 * #    the benchmark scores the pipeline exactly as it scores any third-party agent.
 * bench run --agent "node .../bin/meridian-memo.ts --bench" --protocol subprocess \
 *           --tasks MB-001,MB-002,MB-003 --timeout 900 --retries 0
 * ```
 *
 * In `--bench` mode the pipeline ignores the context the harness inlines into
 * its prompt and retrieves the same documents itself through `FixtureSource` —
 * otherwise the run would be testing a prompt, not a pipeline.
 *
 * @module @meridian/agent/bin/meridian-memo
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OpenAICompatibleModel } from '../src/model.ts'
import { auditEnabled, runPipeline, type PipelineResult } from '../src/pipeline.ts'
import { EdgarSource } from '../src/source/edgar.ts'
import { FixtureSource } from '../src/source/fixture.ts'
import { PeriscopeSource } from '../src/source/periscope.ts'
import type { MeridianLang } from '../src/contract.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_TASKS_DIR = resolve(HERE, '..', '..', 'bench', 'tasks')

interface Args {
  task?: string
  bench: boolean
  question?: string
  files?: string[]
  tasksDir: string
  out?: string
  lang?: MeridianLang
  /** Apply this analysis recipe instead of matching one. */
  skill?: string
  /** `--no-audit` (or `MERIDIAN_AUDIT=off`) turns off the step-7b checklist audit. */
  audit: boolean
  /** `fixture` (default) | `periscope` | `edgar` */
  source?: string
  symbol?: string
  market?: string
  limit?: number
}

function parseArgs(argv: string[]): Args {
  const args: Args = { bench: false, audit: auditEnabled(process.env), tasksDir: process.env.MERIDIAN_BENCH_TASKS ?? DEFAULT_TASKS_DIR }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    switch (flag) {
      case '--bench':
        args.bench = true
        break
      case '--task':
        args.task = value
        index += 1
        break
      case '--question':
        args.question = value
        index += 1
        break
      case '--files':
        args.files = (value ?? '').split(',').filter(Boolean)
        index += 1
        break
      case '--tasks-dir':
        args.tasksDir = resolve(value ?? '')
        index += 1
        break
      case '--out':
        args.out = resolve(value ?? '')
        index += 1
        break
      case '--lang':
        args.lang = value as MeridianLang
        index += 1
        break
      case '--skill':
        args.skill = value
        index += 1
        break
      case '--no-audit':
        args.audit = false
        break
      case '--source':
        args.source = value
        index += 1
        break
      case '--symbol':
        args.symbol = value
        index += 1
        break
      case '--market':
        args.market = value
        index += 1
        break
      case '--limit':
        args.limit = Number(value)
        index += 1
        break
      default:
        if (flag?.startsWith('--')) throw new Error(`unknown flag ${flag}`)
    }
  }
  return args
}

/** Read a bench `task.json`. */
function readTask(tasksDir: string, taskId: string): { prompt: string; lang: MeridianLang; contextFiles: string[] } {
  const raw = JSON.parse(readFileSync(join(tasksDir, taskId, 'task.json'), 'utf8')) as {
    prompt: string
    lang: MeridianLang
    context_files: string[]
  }
  return { prompt: raw.prompt, lang: raw.lang, contextFiles: raw.context_files }
}

/** Persist the memo, its Markdown, and the step-by-step trace. */
function writeArtifacts(directory: string, result: PipelineResult): void {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'memo.md'), result.markdown, 'utf8')
  writeFileSync(join(directory, 'memo.json'), `${JSON.stringify(result.memo, null, 2)}\n`, 'utf8')
  writeFileSync(join(directory, 'trace.json'), `${JSON.stringify(result.trace, null, 2)}\n`, 'utf8')
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const model = OpenAICompatibleModel.fromEnv()
  if (!model) {
    process.stderr.write('DEEPSEEK_API_KEY (or MERIDIAN_MODEL_API_KEY) is required\n')
    return 2
  }

  if (args.bench) {
    const request = JSON.parse(readFileSync(0, 'utf8')) as { task_id?: string; lang?: MeridianLang; prompt?: string }
    const taskId = request.task_id
    if (!taskId) {
      process.stderr.write('bench request has no task_id\n')
      return 2
    }
    const task = readTask(args.tasksDir, taskId)
    const source = FixtureSource.fromBenchTasks(args.tasksDir, [taskId])
    const documentIds = task.contextFiles.map((relative) => `${taskId}/${relative}`)
    const result = await runPipeline({
      question: task.prompt,
      source,
      model,
      lang: request.lang ?? task.lang,
      documentIds,
      taskId,
      ...(args.skill === undefined ? {} : { skillId: args.skill }),
      ...(args.audit ? {} : { audit: false }),
    })
    const outRoot = process.env.MERIDIAN_MEMO_OUT
    if (outRoot) writeArtifacts(join(resolve(outRoot), taskId), result)
    process.stdout.write(`${JSON.stringify({ output: result.markdown })}\n`)
    return 0
  }

  if (args.task) {
    const task = readTask(args.tasksDir, args.task)
    const source = FixtureSource.fromBenchTasks(args.tasksDir, [args.task])
    const result = await runPipeline({
      question: args.question ?? task.prompt,
      source,
      model,
      lang: args.lang ?? task.lang,
      documentIds: task.contextFiles.map((relative) => `${args.task}/${relative}`),
      taskId: args.task,
      ...(args.skill === undefined ? {} : { skillId: args.skill }),
      ...(args.audit ? {} : { audit: false }),
      onStep: (step, detail) => process.stderr.write(`[${step}] ${JSON.stringify(detail)}\n`),
    })
    if (args.out) writeArtifacts(args.out, result)
    else process.stdout.write(result.markdown)
    return result.memo.gate.passed ? 0 : 1
  }

  // Live retrieval: no context is handed in, the pipeline discovers the filings
  // itself through a real data source.
  if (args.question && (args.source === 'periscope' || args.source === 'edgar')) {
    const source =
      args.source === 'periscope'
        ? PeriscopeSource.fromEnv()
        : new EdgarSource({ userAgent: process.env.MERIDIAN_EDGAR_USER_AGENT ?? '' })
    if (!source) {
      process.stderr.write('PERISCOPE_API_URL and PERISCOPE_API_KEY are required for --source periscope\n')
      return 2
    }
    const result = await runPipeline({
      question: args.question,
      source,
      model,
      ...(args.lang === undefined ? {} : { lang: args.lang }),
      ...(args.skill === undefined ? {} : { skillId: args.skill }),
      ...(args.audit ? {} : { audit: false }),
      catalogQuery: {
        ...(args.symbol === undefined ? {} : { symbol: args.symbol }),
        ...(args.market === undefined ? {} : { market: args.market }),
        limit: args.limit ?? 10,
      },
      onStep: (step, detail) => process.stderr.write(`[${step}] ${JSON.stringify(detail)}\n`),
    })
    if (args.out) writeArtifacts(args.out, result)
    else process.stdout.write(result.markdown)
    return result.memo.gate.passed ? 0 : 1
  }

  if (args.question && args.files?.length) {
    const source = FixtureSource.fromFiles(args.files)
    const result = await runPipeline({
      question: args.question,
      source,
      model,
      ...(args.lang === undefined ? {} : { lang: args.lang }),
      ...(args.skill === undefined ? {} : { skillId: args.skill }),
      ...(args.audit ? {} : { audit: false }),
      onStep: (step, detail) => process.stderr.write(`[${step}] ${JSON.stringify(detail)}\n`),
    })
    if (args.out) writeArtifacts(args.out, result)
    else process.stdout.write(result.markdown)
    return result.memo.gate.passed ? 0 : 1
  }

  process.stderr.write(
    'usage: meridian-memo (--task <MB-XXX> | --question <text> --files <a.txt,b.txt> | --bench) [--out <dir>]\n',
  )
  return 2
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`meridian-memo: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exit(2)
  },
)

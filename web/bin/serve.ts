#!/usr/bin/env node

import { createWebServer } from '../src/index.ts'

interface ServeOptions {
  host: string
  port: number
}

function usage(): string {
  return [
    'Meridian Web — local, evidence-first research UI',
    '',
    'Usage: node web/bin/serve.ts [--host 127.0.0.1] [--port 4317]',
    '',
    'BYO model environment:',
    '  DEEPSEEK_API_KEY',
    '  MERIDIAN_MODEL_API_KEY / MERIDIAN_MODEL_BASE_URL / MERIDIAN_MODEL',
    '',
  ].join('\n')
}

function parseArgs(argv: string[]): ServeOptions | undefined {
  if (argv.includes('--help') || argv.includes('-h')) return undefined
  let host = '127.0.0.1'
  let port = 4317
  const take = (flag: string, index: number): string => {
    const value = argv[index + 1]
    if (!value || value.startsWith('-')) throw new Error(`${flag} 后需要一个值。`)
    return value
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--host') {
      host = take(token, index)
      index += 1
    } else if (token === '--port') {
      const value = take(token, index)
      port = Number(value)
      index += 1
    } else {
      throw new Error(`未知参数：${token}`)
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port 必须是 1 到 65535 之间的整数。')
  if (!host.trim()) throw new Error('--host 不能为空。')
  return { host, port }
}

try {
  const options = parseArgs(process.argv.slice(2))
  if (!options) {
    process.stdout.write(usage())
  } else {
    const server = createWebServer()
    server.listen(options.port, options.host, () => {
      const loopback = new Set(['127.0.0.1', '::1', 'localhost']).has(options.host)
      process.stdout.write(`[meridian-web] listening on http://${options.host}:${options.port}\n`)
      if (!loopback) {
        process.stderr.write(
          `[meridian-web] WARNING: --host ${options.host} exposes uploaded documents and memo content beyond this machine. Put authentication and TLS in front of the service.\n`,
        )
      } else {
        process.stdout.write('[meridian-web] local-only default: only this machine can connect.\n')
      }
    })
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}`)
  process.exitCode = 1
}

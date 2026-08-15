/**
 * WP-M-ADAPTER spike evidence generator.
 *
 * Runs the end-to-end acceptance path on a REAL DeepSeek Harness runtime:
 * register a mock financial tool through `AgentKernel` → the model calls it →
 * the model summarizes the result. Prints a transcript plus a verdict block so
 * the run can be pasted into a report without being paraphrased.
 *
 * Usage: `node scripts/spike-dsh.ts` (needs Node >=22.19 and `DEEPSEEK_API_KEY`).
 */

import { DshKernel, dshUnavailableReason } from '../src/dsh-kernel.ts'
import type { KernelEvent } from '../src/kernel.ts'
import {
  SPIKE_PROMPT,
  announcementsTool,
  callLog,
} from '../test/fixtures/announcements-tool.ts'

const blocked = dshUnavailableReason()
if (blocked) {
  process.stderr.write(`spike-dsh: cannot run — ${blocked}\n`)
  process.exit(2)
}

const kernel = new DshKernel({ model: process.env.MERIDIAN_DSH_MODEL ?? 'deepseek-v4-flash' })
kernel.registerTool(announcementsTool)
kernel.onEvent((event: KernelEvent) => {
  process.stdout.write(`  [event] ${event.type}${'name' in event ? ` ${event.name}` : ''}\n`)
})

const startedAt = Date.now()
process.stdout.write(`prompt: ${SPIKE_PROMPT}\n\n`)

try {
  const result = await kernel.run({ prompt: SPIKE_PROMPT, lang: 'zh-CN' })
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)

  process.stdout.write(`\n--- tool call log (witnessed inside the tool body) ---\n`)
  process.stdout.write(`${JSON.stringify(callLog, null, 2)}\n`)

  process.stdout.write(`\n--- kernel tool calls ---\n`)
  for (const call of result.toolCalls) {
    process.stdout.write(
      `  ${call.name}(${JSON.stringify(call.args)}) ok=${call.ok}\n    → ${String(call.result).slice(0, 400)}\n`,
    )
  }

  process.stdout.write(`\n--- final response ---\n${result.text}\n`)

  const log = await kernel.sessionLog(result.sessionId)
  process.stdout.write(
    `\n--- verdict ---\n` +
      `kernel:            ${kernel.id}\n` +
      `session:           ${result.sessionId}\n` +
      `end reason:        ${result.reason}\n` +
      `elapsed:           ${elapsed}s\n` +
      `tool body invoked: ${callLog.length} time(s), args=${JSON.stringify(callLog)}\n` +
      `tool calls seen:   ${result.toolCalls.length}\n` +
      `events:            ${result.events.map((event) => event.type).join(' → ')}\n` +
      `sessionLog len:    ${log.length}\n` +
      `usage:             ${JSON.stringify(result.usage ?? null)}\n`,
  )
} finally {
  await kernel.close()
}

/**
 * The `AgentKernel` contract suite: ONE suite, run against every implementation.
 *
 * A test that only passes on `MockKernel` is not a contract — it is a mock
 * detail. A test that only passes on `DshKernel` is dsh leaking through the
 * seam. So both implementations run this file verbatim, and the assertions are
 * written to the interface, never to a backend's internals.
 *
 * @module test/contract
 */

import { describe, expect, it } from 'vitest'
import type { AgentKernel, KernelEvent } from '../src/kernel.ts'
import { ToolRegistrationError, UnknownSessionError } from '../src/kernel.ts'
import {
  SPIKE_PROMPT,
  TITLE_KEYWORDS,
  announcementsTool,
  callLog,
  resetCallLog,
} from './fixtures/announcements-tool.ts'

export { SPIKE_PROMPT }

/** How a suite obtains a fresh kernel and how long it may take. */
export interface ContractHarness {
  /** Human label used in the suite name. */
  label: string
  /** Build a kernel with no tools registered. */
  create(): Promise<AgentKernel> | AgentKernel
  /** Per-test timeout (a real model needs far more than a stub). */
  timeoutMs: number
  /**
   * `true` when a real language model drives the loop, so exact tool-call
   * counts and stub-only phrasing cannot be asserted.
   */
  modelDriven: boolean
}

/**
 * Register the contract suite for one implementation.
 *
 * @param harness - how to build the kernel under test.
 */
export function describeKernelContract(harness: ContractHarness): void {
  describe(`AgentKernel contract — ${harness.label}`, () => {
    it(
      'runs a tool round-trip end to end and reports it through run/onEvent/sessionLog',
      async () => {
        resetCallLog()
        const kernel = await harness.create()
        const observed: KernelEvent[] = []
        const off = kernel.onEvent((event) => observed.push(event))
        try {
          kernel.registerTool(announcementsTool)
          const result = await kernel.run({ prompt: SPIKE_PROMPT, lang: 'zh-CN' })

          // 1. The tool body actually executed, with the code from the prompt.
          expect(callLog.length).toBeGreaterThanOrEqual(1)
          expect(callLog[0].symbol).toBe('000001')

          // 2. The kernel reported the round-trip.
          const call = result.toolCalls.find((entry) => entry.name === 'list_announcements')
          expect(call, 'expected a list_announcements tool call').toBeTruthy()
          expect(call?.ok).toBe(true)

          // 3. The answer is grounded in the tool result, not invented.
          const keywords = TITLE_KEYWORDS['000001']
          const hits = keywords.filter((keyword) => result.text.includes(keyword))
          expect(hits.length, `final text should quote titles, got: ${result.text}`)
            .toBeGreaterThanOrEqual(1)

          // 4. Event ordering is a real contract, not an accident.
          const types = result.events.map((event) => event.type)
          expect(types[0]).toBe('run.start')
          expect(types.at(-1)).toBe('run.end')
          const callIndex = types.indexOf('tool.call')
          const resultIndex = types.indexOf('tool.result')
          expect(callIndex).toBeGreaterThan(-1)
          expect(resultIndex).toBeGreaterThan(callIndex)

          // 5. `onEvent` sees exactly what `run` returned.
          expect(observed.map((event) => event.type)).toEqual(types)

          // 6. `sessionLog` replays the same run durably.
          const log = await kernel.sessionLog(result.sessionId)
          expect(log.map((event) => event.type)).toEqual(types)
          expect(result.reason).toBe('idle')
        } finally {
          off()
          await kernel.close()
        }
      },
      harness.timeoutMs,
    )

    it('rejects a duplicate tool name and honors the unregister handle', async () => {
      const kernel = await harness.create()
      try {
        const dispose = kernel.registerTool(announcementsTool)
        expect(() => kernel.registerTool(announcementsTool)).toThrow(ToolRegistrationError)
        dispose()
        // After disposal the name is free again.
        kernel.registerTool(announcementsTool)()
      } finally {
        await kernel.close()
      }
    })

    it('rejects a structurally invalid tool', async () => {
      const kernel = await harness.create()
      try {
        expect(() =>
          kernel.registerTool({
            ...announcementsTool,
            name: 'not a valid name',
          } as never),
        ).toThrow(ToolRegistrationError)
        expect(() =>
          kernel.registerTool({
            ...announcementsTool,
            name: 'missing_required',
            inputSchema: { type: 'object', properties: {}, required: ['symbol'] },
          } as never),
        ).toThrow(ToolRegistrationError)
      } finally {
        await kernel.close()
      }
    })

    it('throws UnknownSessionError for a session it never ran', async () => {
      const kernel = await harness.create()
      try {
        await expect(kernel.sessionLog('never-existed')).rejects.toBeInstanceOf(
          UnknownSessionError,
        )
      } finally {
        await kernel.close()
      }
    })

    it('is closed terminally: registerTool after close throws', async () => {
      const kernel = await harness.create()
      await kernel.close()
      await kernel.close() // idempotent
      expect(() => kernel.registerTool(announcementsTool)).toThrow()
    })
  })
}

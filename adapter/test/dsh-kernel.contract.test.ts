/**
 * The SAME contract suite bound to `DshKernel` — a real DeepSeek Harness
 * subprocess, a real DeepSeek model, real MCP tool calls.
 *
 * Skips (loudly, naming the reason) when the environment cannot support it:
 * no `DEEPSEEK_API_KEY`, or a Node older than dsh's `^22.19.0 || >=24` engine
 * range. A skip is honest; a silent fallback to `MockKernel` would not be.
 *
 * @module test/dsh-kernel.contract.test
 */

import { describe } from 'vitest'
import { DshKernel, dshUnavailableReason } from '../src/dsh-kernel.ts'
import { describeKernelContract } from './contract.ts'

const blocked = dshUnavailableReason()

if (blocked) {
  describe.skip(`AgentKernel contract — DshKernel (skipped: ${blocked})`, () => {})
} else {
  describeKernelContract({
    label: 'DshKernel',
    create: () => new DshKernel({ model: process.env.MERIDIAN_DSH_MODEL ?? 'deepseek-v4-flash' }),
    // A cold start boots a Node subprocess, an MCP handshake, and at least two
    // model round-trips. 180s is not generous.
    timeoutMs: 180_000,
    modelDriven: true,
  })
}

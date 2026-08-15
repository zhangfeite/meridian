/**
 * Contract suite bound to `MockKernel`. Always runs — no network, no key.
 *
 * @module test/mock-kernel.contract.test
 */

import { MockKernel } from '../src/mock-kernel.ts'
import { describeKernelContract } from './contract.ts'

describeKernelContract({
  label: 'MockKernel',
  create: () => new MockKernel(),
  timeoutMs: 10_000,
  modelDriven: false,
})

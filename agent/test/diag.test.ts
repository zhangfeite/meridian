/** Bench diagnostics are a file-only sidecar: never part of the answer protocol. */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { benchDiagnostic, benchResponse, writeBenchDiagnostic } from '../bin/meridian-memo.ts'
import type { PipelineResult } from '../src/pipeline.ts'

const syntheticResult = {
  memo: {
    audit: [{ step: 'extract', action: 'claim_rejected_unverifiable_quote', detail: 'quote not located' }],
  },
  trace: {
    extraction: {
      rejected: [{ text: 'unsupported claim', reason: 'quote not located', round: 'initial' }],
      notes: ['document read partially'],
      spans: [{ text: 'claim', documentId: 'D1', from: 'short', to: 'whole sentence', path: 'widened' }],
    },
  },
} as unknown as PipelineResult

test('bench diagnostic sidecar has the declared schema and does not alter protocol bytes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'meridian-diag-'))
  const protocolBefore = Buffer.from(benchResponse('# memo\n'))
  try {
    writeBenchDiagnostic(directory, 'MB-TEST', 'en', syntheticResult)

    const sidecar = JSON.parse(readFileSync(join(directory, 'MB-TEST.en.diag.json'), 'utf8'))
    assert.deepEqual(sidecar, benchDiagnostic('MB-TEST', 'en', syntheticResult))
    assert.deepEqual(Object.keys(sidecar), ['task_id', 'lang', 'rejected', 'notes', 'spans', 'audit'])
    assert.equal(sidecar.task_id, 'MB-TEST')
    assert.equal(sidecar.lang, 'en')
    assert.equal(sidecar.rejected[0].text, 'unsupported claim')
    assert.equal(sidecar.notes[0], 'document read partially')
    assert.equal(sidecar.spans[0].documentId, 'D1')
    assert.equal(sidecar.audit[0].action, 'claim_rejected_unverifiable_quote')

    // The bench subprocess protocol is constructed independently of the file
    // sidecar, so enabling diagnostics cannot change a single stdout byte.
    const protocolAfter = Buffer.from(benchResponse('# memo\n'))
    assert.deepEqual(protocolAfter, protocolBefore)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

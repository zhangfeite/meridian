/**
 * Tests for the CI red line itself.
 *
 * A guard nobody has watched fail is not a guard. These tests plant a violation
 * in a scratch tree and assert the script exits non-zero and names the file, and
 * assert the real `meridian/` tree is clean.
 *
 * @module test/dsh-boundary.test
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = fileURLToPath(new URL('../scripts/check-dsh-boundary.mjs', import.meta.url))
const MERIDIAN_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * Run the checker over one directory.
 * @param root - the tree to scan.
 * @returns exit status and combined output.
 */
function runCheck(root: string): { code: number; output: string } {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' })
    return { code: 0, output: stdout }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return { code: failure.status ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

describe('dsh dependency boundary', () => {
  let scratch: string

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'meridian-boundary-'))
  })

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  it('passes on the real meridian/ tree', () => {
    const { code, output } = runCheck(MERIDIAN_ROOT)
    expect(output, output).toContain('dsh boundary OK')
    expect(code).toBe(0)
  })

  it('fails when financial code imports dsh directly', () => {
    mkdirSync(join(scratch, 'skills'), { recursive: true })
    writeFileSync(
      join(scratch, 'skills', 'earnings.ts'),
      "import { defineTool } from '@deepseek-ai/dsh-tools'\nexport const x = defineTool\n",
      'utf8',
    )
    const { code, output } = runCheck(scratch)
    expect(code, output).toBe(1)
    expect(output).toContain('skills/earnings.ts')
    expect(output).toContain('@deepseek-ai/dsh-tools')
  })

  it('fails on a dsh package name smuggled in as a config string', () => {
    mkdirSync(join(scratch, 'bench'), { recursive: true })
    writeFileSync(
      join(scratch, 'bench', 'compose.mjs'),
      'export const row = { name: "@deepseek-ai/dsh-llm-deepseek" }\n',
      'utf8',
    )
    const { code, output } = runCheck(scratch)
    expect(code).toBe(1)
    expect(output).toContain('bench/compose.mjs')
  })

  it('tolerates prose that merely names dsh', () => {
    mkdirSync(join(scratch, 'docs-code'), { recursive: true })
    writeFileSync(
      join(scratch, 'docs-code', 'note.ts'),
      '// We deliberately do NOT import @deepseek-ai/dsh-tools here.\nexport const ok = true\n',
      'utf8',
    )
    expect(runCheck(scratch).code).toBe(0)
  })

  it('ignores node_modules and build output', () => {
    mkdirSync(join(scratch, 'node_modules', '@deepseek-ai'), { recursive: true })
    writeFileSync(
      join(scratch, 'node_modules', '@deepseek-ai', 'index.js'),
      "export * from '@deepseek-ai/dsh-base'\n",
      'utf8',
    )
    mkdirSync(join(scratch, 'lib'), { recursive: true })
    writeFileSync(
      join(scratch, 'lib', 'built.js'),
      "import '@deepseek-ai/dsh-sdk-client'\n",
      'utf8',
    )
    expect(runCheck(scratch).code).toBe(0)
  })
})

/**
 * Gold text must never live in pipeline source — prompts included.
 *
 * The skills anti-cheat scan covers recipe files; M-S8 found a gold answer
 * hardcoded in gapChallengePrompt since M-S3 (the skills scan never looked at
 * prompts.ts). This test closes that blind spot: no ≥8-character run from any
 * bench gold quote may appear anywhere under src/.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const AGENT_SRC = resolve(import.meta.dirname, '..', 'src')
const TASKS_DIR = resolve(import.meta.dirname, '..', '..', 'bench', 'tasks')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (full.endsWith('.ts')) out.push(full)
  }
  return out
}

function goldStrings(): string[] {
  const found: string[] = []
  for (const task of readdirSync(TASKS_DIR)) {
    const dir = join(TASKS_DIR, task)
    if (!statSync(dir).isDirectory()) continue
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('gold') || !name.endsWith('.json')) continue
      const gold = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      for (const item of gold.numbers ?? []) {
        for (const key of ['verbatim', 'source_quote']) {
          const value = item[key]
          if (typeof value === 'string' && !value.startsWith('(derived)')) found.push(value)
        }
      }
      for (const item of gold.claim_evidence ?? []) {
        if (typeof item.evidence_quote === 'string') found.push(item.evidence_quote)
      }
    }
  }
  return found
}

test('no gold quote fragment (≥8 chars) appears anywhere in agent src', () => {
  const sources = walk(AGENT_SRC).map((file) => ({ file, text: readFileSync(file, 'utf8') }))
  const offences: string[] = []
  for (const quote of goldStrings()) {
    const clean = quote.replace(/\s+/g, '')
    if (clean.length < 8) continue
    for (let start = 0; start + 8 <= clean.length; start += 4) {
      const window = clean.slice(start, start + 8)
      for (const { file, text } of sources) {
        if (text.replace(/\s+/g, '').includes(window)) {
          offences.push(`${file}: …${window}…`)
        }
      }
    }
  }
  assert.deepEqual([...new Set(offences)], [])
})

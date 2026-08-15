#!/usr/bin/env node
/**
 * dsh dependency boundary check — a CI red line, not a lint suggestion.
 *
 * Rule (PRD §8, spec-meridian-s1 §3.3): no Meridian source file may reference a
 * `@deepseek-ai/*` package, except the small allowlist that IS the DshKernel
 * implementation. Exit code 1 on any violation.
 *
 * Scope defaults to the whole `meridian/` tree so bench runners, skills, and
 * future financial packages are covered the moment they land — the check is
 * meant to catch the import *before* it becomes load-bearing.
 *
 * Usage: `node scripts/check-dsh-boundary.mjs [rootDir]`
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const DEFAULT_ROOT = resolve(HERE, '..', '..')
const root = resolve(process.argv[2] ?? DEFAULT_ROOT)

/**
 * The ONLY files allowed to touch dsh, expressed relative to `meridian/`.
 * Every addition here widens the migration blast radius — treat a pull request
 * that grows this list as an architecture change, not a chore.
 */
const ALLOWLIST = new Set([
  // The kernel implementation: the whole point of the seam.
  'adapter/src/dsh-kernel.ts',
  // The runtime bin it launches (composed from published dsh boot helpers).
  'adapter/runtime/dsh-runtime-bin.mjs',
  // This checker's own tests, whose FIXTURES are deliberate violations. Not an
  // exemption for test code in general — only for the file that plants the
  // violations this script must catch.
  'adapter/test/dsh-boundary.test.ts',
])

/** Paths never scanned. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'lib', 'dist', 'coverage', '.venv'])

/** File extensions scanned. */
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx', '.py']

/**
 * Any textual reference to a dsh package: static import, dynamic import,
 * `require`, or a bare string in a config-building template. A string is enough
 * — `cordis.yml` composition text is exactly how dsh would sneak back in.
 */
const DSH_REFERENCE = /@deepseek-ai\/[a-z0-9-]+/gi

/**
 * Lines that are purely a comment. Prose may name dsh — this file does, and so
 * does every doc comment explaining WHY the boundary exists. A commented-out
 * import creates no dependency, so skipping comment lines removes false
 * positives without weakening the rule: a real import, a `require`, or a
 * package name inside a config template is never a comment line.
 */
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#)/

/**
 * Recursively collect scannable files.
 * @param dir - directory to walk.
 * @param sink - accumulator.
 * @returns absolute file paths.
 */
function walk(dir, sink = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = resolve(dir, entry)
    if (statSync(full).isDirectory()) walk(full, sink)
    else if (EXTENSIONS.some((extension) => entry.endsWith(extension))) sink.push(full)
  }
  return sink
}

const violations = []
for (const file of walk(root)) {
  const rel = relative(root, file).split(sep).join('/')
  if (ALLOWLIST.has(rel)) continue
  const text = readFileSync(file, 'utf8')
  const matches = [...new Set(text.match(DSH_REFERENCE) ?? [])]
  if (matches.length === 0) continue
  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    if (COMMENT_LINE.test(line)) continue
    const hit = line.match(DSH_REFERENCE)
    if (hit) violations.push({ rel, line: index + 1, text: line.trim(), packages: hit })
  }
}

if (violations.length > 0) {
  process.stderr.write(
    'dsh boundary violation: Meridian code outside the adapter references dsh directly.\n' +
      'The financial layer must go through @meridian/kernel-adapter (AgentKernel).\n\n',
  )
  for (const violation of violations) {
    process.stderr.write(`  ${violation.rel}:${violation.line}\n      ${violation.text}\n`)
  }
  process.stderr.write(
    `\n${violations.length} violation(s). Allowed files: ${[...ALLOWLIST].join(', ')}\n`,
  )
  process.exit(1)
}

process.stdout.write(
  `dsh boundary OK — scanned ${relative(process.cwd(), root) || '.'}; ` +
    `${ALLOWLIST.size} allowlisted file(s) may import @deepseek-ai/*.\n`,
)

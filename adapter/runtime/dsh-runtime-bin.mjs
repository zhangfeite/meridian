#!/usr/bin/env node
/**
 * Meridian's dsh runtime bin.
 *
 * `@deepseek-ai/dsh-sdk-client` spawns "the runtime executable" and drives it
 * over stdio JSON-RPC, but the published npm surface ships no such executable
 * for TypeScript consumers — the `dsh` CLI boots *profiles* out of `$DSH_HOME`,
 * and the `cordis` bin hardcodes `./cordis.yml` while importing loader plugins
 * that `@deepseek-ai/cordis` does not depend on. So we supply the bin: eleven
 * lines over the published `@deepseek-ai/dsh-app-boot` helpers.
 *
 * This file and `src/dsh-kernel.ts` are the ONLY places in Meridian allowed to
 * import `@deepseek-ai/*`. See `scripts/check-dsh-boundary.mjs`.
 *
 * Usage: `node dsh-runtime-bin.mjs <absolute cordis.yml>`
 *
 * stdout is the JSON-RPC channel — every diagnostic here goes to stderr.
 */

import { appendFileSync } from 'node:fs'
import { boot, installFailLoud, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

const BIN = 'meridian-dsh-runtime'

// The TS SDK client captures the child's stderr into a bounded tail it only
// surfaces when the runtime dies unexpectedly — there is no live stderr hook, so
// a booting-but-misbehaving runtime is completely silent from the parent. Set
// MERIDIAN_DSH_LOG=<path> to tee this process's diagnostics to a file instead.
if (process.env.MERIDIAN_DSH_LOG) {
  const logPath = process.env.MERIDIAN_DSH_LOG
  const write = process.stderr.write.bind(process.stderr)
  process.stderr.write = (chunk, ...rest) => {
    try {
      appendFileSync(logPath, typeof chunk === 'string' ? chunk : Buffer.from(chunk))
    } catch {
      // A broken log sink must never take the runtime down.
    }
    return write(chunk, ...rest)
  }
}

installFailLoud(BIN)

const configArg = process.argv[2]
if (!configArg) {
  process.stderr.write(`${BIN}: usage: ${BIN} <cordis.yml>\n`)
  process.exit(2)
}

// `bareModuleBaseUrl` anchors bare `@deepseek-ai/dsh-*` plugin names to THIS
// package's node_modules. Without it the Loader resolves them relative to the
// config file, which lives in a per-run temp directory with no node_modules —
// the first failure mode we hit, and a silent one until the tree fails to settle.
await boot(
  BIN,
  resolveConfigPath(configArg, process.env.DSH_SNAPSHOT, process.cwd()),
  undefined,
  undefined,
  import.meta.url,
)

// `boot()` resolves only after the whole plugin tree has loaded AND activated,
// which is the only trustworthy "tools are registered" moment. The JSON-RPC
// server, by contrast, starts answering as soon as its own entry activates, so
// without this ping the parent cannot tell a settled runtime from one whose MCP
// client is still syncing. Best-effort: a failed ping must not kill the runtime,
// because the parent's own timeout is the backstop.
if (process.env.MERIDIAN_READY_URL) {
  try {
    await fetch(process.env.MERIDIAN_READY_URL, { method: 'POST' })
  } catch (error) {
    process.stderr.write(`${BIN}: ready ping failed: ${String(error)}\n`)
  }
}

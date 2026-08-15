# `@meridian/kernel-adapter`

The agent-loop seam for Meridian. Meridian's financial layer depends on the
`AgentKernel` interface and on nothing else; DeepSeek Harness (`dsh`) is one
implementation behind it.

This is not architecture astronautics. dsh shipped on 2026-08-13 as a *developer
preview* whose own README says, in capitals, that there will be
compatibility-breaking changes. PRD §8 budgets roughly two weeks to walk away
from it if the upgrade cost gets out of hand. That budget is only credible if the
blast radius is one file — so it is one file, and CI enforces it.

---

## 1. Pinned dsh version

| Fact | Value |
|---|---|
| Upstream repo | <https://github.com/deepseek-ai/deepseek-harness> |
| Repo created | 2026-08-13T11:56:32Z |
| `master` HEAD read for this work | `47f943859bef60e4160492346772ded9b24f765a` (pushed 2026-08-13T13:00:21Z) |
| Git tags / GitHub releases | **none** — the repo has never been tagged |
| Source-tree version field | `0.1.0-rc.5` (root `package.json`, `private: true`) |
| npm version we pin | **`0.1.0-rc.6`**, published 2026-08-13T12:35:03.812Z |
| License | MIT |
| Node engines | `^22.19.0 \|\| >=24.0.0` |

Every dsh package is pinned **exactly** (no `^`, no `~`) in `package.json`, and
`package-lock.json` is committed. Resolved integrity hashes:

| Package | Version | Integrity (prefix) |
|---|---|---|
| `@deepseek-ai/dsh-sdk-client` | 0.1.0-rc.6 | `sha512-7y8+dsTljsvHpyZeENeTc…` |
| `@deepseek-ai/dsh-sdk-jsonrpc-server` | 0.1.0-rc.6 | `sha512-VQsoRpqUG55+T0kQtX82P…` |
| `@deepseek-ai/dsh-app-boot` | 0.1.0-rc.6 | `sha512-97Xb2wB0cuFMmbvW7/95p…` |
| `@deepseek-ai/dsh-agent-spine-demo` | 0.1.0-rc.6 | `sha512-urMS7CReaddhybJZCaPA8…` |
| `@deepseek-ai/dsh-llm-deepseek` | 0.1.0-rc.6 | `sha512-Md9ik1e8tmrKcL2aRpif8…` |
| `@deepseek-ai/dsh-mcp-client` | 0.1.0-rc.6 | `sha512-seBl0SLn308CbPwGVSm2B…` |
| `@deepseek-ai/cordis` | 4.0.1 | `sha512-YBdskTU2Po1kru3GgcUWU…` |
| `@modelcontextprotocol/sdk` | 1.30.0 | `sha512-xKd8OIzlqNzcqcNumGAa6…` |

Full hashes are in `package-lock.json`; treat that file as the authority.

---

## 2. Architecture

```text
 Meridian process                              dsh runtime subprocess
 ┌──────────────────────────────┐             ┌──────────────────────────────┐
 │ financial layer              │             │ dsh-sdk-jsonrpc-server       │
 │   ↓ AgentKernel (this pkg)   │   stdio     │ dsh-agent-spine-demo (loop)  │
 │ DshKernel ───────────────────┼──JSON-RPC──▶│ dsh-llm-deepseek → DeepSeek  │
 │   └ ToolRegistry             │             │ dsh-mcp-client               │
 │ MCP bridge (127.0.0.1:*) ◀───┼──MCP HTTP───┘                              │
 └──────────────────────────────┘             └──────────────────────────────┘
```

`AgentKernel` (`src/kernel.ts`) has exactly four verbs — `run(plan)`,
`registerTool`, `onEvent`, `sessionLog` — plus `close()`. Anything wider would
leak the shape of one particular harness into the financial layer.

**Tools cross the seam as plain data.** A Meridian tool is
`{ name, description, inputSchema, execute }` — no dsh types, no Cordis context,
no `defineTool`. `DshKernel` publishes the live registry over an in-process MCP
Streamable-HTTP server on loopback, and the runtime's `dsh-mcp-client` consumes
it. That single decision is what keeps the dsh import surface at one file: the
alternative (dsh's native `ctx.tools.register`) would have put a dsh import in
every financial skill.

Cost of that choice, stated plainly: one loopback HTTP hop per tool call, and
the model sees `mcp__meridian__<name>` rather than `<name>` (the kernel strips
the prefix back off on the way out, so `RunResult.toolCalls[].name` is the bare
name).

**Implementations**

- `DshKernel` (`src/dsh-kernel.ts`) — real runtime, real model.
- `MockKernel` (`src/mock-kernel.ts`) — deterministic scripted stub model. Two
  jobs: test substrate, and the placeholder an in-house loop would replace if we
  ever spend the PRD §8 exit budget. It is *not* an LLM; its default script
  picks one registered tool, fills required parameters from the prompt by
  name-hint, calls it once, and renders the result's string leaves.

---

## 3. Running it

Requires Node `^22.19 || >=24` and `DEEPSEEK_API_KEY` in the environment.

```sh
npm ci
npm run typecheck
npm test                    # contract suite on BOTH kernels + boundary guard
                            # (serial: two dsh runtimes should not race each other)
npm run check:dsh-boundary  # the CI red line, standalone
node scripts/spike-dsh.ts   # end-to-end evidence run against real dsh
```

`MERIDIAN_MCP_DEBUG=1` traces MCP traffic on the Meridian side.
`MERIDIAN_DSH_LOG=<path>` tees the runtime subprocess's stderr to a file (see
pitfall 6 — you will need this).

---

## 4. The contract suite

`test/contract.ts` is one suite parameterized by implementation.
`test/mock-kernel.contract.test.ts` and `test/dsh-kernel.contract.test.ts` both
run it verbatim. A test that only passes on the mock is a mock detail; a test
that only passes on dsh is dsh leaking through the seam.

The dsh file **skips loudly** (naming the reason) when `DEEPSEEK_API_KEY` is
absent or Node is too old. It never silently falls back to the mock.

This paid for itself immediately: the suite caught `DshKernel` filing its
`run.start` event under a `'(pending)'` session id, so `sessionLog()` was missing
the head of its own run. The kernel now mints the session id client-side.

---

## 5. The dsh boundary (CI red line)

`scripts/check-dsh-boundary.mjs` scans the whole `meridian/` tree for any
reference to `@deepseek-ai/*` and exits 1 on a hit. Three files are allowlisted:

| File | Why |
|---|---|
| `adapter/src/dsh-kernel.ts` | the implementation itself |
| `adapter/runtime/dsh-runtime-bin.mjs` | the runtime bin it launches |
| `adapter/test/dsh-boundary.test.ts` | its fixtures are deliberate violations |

The scan is textual on purpose — a package name inside a config template is just
as much a dependency as an `import`, and this is a red line, not a linter hint.
Comment-only lines are skipped so prose may explain the rule. Growing that
allowlist is an architecture decision, not a chore.

`test/dsh-boundary.test.ts` proves the guard actually fails: it plants a
violating import, a violating config string, and a harmless comment in scratch
trees and asserts the exit codes.

---

## 6. Pitfall log — dsh developer preview, 2026-08-14

Recorded for the quarterly upgrade evaluation (PRD §8). Everything below was hit
for real during this spike, in roughly this order.

### 1. The package is not called what the task said
`deepseek-harness` does not exist on npm. The CLI is **`@deepseek-ai/dsh`**; the
libraries are `@deepseek-ai/dsh-*`. The GitHub repo name is the only place
"deepseek-harness" appears.

### 2. `latest` on npm points at a three-generation-old build
Only `@deepseek-ai/dsh` (the CLI) has `dist-tags.latest = 0.1.0-rc.6`. Every
library package still tags `latest = 0.0.1-rc.1` (2026-08-10) and puts the
current build on `next`:

```
@deepseek-ai/dsh-sdk-client  latest=0.0.1-rc.1  next=0.1.0-rc.6
@deepseek-ai/dsh-base        latest=0.0.1-rc.1  next=0.1.0-rc.6
```

A plain `npm i @deepseek-ai/dsh-sdk-client` therefore installs a client that
cannot talk to a current runtime. **Always pin exact versions.** The mismatch is
invisible until something fails at the wire level.

### 3. Node 20 is not enough, and the failure is a warning
`engines: ^22.19.0 || >=24.0.0`. The machine's default was Node 20.20.1; npm only
warns. We run everything under Node 22.23.2 (`nvm`). `dshUnavailableReason()`
turns this into an explicit skip reason rather than a mystery crash.

### 4. There is no published runtime executable for TypeScript consumers
`@deepseek-ai/dsh-sdk-client` says to launch "the `dsh-jsonrpc-agent` bin", which
is not on npm — it ships inside the *Python* distribution. Meanwhile the `dsh`
CLI boots *profiles* from `$DSH_HOME` and cannot be pointed at a bare
`cordis.yml`, and the `cordis` bin (a) hardcodes `./cordis.yml` with no argv and
(b) imports `@deepseek-ai/cordis-plugin-loader` and `-include`, which
`@deepseek-ai/cordis` does not depend on — so it cannot run as installed.

We supply the bin ourselves: `runtime/dsh-runtime-bin.mjs`, ~15 lines over the
published `@deepseek-ai/dsh-app-boot` helpers. This works and is documented
upstream, but it is a gap a TypeScript consumer must fill.

### 5. Bare plugin names resolve relative to the config file
`boot()` resolves `@deepseek-ai/dsh-*` entries in `cordis.yml` from the config's
directory. Our config is generated into a temp dir with no `node_modules`, so the
tree silently fails to settle. Fix: pass `bareModuleBaseUrl` (we pass
`import.meta.url`) to anchor resolution to this package's install.

### 6. The runtime subprocess is invisible unless it dies
`HarnessClient` spawns with piped stdio and keeps stderr in a bounded tail it
only surfaces inside a `TransportClosedError`. There is no live stderr hook and
no option to inherit. A runtime that boots but misbehaves produces *zero* output
in the parent. This cost the most time of anything here. Workaround shipped:
`MERIDIAN_DSH_LOG=<path>` in our bin tees stderr to a file.

### 7. **The runtime answers prompts before its plugin tree has settled**
The most serious finding, and the one that would have made this spike look like a
model failure.

`dsh-sdk-jsonrpc-server` starts serving stdio JSON-RPC the moment *its own* entry
activates. The Cordis Loader mounts entries **concurrently**, so a prompt sent
right after `initialize` can begin its first turn while other entries are still
activating. Prompt assembly then runs against whatever is in the tool registry at
that instant.

Measured on this machine, with instrumentation inside `dsh-tools`:

```
t=…225285  our MCP bridge served tools/list
t=…225288  wireSchemas → visible=["get_goal","create_goal","update_goal"]   ← prompt assembled
t=…225296  insert mcp__meridian__list_announcements                        ← 8 ms too late
```

The model then answered, correctly and helpfully, that it had no such tool. Every
symptom pointed at MCP wiring; the wiring was fine.

Two sub-lessons:

- Waiting for `tools/list` is **not** sufficient — registration happens after
  that response returns.
- Any asynchronously-registering tool source (every MCP server) is exposed to
  this, not just ours.

Fix shipped: `boot()` resolving is the only trustworthy "tree settled" signal, so
`runtime/dsh-runtime-bin.mjs` POSTs to a `/meridian-ready` endpoint on our bridge
after `boot()` returns, and `DshKernel.start()` waits for that ping (60 s cap)
before any prompt. **Do not remove that gate.**

### 8. Config keys fail silently when the schema tolerates them
`agent-spine`'s `goals: { enabled: false }` is accepted at load and has no
effect — `create_goal` / `get_goal` / `update_goal` were still in the model's
tool set. Conversely `@deepseek-ai/dsh-tool-todo` *rejects* activation with
`$.allowParallelInProgress missing required value` if you mount it with no
config at all. Required-with-no-default and accepted-but-ignored coexist; assume
neither, verify by reading `request/header`.

### 9. Two useful pieces of ground truth
- The `request/header` session event carries the exact tool list sent to the
  model. It is the fastest way to answer "does the model actually see my tool".
- `tool/result` hides its call id in two places, neither obvious:
  `message.source.callId` and `message.content[].toolCallId`. Its text is nested
  one level deeper than an assistant message
  (`content[].content[].text`). `src/dsh-kernel.ts` reads both defensively.

### 10. MCP SDK 1.30.0: "stateless mode" is single-use (not a dsh bug, but it bites here)
The SDK's own docblock still shows `sessionIdGenerator: undefined` on a
long-lived transport. As of 1.30.0 the second request throws
`Stateless transport cannot be reused across requests`, and the Node wrapper
(Hono) converts that throw into a bare HTTP 500 with an empty body. At the dsh
end this surfaces as `Streamable HTTP error: Error POSTing to endpoint:` with
nothing after the colon and nothing in any log. We use stateful mode.

### 11. Install cost, and what you do *not* need
`npm i @deepseek-ai/dsh` pulls **508 packages** and took ~3 minutes (a 2-minute
timeout is not enough). It also drags in the whole web frontend.

You do not need it. Depending only on `dsh-app-boot`, the plugin packages we
actually mount, and `node-addon-require-builtin` (the Loader's optional native
peer, which repository bins install but external callers must supply) brings the
lockfile from **691 to 280 packages** with the full spike still passing.

### 12. Preview-era churn signal
No git tags, no GitHub releases, six npm versions in four days (2026-08-10 →
08-13), and the source tree's version (`0.1.0-rc.5`) already trails npm
(`0.1.0-rc.6`). Treat any upgrade as a re-qualification of the whole pitfall
list above, not as a version bump.

---

## 7. Breaking-change surface we depend on

The quarterly evaluation should re-check exactly these. Everything else is ours.

| Surface | Used by | Fragility |
|---|---|---|
| `DeepSeekHarness` / `run()` / `RunResult` | `dsh-kernel.ts` | documented public API; `run()`'s "receipt to idle" semantics are explicitly not per-prompt |
| `boot()` + `resolveConfigPath()` + `installFailLoud()` | `runtime/dsh-runtime-bin.mjs` | public, but the 5th arg (`bareModuleBaseUrl`) is load-bearing for us |
| `cordis.yml` row schemas for 4 plugins | `composeCordisConfig()` | **highest risk** — config keys are per-package and change without notice (see pitfall 8) |
| Session event shapes (`assistant/message`, `tool/call`, `tool/result`, `turn/end`) | `#normalize()` | read defensively; unknown types are ignored, not fatal |
| `mcp__<server>__<tool>` naming | `stripMcpPrefix()` | documented and deterministic |
| Runtime answers only after `boot()` | the readiness gate | **behavioural, undocumented** — if dsh ever pings ready itself, drop ours |

A green `npm test` on both kernels is the upgrade gate: it exercises every row
above end to end.

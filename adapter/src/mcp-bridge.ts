/**
 * In-process MCP bridge: publishes the kernel's {@link ToolRegistry} over
 * Streamable HTTP so an out-of-process agent runtime can call tools whose
 * bodies are ordinary closures in *this* process.
 *
 * This is the load-bearing trick behind the dsh boundary discipline. dsh's own
 * tool API (`ctx.tools.register` + `defineTool` from `@deepseek-ai/dsh-tools`)
 * would require every Meridian tool to import dsh types and to live inside the
 * harness's plugin tree. Going through MCP instead means a Meridian tool is a
 * plain object with an async function, identical on `MockKernel` and
 * `DshKernel`, and the dsh dependency stops at `DshKernel` + `runtime/`.
 *
 * Trade-off, recorded honestly: one localhost HTTP hop and MCP's
 * `mcp__<server>__<tool>` name mangling per call. Both are cheap next to the
 * cost of a harness migration.
 *
 * @module @meridian/kernel-adapter/mcp-bridge
 */

import { randomUUID } from 'node:crypto'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { JsonValue } from './kernel.ts'
import type { ToolRegistry } from './registry.ts'

/** Path the runtime bin pings after `boot()` settles. */
const READY_PATH = '/meridian-ready'

/** A running bridge. */
export interface McpBridgeHandle {
  /** The URL an MCP client connects to (`http://127.0.0.1:<port>/mcp`). */
  readonly url: string
  /** The URL the runtime bin pings once `boot()` has settled the plugin tree. */
  readonly readyUrl: string
  /** Resolves the first time a client fetches the tool list. Diagnostic only. */
  readonly whenToolsListed: Promise<void>
  /**
   * Resolves when the runtime reports its plugin tree fully settled.
   *
   * THE gate `DshKernel` waits on before sending a prompt, and the fix for the
   * spike's hardest bug. A dsh runtime starts serving JSON-RPC the moment
   * `dsh-sdk-jsonrpc-server` activates, which the Loader does CONCURRENTLY with
   * every other entry — so a prompt sent right after `initialize` can begin its
   * first turn while the MCP client is still syncing. Measured on this machine
   * the model's prompt was assembled 8 ms before the Meridian tool landed in
   * the registry, and the model then truthfully answered that it had no such
   * tool. Waiting for `tools/list` is NOT sufficient: registration happens
   * after that response. `boot()` resolving is, so the runtime bin tells us.
   */
  readonly whenRuntimeReady: Promise<void>
  /** Stop the HTTP listener and the MCP server. */
  close(): Promise<void>
}

/**
 * Start the bridge on an ephemeral loopback port.
 *
 * @param registry - the live tool table to publish.
 * @param serverName - MCP server name; becomes the `mcp__<name>__*` prefix.
 * @returns the running bridge handle.
 */
export async function startMcpBridge(
  registry: ToolRegistry,
  serverName: string,
): Promise<McpBridgeHandle> {
  const mcp = new McpServer(
    { name: serverName, version: '0.0.1' },
    { capabilities: { tools: {} } },
  )

  const listed = Promise.withResolvers<void>()
  const ready = Promise.withResolvers<void>()

  mcp.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = registry.list()
    debugLog(`tools/list -> ${tools.map((tool) => tool.name).join(',') || '(none)'}`, null)
    listed.resolve()
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as unknown as {
          type: 'object'
          properties?: Record<string, unknown>
        },
      })),
    }
  })

  mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name
    const args = (request.params.arguments ?? {}) as Record<string, JsonValue>
    const tool = registry.get(name)
    debugLog(`tools/call ${name} ${JSON.stringify(args)}`, null)
    const callId = String(extra.requestId)
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `no such tool: ${name}` }],
      }
    }
    try {
      const value = (await tool.execute(args, {
        signal: extra.signal,
        runId: String(extra.requestId),
        callId,
      })) as JsonValue
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(value) }],
        structuredContent: isPlainObject(value) ? value : { value },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { isError: true, content: [{ type: 'text' as const, text: message }] }
    }
  })

  // Stateful (session-id) mode, deliberately.
  //
  // The SDK's own docblock still advertises `sessionIdGenerator: undefined` as
  // "stateless mode" for a long-lived transport, but as of @modelcontextprotocol
  // /sdk 1.30.0 a stateless transport is SINGLE-USE: the second request throws
  // `Stateless transport cannot be reused across requests`. Worse, the Node
  // wrapper runs through Hono, whose error handler converts that throw into a
  // bare HTTP 500 with no body — so the symptom at the dsh end is an opaque
  // "Error POSTing to endpoint" with nothing in any log. Stateful mode keeps one
  // transport alive for the runtime's whole lifetime, which is what we want
  // anyway. See README §"Pitfall log".
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  })
  // `onclose` is typed required-but-undefined by the SDK, which
  // `exactOptionalPropertyTypes` rejects; the cast is third-party friction only.
  await mcp.connect(transport as unknown as Parameters<McpServer['connect']>[0])

  const http = createServer((req, res) => {
    if (req.url?.startsWith(READY_PATH)) {
      debugLog(`ready ping from runtime`, null)
      ready.resolve()
      res.writeHead(204)
      res.end()
      return
    }
    void transport.handleRequest(req, res).catch((error: unknown) => {
      debugLog(`transport error: ${String((error as Error)?.stack ?? error)}`, null)
      if (!res.headersSent) res.writeHead(500)
      res.end(String(error))
    })
  })

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(0, '127.0.0.1', () => {
      http.removeListener('error', reject)
      resolve()
    })
  })

  const port = (http.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    readyUrl: `http://127.0.0.1:${port}${READY_PATH}`,
    whenToolsListed: listed.promise,
    whenRuntimeReady: ready.promise,
    close: async () => {
      listed.resolve()
      ready.resolve()
      await transport.close()
      await mcp.close()
      await closeHttp(http)
    },
  }
}

/**
 * Preview-era tracing: set `MERIDIAN_MCP_DEBUG=1` to see what the runtime's MCP
 * client actually asked for. Silent otherwise.
 * @param line - the message.
 * @param passthrough - value returned unchanged.
 * @returns `passthrough`.
 */
function debugLog<T>(line: string, passthrough: T): T {
  if (process.env.MERIDIAN_MCP_DEBUG) process.stderr.write(`[meridian-mcp] ${line}\n`)
  return passthrough
}

/** @param value - candidate. @returns whether it is a non-array JSON object. */
function isPlainObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param http - listener to stop. @returns settlement once it is closed. */
function closeHttp(http: HttpServer): Promise<void> {
  return new Promise((resolve) => {
    http.closeAllConnections?.()
    http.close(() => resolve())
  })
}

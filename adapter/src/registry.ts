/**
 * Kernel-agnostic tool registry and event bus. Shared by every `AgentKernel`
 * implementation so registration semantics cannot drift between them (a
 * contract test that passes on `MockKernel` and fails on `DshKernel` because
 * one of them tolerated a duplicate name would make the abstraction a lie).
 *
 * @module @meridian/kernel-adapter/registry
 */

import {
  assertValidTool,
  ToolRegistrationError,
  type AnyToolDefinition,
  type KernelEvent,
  type Unregister,
} from './kernel.ts'

/** Live tool table with fail-loud duplicate detection. */
export class ToolRegistry {
  readonly #tools = new Map<string, AnyToolDefinition>()
  readonly #onChange: () => void

  /** @param onChange - called after every add/remove (kernels use it to re-sync). */
  constructor(onChange: () => void = () => {}) {
    this.#onChange = onChange
  }

  /** Register a tool; throws {@link ToolRegistrationError} on a live-name collision. */
  register(tool: AnyToolDefinition): Unregister {
    assertValidTool(tool)
    if (this.#tools.has(tool.name)) {
      throw new ToolRegistrationError(`tool '${tool.name}' is already registered`)
    }
    this.#tools.set(tool.name, tool)
    this.#onChange()
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (this.#tools.get(tool.name) === tool) {
        this.#tools.delete(tool.name)
        this.#onChange()
      }
    }
  }

  get(name: string): AnyToolDefinition | undefined {
    return this.#tools.get(name)
  }

  list(): AnyToolDefinition[] {
    return [...this.#tools.values()]
  }

  get size(): number {
    return this.#tools.size
  }
}

/** Fan-out for {@link KernelEvent}s; a throwing listener never breaks a run. */
export class EventBus {
  readonly #listeners = new Set<(event: KernelEvent) => void>()

  subscribe(listener: (event: KernelEvent) => void): Unregister {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  emit(event: KernelEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event)
      } catch {
        // Observer failures are contained: a run must not fail because a
        // telemetry sink threw.
      }
    }
  }
}

/** Append-only per-session event store, the substrate of `sessionLog()`. */
export class SessionLogStore {
  readonly #logs = new Map<string, KernelEvent[]>()

  append(event: KernelEvent): void {
    const log = this.#logs.get(event.sessionId)
    if (log) log.push(event)
    else this.#logs.set(event.sessionId, [event])
  }

  has(sessionId: string): boolean {
    return this.#logs.has(sessionId)
  }

  read(sessionId: string): KernelEvent[] {
    return [...(this.#logs.get(sessionId) ?? [])]
  }
}

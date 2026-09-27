import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"

import { spawnOnHost, type Host } from "./host"

type RequestID = number | string

/** Non-empty stderr lines kept for the error raised when the app-server exits. */
const STDERR_TAIL_LINES = 3
/** How long an exit waits for the rest of stderr, which a leftover process could keep open indefinitely. */
const STDERR_DRAIN_MS = 500

interface Pending {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

export class AppServerError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(`${method} failed (${code}): ${message}`)
    this.name = "AppServerError"
  }
}

export class AppServerClosedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AppServerClosedError"
  }
}

export interface AppServerHandlers {
  /** Answers a request sent by the app-server (for example an MCP elicitation). */
  onServerRequest: (method: string, params: any) => Promise<unknown>
  onNotification?: (method: string, params: any) => void
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
  onStderr?: (line: string) => void
  /** Every JSON-RPC message sent or received, for debugging. */
  onTraffic?: (direction: "send" | "receive", message: unknown) => void
}

export interface RequestOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * Minimal client for `codex app-server --listen stdio://`, which speaks
 * newline-delimited JSON-RPC (without the `jsonrpc` field).
 */
export class AppServerClient {
  private nextID = 1
  private readonly pending = new Map<RequestID, Pending>()
  private readonly stderrTail: string[] = []
  /** Stderr received after the last newline. */
  private stderrPartial = ""
  /** Settles once an exit has been handled: `onExit` called and pending requests rejected. */
  private readonly exitHandled: Promise<void>
  private exited = false

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly handlers: AppServerHandlers,
  ) {
    createInterface({ input: child.stdout }).on("line", (line) => this.receive(line))
    // Read stderr by hand rather than with readline: an unfinished last line must still reach the exit error when
    // stderr stays open after the exit.
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      const lines = (this.stderrPartial + chunk).split(/\r?\n/)
      this.stderrPartial = lines.pop() ?? ""
      for (const line of lines) this.stderrLine(line)
    })
    const stderrEnded = new Promise<void>((resolve) =>
      child.stderr.once("close", () => {
        if (this.stderrPartial) this.stderrLine(this.stderrPartial)
        this.stderrPartial = ""
        resolve()
      }),
    )
    this.exitHandled = new Promise<void>((resolve) =>
      child.once("exit", (code, signal) => {
        this.exited = true
        // The owner hears about the exit at once, before it can start a replacement it might confuse with this one.
        handlers.onExit?.(code, signal)
        resolve(this.rejectPending(code, signal, stderrEnded))
      }),
    )
    child.stdin.on("error", () => {})
  }

  static async start(input: {
    host: Host
    codexPath: string
    clientVersion: string
    handlers: AppServerHandlers
    timeoutMs?: number
  }): Promise<AppServerClient> {
    const child = spawnOnHost(input.host, input.codexPath, ["app-server", "--listen", "stdio://"])
    const spawned = await new Promise<Error | undefined>((resolve) => {
      child.once("spawn", () => resolve(undefined))
      child.once("error", (error) => resolve(error))
    })
    if (spawned) {
      const where = input.host.remote ? ` on ${input.host.label}` : ""
      throw new Error(`Could not start ${input.codexPath}${where}: ${spawned.message}`)
    }

    const client = new AppServerClient(child, input.handlers)
    try {
      await client.request(
        "initialize",
        {
          clientInfo: {
            name: "opencode-codex-computer-use",
            title: "OpenCode Codex Computer Use",
            version: input.clientVersion,
          },
          capabilities: { experimentalApi: false },
        },
        { timeoutMs: input.timeoutMs ?? 30_000 },
      )
      client.notify("initialized")
    } catch (error) {
      client.kill()
      throw error
    }
    return client
  }

  get closed(): boolean {
    return this.exited
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  request<T = any>(method: string, params?: unknown, options: RequestOptions = {}): Promise<T> {
    if (this.exited) return Promise.reject(new AppServerClosedError("codex app-server is not running"))
    const id = this.nextID++
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = { method, resolve: resolve as (value: unknown) => void, reject }
      if (options.timeoutMs) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`${method} timed out after ${options.timeoutMs} ms`))
        }, options.timeoutMs)
      }
      if (options.signal) {
        if (options.signal.aborted) return reject(abortError(method))
        options.signal.addEventListener(
          "abort",
          () => {
            if (!this.pending.delete(id)) return
            clearTimeout(pending.timer)
            reject(abortError(method))
          },
          { once: true },
        )
      }
      this.pending.set(id, pending)
      this.write(params === undefined ? { id, method } : { id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params })
  }

  /** Closes stdin so the app-server shuts down cleanly; kills it if it does not exit in time. */
  async close(timeoutMs = 5_000): Promise<void> {
    if (!this.exited) this.child.stdin.end()
    const timer = setTimeout(() => this.kill(), timeoutMs)
    await this.exitHandled
    clearTimeout(timer)
  }

  kill(): void {
    if (!this.exited) this.child.kill("SIGTERM")
  }

  private stderrLine(line: string): void {
    if (line.trim()) this.stderrTail.push(line.trim())
    if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift()
    this.handlers.onStderr?.(line)
  }

  private async rejectPending(
    code: number | null,
    signal: NodeJS.Signals | null,
    stderrEnded: Promise<void>,
  ): Promise<void> {
    // The exit code alone does not say why; the last stderr lines usually do (for example an SSH error). They can
    // still be on their way when the process has exited, so wait for the rest of stderr, but only briefly.
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([stderrEnded, new Promise<void>((resolve) => (timer = setTimeout(resolve, STDERR_DRAIN_MS)))])
    clearTimeout(timer)
    const lines = [...this.stderrTail, this.stderrPartial.trim()].filter(Boolean).slice(-STDERR_TAIL_LINES)
    const tail = lines.length ? `: ${lines.join("\n")}` : ""
    const error = new AppServerClosedError(`codex app-server exited (code ${code}, signal ${signal})${tail}`)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private write(message: unknown): void {
    if (this.exited || !this.child.stdin.writable) return
    this.handlers.onTraffic?.("send", message)
    this.child.stdin.write(JSON.stringify(message) + "\n")
  }

  private receive(line: string): void {
    let message: any
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message === null || typeof message !== "object") return
    this.handlers.onTraffic?.("receive", message)

    const isResponse = message.id !== undefined && ("result" in message || "error" in message) && !message.method
    if (isResponse) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) {
        const { code = -1, message: text = "unknown error", data } = message.error
        pending.reject(new AppServerError(pending.method, code, text, data))
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (typeof message.method !== "string") return
    if (message.id === undefined) {
      this.handlers.onNotification?.(message.method, message.params)
      return
    }

    const id = message.id as RequestID
    this.handlers.onServerRequest(message.method, message.params).then(
      (result) => this.write({ id, result }),
      (error: unknown) =>
        this.write({
          id,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        }),
    )
  }
}

function abortError(method: string): Error {
  const error = new Error(`${method} was cancelled`)
  error.name = "AbortError"
  return error
}

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"

type RequestID = number | string

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
  private exited = false

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly handlers: AppServerHandlers,
  ) {
    createInterface({ input: child.stdout }).on("line", (line) => this.receive(line))
    createInterface({ input: child.stderr }).on("line", (line) => handlers.onStderr?.(line))
    child.on("exit", (code, signal) => {
      this.exited = true
      const error = new AppServerClosedError(`codex app-server exited (code ${code}, signal ${signal})`)
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(error)
      }
      this.pending.clear()
      handlers.onExit?.(code, signal)
    })
    child.stdin.on("error", () => {})
  }

  static async start(input: {
    codexPath: string
    clientVersion: string
    handlers: AppServerHandlers
    timeoutMs?: number
  }): Promise<AppServerClient> {
    const child = spawn(input.codexPath, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    })
    const spawned = await new Promise<Error | undefined>((resolve) => {
      child.once("spawn", () => resolve(undefined))
      child.once("error", (error) => resolve(error))
    })
    if (spawned) throw new Error(`Could not start ${input.codexPath}: ${spawned.message}`)

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
    if (this.exited) return
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()))
    this.child.stdin.end()
    const timer = setTimeout(() => this.kill(), timeoutMs)
    await exited
    clearTimeout(timer)
  }

  kill(): void {
    if (!this.exited) this.child.kill("SIGTERM")
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

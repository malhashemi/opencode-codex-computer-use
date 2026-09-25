import { AppServerClient, AppServerError } from "./app-server"
import { BUNDLED_CODEX_PATHS, CODEX_PATH_ENV, resolveCodexPath } from "./codex-path"

/** Codex's MCP server that hosts the Computer Use JavaScript runtime (`cua`). */
export const CUA_SERVER = "cua_repl"

export interface BridgeOptions {
  codexPath?: string
  idleShutdownMs: number
  callTimeoutMs: number
  cwd: string
  version: string
  log: (message: string) => void
  /** JavaScript run before the model's code on every call (see `surfaceGuard`). */
  codePrefix?: string
  /** Receives every app-server message, for the optional debug log. */
  onTraffic?: (direction: "send" | "receive", message: unknown) => void
}

export interface McpContentBlock {
  type: string
  text?: string
  data?: string
  mimeType?: string
  [key: string]: unknown
}

export interface RunResult {
  content: McpContentBlock[]
  isError: boolean
  meta?: Record<string, unknown>
  notes: string[]
}

export class SetupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SetupError"
  }
}

export const SETUP_HELP =
  "Codex Computer Use needs the ChatGPT (or Codex) desktop app installed and signed in, with Computer Use enabled " +
  "(on macOS: 14.4+ on Apple Silicon, with Accessibility and Screen Recording granted). " +
  "Run /computer-use-doctor or see the opencode-codex-computer-use README."

interface SessionState {
  readonly generation: number
  readonly threadID: Promise<string>
  resolvedThreadID?: string
  /** Computer Use ran since the last `turn_ended`. */
  dirty: boolean
  /** Generated on the first call of an OpenCode turn and cleared when the turn ends. */
  turnID?: string
}

export class ComputerUseBridge {
  private client?: AppServerClient
  private starting?: Promise<AppServerClient>
  private generation = 0
  private readonly sessions = new Map<string, SessionState>()
  private readonly approvalNotes = new Map<string, string[]>()
  private readonly restartedSessions = new Set<string>()
  private active = 0
  private idleTimer?: ReturnType<typeof setTimeout>
  private disposed = false

  constructor(private readonly options: BridgeOptions) {}

  async run(
    sessionID: string,
    code: string,
    input: { signal?: AbortSignal; callID?: string } = {},
  ): Promise<RunResult> {
    return this.busy(async () => {
      const client = await this.ensureClient()
      const threadID = await this.thread(sessionID, client)
      const state = this.sessions.get(sessionID)
      if (state) {
        state.dirty = true
        state.turnID ??= crypto.randomUUID()
      }

      const notes: string[] = []
      if (this.restartedSessions.delete(sessionID)) {
        notes.push(
          "The Computer Use runtime was restarted since the previous call, so JavaScript variables from earlier calls " +
            '(such as `app` or `tab`) no longer exist. Bind them again, for example `let app = await cua.getApp("Notes")`.',
        )
      }

      const onAbort = () => void this.endTurn(sessionID, "Interrupt")
      input.signal?.addEventListener("abort", onAbort, { once: true })
      try {
        const result = await client.request(
          "mcpServer/tool/call",
          {
            threadId: threadID,
            server: CUA_SERVER,
            tool: "js",
            arguments: { code: this.options.codePrefix ? `${this.options.codePrefix}\n${code}` : code },
            _meta: turnMetadata(threadID, state?.turnID, input.callID),
          },
          { signal: input.signal, timeoutMs: this.options.callTimeoutMs },
        )
        notes.push(...this.takeApprovalNotes(threadID))
        return {
          content: Array.isArray(result?.content) ? result.content : [],
          isError: result?.isError === true,
          meta: result?._meta,
          notes,
        }
      } catch (error) {
        this.takeApprovalNotes(threadID).forEach((note) => notes.push(note))
        throw await this.explain(error, client, threadID, notes)
      } finally {
        input.signal?.removeEventListener("abort", onAbort)
      }
    })
  }

  /** Resets the session's JavaScript runtime (`js_reset`). Does nothing if Computer Use has not run yet. */
  async reset(sessionID: string): Promise<boolean> {
    const state = this.sessions.get(sessionID)
    if (!state || state.generation !== this.generation || !this.client || this.client.closed) return false
    return this.busy(async () => {
      const client = this.client!
      const threadID = await state.threadID
      await client.request(
        "mcpServer/tool/call",
        { threadId: threadID, server: CUA_SERVER, tool: "js_reset", arguments: {} },
        { timeoutMs: 30_000 },
      )
      return true
    })
  }

  /** Tells Computer Use the turn ended, as Codex does from its Stop/Interrupt hooks. */
  async endTurn(sessionID: string, kind: "Stop" | "Interrupt"): Promise<void> {
    const state = this.sessions.get(sessionID)
    const client = this.client
    if (!state?.dirty || !state.resolvedThreadID || !client || client.closed || state.generation !== this.generation)
      return
    const turnID = state.turnID ?? "opencode"
    state.dirty = false
    state.turnID = undefined
    try {
      await client.request(
        "mcpServer/tool/call",
        {
          threadId: state.resolvedThreadID,
          server: CUA_SERVER,
          tool: "turn_ended",
          arguments: {
            hook_event_name: kind,
            session_id: state.resolvedThreadID,
            turn_id: turnID,
          },
          _meta: turnMetadata(state.resolvedThreadID, turnID),
        },
        { timeoutMs: 10_000 },
      )
    } catch (error) {
      this.options.log(`turn_ended failed for session ${sessionID}: ${describe(error)}`)
    }
  }

  /** Ends the session's Codex thread; Codex then stops its Computer Use processes. */
  async closeSession(sessionID: string): Promise<void> {
    const state = this.sessions.get(sessionID)
    if (!state) return
    await this.endTurn(sessionID, "Stop")
    this.sessions.delete(sessionID)
    this.restartedSessions.delete(sessionID)
    const client = this.client
    if (!state.resolvedThreadID || !client || client.closed || state.generation !== this.generation) return
    this.approvalNotes.delete(state.resolvedThreadID)
    await client
      .request("thread/unsubscribe", { threadId: state.resolvedThreadID }, { timeoutMs: 10_000 })
      .catch((error) => this.options.log(`thread/unsubscribe failed: ${describe(error)}`))
  }

  /** Names of the MCP servers Codex has loaded for the session's thread, for diagnostics. */
  async serverNames(sessionID: string): Promise<string[]> {
    return this.busy(async () => {
      const client = await this.ensureClient()
      const threadID = await this.thread(sessionID, client)
      const response = await client.request(
        "mcpServerStatus/list",
        { threadId: threadID, detail: "toolsAndAuthOnly" },
        { timeoutMs: 30_000 },
      )
      return Array.isArray(response?.data)
        ? response.data.map((server: { name?: unknown }) => String(server?.name ?? ""))
        : []
    })
  }

  /** The effective Codex `approval_policy` (a granular policy is reported as "granular"), if Codex reports it. */
  async approvalPolicy(): Promise<string | undefined> {
    return this.busy(async () => {
      const client = await this.ensureClient()
      const response = await client.request("config/read", { cwd: this.options.cwd }, { timeoutMs: 15_000 })
      const policy = response?.config?.approval_policy
      if (typeof policy === "string") return policy
      return policy && typeof policy === "object" ? "granular" : undefined
    })
  }

  get codexPath(): string | undefined {
    return resolveCodexPath(this.options.codexPath)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    clearTimeout(this.idleTimer)
    await this.stop()
  }

  private async stop(): Promise<void> {
    const client = this.client
    if (!client) return
    await Promise.all([...this.sessions.keys()].map((sessionID) => this.endTurn(sessionID, "Stop")))
    await client.close()
  }

  private async busy<T>(work: () => Promise<T>): Promise<T> {
    this.active++
    clearTimeout(this.idleTimer)
    try {
      return await work()
    } finally {
      this.active--
      this.scheduleIdleShutdown()
    }
  }

  private scheduleIdleShutdown(): void {
    clearTimeout(this.idleTimer)
    if (this.active > 0 || !this.client || this.options.idleShutdownMs <= 0) return
    this.idleTimer = setTimeout(() => {
      if (this.active > 0) return
      this.options.log(`idle for ${this.options.idleShutdownMs} ms; stopping codex app-server`)
      void this.stop()
    }, this.options.idleShutdownMs)
    this.idleTimer.unref?.()
  }

  private ensureClient(): Promise<AppServerClient> {
    if (this.disposed) return Promise.reject(new Error("opencode-codex-computer-use has been unloaded"))
    if (this.client && !this.client.closed) return Promise.resolve(this.client)
    if (this.starting) return this.starting

    this.starting = (async () => {
      const codexPath = resolveCodexPath(this.options.codexPath)
      if (!codexPath) {
        throw new SetupError(
          `Could not find the \`codex\` executable (looked at the \`codexPath\` option, $${CODEX_PATH_ENV}, ` +
            `${[...BUNDLED_CODEX_PATHS, "PATH"].join(", ")}). ${SETUP_HELP}`,
        )
      }
      const generation = this.generation + 1
      const client = await AppServerClient.start({
        codexPath,
        clientVersion: this.options.version,
        handlers: {
          onServerRequest: (method, params) => this.answerServerRequest(method, params),
          onExit: (code, signal) => this.handleExit(generation, code, signal),
          onTraffic: this.options.onTraffic,
        },
      })
      this.generation = generation
      this.client = client
      this.options.log(`started codex app-server (pid ${client.pid}) from ${codexPath}`)
      return client
    })().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  private handleExit(generation: number, code: number | null, signal: NodeJS.Signals | null): void {
    this.options.log(`codex app-server exited (code ${code}, signal ${signal})`)
    if (generation !== this.generation) return
    this.client = undefined
    clearTimeout(this.idleTimer)
    for (const [sessionID, state] of this.sessions) {
      if (state.generation !== generation) continue
      this.sessions.delete(sessionID)
      this.restartedSessions.add(sessionID)
    }
    this.approvalNotes.clear()
  }

  private thread(sessionID: string, client: AppServerClient): Promise<string> {
    const existing = this.sessions.get(sessionID)
    if (existing && existing.generation === this.generation) return existing.threadID

    // No approvalPolicy: app access follows the user's Codex approval_policy.
    const params: Record<string, unknown> = { ephemeral: true, cwd: this.options.cwd }
    const threadID = client.request("thread/start", params, { timeoutMs: 60_000 }).then((response: any) => {
      const id = response?.thread?.id
      if (typeof id !== "string") throw new Error("thread/start returned no thread id")
      return id
    })
    const state: SessionState = { generation: this.generation, threadID, dirty: false }
    this.sessions.set(sessionID, state)
    void (async () => {
      try {
        state.resolvedThreadID = await threadID
      } catch {
        if (this.sessions.get(sessionID) === state) this.sessions.delete(sessionID)
      }
    })()
    return threadID
  }

  private async answerServerRequest(method: string, params: any): Promise<unknown> {
    if (method !== "mcpServer/elicitation/request") {
      throw new Error(`${method} is not supported by opencode-codex-computer-use`)
    }
    // OpenCode's plugin API cannot raise a permission question yet, so a prompt Codex forwards
    // (because approval_policy is not "never") is declined, and the model is told how the user can allow the app.
    const message = typeof params?.message === "string" ? params.message : "Computer Use requested approval"
    this.addApprovalNote(params?.threadId, declinedNote(message, appName(params)))
    this.options.log(`declined: ${message}`)
    return { action: "decline", content: null }
  }

  private addApprovalNote(threadID: unknown, note: string): void {
    if (typeof threadID !== "string") return
    const notes = this.approvalNotes.get(threadID) ?? []
    notes.push(note)
    this.approvalNotes.set(threadID, notes)
  }

  private takeApprovalNotes(threadID: string): string[] {
    const notes = this.approvalNotes.get(threadID) ?? []
    this.approvalNotes.delete(threadID)
    return notes
  }

  /** Turns low-level failures into actionable errors, checking whether Codex exposes `cua_repl` at all. */
  private async explain(error: unknown, client: AppServerClient, threadID: string, notes: string[]): Promise<Error> {
    const base = error instanceof Error ? error : new Error(String(error))
    if (base.name === "AbortError") return base
    if (base instanceof AppServerError && !client.closed) {
      let available: boolean | undefined
      try {
        const response = await client.request(
          "mcpServerStatus/list",
          { threadId: threadID, detail: "toolsAndAuthOnly" },
          { timeoutMs: 15_000 },
        )
        if (Array.isArray(response?.data)) {
          available = response.data.some((server: { name?: unknown }) => server?.name === CUA_SERVER)
        }
      } catch {
        available = undefined
      }
      if (available === false) {
        return new SetupError(
          `Codex has no \`${CUA_SERVER}\` MCP server, so Computer Use is not enabled. ${SETUP_HELP}`,
        )
      }
    }
    if (notes.length === 0) return base
    const wrapped = new Error([base.message, ...notes].join("\n"))
    wrapped.name = base.name
    return wrapped
  }
}

function appName(params: any): string | undefined {
  const display = params?._meta?.tool_params_display
  const entry = Array.isArray(display) ? display.find((item: { name?: string }) => item?.name === "app") : undefined
  return typeof entry?.value === "string" ? entry.value : undefined
}

export function declinedNote(message: string, app?: string): string {
  const target = app ? `"${app}"` : "this app"
  return (
    `Computer Use asked "${message}" and it could not be approved from OpenCode. Tell the user that Computer Use ` +
    `needs permission to use ${target}. They can approve it permanently in the ChatGPT or Codex app (use the app ` +
    'once through Computer Use there and choose to always allow it), or set approval_policy = "never" in ' +
    "~/.codex/config.toml so Codex approves apps itself."
  )
}

/**
 * Per-call metadata Codex attaches to MCP tool calls during a turn. The browser surface of `cua_repl` requires
 * `session_id` and `turn_id`; `call_id` links approval prompts to the originating tool call.
 */
export function turnMetadata(threadID: string, turnID: string | undefined, callID?: string) {
  if (!turnID) return undefined
  return {
    "x-codex-turn-metadata": {
      session_id: threadID,
      thread_id: threadID,
      turn_id: turnID,
      ...(callID ? { call_id: callID } : {}),
    },
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

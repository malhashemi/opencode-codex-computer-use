import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import { AppServerClient } from "../src/app-server"
import { ComputerUseBridge, SetupError } from "../src/bridge"
import { localHost, sshHost, type Host } from "../src/host"

const FAKE_CODEX = join(import.meta.dir, "fixtures", "fake-codex")
const FAKE_SSH_DIR = join(import.meta.dir, "fixtures", "fake-ssh")
const PATH = process.env.PATH
const bridges: ComputerUseBridge[] = []

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.dispose()))
  delete process.env.FAKE_CODEX_NO_CUA
  delete process.env.FAKE_CODEX_POLICY
  delete process.env.FAKE_SSH_HOME
  delete process.env.FAKE_CODEX_INIT_ERROR_ONCE
  process.env.PATH = PATH
})

describe("AppServerClient", () => {
  test("tells its owner about an exit at once, while pending calls wait for the rest of stderr", async () => {
    const at: Record<string, number> = {}
    const client = await AppServerClient.start({
      host: localHost(),
      codexPath: FAKE_CODEX,
      clientVersion: "test",
      handlers: { onServerRequest: async () => ({}), onExit: () => (at.exit = performance.now()) },
    })
    const started = await client.request("thread/start", { ephemeral: true, cwd: "/tmp" })
    await client
      .request("mcpServer/tool/call", {
        threadId: started.thread.id,
        server: "cua_repl",
        tool: "js",
        arguments: { code: "EXIT_HELD" },
      })
      .catch(() => (at.rejected = performance.now()))
    // EXIT_HELD leaves stderr open, so the rejection waits out the drain; the exit must not.
    expect(at.rejected! - at.exit!).toBeGreaterThan(300)
  })
})

function setup(
  input: {
    host?: Host
    idleShutdownMs?: number
    codePrefix?: string
    onTraffic?: (direction: "send" | "receive", message: unknown) => void
  } = {},
) {
  const logFile = join(mkdtempSync(join(tmpdir(), "cua-bridge-")), "codex.log")
  process.env.FAKE_CODEX_LOG = logFile
  const logs: string[] = []
  const bridge = new ComputerUseBridge({
    host: input.host ?? localHost(),
    codexPath: FAKE_CODEX,
    idleShutdownMs: input.idleShutdownMs ?? 0,
    callTimeoutMs: 10_000,
    cwd: "/tmp/project",
    version: "test",
    log: (message) => logs.push(message),
    codePrefix: input.codePrefix,
    onTraffic: input.onTraffic,
  })
  bridges.push(bridge)
  const received = (): any[] =>
    existsSync(logFile)
      ? readFileSync(logFile, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : []
  const calls = (method: string) => received().filter((message) => message.method === method)
  return { bridge, received, calls, logs }
}

const text = (result: { content: { text?: string }[] }) => result.content.map((block) => block.text).join("\n")

describe("ComputerUseBridge", () => {
  test("starts one app-server and one ephemeral thread per OpenCode session", async () => {
    const { bridge, calls } = setup()
    const first = await bridge.run("ses_a", "1 + 1")
    const again = await bridge.run("ses_a", "2 + 2")
    const other = await bridge.run("ses_b", "3 + 3")

    expect(text(first)).toBe("ran on thread-1: 1 + 1")
    expect(text(again)).toBe("ran on thread-1: 2 + 2")
    expect(text(other)).toBe("ran on thread-2: 3 + 3")
    expect(calls("initialize")).toHaveLength(1)
    const starts = calls("thread/start")
    expect(starts).toHaveLength(2)
    expect(starts[0].params).toEqual({ ephemeral: true, cwd: "/tmp/project" })
    expect(calls("mcpServer/tool/call")[0].params).toMatchObject({ server: "cua_repl", tool: "js" })
  })

  test("prepends the code prefix and reports traffic", async () => {
    const traffic: string[] = []
    const { bridge } = setup({
      codePrefix: "/* guard */",
      onTraffic: (direction, message) =>
        traffic.push(`${direction}:${(message as { method?: string }).method ?? "result"}`),
    })
    expect(text(await bridge.run("ses_a", "1 + 1"))).toBe("ran on thread-1: /* guard */\n1 + 1")
    expect(traffic).toContain("send:mcpServer/tool/call")
    expect(traffic).toContain("receive:result")
  })

  test("lists the thread's MCP servers", async () => {
    const { bridge } = setup()
    expect(await bridge.serverNames("ses_a")).toEqual(["cua_repl"])
  })

  test("concurrent first calls in one session share a thread", async () => {
    const { bridge, calls } = setup()
    await Promise.all([bridge.run("ses_a", "a"), bridge.run("ses_a", "b")])
    expect(calls("thread/start")).toHaveLength(1)
  })

  test("browser calls satisfy the runtime's turn-metadata requirement", async () => {
    const { bridge } = setup()
    const result = await bridge.run("ses_a", "BROWSER")
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('"type":"extension"')
  })

  test("returns screenshots and tool metadata", async () => {
    const { bridge } = setup()
    const result = await bridge.run("ses_a", "IMAGE")
    expect(result.content[1]).toEqual({ type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" })
    expect(result.meta?.["codex/toolSurface"]).toMatchObject({ app: { appId: "com.apple.finder" } })
  })

  test("reports JavaScript errors from the runtime", async () => {
    const { bridge } = setup()
    const result = await bridge.run("ses_a", "THROW")
    expect(result.isError).toBe(true)
    expect(text(result)).toContain("ReferenceError")
  })

  test("follows the Codex approval policy and declines forwarded prompts with an actionable note", async () => {
    const { bridge, calls } = setup()
    const result = await bridge.run("ses_a", "ELICIT")
    expect(calls("thread/start")[0].params.approvalPolicy).toBeUndefined()
    expect(text(result)).toBe("elicitation:decline")
    expect(result.notes[0]).toContain('needs permission to use "Calculator"')
    expect(result.notes[0]).toContain('approval_policy = "never"')
  })

  test("reads the Codex approval policy", async () => {
    process.env.FAKE_CODEX_POLICY = "never"
    expect(await setup().bridge.approvalPolicy()).toBe("never")
    process.env.FAKE_CODEX_POLICY = "granular"
    expect(await setup().bridge.approvalPolicy()).toBe("granular")
  })

  test("sends turn_ended once per turn that used Computer Use", async () => {
    const { bridge, calls } = setup()
    await bridge.endTurn("ses_a", "Stop")
    await bridge.run("ses_a", "x")
    await bridge.endTurn("ses_a", "Stop")
    await bridge.endTurn("ses_a", "Stop")

    const js = calls("mcpServer/tool/call").find((call) => call.params.tool === "js")
    const ended = calls("mcpServer/tool/call").filter((call) => call.params.tool === "turn_ended")
    expect(ended).toHaveLength(1)
    expect(ended[0].params.arguments).toEqual({
      hook_event_name: "Stop",
      session_id: "thread-1",
      turn_id: js.params._meta["x-codex-turn-metadata"].turn_id,
    })
  })

  test("attaches Codex turn metadata, stable within a turn and new for the next turn", async () => {
    const { bridge, calls } = setup()
    await bridge.run("ses_a", "a", { callID: "call_1" })
    await bridge.run("ses_a", "b", { callID: "call_2" })
    await bridge.endTurn("ses_a", "Stop")
    await bridge.run("ses_a", "c")

    const metas = calls("mcpServer/tool/call")
      .filter((call) => call.params.tool === "js")
      .map((call) => call.params._meta["x-codex-turn-metadata"])
    expect(metas[0]).toMatchObject({ session_id: "thread-1", thread_id: "thread-1", call_id: "call_1" })
    expect(metas[0].turn_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(metas[1].turn_id).toBe(metas[0].turn_id)
    expect(metas[1].call_id).toBe("call_2")
    expect(metas[2].turn_id).not.toBe(metas[0].turn_id)
    expect(metas[2].call_id).toBeUndefined()
  })

  test("closing a session ends the turn and unsubscribes its thread", async () => {
    const { bridge, calls } = setup()
    await bridge.run("ses_a", "x")
    await bridge.closeSession("ses_a")
    expect(calls("mcpServer/tool/call").some((call) => call.params.tool === "turn_ended")).toBe(true)
    expect(calls("thread/unsubscribe")[0].params).toEqual({ threadId: "thread-1" })
    await bridge.run("ses_a", "y")
    expect(calls("thread/start")).toHaveLength(2)
  })

  test("reset calls js_reset only once Computer Use has run", async () => {
    const { bridge, calls } = setup()
    expect(await bridge.reset("ses_a")).toBe(false)
    await bridge.run("ses_a", "x")
    expect(await bridge.reset("ses_a")).toBe(true)
    expect(calls("mcpServer/tool/call").some((call) => call.params.tool === "js_reset")).toBe(true)
  })

  test("restarts after the app-server dies and tells the model its variables are gone", async () => {
    const { bridge, calls } = setup()
    await bridge.run("ses_a", "let app = 1")
    await expect(bridge.run("ses_a", "EXIT")).rejects.toThrow()
    const result = await bridge.run("ses_a", "app")
    expect(calls("initialize")).toHaveLength(2)
    expect(result.notes[0]).toContain("runtime was restarted")
    expect((await bridge.run("ses_a", "app")).notes).toEqual([])
  })

  test("says why the app-server exited, from its last stderr lines", async () => {
    const { bridge } = setup()
    await expect(bridge.run("ses_a", "EXIT")).rejects.toThrow(
      "codex app-server exited (code 1, signal null): fake-codex: stopping on request",
    )
  })

  test("includes stderr output that arrives after the exit, even without a final newline", async () => {
    const { bridge } = setup()
    await expect(bridge.run("ses_a", "EXIT_LATE")).rejects.toThrow(
      "codex app-server exited (code 1, signal null): fake-codex: late reason",
    )
  })

  test("keeps an unfinished stderr line even when stderr stays open", async () => {
    const { bridge } = setup()
    await expect(bridge.run("ses_a", "EXIT_PARTIAL_HELD")).rejects.toThrow(
      "codex app-server exited (code 1, signal null): fake-codex: unfinished reason",
    )
  })

  test("a process from a failed startup never takes the place of the next one", async () => {
    process.env.FAKE_CODEX_INIT_ERROR_ONCE = join(mkdtempSync(join(tmpdir(), "cua-init-")), "failed-once")
    const { bridge, calls } = setup()
    await expect(bridge.run("ses_a", "1 + 1")).rejects.toThrow("initialize failed")
    expect(text(await bridge.run("ses_a", "2 + 2"))).toBe("ran on thread-1: 2 + 2")

    // The first process exits a second after it was told to stop, long after the second one took over.
    await Bun.sleep(1_500)
    const again = await bridge.run("ses_a", "3 + 3")
    expect(text(again)).toBe("ran on thread-1: 3 + 3")
    expect(again.notes).toEqual([])
    expect(calls("initialize")).toHaveLength(2)
  })

  test("does not wait for a leftover process that keeps stderr open", async () => {
    const { bridge } = setup()
    await bridge.run("ses_a", "warm up")
    const started = performance.now()
    await expect(bridge.run("ses_a", "EXIT_HELD")).rejects.toThrow("fake-codex: stopping, stderr stays open")
    expect(performance.now() - started).toBeLessThan(1_500)
  })

  test("cancelling a call rejects it and interrupts the turn", async () => {
    const { bridge, calls } = setup()
    await bridge.run("ses_a", "warm up")
    const controller = new AbortController()
    const pending = bridge.run("ses_a", "SLOW", { signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    await expect(pending).rejects.toThrow("cancelled")
    await Bun.sleep(100)
    const ended = calls("mcpServer/tool/call").filter((call) => call.params.tool === "turn_ended")
    expect(ended.at(-1)?.params.arguments.hook_event_name).toBe("Interrupt")
  })

  test("explains a missing cua_repl server as a setup problem", async () => {
    process.env.FAKE_CODEX_NO_CUA = "1"
    const { bridge } = setup()
    const error = (await bridge.run("ses_a", "x").catch((caught: unknown) => caught)) as Error
    expect(error).toBeInstanceOf(SetupError)
    expect(error.message).toContain("no `cua_repl` MCP server")
  })

  test("runs Codex on a remote host, in that host's home folder", async () => {
    const home = mkdtempSync(join(tmpdir(), "cu remote home "))
    process.env.PATH = `${FAKE_SSH_DIR}${delimiter}${PATH}`
    process.env.FAKE_SSH_HOME = home
    const { bridge, calls, logs } = setup({ host: sshHost("my-mac") })

    expect(await bridge.codexPath()).toBe(FAKE_CODEX)
    expect(text(await bridge.run("ses_a", "1 + 1"))).toBe("ran on thread-1: 1 + 1")
    expect(calls("thread/start")[0].params).toEqual({ ephemeral: true, cwd: home })
    expect(await bridge.approvalPolicy()).toBeUndefined()
    expect(calls("config/read")[0].params).toEqual({ cwd: home })
    expect(logs.some((line) => line.endsWith(`from ${FAKE_CODEX} on my-mac over SSH`))).toBe(true)
  })

  test("a call names the remote host it cannot reach", async () => {
    process.env.PATH = FAKE_SSH_DIR
    const { bridge } = setup({ host: sshHost("my-mac") })
    await expect(bridge.run("ses_a", "1 + 1")).rejects.toThrow(/^Could not reach my-mac over SSH: /)
  })

  test("does not start Codex when the plugin is unloaded while it looks for codex", async () => {
    let lookedUp!: () => void
    let release!: () => void
    const lookingUp = new Promise<void>((resolve) => (lookedUp = resolve))
    const released = new Promise<void>((resolve) => (release = resolve))
    const local = localHost()
    const host: Host = {
      ...local,
      findExecutable: async (candidates, name) => {
        lookedUp()
        await released
        return local.findExecutable(candidates, name)
      },
    }
    const { bridge, calls } = setup({ host })

    const call = bridge.run("ses_a", "1 + 1")
    await lookingUp
    const disposed = bridge.dispose()
    release()
    await expect(call).rejects.toThrow("opencode-codex-computer-use has been unloaded")
    await disposed
    expect(calls("initialize")).toHaveLength(0)
  })

  test("closes an app-server that finished starting after the plugin was unloaded", async () => {
    let disposed: Promise<void> | undefined
    const local = localHost()
    const host: Host = {
      ...local,
      // Unloads the plugin just as the app-server is being started.
      command: (command, args) => {
        disposed ??= bridge.dispose()
        return local.command(command, args)
      },
    }
    const { bridge, calls, logs } = setup({ host })

    await expect(bridge.run("ses_a", "1 + 1")).rejects.toThrow("opencode-codex-computer-use has been unloaded")
    await disposed
    expect(calls("initialize")).toHaveLength(1)
    expect(calls("thread/start")).toHaveLength(0)
    expect(logs.some((line) => line.startsWith("codex app-server exited"))).toBe(true)
  })

  test("stops the app-server after the idle timeout", async () => {
    const { bridge, calls, logs } = setup({ idleShutdownMs: 200 })
    await bridge.run("ses_a", "x")
    await Bun.sleep(600)
    expect(logs.some((line) => line.includes("exited"))).toBe(true)
    expect(calls("mcpServer/tool/call").some((call) => call.params.tool === "turn_ended")).toBe(true)
    const result = await bridge.run("ses_a", "y")
    expect(result.notes[0]).toContain("runtime was restarted")
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ComputerUseBridge, SetupError, type ApprovalMode } from "../src/bridge"

const FAKE_CODEX = join(import.meta.dir, "fixtures", "fake-codex")
const bridges: ComputerUseBridge[] = []

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.dispose()))
  delete process.env.FAKE_CODEX_NO_CUA
})

function setup(input: { approvals?: ApprovalMode; idleShutdownMs?: number } = {}) {
  const logFile = join(mkdtempSync(join(tmpdir(), "cua-bridge-")), "codex.log")
  process.env.FAKE_CODEX_LOG = logFile
  const logs: string[] = []
  const bridge = new ComputerUseBridge({
    codexPath: FAKE_CODEX,
    approvals: input.approvals ?? "codex",
    idleShutdownMs: input.idleShutdownMs ?? 0,
    callTimeoutMs: 10_000,
    cwd: "/tmp/project",
    version: "test",
    log: (message) => logs.push(message),
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

  test("concurrent first calls in one session share a thread", async () => {
    const { bridge, calls } = setup()
    await Promise.all([bridge.run("ses_a", "a"), bridge.run("ses_a", "b")])
    expect(calls("thread/start")).toHaveLength(1)
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

  test("codex mode keeps the Codex approval policy and declines forwarded prompts with a note", async () => {
    const { bridge, calls } = setup({ approvals: "codex" })
    const result = await bridge.run("ses_a", "ELICIT")
    expect(calls("thread/start")[0].params.approvalPolicy).toBeUndefined()
    expect(text(result)).toBe("elicitation:decline")
    expect(result.notes[0]).toContain('Declined "Allow Computer Use to use "Calculator"?"')
  })

  test("accept-session mode asks Codex to forward prompts and accepts them for the session only", async () => {
    const { bridge, calls, received } = setup({ approvals: "accept-session" })
    const result = await bridge.run("ses_a", "ELICIT")
    expect(calls("thread/start")[0].params.approvalPolicy).toBe("on-request")
    expect(text(result)).toBe("elicitation:accept")
    const answer = received().find((message) => message.id === 1000)
    expect(answer.result).toEqual({ action: "accept", content: {}, _meta: { persist: "session" } })
    expect(result.notes).toEqual([])
  })

  test("decline mode declines prompts", async () => {
    const { bridge, calls } = setup({ approvals: "decline" })
    const result = await bridge.run("ses_a", "ELICIT")
    expect(calls("thread/start")[0].params.approvalPolicy).toBe("on-request")
    expect(text(result)).toBe("elicitation:decline")
    expect(result.notes[0]).toContain('`approvals` is "decline"')
  })

  test("sends turn_ended once per turn that used Computer Use", async () => {
    const { bridge, calls } = setup()
    await bridge.endTurn("ses_a", "Stop")
    await bridge.run("ses_a", "x", { turnID: "msg_1" })
    await bridge.endTurn("ses_a", "Stop")
    await bridge.endTurn("ses_a", "Stop")

    const ended = calls("mcpServer/tool/call").filter((call) => call.params.tool === "turn_ended")
    expect(ended).toHaveLength(1)
    expect(ended[0].params.arguments).toEqual({ hook_event_name: "Stop", session_id: "thread-1", turn_id: "msg_1" })
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
    const error = await bridge.run("ses_a", "x").catch((error) => error)
    expect(error).toBeInstanceOf(SetupError)
    expect(error.message).toContain("no `cua_repl` MCP server")
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

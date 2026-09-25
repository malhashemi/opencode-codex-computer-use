#!/usr/bin/env bun
// Fake `codex app-server --listen stdio://` for tests. Appends every received message to $FAKE_CODEX_LOG.
import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"

const log = process.env.FAKE_CODEX_LOG
const record = (entry: unknown) => log && appendFileSync(log, JSON.stringify(entry) + "\n")
const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + "\n")

if (process.argv[2] !== "app-server") process.exit(2)
if (process.env.FAKE_CODEX_NO_CUA === "1") record({ note: "no cua" })

let threads = 0
let serverRequestID = 1000
const waiting = new Map<number, (result: any) => void>()

createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = JSON.parse(line)
  record(message)
  if (message.method === undefined && waiting.has(message.id)) {
    waiting.get(message.id)!(message.result ?? message.error)
    waiting.delete(message.id)
    return
  }
  const { id, method, params } = message
  switch (method) {
    case "initialize":
      return send({ id, result: { userAgent: "fake" } })
    case "initialized":
      return
    case "thread/start":
      return send({ id, result: { thread: { id: `thread-${++threads}`, ephemeral: params.ephemeral, path: null } } })
    case "thread/unsubscribe":
      return send({ id, result: { status: "unsubscribed" } })
    case "mcpServerStatus/list":
      return send({
        id,
        result: { data: process.env.FAKE_CODEX_NO_CUA === "1" ? [{ name: "node_repl" }] : [{ name: "cua_repl" }] },
      })
    case "mcpServer/tool/call":
      return toolCall(id, params)
    default:
      return send({ id, error: { code: -32601, message: `unknown method ${method}` } })
  }
})

async function toolCall(id: number, params: any) {
  if (process.env.FAKE_CODEX_NO_CUA === "1") {
    return send({ id, error: { code: -32602, message: `unknown MCP server ${params.server}` } })
  }
  if (params.tool !== "js") return send({ id, result: { content: [{ type: "text", text: "{}" }] } })
  const code: string = params.arguments.code
  if (code.includes("EXIT")) process.exit(1)
  if (code.includes("BROWSER")) {
    const meta = params._meta?.["x-codex-turn-metadata"]
    if (!meta?.session_id || !meta?.turn_id) {
      return send({
        id,
        result: {
          isError: true,
          content: [{ type: "text", text: "Missing required Codex turn metadata: session_id, turn_id" }],
        },
      })
    }
    return send({
      id,
      result: { content: [{ type: "text", text: 'BROWSERS=[{"id":"1","name":"Chrome","type":"extension"}]' }] },
    })
  }
  if (code.includes("THROW")) {
    return send({ id, result: { isError: true, content: [{ type: "text", text: "ReferenceError: boom" }] } })
  }
  if (code.includes("ELICIT")) {
    const requestID = serverRequestID++
    const answer = new Promise<any>((resolve) => waiting.set(requestID, resolve))
    send({
      id: requestID,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: params.threadId,
        serverName: "cua_repl",
        mode: "form",
        message: 'Allow Computer Use to use "Calculator"?',
      },
    })
    const result = await answer
    return send({ id, result: { content: [{ type: "text", text: `elicitation:${result.action}` }] } })
  }
  if (code.includes("IMAGE")) {
    return send({
      id,
      result: {
        content: [
          { type: "text", text: "shot" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" },
        ],
        _meta: { "codex/toolSurface": { app: { appId: "com.apple.finder", kind: "appId" }, kind: "computerUse" } },
      },
    })
  }
  if (code.includes("SLOW")) await new Promise((resolve) => setTimeout(resolve, 2_000))
  send({ id, result: { content: [{ type: "text", text: `ran on ${params.threadId}: ${code}` }] } })
}

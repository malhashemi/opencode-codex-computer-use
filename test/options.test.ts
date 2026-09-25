import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"

import { stripImages } from "../src/debug"
import { approvalCheck } from "../src/doctor"
import { describeTool } from "../src/index"
import { DEFAULT_DEBUG_LOG, parseOptions } from "../src/options"
import { surfaceGuard } from "../src/surfaces"

describe("parseOptions", () => {
  test("defaults", () => {
    expect(parseOptions({})).toEqual({
      codexPath: undefined,
      idleShutdownMs: 0,
      callTimeoutMs: 300_000,
      maxOutputBytes: 128 * 1024,
      screenshots: "image",
      surfaces: ["apps", "browser"],
      debugLog: undefined,
      warnings: [],
    })
  })

  test("custom values", () => {
    expect(
      parseOptions({
        codexPath: " /x/codex ",
        idleShutdownMinutes: 30,
        callTimeoutSeconds: 60,
        maxOutputKB: 0,
        screenshots: "ocr",
        surfaces: ["browser"],
        debug: "~/cu.jsonl",
      }),
    ).toEqual({
      codexPath: "/x/codex",
      idleShutdownMs: 1_800_000,
      callTimeoutMs: 60_000,
      maxOutputBytes: 0,
      screenshots: "ocr",
      surfaces: ["browser"],
      debugLog: join(homedir(), "cu.jsonl"),
      warnings: [],
    })
    expect(parseOptions({ debug: true }).debugLog).toBe(DEFAULT_DEBUG_LOG)
    expect(parseOptions({ surfaces: "apps" }).surfaces).toEqual(["apps"])
  })

  test("rejects invalid values", () => {
    expect(() => parseOptions({ screenshots: "video" })).toThrow("invalid option screenshots")
    expect(() => parseOptions({ surfaces: [] })).toThrow("invalid option surfaces")
    expect(() => parseOptions({ surfaces: ["apps", "files"] })).toThrow("invalid option surfaces")
  })
})

test("the removed approvals option is ignored with a warning", () => {
  const options = parseOptions({ approvals: "accept-session" })
  expect(options.warnings[0]).toContain('"approvals" option was removed')
  expect("approvals" in options).toBe(false)
})

describe("approvalCheck", () => {
  test("only never is fully automatic", () => {
    expect(approvalCheck("never")[0]).toBe("ok")
    expect(approvalCheck("on-request")).toEqual(["warn", expect.stringContaining('approval_policy = "on-request"')])
    expect(approvalCheck(undefined)[1]).toContain("approval_policy unknown")
  })
})

describe("surfaceGuard", () => {
  test("adds nothing when every surface is enabled", () => {
    expect(surfaceGuard(["apps", "browser"])).toBeUndefined()
  })

  test("disables browser methods on one line", () => {
    const guard = surfaceGuard(["apps"])!
    expect(guard).not.toContain("\n")
    expect(guard).toContain('cua["getBrowser"]')
    expect(guard).toContain("state.browsers = [];")
    expect(guard).not.toContain('cua["getApp"]')
  })

  test("runs against a stand-in cua object", async () => {
    const written: string[] = []
    const cua: Record<string, any> = {
      getApp: async () => "app",
      listApps: async () => [],
      getBrowser: async () => "browser",
      getState: async () => ({ apps: ["Notes"], browsers: ["Chrome"] }),
      computer: { launch_app: async () => {} },
    }
    const run = new Function("cua", "nodeRepl", "globalThis", `return (async () => { ${surfaceGuard(["apps"])} })()`)
    await run(cua, { write: (text: string) => written.push(text) }, {})
    await expect(cua.getBrowser()).rejects.toThrow(
      'Browser tabs are turned off by the opencode-codex-computer-use "surfaces" option.',
    )
    expect(await cua.getApp()).toBe("app")
    expect(await cua.getState({ emit: false })).toEqual({ apps: ["Notes"], browsers: [] })
  })
})

describe("describeTool", () => {
  test("mentions only the enabled surfaces and screenshot mode", () => {
    const appsOnly = describeTool(parseOptions({ surfaces: ["apps"], screenshots: "ocr" }))
    expect(appsOnly).toContain("Operate native desktop apps through")
    expect(appsOnly).toContain("Browser tabs are turned off")
    expect(appsOnly).toContain("recognized text")
    expect(describeTool(parseOptions({}))).toContain("native desktop apps and Chrome tabs")
  })
})

describe("stripImages", () => {
  test("replaces image data in nested messages", () => {
    expect(
      stripImages({
        result: {
          content: [
            { type: "image", data: "abcd" },
            { type: "text", text: "t" },
          ],
        },
      }),
    ).toEqual({
      result: {
        content: [
          { type: "image", data: "<4 base64 chars>" },
          { type: "text", text: "t" },
        ],
      },
    })
  })
})

import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"

import { ComputerUseBridge } from "../src/bridge"
import { stripImages } from "../src/debug"
import { approvalCheck, runDoctor } from "../src/doctor"
import { sshHost, type Host } from "../src/host"
import { describeTool } from "../src/index"
import { DEFAULT_DEBUG_LOG, parseOptions } from "../src/options"
import { surfaceGuard } from "../src/surfaces"

describe("parseOptions", () => {
  test("defaults", () => {
    expect(parseOptions({})).toEqual({
      codexPath: undefined,
      ssh: undefined,
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
        ssh: " me@my-mac ",
        idleShutdownMinutes: 30,
        callTimeoutSeconds: 60,
        maxOutputKB: 0,
        screenshots: "ocr",
        surfaces: ["browser"],
        debug: "~/cu.jsonl",
      }),
    ).toEqual({
      codexPath: "/x/codex",
      ssh: "me@my-mac",
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

  test("ssh takes one SSH destination", () => {
    expect(parseOptions({ ssh: "my-mac" }).ssh).toBe("my-mac")
    expect(parseOptions({ ssh: "  " }).ssh).toBeUndefined()
    expect(() => parseOptions({ ssh: "-oProxyCommand=sh" })).toThrow(
      '[codex-computer-use] invalid option ssh="-oProxyCommand=sh"; use an SSH destination such as "my-mac" or "me@my-mac"',
    )
    expect(() => parseOptions({ ssh: "me@my-mac -p 2222" })).toThrow('invalid option ssh="me@my-mac -p 2222"')
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

function doctor(host: Host) {
  const bridge = new ComputerUseBridge({
    host,
    idleShutdownMs: 0,
    callTimeoutMs: 1_000,
    cwd: "/",
    version: "test",
    log: () => {},
  })
  return runDoctor(bridge, parseOptions({ ssh: "my-mac" }), "doctor")
}

describe("runDoctor", () => {
  test("stops at the platform check when the Computer Use machine cannot be reached", async () => {
    const host: Host = {
      ...sshHost("my-mac"),
      info: async () => {
        throw new Error("Could not reach my-mac over SSH: ssh: Could not resolve hostname my-mac")
      },
    }
    const report = await doctor(host)
    expect(report.ok).toBe(false)
    expect(report.checks).toEqual([
      {
        name: "Platform",
        status: "fail",
        detail: "Could not reach my-mac over SSH: ssh: Could not resolve hostname my-mac",
      },
    ])
  })

  test("checks the platform and codex on the Computer Use machine", async () => {
    const searched: (string | undefined)[][] = []
    const host: Host = {
      ...sshHost("my-mac"),
      info: async () => ({
        platform: "darwin",
        arch: "arm64",
        home: "/Users/me",
        codexHome: "/Users/me/.codex",
        osVersion: "26.1",
      }),
      findExecutable: async (candidates) => {
        searched.push([...candidates])
        return undefined
      },
    }
    const report = await doctor(host)
    expect(report.checks).toEqual([
      { name: "Platform", status: "ok", detail: "macOS 26.1 (arm64) on my-mac over SSH" },
      { name: "codex executable", status: "fail", detail: expect.stringMatching(/^Not found on my-mac over SSH\. /) },
    ])
    expect(searched[0]).toContain("/Applications/ChatGPT.app/Contents/Resources/codex")
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

  test("says when the apps and tabs are on another machine", () => {
    expect(describeTool(parseOptions({}))).not.toContain("SSH")
    const remote = describeTool(parseOptions({ ssh: "my-mac" }))
    expect(remote).toContain("are on my-mac (reached over SSH), a different machine")
    expect(remote).toContain("local files are not visible there until copied (for example with `scp <file> my-mac:`).")
    expect(remote.split("\n").filter((line) => line.includes("SSH"))).toHaveLength(1)
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

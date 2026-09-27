import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import { localHost, runOnHost, shellQuote, sshHost } from "../src/host"

const FIXTURES = join(import.meta.dir, "fixtures")
const FAKE_CODEX = join(FIXTURES, "fake-codex")
const FAKE_SSH_DIR = join(FIXTURES, "fake-ssh")
const PATH = process.env.PATH

afterEach(() => {
  process.env.PATH = PATH
  delete process.env.FAKE_SSH_HOME
})

/** An executable file whose directory and name need quoting. */
function awkwardExecutable(): string {
  const path = join(mkdtempSync(join(tmpdir(), "cu host ")), "it's codex")
  writeFileSync(path, "#!/bin/sh\n")
  chmodSync(path, 0o755)
  return path
}

describe("shellQuote", () => {
  test("quotes every word so the remote shell reads it back unchanged", () => {
    expect(shellQuote("codex")).toBe("'codex'")
    expect(shellQuote("a b")).toBe("'a b'")
    expect(shellQuote("it's")).toBe("'it'\\''s'")
    expect(shellQuote("")).toBe("''")
  })
})

describe("command", () => {
  test("an SSH host runs the quoted command through ssh with fixed options", () => {
    const host = sshHost("me@my-mac")
    expect(host.remote).toBe(true)
    expect(host.label).toBe("me@my-mac over SSH")
    expect(
      host.command("/Applications/ChatGPT.app/Contents/Resources/codex", ["app-server", "--listen", "stdio://"]),
    ).toEqual({
      file: "ssh",
      args: [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=15",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=4",
        "--",
        "me@my-mac",
        "'/Applications/ChatGPT.app/Contents/Resources/codex' 'app-server' '--listen' 'stdio://'",
      ],
    })
  })

  test("this machine runs the command as is", () => {
    const host = localHost()
    expect(host.remote).toBe(false)
    expect(host.label).toBe("this machine")
    expect(host.command("/usr/bin/plutil", ["-extract", "a b"])).toEqual({
      file: "/usr/bin/plutil",
      args: ["-extract", "a b"],
    })
  })
})

describe("runOnHost", () => {
  test("writes the input to stdin and returns stdout", async () => {
    expect(await runOnHost(localHost(), "cat", [], { input: "hello" })).toBe("hello")
    expect(await runOnHost(localHost(), "cat", [], { input: new Uint8Array([104, 105]) })).toBe("hi")
    expect(await runOnHost(localHost(), "cat", [])).toBe("")
  })

  test("rejects with stderr, or the exit code when stderr is empty", async () => {
    await expect(runOnHost(localHost(), "sh", ["-c", "echo ' went wrong ' >&2; exit 3"])).rejects.toThrow(
      /^went wrong$/,
    )
    await expect(runOnHost(localHost(), "sh", ["-c", "exit 4"])).rejects.toThrow("sh exited with code 4")
  })

  test("rejects when the program cannot start", async () => {
    await expect(runOnHost(localHost(), join(FIXTURES, "missing"), [])).rejects.toThrow()
  })

  test("kills the process on timeout", async () => {
    const started = performance.now()
    await expect(runOnHost(localHost(), "sleep", ["5"], { timeoutMs: 100 })).rejects.toThrow(
      "sleep timed out after 100 ms",
    )
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  test("gives up at once even when leftover processes keep the output open", async () => {
    const started = performance.now()
    await expect(runOnHost(localHost(), "/bin/sh", ["-c", "sleep 5 & sleep 5"], { timeoutMs: 100 })).rejects.toThrow(
      "/bin/sh timed out after 100 ms",
    )
    await expect(
      runOnHost(localHost(), "/bin/sh", ["-c", "sleep 5 & head -c 100000 /dev/zero"], {
        timeoutMs: 5_000,
        maxBuffer: 1_000,
      }),
    ).rejects.toThrow("/bin/sh wrote more than 1000 bytes")
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  test("kills the process when stdout exceeds maxBuffer", async () => {
    await expect(runOnHost(localHost(), "sh", ["-c", "yes | head -c 100000"], { maxBuffer: 1_000 })).rejects.toThrow(
      "sh wrote more than 1000 bytes",
    )
  })
})

describe("localHost", () => {
  test("describes this machine", async () => {
    const info = await localHost().info()
    expect(info).toMatchObject({ platform: process.platform, arch: process.arch })
    expect(info.codexHome).toBe(process.env.CODEX_HOME || join(info.home, ".codex"))
    expect(info.osVersion === undefined).toBe(process.platform !== "darwin")
  })

  test("finds the first executable candidate, then the name on PATH", async () => {
    const host = localHost()
    process.env.PATH = FIXTURES
    expect(await host.findExecutable([undefined, "", "/nope/codex", FAKE_CODEX], "codex")).toBe(FAKE_CODEX)
    expect(await host.findExecutable([join(FIXTURES, "fake-codex.ts")], "fake-codex")).toBe(FAKE_CODEX)
    expect(await host.findExecutable([], "codex")).toBeUndefined()
    process.env.PATH = "/nope"
    expect(await host.findExecutable(["/nope/codex"], "fake-codex")).toBeUndefined()
  })

  test("checks whether a path exists", async () => {
    expect(await localHost().exists(FAKE_CODEX)).toBe(true)
    expect(await localHost().exists(join(FIXTURES, "missing"))).toBe(false)
  })
})

describe("sshHost through a stand-in ssh", () => {
  let home: string

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "cu remote home "))
  })

  const useFakeSsh = () => {
    process.env.PATH = `${FAKE_SSH_DIR}${delimiter}${PATH}`
    process.env.FAKE_SSH_HOME = home
  }

  test("passes every argument through the remote shell unchanged", async () => {
    useFakeSsh()
    const args = ["a b", "it's", "$HOME", "", "two\nlines", "`id` $(id)", '"q"', "back\\slash", "*"]
    expect(await runOnHost(sshHost("my-mac"), "printf", ["%s|", ...args])).toBe(args.map((arg) => `${arg}|`).join(""))
  })

  test("sends the input and reports remote failures", async () => {
    useFakeSsh()
    expect(await runOnHost(sshHost("my-mac"), "cat", [], { input: "over ssh" })).toBe("over ssh")
    await expect(runOnHost(sshHost("my-mac"), "sh", ["-c", "echo nope >&2; exit 1"])).rejects.toThrow("nope")
  })

  test("describes the remote machine", async () => {
    useFakeSsh()
    const local = await localHost().info()
    expect(await sshHost("my-mac").info()).toEqual({
      ...local,
      home,
      codexHome: process.env.CODEX_HOME || join(home, ".codex"),
    })
  })

  test("names the machine it could not reach, with the reason", async () => {
    // ssh starts, but the remote side fails: the stand-in cannot find sh on this PATH.
    process.env.PATH = FAKE_SSH_DIR
    await expect(sshHost("my-mac").info()).rejects.toThrow(/^Could not reach my-mac over SSH: .*not found/)
  })

  test("names the machine when it stops answering after the first contact", async () => {
    useFakeSsh()
    const host = sshHost("my-mac")
    await host.info()
    process.env.PATH = FAKE_SSH_DIR
    await expect(host.findExecutable([FAKE_CODEX], "codex")).rejects.toThrow(
      /^Could not reach my-mac over SSH: .*not found/,
    )
  })

  test("caches the description once it succeeds, and only then", async () => {
    const host = sshHost("my-mac")
    process.env.PATH = join(FIXTURES, "missing")
    await expect(host.info()).rejects.toThrow(/^Could not reach my-mac over SSH: /)
    useFakeSsh()
    expect((await host.info()).home).toBe(home)
    process.env.PATH = join(FIXTURES, "missing")
    expect((await host.info()).home).toBe(home)
  })

  test("finds executables on the remote machine", async () => {
    useFakeSsh()
    const host = sshHost("my-mac")
    const awkward = awkwardExecutable()
    expect(await host.findExecutable([undefined, "", "/nope/codex", FIXTURES, awkward, FAKE_CODEX], "codex")).toBe(
      awkward,
    )
    expect(await host.findExecutable([join(FIXTURES, "fake-codex.ts")], "sh")).toMatch(/\/sh$/)
    expect(await host.findExecutable(["/nope/codex"], "no-such-command-for-cu-tests")).toBeUndefined()
  })

  test("checks whether a path exists on the remote machine", async () => {
    useFakeSsh()
    const host = sshHost("my-mac")
    expect(await host.exists(awkwardExecutable())).toBe(true)
    expect(await host.exists(join(home, "missing"))).toBe(false)
  })
})

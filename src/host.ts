import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { accessSync, constants, existsSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"

/** Facts about the machine that runs Codex Computer Use. */
export interface HostInfo {
  /** Node-style platform: "darwin", "linux", "win32"; other systems: lowercased `uname -s`. */
  platform: string
  /** Node-style architecture: "arm64" (arm64/aarch64), "x64" (x86_64/amd64); otherwise raw `uname -m`. */
  arch: string
  /** Home directory on the host. */
  home: string
  /** $CODEX_HOME on the host, or <home>/.codex. */
  codexHome: string
  /** `sw_vers -productVersion`, only on darwin (undefined if unavailable). */
  osVersion?: string
}

export interface RunOptions {
  /** Written to stdin, which is then closed. Without it stdin is closed immediately. */
  input?: Uint8Array | string
  /** Default 15_000. On timeout the process is killed and the promise rejects. */
  timeoutMs?: number
  /** Maximum stdout bytes, default 16 MiB; exceeding it kills the process and rejects. */
  maxBuffer?: number
}

/** Where Codex Computer Use runs: this machine, or another one reached over SSH. */
export interface Host {
  /** True when commands run on another machine over SSH. */
  readonly remote: boolean
  /** For messages: "this machine", or "<destination> over SSH". */
  readonly label: string
  /** Program and arguments that run `command args` on the host. Local: unchanged. */
  command(command: string, args: readonly string[]): { file: string; args: string[] }
  /** Cached after the first success; failures (e.g. SSH unreachable) are not cached. */
  info(): Promise<HostInfo>
  /** First candidate that is an executable file on the host (undefined/empty entries skipped); otherwise `name`
   *  looked up on the host's PATH; undefined when nothing is found. */
  findExecutable(candidates: readonly (string | undefined)[], name: string): Promise<string | undefined>
  /** Whether `path` exists on the host. Any failure reads as false. */
  exists(path: string): Promise<boolean>
}

/**
 * Added to every SSH connection: no prompts (a password prompt would hang the plugin), a bounded connection time,
 * and keep-alives so a dead connection ends the app-server instead of leaving calls waiting.
 */
export const SSH_OPTIONS: readonly string[] = [
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=15",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=4",
]

const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024

/** This machine. */
export function localHost(): Host {
  const host: Host = {
    remote: false,
    label: "this machine",
    command: (command, args) => ({ file: command, args: [...args] }),
    info: cacheSuccess(async () => {
      const home = homedir()
      return {
        platform: process.platform,
        arch: process.arch,
        home,
        codexHome: process.env.CODEX_HOME || join(home, ".codex"),
        osVersion:
          process.platform === "darwin"
            ? await runOnHost(host, "/usr/bin/sw_vers", ["-productVersion"]).then(
                (out) => out.trim() || undefined,
                () => undefined,
              )
            : undefined,
      }
    }),
    findExecutable: async (candidates, name) => {
      const onPath = (process.env.PATH ?? process.env.Path ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => join(directory, process.platform === "win32" ? `${name}.exe` : name))
      return [...candidates, ...onPath].find((candidate): candidate is string => !!candidate && isExecutable(candidate))
    },
    exists: async (path) => existsSync(path),
  }
  return host
}

// The remote side needs a POSIX `sh` (macOS or Linux). Values reach these scripts as positional arguments, never
// inside the script text.
const INFO_SCRIPT =
  'uname -s; uname -m; printf "%s\\n" "$HOME" "${CODEX_HOME:-$HOME/.codex}"; sw_vers -productVersion 2>/dev/null || echo'
const FIND_SCRIPT =
  'name=$1; shift; for p in "$@"; do if [ -f "$p" ] && [ -x "$p" ]; then printf "%s\\n" "$p"; exit 0; fi; done; ' +
  'command -v "$name" || true'

/** Another machine, reached with the system `ssh` and the user's SSH configuration for `destination`. */
export function sshHost(destination: string): Host {
  const host: Host = {
    remote: true,
    label: `${destination} over SSH`,
    // ssh joins the remote command into one string for the remote login shell; quoting each word makes the round
    // trip exact.
    command: (command, args) => ({
      file: "ssh",
      args: [...SSH_OPTIONS, "--", destination, [command, ...args].map(shellQuote).join(" ")],
    }),
    info: cacheSuccess(async () => {
      // Usually the first contact with the machine, so its failure is what users see, from a tool call or the doctor:
      // it names the machine, and waits longer than ssh's ConnectTimeout so ssh's own reason gets through.
      const output = await runOnHost(host, "sh", ["-c", INFO_SCRIPT], { timeoutMs: 30_000 }).catch((error: unknown) => {
        throw new Error(`Could not reach ${host.label}: ${error instanceof Error ? error.message : String(error)}`)
      })
      const [system = "", machine = "", home = "", codexHome = "", version = ""] = output.split("\n")
      if (!system.trim() || !home) throw new Error(`unexpected system information: ${JSON.stringify(output)}`)
      const platform = system.trim().toLowerCase()
      return {
        platform,
        arch: normalizeArch(machine.trim()),
        home,
        codexHome,
        osVersion: platform === "darwin" ? version.trim() || undefined : undefined,
      }
    }),
    findExecutable: async (candidates, name) => {
      const paths = candidates.filter((candidate): candidate is string => !!candidate)
      const output = await runOnHost(host, "sh", ["-c", FIND_SCRIPT, "sh", name, ...paths])
      return output.trim() || undefined
    },
    exists: (path) =>
      runOnHost(host, "test", ["-e", path]).then(
        () => true,
        () => false,
      ),
  }
  return host
}

/** Starts `command args` on the host with piped stdio (env: process.env). */
export function spawnOnHost(host: Host, command: string, args: readonly string[]): ChildProcessWithoutNullStreams {
  const target = host.command(command, args)
  return spawn(target.file, target.args, { stdio: ["pipe", "pipe", "pipe"], env: process.env })
}

/** Runs `command args` on the host to completion; resolves with stdout (utf8). Rejects on spawn error, non-zero
 *  exit (message: trimmed stderr, else "<command> exited with code N"), timeout, or maxBuffer. */
export function runOnHost(
  host: Host,
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 15_000
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER
  return new Promise((resolve, reject) => {
    const child = spawnOnHost(host, command, args)
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let size = 0
    let settled = false
    const settle = (error: Error | undefined, output = "") => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(output)
    }
    // Settles at once instead of waiting for "close": descendants of the process (or an ssh ProxyCommand) can keep
    // its output open long after it is killed, and our ends of the pipes must not wait for them.
    const abandon = (error: Error) => {
      settle(error)
      child.kill("SIGKILL")
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
    }
    const timer = setTimeout(() => abandon(new Error(`${command} timed out after ${timeoutMs} ms`)), timeoutMs)

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > maxBuffer) return abandon(new Error(`${command} wrote more than ${maxBuffer} bytes`))
      stdout.push(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.once("error", (error) => settle(error))
    child.once("close", (code, signal) => {
      if (code === 0) return settle(undefined, Buffer.concat(stdout).toString("utf8"))
      const message = Buffer.concat(stderr).toString("utf8").trim()
      const status = code === null ? `was stopped by ${signal}` : `exited with code ${code}`
      settle(new Error(message || `${command} ${status}`))
    })
    // The process may exit without reading its input.
    child.stdin.on("error", () => {})
    child.stdin.end(options.input)
  })
}

/** POSIX single-quoting of one word: 'it'\''s'. The empty string becomes ''. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Caches a successful lookup; a failed one (for example while SSH is unreachable) is retried on the next call. */
function cacheSuccess<T>(load: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | undefined
  return () => {
    cached ??= load().catch((error: unknown) => {
      cached = undefined
      throw error
    })
    return cached
  }
}

function normalizeArch(machine: string): string {
  if (machine === "arm64" || machine === "aarch64") return "arm64"
  if (machine === "x86_64" || machine === "amd64") return "x64"
  return machine
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

#!/usr/bin/env bun
// Read-only setup check, the same as OpenCode's /computer-use-doctor command.
// Usage: bun scripts/smoke.ts [path/to/codex] [--ocr] [--ssh <destination>]
import { ComputerUseBridge } from "../src/bridge"
import { runDoctor } from "../src/doctor"
import { localHost, sshHost } from "../src/host"
import { parseOptions } from "../src/options"

const args = process.argv.slice(2)
const sshAt = args.indexOf("--ssh")
if (sshAt >= 0 && !args[sshAt + 1]) {
  console.error("Usage: bun scripts/smoke.ts [path/to/codex] [--ocr] [--ssh <destination>]")
  process.exit(2)
}
const options = parseOptions({
  codexPath: args.find((arg, index) => !arg.startsWith("--") && (sshAt < 0 || index !== sshAt + 1)),
  screenshots: args.includes("--ocr") ? "both" : "image",
  ssh: sshAt >= 0 ? args[sshAt + 1] : undefined,
})
const host = options.ssh ? sshHost(options.ssh) : localHost()
const bridge = new ComputerUseBridge({
  ...options,
  host,
  idleShutdownMs: 0,
  cwd: process.cwd(),
  version: "smoke",
  log: () => {},
})

const report = await runDoctor(bridge, options, "smoke")
await bridge.dispose()
console.log(report.text)
process.exit(report.ok ? 0 : 1)

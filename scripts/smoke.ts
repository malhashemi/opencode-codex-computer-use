#!/usr/bin/env bun
// Read-only setup check, the same as OpenCode's /computer-use-doctor command.
// Usage: bun scripts/smoke.ts [path/to/codex] [--ocr]
import { ComputerUseBridge } from "../src/bridge"
import { runDoctor } from "../src/doctor"
import { parseOptions } from "../src/options"

const args = process.argv.slice(2)
const options = parseOptions({
  codexPath: args.find((arg) => !arg.startsWith("--")),
  screenshots: args.includes("--ocr") ? "both" : "image",
})
const bridge = new ComputerUseBridge({
  ...options,
  idleShutdownMs: 0,
  cwd: process.cwd(),
  version: "smoke",
  log: () => {},
})

const report = await runDoctor(bridge, options, "smoke")
await bridge.dispose()
console.log(report.text)
process.exit(report.ok ? 0 : 1)

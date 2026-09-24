#!/usr/bin/env bun
// Read-only check that the installed Codex Computer Use engine is reachable: reads Finder's UI and takes a screenshot.
// Usage: bun scripts/smoke.ts [path/to/codex]
import { ComputerUseBridge } from "../src/bridge"
import { resolveCodexPath } from "../src/codex-path"
import { imageMime } from "../src/content"

const codexPath = resolveCodexPath(process.argv[2])
console.log(`codex: ${codexPath ?? "not found"}`)

const bridge = new ComputerUseBridge({
  codexPath,
  approvals: "codex",
  idleShutdownMs: 0,
  callTimeoutMs: 120_000,
  cwd: process.cwd(),
  version: "smoke",
  log: (message) => console.log(`  ${message}`),
})

let failed = false
try {
  const started = performance.now()
  const state = await bridge.run(
    "smoke",
    'let app = await cua.getApp("Finder");\nnodeRepl.write("bound Finder");',
  )
  const text = state.content.map((block) => block.text ?? "").join("\n")
  const elements = text.match(/^\s*\d+ /gm)?.length ?? 0
  console.log(`getApp("Finder"): ${Math.round(performance.now() - started)} ms, ${elements} UI elements, error=${state.isError}`)
  if (state.isError || elements === 0) throw new Error(text.slice(0, 2_000))

  const shot = await bridge.run("smoke", "await app.getScreenshot({ emit: true });")
  const image = shot.content.find((block) => block.type === "image")
  const size = Math.round(((image?.data?.length ?? 0) * 3) / 4 / 1024)
  console.log(`getScreenshot(): ${image ? `${imageMime(image.data ?? "", image.mimeType)}, ${size} KB` : "no image"}`)
  if (!image) throw new Error("no screenshot returned")

  const browsers = await bridge.run(
    "smoke",
    'let bs = await cua.listBrowsers({ emit: false });\nnodeRepl.write("BROWSERS=" + JSON.stringify(bs.map(b => `${b.name ?? b.id} (${b.type})`)));',
  )
  const listed = browsers.content.map((block) => block.text ?? "").join("\n")
  const match = listed.match(/BROWSERS=(.*)/)
  if (browsers.isError || !match) {
    console.log(`listBrowsers(): unavailable (${listed.split("\n").find(Boolean) ?? "no output"})`)
  } else {
    const names: string[] = JSON.parse(match[1]!)
    console.log(`listBrowsers(): ${names.length ? names.join(", ") : "none (install the ChatGPT for Chrome extension for Chrome tabs)"}`)
  }

  await bridge.endTurn("smoke", "Stop")
  console.log("\nOK: Codex Computer Use is reachable from this machine.")
} catch (error) {
  failed = true
  console.error(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await bridge.dispose()
}
process.exit(failed ? 1 : 0)

import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { CUA_SERVER, type ComputerUseBridge, type McpContentBlock } from "./bridge"
import { imageMime, textOf } from "./content"
import { recognizeText } from "./ocr"
import type { Options } from "./options"

type Status = "ok" | "warn" | "fail" | "skip"

interface Check {
  name: string
  status: Status
  detail: string
}

const ICONS: Record<Status, string> = { ok: "✅", warn: "⚠️", fail: "❌", skip: "➖" }

export interface DoctorReport {
  ok: boolean
  checks: Check[]
  text: string
}

/** Read-only checks of everything the plugin needs. Uses its own throwaway Codex thread. */
export async function runDoctor(
  bridge: ComputerUseBridge,
  options: Options,
  sessionKey: string,
): Promise<DoctorReport> {
  const checks: Check[] = []
  const add = (name: string, status: Status, detail: string) => checks.push({ name, status, detail })

  add("Platform", ...(await platformCheck()))

  const codexPath = bridge.codexPath
  if (!codexPath) {
    add(
      "codex executable",
      "fail",
      "Not found. Install the ChatGPT (or Codex) desktop app, or set the `codexPath` option.",
    )
    return report(checks, options)
  }
  const version = await run(codexPath, ["--version"]).catch(() => "unknown version")
  add("codex executable", "ok", `${codexPath} (${version.trim()})`)

  if (process.platform === "darwin") add("Computer Use app", ...(await computerUseAppCheck()))

  try {
    const names = await bridge.serverNames(sessionKey)
    if (!names.includes(CUA_SERVER)) {
      add(
        "Computer Use runtime",
        "fail",
        `Codex started, but has no \`${CUA_SERVER}\` server. Turn on Computer Use in the ChatGPT/Codex app, then run this again.`,
      )
      return report(checks, options)
    }
    add("Computer Use runtime", "ok", `Codex app-server running with \`${CUA_SERVER}\``)
    add("App access", ...approvalCheck(await bridge.approvalPolicy().catch(() => undefined)))

    const probe = (code: string) => bridge.run(sessionKey, code)

    if (options.surfaces.includes("apps")) {
      const apps = await probe('nodeRepl.write("APPS=" + (await cua.listApps({ emit: false })).length);')
      const count = textOf(apps.content).match(/APPS=(\d+)/)?.[1]
      add(
        "Native apps",
        count ? "ok" : "fail",
        count ? `Engine reachable, ${count} apps listed` : firstLine(apps.content, "Could not list apps"),
      )

      if (process.platform === "darwin" && count) {
        const shot = await probe(
          'const __doctorFinder = await cua.getApp("com.apple.finder"); await __doctorFinder.getScreenshot({ emit: true }); nodeRepl.write("SHOT");',
        ).catch((error: unknown) => ({
          content: [{ type: "text", text: String(error) }] as McpContentBlock[],
          isError: true,
        }))
        const image = shot.content.find((block) => block.type === "image" && typeof block.data === "string")
        add(
          "Screenshots",
          image ? "ok" : "warn",
          image
            ? `Finder screenshot captured (${imageMime(image.data!, image.mimeType)}, ${Math.round((image.data!.length * 0.75) / 1024)} KB)`
            : `No screenshot: ${firstLine(shot.content, "unknown error")}. Check Screen Recording permission for Codex Computer Use.`,
        )
        if (options.screenshots === "ocr" || options.screenshots === "both") {
          add("OCR", ...(await ocrCheck(image?.data)))
        }
      }
    } else {
      add("Native apps", "skip", "Turned off by the `surfaces` option")
    }

    if (options.surfaces.includes("browser")) {
      const browsers = await probe(
        'nodeRepl.write("BROWSERS=" + JSON.stringify((await cua.listBrowsers({ emit: false })).map(b => `${b.name ?? b.id} (${b.type})`)));',
      )
      const match = textOf(browsers.content).match(/BROWSERS=(.*)/)
      const connected: string[] = match ? JSON.parse(match[1]!) : []
      add(
        "Browser tabs",
        connected.length ? "ok" : "warn",
        connected.length
          ? `Connected: ${connected.join(", ")}`
          : match
            ? "No browser connected. Install and connect the ChatGPT for Chrome extension from the ChatGPT/Codex app."
            : firstLine(browsers.content, "Could not list browsers"),
      )
    } else {
      add("Browser tabs", "skip", "Turned off by the `surfaces` option")
    }
  } catch (error) {
    add("Computer Use runtime", "fail", error instanceof Error ? error.message : String(error))
  } finally {
    await bridge.closeSession(sessionKey)
  }
  return report(checks, options)
}

function report(checks: Check[], options: Options): DoctorReport {
  const ok = !checks.some((check) => check.status === "fail")
  const lines = [
    `## Codex Computer Use doctor: ${ok ? "ready" : "not ready"}`,
    "",
    ...checks.map((check) => `- ${ICONS[check.status]} **${check.name}**: ${check.detail}`),
    "",
    `Options: surfaces=${options.surfaces.join("+")}, screenshots=${options.screenshots}, ` +
      `maxOutputKB=${Math.round(options.maxOutputBytes / 1024) || "unlimited"}, ` +
      `idleShutdownMinutes=${options.idleShutdownMs / 60_000 || "never"}, debug=${options.debugLog ?? "off"}`,
  ]
  return { ok, checks, text: lines.join("\n") }
}

export function approvalCheck(policy: string | undefined): [Status, string] {
  if (policy === "never") return ["ok", 'Codex approves app access itself (approval_policy = "never")']
  const setting = policy ? `approval_policy = "${policy}"` : "approval_policy unknown"
  return [
    "warn",
    `${setting}: apps you have not approved permanently in ChatGPT/Codex will be declined, because OpenCode cannot ` +
      'show Computer Use\'s approval prompts yet. Approve apps once in ChatGPT/Codex, or set approval_policy = "never".',
  ]
}

async function platformCheck(): Promise<[Status, string]> {
  if (process.platform === "darwin") {
    const version = (await run("/usr/bin/sw_vers", ["-productVersion"]).catch(() => "")).trim()
    const [major = 0, minor = 0] = version.split(".").map(Number)
    const supported = major > 14 || (major === 14 && minor >= 4)
    if (process.arch !== "arm64")
      return ["fail", `macOS ${version} on ${process.arch}: Computer Use requires Apple Silicon`]
    return supported
      ? ["ok", `macOS ${version} (arm64)`]
      : ["fail", `macOS ${version}: Computer Use requires 14.4 or later`]
  }
  if (process.platform === "win32" || process.platform === "linux") {
    return [
      "warn",
      `${process.platform} (${process.arch}): supported by Codex Computer Use, experimental in this plugin`,
    ]
  }
  return ["fail", `${process.platform} is not supported by Codex Computer Use`]
}

async function computerUseAppCheck(): Promise<[Status, string]> {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex")
  const app = join(codexHome, "computer-use", "Codex Computer Use.app")
  if (!existsSync(app)) return ["fail", `Not installed at ${app}. Turn on Computer Use in the ChatGPT/Codex app.`]
  const version = await run("/usr/bin/plutil", [
    "-extract",
    "CFBundleShortVersionString",
    "raw",
    join(app, "Contents", "Info.plist"),
  ])
    .then((out) => out.trim())
    .catch(() => "unknown version")
  return ["ok", `${app} (${version})`]
}

async function ocrCheck(data: string | undefined): Promise<[Status, string]> {
  if (!data) return ["skip", "No screenshot to test with"]
  try {
    const started = performance.now()
    const result = await recognizeText(Buffer.from(data, "base64"))
    return ["ok", `${result.lines.length} text lines recognized in ${Math.round(performance.now() - started)} ms`]
  } catch (error) {
    return ["fail", `On-device OCR failed: ${error instanceof Error ? error.message : String(error)}`]
  }
}

function firstLine(blocks: readonly McpContentBlock[], fallback: string): string {
  return (
    textOf(blocks)
      .split("\n")
      .find((line) => line.trim() && !line.startsWith("#")) ?? fallback
  ).slice(0, 300)
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(command, args, { timeout: 15_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout))),
  )
}

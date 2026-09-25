import { homedir } from "node:os"
import { join } from "node:path"

import type { PluginOptions } from "@opencode/plugin"

export const SCREENSHOT_MODES = ["image", "ocr", "both", "off"] as const
export type ScreenshotMode = (typeof SCREENSHOT_MODES)[number]

export const SURFACES = ["apps", "browser"] as const
export type Surface = (typeof SURFACES)[number]

export interface Options {
  codexPath?: string
  idleShutdownMs: number
  callTimeoutMs: number
  /** Maximum text returned by one call, in bytes. 0 disables the limit. */
  maxOutputBytes: number
  screenshots: ScreenshotMode
  surfaces: readonly Surface[]
  /** JSONL file receiving the app-server traffic, or undefined when debugging is off. */
  debugLog?: string
  /** Messages about options that were accepted but have no effect. */
  warnings: readonly string[]
}

export const DEFAULT_DEBUG_LOG = join(
  process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
  "opencode",
  "log",
  "codex-computer-use.jsonl",
)

export function parseOptions(raw: PluginOptions): Options {
  const warnings: string[] = []
  if (raw.approvals !== undefined) {
    warnings.push(
      'The "approvals" option was removed in 0.1.1 and is ignored: app access follows your Codex approval_policy.',
    )
  }
  return {
    codexPath: typeof raw.codexPath === "string" && raw.codexPath.trim() ? raw.codexPath.trim() : undefined,
    idleShutdownMs: nonNegative(raw.idleShutdownMinutes, 0) * 60_000,
    callTimeoutMs: positive(raw.callTimeoutSeconds, 300) * 1_000,
    maxOutputBytes: Math.round(nonNegative(raw.maxOutputKB, 128) * 1024),
    screenshots: oneOf("screenshots", raw.screenshots, SCREENSHOT_MODES, "image"),
    surfaces: surfaces(raw.surfaces),
    debugLog: debugLog(raw.debug),
    warnings,
  }
}

function oneOf<T extends string>(name: string, value: unknown, allowed: readonly T[], fallback: T): T {
  if (value === undefined) return fallback
  if (allowed.includes(value as T)) return value as T
  throw new Error(`[codex-computer-use] invalid option ${name}=${JSON.stringify(value)}; use ${allowed.join(", ")}`)
}

function nonNegative(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
}

function surfaces(value: unknown): readonly Surface[] {
  if (value === undefined) return SURFACES
  const list = Array.isArray(value) ? value : [value]
  const invalid = list.filter((item) => !SURFACES.includes(item))
  if (invalid.length > 0 || list.length === 0) {
    throw new Error(
      `[codex-computer-use] invalid option surfaces=${JSON.stringify(value)}; use a non-empty list of ${SURFACES.join(", ")}`,
    )
  }
  return SURFACES.filter((surface) => list.includes(surface))
}

function debugLog(value: unknown): string | undefined {
  if (value === true) return DEFAULT_DEBUG_LOG
  if (typeof value === "string" && value.trim()) {
    const path = value.trim()
    return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path
  }
  return undefined
}

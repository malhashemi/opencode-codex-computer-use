import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

/**
 * Appends every app-server message to a JSONL file. Screenshot data is replaced by its size; everything else
 * (accessibility trees, page text, code) is written as is, so the log can contain sensitive data.
 */
export function trafficLogger(path: string, log: (message: string) => void) {
  let failed = false
  mkdirSync(dirname(path), { recursive: true })
  return (direction: "send" | "receive", message: unknown) => {
    if (failed) return
    try {
      appendFileSync(path, JSON.stringify({ time: new Date().toISOString(), direction, message: stripImages(message) }) + "\n")
    } catch (error) {
      failed = true
      log(`debug log disabled, could not write ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

export function stripImages(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripImages)
  if (value === null || typeof value !== "object") return value
  const record = value as Record<string, unknown>
  if (record.type === "image" && typeof record.data === "string") {
    return { ...record, data: `<${record.data.length} base64 chars>` }
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, stripImages(item)]))
}

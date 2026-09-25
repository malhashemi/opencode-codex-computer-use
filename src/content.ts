import type { McpContentBlock } from "./bridge"
import { formatOcr, recognizeText, type OcrResult } from "./ocr"
import type { ScreenshotMode } from "./options"

export type ToolContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }

export interface ContentOptions {
  screenshots?: ScreenshotMode
  /** Maximum bytes of text across all blocks; 0 or undefined disables the limit. Notes are never cut. */
  maxOutputBytes?: number
  ocr?: (image: Uint8Array) => Promise<OcrResult>
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
}

/** Base64 prefixes of image magic bytes. The engine has been seen labelling JPEG screenshots as image/png. */
const SIGNATURES: readonly [prefix: string, mime: string][] = [
  ["/9j/", "image/jpeg"],
  ["iVBORw0KGgo", "image/png"],
  ["UklGR", "image/webp"],
  ["R0lGOD", "image/gif"],
]

export function imageMime(data: string, declared?: unknown): string {
  const sniffed = SIGNATURES.find(([prefix]) => data.startsWith(prefix))?.[1]
  return sniffed ?? (typeof declared === "string" ? declared : "image/png")
}

/** Maps MCP content blocks returned by `cua_repl` to OpenCode tool content. */
export async function toToolContent(
  blocks: readonly McpContentBlock[],
  notes: readonly string[] = [],
  options: ContentOptions = {},
): Promise<ToolContent[]> {
  const mode = options.screenshots ?? "image"
  const ocr = options.ocr ?? recognizeText
  let images = 0
  const pending = blocks.map(async (block): Promise<ToolContent[]> => {
    if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }]
    if (block.type !== "image" || typeof block.data !== "string") {
      return [{ type: "text", text: JSON.stringify(block) }]
    }
    const index = ++images
    const mime = imageMime(block.data, block.mimeType)
    const items: ToolContent[] = []
    if (mode === "image" || mode === "both") {
      items.push({
        type: "file",
        uri: `data:${mime};base64,${block.data}`,
        mime,
        name: `screenshot-${index}.${EXTENSIONS[mime] ?? "img"}`,
      })
    }
    if (mode === "ocr" || mode === "both") {
      try {
        items.push({ type: "text", text: formatOcr(await ocr(Buffer.from(block.data, "base64")), index) })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        items.push({ type: "text", text: `Screenshot ${index}: text recognition failed (${reason}).` })
      }
    }
    if (mode === "off") {
      items.push({
        type: "text",
        text: `[Screenshot ${index} omitted: screenshots are turned off. Use the accessibility tree instead.]`,
      })
    }
    return items
  })
  const content = (await Promise.all(pending)).flat()
  if (content.length === 0) content.push({ type: "text", text: "(no output)" })
  return [
    ...notes.map((note): ToolContent => ({ type: "text", text: `Note: ${note}` })),
    ...limitText(content, options.maxOutputBytes ?? 0),
  ]
}

function limitText(content: ToolContent[], maxBytes: number): ToolContent[] {
  if (maxBytes <= 0) return content
  const total = content.reduce((sum, item) => sum + (item.type === "text" ? byteLength(item.text) : 0), 0)
  if (total <= maxBytes) return content

  let remaining = maxBytes
  const limited: ToolContent[] = []
  for (const item of content) {
    if (item.type !== "text") {
      limited.push(item)
      continue
    }
    if (remaining <= 0) continue
    const size = byteLength(item.text)
    if (size <= remaining) {
      limited.push(item)
      remaining -= size
      continue
    }
    limited.push({ type: "text", text: truncateBytes(item.text, remaining) })
    remaining = 0
  }
  limited.push({
    type: "text",
    text:
      `Note: output truncated to ${kb(maxBytes)} of ${kb(total)}. Narrow the query instead of repeating it: ` +
      "pass { emit: false } to observation methods and nodeRepl.write only the part you need.",
  })
  return limited
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8")
}

function truncateBytes(text: string, maxBytes: number): string {
  const cut = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8")
  return cut.endsWith("\uFFFD") ? cut.slice(0, -1) : cut
}

function kb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`
}

/** Joins the text blocks, for surfacing a failed call as a tool error. */
export function textOf(blocks: readonly McpContentBlock[]): string {
  return blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
}

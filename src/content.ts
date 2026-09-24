import type { McpContentBlock } from "./bridge"

export type ToolContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }

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

/** Maps MCP content blocks returned by `cua_repl` to OpenCode tool content; screenshots become data URIs. */
export function toToolContent(blocks: readonly McpContentBlock[], notes: readonly string[] = []): ToolContent[] {
  let images = 0
  const content = blocks.flatMap((block): ToolContent[] => {
    if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }]
    if (block.type === "image" && typeof block.data === "string") {
      const mime = imageMime(block.data, block.mimeType)
      images++
      return [
        {
          type: "file",
          uri: `data:${mime};base64,${block.data}`,
          mime,
          name: `screenshot-${images}.${EXTENSIONS[mime] ?? "img"}`,
        },
      ]
    }
    return [{ type: "text", text: JSON.stringify(block) }]
  })
  for (const note of notes) content.push({ type: "text", text: `Note: ${note}` })
  if (content.length === 0) content.push({ type: "text", text: "(no output)" })
  return content
}

/** Joins the text blocks, for surfacing a failed call as a tool error. */
export function textOf(blocks: readonly McpContentBlock[]): string {
  return blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
}

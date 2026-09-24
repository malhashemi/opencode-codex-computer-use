import { describe, expect, test } from "bun:test"
import { imageMime, textOf, toToolContent } from "../src/content"
import { formatOcr, type OcrResult } from "../src/ocr"

const IMAGE = { type: "image", data: "/9j/4AAQSkZJRg==", mimeType: "image/png" }
const fakeOcr = async (): Promise<OcrResult> => ({
  width: 100,
  height: 50,
  lines: [
    { text: "second", x: 60, y: 30 },
    { text: "first", x: 10, y: 10 },
  ],
})

describe("toToolContent", () => {
  test("keeps text and turns screenshots into data URIs with their real format", async () => {
    const content = await toToolContent([{ type: "text", text: "state" }, IMAGE])
    expect(content).toEqual([
      { type: "text", text: "state" },
      { type: "file", uri: "data:image/jpeg;base64,/9j/4AAQSkZJRg==", mime: "image/jpeg", name: "screenshot-1.jpg" },
    ])
    expect(imageMime("iVBORw0KGgoAAAA", "image/jpeg")).toBe("image/png")
    expect(imageMime("unknown", "image/webp")).toBe("image/webp")
  })

  test("screenshots=ocr replaces images with recognized text", async () => {
    const content = await toToolContent([IMAGE], [], { screenshots: "ocr", ocr: fakeOcr })
    expect(content).toHaveLength(1)
    expect(content[0]).toMatchObject({ type: "text" })
    const text = (content[0] as { text: string }).text
    expect(text).toContain("Screenshot 1 as text")
    expect(text.indexOf("[10,10] first")).toBeLessThan(text.indexOf("[60,30] second"))
  })

  test("screenshots=both keeps the image and adds text", async () => {
    const content = await toToolContent([IMAGE], [], { screenshots: "both", ocr: fakeOcr })
    expect(content.map((item) => item.type)).toEqual(["file", "text"])
  })

  test("screenshots=off drops images with a placeholder", async () => {
    const content = await toToolContent([IMAGE], [], { screenshots: "off" })
    expect(content).toEqual([{ type: "text", text: expect.stringContaining("Screenshot 1 omitted") }])
  })

  test("OCR failures become a note instead of an error", async () => {
    const content = await toToolContent([IMAGE], [], {
      screenshots: "ocr",
      ocr: async () => {
        throw new Error("no vision")
      },
    })
    expect((content[0] as { text: string }).text).toContain("text recognition failed (no vision)")
  })

  test("caps text output and explains how to narrow it; notes and images are kept", async () => {
    const big = "x".repeat(3000)
    const content = await toToolContent([{ type: "text", text: big }, IMAGE, { type: "text", text: "tail" }], ["restarted"], {
      maxOutputBytes: 1024,
    })
    expect(content[0]).toEqual({ type: "text", text: "Note: restarted" })
    expect((content[1] as { text: string }).text).toHaveLength(1024)
    expect(content[2]).toMatchObject({ type: "file" })
    expect(content.some((item) => item.type === "text" && item.text === "tail")).toBe(false)
    expect((content.at(-1) as { text: string }).text).toContain("output truncated to 1 KB of 3 KB")
  })

  test("does not truncate within the limit", async () => {
    expect(await toToolContent([{ type: "text", text: "short" }], [], { maxOutputBytes: 1024 })).toEqual([
      { type: "text", text: "short" },
    ])
  })

  test("puts notes first and never returns empty content", async () => {
    expect(await toToolContent([{ type: "text", text: "state" }], ["restarted"])).toEqual([
      { type: "text", text: "Note: restarted" },
      { type: "text", text: "state" },
    ])
    expect(await toToolContent([])).toEqual([{ type: "text", text: "(no output)" }])
  })

  test("serializes unknown blocks", async () => {
    expect(await toToolContent([{ type: "resource", uri: "x" }])).toEqual([
      { type: "text", text: '{"type":"resource","uri":"x"}' },
    ])
  })

  test("textOf joins text blocks only", () => {
    expect(textOf([{ type: "text", text: "a" }, { type: "image", data: "x" }, { type: "text", text: "b" }])).toBe("a\nb")
  })
})

describe("formatOcr", () => {
  test("reports when nothing was recognized", () => {
    expect(formatOcr({ width: 10, height: 10, lines: [] }, 2)).toContain("(no text recognized)")
  })
})

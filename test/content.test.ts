import { describe, expect, test } from "bun:test"
import { imageMime, textOf, toToolContent } from "../src/content"
import { parseOptions } from "../src/index"

describe("toToolContent", () => {
  test("keeps text and turns screenshots into data URIs", () => {
    const content = toToolContent([
      { type: "text", text: "state" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" },
    ])
    expect(content).toEqual([
      { type: "text", text: "state" },
      { type: "file", uri: "data:image/jpeg;base64,aGVsbG8=", mime: "image/jpeg", name: "screenshot-1.jpg" },
    ])
  })

  test("uses the real image format when the declared MIME type is wrong", () => {
    const jpegLabelledPng = toToolContent([{ type: "image", data: "/9j/4AAQSkZJRg==", mimeType: "image/png" }])
    expect(jpegLabelledPng[0]).toMatchObject({ mime: "image/jpeg", uri: "data:image/jpeg;base64,/9j/4AAQSkZJRg==" })
    expect(imageMime("iVBORw0KGgoAAAA", "image/jpeg")).toBe("image/png")
    expect(imageMime("unknown", "image/webp")).toBe("image/webp")
  })

  test("appends notes and never returns empty content", () => {
    expect(toToolContent([], ["restarted"])).toEqual([{ type: "text", text: "Note: restarted" }])
    expect(toToolContent([])).toEqual([{ type: "text", text: "(no output)" }])
  })

  test("serializes unknown blocks", () => {
    expect(toToolContent([{ type: "resource", uri: "x" }])).toEqual([
      { type: "text", text: '{"type":"resource","uri":"x"}' },
    ])
  })

  test("textOf joins text blocks only", () => {
    expect(textOf([{ type: "text", text: "a" }, { type: "image", data: "x" }, { type: "text", text: "b" }])).toBe("a\nb")
  })
})

describe("parseOptions", () => {
  test("defaults", () => {
    expect(parseOptions({})).toEqual({
      codexPath: undefined,
      approvals: "codex",
      idleShutdownMs: 600_000,
      callTimeoutMs: 300_000,
    })
  })

  test("custom values", () => {
    expect(
      parseOptions({ codexPath: " /x/codex ", approvals: "accept-session", idleShutdownMinutes: 0, callTimeoutSeconds: 60 }),
    ).toEqual({ codexPath: "/x/codex", approvals: "accept-session", idleShutdownMs: 0, callTimeoutMs: 60_000 })
  })

  test("rejects unknown approval modes", () => {
    expect(() => parseOptions({ approvals: "always" })).toThrow("invalid option approvals")
  })
})

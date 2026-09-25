import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { CODEX_PATH_ENV, resolveCodexPath } from "../src/codex-path"

const FAKE_CODEX = join(import.meta.dir, "fixtures", "fake-codex")
const FIXTURES = join(import.meta.dir, "fixtures")

describe("resolveCodexPath", () => {
  test("prefers the explicit option", () => {
    expect(resolveCodexPath(FAKE_CODEX, { env: {}, bundled: [] })).toBe(FAKE_CODEX)
  })

  test("uses the environment variable next", () => {
    expect(resolveCodexPath(undefined, { env: { [CODEX_PATH_ENV]: FAKE_CODEX }, bundled: [] })).toBe(FAKE_CODEX)
  })

  test("skips missing candidates and prefers app bundles over PATH", () => {
    expect(resolveCodexPath("/nope/codex", { env: { PATH: "/nope" }, bundled: ["/missing", FAKE_CODEX] })).toBe(
      FAKE_CODEX,
    )
  })

  test("only finds an executable named codex on PATH", () => {
    expect(resolveCodexPath(undefined, { env: { PATH: FIXTURES }, bundled: [] })).toBeUndefined()
  })

  test("returns undefined when nothing is installed", () => {
    expect(resolveCodexPath(undefined, { env: { PATH: "/nope" }, bundled: [] })).toBeUndefined()
  })
})

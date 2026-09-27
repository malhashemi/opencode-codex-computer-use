import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"

import { BUNDLED_CODEX_PATHS, CODEX_PATH_ENV, resolveCodexPath } from "../src/codex-path"
import { localHost, type Host } from "../src/host"

const FAKE_CODEX = join(import.meta.dir, "fixtures", "fake-codex")
const FIXTURES = join(import.meta.dir, "fixtures")
const PATH = process.env.PATH

afterEach(() => {
  process.env.PATH = PATH
})

/** This machine, reporting another platform, so the app bundles installed here do not decide the result. */
function hostOn(platform: string): Host {
  const local = localHost()
  return { ...local, info: async () => ({ ...(await local.info()), platform }) }
}

/** What resolveCodexPath asks the host to look for. */
async function searched(platform: string) {
  let request: { candidates: readonly (string | undefined)[]; name: string } | undefined
  const host: Host = {
    ...hostOn(platform),
    findExecutable: async (candidates, name) => {
      request = { candidates, name }
      return undefined
    },
  }
  await resolveCodexPath(host, "/x/codex", { [CODEX_PATH_ENV]: "/env/codex" })
  return request
}

describe("resolveCodexPath", () => {
  test("prefers the explicit option", async () => {
    expect(await resolveCodexPath(localHost(), FAKE_CODEX, {})).toBe(FAKE_CODEX)
  })

  test("uses the environment variable next", async () => {
    expect(await resolveCodexPath(localHost(), undefined, { [CODEX_PATH_ENV]: FAKE_CODEX })).toBe(FAKE_CODEX)
  })

  test("skips missing candidates", async () => {
    expect(await resolveCodexPath(localHost(), "/nope/codex", { [CODEX_PATH_ENV]: FAKE_CODEX })).toBe(FAKE_CODEX)
  })

  test("considers the app bundles, before PATH, only when the host runs macOS", async () => {
    expect(await searched("darwin")).toEqual({
      candidates: ["/x/codex", "/env/codex", ...BUNDLED_CODEX_PATHS],
      name: "codex",
    })
    expect(await searched("linux")).toEqual({ candidates: ["/x/codex", "/env/codex"], name: "codex" })
  })

  test("only finds an executable named codex on PATH", async () => {
    process.env.PATH = FIXTURES
    expect(await resolveCodexPath(hostOn("linux"), undefined, {})).toBeUndefined()
  })

  test("returns undefined when nothing is installed", async () => {
    process.env.PATH = "/nope"
    expect(await resolveCodexPath(hostOn("linux"), undefined, {})).toBeUndefined()
  })
})

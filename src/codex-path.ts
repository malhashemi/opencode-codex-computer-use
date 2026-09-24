import { accessSync, constants } from "node:fs"
import { delimiter, join } from "node:path"

/** macOS app bundles first: their `codex` matches the Computer Use runtime shipped in the same bundle. */
export const BUNDLED_CODEX_PATHS =
  process.platform === "darwin"
    ? ["/Applications/ChatGPT.app/Contents/Resources/codex", "/Applications/Codex.app/Contents/Resources/codex"]
    : []

export const CODEX_PATH_ENV = "OPENCODE_CODEX_COMPUTER_USE_CODEX_PATH"

export function resolveCodexPath(
  explicit?: string,
  input: { env?: NodeJS.ProcessEnv; bundled?: readonly string[]; platform?: NodeJS.Platform } = {},
): string | undefined {
  const env = input.env ?? process.env
  const platform = input.platform ?? process.platform
  const candidates = [
    explicit,
    env[CODEX_PATH_ENV],
    ...(input.bundled ?? BUNDLED_CODEX_PATHS),
    ...pathCandidates(env, platform),
  ]
  return candidates.find((candidate): candidate is string => !!candidate && isExecutable(candidate, platform))
}

function pathCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const names = platform === "win32" ? ["codex.exe"] : ["codex"]
  return (env.PATH ?? env.Path ?? "")
    .split(delimiter)
    .filter(Boolean)
    .flatMap((directory) => names.map((name) => join(directory, name)))
}

function isExecutable(path: string, platform: NodeJS.Platform): boolean {
  try {
    accessSync(path, platform === "win32" ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

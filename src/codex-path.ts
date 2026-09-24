import { accessSync, constants } from "node:fs"
import { delimiter, join } from "node:path"

/** App bundles first: their `codex` matches the Computer Use runtime shipped in the same bundle. */
export const BUNDLED_CODEX_PATHS = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
]

export const CODEX_PATH_ENV = "OPENCODE_CODEX_COMPUTER_USE_CODEX_PATH"

export function resolveCodexPath(
  explicit?: string,
  input: { env?: NodeJS.ProcessEnv; bundled?: readonly string[] } = {},
): string | undefined {
  const env = input.env ?? process.env
  const candidates = [explicit, env[CODEX_PATH_ENV], ...(input.bundled ?? BUNDLED_CODEX_PATHS), ...pathCandidates(env)]
  return candidates.find((candidate): candidate is string => !!candidate && isExecutable(candidate))
}

function pathCandidates(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, "codex"))
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

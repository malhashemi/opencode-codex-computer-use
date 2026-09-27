import type { Host } from "./host"

/** macOS app bundles first: their `codex` matches the Computer Use runtime shipped in the same bundle. */
export const BUNDLED_CODEX_PATHS: readonly string[] = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
]

export const CODEX_PATH_ENV = "OPENCODE_CODEX_COMPUTER_USE_CODEX_PATH"

/** Order: explicit option, env[CODEX_PATH_ENV] (this process's env), BUNDLED_CODEX_PATHS when the host runs macOS,
 *  then `codex` on the host's PATH. Paths are paths on the host. */
export async function resolveCodexPath(
  host: Host,
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const { platform } = await host.info()
  const bundled = platform === "darwin" ? BUNDLED_CODEX_PATHS : []
  return host.findExecutable([explicit, env[CODEX_PATH_ENV], ...bundled], "codex")
}

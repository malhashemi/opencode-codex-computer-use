import { SURFACES, type Surface } from "./options"

const BROWSER_METHODS = ["getBrowser", "createBrowserTab", "getTab", "listBrowsers", "listTabs"]
const APP_METHODS = ["getApp", "listApps"]

const message = (surface: string) => `${surface} are turned off by the opencode-codex-computer-use "surfaces" option.`

/**
 * JavaScript run before the model's code when a surface is turned off. It replaces the disabled half of `cua` with
 * functions that throw a clear error and filters `cua.getState()`. It runs once per runtime (a reset or restart
 * clears the marker). This scopes a cooperative model; it is not a security boundary.
 * Kept on one line so the model's code keeps its line numbers (offset by one).
 */
export function surfaceGuard(enabled: readonly Surface[]): string | undefined {
  const disabled = SURFACES.filter((surface) => !enabled.includes(surface))
  if (disabled.length === 0) return undefined
  const noBrowser = disabled.includes("browser")
  const noApps = disabled.includes("apps")
  const methods = [...(noBrowser ? BROWSER_METHODS : []), ...(noApps ? APP_METHODS : [])]
  return [
    "if (!globalThis.__opencodeCuSurfaces) {",
    "globalThis.__opencodeCuSurfaces = true;",
    "const __getState = cua.getState.bind(cua);",
    ...methods.map(
      (method) =>
        `cua[${JSON.stringify(method)}] = async () => { throw new Error(${JSON.stringify(
          message(BROWSER_METHODS.includes(method) ? "Browser tabs" : "Native apps"),
        )}); };`,
    ),
    noApps && "if (cua.computer) cua.computer.launch_app = undefined;",
    "cua.getState = async (options = {}) => {",
    "const state = await __getState({ ...options, emit: false });",
    noBrowser && "state.browsers = [];",
    noApps && "state.apps = [];",
    "if (options.emit !== false) nodeRepl.write(JSON.stringify(state));",
    "return state; };",
    "}",
  ]
    .filter(Boolean)
    .join(" ")
}

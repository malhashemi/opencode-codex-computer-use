# opencode-codex-computer-use

An [OpenCode](https://opencode.ai) plugin that lets your OpenCode agent operate native macOS apps and Chrome tabs with
the **Codex Computer Use engine that is already installed on your Mac** by the ChatGPT (or Codex) desktop app.

It does not reimplement, copy, patch or bundle anything from OpenAI. It talks to Codex through Codex's public
[app-server protocol](https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol), and Codex runs its own
Computer Use plugin exactly as it does for itself. Your OpenCode model drives it; no OpenAI model is called.

> Not affiliated with or endorsed by OpenAI. Computer Use is a proprietary OpenAI component; using it from a
> third-party agent is your decision. Check OpenAI's terms for your account.

## What you need on the Codex side

Nothing in Codex has to be configured by hand. You only need a working Computer Use install:

| Requirement | Why |
| --- | --- |
| **Mac with Apple Silicon** | OpenAI ships the Computer Use helper for arm64 only. |
| **macOS 14.4 or later** | Minimum version of the Computer Use app. |
| **ChatGPT desktop app** (or the Codex desktop app) in `/Applications`, **signed in** | It ships the `codex` binary and the Computer Use runtime this plugin uses. Computer Use must be available for your account and region. |
| **Computer Use turned on** in the app (Settings → Computer Use) | This installs `~/.codex/computer-use/Codex Computer Use.app` and registers Codex's `cua_repl` runtime in `~/.codex`. |
| **Accessibility** and **Screen Recording** granted to *Codex Computer Use* (System Settings → Privacy & Security) | macOS asks the first time Computer Use runs. Easiest: ask Codex to do one small Computer Use task first. |
| *Optional, for Chrome tabs:* the **ChatGPT for Chrome** extension, connected | Set up from the ChatGPT/Codex app (Chrome plugin). Without it, native apps still work and the agent can only drive Chrome as an ordinary app. |

The ChatGPT app does not need to be open while you use OpenCode.

**Windows and Linux (experimental):** Codex Computer Use also runs on Windows, and its runtime has a Linux target. The
plugin itself is platform-neutral (it only talks to `codex app-server`), but it has only been tested on macOS. On
other platforms, `codex` is found through `PATH` or the `codexPath` option, and OCR is not available yet.

### Check your setup

In OpenCode, run the **`/computer-use-doctor`** command. It checks, read-only, each requirement above: the platform,
the `codex` executable, the Computer Use app and runtime, native app access and screenshots, OCR (when enabled) and
connected browsers, and says how to fix whatever is missing. The report is added to the session without starting a
model turn.

From this repository, `bun scripts/smoke.ts` runs the same checks in a terminal (`--ocr` also tests OCR).

```
## Codex Computer Use doctor: ready

- ✅ **Platform**: macOS 26.6.2 (arm64)
- ✅ **codex executable**: /Applications/ChatGPT.app/Contents/Resources/codex (codex-cli 0.155.0-alpha.16)
- ✅ **Computer Use app**: ~/.codex/computer-use/Codex Computer Use.app (26.916.1001103)
- ✅ **Computer Use runtime**: Codex app-server running with `cua_repl`
- ✅ **Native apps**: Engine reachable, 17 apps listed
- ✅ **Screenshots**: Finder screenshot captured (image/jpeg, 132 KB)
- ✅ **OCR**: 61 text lines recognized in 894 ms
- ✅ **Browser tabs**: Connected: Chrome (extension)
```

## Install in OpenCode

Clone this repository, run `bun install` in it, then add the **repository directory** to `opencode.json(c)`, globally
(`~/.config/opencode/opencode.json`) or per project. OpenCode loads the directory's root `index.ts`.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "/absolute/path/to/opencode-codex-computer-use",
  ],
}
```

With options:

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-codex-computer-use",
      "options": {
        "approvals": "codex",
        "surfaces": ["apps", "browser"],
        "screenshots": "image",
        "maxOutputKB": 128,
        "idleShutdownMinutes": 0,
        "debug": false,
      },
    },
  ],
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `approvals` | `"codex"` | How "Allow Computer Use to use *App*?" prompts are answered. `"codex"` follows the `approval_policy` in your `~/.codex/config.toml` (with `"never"`, Codex answers them itself; any prompt Codex still forwards is declined). `"accept-session"` accepts each prompt for the current session only. `"decline"` declines them all. Apps blocked by the engine or your organization stay blocked in every mode. |
| `surfaces` | `["apps", "browser"]` | What the agent may operate: native apps, browser tabs, or both. Turning one off removes it from the tool description and makes its `cua` functions throw. This scopes the model; it is not a security boundary. |
| `screenshots` | `"image"` | How screenshots reach the model. `"image"`: as images. `"ocr"`: as text recognized on-device (macOS Vision), one line per text block with its `[x,y]` position, which is also a valid click coordinate; for models without vision, or to keep pixels off your model provider. `"both"`: image plus text. `"off"`: replaced by a placeholder, so the model relies on the accessibility tree. |
| `maxOutputKB` | `128` | Maximum text one call returns. Longer output is cut, with a note telling the model to narrow its query. `0` disables the limit. Images are not counted. |
| `idleShutdownMinutes` | `0` (never) | Stop the background Codex process after this many minutes without Computer Use calls. The default keeps it running until OpenCode stops, so work can wait indefinitely for you (for example, a login in a tab the agent handed over). |
| `callTimeoutSeconds` | `300` | Maximum time for one `computer_use` call. |
| `codexPath` | auto | Path to `codex`. Otherwise `$OPENCODE_CODEX_COMPUTER_USE_CODEX_PATH`, then (on macOS) the ChatGPT app, then the Codex app, then `PATH`. |
| `debug` | `false` | `true` (or a file path) writes every message exchanged with Codex to `~/.local/share/opencode/log/codex-computer-use.jsonl`, with screenshots replaced by their size. The log contains accessibility trees and page text, so it can hold sensitive data. |

### Permissions

Both tools use the OpenCode permission action `computer_use`. OpenCode allows it by default; to be asked before every
call, or to turn it off, add a rule:

```jsonc
{
  "permissions": [
    { "action": "computer_use", "resource": "*", "effect": "ask" },
  ],
}
```

## Tools

| Tool | What it does |
| --- | --- |
| `computer_use` | Runs JavaScript in Codex's Computer Use runtime, where a `cua` object is preloaded, and returns text output, accessibility trees and screenshots. Variables persist between calls in the same OpenCode session. |
| `computer_use_reset` | Clears that runtime for the current session. |
| `/computer-use-doctor` (command) | Checks the setup; see [Check your setup](#check-your-setup). |

The same runtime covers both surfaces, as it does in Codex:

```js
// Native apps
let app = await cua.getApp("Notes") // name, bundle ID or path; returns the app's accessibility tree

// Chrome tabs (needs the ChatGPT for Chrome extension)
let browser = await cua.getBrowser()
let tab = await cua.createBrowserTab(browser.browserId, "https://example.com")
```

Tabs work on the page itself and add `goto`, `back`, `reload`, `close` and Playwright-style locators. Tabs the agent
creates close automatically when the OpenCode turn ends, unless the agent marks them to keep (`tab.markDeliverable()`).
Keys and typing go to the bound app or tab, so system-wide shortcuts such as Spotlight are not available.

The first call in each session also returns the engine's full API reference to the model, so the plugin does not
need to ship OpenAI's documentation.

## How it works

```
OpenCode ── computer_use tool
  └─ codex app-server  (hidden, started on first use, JSON-RPC over stdio)
      └─ one ephemeral Codex thread per OpenCode session
          └─ cua_repl (Codex's Computer Use runtime) ── Codex Computer Use engine ── your apps
```

- **Nothing opens in Codex.** Threads are started with `ephemeral: true`: nothing is written to disk, nothing appears
  in the ChatGPT/Codex thread list, and no model turn runs in Codex. Only routine Codex diagnostic log lines are written.
- **What you see:** the apps being operated (apps that are not running are launched in the background) and Computer
  Use's own on-screen indicator while it acts ("ChatGPT is using your computer — Esc to cancel").
- **Turns:** each call carries the Codex thread ID and an ID for the current OpenCode turn (in the request's `_meta`,
  as Codex does for its own tool calls); the browser surface requires it. When an OpenCode turn finishes or is
  interrupted, the plugin tells Computer Use the turn ended, which also cleans up agent-created Chrome tabs. Deleting
  an OpenCode session closes its Codex thread.
- **Lifetime:** the Codex process keeps running between calls, so JavaScript variables survive long waits. If it
  stops anyway (an optional `idleShutdownMinutes`, a crash, or a ChatGPT update), the next call starts it again and
  tells the model, before anything else, that its earlier variables are gone.

## Privacy

Computer Use reads the UI and screenshots of the apps and pages it operates, and those are sent to **your OpenCode
model provider** as tool results. In Chrome it works in your real profile, with your logged-in sessions. OpenAI's Computer Use component also sends its own usage telemetry to OpenAI, as it does
inside ChatGPT; your ChatGPT settings govern that.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Could not find the codex executable` | Install the ChatGPT desktop app in `/Applications`, or set `codexPath`. |
| `Codex has no cua_repl MCP server` | Turn on Computer Use in the ChatGPT/Codex app, then run `/computer-use-doctor` again. |
| Permission errors from the engine | Grant Accessibility and Screen Recording to *Codex Computer Use*, then retry. |
| `Declined "Allow Computer Use to use …"` | Approve the app once in ChatGPT/Codex, or set `approvals` to `"accept-session"`. |
| No browsers listed / Chrome tab calls fail | Install and connect the ChatGPT for Chrome extension from the ChatGPT/Codex app, keep Chrome running, then run `/computer-use-doctor`. |
| Anything else | Run `/computer-use-doctor`. Plugin messages are prefixed `[codex-computer-use]` in `~/.local/share/opencode/log/opencode.log`; set `"debug": true` to log the full exchange with Codex. |

## Development

```sh
bun install
bun test           # unit tests against a fake codex app-server; never touches the real engine
bun run typecheck
bun scripts/smoke.ts   # read-only check against the real engine
```

OpenCode sessions opened in this repository load the plugin from source through
`.opencode/plugins/codex-computer-use.ts`. After editing, run `opencode api post /api/location/reload` (or restart
OpenCode) to pick up changes.

## License

MIT for this plugin's code. The Codex Computer Use engine is OpenAI's and is not part of this repository.

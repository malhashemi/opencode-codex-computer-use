# opencode-codex-computer-use

An [OpenCode](https://opencode.ai) plugin that lets your OpenCode agent operate native macOS apps with the
**Codex Computer Use engine that is already installed on your Mac** by the ChatGPT (or Codex) desktop app.

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

The ChatGPT app does not need to be open while you use OpenCode.

Check your setup from this repository:

```sh
bun install
bun scripts/smoke.ts
```

It reads Finder's UI and takes one screenshot (read-only), then prints `OK` or what is missing. You can also run
`/Applications/ChatGPT.app/Contents/Resources/codex mcp list` and look for an enabled `cua_repl` server.

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
        "idleShutdownMinutes": 10,
      },
    },
  ],
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `approvals` | `"codex"` | How "Allow Computer Use to use *App*?" prompts are answered. `"codex"` follows the `approval_policy` in your `~/.codex/config.toml` (with `"never"`, Codex answers them itself; any prompt Codex still forwards is declined). `"accept-session"` accepts each prompt for the current session only. `"decline"` declines them all. Apps blocked by the engine or your organization stay blocked in every mode. |
| `idleShutdownMinutes` | `10` | Stop the background Codex process after this long without Computer Use calls. `0` keeps it running until OpenCode stops. |
| `callTimeoutSeconds` | `300` | Maximum time for one `computer_use` call. |
| `codexPath` | auto | Path to `codex`. Otherwise `$OPENCODE_CODEX_COMPUTER_USE_CODEX_PATH`, then the ChatGPT app, then the Codex app, then `PATH`. |

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

A typical first call:

```js
let app = await cua.getApp("Notes") // name, bundle ID or path; returns the app's accessibility tree
```

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
- **End of a turn:** when an OpenCode turn finishes or is interrupted, the plugin tells Computer Use the turn ended,
  as Codex does. Deleting an OpenCode session closes its Codex thread.
- **Idle:** after `idleShutdownMinutes` the Codex process stops. The next call starts it again and tells the model its
  earlier JavaScript variables are gone.

## Privacy

Computer Use reads the UI and screenshots of the apps it operates, and those are sent to **your OpenCode model
provider** as tool results. OpenAI's Computer Use component also sends its own usage telemetry to OpenAI, as it does
inside ChatGPT; your ChatGPT settings govern that.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Could not find the codex executable` | Install the ChatGPT desktop app in `/Applications`, or set `codexPath`. |
| `Codex has no cua_repl MCP server` | Turn on Computer Use in the ChatGPT/Codex app, then run `bun scripts/smoke.ts` again. |
| Permission errors from the engine | Grant Accessibility and Screen Recording to *Codex Computer Use*, then retry. |
| `Declined "Allow Computer Use to use …"` | Approve the app once in ChatGPT/Codex, or set `approvals` to `"accept-session"`. |
| Plugin logs | Lines prefixed `[codex-computer-use]` in `~/.local/share/opencode/log/opencode.log`. |

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

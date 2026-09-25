# Security policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub's private vulnerability reporting](https://github.com/malhashemi/opencode-codex-computer-use/security/advisories/new),
not in a public issue. Include steps to reproduce and the version you tested.

You can expect an acknowledgement within a few days. Once a fix is ready, it ships in a release and the advisory is
published with credit to you, unless you prefer otherwise.

## Scope

This plugin lets an AI agent operate the apps and browser tabs on your computer, so these areas matter most:

- **App approvals.** App-access prompts from Computer Use follow your Codex `approval_policy` by default and are never
  accepted permanently. A way to make the plugin accept access the configuration does not allow is a vulnerability.
- **Surfaces.** The `surfaces` option narrows what a cooperative model uses; it is documented as not being a security
  boundary. A bypass of OpenCode's `computer_use` permission rules would be in scope.
- **The Codex process.** The plugin starts `codex app-server` from the ChatGPT or Codex app bundle, the `codexPath`
  option, `$OPENCODE_CODEX_COMPUTER_USE_CODEX_PATH` or `PATH`. Anything that makes it run a different binary than the
  one configured is in scope.
- **Local files.** The optional debug log contains accessibility trees and page text; it is written only when `debug`
  is set.

Issues in OpenAI's Computer Use engine or in Codex itself should go to OpenAI.

## Supported versions

Security fixes go into the latest release.

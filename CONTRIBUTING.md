# Contributing

Thanks for helping. Bug reports, platform testing and code are all welcome.

## Where to start

- **Found a bug?** [Open a bug report](https://github.com/malhashemi/opencode-codex-computer-use/issues/new?template=bug.yml)
  with the output of `/computer-use-doctor`; it shows which part of the setup is missing.
- **On Windows or Linux?** The plugin is developed on macOS. A report that it works (or doesn't) with Codex Computer Use
  on your machine is a real contribution.
- **Have an idea?** [Open a feature request](https://github.com/malhashemi/opencode-codex-computer-use/issues/new?template=feature.yml)
  before writing a lot of code, so we can agree on the shape first.
- **Security issue?** Follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Development

You need [Bun](https://bun.sh) and, to try changes for real, a working Codex Computer Use install (see the
[README](README.md#requirements)).

```sh
bun install
bun run check     # formatting, lint, types, tests
bun run doctor    # read-only check against the real engine
```

`bun test` runs against a fake `codex app-server` (`test/fixtures/fake-codex.ts`) and never touches your apps.

### Running the plugin from your checkout

OpenCode sessions opened in this repository load the plugin from source through
`.opencode/plugins/codex-computer-use.ts`. To use your checkout from another project, add its directory to that
project's `plugins`. After editing, run `opencode api post /api/location/reload` or restart OpenCode.

### How the code fits together

| File                | Role                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `src/index.ts`      | Plugin entry: options, the `computer_use` tools, the doctor command, turn and session events                                   |
| `src/bridge.ts`     | One `codex app-server` per plugin instance, one ephemeral Codex thread per OpenCode session, app-access prompts, turn metadata |
| `src/app-server.ts` | JSON-RPC client for `codex app-server --listen stdio://`                                                                       |
| `src/content.ts`    | Converts Codex results to OpenCode content: screenshots, OCR, output cap                                                       |
| `src/ocr.ts`        | On-device OCR with the macOS Vision framework                                                                                  |
| `src/surfaces.ts`   | Turns native apps or browser tabs off inside the runtime                                                                       |
| `src/doctor.ts`     | Setup checks shared by `/computer-use-doctor` and `scripts/smoke.ts`                                                           |

The protocol the bridge speaks is defined in the open-source
[Codex app-server protocol](https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol).

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Make your change, with tests where it makes sense.
3. Run `bun run check`. When your change affects how apps or browsers are driven, also try it against the real engine
   and say in the pull request what you ran and on which OS.
4. Open the pull request with a [Conventional Commit](https://www.conventionalcommits.org/) title.

`main` only changes through pull requests, and CI (format, lint, types and tests on macOS and Linux) must pass before
anything merges. CI on a pull request from someone who has not had a contribution merged yet starts once a maintainer
approves the run. A maintainer reviews and merges outside contributions; maintainers merge their own pull requests once
CI passes.

### Commit and pull request titles

Titles drive the changelog and version numbers, so they follow Conventional Commits:

| Prefix      | Use for                              | Release effect           |
| ----------- | ------------------------------------ | ------------------------ |
| `feat:`     | A new capability users will notice   | Minor version, changelog |
| `fix:`      | A bug fix                            | Patch version, changelog |
| `perf:`     | A performance improvement            | Patch version, changelog |
| `docs:`     | Documentation only                   | None                     |
| `refactor:` | Code changes with no behavior change | None                     |
| `test:`     | Tests only                           | None                     |
| `build:`    | Dependencies, tooling, packaging     | None                     |
| `ci:`       | Workflows                            | None                     |
| `chore:`    | Anything else                        | None                     |

Add `!` after the type (`feat!:`) for a breaking change, and describe the migration in the pull request body.

### Code style

- TypeScript is formatted with [oxfmt](https://oxc.rs/docs/guide/usage/formatter) and linted with
  [oxlint](https://oxc.rs/docs/guide/usage/linter); CI rejects warnings. Fix findings in the code rather than disabling
  rules; a targeted `oxlint-disable-next-line` needs a comment explaining why.
- Comments explain why something is done, not what the next line does.
- Never copy code, prompts or documentation from OpenAI's Computer Use components into this repository. The plugin
  talks to them only through Codex's public protocol.

## Releases

Releases are automated with [release-please](https://github.com/googleapis/release-please):

1. Merge pull requests with Conventional Commit titles.
2. release-please keeps a release pull request open with the next version and the changelog entry. GitHub does not
   run CI for pull requests opened by GitHub Actions, so the release workflow starts CI on that branch itself; its
   checks appear on the release pull request like any other.
3. Merging the release pull request tags the release, and the release workflow runs `bun run check` on the tag and
   publishes to npm.

Publishing uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers): the package trusts `release.yml`
in the `npm` environment of this repository, so no npm token exists anywhere, and every version carries a provenance
attestation linking it to the workflow run that built it. To finish a release that failed part-way, run the Release
workflow manually with the tag.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be kind and assume good intent.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).

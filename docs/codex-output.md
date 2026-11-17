# What the Codex CLI prints in review mode

Observed on **codex-cli 0.147.0** (`codex --version`), macOS, logged in with ChatGPT, on 2026-11-17. The tool is tested against 0.147.x and prints a warning when it meets any other version, because the layout below is not a documented interface and Codex changes quickly.

## The command

```
codex exec --sandbox read-only --ephemeral --ignore-user-config --json \
  --output-last-message <scratch>/last-message.txt \
  review --base <base sha>
```

run with the worktree of the head commit as its working directory and an allowlisted environment (see `src/env.js`).

- Exec options (`--sandbox`, `--json`, `--output-last-message`) go before the `review` subcommand. `codex exec review --help` does not list `--sandbox`, but `codex exec --help` does, and the parent's options apply to the subcommand.
- There is no prompt argument. `codex exec review` accepts one ("Custom review instructions"), and the tool never passes it, so the review uses Codex's own review instructions plus the repository's `AGENTS.md`.
- `--base` is documented as taking a branch. A full commit sha works: in the recorded run Codex diffed against `a488c33...` directly.
- `--ignore-user-config` is passed so the reviewer's `~/.codex/config.toml` does not change the review. On the machine this was recorded on, that config selects a model a ChatGPT login cannot use, and the review failed with `model_not_found` (recorded in `test/fixtures/codex-0.147.0/failed-model-not-found.events.jsonl`). The same config also starts MCP servers. Authentication still comes from `CODEX_HOME`.

## Structured output is not available in review mode

`codex exec review --help` lists `--output-schema <FILE>`. It is accepted in review mode and has no effect: with a schema asking for a JSON object of findings, the final message was still the plain text review described below. So the tool does not pass `--output-schema`, and it parses the review's own text. It never falls back to a custom prompt to get JSON.

## stdout with `--json`: a JSONL event stream

One JSON object per line. The types seen in a successful review:

| `type` | Notes |
|---|---|
| `thread.started` | `thread_id` |
| `turn.started` | |
| `item.started`, `item.completed` with `item.type` `command_execution` | The shell commands Codex ran to read the diff (`git diff <base>`), with their output |
| `item.completed` with `item.type` `agent_message` | `item.text` is the review, identical to the `--output-last-message` file |
| `turn.completed` | `usage` (all zeros with a ChatGPT login) |

In the failed run there was also `item.completed` with `item.type` `error` (a non-fatal warning), a top-level `error`, an `agent_message` reading "Review was interrupted. Please re-run /review and wait for it to complete.", then `turn.failed` with `error.message`, and exit status 1.

There are no review-specific events (nothing like an "exited review mode" event carrying structured findings) in this version's JSONL stream.

The tool treats the run as failed when: codex exits non-zero, the stream has a line that is not JSON, it has `turn.failed`, or it has no `turn.completed`. stderr is not read for status; Codex logs warnings there even on success.

## The review text

The final message is the overall explanation, then, when there are findings, a findings block:

```
<overall explanation, one or more paragraphs>

Review comment:

- [P1] <title> <U+2014> <absolute path>:<start>-<end>
  <body, every line indented two spaces>
```

`<U+2014>` stands for the em dash character Codex prints between the title and the location. The recorded example is `test/fixtures/codex-0.147.0/review-planted-bug.last-message.txt`.

- The header was `Review comment:` for one finding. A review with several findings has not been observed yet, and the plural header is not confirmed; the parser accepts `Review comment:`, `Review comments:` and `Full review comments:`, and a test covers several findings in that layout with synthetic text.
- The priority is not a separate field: it is the `[P0]` to `[P3]` prefix of the title. A finding with no prefix, or one outside P0 to P3, fails the run.
- The location is an absolute path inside the worktree (on macOS under `/private/var/folders/...`, the resolved form of `$TMPDIR`), then `:start-end`. A one-line finding is written `26-26`. The tool strips the worktree root and fails the run if a path points outside it.
- A review with no findings is the explanation alone, with no header. A text that has finding-like lines (`- [P1] ...`) but no header is treated as unparseable rather than clean.
- Both runs on the planted bug found it, once as P2 and once as P1, at `src/stats.js:26-27` and `src/stats.js:26-26`. Codex is not deterministic between runs.

## Recorded fixtures

`test/fixtures/codex-0.147.0/`:

- `review-planted-bug.events.jsonl` and `review-planted-bug.last-message.txt`: the raw stdout and last message of the real run started by `codex-mr-review review --base a488c33 --head feature --dry-run` against a throwaway repository whose feature branch adds `sumFirst()` with a `<=` loop bound. Recorded by a shim placed first on `PATH` that ran the real `codex` and kept copies. Unedited, so the command output inside it carries the local machine's paths and Xcode noise from the sandbox. `review-planted-bug.json` has the details.
- `failed-model-not-found.events.jsonl`: the raw stdout of a real run that failed (exit 1) because the user config chose an unsupported model.

The tests replay these through `test/support/fake-codex.js`, a stand-in `codex` placed first on `PATH`, so CI needs no Codex install or login.

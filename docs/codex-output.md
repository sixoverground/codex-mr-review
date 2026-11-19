# What the Codex CLI prints in review mode

Observed on **codex-cli 0.147.0** (`codex --version`), macOS, logged in with ChatGPT, on 2026-11-17. The tool is tested against 0.147.x and prints a warning when it meets any other version, because the layout below is not a documented interface and Codex changes quickly.

## The command

```
codex exec --sandbox read-only --ephemeral --ignore-user-config --json \
  [--model <name>] -c 'model_reasoning_effort="<level>"' \
  --output-last-message <scratch>/last-message.txt \
  review --base <base sha>
```

run with the worktree of the head commit as its working directory and an allowlisted environment (see `src/env.js`).

- Exec options (`--sandbox`, `--json`, `--output-last-message`) go before the `review` subcommand. `codex exec review --help` does not list `--sandbox`, but `codex exec --help` does, and the parent's options apply to the subcommand.
- There is no prompt argument. `codex exec review` accepts one ("Custom review instructions"), and the tool never passes it, so the review uses Codex's own review instructions plus the repository's `AGENTS.md` files. Codex reads `AGENTS.md` and `AGENTS.override.md` from the root down to its working directory; the tool resets every one of them, at any depth, to the base commit's copy, so it does not depend on which ones Codex reads.
- `--base` is documented as taking a branch. A full commit sha works: in the recorded run Codex diffed against `a488c33...` directly.
- `--ignore-user-config` is passed so the reviewer's `~/.codex/config.toml` does not change the review. On the machine this was recorded on, that config selects a model a ChatGPT login cannot use, and the review failed with `model_not_found` (recorded in `test/fixtures/codex-0.147.0/failed-model-not-found.events.jsonl`). The same config also starts MCP servers. Authentication still comes from `CODEX_HOME`.

## Model and reasoning effort

Because `--ignore-user-config` drops `~/.codex/config.toml`, the model and reasoning effort come only from the command line. Confirmed on codex-cli 0.147.0 on 2026-11-18:

- `--model <MODEL>` (short `-m`) is listed in both `codex exec --help` and `codex exec review --help` ("Model the agent should use"). The tool passes it before `review`, and only when `--model` is given; otherwise Codex uses its built-in default model. It was confirmed from the help text only; no run has used a non-default model yet.
- Reasoning effort has no flag of its own. It is the config key `model_reasoning_effort`, set with `-c` (`codex exec --help`: "Override a configuration value that would otherwise be loaded from `~/.codex/config.toml`"). The value is passed as a quoted TOML string. `-c` still applies with `--ignore-user-config`: a run with `-c model_reasoning_effort=bogus` reached the model API, which rejected it with a 400.
- **The accepted levels** come from that rejection, which Codex forwarded in its `error` and `turn.failed` events: "Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'." Codex itself passes any string through, so the tool checks the level and exits 2 on anything else. Whether every model accepts every level was not checked.
- **The event stream does not name the model.** `thread.started` carries only `thread_id`, and no other event in the recorded runs mentions a model or effort. So the tool reports an unset `--model` as "Codex's default" rather than guessing.
- A real run at the defaults (no `--model`, effort `high`) on the planted-bug repository exited 0 in about 70 seconds and found the planted bug at P2 (`src/stats.js:26-26`), plus the `max()` bound at P3. The event types were the same as in the recorded fixtures, so they were not re-recorded.

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

- The header is `Review comment:` for one finding and `Full review comments:` for more than one (both observed). Each finding after the first is preceded by a blank line. The parser also accepts `Review comments:`, which has not been observed.
- The priority is not a separate field: it is the `[P0]` to `[P3]` prefix of the title. A finding with no prefix, or one outside P0 to P3, fails the run.
- The location is an absolute path inside the worktree (on macOS under `/private/var/folders/...`, the resolved form of `$TMPDIR`), then `:start-end`. A one-line finding is written `26-26`. The tool strips the worktree root and fails the run if a path points outside it.
- A review with no findings is the explanation alone, with no header. A text that has finding-like lines (`- [P1] ...`) but no header is treated as unparseable rather than clean.
- Every run on the planted bug found it, at P2 or P1, as `src/stats.js:26-27` or `src/stats.js:26-26`. Some runs also flagged the `<=` bound in `max()` as a second finding, at P2 or P3. Codex is not deterministic between runs.

## Recorded fixtures

`test/fixtures/codex-0.147.0/`:

- `review-planted-bug.events.jsonl` and `review-planted-bug.last-message.txt`: the raw stdout and last message of the real run started by `codex-mr-review review --base a488c33 --head feature --dry-run` against a throwaway repository whose feature branch adds `sumFirst()` with a `<=` loop bound. Recorded by a shim placed first on `PATH` that ran the real `codex` and kept copies. Unedited except for two redactions, applied the same way across every file here: the macOS temporary directory (`/var/folders/<id>/T`) became `/tmp`, and the local account name, which appeared in an `ls -la` Codex ran, became `user`. The Xcode noise from the sandbox is left as it was. `review-planted-bug.json` has the details.
- `review-two-findings.*`: a second real run of the same command on the same repository that reported two findings, recorded the same way. It is the source for the `Full review comments:` layout.
- `failed-model-not-found.events.jsonl`: the raw stdout of a real run that failed (exit 1) because the user config chose an unsupported model.

The tests replay these through `test/support/fake-codex.js`, a stand-in `codex` placed first on `PATH`, so CI needs no Codex install or login.

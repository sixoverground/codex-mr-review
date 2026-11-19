# codex-mr-review

Run the Codex CLI's review mode in GitLab CI and post findings to merge requests.

**Status: posts to GitLab.** `review` runs Codex's review mode on a change and posts the findings, a summary and the review marker to a merge request. `review --dry-run` prints the findings instead and makes no network call. The GitLab CI template is not written yet.

## What it is for

GitLab has no built-in equivalent of cloud Codex reviewing a pull request on GitHub. This tool fills that gap for a GitLab project with its own runner:

- It runs `codex exec` in its built-in review mode, in a read-only sandbox, against the diff of a merge request.
- It posts each finding as an inline, resolvable discussion on the merge request, laid out the way cloud Codex lays out a finding: a P0 to P3 priority, a title, then a body.
- After every completed review, clean or not, it posts a summary note carrying a machine-readable marker that names the reviewer and the exact commit reviewed. The format of that marker is a published contract, described in [docs/contract.md](docs/contract.md). Anything that needs to know "has this commit been reviewed?" can read it.
- The marker is written by the tool's own code after Codex has exited successfully. It is never taken from model output, and model output is scrubbed of anything that looks like a marker before it is posted.

## What it is not for

- **Not a GitHub reviewer.** On GitHub, use cloud Codex. This tool never posts to GitHub.
- **Not a custom review prompt.** It uses Codex's own review mode. Review guidance for a project comes from that project's `AGENTS.md`, read from the base branch so a merge request cannot rewrite its own review instructions.
- **Not an approval gate.** A marker says a commit was reviewed. It says nothing about whether the review liked it.
- **Not a sandbox for untrusted code on a shared machine.** The read-only sandbox blocks writes and network but can read whatever the runner's user can read. See [SECURITY.md](SECURITY.md).

## Usage

```
codex-mr-review --help
codex-mr-review --version
codex-mr-review review --base <ref> [--head <ref>] [--dry-run] [--format text|json]
                       [--reviewer <name>] [--clean-emoji] [--timeout <seconds>]
                       [--model <name>] [--reasoning-effort <level>]
                       [--gitlab-url <url>] [--project <id|path>] [--mr <iid>]
```

`--dry-run` prints the findings locally and posts nothing. `--base` is required. Run it from inside the repository; it reviews `--head` (default `HEAD`) against `--base` in a temporary worktree, with every `AGENTS.md` and `AGENTS.override.md` (at any depth) taken from `--base`, and removes the worktree afterwards.

- `--format text` prints each finding under its location, laid out like a cloud Codex comment, then one summary. `--format json` prints one object valid against [schema/review-output.schema.json](schema/review-output.schema.json). See [docs/output-format.md](docs/output-format.md).
- Exit status 0 means the review completed, with or without findings. Any failure (Codex exits non-zero, times out, or returns something that does not parse, including a priority outside P0 to P3) exits 1 and prints no findings.
- It needs the `codex` CLI on `PATH`, logged in or with `CODEX_API_KEY` or `OPENAI_API_KEY` set. It is tested with codex-cli 0.147.x and warns on any other version. What that version prints is recorded in [docs/codex-output.md](docs/codex-output.md).

### Model and reasoning effort

Codex always runs with `--ignore-user-config`, so nothing in `~/.codex/config.toml` (model, reasoning effort, MCP servers, profiles) affects a review. Whatever should differ from Codex's built-in defaults has to be passed to this tool:

- `--model <name>` picks the model Codex reviews with. Unset, Codex uses its own default model.
- `--reasoning-effort <level>` sets how hard the model thinks: `none`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. Any other value exits 2 before Codex starts.

The effort defaults to `high`, not Codex's built-in default. In a side-by-side check against cloud Codex on real changes, the local review at the built-in settings missed most of cloud Codex's findings. A review runs once per change and its misses are expensive, so spending more reasoning on it is the better trade. `xhigh` and `max` are accepted for slower, deeper runs.

The tool prints the model and effort it asked for on stderr (`reviewing with model Codex's default, reasoning effort high`), and `--format json` includes them as `model` (or `null`) and `reasoning_effort`. Codex does not report which model it used, so an unset `--model` is reported as Codex's default rather than a name. Details are in [docs/codex-output.md](docs/codex-output.md).

### Posting to a merge request

Without `--dry-run`, the tool posts. It needs four things, each from a flag or else from GitLab CI's own variables:

| What | Flag | CI variable |
|---|---|---|
| GitLab instance | `--gitlab-url https://gitlab.com` | `CI_SERVER_URL` |
| Project id or path | `--project group/project` | `CI_MERGE_REQUEST_PROJECT_ID`, then `CI_PROJECT_ID` |
| Merge request iid | `--mr 12` | `CI_MERGE_REQUEST_IID` |
| Token | none (environment only) | `CODEX_MR_REVIEW_TOKEN` |

If any is missing it exits 2 and names it, before Codex runs. The token needs the `api` scope on an account (ideally a dedicated bot or project access token) that can comment on the merge request. `GITLAB_TOKEN` is deliberately not used as a fallback: it is often a person's own token, and the review should post as an identity a consumer can pin.

What it posts, in this order (layouts in [docs/output-format.md](docs/output-format.md)):

1. Each new finding as an inline, resolvable thread on the line, built from the merge request's `diff_refs`. If GitLab rejects the position (for example a line outside the diff), the finding is posted as a general thread that cites `path:line`, so it is never dropped.
2. A finding already posted by an earlier review (matched by a fingerprint hidden in the thread) is not posted again. If its thread was resolved and the finding is still there, the thread gets one reply and is reopened, once. After that it is only counted.
3. A summary note: the summary, counts by priority, how many findings were not posted again or were reopened, whether `AGENTS.md` changed, and the review marker `<!-- phases:review v=1 reviewer=<name> sha=<sha> -->` on its last line. `--reviewer` sets the name.
4. With `--clean-emoji`, a thumbs up on the merge request when the review found nothing.

The marker's sha is the pipeline's: `CI_MERGE_REQUEST_SOURCE_BRANCH_SHA` when set (the branch head in a merged-results pipeline), else `CI_COMMIT_SHA`, else the commit checked out where the tool runs. It is never read from model output. The marker is posted only after Codex exited successfully and every finding was posted. A failed review posts a short failure note with no marker and exits 1.

Model text is scrubbed before posting: `<!-- phases:review` and the tool's own hidden comment prefixes are removed, and every known secret is redacted.

### Environment

Codex runs with an allowlisted environment (`src/env.js`): `PATH`, `HOME`, locale and temp variables, `CODEX_HOME`, `CODEX_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, proxy variables and `SSL_CERT_FILE` / `SSL_CERT_DIR`. Nothing else reaches it. In particular `GITLAB_TOKEN`, `CI_JOB_TOKEN` and `CODEX_MR_REVIEW_TOKEN` never do.

`CODEX_MR_REVIEW_TOKEN` is the GitLab token the tool posts with. Only the tool's own requests to GitLab carry it, in the `PRIVATE-TOKEN` header.

The values of those three tokens and of `OPENAI_API_KEY` and `CODEX_API_KEY` are replaced with `[redacted]` in everything the tool prints. See [SECURITY.md](SECURITY.md).

Install instructions and the GitLab CI template will follow.

## Development

Requires Node 20 or later. There are no runtime dependencies.

```
npm ci
npm test
npm run lint
```

## License

MIT. See [LICENSE](LICENSE).

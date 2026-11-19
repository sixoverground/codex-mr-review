# codex-mr-review

Run the Codex CLI's review mode in GitLab CI and post the findings to the merge request.

## What it does

GitLab has no built-in equivalent of cloud Codex reviewing a pull request on GitHub. This tool fills that gap for a GitLab project with its own runner. On every merge request pipeline it:

1. Checks out the merge request's head in a temporary directory, with every `AGENTS.md` taken from the base branch, so a merge request cannot rewrite the instructions for its own review.
2. Runs `codex exec` in Codex's built-in review mode, in a read-only sandbox, with no custom prompt.
3. Posts each finding as an inline, resolvable thread on the line, laid out the way cloud Codex lays out a finding: a P0 to P3 badge and a title, then the body.
4. Posts a summary note ending with a machine-readable review marker that names the reviewer and the exact commit reviewed, after every completed review, clean or not.

It is not a GitHub reviewer (it never posts to GitHub), not a custom review prompt, and not an approval gate: a marker says a commit was reviewed, not whether the review liked it.

## The contract it implements

The marker and the inline threads follow version 1 of the review contract, pinned at
https://github.com/sixoverground/claude-phases/blob/5c8875d10d58a6aebaf421d4d999388533195aa6/docs/review-contract.md
(see [docs/contract.md](docs/contract.md)). In short: findings are inline resolvable threads, and every completed review leaves a top-level note with

```
<!-- phases:review v=1 reviewer=<name> sha=<40 character sha> -->
```

on its own line, written by the tool's code, never by the model, and only after the review succeeded. Anything that needs to know whether a commit was reviewed can read it, and should accept it only from the account the tool posts as.

## Install

On the machine that runs the review (the runner), with Node 20 or later and git:

```
npm install -g github:sixoverground/codex-mr-review#v0.1.0
codex-mr-review --version
```

This installs straight from the release tag on GitHub, so no npm registry account is needed. The equivalent long form is `npm install -g git+https://github.com/sixoverground/codex-mr-review.git#v0.1.0`. There are no runtime dependencies and no build step.

The runner also needs the Codex CLI (tested with codex-cli 0.147.x), logged in. See "Codex on the runner" below.

## Add it to a project

In the project's `.gitlab-ci.yml`:

```yaml
include:
  - remote: https://raw.githubusercontent.com/sixoverground/codex-mr-review/v0.1.0/templates/codex-review.gitlab-ci.yml

codex-review:
  tags: [your-runner-tag]
```

Then, under **Settings > CI/CD > Variables**, add `CODEX_MR_REVIEW_TOKEN` with the token described below. Mark it **masked**. Do not mark it **protected** unless every merge request branch is protected: a protected variable is not passed to pipelines on unprotected branches, and the job then fails with "posting needs ... CODEX_MR_REVIEW_TOKEN".

The template ([templates/codex-review.gitlab-ci.yml](templates/codex-review.gitlab-ci.yml)) defines a hidden job `.codex-review` and a ready job `codex-review` that extends it. The job:

- runs only on merge request pipelines (`$CI_PIPELINE_SOURCE == "merge_request_event"`), in the `test` stage (override `stage:` if the project has no `test` stage);
- fetches full history (`GIT_DEPTH: "0"`), so the merge request's diff base is in the checkout;
- is `interruptible: true`, so a newer push cancels a running review, and has a `resource_group` per merge request, so two reviews of one merge request never run at once;
- leaves runner `tags` for the project to set;
- reviews from `$CI_MERGE_REQUEST_DIFF_BASE_SHA`, and in a merged-results pipeline passes `--head "$CI_MERGE_REQUEST_SOURCE_BRANCH_SHA"`, so the reviewed tree is the one the merge request's diff shows rather than the merge commit.

Variables the job reads, each overridable in the project's CI/CD variables or in the `codex-review` job:

| Variable | Default | Passed as |
|---|---|---|
| `CODEX_MR_REVIEW_TOKEN` | none (required) | the GitLab token, environment only |
| `CODEX_MR_REVIEW_MODEL` | empty (Codex's default) | `--model` |
| `CODEX_MR_REVIEW_REASONING_EFFORT` | `high` | `--reasoning-effort` |
| `CODEX_MR_REVIEW_REVIEWER` | `codex` | `--reviewer`, the name in the marker |
| `CODEX_MR_REVIEW_TIMEOUT` | `900` | `--timeout`, in seconds |
| `CODEX_MR_REVIEW_CLEAN_EMOJI` | `false` | `--clean-emoji` when `true` |

## The token and the role it needs

`CODEX_MR_REVIEW_TOKEN` is a GitLab access token with the `api` scope, for an account with at least the **Developer** role on the project. Posting notes and threads needs less, but reopening a resolved thread needs Developer (or authorship of the merge request). Use a project access token or a dedicated bot user, not a person's token: consumers of the marker pin it to the account that posts it, and `GITLAB_TOKEN` is deliberately not used as a fallback for the same reason.

The token is sent only in the `PRIVATE-TOKEN` header of the tool's own requests to GitLab. It never reaches Codex, and it is redacted from everything the tool prints or posts.

## A shell-executor runner on macOS

The review needs a machine with Codex logged in, which usually means a Mac and a [shell-executor runner](https://docs.gitlab.com/runner/install/osx/). Because the read-only sandbox can still read anything the runner's user can (see [SECURITY.md](SECURITY.md)), run it as a dedicated user:

1. Create a standard (non-admin) macOS user for the runner, for example `gitlab-runner`, with nothing else in its home.
2. As that user, install Node 20 or later, git and the Codex CLI, then install this tool with the command above. Check that `node`, `codex` and `codex-mr-review` are on that user's `PATH` in a non-interactive shell (`bash -lc 'command -v codex codex-mr-review'`), since the shell executor runs a login shell.
3. As that user, log in to Codex (below) and install and register `gitlab-runner` with the `shell` executor and a tag, following GitLab's macOS runner instructions. On macOS the runner runs as a LaunchAgent, so that user must stay logged in.
4. Put the tag in the project's `codex-review` job.

## Codex on the runner

Codex authenticates as the runner user, in that user's `CODEX_HOME` (default `~/.codex`):

- **ChatGPT login:** run `codex login` once as the runner user. Reviews then draw on that account's Codex usage, and hitting its rate limit makes the job fail like any other failed review: red, with a failure note and no marker.
- **API key:** set `CODEX_API_KEY` (or `OPENAI_API_KEY`) in the runner's environment or as a masked CI/CD variable. The tool passes these two to Codex and redacts them from its output.

The tool runs Codex with `--ignore-user-config`, so the runner user's `config.toml` (model, MCP servers, profiles) never affects a review. Codex does still read a global `AGENTS.md` or `AGENTS.override.md` in its home; keep those empty for the runner user. The tool warns when one has content.

## Command line

```
codex-mr-review --help
codex-mr-review --version
codex-mr-review review [--base <ref>] [--head <ref>] [--dry-run] [--format text|json]
                       [--reviewer <name>] [--clean-emoji] [--timeout <seconds>]
                       [--model <name>] [--reasoning-effort <level>]
                       [--gitlab-url <url>] [--project <id|path>] [--mr <iid>]
```

Run it from inside the repository. It reviews `--head` against `--base`:

- `--base` is required, except in a merge request pipeline, where it defaults to `$CI_MERGE_REQUEST_DIFF_BASE_SHA`.
- `--head` defaults to `$CI_MERGE_REQUEST_SOURCE_BRANCH_SHA` when GitLab sets it (merged-results pipelines only), and to `HEAD` otherwise.
- `--dry-run` prints the findings locally and makes no network call. `--format text` prints each finding under its location, then the summary. `--format json` prints one object valid against [schema/review-output.schema.json](schema/review-output.schema.json). See [docs/output-format.md](docs/output-format.md).
- Exit status 0 means the review completed and was posted (or printed), with or without findings. 1 means a failure: Codex failed, timed out or returned something that does not parse, GitLab refused a request, or the marker was withheld. 2 means a usage error, such as a missing token, before anything runs.

### Model and reasoning effort

Codex always runs with `--ignore-user-config`, so nothing in `~/.codex/config.toml` (model, reasoning effort, MCP servers, profiles) affects a review. Whatever should differ from Codex's built-in defaults has to be passed to this tool:

- `--model <name>` picks the model Codex reviews with. Unset, Codex uses its own default model.
- `--reasoning-effort <level>` sets how hard the model thinks: `none`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. Any other value exits 2 before Codex starts.

The effort defaults to `high`, not Codex's built-in default. In a side-by-side check against cloud Codex on real changes, the local review at the built-in settings missed most of cloud Codex's findings. A review runs once per change and its misses are expensive, so spending more reasoning on it is the better trade. `xhigh` and `max` are accepted for slower, deeper runs.

The tool prints the model and effort it asked for on stderr (`reviewing with model Codex's default, reasoning effort high`), and `--format json` includes them as `model` (or `null`) and `reasoning_effort`. Codex does not report which model it used, so an unset `--model` is reported as Codex's default rather than a name. Details are in [docs/codex-output.md](docs/codex-output.md).

### What it posts

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

Positions are sent only when the merge request's `diff_refs.head_sha` is the reviewed commit. If the merge request has moved on, findings are posted as general threads citing `path:line`, since a line number from one tree can land on the wrong line of another. If `--head` is passed and is not the pipeline's commit, the findings are still posted but the marker is withheld, the summary says why, and the tool exits 1. Without an explicit `--head` a mismatch only warns: the marker always names the pipeline's commit, and in a merged-results pipeline the head already defaults to the source branch head, so the two agree.

Model text is scrubbed before posting: `<!-- phases:review` and the tool's own hidden comment prefixes are removed, and every known secret is redacted.

### Environment

Codex runs with an allowlisted environment (`src/env.js`): `PATH`, `HOME`, locale and temp variables, `CODEX_HOME`, `CODEX_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, proxy variables and `SSL_CERT_FILE` / `SSL_CERT_DIR`. Nothing else reaches it. In particular `GITLAB_TOKEN`, `CI_JOB_TOKEN` and `CODEX_MR_REVIEW_TOKEN` never do.

`CODEX_MR_REVIEW_TOKEN` is the GitLab token the tool posts with. Only the tool's own requests to GitLab carry it, in the `PRIVATE-TOKEN` header.

The values of those three tokens and of `OPENAI_API_KEY` and `CODEX_API_KEY` are replaced with `[redacted]` in everything the tool prints. See [SECURITY.md](SECURITY.md).

## Running a reviewer other than Codex

The marker contract is not specific to Codex. Any reviewer can share this job's setup (merge request pipelines only, full history, one review per merge request, interruptible) by replacing the script and emitting the contract itself: post each finding as an inline, resolvable thread on the merge request, then, only after the review succeeded, post a top-level note whose last line is `<!-- phases:review v=1 reviewer=<name> sha=<sha> -->` with its own reviewer name and the full sha of the commit it reviewed. For example:

```yaml
include:
  - remote: https://raw.githubusercontent.com/sixoverground/codex-mr-review/v0.1.0/templates/codex-review.gitlab-ci.yml

other-review:
  extends: .codex-review
  tags: [your-runner-tag]
  resource_group: other-review-$CI_MERGE_REQUEST_PROJECT_ID-$CI_MERGE_REQUEST_IID
  script:
    - my-reviewer --base "$CI_MERGE_REQUEST_DIFF_BASE_SHA" --reviewer my-reviewer
```

Give it its own reviewer name and resource group, and the same rules this tool follows apply to it: the sha comes from the pipeline, never from model output; model text is scrubbed of `<!-- phases:review` before posting; and a failed review posts no marker.

## Development

Requires Node 20 or later. There are no runtime dependencies.

```
npm ci
npm test
npm run lint
```

Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

MIT. See [LICENSE](LICENSE).

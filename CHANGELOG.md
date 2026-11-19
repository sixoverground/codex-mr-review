# Changelog

All notable changes to this project are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.1.0]

The first release: review a GitLab merge request with Codex's own review mode and post the result.

### Added

- The `codex-mr-review` command line, with `review`, `--help` and `--version`, and no runtime dependencies.
- `review --dry-run`: runs `codex exec review` in a read-only sandbox, with no custom prompt, in a temporary checkout of the head commit whose `AGENTS.md` files all come from the base, and prints the findings as text or as JSON valid against `schema/review-output.schema.json`. Findings carry a P0 to P3 priority and a fingerprint that survives lines moving.
- `--model` and `--reasoning-effort` (default `high`). Codex runs with `--ignore-user-config`, so the runner's `config.toml` never changes a review.
- Posting to GitLab: each finding as an inline, resolvable thread in cloud Codex's layout, falling back to a general thread citing `path:line` when GitLab rejects the position or the merge request has moved on; no re-posting of a finding already on one of the tool's threads, and one reopen of a resolved thread whose finding is back; a summary note ending with the review marker `<!-- phases:review v=1 reviewer=<name> sha=<sha> -->` for the pipeline's commit, posted only after the review succeeded and every finding was posted; a failure note, with no marker, otherwise; and `--clean-emoji`.
- The GitLab CI template `templates/codex-review.gitlab-ci.yml`: merge request pipelines only, full history, interruptible, one review per merge request at a time, runner tags left to the project, and variables for the model, effort, reviewer name, timeout and clean emoji. In a merged-results pipeline it reviews the source branch head.
- In CI, `--base` defaults to `$CI_MERGE_REQUEST_DIFF_BASE_SHA` and `--head` to `$CI_MERGE_REQUEST_SOURCE_BRANCH_SHA` when GitLab sets it.
- Install from the release tag with `npm install -g github:sixoverground/codex-mr-review#v0.1.0`, no registry account needed.

### Security

- Codex gets an allowlisted environment: the GitLab token, `CI_JOB_TOKEN` and `GITLAB_TOKEN` never reach it.
- Known secrets are redacted, raw and trimmed, from everything printed or posted, always before any text is cut. Everything from Codex is scrubbed of marker text at one point, and the scrubbed review is validated before anything is posted.
- The review checkout is a local clone whose git config is stripped of credentials (remote URL userinfo, extra headers, credential helpers) before Codex starts; the CI checkout's config is untouched.
- Guidance files are reset to the base at any depth, symlinks in the change are never followed, and base guidance symlinks resolve in the base tree.
- Codex's whole process group is killed when it exits. GitLab redirects are never followed, so the token is never resent to another host.
- `SECURITY.md` states what remains open: the read-only sandbox can read anything the runner's user can, so run the runner as a dedicated user.

[0.1.0]: https://github.com/sixoverground/codex-mr-review/releases/tag/v0.1.0

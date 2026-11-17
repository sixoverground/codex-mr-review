# Security

## Reporting a vulnerability

Please report security problems privately through GitHub's private vulnerability reporting on this repository (the "Report a vulnerability" button under the Security tab). Do not open a public issue. We aim to acknowledge a report within a week.

## What this tool handles

This tool will hold a GitLab token with permission to comment on merge requests, and will run a model over code that the merge request's author controls. The rules it is built around:

- **The token never reaches the model.** Codex runs as a child process with an allowlisted environment (`src/env.js`), so the GitLab token, `CI_JOB_TOKEN` and the tool's own `CODEX_MR_REVIEW_TOKEN` are not in it. A test checks the environment the child actually receives.
- **The token is never logged or posted.** Known secret values are redacted from everything the tool writes to a merge request or to the job log.
- **The model cannot write the review marker.** The marker is added by the tool after Codex exits successfully, using a commit sha from the CI environment. Any marker-like text in model output is removed before posting.
- **The diff cannot rewrite its own review instructions.** The review runs in a temporary worktree of the head commit in which `AGENTS.md` and `AGENTS.override.md` are the base commit's copies, or absent when the base has none. The summary says when the head changed them.
- **The reviewer's own Codex config is not used.** Codex runs with `--ignore-user-config`, so MCP servers and model settings from `~/.codex/config.toml` do not apply to a review.

## Known limits

Codex's read-only sandbox blocks writes and network access, but it can still read any file the runner's user can read. Run the runner as a dedicated user with access to nothing else, especially on a personal machine with a shell executor. Anything a finding quotes is visible to everyone who can see the merge request.

This section will be completed as the tool is built out.

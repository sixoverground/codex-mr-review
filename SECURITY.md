# Security

## Reporting a vulnerability

Please report security problems privately through GitHub's private vulnerability reporting on this repository (the "Report a vulnerability" button under the Security tab). Do not open a public issue. We aim to acknowledge a report within a week.

## What this tool handles

This tool will hold a GitLab token with permission to comment on merge requests, and will run a model over code that the merge request's author controls. The rules it is built around:

- **The token never reaches the model.** Codex runs as a child process with an allowlisted environment (`src/env.js`), so the GitLab token, `CI_JOB_TOKEN` and the tool's own `CODEX_MR_REVIEW_TOKEN` are not in it. A test checks the environment the child actually receives.
- **The token is never logged or posted.** The values of `GITLAB_TOKEN`, `CI_JOB_TOKEN`, `CODEX_MR_REVIEW_TOKEN`, `OPENAI_API_KEY` and `CODEX_API_KEY` (when 8 characters or longer) are replaced with `[redacted]` in everything the tool writes: diagnostics, error messages that quote Codex, and findings and summaries in both output formats. All output passes through one redaction point (`src/redact.js`, applied to stdout and stderr at the top of `main`). The API keys do reach Codex, which needs them, so this is what stops Codex echoing one into the log.
- **The model cannot write the review marker.** The marker is added by the tool after Codex exits successfully, using a commit sha from the CI environment. Any marker-like text in model output is removed before posting.
- **The diff cannot rewrite its own review instructions.** The review runs in a temporary worktree of the head commit in which every `AGENTS.md` and `AGENTS.override.md`, at any depth, is the base commit's copy, or absent when the base has none. That covers guidance files the head adds, edits or deletes. The summary says when the head changed any of them.
- **A guidance symlink in the base is resolved in the base, never recreated.** A base `AGENTS.md -> instructions.md` is followed inside the base commit's tree (chains and directory links included) and the base content is written as a regular file, so a change cannot rewrite its instructions by editing the target. A head change to any file or link such a symlink resolves through is reported as a change to `AGENTS.md`. A base link that leaves the repository, is missing or loops fails the run before Codex starts.
- **Symlinks in the change are never followed when resetting guidance.** An existing entry is unlinked without being followed before the base copy is written. If any directory on the way to a guidance path is a symlink, or the parent resolves outside the worktree, the run fails before Codex starts.
- **Nothing Codex starts outlives the review.** Codex runs in its own process group, and the whole group gets SIGKILL when Codex exits, on every path, before the worktree is removed.
- **The reviewer's own Codex config is not used.** Codex runs with `--ignore-user-config`, so MCP servers and model settings from `~/.codex/config.toml` do not apply to a review.

- **The marker is the tool's, not the model's.** It is built by the tool from the CI sha (or the checkout's), only after Codex exited successfully and every finding was posted, and it goes in a top-level note. A failed run posts no marker.
- **Only the tool's own threads count for dedupe.** A finding is skipped or reopened only when its fingerprint is on a thread the token's own account started, so a fingerprint pasted by someone else cannot hide a finding. Model text cannot carry a fingerprint either: the prefix is scrubbed.
- **Post as a dedicated identity.** Anyone who can comment can type a marker by hand, so a consumer should accept a marker only from the account the tool posts as. Use a bot user or a project access token for `CODEX_MR_REVIEW_TOKEN`, not a person's token.

## Known limits

Codex's read-only sandbox blocks writes and network access, but it can still read any file the runner's user can read. Run the runner as a dedicated user with access to nothing else, especially on a personal machine with a shell executor. Anything a finding quotes is visible to everyone who can see the merge request.

This section will be completed as the tool is built out.

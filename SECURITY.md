# Security

## Reporting a vulnerability

Please report security problems privately through GitHub's private vulnerability reporting on this repository (the "Report a vulnerability" button under the Security tab). Do not open a public issue. We aim to acknowledge a report within a week.

## What this tool handles

This tool will hold a GitLab token with permission to comment on merge requests, and will run a model over code that the merge request's author controls. The rules it is built around:

- **The token never reaches the model.** Codex runs as a child process with an allowlisted environment, so the GitLab token and `CI_JOB_TOKEN` are not in it.
- **The token is never logged or posted.** Known secret values are redacted from everything the tool writes to a merge request or to the job log.
- **The model cannot write the review marker.** The marker is added by the tool after Codex exits successfully, using a commit sha from the CI environment. Any marker-like text in model output is removed before posting.
- **The diff cannot rewrite its own review instructions.** `AGENTS.md` is taken from the base branch.

## Known limits

Codex's read-only sandbox blocks writes and network access, but it can still read any file the runner's user can read. Run the runner as a dedicated user with access to nothing else, especially on a personal machine with a shell executor. Anything a finding quotes is visible to everyone who can see the merge request.

This section will be completed as the tool is built out.

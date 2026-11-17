# codex-mr-review

Run the Codex CLI's review mode in GitLab CI and post findings to merge requests.

**Status: dry run only.** `review --dry-run` runs Codex's review mode on a change and prints the findings. Nothing is posted yet: `review` without `--dry-run` exits with "not implemented".

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
```

`--dry-run` prints the findings locally and posts nothing. `--base` is required. Run it from inside the repository; it reviews `--head` (default `HEAD`) against `--base` in a temporary worktree, with every `AGENTS.md` and `AGENTS.override.md` (at any depth) taken from `--base`, and removes the worktree afterwards.

- `--format text` prints each finding under its location, laid out like a cloud Codex comment, then one summary. `--format json` prints one object valid against [schema/review-output.schema.json](schema/review-output.schema.json). See [docs/output-format.md](docs/output-format.md).
- Exit status 0 means the review completed, with or without findings. Any failure (Codex exits non-zero, times out, or returns something that does not parse, including a priority outside P0 to P3) exits 1 and prints no findings.
- It needs the `codex` CLI on `PATH`, logged in or with `CODEX_API_KEY` or `OPENAI_API_KEY` set. It is tested with codex-cli 0.147.x and warns on any other version. What that version prints is recorded in [docs/codex-output.md](docs/codex-output.md).

### Environment

Codex runs with an allowlisted environment (`src/env.js`): `PATH`, `HOME`, locale and temp variables, `CODEX_HOME`, `CODEX_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, proxy variables and `SSL_CERT_FILE` / `SSL_CERT_DIR`. Nothing else reaches it. In particular `GITLAB_TOKEN`, `CI_JOB_TOKEN` and `CODEX_MR_REVIEW_TOKEN` never do.

`CODEX_MR_REVIEW_TOKEN` is the name reserved for the GitLab token this tool will use to post. Nothing reads it yet.

The values of those three tokens and of `OPENAI_API_KEY` and `CODEX_API_KEY` are replaced with `[redacted]` in everything the tool prints. See [SECURITY.md](SECURITY.md).

Install instructions and the GitLab CI template will follow once the tool posts.

## Development

Requires Node 20 or later. There are no runtime dependencies.

```
npm ci
npm test
npm run lint
```

## License

MIT. See [LICENSE](LICENSE).

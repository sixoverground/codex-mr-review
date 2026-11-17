# codex-mr-review

Run the Codex CLI's review mode in GitLab CI and post findings to merge requests.

**Status: scaffold.** The command line parses its arguments, and `review` exits with "not implemented". Nothing is reviewed or posted yet.

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

`--dry-run` will print findings locally without posting. Install instructions and the GitLab CI template will follow once the tool does something.

## Development

Requires Node 20 or later. There are no runtime dependencies.

```
npm ci
npm test
npm run lint
```

## License

MIT. See [LICENSE](LICENSE).

# Output format

A finding from this tool is laid out the way cloud Codex lays out a finding on a GitHub pull request, so anything already written to read a Codex review (a person, or claude-phases' `phase-driver`) reads this one the same way.

## The reference

A real cloud Codex review on a public pull request:

https://github.com/sixoverground/claude-phases/pull/36

by `chatgpt-codex-connector[bot]`, fetched on 2026-11-17 with

```
gh api repos/sixoverground/claude-phases/pulls/36/comments
gh api repos/sixoverground/claude-phases/pulls/36/reviews
gh api repos/sixoverground/claude-phases/issues/36/comments
```

Recorded verbatim in `test/fixtures/cloud-codex/`:

- `inline-comment.md`: the body of one inline finding, https://github.com/sixoverground/claude-phases/pull/36#discussion_r4604881062
- `review-body.md`: the body of the review the inline comments belong to, https://github.com/sixoverground/claude-phases/pull/36#pullrequestreview-5945445700
- `summary-comment.md`: the "Codex Review Summary" issue comment, https://github.com/sixoverground/claude-phases/pull/36#issuecomment-6958947812
- `source.json`: where each one came from

## An inline finding

The raw markdown of the cloud comment:

```
**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Isolate polling failures to the affected pull request**

When watching multiple PRs, a failed request for one PR suppresses ...

Useful? React with 👍 / 👎.

<!-- codex-code-review-finding:v1 -->
```

The structure, in order:

1. **The priority badge comes first**, inside the bold span: an image whose alt text is `P2 Badge`, served by shields.io as `https://img.shields.io/badge/P2-yellow?style=flat`, wrapped in `<sub><sub>...</sub></sub>` to shrink it.
2. **Two spaces, then the title**, still inside the same `**...**`, so the first line reads as the badge and a bold title.
3. **A blank line, then the body.**
4. A "Useful?" line and a hidden `<!-- codex-code-review-finding:v1 -->` marker.

The file and line are not in the body; GitHub anchors the comment to them (here `skills/phase-driver/references/watching.md`, lines 84 to 87).

`src/render.js` writes items 1 to 3 exactly. A test (`test/render.test.js`) renders a finding with the reference's priority, title and first paragraph and checks it matches the recorded comment byte for byte up to the end of that paragraph, and that both match the same structural pattern.

It does not write item 4. The "Useful?" line asks for feedback that goes to OpenAI's service, and the `codex-code-review-finding:v1` marker is cloud Codex's own; writing it would make a local review claim to be a cloud one. This tool's machine-readable marker is the one in `docs/contract.md`, which a later phase adds.

**Badge colours.** Only `P2-yellow` has been observed on a real review. P0 `red`, P1 `orange` and P3 `green` are assumptions until a real cloud review with those priorities is recorded. A reader that keys on the priority should read the alt text or the badge label (`P1`), not the colour.

## The summary

Cloud Codex writes two summaries:

- The **review body** (`review-body.md`), posted with the inline comments: a hidden `<!-- codex-review-receipt:v1 -->`, a `### 💡 Codex Review` heading, "Here are some automated review suggestions for this pull request.", `**Reviewed commit:** \`e47ffccf9c\`` (ten characters), and a collapsed "About Codex in GitHub" block.
- A separate **issue comment** (`summary-comment.md`) that it edits as reviews run. It starts with `<!-- codex-pull-request-review-summary -->` and `<!-- codex-review-state:v1 {...} -->`, a JSON object with `code_review` and `security_review` entries (`commit_sha`, `has_any_findings`, `has_unresolved_findings`, `status`), then a collapsed status table. This tool records it as observed and does not emit it.

This tool prints one summary per review, modelled on the review body:

```
### 💡 Codex Review

Here are some automated review suggestions for this merge request.

<Codex's overall explanation>

**Reviewed commit:** `72cd7804d1`
```

With no findings the second paragraph reads "Codex found no issues in this change." When the head commit changes `AGENTS.md` (or adds `AGENTS.override.md`), a line says the review followed the base branch's copy. The hidden receipt marker and the "About Codex in GitHub" block are left out for the same reason as above.

## `--dry-run --format text`

Each finding under its location (`path:start-end`, or just the path when Codex gave no range), rendered as above, separated by `---`, then the summary.

## `--dry-run --format json`

One JSON object, valid against `schema/review-output.schema.json`:

```json
{
  "version": 1,
  "status": "completed",
  "base": "<40 character sha>",
  "head": "<40 character sha>",
  "codex_version": "0.147.0",
  "agents_md_changed": false,
  "explanation": "...",
  "findings": [
    {
      "path": "src/stats.js",
      "start_line": 26,
      "end_line": 26,
      "priority": "P1",
      "title": "Stop sumFirst after n elements",
      "body": "...",
      "fingerprint": "<64 hex characters>"
    }
  ]
}
```

`start_line` and `end_line` are `null` together when a finding has no line range. `priority` is one of `P0` to `P3`. `title` has the `[P1]` prefix removed.

The fingerprint is SHA-256 over the path, the title (priority prefix removed, whitespace collapsed, lower-cased) and the text of the flagged lines at the head commit (trailing whitespace removed). Line numbers are not part of it, so a finding keeps its fingerprint when an unrelated edit moves it.

A failed review prints nothing on stdout, in either format.

# Output format

A finding from this tool is laid out the way cloud Codex lays out a finding on a GitHub pull request, so anything already written to read a Codex review (a person, or a tool that drives the change) reads this one the same way.

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

## On a GitLab merge request

Without `--dry-run`, every note the tool posts ends with hidden lines (HTML comments, which GitLab does not render) written by the tool's own code, never by the model. Each kind of note, with its hidden lines in order:

- **A finding** is an inline thread whose body is the rendering above, unchanged, then two hidden lines:

  ```
  <!-- codex-mr-review:fingerprint <64 hex> -->
  <!-- phases:reviewer v=1 reviewer=<name> -->
  ```

  The fingerprint recognises the finding on a later run. The second line is the reviewer stamp, which says the tool wrote the note. The thread is anchored with a text position: `base_sha`, `start_sha` and `head_sha` from the merge request's `diff_refs`, `new_path`, `old_path` (the pre-rename path when the file was renamed), `new_line` (the finding's first line), and `old_line` as well when that line is unchanged context.
- **When GitLab rejects the position** (a 400), the same body, with the same two hidden lines, is posted as a general thread, which is still resolvable, with a first line citing the location, such as `` `src/stats.js:26` ``.
- **A reopened thread** gets one reply, ``Still present at `<sha>`.``, then two hidden lines: `<!-- codex-mr-review:reopened -->`, so it is reopened only once, and the reviewer stamp.
- **The summary note** is the summary above with the 40 character sha's first ten characters as the reviewed commit, then `**Findings:** 1 P1, 1 P3` (or `none`), a sentence each for findings not posted again and threads reopened when there are any, then a blank line, the reviewer stamp, and the marker on the last line:

  ```
  <!-- phases:reviewer v=1 reviewer=codex -->
  <!-- phases:review v=1 reviewer=codex sha=<40 character sha> -->
  ```

  When the marker is withheld (an explicit `--head` that is not the pipeline's commit), the summary says why and the stamp is its last line, with no marker.
- **A failed review** posts only `### 💡 Codex Review` and "The review did not complete:" with the first line of the reason, then a blank line and the reviewer stamp. No marker.

`<name>` is `--reviewer`, `codex` by default. The stamp says who wrote a note; only the marker says a review completed.

A note carrying `<!-- phases:driver v=1 -->`, the contract's reserved consumer stamp, is never the tool's own, even when it was posted from the tool's account: a thread whose first note carries it is not one of the tool's threads, and a reply carrying it is not the tool's reopen. A thread posted by 0.1.0, with a fingerprint and no stamp, is still recognised as the tool's.

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
  "model": null,
  "reasoning_effort": "high",
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

`model` is the `--model` passed to Codex, or `null` when Codex used its own default. `reasoning_effort` is the level passed, `high` unless `--reasoning-effort` says otherwise.

`start_line` and `end_line` are `null` together when a finding has no line range. `priority` is one of `P0` to `P3`. `title` has the `[P1]` prefix removed.

The fingerprint is SHA-256 over the path, the title (priority prefix removed, whitespace collapsed, lower-cased) and the text of the flagged lines at the head commit (trailing whitespace removed). Line numbers are not part of it, so a finding keeps its fingerprint when an unrelated edit moves it.

A failed review prints nothing on stdout, in either format.

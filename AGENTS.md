# Review guidance for this repository

This file is read by the AI reviewer on every change to this repo. It says what matters here and how to label findings.

## What this repo is

A small Node command line tool, with no runtime dependencies, that runs the Codex CLI's review mode on a GitLab merge request and posts the findings back, followed by a summary note carrying a machine-readable review marker. The marker format is a contract other tools depend on; see `docs/contract.md`.

## Priority labels

Label every finding with exactly one of these. Nothing else is a valid priority.

- **P0**: Must fix before merging. A secret can leak, model output can produce or forge a marker, a marker can be posted for a review that did not complete, or the tool posts somewhere it must not.
- **P1**: Should fix before merging. A real bug in normal use: wrong output, a finding silently dropped, a failed review that exits 0, a broken test or CI job.
- **P2**: Worth fixing soon. Missing test coverage for a stated rule, an unhelpful error message, an edge case that is unlikely but real.
- **P3**: Minor. Naming, clarity, small simplifications.

Do not report style that the linter already enforces.

## What matters most here

- **Tokens never leak.** The GitLab token, `CI_JOB_TOKEN`, and any value the tool knows to be secret must never appear in a log line, an error message, a posted comment, a test fixture, or the environment passed to the `codex` child process. Flag any code path that could print or forward one.
- **Model output never writes the marker.** The marker `<!-- phases:review v=1 ... -->` is written only by the tool's own code, only after `codex` exited successfully and the findings were posted, with a sha from the CI environment or the checkout. Model text must be scrubbed of the marker prefix before posting. Any change that weakens one of these is P0.
- **Failures are loud.** A failed, timed out or unparseable review must exit non-zero, post no marker, and print no findings. Treat a path that turns a failure into a clean pass as P0 or P1.
- **The base branch's `AGENTS.md` governs a review.** The change under review must not be able to replace the instructions for its own review.
- **No runtime dependencies** without a stated reason. Dev dependencies are fine.
- **No network calls in tests.** Tests use a fake `codex` executable and a local HTTP server.
- **Contract fidelity.** Marker fields are exact: `v=1`, a reviewer name matching `[a-z0-9-]+`, and a full 40 character lowercase sha.

## Out of scope

- GitHub support. The tool never posts to GitHub, and a suggestion to add it is not a finding.
- Custom review prompts. The tool uses Codex's own review mode on purpose.
- Approval or merge decisions. The marker records that a review happened, nothing more.
- The quality of Codex's own findings. That is the model's behaviour, not this code's.
- Wording preferences in documentation, unless the text is wrong.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CodexOutputError, isTestedVersion, parseEvents, parseReviewText, reviewArgs } from "../src/codex.js";
import { CODEX_FIXTURES } from "./support/helpers.js";

const recordedEvents = readFileSync(join(CODEX_FIXTURES, "review-planted-bug.events.jsonl"), "utf8");
const recordedMessage = readFileSync(join(CODEX_FIXTURES, "review-planted-bug.last-message.txt"), "utf8");
const failedEvents = readFileSync(join(CODEX_FIXTURES, "failed-model-not-found.events.jsonl"), "utf8");
const DASH = "\u2014";

test("reviewArgs uses the read-only sandbox, review mode, --json and --ephemeral, with no prompt", () => {
  const args = reviewArgs({ baseSha: "a".repeat(40), lastMessagePath: "/tmp/last.txt" });
  assert.deepEqual(args, [
    "exec", "--sandbox", "read-only", "--ephemeral", "--ignore-user-config", "--json",
    "--output-last-message", "/tmp/last.txt", "review", "--base", "a".repeat(40),
  ]);
  // Nothing follows the review options: no custom prompt, positional or "-".
  assert.equal(args.at(-2), "--base");
});

test("parseEvents reads the recorded real run", () => {
  const e = parseEvents(recordedEvents);
  assert.equal(e.completed, true);
  assert.equal(e.failure, null);
  assert.equal(e.lastAgentMessage, recordedMessage);
});

test("parseEvents reports the recorded failed turn", () => {
  const e = parseEvents(failedEvents);
  assert.equal(e.completed, false);
  assert.match(e.failure, /model_not_found/);
});

test("parseEvents rejects a line that is not JSON", () => {
  assert.throws(() => parseEvents('{"type":"turn.started"}\nnot json\n'), CodexOutputError);
});

test("parseReviewText reads the recorded real review", () => {
  const r = parseReviewText(recordedMessage);
  assert.match(r.explanation, /off-by-one/);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].rawTitle, "[P1] Stop sumFirst after n elements");
  assert.match(r.findings[0].location, /\/worktree\/src\/stats\.js:26-26$/);
  assert.match(r.findings[0].body, /^For any positive `n`/);
  assert.ok(!r.findings[0].body.startsWith(" "));
});

// Synthetic: the plural header and a multi-line body, in the same layout.
test("parseReviewText reads several findings with multi-line bodies", () => {
  const text = [
    "Two problems.",
    "",
    "Full review comments:",
    "",
    `- [P0] Leaks the token ${DASH} /w/src/a.js:3-5`,
    "  First paragraph.",
    "  ",
    "  Second paragraph.",
    "",
    `- [P3] Rename x ${DASH} /w/src/b.js:9-9`,
    "  Short.",
  ].join("\n");
  const r = parseReviewText(text);
  assert.equal(r.explanation, "Two problems.");
  assert.equal(r.findings.length, 2);
  assert.equal(r.findings[0].body, "First paragraph.\n\nSecond paragraph.");
  assert.equal(r.findings[1].rawTitle, "[P3] Rename x");
  assert.equal(r.findings[1].body, "Short.");
});

test("parseReviewText treats a review with no findings block as clean", () => {
  const r = parseReviewText("The change looks correct. No issues found.\n");
  assert.deepEqual(r.findings, []);
  assert.equal(r.explanation, "The change looks correct. No issues found.");
});

for (const [name, text] of [
  ["empty output", ""],
  ["whitespace only", "  \n\n"],
  ["an interrupted review", "Review was interrupted. Please re-run /review and wait for it to complete."],
  ["a header with no findings", "Summary.\n\nReview comment:\n\n"],
  ["finding-like lines without a header", `Summary.\n\n- [P1] Bug ${DASH} src/a.js:1-2\n  body`],
  ["an unindented line inside the findings", `Summary.\n\nReview comment:\n\n- [P1] Bug ${DASH} src/a.js:1-2\nnot indented`],
]) {
  test(`parseReviewText rejects ${name}`, () => {
    assert.throws(() => parseReviewText(text), CodexOutputError);
  });
}

test("isTestedVersion accepts 0.147.x only", () => {
  assert.equal(isTestedVersion("0.147.0"), true);
  assert.equal(isTestedVersion("0.147.3"), true);
  assert.equal(isTestedVersion("0.148.0"), false);
  assert.equal(isTestedVersion("1.147.0"), false);
});

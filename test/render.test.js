import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { badge, renderFinding, renderSummary, renderText } from "../src/render.js";
import { CLOUD_FIXTURES } from "./support/helpers.js";

const cloudInline = readFileSync(join(CLOUD_FIXTURES, "inline-comment.md"), "utf8");

// The structure of a cloud Codex inline comment: the badge, two spaces and
// the title, all in bold on the first line; a blank line; then the body.
const STRUCTURE = new RegExp(
  "^\\*\\*<sub><sub>!\\[(P[0-3]) Badge\\]\\(https://img\\.shields\\.io/badge/\\1-([a-z]+)\\?style=flat\\)</sub></sub> {2}(.+)\\*\\*\\n\\n([^\\n].*)",
  "s",
);

function structure(markdown) {
  const m = STRUCTURE.exec(markdown);
  assert.ok(m, `not in cloud Codex layout:\n${markdown}`);
  const [, priority, color, title, rest] = m;
  return { priority, color, title, firstParagraph: rest.split("\n\n")[0].trimEnd() };
}

const SHA = "72cd7804d1a0b2c3d4e5f60718293a4b5c6d7e8f";

test("the recorded cloud Codex comment has the reference structure", () => {
  const s = structure(cloudInline);
  assert.equal(s.priority, "P2");
  assert.equal(s.color, "yellow");
  assert.equal(s.title, "Isolate polling failures to the affected pull request");
});

test("a rendered finding matches the recorded cloud Codex comment in structure", () => {
  const cloud = structure(cloudInline);
  const rendered = renderFinding({
    path: "src/stats.js", start_line: 26, end_line: 26,
    priority: cloud.priority, title: cloud.title, body: cloud.firstParagraph, fingerprint: "0".repeat(64),
  });
  assert.deepEqual(structure(rendered), cloud);
  // Up to the end of the first paragraph the two are byte for byte equal.
  assert.ok(cloudInline.startsWith(rendered.trimEnd()), rendered);
});

test("every priority renders in the same structure", () => {
  for (const p of ["P0", "P1", "P2", "P3"]) {
    const s = structure(renderFinding({ priority: p, title: "T", body: "B" }));
    assert.equal(s.priority, p);
  }
  assert.throws(() => badge("P4"));
});

test("the summary names the reviewed commit and notes an edited AGENTS.md", () => {
  const review = { head: SHA, explanation: "One bug.", agents_md_changed: false, findings: [{}] };
  const plain = renderSummary(review);
  assert.match(plain, /^### \u{1F4A1} Codex Review\n/u);
  assert.match(plain, /\*\*Reviewed commit:\*\* `72cd7804d1`/);
  assert.doesNotMatch(plain, /AGENTS\.md/);
  assert.match(renderSummary({ ...review, agents_md_changed: true }), /edits `AGENTS\.md`.*base branch's copy/);
  assert.match(renderSummary({ ...review, findings: [] }), /found no issues/);
});

test("renderText prints each finding under its location, then one summary", () => {
  const text = renderText({
    head: SHA, explanation: "E", agents_md_changed: false,
    findings: [
      { path: "a.js", start_line: 3, end_line: 4, priority: "P1", title: "T1", body: "B1" },
      { path: "b.js", start_line: null, end_line: null, priority: "P3", title: "T2", body: "B2" },
    ],
  });
  assert.match(text, /^a\.js:3-4\n\n\*\*<sub>/);
  assert.match(text, /\n---\n\nb\.js\n\n\*\*<sub>/);
  assert.equal(text.match(/Codex Review/g).length, 1);
});

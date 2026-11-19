import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseReviewText } from "../src/codex.js";
import {
  FindingError, PRIORITIES, fingerprint, flaggedText, normaliseFinding, parseLocation, relativePath, splitPriority,
} from "../src/findings.js";
import { CODEX_FIXTURES, FEATURE_STATS, RECORDED_ROOT } from "./support/helpers.js";

const recordedMessage = readFileSync(join(CODEX_FIXTURES, "review-planted-bug.last-message.txt"), "utf8");
const files = { "src/stats.js": FEATURE_STATS };
const ctx = { roots: [RECORDED_ROOT], readFile: (p) => files[p] ?? null };

test("normaliseFinding turns the recorded finding into the tool's shape", () => {
  const [raw] = parseReviewText(recordedMessage).findings;
  const f = normaliseFinding(raw, ctx);
  assert.deepEqual(Object.keys(f), ["path", "start_line", "end_line", "priority", "title", "body", "fingerprint"]);
  assert.equal(f.path, "src/stats.js");
  assert.equal(f.start_line, 26);
  assert.equal(f.end_line, 26);
  assert.equal(f.priority, "P1");
  assert.equal(f.title, "Stop sumFirst after n elements");
  assert.match(f.body, /^For any positive `n`/);
  assert.match(f.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(f.fingerprint, fingerprint({
    path: "src/stats.js",
    title: "Stop sumFirst after n elements",
    text: "  for (let i = 0; i <= n; i++) {",
  }));
});

test("a finding with no line range keeps null lines and still gets a fingerprint", () => {
  const f = normaliseFinding({ rawTitle: "[P2] Missing tests", location: "src/stats.js", body: "b" }, ctx);
  assert.equal(f.path, "src/stats.js");
  assert.equal(f.start_line, null);
  assert.equal(f.end_line, null);
  assert.match(f.fingerprint, /^[0-9a-f]{64}$/);
});

test("parseLocation reads a range, a single line, and no range", () => {
  assert.deepEqual(parseLocation("/w/a.js:3-5"), { path: "/w/a.js", start_line: 3, end_line: 5 });
  assert.deepEqual(parseLocation("a.js:7"), { path: "a.js", start_line: 7, end_line: 7 });
  assert.deepEqual(parseLocation("a.js"), { path: "a.js", start_line: null, end_line: null });
  assert.deepEqual(parseLocation("dir:x/a.js:2-2"), { path: "dir:x/a.js", start_line: 2, end_line: 2 });
  assert.throws(() => parseLocation("a.js:5-3"), FindingError);
  assert.throws(() => parseLocation("a.js:0-1"), FindingError);
});

test("relativePath strips any spelling of the worktree root", () => {
  const roots = ["/var/x/worktree", "/private/var/x/worktree"];
  assert.equal(relativePath("/private/var/x/worktree/src/a.js", roots), "src/a.js");
  assert.equal(relativePath("/var/x/worktree/src/a.js", roots), "src/a.js");
  assert.equal(relativePath("src/./a.js", roots), "src/a.js");
  assert.throws(() => relativePath("/etc/passwd", roots), FindingError);
  assert.throws(() => relativePath("/var/x/worktree-other/a.js", roots), FindingError);
  assert.throws(() => relativePath("../a.js", roots), FindingError);
});

test("relativePath refuses a newline, a control character or an angle bracket", () => {
  const roots = ["/w"];
  for (const bad of ["src/a\nb.js", "/w/src/a\r.js", "src/\u0000.js", "src/\u007f.js", "src/<!-- x -->.js", "src/a>b.js"]) {
    assert.throws(() => relativePath(bad, roots), /control character or an angle bracket/, JSON.stringify(bad));
  }
  assert.equal(relativePath("src/ünïcode file.js", roots), "src/ünïcode file.js");
});

test("normaliseFinding fails on a path with a newline", () => {
  assert.throws(() => normaliseFinding({ rawTitle: "[P1] T", location: "src/a\nb.js:1-1", body: "" }, ctx), FindingError);
});

test("the priority levels are P0 to P3 and nothing else", () => {
  assert.deepEqual(PRIORITIES, ["P0", "P1", "P2", "P3"]);
  for (const p of PRIORITIES) assert.equal(splitPriority(`[${p}] T`).priority, p);
  for (const bad of ["[P4] T", "[P9] T", "[P10] T", "[p1] T", "P1 T", "T", "[P1]  "]) {
    assert.throws(() => splitPriority(bad), FindingError, bad);
  }
});

test("a priority outside P0 to P3 fails normalisation", () => {
  assert.throws(
    () => normaliseFinding({ rawTitle: "[P4] Too low", location: "src/stats.js:1-1", body: "" }, ctx),
    /outside P0 to P3/,
  );
});

test("the same finding on lines shifted by an unrelated edit keeps its fingerprint", () => {
  const shifted = `// An unrelated header comment.\n// Another line.\n\n${FEATURE_STATS}`;
  const raw = { rawTitle: "[P1] Stop sumFirst after n elements", body: "b" };
  const before = normaliseFinding({ ...raw, location: "src/stats.js:26-26" }, ctx);
  const after = normaliseFinding({ ...raw, location: "src/stats.js:29-29" }, {
    roots: ctx.roots,
    readFile: () => shifted,
  });
  assert.equal(after.start_line, 29);
  assert.equal(before.fingerprint, after.fingerprint);
});

test("the fingerprint changes with the path, the title or the flagged text", () => {
  const base = { path: "a.js", title: "Bug", text: "x" };
  const fp = fingerprint(base);
  assert.notEqual(fingerprint({ ...base, path: "b.js" }), fp);
  assert.notEqual(fingerprint({ ...base, title: "Other bug" }), fp);
  assert.notEqual(fingerprint({ ...base, text: "y" }), fp);
  // Case, spacing and a priority tag in the title do not count.
  assert.equal(fingerprint({ ...base, title: "  [P2]  bug " }), fp);
});

test("flaggedText drops trailing whitespace and handles missing files", () => {
  assert.equal(flaggedText("a  \nb\t\nc", 1, 2), "a\nb");
  assert.equal(flaggedText(null, 1, 2), "");
  assert.equal(flaggedText("a", null, null), "");
});

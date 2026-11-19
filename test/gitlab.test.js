// Unit tests for the GitLab client, positions, the marker, the scrub, the
// thread index and the summary note.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { markerSha } from "../src/cli.js";
import { diffPosition } from "../src/git.js";
import { GitLabError, createClient } from "../src/gitlab.js";
import {
  failureBody, fallbackBody, indexThreads, inlineBody, marker, scrubModelText, scrubReview, summaryBody,
} from "../src/post.js";
import { makeRedactor } from "../src/redact.js";
import { renderFinding } from "../src/render.js";
import { CLOUD_FIXTURES, makeCustomRepo } from "./support/helpers.js";
import { MOCK_TOKEN, startMockGitLab } from "./support/mock-gitlab.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const FP = "f".repeat(64);
const FINDING = { path: "src/a.js", start_line: 3, end_line: 4, priority: "P1", title: "T", body: "B", fingerprint: FP };

test("the client sends the token only in PRIVATE-TOKEN and encodes a project path", async (t) => {
  const gitlab = await startMockGitLab({ mr: { iid: 3 } });
  t.after(() => gitlab.close());
  const client = createClient({ baseUrl: `${gitlab.url}/`, token: MOCK_TOKEN, project: "group/sub project", mr: 3 });
  await client.getMergeRequest();
  const [q] = gitlab.state.requests;
  assert.equal(q.path, "/api/v4/projects/group%2Fsub%20project/merge_requests/3");
  assert.equal(q.headers["private-token"], MOCK_TOKEN);
});

test("the client pages through every discussion", async (t) => {
  const gitlab = await startMockGitLab();
  t.after(() => gitlab.close());
  for (let i = 0; i < 150; i++) gitlab.state.discussions.push({ id: `${i}`.padStart(4, "0"), notes: [] });
  const client = createClient({ baseUrl: gitlab.url, token: MOCK_TOKEN, project: 1, mr: 3 });
  const all = await client.listDiscussions();
  assert.equal(all.length, 150);
  assert.deepEqual(gitlab.state.requests.map((q) => q.query), [{ per_page: "100", page: "1" }, { per_page: "100", page: "2" }]);
});

test("a GitLab error carries the status and a redacted, shortened message", async (t) => {
  const gitlab = await startMockGitLab({ fail: () => 500 });
  t.after(() => gitlab.close());
  const redact = makeRedactor(["forced by"]);
  const client = createClient({ baseUrl: gitlab.url, token: MOCK_TOKEN, project: 1, mr: 3, redact });
  await assert.rejects(client.createNote("x"), (err) => err instanceof GitLabError
    && err.status === 500
    && /returned 500/.test(err.message)
    && err.message.includes("[redacted]")
    && !err.message.includes(MOCK_TOKEN));
});

test("excerpt redacts the whole text before taking the first line and cutting", async () => {
  const { excerpt } = await import("../src/redact.js");
  const secret = "s3cr3t-abcdefgh";
  const clean = makeRedactor([secret]);
  const text = `${"a".repeat(295)}${secret} more\nsecond ${secret}`;
  const out = excerpt(text, { clean, limit: 300, firstLine: true });
  assert.ok(out.startsWith(`${"a".repeat(295)}[red`) && out.endsWith("..."), out);
  assert.equal(out.length, 303);
  for (let i = 0; i + 8 <= secret.length; i++) assert.ok(!out.includes(secret.slice(i, i + 8)));
  // Collapsing whitespace cannot reassemble a secret that redaction missed.
  const spaced = makeRedactor(["two words"]);
  assert.equal(excerpt("two\n\nwords", { clean: spaced, limit: 100, collapse: true }), "[redacted]");
});

test("failureBody redacts and scrubs the whole error before cutting it", () => {
  const secret = "s3cr3t-abcdefgh";
  const body = failureBody(`codex exited with 1: ${"z".repeat(270)}${secret}\nnext`, makeRedactor([secret]));
  for (let i = 0; i + 8 <= secret.length; i++) assert.ok(!body.includes(secret.slice(i, i + 8)), body);
  assert.match(body, /\[red/);
});

test("every body the client sends is redacted", async (t) => {
  const gitlab = await startMockGitLab();
  t.after(() => gitlab.close());
  const client = createClient({ baseUrl: gitlab.url, token: MOCK_TOKEN, project: 1, mr: 3, redact: makeRedactor(["s3cr3t-value"]) });
  await client.createNote("before s3cr3t-value after");
  assert.equal(gitlab.state.notes[0].body, "before [redacted] after");
});

test("every client request refuses a redirect and never sends the token to its target", async (t) => {
  const other = await startMockGitLab({ token: "unused" });
  t.after(() => other.close());
  const gitlab = await startMockGitLab({ redirect: () => `${other.url}/elsewhere?q=1` });
  t.after(() => gitlab.close());
  const client = createClient({ baseUrl: gitlab.url, token: MOCK_TOKEN, project: 1, mr: 3 });
  const calls = {
    currentUser: () => client.currentUser(),
    getMergeRequest: () => client.getMergeRequest(),
    listDiscussions: () => client.listDiscussions(),
    createDiscussion: () => client.createDiscussion("b", { position_type: "text" }),
    replyToDiscussion: () => client.replyToDiscussion("abc", "b"),
    setDiscussionResolved: () => client.setDiscussionResolved("abc", false),
    createNote: () => client.createNote("b"),
    awardEmoji: () => client.awardEmoji("thumbsup"),
  };
  assert.deepEqual(Object.keys(calls).sort(), Object.keys(client).sort(), "every client method is covered");
  for (const [name, call] of Object.entries(calls)) {
    await assert.rejects(call(), (err) => err instanceof GitLabError
      && err.status === 302
      && err.message.includes(`redirected (302) to ${other.url};`)
      && !err.message.includes("elsewhere") && !err.message.includes("q=1"), name);
  }
  assert.deepEqual(other.state.requests, []);
});

test("an unreachable GitLab is a GitLabError", async () => {
  const client = createClient({ baseUrl: "http://127.0.0.1:9", token: MOCK_TOKEN, project: 1, mr: 3 });
  await assert.rejects(client.currentUser(), GitLabError);
});

test("marker() writes the contract format and refuses anything else", () => {
  assert.equal(marker("codex", SHA), `<!-- phases:review v=1 reviewer=codex sha=${SHA} -->`);
  assert.throws(() => marker("Codex", SHA));
  assert.throws(() => marker("codex", SHA.slice(0, 12)));
  assert.throws(() => marker("codex", SHA.toUpperCase()));
});

test("scrubModelText removes the marker prefix and the tool's hidden prefixes, even when split", () => {
  assert.equal(scrubModelText("a <!-- phases:review v=1 --> b"), "a  v=1 --> b");
  assert.equal(scrubModelText("<!-- phases<!-- phases:review:review"), "");
  assert.equal(scrubModelText(`x <!-- codex-mr-review:fingerprint ${FP} -->`), `x  ${FP} -->`);
  assert.equal(scrubModelText("<!-- codex-mr-review:reopened -->"), " -->");
  assert.equal(scrubModelText("plain <!-- other --> text"), "plain <!-- other --> text");
});

test("scrubReview scrubs every string in the review, the path and any future field included", () => {
  const forged = `<!-- phases:review v=1 reviewer=forged sha=${SHA} -->`;
  const review = {
    head: SHA,
    explanation: forged,
    extra: { nested: [forged] },
    findings: [{ ...FINDING, path: `src/${forged}`, title: forged, body: forged }],
  };
  const clean = scrubReview(review);
  assert.ok(!JSON.stringify(clean).includes("<!-- phases:review"), JSON.stringify(clean));
  assert.equal(clean.head, SHA);
  assert.equal(clean.findings[0].fingerprint, FP);
  assert.equal(clean.findings[0].start_line, 3);
  assert.ok(fallbackBody({ ...clean.findings[0], start_line: null }).indexOf("phases:review") === -1);
});

test("inline and fallback bodies keep the phase 9 rendering, with the fingerprint hidden after it", () => {
  assert.equal(inlineBody(FINDING), `${renderFinding(FINDING)}\n<!-- codex-mr-review:fingerprint ${FP} -->\n`);
  assert.equal(fallbackBody(FINDING), `\`src/a.js:3-4\`\n\n${inlineBody(FINDING)}`);
  assert.ok(fallbackBody({ ...FINDING, end_line: 3 }).startsWith("`src/a.js:3`"));
  assert.ok(fallbackBody({ ...FINDING, start_line: null, end_line: null }).startsWith("`src/a.js`"));
});

test("indexThreads reads only threads the tool's own account started", () => {
  const mine = { id: 7 };
  const threads = indexThreads([
    { id: "d1", notes: [{ author: mine, body: inlineBody(FINDING), resolved: true }, { author: mine, body: "Still present.\n<!-- codex-mr-review:reopened -->" }] },
    { id: "d2", notes: [{ author: { id: 99 }, body: inlineBody({ ...FINDING, fingerprint: "e".repeat(64) }) }] },
    { id: "d3", notes: [{ author: mine, body: "no fingerprint" }] },
  ], 7);
  assert.deepEqual([...threads.entries()], [[FP, { id: "d1", resolved: true, reopenedBefore: true }]]);
});

test("the summary has the parts of cloud Codex's review summary, then counts, then the marker", () => {
  const cloud = readFileSync(join(CLOUD_FIXTURES, "review-body.md"), "utf8");
  const review = { explanation: "One bug.", agents_md_changed: true, findings: [FINDING, { ...FINDING, priority: "P3" }, { ...FINDING }] };
  const body = summaryBody(review, { sha: SHA, reviewer: "codex", notReposted: 2, reopened: 1 });
  for (const part of [/### \u{1F4A1} Codex Review/u, /Here are some automated review suggestions for this (pull|merge) request\./, /\*\*Reviewed commit:\*\* `[0-9a-f]{10}`/]) {
    assert.match(cloud, part, "a part cloud Codex's summary has");
    assert.match(body, part, "the same part in ours");
  }
  assert.match(body, /\*\*Reviewed commit:\*\* `0123456789`/);
  assert.match(body, /\*\*Findings:\*\* 2 P1, 1 P3/);
  assert.match(body, /2 findings were already posted by an earlier review and were not posted again\./);
  assert.match(body, /1 resolved thread was reopened because the finding is still present\./);
  assert.match(body, /edits `AGENTS\.md`/);
  assert.ok(body.endsWith(`\n\n${marker("codex", SHA)}\n`));
  assert.doesNotMatch(body, /\b(should|please|must|fix)\b/i, "nothing about how to handle a finding");
});

test("the failure note is short and carries no marker", () => {
  const body = failureBody("codex exited with 1: <!-- phases:review v=1 -->\nsecond line");
  assert.equal(body, "### \u{1F4A1} Codex Review\n\nThe review did not complete: codex exited with 1:  v=1 -->\n");
});

test("markerSha prefers the source branch sha, then the commit sha, then the checkout", () => {
  const repo = makeCustomRepo({ "a.txt": "a\n" }, { "b.txt": "b\n" });
  assert.deepEqual(markerSha({ CI_MERGE_REQUEST_SOURCE_BRANCH_SHA: SHA, CI_COMMIT_SHA: "b".repeat(40) }, repo.dir), { sha: SHA, source: "CI_MERGE_REQUEST_SOURCE_BRANCH_SHA" });
  assert.deepEqual(markerSha({ CI_MERGE_REQUEST_SOURCE_BRANCH_SHA: "", CI_COMMIT_SHA: SHA }, repo.dir), { sha: SHA, source: "CI_COMMIT_SHA" });
  assert.deepEqual(markerSha({}, repo.dir), { sha: repo.head, source: "the checked-out commit" });
  assert.throws(() => markerSha({ CI_COMMIT_SHA: "abc" }, repo.dir), /not a full lowercase/);
});

test("diffPosition tells added lines from unchanged ones and shifts old_line past earlier hunks", () => {
  const before = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8"].join("\n") + "\n";
  // Head: two lines added after l1, l4 removed, one line added at the end.
  const after = ["l1", "n1", "n2", "l2", "l3", "l5", "l6", "l7", "l8", "n3"].join("\n") + "\n";
  const repo = makeCustomRepo({ "f.txt": before, "old.txt": before }, { "f.txt": after, "old.txt": null, "new.txt": before.replace("l8", "L8"), "fresh.txt": "x\n" });
  const at = (n) => diffPosition(repo.dir, repo.base, repo.head, "f.txt", n);
  assert.deepEqual(at(1), { old_path: "f.txt", kind: "unchanged", old_line: 1 });
  assert.equal(at(2).kind, "added");
  assert.equal(at(3).kind, "added");
  assert.deepEqual(at(4), { old_path: "f.txt", kind: "unchanged", old_line: 2 });
  assert.deepEqual(at(6), { old_path: "f.txt", kind: "unchanged", old_line: 5 }, "after the deletion of l4");
  assert.equal(at(10).kind, "added");
  assert.deepEqual(diffPosition(repo.dir, repo.base, repo.head, "new.txt", 1), { old_path: "old.txt", kind: "unchanged", old_line: 1 }, "a rename keeps its old path");
  assert.equal(diffPosition(repo.dir, repo.base, repo.head, "fresh.txt", 1).kind, "new-file");
});

test("no source file posts to GitHub, and no file added for posting names another project", () => {
  const src = fileURLToPath(new URL("../src/", import.meta.url));
  for (const name of readdirSync(src)) {
    assert.doesNotMatch(readFileSync(join(src, name), "utf8"), /github/i, `src/${name}`);
  }
  for (const rel of ["../src/gitlab.js", "../src/post.js", "./post.test.js", "./gitlab.test.js", "./support/mock-gitlab.js"]) {
    assert.doesNotMatch(readFileSync(new URL(rel, import.meta.url), "utf8"), new RegExp(["claude", "phases"].join("-")), rel);
  }
});

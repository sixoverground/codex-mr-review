// End to end: the CLI posts to a local mock GitLab, with a fake codex
// replaying recorded output, against a real throwaway git repository.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readOutputSchema } from "../src/cli.js";
import { renderFinding } from "../src/render.js";
import { validate } from "../src/schema.js";
import { CODEX_FIXTURES, RECORDED_ROOT, makeFakeCodex, makeRepo, tempDir } from "./support/helpers.js";
import { MOCK_TOKEN, startMockGitLab } from "./support/mock-gitlab.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const COMPLETED = join(CODEX_FIXTURES, "review-planted-bug.events.jsonl");
const MARKER_RE = /<!-- phases:review v=1 reviewer=([a-z0-9-]+) sha=([0-9a-f]{40}) -->/g;
const DASH = "\u2014";

function runCli(args, { cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "review", ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function writeTemp(text) {
  const path = join(tempDir(), "file.txt");
  writeFileSync(path, text);
  return path;
}

function mrFor(repo) {
  return { iid: 3, sha: repo.head, diff_refs: { base_sha: repo.base, start_sha: repo.base, head_sha: repo.head } };
}

// Sets up a repository, a fake codex and a mock GitLab, and returns a
// function that runs the CLI against them.
async function setup({ scenario = {}, mock = {}, repo = makeRepo() } = {}) {
  const fake = makeFakeCodex(scenario);
  const gitlab = await startMockGitLab({ mr: mrFor(repo), ...mock });
  const run = (extraArgs = [], extraEnv = {}) => runCli(
    ["--base", repo.base, "--gitlab-url", gitlab.url, "--project", "group/scratch", "--mr", "3", ...extraArgs],
    {
      cwd: repo.dir,
      env: { PATH: `${fake.dir}:${process.env.PATH}`, HOME: process.env.HOME, TMPDIR: tempDir(), CODEX_MR_REVIEW_TOKEN: MOCK_TOKEN, ...extraEnv },
    },
  );
  return { repo, fake, gitlab, run };
}

function bodies(gitlab) {
  return gitlab.state.requests.map((r) => r.raw).join("\n");
}

function markers(text) {
  return [...text.matchAll(MARKER_RE)].map((m) => ({ reviewer: m[1], sha: m[2] }));
}

const RECORDED_FINDING = {
  priority: "P1",
  title: "Stop sumFirst after n elements",
  body: readFileSync(join(CODEX_FIXTURES, "review-planted-bug.last-message.txt"), "utf8").split("\n").at(-1).trim(),
};

test("an accepted inline position: exactly the expected requests, an inline thread, then the summary with the marker", async (t) => {
  const { repo, gitlab, run } = await setup();
  t.after(() => gitlab.close());
  const r = await run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(gitlab.calls(), [
    "GET /api/v4/user",
    "GET MR",
    "GET MR/discussions",
    "POST MR/discussions",
    "POST MR/notes",
  ]);
  const [thread] = gitlab.state.requests.filter((q) => q.method === "POST" && q.path.endsWith("/discussions"));
  assert.deepEqual(thread.body.position, {
    position_type: "text",
    base_sha: repo.base,
    start_sha: repo.base,
    head_sha: repo.head,
    new_path: "src/stats.js",
    old_path: "src/stats.js",
    new_line: 26,
  });
  // The body is the phase 9 rendering unchanged, then the hidden fingerprint.
  assert.ok(thread.body.body.startsWith(renderFinding(RECORDED_FINDING)), thread.body.body);
  assert.match(thread.body.body, /\n<!-- codex-mr-review:fingerprint [0-9a-f]{64} -->\n$/);
  assert.equal(gitlab.state.discussions[0].notes[0].resolvable, true);

  const summary = gitlab.state.notes[0].body;
  assert.match(summary, /^### \u{1F4A1} Codex Review\n\nHere are some automated review suggestions/u);
  assert.match(summary, /\*\*Reviewed commit:\*\* `[0-9a-f]{10}`/);
  assert.match(summary, /\*\*Findings:\*\* 1 P1/);
  assert.deepEqual(markers(summary), [{ reviewer: "codex", sha: repo.head }]);
  assert.ok(summary.trimEnd().endsWith(`<!-- phases:review v=1 reviewer=codex sha=${repo.head} -->`));
  assert.match(summary, /\n<!-- phases:review [^\n]+-->\n$/, "the marker is on its own last line");
  assert.doesNotMatch(r.stdout + r.stderr, /phases:review/);
});

test("--reviewer names the reviewer in the marker", async (t) => {
  const { repo, gitlab, run } = await setup();
  t.after(() => gitlab.close());
  const r = await run(["--reviewer", "codex-local"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(markers(gitlab.state.notes[0].body), [{ reviewer: "codex-local", sha: repo.head }]);
});

test("a rejected position falls back to a general thread citing path:line", async (t) => {
  const { gitlab, run } = await setup({ mock: { rejectPosition: () => true } });
  t.after(() => gitlab.close());
  const r = await run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(gitlab.calls(), [
    "GET /api/v4/user",
    "GET MR",
    "GET MR/discussions",
    "POST MR/discussions",
    "POST MR/discussions",
    "POST MR/notes",
  ]);
  const posts = gitlab.state.requests.filter((q) => q.method === "POST" && q.path.endsWith("/discussions"));
  assert.ok(posts[0].body.position);
  assert.equal(posts[1].body.position, undefined);
  assert.ok(posts[1].body.body.startsWith(`\`src/stats.js:26\`\n\n${renderFinding(RECORDED_FINDING)}`), posts[1].body.body);
  assert.equal(gitlab.state.discussions.length, 1);
  assert.equal(gitlab.state.discussions[0].notes[0].resolvable, true);
  assert.match(r.stderr, /rejected the position for src\/stats\.js:26 \(400\)/);
  assert.equal(markers(gitlab.state.notes[0].body).length, 1);
});

test("an unchanged line gets old_line as well as new_line", async (t) => {
  const msg = `Note.\n\nReview comment:\n\n- [P3] Mean of empty ${DASH} ${RECORDED_ROOT}/src/stats.js:10-10\n  Body.\n`;
  const { gitlab, run } = await setup({ scenario: { lastMessage: writeTemp(msg), events: COMPLETED } });
  t.after(() => gitlab.close());
  const r = await run();
  assert.equal(r.status, 0, r.stderr);
  const thread = gitlab.state.requests.find((q) => q.method === "POST" && q.path.endsWith("/discussions"));
  assert.equal(thread.body.position.new_line, 10);
  assert.equal(thread.body.position.old_line, 10);
});

test("a finding with no line range is posted as a general thread citing the path", async (t) => {
  const msg = `Note.\n\nReview comment:\n\n- [P2] Missing tests ${DASH} ${RECORDED_ROOT}/src/stats.js\n  Body.\n`;
  const { gitlab, run } = await setup({ scenario: { lastMessage: writeTemp(msg), events: COMPLETED } });
  t.after(() => gitlab.close());
  const r = await run();
  assert.equal(r.status, 0, r.stderr);
  const posts = gitlab.state.requests.filter((q) => q.method === "POST" && q.path.endsWith("/discussions"));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.position, undefined);
  assert.ok(posts[0].body.body.startsWith("`src/stats.js`\n\n"));
});

test("a merge request without diff_refs gets general threads", async (t) => {
  const repo = makeRepo();
  const { gitlab, run } = await setup({ repo, mock: { mr: { iid: 3, diff_refs: null } } });
  t.after(() => gitlab.close());
  const r = await run();
  assert.equal(r.status, 0, r.stderr);
  const posts = gitlab.state.requests.filter((q) => q.method === "POST" && q.path.endsWith("/discussions"));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.position, undefined);
});

for (const emoji of [true, false]) {
  test(`a clean review posts a summary with a marker and no threads${emoji ? ", and --clean-emoji adds a thumbs up" : ""}`, async (t) => {
    const { repo, gitlab, run } = await setup({ scenario: { lastMessage: writeTemp("The change looks correct.\n"), events: COMPLETED } });
    t.after(() => gitlab.close());
    const r = await run(emoji ? ["--clean-emoji"] : []);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(gitlab.calls(), [
      "GET /api/v4/user",
      "GET MR",
      "GET MR/discussions",
      "POST MR/notes",
      ...(emoji ? ["POST MR/award_emoji"] : []),
    ]);
    const summary = gitlab.state.notes[0].body;
    assert.match(summary, /Codex found no issues in this change\./);
    assert.match(summary, /\*\*Findings:\*\* none/);
    assert.deepEqual(markers(summary), [{ reviewer: "codex", sha: repo.head }]);
    assert.deepEqual(gitlab.state.awards, emoji ? ["thumbsup"] : []);
  });
}

test("--clean-emoji adds nothing when there are findings", async (t) => {
  const { gitlab, run } = await setup();
  t.after(() => gitlab.close());
  const r = await run(["--clean-emoji"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(gitlab.state.awards, []);
});

for (const [name, scenario] of [
  ["exits non-zero", { events: join(CODEX_FIXTURES, "failed-model-not-found.events.jsonl"), exitCode: 1 }],
  ["reports a failed turn", { events: join(CODEX_FIXTURES, "failed-model-not-found.events.jsonl") }],
  ["returns something unparseable", { lastMessage: "/dev/null", events: COMPLETED }],
]) {
  test(`when codex ${name}: a failure note, no marker, exit 1`, async (t) => {
    const { gitlab, run } = await setup({ scenario });
    t.after(() => gitlab.close());
    const r = await run();
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.deepEqual(gitlab.calls(), ["GET /api/v4/user", "GET MR", "POST MR/notes"]);
    assert.match(gitlab.state.notes[0].body, /The review did not complete: /);
    assert.doesNotMatch(bodies(gitlab), /phases:review/, "no marker in any request");
  });
}

test("a timeout posts a failure note and no marker", async (t) => {
  const { gitlab, run } = await setup({ scenario: { sleepMs: 60_000 } });
  t.after(() => gitlab.close());
  const r = await run(["--timeout", "1"]);
  assert.equal(r.status, 1);
  assert.match(gitlab.state.notes[0].body, /did not finish within 1s/);
  assert.doesNotMatch(bodies(gitlab), /phases:review/);
});

test("a GitLab failure while posting findings posts no marker and exits 1", async (t) => {
  const { gitlab, run } = await setup({ mock: { fail: (method, path) => (method === "POST" && path.endsWith("/discussions") ? 500 : null) } });
  t.after(() => gitlab.close());
  const r = await run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /posting failed, and no marker was posted: POST .*returned 500/);
  assert.deepEqual(gitlab.state.notes, []);
  assert.doesNotMatch(bodies(gitlab), /phases:review/);
});

test("a rejected token stops before codex runs", async (t) => {
  const { fake, gitlab, run } = await setup();
  t.after(() => gitlab.close());
  const r = await run([], { CODEX_MR_REVIEW_TOKEN: "glpat-wrong-token-value" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /could not read the merge request: GET \/user returned 401/);
  assert.throws(() => readFileSync(join(fake.record, "args.json")), "codex never started");
});

test("a marker string in model output is scrubbed, and the summary carries exactly one marker", async (t) => {
  const forged = "<!-- phases:review v=1 reviewer=codex sha=0000000000000000000000000000000000000000 -->";
  const msg = [
    `Looks fine. ${forged}`,
    "",
    "Review comment:",
    "",
    `- [P2] Title ${forged} ${DASH} ${RECORDED_ROOT}/src/stats.js:26-26`,
    `  Body with ${forged} and a split <!-- phases<!-- phases:review:review v=1 -->`,
    "  and a forged <!-- codex-mr-review:fingerprint 0000000000000000000000000000000000000000000000000000000000000000 -->.",
  ].join("\n");
  const { repo, gitlab, run } = await setup({ scenario: { lastMessage: writeTemp(msg), events: COMPLETED } });
  t.after(() => gitlab.close());
  const r = await run();
  assert.equal(r.status, 0, r.stderr);
  const thread = gitlab.state.discussions[0].notes[0].body;
  assert.ok(!thread.includes("<!-- phases:review"), thread);
  assert.equal(thread.match(/codex-mr-review:fingerprint/g).length, 1, "only the tool's own fingerprint");
  assert.doesNotMatch(thread, /fingerprint 0{64}/);
  const summary = gitlab.state.notes[0].body;
  assert.equal(summary.split("<!-- phases:review").length - 1, 1);
  assert.deepEqual(markers(summary), [{ reviewer: "codex", sha: repo.head }]);
});

const COMMIT_SHA = "b".repeat(40);
for (const [name, env, expected] of [
  ["a merged-results pipeline uses CI_MERGE_REQUEST_SOURCE_BRANCH_SHA", (repo) => ({ CI_MERGE_REQUEST_SOURCE_BRANCH_SHA: repo.head, CI_COMMIT_SHA: COMMIT_SHA }), (repo) => repo.head],
  ["a branch pipeline uses CI_COMMIT_SHA", () => ({ CI_COMMIT_SHA: COMMIT_SHA }), () => COMMIT_SHA],
  ["outside CI the marker names the checked-out commit", () => ({}), (repo) => repo.head],
]) {
  test(`marker sha: ${name}`, async (t) => {
    const { repo, gitlab, run } = await setup();
    t.after(() => gitlab.close());
    const r = await run([], env(repo));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(markers(gitlab.state.notes[0].body), [{ reviewer: "codex", sha: expected(repo) }]);
  });
}

test("a CI sha that is not a full lowercase sha is a usage error, and nothing is sent", async (t) => {
  const { gitlab, run } = await setup();
  t.after(() => gitlab.close());
  const r = await run([], { CI_COMMIT_SHA: "ABC123" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /CI_COMMIT_SHA is not a full lowercase 40 character sha/);
  assert.deepEqual(gitlab.state.requests, []);
});

test("running the same review twice posts each finding once", async (t) => {
  const { gitlab, run } = await setup();
  t.after(() => gitlab.close());
  assert.equal((await run()).status, 0);
  const second = await run();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(gitlab.state.discussions.length, 1);
  assert.equal(gitlab.state.notes.length, 2, "a summary per review");
  assert.match(gitlab.state.notes[1].body, /1 finding was already posted by an earlier review and was not posted again\./);
  assert.equal(markers(gitlab.state.notes[1].body).length, 1);
});

test("a finding on a resolved thread reopens it once, with one reply; after that it is only counted", async (t) => {
  const { repo, gitlab, run } = await setup();
  t.after(() => gitlab.close());
  assert.equal((await run()).status, 0);
  gitlab.resolveAll();

  const second = await run();
  assert.equal(second.status, 0, second.stderr);
  const [discussion] = gitlab.state.discussions;
  assert.equal(discussion.notes.length, 2);
  assert.match(discussion.notes[1].body, new RegExp(`^Still present at \`${repo.head}\`\\.`));
  assert.equal(discussion.notes[0].resolved, false, "reopened");
  const puts = gitlab.state.requests.filter((q) => q.method === "PUT");
  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0].body, { resolved: false });
  assert.match(gitlab.state.notes[1].body, /1 resolved thread was reopened because the finding is still present\./);

  gitlab.resolveAll();
  const third = await run();
  assert.equal(third.status, 0, third.stderr);
  assert.equal(discussion.notes.length, 2, "no second reply");
  assert.equal(discussion.notes[0].resolved, true, "not reopened again");
  assert.equal(gitlab.state.requests.filter((q) => q.method === "PUT").length, 1);
  assert.equal(gitlab.state.discussions.length, 1, "not posted again");
  assert.match(gitlab.state.notes[2].body, /1 finding was already posted by an earlier review/);
});

test("a fingerprint on a thread someone else started does not hide a finding", async (t) => {
  const { gitlab, run } = await setup();
  t.after(() => gitlab.close());
  assert.equal((await run()).status, 0);
  // The same thread, as if a person had posted it.
  gitlab.state.discussions[0].notes[0].author = { id: 99, username: "someone" };
  assert.equal((await run()).status, 0);
  assert.equal(gitlab.state.discussions.length, 2);
});

test("the token appears in no log line, URL or outbound body", async (t) => {
  const msg = `Leaked ${MOCK_TOKEN}.\n\nReview comment:\n\n- [P0] Token ${MOCK_TOKEN} ${DASH} ${RECORDED_ROOT}/src/stats.js:26-26\n  It is ${MOCK_TOKEN}.\n`;
  for (const scenario of [
    { lastMessage: writeTemp(msg), events: COMPLETED, stderr: `debug ${MOCK_TOKEN}\n` },
    { events: writeTemp(`{"type":"turn.failed","error":{"message":"bad key ${MOCK_TOKEN}"}}\n`), exitCode: 1, stderr: `ERROR token=${MOCK_TOKEN}\n` },
  ]) {
    const { gitlab, run } = await setup({ scenario });
    t.after(() => gitlab.close());
    const r = await run(["--format", "json"]);
    assert.ok(!r.stdout.includes(MOCK_TOKEN) && !r.stderr.includes(MOCK_TOKEN), "not in the log");
    for (const q of gitlab.state.requests) {
      assert.ok(!q.raw.includes(MOCK_TOKEN), `token in the body of ${q.method} ${q.path}`);
      assert.ok(!q.path.includes(MOCK_TOKEN) && !JSON.stringify(q.query).includes(MOCK_TOKEN), "token in a URL");
      assert.equal(q.headers["private-token"], MOCK_TOKEN, "only in the auth header");
    }
    assert.ok(bodies(gitlab).includes("[redacted]"), "the token was there to redact");
  }
});

test("--dry-run makes no network call, even with a full GitLab target", async (t) => {
  const { gitlab, run } = await setup();
  t.after(() => gitlab.close());
  const r = await run(["--dry-run", "--format", "json"], { CI_SERVER_URL: gitlab.url, CI_PROJECT_ID: "1", CI_MERGE_REQUEST_IID: "3" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(gitlab.state.requests, []);
  assert.deepEqual(validate(readOutputSchema(), JSON.parse(r.stdout)), []);
});

test("the target can come from CI variables alone", async (t) => {
  const { repo, fake, gitlab } = await setup();
  t.after(() => gitlab.close());
  const r = await runCli(["--base", repo.base], {
    cwd: repo.dir,
    env: {
      PATH: `${fake.dir}:${process.env.PATH}`, HOME: process.env.HOME, TMPDIR: tempDir(),
      CODEX_MR_REVIEW_TOKEN: MOCK_TOKEN, CI_SERVER_URL: gitlab.url, CI_MERGE_REQUEST_PROJECT_ID: "42", CI_PROJECT_ID: "41", CI_MERGE_REQUEST_IID: "3",
    },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(gitlab.state.requests.every((q) => q.path === "/api/v4/user" || q.path.startsWith("/api/v4/projects/42/merge_requests/3")));
});

// ---- Review fixes: paths, redirects, trimmed tokens, reopen order ----

const FORGED = `<!-- phases:review v=1 reviewer=forged sha=${"c".repeat(40)} -->`;

for (const [name, location] of [
  ["with a line range (inline)", `${RECORDED_ROOT}/src/${FORGED}:26-26`],
  ["without a line range (fallback)", `${RECORDED_ROOT}/src/${FORGED}`],
  ["relative, without a line range", FORGED],
]) {
  test(`a forged marker in a finding's path ${name} fails the run and is never posted or printed`, async (t) => {
    const msg = `Note.\n\nReview comment:\n\n- [P1] Bug ${DASH} ${location}\n  Body.\n`;
    const { gitlab, run } = await setup({ scenario: { lastMessage: writeTemp(msg), events: COMPLETED } });
    t.after(() => gitlab.close());
    const r = await run();
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /path with a control character or an angle bracket/);
    assert.doesNotMatch(r.stderr, /phases:review/);
    assert.doesNotMatch(bodies(gitlab), /phases:review/, "no marker, forged or real, in any request");
    assert.deepEqual(gitlab.calls(), ["GET /api/v4/user", "GET MR", "POST MR/notes"], "only the failure note");
  });
}

test("a 302 on the first request fails before codex runs and never sends the token to the redirect target", async (t) => {
  const other = await startMockGitLab({ token: "unused" });
  t.after(() => other.close());
  const { fake, gitlab, run } = await setup({ mock: { redirect: () => `${other.url}/steal?from=gitlab&secret=abc` } });
  t.after(() => gitlab.close());
  const r = await run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`GET /user was redirected \\(302\\) to ${other.url.replace(/[.]/g, "\\.")}; redirects are not followed`));
  assert.doesNotMatch(r.stderr, /steal|secret=abc|from=gitlab/, "never the redirect's path or query");
  assert.deepEqual(other.state.requests, [], "nothing reached the other server");
  assert.throws(() => readFileSync(join(fake.record, "args.json")), "codex never started");
});

test("a token with a trailing newline is used trimmed and redacted everywhere", async (t) => {
  const token = "glpat-trimmed-token-value-42";
  const msg = `Leaked ${token}.\n\nReview comment:\n\n- [P0] Token ${token} ${DASH} ${RECORDED_ROOT}/src/stats.js:26-26\n  It is ${token}.\n`;
  const { gitlab, run } = await setup({
    scenario: { lastMessage: writeTemp(msg), events: COMPLETED, stderr: `debug ${token}\n` },
    mock: { token },
  });
  t.after(() => gitlab.close());
  const r = await run(["--format", "json"], { CODEX_MR_REVIEW_TOKEN: `${token}\n` });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes(token) && !r.stderr.includes(token), "not in the log");
  for (const q of gitlab.state.requests) {
    assert.ok(!q.raw.includes(token), `token in the body of ${q.method} ${q.path}`);
    assert.equal(q.headers["private-token"], token, "sent trimmed, in the header only");
  }
  assert.ok(bodies(gitlab).includes("[redacted]"));
  assert.match(JSON.parse(r.stdout).findings[0].title, /\[redacted\]/);
});

test("a failed reopen leaves no sentinel, and the next run reopens and replies exactly once", async (t) => {
  let failPut = false;
  const { gitlab, run } = await setup({ mock: { fail: (method) => (failPut && method === "PUT" ? 500 : null) } });
  t.after(() => gitlab.close());
  assert.equal((await run()).status, 0);
  gitlab.resolveAll();

  failPut = true;
  const failed = await run();
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /posting failed, and no marker was posted: PUT .*returned 500/);
  const [discussion] = gitlab.state.discussions;
  assert.equal(discussion.notes.length, 1, "no reply, so no sentinel");
  assert.equal(gitlab.state.notes.length, 1, "no summary for the failed run");

  failPut = false;
  const retried = await run();
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(discussion.notes.length, 2, "one reply");
  assert.match(discussion.notes[1].body, /^Still present at /);
  assert.equal(discussion.notes[0].resolved, false, "reopened");
  const order = gitlab.calls().slice(-4);
  assert.deepEqual(order, ["GET MR/discussions", "PUT MR/discussions/" + discussion.id, "POST MR/discussions/" + discussion.id + "/notes", "POST MR/notes"]);
});

// ---- Redact before any cut; validate before any write ----

// A token with no common substrings, so any 8 characters of it found in
// the output can only have come from the token.
const CUT_TOKEN = "glpat-Zq8vK2mN7xR4tY1wB6cLp3Hs";

function assertNoTokenPiece(text, where) {
  for (let i = 0; i + 8 <= CUT_TOKEN.length; i++) {
    const piece = CUT_TOKEN.slice(i, i + 8);
    assert.ok(!text.includes(piece), `${where} holds "${piece}", part of the token`);
  }
}

function assertNoTokenAnywhere(r, gitlab) {
  assertNoTokenPiece(r.stdout, "stdout");
  assertNoTokenPiece(r.stderr, "stderr");
  for (const q of gitlab.state.requests) assertNoTokenPiece(q.raw + q.path + JSON.stringify(q.query), `${q.method} ${q.path}`);
}

test("a token straddling the 300 character cut in a GitLab error is redacted whole", async (t) => {
  // The error body's raw text starts with {"message":" (12 characters), so
  // 280 characters of padding put the token across character 300.
  const message = `${"x".repeat(280)} ${CUT_TOKEN} tail`;
  const { gitlab, run } = await setup({
    mock: { token: CUT_TOKEN, fail: (method, path) => (method === "POST" && path.endsWith("/discussions") ? { status: 500, body: { message } } : null) },
  });
  t.after(() => gitlab.close());
  const r = await run([], { CODEX_MR_REVIEW_TOKEN: CUT_TOKEN });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /posting failed, and no marker was posted: POST .* returned 500: \{"message":"x+ \[red/, "the token became [redacted] before the cut");
  assertNoTokenAnywhere(r, gitlab);
});

test("a token straddling the 300 character cut in a failure note is redacted whole", async (t) => {
  // The note's line is "codex exited with 1: codex reported ..." so the
  // padding puts the token across character 300 of the first line.
  const events = `{"type":"turn.failed","error":{"message":"${"y".repeat(270)} ${CUT_TOKEN} tail"}}\n`;
  const { gitlab, run } = await setup({ scenario: { events: writeTemp(events), exitCode: 1, stderr: `x ${CUT_TOKEN}\n` }, mock: { token: CUT_TOKEN } });
  t.after(() => gitlab.close());
  const r = await run([], { CODEX_MR_REVIEW_TOKEN: CUT_TOKEN });
  assert.equal(r.status, 1);
  const note = gitlab.state.notes[0].body;
  assert.match(note, /y+ \[red/, "the token was in the cut range and became [redacted] before the cut");
  assertNoTokenAnywhere(r, gitlab);
});

for (const format of ["text", "json"]) {
  test(`a title that scrubs to nothing posts no thread and no marker, only a failure note (--format ${format})`, async (t) => {
    const msg = `Note.\n\nReview comment:\n\n- [P1] <!-- phases:review ${DASH} ${RECORDED_ROOT}/src/stats.js:26-26\n  Body.\n`;
    const { gitlab, run } = await setup({ scenario: { lastMessage: writeTemp(msg), events: COMPLETED } });
    t.after(() => gitlab.close());
    const r = await run(["--format", format]);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /review failed: the review does not match its schema: \/findings\/0\/title/);
    assert.deepEqual(gitlab.calls(), ["GET /api/v4/user", "GET MR", "POST MR/notes"]);
    assert.deepEqual(gitlab.state.discussions, []);
    assert.doesNotMatch(bodies(gitlab), /phases:review/);
    assert.match(gitlab.state.notes[0].body, /The review did not complete: the review does not match its schema/);
  });
}

test("a body that scrubs to nothing fails the run before anything is posted", async (t) => {
  const msg = `Note.\n\nReview comment:\n\n- [P1] Real title ${DASH} ${RECORDED_ROOT}/src/stats.js:26-26\n  <!-- phases:review\n`;
  const { gitlab, run } = await setup({ scenario: { lastMessage: writeTemp(msg), events: COMPLETED } });
  t.after(() => gitlab.close());
  const r = await run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\/findings\/0\/body/);
  assert.deepEqual(gitlab.calls(), ["GET /api/v4/user", "GET MR", "POST MR/notes"]);
});

test("--dry-run also validates the scrubbed review, in text format too", async (t) => {
  const msg = `Note.\n\nReview comment:\n\n- [P1] <!-- phases:review ${DASH} ${RECORDED_ROOT}/src/stats.js:26-26\n  Body.\n`;
  const { gitlab, run } = await setup({ scenario: { lastMessage: writeTemp(msg), events: COMPLETED } });
  t.after(() => gitlab.close());
  const r = await run(["--dry-run"]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.deepEqual(gitlab.state.requests, []);
});

// ---- Positions and the marker only against the reviewed commit ----

// Adds a commit on top of the repository's head, as a push after the
// review started would, and returns its sha.
function commitOnTop(repo) {
  const git = (...args) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: repo.dir, encoding: "utf8" }).trim();
  writeFileSync(join(repo.dir, "later.txt"), "a later push\n");
  git("add", "-A");
  git("commit", "-q", "-m", "Later");
  return git("rev-parse", "HEAD");
}

function discussionPosts(gitlab) {
  return gitlab.state.requests.filter((q) => q.method === "POST" && /\/discussions$/.test(q.path));
}

test("a newer head in diff_refs sends no position and posts general threads citing path:line", async (t) => {
  const repo = makeRepo();
  const newer = "d".repeat(40);
  const { gitlab, run } = await setup({ repo, mock: { mr: { iid: 3, diff_refs: { base_sha: repo.base, start_sha: repo.base, head_sha: newer } } } });
  t.after(() => gitlab.close());
  const r = await run();
  assert.equal(r.status, 0, r.stderr);
  const posts = discussionPosts(gitlab);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.position, undefined, "no position against another head");
  assert.ok(posts[0].body.body.startsWith(`\`src/stats.js:26\`\n\n${renderFinding(RECORDED_FINDING)}`));
  assert.match(r.stderr, new RegExp(`the merge request head is ${newer.slice(0, 10)} but the review is of ${repo.head.slice(0, 10)}; findings are posted as general threads`));
  assert.deepEqual(markers(gitlab.state.notes[0].body), [{ reviewer: "codex", sha: repo.head }]);
});

test("with diff_refs at the reviewed head, positions are still sent", async (t) => {
  const repo = makeRepo();
  const { gitlab, run } = await setup({ repo });
  t.after(() => gitlab.close());
  const r = await run();
  assert.equal(r.status, 0, r.stderr);
  const [post] = discussionPosts(gitlab);
  assert.equal(post.body.position.head_sha, repo.head);
  assert.equal(post.body.position.new_line, 26);
  assert.doesNotMatch(r.stderr, /findings are posted as general threads/);
});

test("an explicit --head older than the pipeline's commit posts the findings, no marker, and exits 1", async (t) => {
  const repo = makeRepo();
  const reviewed = repo.head;
  const pipeline = commitOnTop(repo);
  const { gitlab, run } = await setup({ repo, mock: { mr: { iid: 3, diff_refs: { base_sha: repo.base, start_sha: repo.base, head_sha: pipeline } } } });
  t.after(() => gitlab.close());
  const r = await run(["--head", reviewed]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`--head is ${reviewed.slice(0, 10)} but the pipeline's commit is ${pipeline.slice(0, 10)} \\(from the checked-out commit\\); no marker will be posted`));
  assert.equal(discussionPosts(gitlab).length, 1, "the findings are still posted");
  assert.equal(discussionPosts(gitlab)[0].body.position, undefined, "as general threads: diff_refs are at another head");
  assert.doesNotMatch(bodies(gitlab), /phases:review/, "no marker anywhere");
  const summary = gitlab.state.notes[0].body;
  assert.match(summary, new RegExp(`No review marker was posted: the reviewed commit \`${reviewed.slice(0, 10)}\` is not the pipeline's commit \`${pipeline.slice(0, 10)}\``));
  assert.match(summary, new RegExp(`\\*\\*Reviewed commit:\\*\\* \`${reviewed.slice(0, 10)}\``));
});

test("an explicit --head that is the pipeline's commit posts the marker as usual", async (t) => {
  const repo = makeRepo();
  const { gitlab, run } = await setup({ repo });
  t.after(() => gitlab.close());
  const r = await run(["--head", repo.head]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(markers(gitlab.state.notes[0].body), [{ reviewer: "codex", sha: repo.head }]);
});

test("without --head, a marker sha that differs from the reviewed tree still posts the marker, with only a warning", async (t) => {
  const repo = makeRepo();
  const source = "e".repeat(40);
  const { gitlab, run } = await setup({ repo });
  t.after(() => gitlab.close());
  const r = await run([], { CI_COMMIT_SHA: source });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, new RegExp(`warning: the marker names ${source} \\(from CI_COMMIT_SHA\\) but the reviewed tree is ${repo.head}`));
  assert.doesNotMatch(r.stderr, /no marker will be posted/);
  assert.deepEqual(markers(gitlab.state.notes[0].body), [{ reviewer: "codex", sha: source }]);
  assert.ok(discussionPosts(gitlab)[0].body.position, "diff_refs match the reviewed tree, so the position is sent");
});

test("in a merged-results pipeline the source branch head is reviewed, so positions match diff_refs", async (t) => {
  const repo = makeRepo();
  // Check out a merge commit, as a merged-results pipeline does: the target
  // gains a commit, and the pipeline's HEAD merges the source into it.
  const git = (...args) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: repo.dir, encoding: "utf8" }).trim();
  git("checkout", "-q", "main");
  writeFileSync(join(repo.dir, "target.txt"), "a commit on the target\n");
  git("add", "-A");
  git("commit", "-q", "-m", "Target moves");
  git("merge", "-q", "--no-ff", "-m", "Merged result", "feature");
  const mergeCommit = git("rev-parse", "HEAD");
  const { gitlab, fake } = await setup({ repo });
  t.after(() => gitlab.close());
  const r = await runCli(["--gitlab-url", gitlab.url, "--project", "group/scratch", "--mr", "3"], {
    cwd: repo.dir,
    env: {
      PATH: `${fake.dir}:${process.env.PATH}`, HOME: process.env.HOME, TMPDIR: tempDir(), CODEX_MR_REVIEW_TOKEN: MOCK_TOKEN,
      CI_MERGE_REQUEST_SOURCE_BRANCH_SHA: repo.head, CI_MERGE_REQUEST_DIFF_BASE_SHA: repo.base, CI_COMMIT_SHA: mergeCommit,
    },
  });
  assert.equal(r.status, 0, r.stderr);
  const args = JSON.parse(readFileSync(join(fake.record, "args.json"), "utf8"));
  assert.equal(args.at(-1), repo.base, "the base came from CI_MERGE_REQUEST_DIFF_BASE_SHA");
  const [post] = discussionPosts(gitlab);
  assert.equal(post.body.position.head_sha, repo.head, "an inline position, not a general thread");
  assert.doesNotMatch(r.stderr, /general threads|warning: the marker names/);
  assert.deepEqual(markers(gitlab.state.notes[0].body), [{ reviewer: "codex", sha: repo.head }]);
});

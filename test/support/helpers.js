// Shared test helpers: throwaway git repositories and a fake codex.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
export const CODEX_FIXTURES = join(FIXTURES, "codex-0.147.0");
export const CLOUD_FIXTURES = join(FIXTURES, "cloud-codex");
const FAKE = fileURLToPath(new URL("./fake-codex.js", import.meta.url));

// The worktree path inside the recorded real run; the fake swaps it for its
// own working directory.
export const RECORDED_ROOT = "/private/tmp/codex-mr-review-YF5anb/worktree";

export function tempDir(prefix = "cmr-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export const BASE_STATS = `// Small statistics helpers.

export function sum(values) {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

export function mean(values) {
  if (values.length === 0) return 0;
  return sum(values) / values.length;
}
`;

export const FEATURE_STATS = `${BASE_STATS}
// Returns the largest value in the array, or undefined when it is empty.
export function max(values) {
  let best = values[0];
  for (let i = 1; i <= values.length; i++) {
    if (values[i] > best) best = values[i];
  }
  return best;
}

// Returns the sum of the first n values.
export function sumFirst(values, n) {
  let total = 0;
  for (let i = 0; i <= n; i++) {
    total += values[i];
  }
  return total;
}
`;

// The same repository the real run used: a main commit and a feature
// branch that adds sumFirst() with an off-by-one bound, so the recorded
// finding at src/stats.js:26 lands on the same line.
// headAgents: text for the head's AGENTS.md, or undefined to leave it.
// headOverride: text for an AGENTS.override.md added on the head.
export function makeRepo({ baseAgents = "# Base guidance\n", headAgents, headOverride } = {}) {
  const dir = tempDir("cmr-repo-");
  git(dir, "init", "-q", "-b", "main");
  mkdirSync(join(dir, "src"));
  if (baseAgents !== null) writeFileSync(join(dir, "AGENTS.md"), baseAgents);
  writeFileSync(join(dir, "src", "stats.js"), BASE_STATS);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Add stats helpers");
  const base = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, "src", "stats.js"), FEATURE_STATS);
  if (headAgents !== undefined) writeFileSync(join(dir, "AGENTS.md"), headAgents);
  if (headOverride !== undefined) writeFileSync(join(dir, "AGENTS.override.md"), headOverride);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Add max and sumFirst");
  const head = git(dir, "rev-parse", "HEAD");
  return { dir, base, head };
}

export function worktreeCount(repo) {
  return git(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length;
}

// Writes a scenario and an executable named codex that runs the fake with
// it. Returns the directory to put first on PATH, the executable's path
// and the directory the fake records into.
export function makeFakeCodex(scenario = {}) {
  const dir = tempDir("cmr-fake-");
  const record = join(dir, "record");
  mkdirSync(record);
  const full = {
    events: join(CODEX_FIXTURES, "review-planted-bug.events.jsonl"),
    lastMessage: join(CODEX_FIXTURES, "review-planted-bug.last-message.txt"),
    recordedRoot: RECORDED_ROOT,
    record,
    ...scenario,
  };
  const scenarioPath = join(dir, "scenario.json");
  writeFileSync(scenarioPath, JSON.stringify(full));
  const bin = join(dir, "codex");
  const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
  writeFileSync(bin, `#!/bin/sh\nexec ${q(process.execPath)} ${q(FAKE)} ${q(scenarioPath)} "$@"\n`);
  chmodSync(bin, 0o755);
  return { dir, bin, record };
}

function applyFiles(dir, files) {
  for (const [path, value] of Object.entries(files)) {
    const full = join(dir, path);
    rmSync(full, { recursive: true, force: true });
    if (value === null) continue;
    mkdirSync(dirname(full), { recursive: true });
    if (typeof value === "string") writeFileSync(full, value);
    else symlinkSync(value.symlink, full);
  }
}

// A repository with a base commit on main and a head commit on feature.
// baseFiles and headChanges map a path to its text, to { symlink: target },
// or (in headChanges) to null to delete it.
export function makeCustomRepo(baseFiles, headChanges) {
  const dir = tempDir("cmr-repo-");
  git(dir, "init", "-q", "-b", "main");
  applyFiles(dir, baseFiles);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", "Base");
  const base = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "-b", "feature");
  applyFiles(dir, headChanges);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", "Head");
  const head = git(dir, "rev-parse", "HEAD");
  return { dir, base, head };
}

// True while a process with this pid exists.
export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// The few git operations the review runner needs, run synchronously.

import { execFileSync, spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The files Codex reads its review guidance from at the root of a checkout.
// Both are reset to the base commit's copy in the reviewed worktree.
export const GUIDANCE_FILES = Object.freeze(["AGENTS.md", "AGENTS.override.md"]);

export class GitError extends Error {}

function git(args, cwd, { encoding = "utf8" } = {}) {
  try {
    return execFileSync("git", args, { cwd, encoding, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const detail = err.stderr ? String(err.stderr).trim() : err.message;
    throw new GitError(`git ${args[0]} failed: ${detail}`);
  }
}

export function repoRoot(cwd) {
  return git(["rev-parse", "--show-toplevel"], cwd).trim();
}

export function resolveCommit(cwd, ref) {
  try {
    return git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd).trim();
  } catch {
    throw new GitError(`"${ref}" is not a commit in this repository`);
  }
}

export function mergeBase(cwd, a, b) {
  try {
    return git(["merge-base", a, b], cwd).trim();
  } catch {
    throw new GitError(`no merge base between ${a.slice(0, 12)} and ${b.slice(0, 12)}`);
  }
}

function blobExists(cwd, commit, path) {
  const r = spawnSync("git", ["cat-file", "-e", `${commit}:${path}`], { cwd, stdio: "ignore" });
  return r.status === 0;
}

// True when the head changed any guidance file since it left the base.
export function headChangedGuidance(cwd, base, head) {
  const from = mergeBase(cwd, base, head);
  const r = spawnSync("git", ["diff", "--quiet", from, head, "--", ...GUIDANCE_FILES], { cwd, stdio: "ignore" });
  if (r.status === 0) return false;
  if (r.status === 1) return true;
  throw new GitError("git diff failed while checking AGENTS.md");
}

export function addWorktree(cwd, dir, commit) {
  git(["worktree", "add", "--detach", "--quiet", dir, commit], cwd);
}

// Makes every guidance file in the worktree the base commit's copy, or
// removes it when the base has none.
export function useBaseGuidance(cwd, worktree, base) {
  for (const name of GUIDANCE_FILES) {
    const target = join(worktree, name);
    if (blobExists(cwd, base, name)) {
      writeFileSync(target, git(["show", `${base}:${name}`], cwd, { encoding: "buffer" }));
    } else {
      rmSync(target, { force: true });
    }
  }
}

// Best effort: never throws, so it is safe in a finally block.
export function removeWorktree(cwd, dir) {
  spawnSync("git", ["worktree", "remove", "--force", dir], { cwd, stdio: "ignore" });
  rmSync(dir, { recursive: true, force: true });
  spawnSync("git", ["worktree", "prune"], { cwd, stdio: "ignore" });
}

// A file's text at a commit, or null when it does not exist there.
export function readAtCommit(cwd, commit, path) {
  if (!blobExists(cwd, commit, path)) return null;
  return git(["show", `${commit}:${path}`], cwd);
}

// The few git operations the review runner needs, run synchronously.

import {
  lstatSync, mkdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join, posix, sep } from "node:path";

import { ExecError, runSync } from "./exec.js";

// Codex reads review guidance from files with these names, at the root and
// in any directory down to the one it works in. Every one of them, at any
// depth, is reset to the base commit's copy in the reviewed worktree.
export const GUIDANCE_NAMES = Object.freeze(["AGENTS.md", "AGENTS.override.md"]);

const SYMLINK_MODE = "120000";

export class GitError extends Error {}

function git(args, cwd, { encoding = "utf8" } = {}) {
  let r;
  try {
    r = runSync("git", args, { cwd, encoding });
  } catch (err) {
    if (err instanceof ExecError) throw new GitError(err.message);
    throw err;
  }
  if (r.status !== 0) {
    throw new GitError(`git ${args[0]} failed: ${String(r.stderr).trim() || `exit ${r.status}`}`);
  }
  return r.stdout;
}

// Like git, but returns the exit status instead of throwing on a non-zero
// one. Used where the status is the answer.
function gitStatus(args, cwd) {
  try {
    return runSync("git", args, { cwd }).status;
  } catch (err) {
    if (err instanceof ExecError) throw new GitError(err.message);
    throw err;
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
  return gitStatus(["cat-file", "-e", `${commit}:${path}`], cwd) === 0;
}

export function isGuidancePath(path) {
  return GUIDANCE_NAMES.includes(posix.basename(path));
}

// Every guidance file in a commit's tree, at any depth, as a Map from its
// path to { mode, object }. Symlinks are included; they are entries too.
export function guidanceEntries(cwd, commit) {
  const out = git(["ls-tree", "-r", "-z", "--full-tree", commit], cwd);
  const entries = new Map();
  for (const record of out.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    const [mode, type, object] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (type !== "blob" || !isGuidancePath(path)) continue;
    entries.set(path, { mode, object });
  }
  return entries;
}

// True when the head added, edited or deleted any guidance file, at any
// depth, since it left the base.
export function headChangedGuidance(cwd, base, head) {
  const from = mergeBase(cwd, base, head);
  const paths = new Set([...guidanceEntries(cwd, from).keys(), ...guidanceEntries(cwd, head).keys()]);
  if (paths.size === 0) return false;
  const status = gitStatus(["diff", "--quiet", from, head, "--", ...[...paths].map((p) => `:(literal)${p}`)], cwd);
  if (status === 0) return false;
  if (status === 1) return true;
  throw new GitError("git diff failed while checking AGENTS.md");
}

export function addWorktree(cwd, dir, commit) {
  git(["worktree", "add", "--detach", "--quiet", dir, commit], cwd);
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

function inside(root, path) {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

// Walks to the parent directory of rel inside root without following any
// symlink. Returns the parent's path, or null when a directory on the way
// is missing and create is false. Throws GitError when a component is a
// symlink or not a directory, or when the parent resolves outside root.
function safeParent(root, rel, { create }) {
  const parts = rel.split("/");
  let dir = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (part === "" || part === "." || part === "..") throw new GitError(`unsafe guidance path ${rel}`);
    dir = join(dir, part);
    const st = lstatOrNull(dir);
    if (st === null) {
      if (!create) return null;
      mkdirSync(dir);
      continue;
    }
    if (st.isSymbolicLink()) {
      throw new GitError(`refusing to touch ${rel}: ${parts.slice(0, i + 1).join("/")} is a symlink in the reviewed tree`);
    }
    if (!st.isDirectory()) throw new GitError(`refusing to touch ${rel}: a parent is not a directory`);
  }
  if (!inside(root, realpathSync(dir))) throw new GitError(`refusing to touch ${rel}: it resolves outside the worktree`);
  return dir;
}

// Removes whatever is at path without following it.
function unlinkEntry(path) {
  const st = lstatOrNull(path);
  if (st === null) return;
  if (st.isDirectory()) rmSync(path, { recursive: true, force: true });
  else unlinkSync(path);
}

// Makes every guidance path in the worktree the base commit's copy, or
// removes it when the base has none. Covers every guidance file the base
// or the head has, at any depth, so the head can neither add, edit nor
// delete one. Never follows a symlink the head controls.
export function useBaseGuidance(cwd, worktree, base, head) {
  const root = realpathSync(worktree);
  const baseEntries = guidanceEntries(cwd, base);
  const paths = new Set([...baseEntries.keys(), ...guidanceEntries(cwd, head).keys()]);
  for (const rel of [...paths].sort()) {
    const entry = baseEntries.get(rel);
    const parent = safeParent(root, rel, { create: entry !== undefined });
    if (parent === null) continue;
    const target = join(parent, posix.basename(rel));
    unlinkEntry(target);
    if (entry === undefined) continue;
    const content = git(["cat-file", "blob", entry.object], cwd, { encoding: "buffer" });
    if (entry.mode === SYMLINK_MODE) {
      // The base is trusted: recreate its symlink as it was.
      symlinkSync(content.toString("utf8"), target);
    } else {
      // "wx" fails rather than follows if anything appeared at target.
      writeFileSync(target, content, { flag: "wx" });
    }
  }
}

// Best effort: never throws, so it is safe in a finally block.
export function removeWorktree(cwd, dir) {
  try { gitStatus(["worktree", "remove", "--force", dir], cwd); } catch { /* fall through to rm */ }
  rmSync(dir, { recursive: true, force: true });
  try { gitStatus(["worktree", "prune"], cwd); } catch { /* best effort */ }
}

// A file's text at a commit, or null when it does not exist there.
export function readAtCommit(cwd, commit, path) {
  if (!blobExists(cwd, commit, path)) return null;
  return git(["show", `${commit}:${path}`], cwd);
}

// The review runner: a temporary checkout of the head commit (a local
// clone with its own, credential-free git config) with the base
// commit's guidance files (every AGENTS.md and AGENTS.override.md), one
// `codex exec review` in it, and the findings it returned. Nothing here
// touches the network itself.
//
// Everything codex returns is redacted with the caller's redactor as soon
// as it is read, so findings and error messages built from it never hold a
// secret, whole or in part. The CLI redacts again wherever it writes.

import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildChildEnv } from "./env.js";
import {
  CodexOutputError, DEFAULT_REASONING_EFFORT, TESTED_CODEX, codexVersion, isTestedVersion, parseEvents, parseReviewText, reviewArgs, runCodex,
} from "./codex.js";
import { FindingError, normaliseFinding } from "./findings.js";
import {
  GitError, addReviewCheckout, headChangedGuidance, readAtCommit, removeReviewCheckout, repoRoot, resolveCommit, useBaseGuidance,
} from "./git.js";

const STDERR_TAIL_LINES = 20;

function tail(text, lines = STDERR_TAIL_LINES) {
  const all = text.trimEnd().split("\n");
  return all.slice(-lines).join("\n");
}

// The global guidance file Codex reads from its home, if it holds any
// text. Codex loads it even with --ignore-user-config (checked against
// codex-cli 0.147.0; see SECURITY.md). Codex uses the first non-empty of
// AGENTS.override.md and AGENTS.md.
export function globalGuidance(childEnv) {
  const home = childEnv.CODEX_HOME || (childEnv.HOME ? join(childEnv.HOME, ".codex") : null);
  if (!home) return null;
  for (const name of ["AGENTS.override.md", "AGENTS.md"]) {
    const path = join(home, name);
    const text = readOrNull(path);
    if (text !== null && text.trim() !== "") return path;
  }
  return null;
}

function readOrNull(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// Returns { ok: true, review } or { ok: false, error }. Never throws for an
// expected failure. The worktree is removed on every path.
export async function runReview({
  base,
  head = "HEAD",
  timeoutSeconds,
  model = null,
  reasoningEffort = DEFAULT_REASONING_EFFORT,
  cwd = process.cwd(),
  env = process.env,
  codexBin = "codex",
  signal,
  warn = () => {},
  redact = (s) => s,
}) {
  const childEnv = buildChildEnv(env);
  let root;
  let baseSha;
  let headSha;
  let agentsChanged;
  let version;
  try {
    root = repoRoot(cwd);
    baseSha = resolveCommit(root, base);
    headSha = resolveCommit(root, head);
    agentsChanged = headChangedGuidance(root, baseSha, headSha);
    version = codexVersion(codexBin, childEnv);
  } catch (err) {
    if (err instanceof GitError || err instanceof CodexOutputError) return { ok: false, error: err.message };
    throw err;
  }
  const global = globalGuidance(childEnv);
  if (global) {
    warn(`Codex will also read the runner's global guidance in ${global}, which is not from the merge request but changes the review. Empty it, or give the runner its own CODEX_HOME.`);
  }
  if (!isTestedVersion(version)) {
    warn(`Codex CLI ${version} has not been tested with this tool (tested: ${TESTED_CODEX.label}). Its output may not parse.`);
  }

  const scratch = mkdtempSync(join(tmpdir(), "codex-mr-review-"));
  const worktree = join(scratch, "worktree");
  const lastMessagePath = join(scratch, "last-message.txt");
  try {
    addReviewCheckout(root, worktree, headSha);
    useBaseGuidance(root, worktree, baseSha, headSha);

    const raw = await runCodex({
      bin: codexBin,
      args: reviewArgs({ baseSha, lastMessagePath, model, reasoningEffort }),
      cwd: worktree,
      env: childEnv,
      timeoutMs: timeoutSeconds * 1000,
      signal,
    });
    // Redact everything codex returned, whole, before any parsing, line
    // selection or cut, so no later step can split a secret.
    const run = { ...raw, stdout: redact(raw.stdout), stderr: redact(raw.stderr) };
    if (run.spawnError) return { ok: false, error: `could not start ${codexBin}: ${run.spawnError.message}` };
    if (run.aborted) return { ok: false, error: "review was interrupted" };
    if (run.timedOut) return { ok: false, error: `codex did not finish within ${timeoutSeconds}s` };
    if (run.code !== 0) {
      let reason = "";
      try {
        const failure = parseEvents(run.stdout).failure;
        if (failure) reason = `: ${failure}`;
      } catch { /* the exit code is the failure; the stream is secondary */ }
      const how = run.code === null ? `was stopped by ${run.signal}` : `exited with ${run.code}`;
      const stderrTail = run.stderr.trim() ? `\n${tail(run.stderr)}` : "";
      return { ok: false, error: `codex ${how}${reason}${stderrTail}` };
    }

    const events = parseEvents(run.stdout);
    if (events.failure) return { ok: false, error: `codex reported a failed turn: ${events.failure}` };
    if (!events.completed) return { ok: false, error: "codex exited without completing the review turn" };
    const lastMessage = readOrNull(lastMessagePath);
    const text = lastMessage === null ? events.lastAgentMessage : redact(lastMessage);
    const parsed = parseReviewText(text);

    const roots = [worktree];
    try { roots.push(realpathSync(worktree)); } catch { /* keep the one spelling */ }
    const findings = parsed.findings.map((raw) => normaliseFinding(raw, {
      roots,
      // The head commit's copy, not the worktree's, which holds the base
      // commit's AGENTS.md.
      readFile: (rel) => readAtCommit(root, headSha, rel),
    }));

    return {
      ok: true,
      review: {
        version: 1,
        status: "completed",
        base: baseSha,
        head: headSha,
        codex_version: version,
        model,
        reasoning_effort: reasoningEffort,
        agents_md_changed: agentsChanged,
        explanation: parsed.explanation,
        findings,
      },
    };
  } catch (err) {
    if (err instanceof GitError || err instanceof CodexOutputError || err instanceof FindingError) {
      return { ok: false, error: err.message };
    }
    throw err;
  } finally {
    removeReviewCheckout(worktree);
    rmSync(scratch, { recursive: true, force: true });
  }
}

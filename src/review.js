// The review runner: a temporary worktree of the head commit with the base
// commit's AGENTS.md, one `codex exec review` in it, and the findings it
// returned. Nothing here touches the network itself.

import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildChildEnv } from "./env.js";
import {
  CodexOutputError, TESTED_CODEX, codexVersion, isTestedVersion, parseEvents, parseReviewText, reviewArgs, runCodex,
} from "./codex.js";
import { FindingError, normaliseFinding } from "./findings.js";
import {
  GitError, addWorktree, headChangedGuidance, readAtCommit, removeWorktree, repoRoot, resolveCommit, useBaseGuidance,
} from "./git.js";

const STDERR_TAIL_LINES = 20;

function tail(text, lines = STDERR_TAIL_LINES) {
  const all = text.trimEnd().split("\n");
  return all.slice(-lines).join("\n");
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
  cwd = process.cwd(),
  env = process.env,
  codexBin = "codex",
  signal,
  warn = () => {},
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
  if (!isTestedVersion(version)) {
    warn(`Codex CLI ${version} has not been tested with this tool (tested: ${TESTED_CODEX.label}). Its output may not parse.`);
  }

  const scratch = mkdtempSync(join(tmpdir(), "codex-mr-review-"));
  const worktree = join(scratch, "worktree");
  const lastMessagePath = join(scratch, "last-message.txt");
  try {
    addWorktree(root, worktree, headSha);
    useBaseGuidance(root, worktree, baseSha);

    const run = await runCodex({
      bin: codexBin,
      args: reviewArgs({ baseSha, lastMessagePath }),
      cwd: worktree,
      env: childEnv,
      timeoutMs: timeoutSeconds * 1000,
      signal,
    });
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
    const text = readOrNull(lastMessagePath) ?? events.lastAgentMessage;
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
    removeWorktree(root, worktree);
    rmSync(scratch, { recursive: true, force: true });
  }
}

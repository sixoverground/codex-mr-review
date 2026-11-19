// Running `codex exec review` and reading what it prints.
//
// What the installed CLI actually emits is recorded in docs/codex-output.md.
// In short: with --json, stdout is a JSONL event stream; the review itself
// arrives as the final agent message, which is plain text in Codex's own
// review layout. --output-schema is accepted in review mode but has no
// effect, so that text is parsed here.

import { spawn } from "node:child_process";

import { ExecError, runSync } from "./exec.js";

// The Codex CLI versions this parser was checked against.
export const TESTED_CODEX = Object.freeze({ major: 0, minor: 147, label: "0.147.x" });

// U+2014, the dash Codex puts between a finding's title and its location.
const LOCATION_DASH = "\u2014";

const HEADER = /^(?:Review comment|Review comments|Full review comments):\s*$/;
const BULLET = new RegExp(`^- (.*) ${LOCATION_DASH} (.+)$`);
const LOOSE_FINDING = /^- \[P\d+\]/m;
const FAILURE_MESSAGES = [
  /^Review was interrupted\b/,
  /^Reviewer failed to output a response\b/,
];

export class CodexOutputError extends Error {}

// The reasoning efforts the model API accepts through codex-cli 0.147.0,
// as listed by its own error for an unknown value (see
// docs/codex-output.md). Codex passes the value through unchecked, so the
// tool checks it.
export const REASONING_EFFORTS = Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const DEFAULT_REASONING_EFFORT = "high";

// A model name: letters, digits, dots, colons, underscores and dashes, not
// starting with a dash, so it can never be read as another flag.
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function reviewArgs({ baseSha, lastMessagePath, model = null, reasoningEffort = DEFAULT_REASONING_EFFORT }) {
  if (!REASONING_EFFORTS.includes(reasoningEffort)) throw new Error(`invalid reasoning effort ${reasoningEffort}`);
  if (model !== null && !MODEL_PATTERN.test(model)) throw new Error(`invalid model name ${model}`);
  // Exec options go before the review subcommand. There is no prompt
  // argument: the review uses Codex's own review instructions. The user's
  // config.toml is ignored, so the model and effort come only from here;
  // with no --model, Codex uses its built-in default model.
  return [
    "exec",
    "--sandbox", "read-only",
    "--ephemeral",
    "--ignore-user-config",
    "--json",
    ...(model === null ? [] : ["--model", model]),
    "-c", `model_reasoning_effort="${reasoningEffort}"`,
    "--output-last-message", lastMessagePath,
    "review",
    "--base", baseSha,
  ];
}

// Returns the version string, such as "0.147.0", or throws.
export function codexVersion(bin, env) {
  let r;
  try {
    r = runSync(bin, ["--version"], { env, timeout: 30_000 });
  } catch (err) {
    if (err instanceof ExecError) throw new CodexOutputError(err.message);
    throw err;
  }
  if (r.status !== 0) throw new CodexOutputError(`${bin} --version exited with ${r.status}`);
  const m = /codex-cli (\d+)\.(\d+)\.(\d+\S*)/.exec(r.stdout);
  if (!m) throw new CodexOutputError(`could not read a version from "${r.stdout.trim()}"`);
  return `${m[1]}.${m[2]}.${m[3]}`;
}

export function isTestedVersion(version) {
  const [major, minor] = version.split(".").map(Number);
  return major === TESTED_CODEX.major && minor === TESTED_CODEX.minor;
}

// Signals codex's whole process group. ESRCH (nothing left in the group)
// is the normal case after the leader and its children have exited.
function killGroup(pid, sig) {
  if (pid === undefined) return;
  try {
    process.kill(-pid, sig);
  } catch (err) {
    if (err.code !== "ESRCH") throw err;
  }
}

// Spawns codex and resolves with what happened. Never rejects.
//
// codex runs as the leader of its own process group. Whenever the leader
// exits, on every path, the whole group gets SIGKILL before this resolves,
// so nothing codex started can outlive the review or its worktree. On a
// timeout or an abort the group gets SIGTERM first and SIGKILL after a
// grace period; the leader exiting early does not cancel that.
export function runCodex({ bin, args, cwd, env, timeoutMs, signal, graceMs = 5_000 }) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let stdout = "";
    let stderr = "";
    let killTimer;
    const sweep = () => {
      try { killGroup(child?.pid, "SIGKILL"); } catch { /* EPERM: not ours to kill */ }
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      sweep();
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, timedOut, aborted, ...result });
    };
    const stop = () => {
      try { killGroup(child?.pid, "SIGTERM"); } catch { /* EPERM */ }
      killTimer = setTimeout(sweep, graceMs);
    };
    const onAbort = () => { aborted = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);

    try {
      // detached puts codex and anything it starts in their own process
      // group, so the group can be stopped as a whole.
      child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (err) {
      finish({ code: null, signal: null, spawnError: err });
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) => finish({ code: null, signal: null, spawnError: err }));
    // A descendant can keep the pipes open after the leader exits, which
    // would hold back "close"; killing the group on "exit" releases them.
    child.on("exit", sweep);
    child.on("close", (code, sig) => finish({ code, signal: sig }));
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

// Reads the --json event stream. Returns whether the turn completed, the
// failure message if it failed, and the last agent message.
export function parseEvents(stdout) {
  let completed = false;
  let failure = null;
  let lastAgentMessage = null;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      // The whole line: cutting it here, before redaction, could cut a
      // secret in half. Messages are shortened later, after redaction.
      throw new CodexOutputError(`codex printed a line that is not JSON: ${line}`);
    }
    if (event === null || typeof event !== "object") {
      throw new CodexOutputError("codex printed an event that is not an object");
    }
    if (event.type === "turn.completed") completed = true;
    if (event.type === "turn.failed") failure = event.error?.message ?? "turn failed";
    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      lastAgentMessage = event.item.text ?? "";
    }
  }
  return { completed, failure, lastAgentMessage };
}

// Splits Codex's review text into the overall explanation and raw findings:
// { rawTitle, location, body }. Throws CodexOutputError when the text is not
// in the layout docs/codex-output.md describes.
export function parseReviewText(text) {
  if (typeof text !== "string" || text.trim() === "") {
    throw new CodexOutputError("codex returned an empty review");
  }
  const trimmed = text.trim();
  for (const re of FAILURE_MESSAGES) {
    if (re.test(trimmed)) throw new CodexOutputError(`codex did not finish the review: ${trimmed}`);
  }
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const headerAt = lines.findIndex((l) => HEADER.test(l));
  if (headerAt === -1) {
    // No findings block. A line that looks like a finding means the layout
    // changed, and reading it as a clean review would hide findings.
    if (LOOSE_FINDING.test(text)) {
      throw new CodexOutputError("codex output has finding-like lines but no findings header");
    }
    return { explanation: trimmed, findings: [] };
  }

  const explanation = lines.slice(0, headerAt).join("\n").trim();
  const findings = [];
  let current = null;
  for (let i = headerAt + 1; i < lines.length; i++) {
    const line = lines[i];
    const bullet = BULLET.exec(line);
    if (bullet) {
      current = { rawTitle: bullet[1].trim(), location: bullet[2].trim(), bodyLines: [] };
      findings.push(current);
      continue;
    }
    if (line.trim() === "") {
      if (current) current.bodyLines.push("");
      continue;
    }
    if (!current || !line.startsWith("  ")) {
      throw new CodexOutputError(`unexpected line in codex findings: ${line}`);
    }
    current.bodyLines.push(line.slice(2));
  }
  if (findings.length === 0) {
    throw new CodexOutputError("codex output has a findings header but no findings");
  }
  return {
    explanation,
    findings: findings.map(({ rawTitle, location, bodyLines }) => ({
      rawTitle,
      location,
      body: bodyLines.join("\n").trim(),
    })),
  };
}

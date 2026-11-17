// Running `codex exec review` and reading what it prints.
//
// What the installed CLI actually emits is recorded in docs/codex-output.md.
// In short: with --json, stdout is a JSONL event stream; the review itself
// arrives as the final agent message, which is plain text in Codex's own
// review layout. --output-schema is accepted in review mode but has no
// effect, so that text is parsed here.

import { spawn, spawnSync } from "node:child_process";

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

export function reviewArgs({ baseSha, lastMessagePath }) {
  // Exec options go before the review subcommand. There is no prompt
  // argument: the review uses Codex's own review instructions.
  return [
    "exec",
    "--sandbox", "read-only",
    "--ephemeral",
    "--ignore-user-config",
    "--json",
    "--output-last-message", lastMessagePath,
    "review",
    "--base", baseSha,
  ];
}

// Returns the version string, such as "0.147.0", or throws.
export function codexVersion(bin, env) {
  const r = spawnSync(bin, ["--version"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  if (r.error) throw new CodexOutputError(`could not run ${bin}: ${r.error.message}`);
  if (r.status !== 0) throw new CodexOutputError(`${bin} --version exited with ${r.status}`);
  const m = /codex-cli (\d+)\.(\d+)\.(\d+\S*)/.exec(r.stdout);
  if (!m) throw new CodexOutputError(`could not read a version from "${r.stdout.trim()}"`);
  return `${m[1]}.${m[2]}.${m[3]}`;
}

export function isTestedVersion(version) {
  const [major, minor] = version.split(".").map(Number);
  return major === TESTED_CODEX.major && minor === TESTED_CODEX.minor;
}

function killGroup(child, sig) {
  try {
    process.kill(-child.pid, sig);
  } catch {
    try { child.kill(sig); } catch { /* already gone */ }
  }
}

// Spawns codex and resolves with what happened. Never rejects.
export function runCodex({ bin, args, cwd, env, timeoutMs, signal }) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let stdout = "";
    let stderr = "";
    let killTimer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, timedOut, aborted, ...result });
    };
    const stop = () => {
      killGroup(child, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child, "SIGKILL"), 5_000);
    };
    const onAbort = () => { aborted = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);

    try {
      // detached puts codex and anything it starts in their own process
      // group, so a timeout can stop all of them.
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
      throw new CodexOutputError(`codex printed a line that is not JSON: ${line.slice(0, 120)}`);
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
    if (re.test(trimmed)) throw new CodexOutputError(`codex did not finish the review: ${trimmed.split("\n")[0]}`);
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
      throw new CodexOutputError(`unexpected line in codex findings: ${line.slice(0, 120)}`);
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

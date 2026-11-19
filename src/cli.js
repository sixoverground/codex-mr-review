#!/usr/bin/env node
// codex-mr-review command line entry point.
//
// `review` runs Codex's review mode and posts the findings, a summary and
// the review marker to a GitLab merge request. `review --dry-run` prints
// the findings instead and makes no network call.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { DEFAULT_REASONING_EFFORT, MODEL_PATTERN, REASONING_EFFORTS } from "./codex.js";
import { diffPosition, mergeBase, repoRoot, GitError } from "./git.js";
import { GitLabError, createClient } from "./gitlab.js";
import { failureBody, postReview, scrubModelText, scrubReview } from "./post.js";
import { makeRedactor, redactingStream, secretValues } from "./redact.js";
import { TOKEN_ENV } from "./env.js";
import { runReview } from "./review.js";
import { runSync } from "./exec.js";
import { renderText } from "./render.js";
import { validate } from "./schema.js";

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

export const FORMATS = ["text", "json"];
export const REVIEWER_PATTERN = /^[a-z0-9-]+$/;

const REVIEW_OPTIONS = {
  base: { type: "string" },
  head: { type: "string" },
  "dry-run": { type: "boolean", default: false },
  format: { type: "string", default: "text" },
  reviewer: { type: "string", default: "codex" },
  "clean-emoji": { type: "boolean", default: false },
  timeout: { type: "string", default: "900" },
  model: { type: "string" },
  "reasoning-effort": { type: "string", default: DEFAULT_REASONING_EFFORT },
  "gitlab-url": { type: "string" },
  project: { type: "string" },
  mr: { type: "string" },
  help: { type: "boolean", short: "h", default: false },
};

export function readVersion() {
  const url = new URL("../package.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")).version;
}

const REVIEW_OPTIONS_HELP = `Review options:
  --base <ref>         Base commit or branch to diff against (required)
  --head <ref>         Head commit to review (default: HEAD)
  --dry-run            Print findings locally and post nothing
  --format <fmt>       Output format for --dry-run: text or json (default: text)
  --reviewer <name>    Reviewer name written into the marker, matching
                       [a-z0-9-]+ (default: codex)
  --clean-emoji        Add a thumbs up to the merge request when a review
                       has no findings
  --timeout <seconds>  Give up on the review after this many seconds
                       (default: 900)
  --model <name>       Model Codex reviews with (default: Codex's own
                       default model; ~/.codex/config.toml is ignored)
  --reasoning-effort <level>
                       Reasoning effort for the review, one of
                       ${REASONING_EFFORTS.join(", ")}
                       (default: ${DEFAULT_REASONING_EFFORT})
  --gitlab-url <url>   GitLab instance, such as https://gitlab.com
                       (default: $CI_SERVER_URL)
  --project <id|path>  Project id or path, such as group/project
                       (default: $CI_MERGE_REQUEST_PROJECT_ID, then
                       $CI_PROJECT_ID)
  --mr <iid>           Merge request iid (default: $CI_MERGE_REQUEST_IID)

Without --dry-run the review is posted to the merge request, using the
token in $${TOKEN_ENV}.
`;

export const MAIN_HELP = `Usage: codex-mr-review <command> [options]

Run the Codex CLI's review mode on a change and report its findings on a
GitLab merge request.

Commands:
  review          Review the diff between a base and a head commit

Options:
  -h, --help      Show this help
  -v, --version   Print the version

${REVIEW_OPTIONS_HELP}`;

export const REVIEW_HELP = `Usage: codex-mr-review review --base <ref> [options]

Review the diff between --base and --head with Codex's review mode.

${REVIEW_OPTIONS_HELP}  -h, --help           Show this help
`;

class UsageError extends Error {}

export function parseReviewArgs(args) {
  let parsed;
  try {
    parsed = parseArgs({ args, options: REVIEW_OPTIONS, strict: true, allowPositionals: false });
  } catch (err) {
    throw new UsageError(err.message);
  }
  const v = parsed.values;
  if (v.help) return { help: true };
  if (v.base === undefined || v.base === "") {
    throw new UsageError("review: --base is required");
  }
  if (!FORMATS.includes(v.format)) {
    throw new UsageError(`review: --format must be one of ${FORMATS.join(", ")}, got "${v.format}"`);
  }
  if (!REVIEWER_PATTERN.test(v.reviewer)) {
    throw new UsageError(`review: --reviewer must match [a-z0-9-]+, got "${v.reviewer}"`);
  }
  if (!REASONING_EFFORTS.includes(v["reasoning-effort"])) {
    throw new UsageError(`review: --reasoning-effort must be one of ${REASONING_EFFORTS.join(", ")}, got "${v["reasoning-effort"]}"`);
  }
  if (v.model !== undefined && !MODEL_PATTERN.test(v.model)) {
    throw new UsageError(`review: --model must be a model name (letters, digits, ".", "_", ":" and "-", not starting with "-"), got "${v.model}"`);
  }
  if (v.mr !== undefined && !/^[1-9][0-9]*$/.test(v.mr)) {
    throw new UsageError(`review: --mr must be a merge request iid (a positive whole number), got "${v.mr}"`);
  }
  const timeout = Number(v.timeout);
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new UsageError(`review: --timeout must be a positive whole number of seconds, got "${v.timeout}"`);
  }
  return {
    help: false,
    base: v.base,
    head: v.head ?? "HEAD",
    dryRun: v["dry-run"],
    format: v.format,
    reviewer: v.reviewer,
    cleanEmoji: v["clean-emoji"],
    timeoutSeconds: timeout,
    model: v.model ?? null,
    reasoningEffort: v["reasoning-effort"],
    gitlabUrl: v["gitlab-url"] ?? null,
    project: v.project ?? null,
    mr: v.mr ?? null,
  };
}

const SHA_RE = /^[0-9a-f]{40}$/;

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

// Where to post, from the flags or else the CI variables. Throws
// UsageError naming what is missing.
export function gitlabTarget(options, env) {
  const baseUrl = nonEmpty(options.gitlabUrl) ?? nonEmpty(env.CI_SERVER_URL);
  const project = nonEmpty(options.project) ?? nonEmpty(env.CI_MERGE_REQUEST_PROJECT_ID) ?? nonEmpty(env.CI_PROJECT_ID);
  const mr = nonEmpty(options.mr) ?? nonEmpty(env.CI_MERGE_REQUEST_IID);
  const token = nonEmpty(env[TOKEN_ENV]);
  const missing = [];
  if (!baseUrl) missing.push("--gitlab-url or CI_SERVER_URL");
  if (!project) missing.push("--project or CI_PROJECT_ID");
  if (!mr) missing.push("--mr or CI_MERGE_REQUEST_IID");
  if (!token) missing.push(TOKEN_ENV);
  if (missing.length > 0) {
    throw new UsageError(`review: posting needs ${missing.join(", ")} (or pass --dry-run)`);
  }
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new UsageError(`review: the GitLab URL "${baseUrl}" is not a URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UsageError(`review: the GitLab URL must be http or https, got "${baseUrl}"`);
  }
  if (!/^[1-9][0-9]*$/.test(mr)) throw new UsageError(`review: the merge request iid must be a positive whole number, got "${mr}"`);
  return { baseUrl: url.href.replace(/\/+$/, ""), project, mr, token };
}

// The sha the marker names: the pipeline's, never the model's.
// CI_MERGE_REQUEST_SOURCE_BRANCH_SHA when set (the branch head in a
// merged-results pipeline), else CI_COMMIT_SHA, else the checked-out
// commit. Returns { sha, source }.
export function markerSha(env, cwd) {
  for (const name of ["CI_MERGE_REQUEST_SOURCE_BRANCH_SHA", "CI_COMMIT_SHA"]) {
    const value = nonEmpty(env[name]);
    if (value === null) continue;
    if (!SHA_RE.test(value)) throw new UsageError(`review: ${name} is not a full lowercase 40 character sha: "${value}"`);
    return { sha: value, source: name };
  }
  const r = runSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd });
  const sha = String(r.stdout).trim();
  if (r.status !== 0 || !SHA_RE.test(sha)) throw new UsageError("review: could not read the checked-out commit for the marker");
  return { sha, source: "the checked-out commit" };
}

export function readOutputSchema() {
  return JSON.parse(readFileSync(new URL("../schema/review-output.schema.json", import.meta.url), "utf8"));
}

// Runs the CLI against argv (without the node and script entries) and
// resolves with an exit code. Output goes through the injected streams so
// tests can capture it.
export async function main(argv, {
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  cwd = process.cwd(),
  signal,
  fetchImpl = globalThis.fetch,
} = {}) {
  // The one redaction point: everything main writes, on either stream and
  // in either format, goes through these two wrappers.
  // Printed text is also scrubbed of the marker prefix: error messages
  // can quote model output, and the tool never prints a marker itself.
  const secrets = makeRedactor(secretValues(env));
  const printable = (text) => secrets(scrubModelText(text));
  const out = redactingStream(stdout, printable);
  const err = redactingStream(stderr, printable);
  try {
    return await dispatch(argv, { stdout: out, stderr: err, env, cwd, signal, secrets, fetchImpl });
  } catch (error) {
    err.write(`codex-mr-review: internal error: ${error?.stack ?? error}\n`);
    return EXIT_FAILURE;
  }
}

async function dispatch(argv, { stdout, stderr, env, cwd, signal, secrets, fetchImpl }) {
  const [command, ...rest] = argv;

  if (command === undefined || command === "-h" || command === "--help" || command === "help") {
    stdout.write(MAIN_HELP);
    return command === undefined ? EXIT_USAGE : EXIT_OK;
  }
  if (command === "-v" || command === "--version") {
    stdout.write(`${readVersion()}\n`);
    return EXIT_OK;
  }
  if (command === "review") {
    let options;
    try {
      options = parseReviewArgs(rest);
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      stderr.write(`codex-mr-review: ${err.message}\n\n${REVIEW_HELP}`);
      return EXIT_USAGE;
    }
    if (options.help) {
      stdout.write(REVIEW_HELP);
      return EXIT_OK;
    }
    if (options.dryRun) return runDryRun(options, { stdout, stderr, env, cwd, signal, secrets });
    let target;
    let shaInfo;
    try {
      target = gitlabTarget(options, env);
      shaInfo = markerSha(env, cwd);
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      stderr.write(`codex-mr-review: ${err.message}\n`);
      return EXIT_USAGE;
    }
    return runAndPost(options, { stdout, stderr, env, cwd, signal, secrets, fetchImpl, target, shaInfo });
  }

  stderr.write(`codex-mr-review: unknown command "${command}"\n\n${MAIN_HELP}`);
  return EXIT_USAGE;
}

// The schema's own checks plus what scrubbing can empty. Returns a list of
// problems; empty means the review may be printed or posted.
export function reviewProblems(review) {
  const problems = validate(readOutputSchema(), review);
  review.findings?.forEach((f, i) => {
    if (typeof f.title === "string" && f.title.trim() === "") problems.push(`/findings/${i}/title: empty after scrubbing`);
    if (typeof f.body === "string" && f.body.trim() === "") problems.push(`/findings/${i}/body: empty after scrubbing`);
  });
  return problems;
}

async function startReview(options, { stderr, env, cwd, signal, secrets }) {
  // Codex's event stream does not name the model it used (thread.started
  // carries only a thread id), so an unset --model is reported as such.
  stderr.write(`codex-mr-review: reviewing with model ${options.model ?? "Codex's default"}, reasoning effort ${options.reasoningEffort}\n`);
  const outcome = await runReview({
    base: options.base,
    head: options.head,
    timeoutSeconds: options.timeoutSeconds,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    cwd,
    env,
    signal,
    warn: (message) => stderr.write(`codex-mr-review: warning: ${message}\n`),
    redact: secrets,
  });
  if (!outcome.ok) return outcome;
  // The one scrub point for everything that came from Codex: every
  // string in the review. Then the scrubbed review is validated, for every
  // output format, before anything is printed or posted.
  const review = scrubReview(outcome.review);
  const problems = reviewProblems(review);
  if (problems.length > 0) return { ok: false, error: `the review does not match its schema: ${problems.join("; ")}` };
  return { ok: true, review };
}

async function runDryRun(options, { stdout, stderr, env, cwd, signal, secrets }) {
  const outcome = await startReview(options, { stderr, env, cwd, signal, secrets });
  // A failed review prints no findings: only the reason, on stderr.
  if (!outcome.ok) {
    stderr.write(`codex-mr-review: review failed: ${outcome.error}\n`);
    return EXIT_FAILURE;
  }
  return printReview(options, outcome.review, { stdout });
}

// review was validated in startReview, before anything was posted.
function printReview(options, review, { stdout }) {
  if (options.format === "json") {
    stdout.write(`${JSON.stringify(review, null, 2)}\n`);
  } else {
    stdout.write(renderText(review));
  }
  return EXIT_OK;
}

// The text position for a finding, from the local diff between the
// review's merge base and its head. Unchanged lines need old_line as well
// as new_line; if the local diff cannot be read, new_line alone is tried
// and a rejection falls back to a general thread.
function positionFor(root, review) {
  let from = null;
  try { from = mergeBase(root, review.base, review.head); } catch { /* new_line only */ }
  return (finding) => {
    const pos = { new_path: finding.path, old_path: finding.path, new_line: finding.start_line };
    if (from === null) return pos;
    try {
      const p = diffPosition(root, from, review.head, finding.path, finding.start_line);
      pos.old_path = p.old_path;
      if (p.kind === "unchanged") pos.old_line = p.old_line;
    } catch (err) {
      if (!(err instanceof GitError)) throw err;
    }
    return pos;
  };
}

async function runAndPost(options, { stdout, stderr, env, cwd, signal, secrets, fetchImpl, target, shaInfo }) {
  const log = (message) => stderr.write(`codex-mr-review: ${message}\n`);
  // Outbound bodies are redacted of secrets only. Model text in them was
  // already scrubbed by startReview, and the summary carries the tool's
  // own marker, which must survive.
  const client = createClient({ ...target, redact: secrets, fetchImpl });
  let self;
  let mr;
  try {
    self = await client.currentUser();
    mr = await client.getMergeRequest();
  } catch (err) {
    if (!(err instanceof GitLabError)) throw err;
    log(`could not read the merge request: ${err.message}`);
    return EXIT_FAILURE;
  }
  log(`posting to merge request !${target.mr}; the marker will name ${shaInfo.sha} (from ${shaInfo.source})`);

  const outcome = await startReview(options, { stderr, env, cwd, signal, secrets });
  if (!outcome.ok) {
    log(`review failed: ${outcome.error}`);
    try {
      await client.createNote(failureBody(outcome.error, secrets));
      log("posted a failure note, with no marker");
    } catch (err) {
      if (!(err instanceof GitLabError)) throw err;
      log(`could not post the failure note: ${err.message}`);
    }
    return EXIT_FAILURE;
  }
  const review = outcome.review;
  if (review.head !== shaInfo.sha) {
    log(`warning: the marker names ${shaInfo.sha} (from ${shaInfo.source}) but the reviewed tree is ${review.head}`);
  }
  const diffRefs = mr?.diff_refs?.base_sha && mr.diff_refs.start_sha && mr.diff_refs.head_sha ? mr.diff_refs : null;
  if (!diffRefs) log("warning: the merge request has no diff_refs yet; findings are posted as general threads");

  try {
    await postReview(client, review, {
      sha: shaInfo.sha,
      reviewer: options.reviewer,
      cleanEmoji: options.cleanEmoji,
      selfId: self?.id,
      diffRefs,
      position: positionFor(repoRoot(cwd), review),
      log,
    });
  } catch (err) {
    if (!(err instanceof GitLabError)) throw err;
    log(`posting failed, and no marker was posted: ${err.message}`);
    return EXIT_FAILURE;
  }
  return printReview(options, review, { stdout });
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  // Ctrl-C or a CI cancel stops codex and still removes the worktree.
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  process.exitCode = await main(process.argv.slice(2), { signal: controller.signal });
}

#!/usr/bin/env node
// codex-mr-review command line entry point.
//
// `review --dry-run` runs Codex's review mode and prints the findings. The
// GitLab client and the marker arrive in later changes, so a review without
// --dry-run stops with "not implemented".

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { makeRedactor, redactingStream, secretValues } from "./redact.js";
import { runReview } from "./review.js";
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
  };
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
} = {}) {
  // The one redaction point: everything main writes, on either stream and
  // in either format, goes through these two wrappers.
  const redact = makeRedactor(secretValues(env));
  const out = redactingStream(stdout, redact);
  const err = redactingStream(stderr, redact);
  try {
    return await dispatch(argv, { stdout: out, stderr: err, env, cwd, signal });
  } catch (error) {
    err.write(`codex-mr-review: internal error: ${error?.stack ?? error}\n`);
    return EXIT_FAILURE;
  }
}

async function dispatch(argv, { stdout, stderr, env, cwd, signal }) {
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
    if (!options.dryRun) {
      stderr.write("codex-mr-review: posting to GitLab is not implemented yet; pass --dry-run\n");
      return EXIT_FAILURE;
    }
    return runDryRun(options, { stdout, stderr, env, cwd, signal });
  }

  stderr.write(`codex-mr-review: unknown command "${command}"\n\n${MAIN_HELP}`);
  return EXIT_USAGE;
}

async function runDryRun(options, { stdout, stderr, env, cwd, signal }) {
  const outcome = await runReview({
    base: options.base,
    head: options.head,
    timeoutSeconds: options.timeoutSeconds,
    cwd,
    env,
    signal,
    warn: (message) => stderr.write(`codex-mr-review: warning: ${message}\n`),
  });
  // A failed review prints no findings: only the reason, on stderr.
  if (!outcome.ok) {
    stderr.write(`codex-mr-review: review failed: ${outcome.error}\n`);
    return EXIT_FAILURE;
  }
  if (options.format === "json") {
    const errors = validate(readOutputSchema(), outcome.review);
    if (errors.length > 0) {
      stderr.write(`codex-mr-review: review failed: output does not match its schema: ${errors.join("; ")}\n`);
      return EXIT_FAILURE;
    }
    stdout.write(`${JSON.stringify(outcome.review, null, 2)}\n`);
  } else {
    stdout.write(renderText(outcome.review));
  }
  return EXIT_OK;
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

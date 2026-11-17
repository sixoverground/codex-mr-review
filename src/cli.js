#!/usr/bin/env node
// codex-mr-review command line entry point.
//
// This is the scaffold: it parses arguments and validates them, and the
// review subcommand stops with "not implemented". The runner, the GitLab
// client and the marker arrive in later changes.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

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
  // --base becomes mandatory when the runner lands. Until then a bare
  // "review" reaches the not-implemented exit like any other valid call.
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
    base: v.base ?? null,
    head: v.head ?? "HEAD",
    dryRun: v["dry-run"],
    format: v.format,
    reviewer: v.reviewer,
    cleanEmoji: v["clean-emoji"],
    timeoutSeconds: timeout,
  };
}

// Runs the CLI against argv (without the node and script entries) and
// returns an exit code. Output goes through the injected streams so tests
// can capture it.
export function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
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
    stderr.write("codex-mr-review: review is not implemented yet\n");
    return EXIT_FAILURE;
  }

  stderr.write(`codex-mr-review: unknown command "${command}"\n\n${MAIN_HELP}`);
  return EXIT_USAGE;
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
  process.exitCode = main(process.argv.slice(2));
}

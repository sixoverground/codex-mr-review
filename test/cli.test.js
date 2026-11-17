import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { main, parseReviewArgs, EXIT_OK, EXIT_FAILURE, EXIT_USAGE } from "../src/cli.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
}

async function capture(argv) {
  let out = "";
  let err = "";
  const code = await main(argv, {
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
  });
  return { code, out, err };
}

test("--help lists the review subcommand", () => {
  const r = run(["--help"]);
  assert.equal(r.status, EXIT_OK);
  assert.match(r.stdout, /^Usage: codex-mr-review/m);
  assert.match(r.stdout, /^\s+review\s/m);
});

for (const args of [["--help"], ["review", "--help"]]) {
  test(`${args.join(" ")} lists every review flag`, () => {
    const r = run(args);
    assert.equal(r.status, EXIT_OK);
    for (const flag of ["--base", "--head", "--dry-run", "--format", "--reviewer", "--clean-emoji", "--timeout"]) {
      assert.ok(r.stdout.includes(flag), `missing ${flag}`);
    }
  });
}

test("--version prints the package.json version", async () => {
  const r = run(["--version"]);
  assert.equal(r.status, EXIT_OK);
  assert.equal(r.stdout.trim(), PKG.version);
  assert.equal((await capture(["-v"])).out.trim(), PKG.version);
});

test("no command prints help and exits with a usage error", async () => {
  const r = await capture([]);
  assert.equal(r.code, EXIT_USAGE);
  assert.match(r.out, /Commands:/);
});

test("an unknown command is a usage error", async () => {
  const r = await capture(["frobnicate"]);
  assert.equal(r.code, EXIT_USAGE);
  assert.match(r.err, /unknown command "frobnicate"/);
});

test("review without --dry-run exits non-zero because posting is not implemented", () => {
  const r = run(["review", "--base", "main"]);
  assert.equal(r.status, EXIT_FAILURE);
  assert.match(r.stderr, /not implemented/);
  assert.equal(r.stdout, "");
});

test("review without --base is a usage error", () => {
  const r = run(["review", "--dry-run"]);
  assert.equal(r.status, EXIT_USAGE);
  assert.match(r.stderr, /--base is required/);
  assert.equal(r.stdout, "");
});

test("review rejects an unknown flag", async () => {
  const r = await capture(["review", "--base", "main", "--post-to-github"]);
  assert.equal(r.code, EXIT_USAGE);
});

test("parseReviewArgs applies defaults", () => {
  assert.deepEqual(parseReviewArgs(["--base", "abc123"]), {
    help: false,
    base: "abc123",
    head: "HEAD",
    dryRun: false,
    format: "text",
    reviewer: "codex",
    cleanEmoji: false,
    timeoutSeconds: 900,
  });
});

test("parseReviewArgs reads every flag", () => {
  const o = parseReviewArgs([
    "--base", "main", "--head", "feature", "--dry-run", "--format", "json",
    "--reviewer", "codex-local", "--clean-emoji", "--timeout", "60",
  ]);
  assert.equal(o.head, "feature");
  assert.equal(o.dryRun, true);
  assert.equal(o.format, "json");
  assert.equal(o.reviewer, "codex-local");
  assert.equal(o.cleanEmoji, true);
  assert.equal(o.timeoutSeconds, 60);
});

test("parseReviewArgs rejects a format other than text or json", () => {
  assert.throws(() => parseReviewArgs(["--base", "main", "--format", "xml"]), /--format/);
});

test("parseReviewArgs rejects a reviewer name outside [a-z0-9-]", () => {
  for (const bad of ["Codex", "codex_local", "codex local", ""]) {
    assert.throws(() => parseReviewArgs(["--base", "main", "--reviewer", bad]), /--reviewer/, bad);
  }
});

test("parseReviewArgs rejects a timeout that is not a positive whole number", () => {
  for (const bad of ["0", "-5", "1.5", "soon"]) {
    assert.throws(() => parseReviewArgs(["--base", "main", "--timeout", bad]), /--timeout/, bad);
  }
});

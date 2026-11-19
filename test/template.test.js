// The GitLab CI template: its job settings, checked as text since there is
// no YAML parser among the dependencies, and its script, run for real with
// sh and a stand-in codex-mr-review that records its arguments.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { tempDir } from "./support/helpers.js";

const TEMPLATE = readFileSync(new URL("../templates/codex-review.gitlab-ci.yml", import.meta.url), "utf8");

function script() {
  const lines = TEMPLATE.split("\n");
  const start = lines.findIndex((l) => l.includes("# codex-mr-review:script-start"));
  const end = lines.findIndex((l) => l.includes("# codex-mr-review:script-end"));
  assert.ok(start > 0 && end > start, "the script markers are present");
  const indent = lines[start].match(/^ */)[0].length;
  return lines.slice(start, end + 1).map((l) => l.slice(indent)).join("\n");
}

const DEFAULTS = {
  CODEX_MR_REVIEW_MODEL: "",
  CODEX_MR_REVIEW_REASONING_EFFORT: "high",
  CODEX_MR_REVIEW_REVIEWER: "codex",
  CODEX_MR_REVIEW_TIMEOUT: "900",
  CODEX_MR_REVIEW_CLEAN_EMOJI: "false",
};

// Runs the job script as GitLab would (with its job variables), and
// returns the arguments codex-mr-review received.
function runScript(env) {
  const dir = tempDir("cmr-template-");
  const record = join(dir, "args.txt");
  const bin = join(dir, "codex-mr-review");
  writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${record}'\n`);
  chmodSync(bin, 0o755);
  const file = join(dir, "job.sh");
  writeFileSync(file, script());
  const r = spawnSync("sh", [file], { encoding: "utf8", env: { PATH: `${dir}:/usr/bin:/bin`, ...DEFAULTS, ...env } });
  assert.equal(r.status, 0, r.stderr);
  return readFileSync(record, "utf8").trimEnd().split("\n");
}

const MR = { CI_MERGE_REQUEST_DIFF_BASE_SHA: "a".repeat(40) };

test("the job runs on merge request pipelines only, interruptible, one at a time per merge request", () => {
  assert.match(TEMPLATE, /^\.codex-review:$/m, "a hidden job");
  assert.match(TEMPLATE, /^codex-review:\n {2}extends: \.codex-review$/m, "a ready job extending it");
  assert.match(TEMPLATE, /^ {2}rules:\n {4}- if: \$CI_PIPELINE_SOURCE == "merge_request_event"$/m);
  assert.match(TEMPLATE, /^ {2}interruptible: true$/m);
  assert.match(TEMPLATE, /^ {2}resource_group: codex-review-\$CI_MERGE_REQUEST_PROJECT_ID-\$CI_MERGE_REQUEST_IID$/m);
  assert.match(TEMPLATE, /^ {4}GIT_DEPTH: "0"$/m, "full history, so the merge base exists");
  assert.match(TEMPLATE, /^ {4}CODEX_MR_REVIEW_REASONING_EFFORT: "high"$/m);
  assert.match(TEMPLATE, /^ {2}# tags: \[your-runner-tag\]$/m, "tags are left for the project");
  assert.doesNotMatch(TEMPLATE, /^\s+tags:/m);
  assert.match(TEMPLATE, /CODEX_MR_REVIEW_TOKEN/, "the one token variable is named");
  assert.doesNotMatch(TEMPLATE, /\t/, "no tabs in YAML");
});

test("a merge request pipeline reviews from the diff base with the defaults", () => {
  assert.deepEqual(runScript(MR), [
    "review", "--base", "a".repeat(40), "--reviewer", "codex", "--reasoning-effort", "high", "--timeout", "900",
  ]);
});

test("a merged-results pipeline also passes the source branch head as --head", () => {
  const args = runScript({ ...MR, CI_MERGE_REQUEST_SOURCE_BRANCH_SHA: "b".repeat(40) });
  assert.deepEqual(args.slice(-2), ["--head", "b".repeat(40)]);
});

test("model, effort, reviewer, timeout and the clean emoji come from variables", () => {
  const args = runScript({
    ...MR,
    CODEX_MR_REVIEW_MODEL: "some-model",
    CODEX_MR_REVIEW_REASONING_EFFORT: "xhigh",
    CODEX_MR_REVIEW_REVIEWER: "codex-local",
    CODEX_MR_REVIEW_TIMEOUT: "1200",
    CODEX_MR_REVIEW_CLEAN_EMOJI: "true",
  });
  assert.deepEqual(args, [
    "review", "--base", "a".repeat(40), "--reviewer", "codex-local", "--reasoning-effort", "xhigh", "--timeout", "1200",
    "--model", "some-model", "--clean-emoji",
  ]);
});

test("a value with spaces or shell characters stays one argument", () => {
  const args = runScript({ ...MR, CODEX_MR_REVIEW_MODEL: "a b; echo pwned" });
  assert.equal(args.at(-1), "a b; echo pwned");
});

test("the README names the other project only in the link to the contract it implements", () => {
  const name = ["claude", "phases"].join("-");
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const lines = readme.split("\n").filter((l) => l.includes(name));
  assert.deepEqual(lines, [`https://github.com/sixoverground/${name}/blob/5c8875d10d58a6aebaf421d4d999388533195aa6/docs/review-contract.md`]);
  for (const rel of ["../templates/codex-review.gitlab-ci.yml", "../CHANGELOG.md"]) {
    assert.ok(!readFileSync(new URL(rel, import.meta.url), "utf8").includes(name), rel);
  }
});

test("the README's install command names the release tag of package.json's version", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(readme.includes(`npm install -g github:sixoverground/codex-mr-review#v${pkg.version}`));
  assert.ok(TEMPLATE.includes(`codex-mr-review/v${pkg.version}/templates/codex-review.gitlab-ci.yml`));
  for (const entry of ["src", "schema", "templates"]) assert.ok(pkg.files.includes(entry), entry);
  assert.equal(pkg.scripts.prepare, undefined, "no build step for a git install to run");
  assert.deepEqual(pkg.dependencies ?? {}, {}, "no runtime dependencies");
});

import { test } from "node:test";
import assert from "node:assert/strict";

import { CHILD_ENV_ALLOWLIST, NEVER_FORWARD, TOKEN_ENV, buildChildEnv } from "../src/env.js";

test("the tool's own token variable is CODEX_MR_REVIEW_TOKEN", () => {
  assert.equal(TOKEN_ENV, "CODEX_MR_REVIEW_TOKEN");
  assert.deepEqual([...NEVER_FORWARD].sort(), ["CI_JOB_TOKEN", "CODEX_MR_REVIEW_TOKEN", "GITLAB_TOKEN"]);
});

test("buildChildEnv keeps only allowlisted names", () => {
  const env = buildChildEnv({
    PATH: "/bin",
    HOME: "/home/x",
    CODEX_HOME: "/home/x/.codex",
    GITLAB_TOKEN: "glpat-secret",
    CI_JOB_TOKEN: "job-secret",
    CODEX_MR_REVIEW_TOKEN: "own-secret",
    AWS_SECRET_ACCESS_KEY: "aws",
    CI_SERVER_URL: "https://gitlab.example",
  });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/home/x", CODEX_HOME: "/home/x/.codex" });
});

test("no name that must never be forwarded is on the allowlist", () => {
  for (const name of NEVER_FORWARD) assert.ok(!CHILD_ENV_ALLOWLIST.includes(name), name);
});

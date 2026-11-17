// The environment handed to the codex child process.
//
// The child gets an allowlist, never a copy of the tool's own environment,
// so a token the tool holds cannot reach the model. The names in
// NEVER_FORWARD are removed again after the allowlist is applied, as a
// second guard in case the allowlist is ever widened by mistake.

// The tool's own GitLab token variable. Nothing reads it yet; it is named
// here so the child environment can be tested against it from the start.
export const TOKEN_ENV = "CODEX_MR_REVIEW_TOKEN";

export const NEVER_FORWARD = Object.freeze([TOKEN_ENV, "GITLAB_TOKEN", "CI_JOB_TOKEN"]);

export const CHILD_ENV_ALLOWLIST = Object.freeze([
  // Process basics.
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TERM",
  "TZ",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  // Codex: where its login lives, or an API key in place of a login.
  "CODEX_HOME",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  // Reaching the model API from behind a proxy or a private CA.
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

export function buildChildEnv(parentEnv) {
  const env = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    if (Object.hasOwn(parentEnv, name) && parentEnv[name] !== undefined) {
      env[name] = parentEnv[name];
    }
  }
  for (const name of NEVER_FORWARD) delete env[name];
  return env;
}

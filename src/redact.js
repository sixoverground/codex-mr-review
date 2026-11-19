// Redacting known secret values from everything the tool writes.
//
// The CLI wraps its stdout and stderr in redactingStream once, at the top
// of main, so every diagnostic, error message, finding and summary passes
// through the same redactor whatever code path produced it.

import { NEVER_FORWARD } from "./env.js";

export const REDACTED = "[redacted]";

// Values shorter than this are not treated as secrets: redacting "1" or
// "true" everywhere would mangle output and protect nothing.
export const MIN_SECRET_LENGTH = 8;

// The variables whose values are secret. The tokens never reach codex at
// all; the API keys do, because codex needs them, so they are redacted
// from anything codex prints back.
export const SECRET_ENV = Object.freeze([...NEVER_FORWARD, "OPENAI_API_KEY", "CODEX_API_KEY"]);

export function secretValues(env) {
  const values = new Set();
  for (const name of SECRET_ENV) {
    const value = env[name];
    if (typeof value !== "string") continue;
    // Both spellings: the tool trims a token before using it, so the
    // trimmed value is the one that can show up in output.
    for (const v of [value, value.trim()]) {
      if (v.trim().length >= MIN_SECRET_LENGTH) values.add(v);
    }
  }
  return [...values];
}

// Returns a function that replaces every occurrence of every secret in a
// string. Each secret is also matched in its JSON-escaped form, so a value
// containing a quote or a backslash is caught inside --format json output
// too, and the replacement never breaks the JSON.
export function makeRedactor(secrets) {
  const needles = new Set();
  for (const s of secrets) {
    needles.add(s);
    needles.add(JSON.stringify(s).slice(1, -1));
  }
  // Longest first, so a secret that contains another is replaced whole.
  const ordered = [...needles].filter((n) => n.length > 0).sort((a, b) => b.length - a.length);
  if (ordered.length === 0) return (text) => text;
  return (text) => {
    let out = String(text);
    for (const needle of ordered) out = out.split(needle).join(REDACTED);
    return out;
  };
}

// Shortens text for a message without ever cutting a secret in half: the
// whole text is cleaned first, then reshaped (first line, collapsed
// whitespace), cleaned again in case reshaping joined a secret together,
// and only then cut. Every truncation of text that can hold a secret or
// model output goes through here. clean is the redactor (and, for model
// text, the scrub) to apply.
export function excerpt(text, { clean, limit, firstLine = false, collapse = false }) {
  let out = clean(String(text));
  if (firstLine) out = out.split("\n")[0];
  if (collapse) out = out.replace(/\s+/g, " ").trim();
  out = clean(out);
  return out.length > limit ? `${out.slice(0, limit)}...` : out;
}

// A writable-like object that redacts everything written to stream.
export function redactingStream(stream, redact) {
  return { write: (chunk) => stream.write(redact(String(chunk))) };
}

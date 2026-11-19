// Normalising Codex's raw findings into the tool's own shape:
// { path, start_line, end_line, priority, title, body, fingerprint }.

import { createHash } from "node:crypto";
import { isAbsolute, posix, sep } from "node:path";

export const PRIORITIES = Object.freeze(["P0", "P1", "P2", "P3"]);

const PRIORITY_TAG = /^\[(P\d+)\]\s*/;
const LOCATION = /^(.*?):(\d+)(?:-(\d+))?$/;

export class FindingError extends Error {}

// Splits "[P2] Title" into a priority and a title. A priority outside P0 to
// P3, or none at all, is an error: it fails the run.
export function splitPriority(rawTitle) {
  const m = PRIORITY_TAG.exec(rawTitle);
  if (!m) throw new FindingError(`finding has no priority label: "${rawTitle}"`);
  if (!PRIORITIES.includes(m[1])) {
    throw new FindingError(`finding has priority ${m[1]}, outside ${PRIORITIES[0]} to ${PRIORITIES.at(-1)}`);
  }
  const title = rawTitle.slice(m[0].length).trim();
  if (title === "") throw new FindingError("finding has an empty title");
  return { priority: m[1], title };
}

// "path:12-14", "path:12" or "path". Returns line numbers as integers or
// null when there is no range.
export function parseLocation(location) {
  const m = LOCATION.exec(location);
  if (!m) return { path: location, start_line: null, end_line: null };
  const start = Number(m[2]);
  const end = m[3] === undefined ? start : Number(m[3]);
  if (start < 1 || end < start) throw new FindingError(`finding has an invalid line range: ${location}`);
  return { path: m[1], start_line: start, end_line: end };
}

// Makes a path repository-relative with forward slashes. Codex reports
// absolute paths inside the worktree; roots lists every spelling of the
// worktree path (for example with and without /private on macOS).
// Characters no path from Codex may contain: a newline or any other control
// character, or an angle bracket (which could open markup such as a
// hidden comment once the path is posted).
function unsafePath(path) {
  for (const ch of path) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f || ch === "<" || ch === ">") return true;
  }
  return false;
}

export function relativePath(path, roots) {
  if (unsafePath(path)) {
    throw new FindingError(`finding has a path with a control character or an angle bracket: ${JSON.stringify(path)}`);
  }
  let p = path;
  if (isAbsolute(p)) {
    const root = roots.find((r) => p.startsWith(r.endsWith(sep) ? r : r + sep));
    if (!root) throw new FindingError(`finding points outside the reviewed tree: ${path}`);
    p = p.slice(root.length).replace(/^[/\\]+/, "");
  }
  p = posix.normalize(p.split(sep).join("/"));
  if (p === "" || p === "." || p.startsWith("../") || p === "..") {
    throw new FindingError(`finding has an invalid path: ${path}`);
  }
  return p;
}

export function normaliseTitle(title) {
  return title.trim().replace(PRIORITY_TAG, "").trim().replace(/\s+/g, " ").toLowerCase();
}

// The text of the flagged lines, with trailing whitespace dropped from each.
export function flaggedText(fileContent, start, end) {
  if (fileContent === null || start === null) return "";
  return fileContent.split(/\r?\n/).slice(start - 1, end).map((l) => l.trimEnd()).join("\n");
}

// Hashes the path, the normalised title and the flagged text. Line numbers
// are left out on purpose so a finding keeps its fingerprint when an
// unrelated edit moves it up or down.
export function fingerprint({ path, title, text }) {
  return createHash("sha256")
    .update(["codex-mr-review/v1", path, normaliseTitle(title), text].join("\0"))
    .digest("hex");
}

// raw: { rawTitle, location, body } from parseReviewText.
// readFile(relativePath) returns the file's text at the reviewed head, or
// null when it does not exist there.
export function normaliseFinding(raw, { roots, readFile }) {
  const { priority, title } = splitPriority(raw.rawTitle);
  const loc = parseLocation(raw.location);
  const path = relativePath(loc.path, roots);
  const text = flaggedText(readFile(path), loc.start_line, loc.end_line);
  return {
    path,
    start_line: loc.start_line,
    end_line: loc.end_line,
    priority,
    title,
    body: raw.body,
    fingerprint: fingerprint({ path, title, text }),
  };
}

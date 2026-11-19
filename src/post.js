// Posting a completed review to a GitLab merge request: one thread per new
// finding, a reply and a reopen for a resolved finding that is back, then
// the summary note with the marker. Also the failure note.
//
// The marker contract is docs/contract.md. The marker is written here,
// from a sha the caller took from the CI environment or the checkout, and
// only after every finding has been posted.

import { excerpt } from "./redact.js";
import { renderFinding, renderSummary } from "./render.js";

export const MARKER_PREFIX = "<!-- phases:review";
const FINGERPRINT_PREFIX = "<!-- codex-mr-review:fingerprint";
const REOPENED_PREFIX = "<!-- codex-mr-review:reopened";
const FINGERPRINT_RE = /<!-- codex-mr-review:fingerprint ([0-9a-f]{64}) -->/;
const SHA_RE = /^[0-9a-f]{40}$/;
const REVIEWER_RE = /^[a-z0-9-]+$/;
// A position GitLab will not take comes back as a 400 (or, on some
// versions, a 422). Anything else is a real failure.
const POSITION_REJECTED = new Set([400, 422]);

export function marker(reviewer, sha) {
  if (!REVIEWER_RE.test(reviewer)) throw new Error(`invalid reviewer name ${reviewer}`);
  if (!SHA_RE.test(sha)) throw new Error(`invalid marker sha ${sha}`);
  return `<!-- phases:review v=1 reviewer=${reviewer} sha=${sha} -->`;
}

// Removes the marker prefix, and the prefixes of this tool's own hidden
// comments, from text that came from the model. Repeats until nothing is
// left, so a split prefix cannot reassemble itself.
export function scrubModelText(text) {
  let out = String(text);
  for (;;) {
    const next = [MARKER_PREFIX, FINGERPRINT_PREFIX, REOPENED_PREFIX].reduce((s, p) => s.split(p).join(""), out);
    if (next === out) return out;
    out = next;
  }
}

// Scrubs every string in a review, whatever field it is in, so a field
// added later cannot bypass it. The tool's own fields (shas, fingerprints,
// versions) contain no prefix and pass through unchanged. The CLI calls
// this once on each review, before anything is printed or posted.
export function scrubReview(value) {
  if (typeof value === "string") return scrubModelText(value);
  if (Array.isArray(value)) return value.map(scrubReview);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubReview(v)]));
  }
  return value;
}

function fingerprintComment(fp) {
  return `<!-- codex-mr-review:fingerprint ${fp} -->`;
}

// The inline thread body: the phase 9 rendering, then the hidden
// fingerprint.
export function inlineBody(finding) {
  return `${renderFinding(finding)}\n${fingerprintComment(finding.fingerprint)}\n`;
}

// The general thread used when GitLab rejects the position: the same
// rendering under a citation of the location, so it is still findable.
export function fallbackBody(finding) {
  const where = finding.start_line === null
    ? finding.path
    : `${finding.path}:${finding.start_line === finding.end_line ? finding.start_line : `${finding.start_line}-${finding.end_line}`}`;
  return `\`${where}\`\n\n${inlineBody(finding)}`;
}

export function reopenBody(sha) {
  return `Still present at \`${sha}\`.\n\n<!-- codex-mr-review:reopened -->\n`;
}

const PRIORITY_ORDER = ["P0", "P1", "P2", "P3"];

function countLine(findings) {
  const counts = PRIORITY_ORDER
    .map((p) => [p, findings.filter((f) => f.priority === p).length])
    .filter(([, n]) => n > 0)
    .map(([p, n]) => `${n} ${p}`);
  return counts.length === 0 ? "**Findings:** none" : `**Findings:** ${counts.join(", ")}`;
}

// The summary note: the phase 9 summary (heading, sentence, explanation,
// AGENTS.md note, reviewed commit), the counts, what was not posted again,
// and the marker on the last line.
export function summaryBody(review, { sha, reviewer, notReposted, reopened }) {
  const parts = [renderSummary({ ...review, head: sha }).trimEnd(), "", countLine(review.findings)];
  if (notReposted > 0) {
    parts.push("", `${notReposted} ${notReposted === 1 ? "finding was" : "findings were"} already posted by an earlier review and ${notReposted === 1 ? "was" : "were"} not posted again.`);
  }
  if (reopened > 0) {
    parts.push("", `${reopened} resolved ${reopened === 1 ? "thread was" : "threads were"} reopened because the finding is still present.`);
  }
  parts.push("", marker(reviewer, sha));
  return `${parts.join("\n")}\n`;
}

// redact is the secret redactor. The whole error is scrubbed and redacted
// before its first line is taken and cut.
export function failureBody(error, redact = (s) => s) {
  const first = excerpt(error, { clean: (s) => redact(scrubModelText(s)), limit: 300, firstLine: true });
  return `### \u{1F4A1} Codex Review\n\nThe review did not complete: ${first}\n`;
}

// What this tool has already said about each fingerprint, read from
// threads started by its own account. Threads anyone else started are
// ignored, so a pasted fingerprint cannot hide a finding.
export function indexThreads(discussions, selfId) {
  const byFingerprint = new Map();
  for (const d of discussions) {
    const notes = d.notes ?? [];
    const first = notes[0];
    if (!first || first.author?.id !== selfId) continue;
    const m = FINGERPRINT_RE.exec(first.body ?? "");
    if (!m || byFingerprint.has(m[1])) continue;
    byFingerprint.set(m[1], {
      id: d.id,
      resolved: first.resolved === true,
      reopenedBefore: notes.some((n) => n.author?.id === selfId && (n.body ?? "").includes(REOPENED_PREFIX)),
    });
  }
  return byFingerprint;
}

// review: the phase 9 review object. position(finding) returns the text
// position fields for a finding, or null when there is none to try.
// Returns counts of what happened. Throws GitLabError on a failure that is
// not a rejected position, before the summary is posted.
export async function postReview(client, review, {
  sha, reviewer, cleanEmoji = false, selfId, diffRefs, position, log = () => {},
}) {
  // review has already been through scrubReview (see the CLI).
  const clean = review;
  const threads = indexThreads(await client.listDiscussions(), selfId);
  const seen = new Set();
  const result = { inline: 0, general: 0, notReposted: 0, reopened: 0 };

  for (const finding of clean.findings) {
    if (seen.has(finding.fingerprint)) {
      result.notReposted += 1;
      continue;
    }
    seen.add(finding.fingerprint);
    const existing = threads.get(finding.fingerprint);
    if (existing) {
      if (existing.resolved && !existing.reopenedBefore) {
        // Reopen first. The reply carries the sentinel that stops later
        // reopens, so it is posted only once the reopen has succeeded; a
        // failed reopen leaves the thread as it was, to be retried.
        await client.setDiscussionResolved(existing.id, false);
        await client.replyToDiscussion(existing.id, reopenBody(sha));
        result.reopened += 1;
        log(`reopened the thread for ${finding.path}: ${finding.title}`);
      } else {
        result.notReposted += 1;
        log(`already posted, not posted again: ${finding.path}: ${finding.title}`);
      }
      continue;
    }
    const pos = diffRefs && finding.start_line !== null ? position(finding) : null;
    if (pos) {
      try {
        await client.createDiscussion(inlineBody(finding), {
          position_type: "text",
          base_sha: diffRefs.base_sha,
          start_sha: diffRefs.start_sha,
          head_sha: diffRefs.head_sha,
          ...pos,
        });
        result.inline += 1;
        log(`posted an inline thread on ${finding.path}:${pos.new_line}`);
        continue;
      } catch (err) {
        if (!POSITION_REJECTED.has(err.status)) throw err;
        log(`GitLab rejected the position for ${finding.path}:${pos.new_line} (${err.status}); posting a general thread`);
      }
    }
    await client.createDiscussion(fallbackBody(finding));
    result.general += 1;
    log(`posted a general thread for ${finding.path}`);
  }

  await client.createNote(summaryBody(clean, { sha, reviewer, notReposted: result.notReposted, reopened: result.reopened }));
  log(`posted the summary note with the marker for ${sha}`);

  if (cleanEmoji && clean.findings.length === 0) {
    try {
      await client.awardEmoji("thumbsup");
      log("added a thumbs up");
    } catch (err) {
      // Decoration only: the marker is the proof, and it is already posted.
      log(`could not add a thumbs up: ${err.message}`);
    }
  }
  return result;
}

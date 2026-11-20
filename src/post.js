// Posting a completed review to a GitLab merge request: one thread per new
// finding, a reply and a reopen for a resolved finding that is back, then
// the summary note with the marker. Also the failure note.
//
// The marker contract is docs/contract.md. The marker is written here,
// from a sha the caller took from the CI environment or the checkout, and
// only after every finding has been posted. Every note also carries the
// reviewer stamp, written here from --reviewer, so a reader on the same
// account can tell this tool's notes from a person's.

import { excerpt } from "./redact.js";
import { renderFinding, renderSummary } from "./render.js";

// The contract reserves this whole prefix: the marker, the reviewer stamp
// and the consumer stamp all start with it, and model text never may.
export const RESERVED_PREFIX = "<!-- phases:";
// The contract's reserved consumer stamp. A note carrying it was written
// by something reading the merge request, never by this tool, whatever
// account posted it.
const CONSUMER_STAMP_PREFIX = "<!-- phases:driver";
const FINGERPRINT_PREFIX = "<!-- codex-mr-review:fingerprint";
const REOPENED_PREFIX = "<!-- codex-mr-review:reopened";
// What the scrub removes, longest first. The reserved prefix alone covers
// everything; the known longer forms go first so a forged marker or stamp
// loses its name as well, and the result reads as it did at 0.1.0.
const SCRUBBED_PREFIXES = Object.freeze([
  "<!-- phases:reviewer",
  "<!-- phases:review",
  CONSUMER_STAMP_PREFIX,
  RESERVED_PREFIX,
  FINGERPRINT_PREFIX,
  REOPENED_PREFIX,
]);
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

// The reviewer stamp on every note the tool posts. It says who wrote the
// note, not that a review completed: only the marker says that.
export function stamp(reviewer) {
  if (!REVIEWER_RE.test(reviewer)) throw new Error(`invalid reviewer name ${reviewer}`);
  return `<!-- phases:reviewer v=1 reviewer=${reviewer} -->`;
}

// Removes the contract's reserved prefix, which covers the marker and both
// stamps, and the prefixes of this tool's own hidden comments, from text
// that came from the model. Each step removes the longest prefix still
// present and starts again, until none is left, so a split prefix cannot
// reassemble itself. Every step makes the text shorter, so it ends.
export function scrubModelText(text) {
  let out = String(text);
  for (;;) {
    const found = SCRUBBED_PREFIXES.find((p) => out.includes(p));
    if (found === undefined) return out;
    out = out.split(found).join("");
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
// fingerprint, then the reviewer stamp.
export function inlineBody(finding, reviewer) {
  return `${renderFinding(finding)}\n${fingerprintComment(finding.fingerprint)}\n${stamp(reviewer)}\n`;
}

// The general thread used when GitLab rejects the position: the same
// rendering under a citation of the location, so it is still findable.
export function fallbackBody(finding, reviewer) {
  const where = finding.start_line === null
    ? finding.path
    : `${finding.path}:${finding.start_line === finding.end_line ? finding.start_line : `${finding.start_line}-${finding.end_line}`}`;
  return `\`${where}\`\n\n${inlineBody(finding, reviewer)}`;
}

export function reopenBody(sha, reviewer) {
  return `Still present at \`${sha}\`.\n\n<!-- codex-mr-review:reopened -->\n${stamp(reviewer)}\n`;
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
// then the reviewer stamp and the marker on the last two lines.
// markerWithheld: { reviewed, expected } when the reviewed commit is not
// the pipeline's; the summary then names the reviewed commit and says why
// there is no marker instead of carrying one, and the stamp is last.
export function summaryBody(review, { sha, reviewer, notReposted, reopened, markerWithheld = null }) {
  const shown = markerWithheld ? markerWithheld.reviewed : sha;
  const parts = [renderSummary({ ...review, head: shown }).trimEnd(), "", countLine(review.findings)];
  if (notReposted > 0) {
    parts.push("", `${notReposted} ${notReposted === 1 ? "finding was" : "findings were"} already posted by an earlier review and ${notReposted === 1 ? "was" : "were"} not posted again.`);
  }
  if (reopened > 0) {
    parts.push("", `${reopened} resolved ${reopened === 1 ? "thread was" : "threads were"} reopened because the finding is still present.`);
  }
  if (markerWithheld) {
    parts.push("", `No review marker was posted: the reviewed commit \`${markerWithheld.reviewed.slice(0, 10)}\` is not the pipeline's commit \`${markerWithheld.expected.slice(0, 10)}\`.`, "", stamp(reviewer));
  } else {
    parts.push("", stamp(reviewer), marker(reviewer, sha));
  }
  return `${parts.join("\n")}\n`;
}

// redact is the secret redactor. The whole error is scrubbed and redacted
// before its first line is taken and cut. The note carries the reviewer
// stamp and never a marker.
export function failureBody(error, { reviewer, redact = (s) => s }) {
  const first = excerpt(error, { clean: (s) => redact(scrubModelText(s)), limit: 300, firstLine: true });
  return `### \u{1F4A1} Codex Review\n\nThe review did not complete: ${first}\n\n${stamp(reviewer)}\n`;
}

function hasConsumerStamp(note) {
  return (note?.body ?? "").includes(CONSUMER_STAMP_PREFIX);
}

// What this tool has already said about each fingerprint, read from
// threads started by its own account. Threads anyone else started are
// ignored, so a pasted fingerprint cannot hide a finding. On one account
// the same account also posts as a person and as a consumer, so a note
// carrying the contract's reserved consumer stamp is never the tool's: a
// thread it starts is skipped, and a reply carrying it is not a reopen.
// A thread posted by 0.1.0 has a fingerprint and no reviewer stamp, and is
// still the tool's, so upgrading re-posts nothing.
export function indexThreads(discussions, selfId) {
  const byFingerprint = new Map();
  for (const d of discussions) {
    const notes = d.notes ?? [];
    const first = notes[0];
    if (!first || first.author?.id !== selfId || hasConsumerStamp(first)) continue;
    const m = FINGERPRINT_RE.exec(first.body ?? "");
    if (!m || byFingerprint.has(m[1])) continue;
    byFingerprint.set(m[1], {
      id: d.id,
      resolved: first.resolved === true,
      reopenedBefore: notes.some((n) => n.author?.id === selfId && !hasConsumerStamp(n) && (n.body ?? "").includes(REOPENED_PREFIX)),
    });
  }
  return byFingerprint;
}

// review: the phase 9 review object. position(finding) returns the text
// position fields for a finding, or null when there is none to try.
// Returns counts of what happened. Throws GitLabError on a failure that is
// not a rejected position, before the summary is posted.
export async function postReview(client, review, {
  sha, reviewer, cleanEmoji = false, selfId, diffRefs, position, markerWithheld = null, log = () => {},
}) {
  // The reviewer name goes into every note, so it is checked before the
  // first request, not only when the marker is built.
  stamp(reviewer);
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
        await client.replyToDiscussion(existing.id, reopenBody(sha, reviewer));
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
        await client.createDiscussion(inlineBody(finding, reviewer), {
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
    await client.createDiscussion(fallbackBody(finding, reviewer));
    result.general += 1;
    log(`posted a general thread for ${finding.path}`);
  }

  await client.createNote(summaryBody(clean, { sha, reviewer, notReposted: result.notReposted, reopened: result.reopened, markerWithheld }));
  log(markerWithheld ? "posted the summary note without a marker" : `posted the summary note with the marker for ${sha}`);

  if (cleanEmoji) {
    await syncCleanEmoji(client, { clean: clean.findings.length === 0 && !markerWithheld, reviewed: review.head, selfId, log });
  }
  return result;
}

// The thumbs up says the latest review of the merge request's current head
// was clean, so it follows every review of that head: added after a clean
// one, and taken back after one with findings, a withheld marker, or a
// failure. GitLab keeps one award per account and name, so a thumbs up left
// by an earlier clean review would otherwise outlive what came after it.
//
// The award is merge-request wide but a review is of one commit, so nothing
// changes unless the reviewed commit is still the head when the review ends:
// a retried pipeline for an older commit, or a review overtaken by a push,
// must not add the thumbs up back or take away the current head's. The head
// is read again here, since a review takes minutes and the one read at the
// start may be stale.
//
// Only the token's own thumbs up is ever touched. Decoration only: the
// marker is the proof, so every failure here is logged and nothing more.
export async function syncCleanEmoji(client, { clean, reviewed, selfId, log }) {
  let own;
  try {
    const mr = await client.getMergeRequest();
    const head = mr?.sha ?? mr?.diff_refs?.head_sha;
    if (head !== reviewed) {
      log(`the merge request has moved on to ${head ? head.slice(0, 10) : "an unknown head"}; reactions are left as they are`);
      return;
    }
    own = (await client.listAwardEmoji()).filter((a) => a.name === "thumbsup" && a.user?.id === selfId);
  } catch (err) {
    log(`could not read the merge request's reactions: ${err.message}`);
    return;
  }
  if (clean) {
    if (own.length > 0) {
      log("the thumbs up from an earlier clean review is still there");
      return;
    }
    try {
      await client.awardEmoji("thumbsup");
      log("added a thumbs up");
    } catch (err) {
      log(`could not add a thumbs up: ${err.message}`);
    }
    return;
  }
  for (const award of own) {
    try {
      await client.removeAwardEmoji(award.id);
      log("removed the thumbs up left by an earlier clean review");
    } catch (err) {
      log(`could not remove the thumbs up left by an earlier clean review: ${err.message}`);
    }
  }
}

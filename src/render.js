// Rendering findings and the review summary in cloud Codex's layout.
//
// The reference is a real cloud Codex review, recorded in
// test/fixtures/cloud-codex/ and described in docs/output-format.md.

// P2 is yellow in the recorded reference. The other colours have not been
// observed on a real review yet; see docs/output-format.md.
export const BADGE_COLORS = Object.freeze({ P0: "red", P1: "orange", P2: "yellow", P3: "green" });

export function badge(priority) {
  const color = BADGE_COLORS[priority];
  if (!color) throw new Error(`no badge for priority ${priority}`);
  return `<sub><sub>![${priority} Badge](https://img.shields.io/badge/${priority}-${color}?style=flat)</sub></sub>`;
}

// One finding as the body of an inline comment: the badge and the title in
// bold on the first line, a blank line, then the body.
export function renderFinding(finding) {
  return `**${badge(finding.priority)}  ${finding.title}**\n\n${finding.body}\n`;
}

export function formatLocation(finding) {
  if (finding.start_line === null) return finding.path;
  return `${finding.path}:${finding.start_line}-${finding.end_line}`;
}

// The one summary for the review, modelled on the body of cloud Codex's
// review.
export function renderSummary(review) {
  const parts = ["### \u{1F4A1} Codex Review", ""];
  parts.push(review.findings.length > 0
    ? "Here are some automated review suggestions for this merge request."
    : "Codex found no issues in this change.");
  if (review.explanation) parts.push("", review.explanation);
  if (review.agents_md_changed) {
    parts.push("", "This change edits `AGENTS.md`. The review followed the base branch's copy, not the edited one.");
  }
  parts.push("", `**Reviewed commit:** \`${review.head.slice(0, 10)}\``);
  return `${parts.join("\n")}\n`;
}

// The --format text output: each finding under its location, then the
// summary.
export function renderText(review) {
  const blocks = review.findings.map((f) => `${formatLocation(f)}\n\n${renderFinding(f)}`);
  blocks.push(renderSummary(review));
  return blocks.join("\n---\n\n");
}

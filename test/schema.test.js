import { test } from "node:test";
import assert from "node:assert/strict";

import { validate } from "../src/schema.js";
import { readOutputSchema } from "../src/cli.js";

const SHA = "a".repeat(40);

function sample() {
  return {
    version: 1,
    status: "completed",
    base: SHA,
    head: "b".repeat(40),
    codex_version: "0.147.0",
    model: null,
    reasoning_effort: "high",
    agents_md_changed: false,
    explanation: "One bug.",
    findings: [{
      path: "src/stats.js", start_line: 26, end_line: 26, priority: "P1",
      title: "T", body: "B", fingerprint: "c".repeat(64),
    }],
  };
}

test("a well-formed review validates against the checked-in schema", () => {
  assert.deepEqual(validate(readOutputSchema(), sample()), []);
  const noRange = sample();
  noRange.findings[0].start_line = null;
  noRange.findings[0].end_line = null;
  assert.deepEqual(validate(readOutputSchema(), noRange), []);
  assert.deepEqual(validate(readOutputSchema(), { ...sample(), model: "some-model", reasoning_effort: "max" }), []);
});

for (const [name, mutate, expected] of [
  ["a priority outside P0 to P3", (r) => { r.findings[0].priority = "P4"; }, /findings\/0\/priority/],
  ["a short sha", (r) => { r.head = "abc"; }, /\/head: does not match/],
  ["a missing field", (r) => { delete r.findings[0].fingerprint; }, /missing required property "fingerprint"/],
  ["an extra field", (r) => { r.extra = 1; }, /unexpected property "extra"/],
  ["a wrong type", (r) => { r.agents_md_changed = "no"; }, /expected boolean, got string/],
  ["a fractional line", (r) => { r.findings[0].start_line = 1.5; }, /expected integer or null, got number/],
  ["a zero line", (r) => { r.findings[0].end_line = 0; }, /less than 1/],
  ["an empty title", (r) => { r.findings[0].title = ""; }, /shorter than 1/],
  ["an unknown reasoning effort", (r) => { r.reasoning_effort = "extreme"; }, /reasoning_effort/],
  ["an empty model name", (r) => { r.model = ""; }, /\/model: shorter than 1/],
  ["another version", (r) => { r.version = 2; }, /\/version: expected 1/],
  ["findings that are not a list", (r) => { r.findings = {}; }, /expected array/],
]) {
  test(`the schema rejects ${name}`, () => {
    const r = sample();
    mutate(r);
    const errors = validate(readOutputSchema(), r);
    assert.ok(errors.some((e) => expected.test(e)), errors.join("\n"));
  });
}

test("the validator refuses keywords outside its subset", () => {
  assert.throws(() => validate({ oneOf: [] }, 1), /not supported/);
  assert.throws(() => validate({ additionalProperties: true }, {}), /only additionalProperties: false/);
});

test("the validator handles nested items and integer as a number", () => {
  const schema = { type: "array", items: { type: "number", minimum: 0 } };
  assert.deepEqual(validate(schema, [1, 2.5]), []);
  assert.deepEqual(validate(schema, [1, -1]), ["/1: less than 0"]);
});

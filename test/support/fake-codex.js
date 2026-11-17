// A stand-in for the codex executable that replays recorded output, so the
// tests need no Codex install and no login.
//
// It is started through a small sh wrapper (see makeFakeCodex in
// helpers.js) that passes a scenario file as the first argument. The
// scenario says what to print and how to exit:
//
//   version       text for `codex --version`
//   events        path of a JSONL file to replay on stdout
//   lastMessage   path of a text file to write to --output-last-message
//   recordedRoot  worktree path in the recording, replaced with the cwd
//   exitCode      exit status (default 0)
//   sleepMs       wait this long before printing anything
//   stderr        text to print on stderr
//   record        directory to write what the fake saw: env.json,
//                 args.json, cwd.txt and agents.json

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [scenarioPath, ...args] = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));

if (args[0] === "--version") {
  process.stdout.write(`${scenario.version ?? "codex-cli 0.147.0"}\n`);
  process.exit(0);
}

const cwd = process.cwd();
const replay = (text) => (scenario.recordedRoot ? text.split(scenario.recordedRoot).join(cwd) : text);

if (scenario.record) {
  const readGuidance = (name) => (existsSync(name) ? readFileSync(name, "utf8") : null);
  writeFileSync(join(scenario.record, "env.json"), JSON.stringify(process.env, null, 2));
  writeFileSync(join(scenario.record, "args.json"), JSON.stringify(args));
  writeFileSync(join(scenario.record, "cwd.txt"), cwd);
  writeFileSync(join(scenario.record, "agents.json"), JSON.stringify({
    "AGENTS.md": readGuidance("AGENTS.md"),
    "AGENTS.override.md": readGuidance("AGENTS.override.md"),
  }));
}

await new Promise((resolve) => setTimeout(resolve, scenario.sleepMs ?? 0));

if (scenario.events) process.stdout.write(replay(readFileSync(scenario.events, "utf8")));
if (scenario.stderr) process.stderr.write(scenario.stderr);

const outAt = args.indexOf("--output-last-message");
if (scenario.lastMessage && outAt !== -1) {
  writeFileSync(args[outAt + 1], replay(readFileSync(scenario.lastMessage, "utf8")));
}

process.exitCode = scenario.exitCode ?? 0;

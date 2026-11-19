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
//                 args.json, cwd.txt, agents.json, guidance.json, and the
//                 checkout's git config as gitconfig.txt (the file) and
//                 gitconfig-list.txt (`git config --list`, every scope)
//   stubbornPid   path: start a descendant that ignores SIGTERM and does
//                 not hold the pipes, and write its pid there

import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
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
  // Every guidance file in the tree, seen without following symlinks.
  const guidance = {};
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir)) {
      if (name === ".git") continue;
      const path = join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      const st = lstatSync(path);
      if (st.isDirectory()) walk(path, relPath);
      else if (name === "AGENTS.md" || name === "AGENTS.override.md") {
        guidance[relPath] = st.isSymbolicLink()
          ? { symlink: readlinkSync(path) }
          : { file: readFileSync(path, "utf8") };
      }
    }
  };
  walk(cwd, "");
  writeFileSync(join(scenario.record, "guidance.json"), JSON.stringify(guidance));
  const gitDir = spawnSync("git", ["rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(scenario.record, "gitconfig.txt"), readFileSync(join(gitDir, "config"), "utf8"));
  writeFileSync(join(scenario.record, "gitconfig-list.txt"), spawnSync("git", ["config", "--list", "--show-origin"], { encoding: "utf8" }).stdout);
}

if (scenario.stubbornPid) {
  const script = `process.on("SIGTERM", () => {});
require("fs").writeFileSync(${JSON.stringify(scenario.stubbornPid)}, String(process.pid));
setInterval(() => {}, 1000);`;
  spawn(process.execPath, ["-e", script], { stdio: "ignore" }).unref();
  while (!existsSync(scenario.stubbornPid)) await new Promise((resolve) => setTimeout(resolve, 20));
}

await new Promise((resolve) => setTimeout(resolve, scenario.sleepMs ?? 0));

if (scenario.events) process.stdout.write(replay(readFileSync(scenario.events, "utf8")));
if (scenario.stderr) process.stderr.write(scenario.stderr);

const outAt = args.indexOf("--output-last-message");
if (scenario.lastMessage && outAt !== -1) {
  writeFileSync(args[outAt + 1], replay(readFileSync(scenario.lastMessage, "utf8")));
}

process.exitCode = scenario.exitCode ?? 0;

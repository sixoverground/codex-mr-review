// The one place src/ runs a child process synchronously.
//
// Node's default maxBuffer for execFileSync is 1 MiB, so reading a larger
// blob failed with ENOBUFS. Every synchronous call goes through runSync,
// which sets a generous limit and turns an overflow into a clear error.

import { spawnSync } from "node:child_process";

export const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

export class ExecError extends Error {}

// Runs file with args and returns { status, signal, stdout, stderr }.
// stdout and stderr are strings, or Buffers with encoding "buffer".
// Throws ExecError when the program cannot start or its output exceeds
// maxBuffer.
export function runSync(file, args, {
  cwd,
  env,
  encoding = "utf8",
  timeout,
  maxBuffer = MAX_OUTPUT_BYTES,
} = {}) {
  const r = spawnSync(file, args, {
    cwd,
    env,
    encoding,
    timeout,
    maxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error) {
    if (r.error.code === "ENOBUFS") {
      throw new ExecError(`${file} ${args[0] ?? ""} printed more than ${maxBuffer} bytes, the most this tool reads`);
    }
    throw new ExecError(`could not run ${file}: ${r.error.message}`);
  }
  return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
}

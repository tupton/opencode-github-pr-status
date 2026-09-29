import { execFile } from "node:child_process";

import type { RunCommand } from "./status";

const COMMAND_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export const runCommand: RunCommand = (command, args, directory, signal) => new Promise((resolve) => {
  try {
    execFile(
      command,
      args,
      {
        cwd: directory,
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: COMMAND_TIMEOUT_MS,
        signal,
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          missing: Boolean(error && "code" in error && error.code === "ENOENT"),
          timedOut: Boolean(error && "killed" in error && error.killed),
        });
      },
    );
  } catch (error) {
    resolve({
      ok: false,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      missing: error instanceof Error && "code" in error && error.code === "ENOENT",
      timedOut: false,
    });
  }
});

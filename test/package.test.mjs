import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Host } from "@opencode/plugin/host";

const directory = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("exports only a terminal plugin", () => {
  assert.equal(manifest.exports["./tui"], "./src/tui.tsx");
  assert.equal(manifest.exports["."], undefined);
  assert.equal(manifest.exports["./server"], undefined);

  const entrypoints = Host.resolve({ directory, name: manifest.name });
  assert.equal(entrypoints.server, undefined);
  assert.match(entrypoints.tui ?? "", /src\/tui\.tsx$/);

  const result = spawnSync("bun", ["-e", `
    import { Host } from "@opencode/plugin/host";
    const { server, tui } = Host.resolve({ directory: process.cwd(), name: "opencode-github-pr-status" });
    if (server || !tui) throw new Error("Not a CLI-only plugin");
    const module = await Host.load(tui);
    if (module.default?.id !== "github-pr-status") throw new Error("Unexpected plugin ID");
  `], {
    cwd: directory,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test("ships the plugin, store, and parser in the npm package", () => {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: directory,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const files = JSON.parse(result.stdout)[0].files.map(({ path }) => path);
  assert.ok(files.includes("src/tui.tsx"));
  assert.ok(files.includes("src/store.mjs"));
  assert.ok(files.includes("src/status.mjs"));
  assert.ok(!files.some((path) => path.startsWith("test/")));
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Host } from "@opencode/plugin/host";

const directory = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("exports only a terminal plugin", () => {
  assert.equal(manifest.exports["./tui"], "./dist/tui.js");
  assert.equal(manifest.exports["."], undefined);
  assert.equal(manifest.exports["./server"], undefined);

  const entrypoints = Host.resolve({ directory, name: manifest.name });
  assert.equal(entrypoints.server, undefined);
  assert.match(entrypoints.tui ?? "", /dist\/tui\.js$/);

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

test("ships compiled plugin code instead of source TSX", () => {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: directory,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const files = JSON.parse(result.stdout)[0].files.map(({ path }) => path);
  assert.ok(files.includes("dist/tui.js"));
  assert.ok(!files.some((path) => path.startsWith("src/")));
  assert.ok(!files.some((path) => path.startsWith("test/")));
});

test("renders the built TUI from an isolated node_modules directory", () => {
  const fixture = mkdtempSync(join(directory, "node_modules", ".package-render-"));
  try {
    const installed = join(fixture, "node_modules", manifest.name);
    mkdirSync(join(installed, "dist"), { recursive: true });
    writeFileSync(join(installed, "package.json"), JSON.stringify({ type: "module" }));
    cpSync(join(directory, "dist", "tui.js"), join(installed, "dist", "tui.js"));

    // Reproduce npm's separate OpenTUI copy alongside the package's peers.
    const peer = join(fixture, "node_modules", "@opentui", "solid");
    mkdirSync(join(fixture, "node_modules", "@opentui"), { recursive: true });
    cpSync(realpathSync(join(directory, "node_modules", "@opentui", "solid")), peer, { recursive: true });

    const result = spawnSync("bun", [
      "--preload", "@opentui/solid/preload",
      "test/packaged-render.tsx", join(installed, "dist", "tui.js"),
    ], { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

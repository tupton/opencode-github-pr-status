import assert from "node:assert/strict";
import test from "node:test";

import { createPullRequestStore } from "../src/store.mjs";

const directory = "/project";
const pr = (number) => JSON.stringify({
  number,
  url: `https://github.com/example/project/pull/${number}`,
  isDraft: false,
  state: "OPEN",
  reviewDecision: "",
  reviewRequests: [],
  statusCheckRollup: [],
});
const ok = (stdout) => ({ ok: true, stdout, stderr: "", missing: false, timedOut: false });
const error = (stderr, missing = false) => ({ ok: false, stdout: "", stderr, missing, timedOut: false });

function createFixture(responses) {
  const calls = [];
  const controller = new AbortController();
  const api = { ui: { toast: { show() {} } } };
  const runCommand = async (command, args, cwd) => {
    calls.push({ command, args, cwd });
    const response = responses.shift();
    assert.ok(response, `Unexpected ${command} command`);
    return response;
  };
  const store = createPullRequestStore(api, controller.signal, runCommand);
  return { store, calls, dispose: () => { controller.abort(); store.dispose(); } };
}

test("branch changes replace the current PR with the new branch's PR", async () => {
  const fixture = createFixture([ok("feature-a\n"), ok(pr(11)), ok("feature-b\n"), ok(pr(22))]);
  try {
    const observed = [];
    const unsubscribe = fixture.store.subscribe(directory, (result) => observed.push(result));
    await fixture.store.refresh(directory);
    assert.equal(fixture.store.get(directory).pullRequest.number, 11);

    fixture.store.refreshAll();
    assert.deepEqual(fixture.store.get(directory), { kind: "loading" });
    const result = await fixture.store.refresh(directory);
    assert.equal(result.pullRequest.number, 22);
    assert.equal(fixture.store.get(directory).pullRequest.number, 22);
    assert.ok(observed.some((value) => value.kind === "loading"));
    unsubscribe();
  } finally {
    fixture.dispose();
  }
});

test("a refresh succeeds after gh becomes available", async () => {
  const fixture = createFixture([ok("feature-a\n"), error("spawn gh ENOENT", true), ok("feature-a\n"), ok(pr(11))]);
  try {
    const missing = await fixture.store.refresh(directory, true);
    assert.equal(missing.kind, "error");
    assert.equal(missing.message, "GitHub CLI is not installed");

    const recovered = await fixture.store.refresh(directory, true);
    assert.equal(recovered.kind, "pull-request");
    assert.equal(fixture.store.get(directory).pullRequest.number, 11);
    assert.equal(fixture.calls.filter(({ command }) => command === "gh").length, 2);
    assert.deepEqual(fixture.calls[3].args, [
      "pr", "view", "--json", "number,url,isDraft,state,reviewDecision,reviewRequests,statusCheckRollup",
    ]);
  } finally {
    fixture.dispose();
  }
});

test("a new branch with no PR clears the previous branch's indicator", async () => {
  const fixture = createFixture([ok("feature-a\n"), ok(pr(11)), ok("feature-b\n"), error("no pull requests found for branch feature-b")]);
  try {
    await fixture.store.refresh(directory, true);
    assert.equal(fixture.store.get(directory).pullRequest.number, 11);
    const result = await fixture.store.refresh(directory, true);
    assert.deepEqual(result, { kind: "none" });
    assert.deepEqual(fixture.store.get(directory), { kind: "none" });
  } finally {
    fixture.dispose();
  }
});

test("a command failure keeps the last PR on the same branch but not on a different branch", async () => {
  const fixture = createFixture([
    ok("feature-a\n"), ok(pr(11)),
    ok("feature-a\n"), error("HTTP 401: Bad credentials"),
    ok("feature-b\n"), error("HTTP 401: Bad credentials"),
  ]);
  try {
    await fixture.store.refresh(directory, true);
    const sameBranch = await fixture.store.refresh(directory, true);
    assert.equal(sameBranch.kind, "error");
    assert.equal(sameBranch.message, "HTTP 401: Bad credentials");
    assert.equal(sameBranch.pullRequest.number, 11);

    const differentBranch = await fixture.store.refresh(directory, true);
    assert.equal(differentBranch.kind, "error");
    assert.equal(differentBranch.pullRequest, undefined);
    assert.equal(fixture.store.get(directory).pullRequest, undefined);
  } finally {
    fixture.dispose();
  }
});

test("a failed branch lookup does not claim the previous PR is current", async () => {
  const fixture = createFixture([ok("feature-a\n"), ok(pr(11)), error("fatal: not a git repository")]);
  try {
    await fixture.store.refresh(directory, true);
    const result = await fixture.store.refresh(directory, true);
    assert.equal(result.kind, "error");
    assert.equal(result.message, "fatal: not a git repository");
    assert.equal(result.pullRequest, undefined);
    assert.equal(fixture.store.get(directory).pullRequest, undefined);
  } finally {
    fixture.dispose();
  }
});

test("overlapping forced refreshes publish only the newest branch result", async () => {
  const pending = Promise.withResolvers();
  const fixture = createFixture([ok("feature-a\n"), pending.promise, ok("feature-b\n"), ok(pr(22))]);
  try {
    const observed = [];
    const first = fixture.store.refresh(directory, true);
    const second = fixture.store.refresh(directory, true);
    const third = fixture.store.refresh(directory, true);
    assert.equal(second, third);
    const unsubscribe = fixture.store.subscribe(directory, (result) => observed.push(result));

    pending.resolve(ok(pr(11)));
    const initialCaller = await first;
    const result = await second;
    assert.equal(initialCaller.pullRequest.number, 22);
    assert.equal(result.pullRequest.number, 22);
    assert.equal(fixture.store.get(directory).pullRequest.number, 22);
    assert.ok(!observed.some((value) => value.pullRequest?.number === 11));
    unsubscribe();
  } finally {
    fixture.dispose();
  }
});

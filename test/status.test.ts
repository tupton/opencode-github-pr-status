import assert from "node:assert/strict";
import test from "node:test";

import { createPullRequestStatus } from "../src/status";
import type { CommandResult, Indicator, IndicatorResult, RunCommand } from "../src/status";

const directory = "/project";
const pr = (number: number, fields: Record<string, unknown> = {}) => JSON.stringify({
  number,
  url: `https://github.com/example/project/pull/${number}`,
  isDraft: false,
  state: "OPEN",
  mergeable: "MERGEABLE",
  reviewDecision: "",
  reviewRequests: [],
  statusCheckRollup: [],
  ...fields,
});
const ok = (stdout: string): CommandResult => ({ ok: true, stdout, stderr: "", missing: false, timedOut: false });
const error = (stderr: string, missing = false): CommandResult => ({ ok: false, stdout: "", stderr, missing, timedOut: false });

function createFixture(responses: Array<CommandResult | Promise<CommandResult>>) {
  const calls: { command: string; args: string[]; cwd: string }[] = [];
  const controller = new AbortController();
  const runCommand: RunCommand = async (command, args, cwd) => {
    calls.push({ command, args, cwd });
    const response = responses.shift();
    assert.ok(response, `Unexpected ${command} command`);
    return response;
  };
  const status = createPullRequestStatus(controller.signal, runCommand);
  return { status, calls, dispose: () => { controller.abort(); status.dispose(); } };
}

test("classifies PR lifecycle, blockers, checks, and review status into tones", async () => {
  const cases: [Record<string, unknown>, Indicator["tone"]][] = [
    [{ state: "MERGED", isDraft: true, statusCheckRollup: [{ conclusion: "FAILURE" }] }, "accent"],
    [{ state: "CLOSED", isDraft: true, statusCheckRollup: [{ conclusion: "FAILURE" }], mergeable: "CONFLICTING" }, "muted"],
    [{ isDraft: true, statusCheckRollup: [{ conclusion: "FAILURE" }] }, "error"],
    [{ isDraft: true, statusCheckRollup: [{ status: "IN_PROGRESS" }] }, "muted"],
    [{ mergeable: "CONFLICTING" }, "error"],
    [{ isDraft: true, mergeable: "CONFLICTING" }, "error"],
    [{ reviewDecision: "CHANGES_REQUESTED", statusCheckRollup: [{ status: "IN_PROGRESS" }] }, "error"],
    [{ statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "SKIPPED" }, { conclusion: "NEUTRAL" }, { status: "IN_PROGRESS" }, { conclusion: "FAILURE" }, { state: "ERROR" }] }, "error"],
    [{ statusCheckRollup: [{}] }, "neutral"],
    [{ statusCheckRollup: [null] }, "neutral"],
    [{ statusCheckRollup: [{ status: "IN_PROGRESS" }] }, "warning"],
    [{ reviewDecision: "CHANGES_REQUESTED" }, "error"],
    [{ reviewDecision: "APPROVED" }, "success"],
    [{ reviewDecision: "APPROVED", reviewRequests: [{ login: "optional-reviewer" }] }, "success"],
    [{ reviewDecision: "APPROVED", statusCheckRollup: [{ status: "IN_PROGRESS" }] }, "warning"],
    [{ reviewDecision: "APPROVED", statusCheckRollup: [{}] }, "neutral"],
    [{ reviewDecision: "REVIEW_REQUIRED" }, "warning"],
    [{ reviewRequests: [{ login: "reviewer" }] }, "warning"],
    [{}, "neutral"],
  ];

  for (const [fields, tone] of cases) {
    const fixture = createFixture([ok("feature-a\n"), ok(pr(123, fields))]);
    try {
      assert.deepEqual(await fixture.status.refresh(directory), { kind: "refreshed", message: "Refreshed PR #123" });
      assert.deepEqual(fixture.status.get(directory), { kind: "pull-request", indicator: { text: "PR #123", tone } });
    } finally {
      fixture.dispose();
    }
  }
});

test("rejects malformed GitHub responses through the status interface", async () => {
  for (const [fields, message] of [
    [{ number: "123" }, /number/],
    [{ url: "" }, /url/],
    [{ statusCheckRollup: {} }, /statusCheckRollup/],
    [{ reviewRequests: {} }, /reviewRequests/],
  ] as const) {
    const fixture = createFixture([ok("feature-a\n"), ok(pr(123, fields))]);
    try {
      const result = await fixture.status.refresh(directory);
      assert.equal(result.kind, "error");
      assert.match(result.message, message);
      assert.equal(fixture.status.get(directory).kind, "error");
    } finally {
      fixture.dispose();
    }
  }
});

test("branch changes replace the current indicator", async () => {
  const fixture = createFixture([ok("feature-a\n"), ok(pr(11)), ok("feature-b\n"), ok(pr(22))]);
  try {
    const observed: IndicatorResult[] = [];
    let unsubscribe!: () => void;
    await new Promise<void>((resolve) => {
      unsubscribe = fixture.status.subscribe(directory, (result) => {
        observed.push(result);
        if (result.kind === "pull-request") resolve();
      });
    });
    assert.deepEqual(fixture.status.get(directory), { kind: "pull-request", indicator: { text: "PR #11", tone: "neutral" } });

    fixture.status.refreshAll();
    assert.deepEqual(fixture.status.get(directory), { kind: "loading" });
    await fixture.status.refresh(directory);
    assert.deepEqual(fixture.status.get(directory), { kind: "pull-request", indicator: { text: "PR #22", tone: "neutral" } });
    assert.ok(observed.some((result) => result.kind === "loading"));
    unsubscribe();
  } finally {
    fixture.dispose();
  }
});

test("a refresh succeeds after gh becomes available", async () => {
  const fixture = createFixture([ok("feature-a\n"), error("spawn gh ENOENT", true), ok("feature-a\n"), ok(pr(11))]);
  try {
    assert.deepEqual(await fixture.status.refresh(directory), { kind: "error", message: "GitHub CLI is not installed" });
    assert.deepEqual(await fixture.status.refresh(directory), { kind: "refreshed", message: "Refreshed PR #11" });
    assert.equal(fixture.calls.filter(({ command }) => command === "gh").length, 2);
    assert.deepEqual(fixture.calls[3].args, [
      "pr", "view", "--json", "number,url,isDraft,state,mergeable,reviewDecision,reviewRequests,statusCheckRollup",
    ]);
  } finally {
    fixture.dispose();
  }
});

test("no PR clears the old indicator and Open returns an informational outcome", async () => {
  const fixture = createFixture([
    ok("feature-a\n"), ok(pr(11)),
    ok("feature-b\n"), error("no pull requests found for branch feature-b"),
    ok("feature-b\n"), error("could not find pull request"),
  ]);
  try {
    await fixture.status.refresh(directory);
    assert.deepEqual(await fixture.status.refresh(directory), { kind: "none", message: "No pull request for the current branch" });
    assert.deepEqual(fixture.status.get(directory), { kind: "none" });
    assert.deepEqual(await fixture.status.open(directory), { kind: "none", message: "No pull request for the current branch" });
  } finally {
    fixture.dispose();
  }
});

test("a same-branch refresh error shows the last known PR in neutral and keeps it openable", async () => {
  const fixture = createFixture([
    ok("feature-a\n"), ok(pr(11)),
    ok("feature-a\n"), error("HTTP 401: Bad credentials"),
    ok(""),
  ]);
  try {
    await fixture.status.refresh(directory);
    assert.deepEqual(await fixture.status.refresh(directory), { kind: "error", message: "HTTP 401: Bad credentials" });
    assert.deepEqual(fixture.status.get(directory), {
      kind: "error", message: "HTTP 401: Bad credentials", indicator: { text: "PR #11", tone: "neutral" },
    });
    // A known PR opens without another branch lookup.
    assert.deepEqual(await fixture.status.open(directory), { kind: "opened", message: "Opened PR #11" });
    assert.deepEqual(fixture.calls[4].args, ["pr", "view", "https://github.com/example/project/pull/11", "--web"]);
  } finally {
    fixture.dispose();
  }
});

test("a different branch or failed branch lookup cannot use the previous PR", async () => {
  const fixture = createFixture([
    ok("feature-a\n"), ok(pr(11)),
    ok("feature-b\n"), error("HTTP 401: Bad credentials"),
    error("fatal: not a git repository"),
  ]);
  try {
    await fixture.status.refresh(directory);
    assert.deepEqual(await fixture.status.refresh(directory), { kind: "error", message: "HTTP 401: Bad credentials" });
    assert.deepEqual(fixture.status.get(directory), { kind: "error", message: "HTTP 401: Bad credentials", indicator: undefined });
    assert.deepEqual(await fixture.status.refresh(directory), { kind: "error", message: "fatal: not a git repository" });
    assert.deepEqual(fixture.status.get(directory), { kind: "error", message: "fatal: not a git repository", indicator: undefined });
  } finally {
    fixture.dispose();
  }
});

test("Open refreshes when no PR is known and returns errors instead of showing toasts", async () => {
  const fixture = createFixture([
    ok("feature-a\n"), ok(pr(11)), error("browser failed"),
  ]);
  try {
    assert.deepEqual(await fixture.status.open(directory), { kind: "error", message: "browser failed" });
    assert.deepEqual(fixture.status.get(directory), { kind: "pull-request", indicator: { text: "PR #11", tone: "neutral" } });
  } finally {
    fixture.dispose();
  }
});

test("aborted actions return a silent cancellation outcome", async () => {
  let resolvePending!: (result: CommandResult) => void;
  const pending = new Promise<CommandResult>((resolve) => { resolvePending = resolve; });
  const fixture = createFixture([pending]);
  try {
    const refresh = fixture.status.refresh(directory);
    fixture.dispose();
    resolvePending(ok("feature-a\n"));
    assert.deepEqual(await refresh, { kind: "cancelled" });
  } finally {
    fixture.dispose();
  }
});

test("overlapping forced refreshes publish only the newest branch result", async () => {
  let resolvePending!: (result: CommandResult) => void;
  const pending = new Promise<CommandResult>((resolve) => { resolvePending = resolve; });
  const fixture = createFixture([ok("feature-a\n"), pending, ok("feature-b\n"), ok(pr(22))]);
  try {
    const observed: IndicatorResult[] = [];
    const first = fixture.status.refresh(directory);
    const second = fixture.status.refresh(directory);
    const third = fixture.status.refresh(directory);
    const unsubscribe = fixture.status.subscribe(directory, (result) => observed.push(result));

    resolvePending(ok(pr(11)));
    assert.deepEqual(await first, { kind: "refreshed", message: "Refreshed PR #22" });
    assert.deepEqual(await second, { kind: "refreshed", message: "Refreshed PR #22" });
    assert.deepEqual(await third, { kind: "refreshed", message: "Refreshed PR #22" });
    assert.deepEqual(fixture.status.get(directory), { kind: "pull-request", indicator: { text: "PR #22", tone: "neutral" } });
    assert.ok(!observed.some((result) => result.kind === "pull-request" && result.indicator.text === "PR #11"));
    unsubscribe();
  } finally {
    fixture.dispose();
  }
});

test("a branch update does not resurrect a cached PR from an older in-flight lookup", async () => {
  let resolveBranch!: (result: CommandResult) => void;
  const pendingBranch = new Promise<CommandResult>((resolve) => { resolveBranch = resolve; });
  const fixture = createFixture([
    ok("feature-a\n"), ok(pr(11)),
    pendingBranch, ok(pr(11)),
    ok("feature-b\n"), ok(pr(22)),
  ]);
  try {
    const observed: IndicatorResult[] = [];
    let unsubscribe!: () => void;
    await new Promise<void>((resolve) => {
      unsubscribe = fixture.status.subscribe(directory, (result) => {
        observed.push(result);
        if (result.kind === "pull-request") resolve();
      });
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const earlier = fixture.status.refresh(directory);
    fixture.status.refreshAll();
    const afterBranchUpdate = observed.length;
    resolveBranch(ok("feature-a\n"));
    await earlier;
    assert.deepEqual(fixture.status.get(directory), { kind: "pull-request", indicator: { text: "PR #22", tone: "neutral" } });
    assert.ok(!observed.slice(afterBranchUpdate).some((result) =>
      result.kind === "pull-request" && result.indicator.text === "PR #11"));
    unsubscribe();
  } finally {
    fixture.dispose();
  }
});

const REFRESH_INTERVAL_MS = 60_000;
const GH_FIELDS = [
  "number",
  "url",
  "isDraft",
  "state",
  "reviewDecision",
  "reviewRequests",
  "statusCheckRollup",
].join(",");

const PASSED_CHECK_STATES = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
const PENDING_CHECK_STATES = new Set(["EXPECTED", "PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"]);

type PullRequest = {
  number: number;
  url: string;
  status: "merged" | "closed" | "draft" | "checks-failing" | "checks-pending" |
    "changes-requested" | "approved" | "awaiting-review" | "ready";
};
export type Indicator = { text: string; tone: "success" | "error" | "warning" | "muted" | "accent" | "default" };
export type IndicatorResult =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "pull-request"; indicator: Indicator }
  | { kind: "error"; message: string; indicator?: Indicator };
export type ActionOutcome =
  | { kind: "refreshed" | "opened" | "none" | "error"; message: string }
  | { kind: "cancelled" };
export type CommandResult = { ok: boolean; stdout: string; stderr: string; missing: boolean; timedOut: boolean };
export type RunCommand = (command: string, args: string[], directory: string, signal: AbortSignal) => Promise<CommandResult>;

type Result =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "pull-request"; pullRequest: PullRequest }
  | { kind: "error"; message: string; pullRequest?: PullRequest };
type Listener = (result: IndicatorResult) => void;
type Channel = {
  key?: string;
  result: Result;
  checkedAt: number;
  inFlight?: Promise<Result>;
  queued?: Promise<Result>;
  timer?: ReturnType<typeof setTimeout>;
  listeners: Set<Listener>;
};

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`GitHub PR response has an invalid ${field}`);
  }
  return value;
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function checkState(check: unknown): "passed" | "pending" | "failed" {
  if (!check || typeof check !== "object" || Array.isArray(check)) return "failed";
  const value = check as Record<string, unknown>;
  const conclusion = optionalString(value.conclusion).toUpperCase();
  const state = optionalString(value.state).toUpperCase();
  const status = optionalString(value.status).toUpperCase();

  if (PASSED_CHECK_STATES.has(conclusion) || PASSED_CHECK_STATES.has(state)) return "passed";
  if (PENDING_CHECK_STATES.has(state) || PENDING_CHECK_STATES.has(status)) return "pending";
  return "failed";
}

function parsePullRequest(input: unknown): PullRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("GitHub PR response is not an object");
  }
  const value = input as Record<string, unknown>;
  if (!Number.isInteger(value.number) || (value.number as number) <= 0) {
    throw new Error("GitHub PR response has an invalid number");
  }
  if (!Array.isArray(value.statusCheckRollup)) {
    throw new Error("GitHub PR response has an invalid statusCheckRollup");
  }
  if (value.reviewRequests !== undefined && !Array.isArray(value.reviewRequests)) {
    throw new Error("GitHub PR response has invalid reviewRequests");
  }

  const checks = { passed: 0, pending: 0, failed: 0 };
  for (const check of value.statusCheckRollup) checks[checkState(check)] += 1;
  const state = optionalString(value.state).toUpperCase();
  const reviewDecision = optionalString(value.reviewDecision).toUpperCase();
  const status: PullRequest["status"] =
    state === "MERGED" ? "merged" :
    state === "CLOSED" ? "closed" :
    Boolean(value.isDraft) ? "draft" :
    checks.failed > 0 ? "checks-failing" :
    checks.pending > 0 ? "checks-pending" :
    reviewDecision === "CHANGES_REQUESTED" ? "changes-requested" :
    reviewDecision === "APPROVED" ? "approved" :
    reviewDecision === "REVIEW_REQUIRED" || ((value.reviewRequests as unknown[] | undefined)?.length ?? 0) > 0 ? "awaiting-review" :
    "ready";

  return { number: value.number as number, url: requiredString(value.url, "url"), status };
}

function indicator(pullRequest: PullRequest): Indicator {
  const tone: Indicator["tone"] =
    pullRequest.status === "merged" || pullRequest.status === "approved" ? "success" :
    pullRequest.status === "checks-failing" || pullRequest.status === "changes-requested" ? "error" :
    pullRequest.status === "checks-pending" ? "warning" :
    pullRequest.status === "closed" || pullRequest.status === "draft" ? "muted" :
    pullRequest.status === "awaiting-review" ? "accent" : "default";
  return { text: `PR #${pullRequest.number}`, tone };
}

function currentPullRequest(result: Result): PullRequest | undefined {
  return result.kind === "pull-request" || result.kind === "error" ? result.pullRequest : undefined;
}

function indicatorResult(result: Result): IndicatorResult {
  if (result.kind === "pull-request") return { kind: "pull-request", indicator: indicator(result.pullRequest) };
  if (result.kind === "error") {
    return { kind: "error", message: result.message, indicator: result.pullRequest && indicator(result.pullRequest) };
  }
  return result;
}

function isNoPullRequestError(stderr: string): boolean {
  const message = stderr.toLowerCase();
  return (
    message.includes("no pull requests found") ||
    message.includes("could not find pull request") ||
    message.includes("no open pull requests") ||
    message.includes("could not determine current branch")
  );
}

function commandError(result: CommandResult, command: string): string {
  if (result.timedOut) return `${command} request timed out`;
  const message = result.stderr.trim().split("\n")[0];
  return message || `${command} request failed`;
}

function refreshOutcome(result: Result): ActionOutcome {
  if (result.kind === "pull-request") return { kind: "refreshed", message: `Refreshed PR #${result.pullRequest.number}` };
  if (result.kind === "none") return { kind: "none", message: "No pull request for the current branch" };
  if (result.kind === "error") return { kind: "error", message: result.message };
  return { kind: "cancelled" };
}

// The UI supplies a session directory and renders IndicatorResult. Command execution is injected
// so the module can be exercised through the same interface without git or GitHub credentials.
export function createPullRequestStatus(signal: AbortSignal, runCommand: RunCommand) {
  const channels = new Map<string, Channel>();
  const cache = new Map<string, Result>();

  const channelFor = (directory: string): Channel => {
    let channel = channels.get(directory);
    if (channel) return channel;
    channel = { result: { kind: "loading" }, checkedAt: 0, listeners: new Set() };
    channels.set(directory, channel);
    return channel;
  };

  const publish = (channel: Channel, result: Result) => {
    channel.result = result;
    const visible = indicatorResult(result);
    for (const listener of channel.listeners) listener(visible);
  };

  const failed = (channel: Channel, message: string): Result => {
    const cached = channel.key ? cache.get(channel.key) : undefined;
    return {
      kind: "error",
      message,
      pullRequest: currentPullRequest(channel.result) ?? (cached && currentPullRequest(cached)),
    };
  };

  const load = async (directory: string, channel: Channel): Promise<Result> => {
    const branchResult = await runCommand("git", ["branch", "--show-current"], directory, signal);
    if (signal.aborted) return channel.result;
    if (!branchResult.ok) {
      channel.key = undefined;
      return { kind: "error", message: commandError(branchResult, "Git") };
    }
    const branch = branchResult.stdout.trim();
    if (!branch) {
      channel.key = undefined;
      return { kind: "none" };
    }

    const key = `${directory}\0${branch}`;
    if (channel.key !== key) {
      channel.key = key;
      if (!channel.queued) publish(channel, cache.get(key) ?? { kind: "loading" });
    }

    const result = await runCommand("gh", ["pr", "view", "--json", GH_FIELDS], directory, signal);
    if (signal.aborted) return channel.result;
    if (!result.ok) {
      if (result.missing) return failed(channel, "GitHub CLI is not installed");
      if (isNoPullRequestError(result.stderr)) return { kind: "none" };
      return failed(channel, commandError(result, "GitHub CLI"));
    }

    try {
      return { kind: "pull-request", pullRequest: parsePullRequest(JSON.parse(result.stdout)) };
    } catch (error) {
      return failed(channel, error instanceof Error ? error.message : String(error));
    }
  };

  const schedule = (directory: string, channel: Channel, delay = REFRESH_INTERVAL_MS) => {
    if (channel.timer) clearTimeout(channel.timer);
    if (channel.listeners.size === 0 || signal.aborted) {
      channel.timer = undefined;
      return;
    }
    channel.timer = setTimeout(() => {
      channel.timer = undefined;
      void update(directory, true);
    }, delay);
  };

  const update = (directory: string, force = false): Promise<Result> => {
    const channel = channelFor(directory);
    if (channel.inFlight) {
      if (channel.queued) return channel.queued;
      if (!force) return channel.inFlight.then((result) => channel.queued ?? result);
      const inFlight = channel.inFlight;
      let queued: Promise<Result>;
      queued = inFlight
        .finally(() => {
          if (channel.queued === queued) channel.queued = undefined;
        })
        .then(() => update(directory, true));
      channel.queued = queued;
      return queued;
    }

    const elapsed = Date.now() - channel.checkedAt;
    if (!force && elapsed < REFRESH_INTERVAL_MS) {
      schedule(directory, channel, REFRESH_INTERVAL_MS - elapsed);
      return Promise.resolve(channel.result);
    }

    if (channel.timer) {
      clearTimeout(channel.timer);
      channel.timer = undefined;
    }
    channel.checkedAt = Date.now();
    channel.inFlight = load(directory, channel)
      .then((result) => {
        if (signal.aborted) return result;
        if (channel.key) cache.set(channel.key, result);
        if (channel.queued) return result;
        publish(channel, result);
        return result;
      })
      .finally(() => {
        channel.inFlight = undefined;
        schedule(directory, channel);
      });
    return channel.inFlight.then((result) => channel.queued ?? result);
  };

  const subscribe = (directory: string, listener: Listener) => {
    const channel = channelFor(directory);
    const activating = channel.listeners.size === 0;
    channel.listeners.add(listener);
    const unsubscribe = () => {
      channel.listeners.delete(listener);
      if (channel.listeners.size === 0 && channel.timer) {
        clearTimeout(channel.timer);
        channel.timer = undefined;
      }
    };
    if (activating) {
      publish(channel, { kind: "loading" });
      void update(directory, true);
    } else {
      listener(indicatorResult(channel.result));
      void update(directory);
    }
    return unsubscribe;
  };

  const get = (directory: string): IndicatorResult => indicatorResult(channelFor(directory).result);

  const refresh = async (directory: string): Promise<ActionOutcome> => {
    const result = await update(directory, true);
    return signal.aborted ? { kind: "cancelled" } : refreshOutcome(result);
  };

  const refreshAll = () => {
    for (const [directory, channel] of channels) {
      if (channel.listeners.size === 0) continue;
      channel.key = undefined;
      publish(channel, { kind: "loading" });
      void update(directory, true);
    }
  };

  const open = async (directory: string): Promise<ActionOutcome> => {
    const channel = channelFor(directory);
    let pullRequest = currentPullRequest(channel.result);
    if (!pullRequest) {
      const result = await update(directory, true);
      if (signal.aborted) return { kind: "cancelled" };
      pullRequest = currentPullRequest(result);
      if (!pullRequest) {
        const outcome = refreshOutcome(result);
        return outcome.kind === "refreshed" ? { kind: "error", message: "PR could not be opened" } : outcome;
      }
    }
    const result = await runCommand("gh", ["pr", "view", pullRequest.url, "--web"], directory, signal);
    if (signal.aborted) return { kind: "cancelled" };
    if (!result.ok) return { kind: "error", message: commandError(result, "GitHub CLI") };
    return { kind: "opened", message: `Opened PR #${pullRequest.number}` };
  };

  const dispose = () => {
    for (const channel of channels.values()) if (channel.timer) clearTimeout(channel.timer);
  };

  return { dispose, get, open, refresh, refreshAll, subscribe };
}

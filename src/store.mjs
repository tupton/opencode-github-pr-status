// @ts-check
import { isNoPullRequestError, parsePullRequest } from "./status.mjs";

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

/** @typedef {ReturnType<typeof parsePullRequest>} PullRequest */
/** @typedef {{ kind: "loading" } | { kind: "none" } | { kind: "pull-request", pullRequest: PullRequest } | { kind: "error", message: string, pullRequest?: PullRequest }} PullRequestResult */
/** @typedef {(result: PullRequestResult) => void} Listener */
/** @typedef {{ ok: boolean, stdout: string, stderr: string, missing: boolean, timedOut: boolean }} CommandResult */
/** @typedef {(command: string, args: string[], directory: string, signal: AbortSignal) => Promise<CommandResult>} RunCommand */
/** @typedef {{ key?: string, result: PullRequestResult, checkedAt: number, inFlight?: Promise<PullRequestResult>, queued?: Promise<PullRequestResult>, timer?: ReturnType<typeof setTimeout>, listeners: Set<Listener> }} Channel */

/** @param {CommandResult} result @param {string} command */
function commandError(result, command) {
  if (result.timedOut) return `${command} request timed out`;
  const message = result.stderr.trim().split("\n")[0];
  return message || `${command} request failed`;
}

/** @param {PullRequestResult} result */
export function pullRequestFromResult(result) {
  return result.kind === "pull-request" || result.kind === "error" ? result.pullRequest : undefined;
}

/**
 * @param {{ ui: { toast: { show: (toast: { variant: "error", title: string, message: string }) => void } } }} api
 * @param {AbortSignal} signal
 * @param {RunCommand} runCommand
 */
export function createPullRequestStore(api, signal, runCommand) {
  /** @type {Map<string, Channel>} */
  const channels = new Map();
  /** @type {Map<string, PullRequestResult>} */
  const cache = new Map();

  /** @param {string} directory */
  const channelFor = (directory) => {
    let channel = channels.get(directory);
    if (channel) return channel;
    channel = {
      result: { kind: "loading" },
      checkedAt: 0,
      listeners: new Set(),
    };
    channels.set(directory, channel);
    return channel;
  };

  /** @param {Channel} channel @param {PullRequestResult} result */
  const publish = (channel, result) => {
    channel.result = result;
    for (const listener of channel.listeners) listener(result);
  };

  /** @param {Channel} channel @param {string} message @returns {PullRequestResult} */
  const failed = (channel, message) => {
    const cached = channel.key ? cache.get(channel.key) : undefined;
    return {
      kind: "error",
      message,
      pullRequest: pullRequestFromResult(channel.result) ?? (cached && pullRequestFromResult(cached)),
    };
  };

  /** @param {string} directory @param {Channel} channel @returns {Promise<PullRequestResult>} */
  const load = async (directory, channel) => {
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
      publish(channel, cache.get(key) ?? { kind: "loading" });
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
      const message = error instanceof Error ? error.message : String(error);
      return failed(channel, message);
    }
  };

  /** @param {string} directory @param {Channel} channel */
  const schedule = (directory, channel, delay = REFRESH_INTERVAL_MS) => {
    if (channel.timer) clearTimeout(channel.timer);
    if (channel.listeners.size === 0 || signal.aborted) {
      channel.timer = undefined;
      return;
    }
    channel.timer = setTimeout(() => {
      channel.timer = undefined;
      void refresh(directory, true);
    }, delay);
  };

  /** @param {string} directory */
  const refresh = (directory, force = false) => {
    const channel = channelFor(directory);
    if (channel.inFlight) {
      if (channel.queued) return channel.queued;
      if (!force) return channel.inFlight.then((result) => channel.queued ?? result);
      if (!channel.queued) {
        const inFlight = channel.inFlight;
        /** @type {Promise<PullRequestResult>} */
        let queued;
        queued = inFlight
          .finally(() => {
            if (channel.queued === queued) channel.queued = undefined;
          })
          .then(() => refresh(directory, true));
        channel.queued = queued;
      }
      return channel.queued;
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

  /** @param {string} directory @param {Listener} listener */
  const subscribe = (directory, listener) => {
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
      void refresh(directory, true);
      return unsubscribe;
    }
    listener(channel.result);
    void refresh(directory);
    return unsubscribe;
  };

  /** @param {string} directory */
  const get = (directory) => channelFor(directory).result;

  const refreshAll = () => {
    for (const [directory, channel] of channels) {
      if (channel.listeners.size === 0) continue;
      publish(channel, { kind: "loading" });
      void refresh(directory, true);
    }
  };

  /** @param {string} directory @param {PullRequest} pullRequest */
  const open = async (directory, pullRequest) => {
    const result = await runCommand("gh", ["pr", "view", pullRequest.url, "--web"], directory, signal);
    if (!result.ok && !signal.aborted) {
      api.ui.toast.show({ variant: "error", title: "GitHub PR", message: commandError(result, "GitHub CLI") });
    }
  };

  const dispose = () => {
    for (const channel of channels.values()) {
      if (channel.timer) clearTimeout(channel.timer);
    }
  };

  return { dispose, get, open, refresh, refreshAll, subscribe };
}

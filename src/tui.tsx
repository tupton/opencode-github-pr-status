/** @jsxImportSource @opentui/solid */

import { execFile } from "node:child_process";
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { Plugin } from "@opencode/plugin/tui";
import type { Context } from "@opencode/plugin/tui/context";

import {
  isNoPullRequestError,
  parsePullRequest,
} from "./status.mjs";

const REFRESH_INTERVAL_MS = 60_000;
const COMMAND_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const GH_FIELDS = [
  "number",
  "url",
  "title",
  "isDraft",
  "state",
  "reviewDecision",
  "reviewRequests",
  "statusCheckRollup",
].join(",");

type PullRequest = ReturnType<typeof parsePullRequest>;
type PullRequestResult =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "pull-request"; pullRequest: PullRequest }
  | { kind: "error"; message: string; pullRequest?: PullRequest };

type Listener = (result: PullRequestResult) => void;
type Channel = {
  key?: string;
  result: PullRequestResult;
  checkedAt: number;
  inFlight?: Promise<PullRequestResult>;
  queued?: Promise<PullRequestResult>;
  timer?: ReturnType<typeof setTimeout>;
  listeners: Set<Listener>;
};

type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  missing: boolean;
  timedOut: boolean;
};

function commandError(result: CommandResult, command: string) {
  if (result.timedOut) return `${command} request timed out`;
  const message = result.stderr.trim().split("\n")[0];
  return message || `${command} request failed`;
}

function pullRequestFromResult(result: PullRequestResult) {
  return result.kind === "pull-request" || result.kind === "error" ? result.pullRequest : undefined;
}

function runCommand(
  command: string,
  args: string[],
  directory: string,
  signal: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolve) => {
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
}

function sessionDirectory(api: Context, sessionID: string) {
  return api.data.session.get(sessionID)?.location.directory;
}

function createPullRequestStore(api: Context, signal: AbortSignal) {
  const channels = new Map<string, Channel>();
  const cache = new Map<string, PullRequestResult>();
  let ghMissing = false;

  const channelFor = (directory: string) => {
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

  const publish = (channel: Channel, result: PullRequestResult) => {
    channel.result = result;
    for (const listener of channel.listeners) listener(result);
  };

  const failed = (channel: Channel, message: string): PullRequestResult => {
    const cached = channel.key ? cache.get(channel.key) : undefined;
    return {
      kind: "error",
      message,
      pullRequest: pullRequestFromResult(channel.result) ?? (cached && pullRequestFromResult(cached)),
    };
  };

  const load = async (directory: string, channel: Channel): Promise<PullRequestResult> => {
    const branchResult = await runCommand("git", ["branch", "--show-current"], directory, signal);
    if (signal.aborted) return channel.result;
    if (!branchResult.ok) return { kind: "error", message: commandError(branchResult, "Git") };
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

    if (ghMissing) {
      return failed(channel, "GitHub CLI is not installed");
    }

    const result = await runCommand(
      "gh",
      ["pr", "view", "--json", GH_FIELDS],
      directory,
      signal,
    );
    if (signal.aborted) return channel.result;
    if (!result.ok) {
      if (result.missing) {
        ghMissing = true;
        return failed(channel, "GitHub CLI is not installed");
      }
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

  const schedule = (directory: string, channel: Channel, delay = REFRESH_INTERVAL_MS) => {
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

  const refresh = (directory: string, force = false) => {
    const channel = channelFor(directory);
    if (channel.inFlight) {
      if (!force) return channel.inFlight;
      if (!channel.queued) {
        const inFlight = channel.inFlight;
        let queued: Promise<PullRequestResult>;
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
    return channel.inFlight;
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
      void refresh(directory, true);
      return unsubscribe;
    }
    listener(channel.result);
    void refresh(directory);
    return unsubscribe;
  };

  const get = (directory: string) => channelFor(directory).result;

  const refreshAll = () => {
    for (const [directory, channel] of channels) {
      if (channel.listeners.size === 0) continue;
      publish(channel, { kind: "loading" });
      void refresh(directory, true);
    }
  };

  const open = async (directory: string, pullRequest: PullRequest) => {
    const result = await runCommand(
      "gh",
      ["pr", "view", pullRequest.url, "--web"],
      directory,
      signal,
    );
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

type PullRequestStore = ReturnType<typeof createPullRequestStore>;

function usePullRequest(api: Context, store: PullRequestStore, sessionID?: string) {
  const [result, setResult] = createSignal<PullRequestResult>({ kind: "loading" });
  const directory = createMemo(() => sessionID ? sessionDirectory(api, sessionID) : undefined);

  createEffect(() => {
    const current = directory();
    if (!current) {
      setResult({ kind: "none" });
      return;
    }
    const unsubscribe = store.subscribe(current, setResult);
    onCleanup(unsubscribe);
  });

  return { directory, result };
}

function statusColor(theme: Context["theme"], status: PullRequest["status"]) {
  switch (status) {
    case "merged":
    case "approved":
      return theme.text.feedback.success.base;
    case "checks-failing":
    case "changes-requested":
      return theme.text.feedback.error.base;
    case "checks-pending":
      return theme.text.feedback.warning.base;
    case "closed":
    case "draft":
      return theme.text.muted;
    case "awaiting-review":
      return theme.hue.accent[300];
    default:
      return theme.text.action.primary.base;
  }
}

function PromptIndicator(props: {
  api: Context;
  store: PullRequestStore;
  sessionID?: string;
}) {
  const state = usePullRequest(props.api, props.store, props.sessionID);
  const pullRequest = createMemo(() => {
    return pullRequestFromResult(state.result());
  });

  return (
    <text
      fg={pullRequest() ? statusColor(props.api.theme, pullRequest()!.status) : props.api.theme.text.muted}
      onMouseUp={() => {
        const current = pullRequest();
        const directory = state.directory();
        if (current && directory) void props.store.open(directory, current);
      }}
    >
      {pullRequest() ? `PR #${pullRequest()!.number}` : ""}
    </text>
  );
}

function activeDirectory(api: Context) {
  const route = api.ui.router.current();
  if (route.type !== "session") return;
  return sessionDirectory(api, route.sessionID);
}

async function refreshActive(api: Context, store: PullRequestStore) {
  const directory = activeDirectory(api);
  if (!directory) {
    api.ui.toast.show({ variant: "warning", title: "GitHub PR", message: "Open a session before refreshing PR status" });
    return;
  }

  const result = await store.refresh(directory, true);
  if (result.kind === "pull-request") {
    api.ui.toast.show({ variant: "success", title: "GitHub PR", message: `Refreshed PR #${result.pullRequest.number}` });
    return;
  }
  if (result.kind === "none") {
    api.ui.toast.show({ variant: "info", title: "GitHub PR", message: "No pull request for the current branch" });
    return;
  }
  if (result.kind === "error") {
    api.ui.toast.show({ variant: "error", title: "GitHub PR", message: result.message });
  }
}

async function openActive(api: Context, store: PullRequestStore) {
  const directory = activeDirectory(api);
  if (!directory) {
    api.ui.toast.show({ variant: "warning", title: "GitHub PR", message: "Open a session before opening a PR" });
    return;
  }

  let result = store.get(directory);
  if (result.kind !== "pull-request") result = await store.refresh(directory, true);
  const pullRequest = pullRequestFromResult(result);
  if (pullRequest) {
    await store.open(directory, pullRequest);
    return;
  }
  if (result.kind === "none") {
    api.ui.toast.show({ variant: "info", title: "GitHub PR", message: "No pull request for the current branch" });
    return;
  }
  if (result.kind === "error") {
    api.ui.toast.show({ variant: "error", title: "GitHub PR", message: result.message });
  }
}

function registerCommands(api: Context, store: PullRequestStore) {
  api.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "github-pr.open",
        title: "GitHub PR: Open",
        group: "GitHub",
        palette: true,
        run: () => openActive(api, store),
      },
      {
        id: "github-pr.refresh",
        title: "GitHub PR: Refresh",
        group: "GitHub",
        palette: true,
        run: () => refreshActive(api, store),
      },
    ],
  }));
}

export default Plugin.define({
  id: "github-pr-status",
  setup(api) {
    const controller = new AbortController();
    const store = createPullRequestStore(api, controller.signal);
    const stopCommands = api.ui.slot({
      append: "app",
      render: () => {
        registerCommands(api, store);
        return null;
      },
    });
    const stopSlot = api.ui.slot({
      append: "prompt.footer.status",
      render: ({ sessionID }) => <PromptIndicator api={api} store={store} sessionID={sessionID} />,
    });
    const stopExecution = api.data.on("session.execution.succeeded", (event) => {
      const directory = sessionDirectory(api, event.data.sessionID);
      if (directory) void store.refresh(directory, true);
    });
    const stopBranch = api.data.on("vcs.branch.updated", () => store.refreshAll());

    return () => {
      controller.abort();
      stopExecution();
      stopBranch();
      stopSlot();
      stopCommands();
      store.dispose();
    };
  },
});

/** @jsxImportSource @opentui/solid */

import { execFile } from "node:child_process";
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { Plugin } from "@opencode/plugin/tui";
import type { Context } from "@opencode/plugin/tui/context";

import { parsePullRequest } from "./status.mjs";
import { createPullRequestStore, pullRequestFromResult } from "./store.mjs";

const COMMAND_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

type PullRequest = ReturnType<typeof parsePullRequest>;
type PullRequestStore = ReturnType<typeof createPullRequestStore>;
type PullRequestResult = ReturnType<PullRequestStore["get"]>;

type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  missing: boolean;
  timedOut: boolean;
};

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
    const store = createPullRequestStore(api, controller.signal, runCommand);
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

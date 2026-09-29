/** @jsxImportSource @opentui/solid */

import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { Plugin } from "@opencode/plugin/tui";
import type { Context } from "@opencode/plugin/tui/context";

import { runCommand } from "./command";
import { createPullRequestStatus } from "./status";
import type { ActionOutcome, Indicator, IndicatorResult } from "./status";

type PullRequestStatus = ReturnType<typeof createPullRequestStatus>;

function sessionDirectory(api: Context, sessionID: string) {
  return api.data.session.get(sessionID)?.location.directory;
}

function usePullRequest(api: Context, status: PullRequestStatus, sessionID?: string) {
  const [result, setResult] = createSignal<IndicatorResult>({ kind: "loading" });
  const directory = createMemo(() => sessionID ? sessionDirectory(api, sessionID) : undefined);

  createEffect(() => {
    const current = directory();
    if (!current) {
      setResult({ kind: "none" });
      return;
    }
    const unsubscribe = status.subscribe(current, setResult);
    onCleanup(unsubscribe);
  });

  return { directory, result };
}

function statusColor(theme: Context["theme"], tone: Indicator["tone"]) {
  switch (tone) {
    case "success":
      return theme.text.feedback.success.base;
    case "error":
      return theme.text.feedback.error.base;
    case "warning":
      return theme.text.feedback.warning.base;
    case "muted":
      return theme.hue.neutral[700];
    case "neutral":
      return theme.hue.neutral[300];
    case "accent":
      return theme.hue.accent[300];
    default:
      return theme.text.action.primary.base;
  }
}

function PromptIndicator(props: {
  api: Context;
  status: PullRequestStatus;
  sessionID?: string;
}) {
  const state = usePullRequest(props.api, props.status, props.sessionID);
  const indicator = createMemo(() => {
    const result = state.result();
    return result.kind === "pull-request" || result.kind === "error" ? result.indicator : undefined;
  });

  return (
    <text
      fg={indicator() ? statusColor(props.api.theme, indicator()!.tone) : props.api.theme.text.muted}
      onMouseUp={() => {
        const directory = state.directory();
        if (indicator() && directory) void props.status.open(directory).then((outcome) => {
          if (outcome.kind === "error") showOutcome(props.api, outcome);
        });
      }}
    >
      {indicator()?.text ?? ""}
    </text>
  );
}

function activeDirectory(api: Context) {
  const route = api.ui.router.current();
  if (route.type !== "session") return;
  return sessionDirectory(api, route.sessionID);
}

function showOutcome(api: Context, outcome: ActionOutcome) {
  if (outcome.kind === "opened" || outcome.kind === "cancelled") return;
  const variant = outcome.kind === "refreshed" ? "success" : outcome.kind === "none" ? "info" : "error";
  api.ui.toast.show({ variant, title: "GitHub PR", message: outcome.message });
}

async function refreshActive(api: Context, status: PullRequestStatus) {
  const directory = activeDirectory(api);
  if (!directory) {
    api.ui.toast.show({ variant: "warning", title: "GitHub PR", message: "Open a session before refreshing PR status" });
    return;
  }

  showOutcome(api, await status.refresh(directory));
}

async function openActive(api: Context, status: PullRequestStatus) {
  const directory = activeDirectory(api);
  if (!directory) {
    api.ui.toast.show({ variant: "warning", title: "GitHub PR", message: "Open a session before opening a PR" });
    return;
  }

  showOutcome(api, await status.open(directory));
}

function registerCommands(api: Context, status: PullRequestStatus) {
  api.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "github-pr.open",
        title: "GitHub PR: Open",
        group: "GitHub",
        palette: true,
        run: () => openActive(api, status),
      },
      {
        id: "github-pr.refresh",
        title: "GitHub PR: Refresh",
        group: "GitHub",
        palette: true,
        run: () => refreshActive(api, status),
      },
    ],
  }));
}

export default Plugin.define({
  id: "github-pr-status",
  setup(api) {
    const controller = new AbortController();
    const status = createPullRequestStatus(controller.signal, runCommand);
    const stopCommands = api.ui.slot({
      append: "app",
      render: () => {
        registerCommands(api, status);
        return null;
      },
    });
    const stopSlot = api.ui.slot({
      append: "prompt.footer.status",
      render: ({ sessionID }) => <PromptIndicator api={api} status={status} sessionID={sessionID} />,
    });
    const stopExecution = api.data.on("session.execution.succeeded", (event) => {
      const directory = sessionDirectory(api, event.data.sessionID);
      if (directory) void status.refresh(directory);
    });
    const stopBranch = api.data.on("vcs.branch.updated", () => status.refreshAll());

    return () => {
      controller.abort();
      stopExecution();
      stopBranch();
      stopSlot();
      stopCommands();
      status.dispose();
    };
  },
});

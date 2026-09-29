/** @jsxImportSource @opentui/solid */

import { testRender } from "@opentui/solid";
import { RGBA } from "@opentui/core";
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure";
import * as tui from "@opencode/plugin/tui";

ensureRuntimePluginSupport({ additional: { "@opencode/plugin/tui": tui } });

const { default: plugin } = await import(process.argv[2]);
const slots: Array<{ append?: string; render: (input: { sessionID?: string; mode: "normal"; showDetails: boolean }) => any }> = [];
const color = RGBA.fromInts(200, 200, 200);
const cleanup = plugin.setup({
  ui: {
    slot: (slot: (typeof slots)[number]) => {
      slots.push(slot);
      return () => {};
    },
  },
  data: { on: () => () => {} },
  theme: { text: { base: color, muted: color } },
});

const footer = slots.find((slot) => slot.append === "prompt.footer.status");
if (!footer) throw new Error("The package did not register the prompt footer");

const app = await testRender(() => (
  <box width="100%" flexDirection="row">
    <text>footer</text>
    {footer.render({ sessionID: undefined, mode: "normal", showDetails: true })}
  </box>
), { width: 30, height: 1 });

try {
  await app.renderOnce();
  if (!app.captureCharFrame().includes("footer")) throw new Error("The prompt footer did not render");
} finally {
  app.renderer.destroy();
  cleanup();
}

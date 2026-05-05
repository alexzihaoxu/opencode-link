// TUI plugin entry. Renders a small "Link" section into the right-hand
// sidebar of the opencode TUI, plus a command-palette entry to open the
// salt file's containing folder.
//
// Data flow: the server-side plugin (src/index.ts) writes Link state to
// ~/.config/opencode-link/state.json on every change. This module polls
// that file every ~1.5s; opencode has no plugin-to-plugin IPC, so the
// file is the bridge.

import type { TuiPluginModule } from "@opencode-ai/plugin/tui";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { readState, type LinkState } from "./state.ts";

const POLL_MS = 1500;

function fmt(state: LinkState | null): string {
  if (!state) {
    return ["Link", "(plugin not yet initialized)"].join("\n");
  }
  const lines = ["Link"];
  lines.push(`code  ${state.code || "—"}`);
  lines.push(`name  ${state.name || "(unset)"}`);
  if (state.salt.origin === "none") {
    lines.push(`salt  not configured`);
  } else {
    lines.push(`salt  ${state.salt.origin} (${state.salt.preview})`);
  }
  lines.push(`peers ${state.peers.length}${state.peers.length ? ":" : ""}`);
  for (const p of state.peers) {
    lines.push(`  • ${p.name || p.code}`);
  }
  return lines.join("\n");
}

function openInFileManager(path: string): { ok: true } | { ok: false; reason: string } {
  if (!path) return { ok: false, reason: "no path" };
  try {
    const dir = dirname(path);
    let cmd: string;
    let args: string[];
    if (process.platform === "win32") {
      cmd = "explorer";
      args = [dir];
    } else if (process.platform === "darwin") {
      cmd = "open";
      args = [dir];
    } else {
      cmd = "xdg-open";
      args = [dir];
    }
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-link:tui",
  tui: async (api) => {
    let state: LinkState | null = await readState();
    let lastSerialized = JSON.stringify(state);

    // Poll the state file. Re-render only when it actually changed.
    const timer = setInterval(async () => {
      try {
        const next = await readState();
        const serialized = JSON.stringify(next);
        if (serialized !== lastSerialized) {
          state = next;
          lastSerialized = serialized;
          api.renderer.requestRender();
        }
      } catch {
        // Best effort; ignore transient FS errors.
      }
    }, POLL_MS);
    api.lifecycle.onDispose(() => clearInterval(timer));

    api.slots.register({
      order: 80,
      slots: {
        sidebar_content() {
          return fmt(state);
        },
      },
    });

    api.command.register(() => [
      {
        title: "opencode-link: open salt file location",
        value: "opencode-link.openSaltLocation",
        category: "opencode-link",
        description: state?.saltFilePath
          ? `Open ${state.saltFilePath} in file manager`
          : "Open the opencode-link salt file in your OS file manager",
        onSelect: () => {
          const path = state?.saltFilePath;
          if (!path) {
            api.ui.toast({
              variant: "warning",
              message: "Salt file path not yet known — try after the plugin has rendered once.",
            });
            return;
          }
          const result = openInFileManager(path);
          if (result.ok) {
            api.ui.toast({
              variant: "success",
              message: `Opened ${dirname(path)}`,
            });
          } else {
            api.ui.toast({
              variant: "error",
              message: `Could not open file manager: ${result.reason}`,
            });
          }
        },
      },
    ]);
  },
};

export default plugin;

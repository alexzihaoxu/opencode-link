import { createRequire } from "node:module";
import { uptime as osUptime } from "node:os";
import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin";
import { loadIdentity, loadSalt } from "./identity.ts";
import { Link } from "./link.ts";
import { buildTools } from "./tools.ts";
import { readState, writeState } from "./state.ts";

const require = createRequire(import.meta.url);

let shutdownInstalled = false;
function installShutdown(): void {
  if (shutdownInstalled) return;
  shutdownInstalled = true;

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    // Only call node-datachannel.cleanup() if the module was ALREADY loaded
    // (i.e. the user actually used a link tool with a salt configured).
    // Calling require() here when nothing previously loaded peerjs-on-node
    // would *force* the native binding to load just to immediately tear it
    // down — and that round-trip is itself what triggers the NAPI panic on
    // bare-launch ctrl+c, when no salt is set and the plugin was inert.
    try {
      const ndPath = require.resolve("node-datachannel");
      if (require.cache?.[ndPath]) {
        const nd = require("node-datachannel");
        nd?.cleanup?.();
      }
    } catch {}
  };

  // Cover every termination path Bun emits. We run cleanup on the FIRST one
  // that fires; the rest no-op via the `cleaned` guard.
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("SIGHUP", cleanup);
  process.on("beforeExit", cleanup);
  process.on("exit", cleanup);
}

export const server: Plugin = async (input: PluginInput): Promise<Hooks> => {
  const [identity, salt] = await Promise.all([loadIdentity(), loadSalt()]);
  const link = new Link(identity, salt);
  link.setClient(input.client);

  // Capture previous state BEFORE wiring the state-change handler — otherwise
  // the handler's first write would race the read below and reboot detection
  // would always read the just-written timestamp (gap ≈ 0, never triggers).
  const prevState = await readState().catch(() => null);

  // Mirror Link state to ~/.config/opencode-link/state.json so the TUI plugin
  // (separate process / module) can render a sidebar panel without IPC.
  link.setStateChangeHandler(() => {
    void writeState(link.toState()).catch(() => {});
  });
  // Write the initial snapshot now that the handler is wired and prevState
  // is safely captured.
  void writeState(link.toState()).catch(() => {});

  // Detect OS reboot since last plugin run. If the previous state file's
  // timestamp is older than the current OS uptime would allow (i.e. the gap
  // between then-and-now exceeds how long the OS has been up), the box must
  // have been off in between. Surface that to the agent for context.
  if (prevState) {
    const offlineFor = Date.now() - prevState.updatedAt;
    const uptimeMs = osUptime() * 1000;
    if (offlineFor > uptimeMs + 30_000) {
      const seconds = Math.round(offlineFor / 1000);
      const human =
        seconds < 60 ? `${seconds}s`
        : seconds < 3600 ? `${Math.round(seconds / 60)}m`
        : `${Math.round(seconds / 3600)}h`;
      // Fire after a tick so any session bind / model capture happens first.
      setTimeout(() => link.notifyReboot(human), 500);
    }
  }

  // Eager peer boot (loads peerjs-on-node + node-datachannel) is opt-in via
  // OPENCODE_LINK_EAGER=1. Bun on Windows panics during native-module unload
  // when node-datachannel was loaded; defaulting to lazy keeps a bare-launch
  // ctrl+c clean. Tradeoff: a receiving agent isn't on signaling until its
  // side calls a link tool — system prompt nudges link_whoami early.
  if (salt.value && process.env.OPENCODE_LINK_EAGER === "1") {
    void link.start().catch((err: Error) => {
      (input.client as any)?.app?.log?.({
        service: "opencode-link",
        level: "warn",
        message: `eager peer boot failed: ${err.message}`,
      });
    });
  }

  installShutdown();

  return {
    tool: buildTools(link),

    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(link.systemPrompt());
    },

    // Capture the session's current model + agent so pushed peer messages
    // wake the agent under the same model the user has been using, instead
    // of opencode's default-model fallback.
    "chat.params": async (input, _output) => {
      if (input.sessionID && input.model?.providerID && input.model?.id) {
        link.bindModel(input.sessionID, input.model.providerID, input.model.id, input.agent);
      }
    },

    event: async ({ event }) => {
      const sid: string | undefined =
        (event as any)?.session_id ??
        (event as any)?.sessionID ??
        (event as any)?.properties?.info?.id;
      if (!sid) return;
      switch (event.type) {
        case "session.created":
          link.noteSession(sid, "created");
          break;
        case "session.idle":
          link.noteSession(sid, "active");
          break;
        case "session.deleted":
          link.noteSession(sid, "deleted");
          break;
      }
    },
  };
};

export default { server };

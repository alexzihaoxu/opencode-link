import { createRequire } from "node:module";
import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin";
import { loadIdentity } from "./identity.ts";
import { Link } from "./link.ts";
import { buildTools } from "./tools.ts";

const require = createRequire(import.meta.url);

let shutdownInstalled = false;
function installShutdown(link: Link): void {
  if (shutdownInstalled) return;
  shutdownInstalled = true;

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      void link.stop();
    } catch {}
    // node-datachannel needs an explicit cleanup() before the native module
    // is unloaded, otherwise its NAPI finalizer panics on process exit.
    try {
      const nd = require("node-datachannel");
      nd?.cleanup?.();
    } catch {}
    if (signal === "SIGINT" || signal === "SIGTERM") {
      // Re-emit so the host (opencode) can do its own cleanup and exit.
      setImmediate(() => process.exit(signal === "SIGINT" ? 130 : 143));
    }
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("beforeExit", () => shutdown("beforeExit"));
  process.once("exit", () => shutdown("exit"));
}

export const server: Plugin = async (input: PluginInput): Promise<Hooks> => {
  const identity = await loadIdentity();
  const link = new Link(identity);
  link.setClient(input.client);

  // Boot the peer in the background so this agent is reachable as soon as
  // opencode loads, not just after the first link_* tool call. Without this,
  // someone trying to connect would hang because the receiver never registered
  // with the signaling server.
  void link.start().catch((err: Error) => {
    (input.client as any)?.app?.log?.({
      service: "opencode-link",
      level: "warn",
      message: `eager peer boot failed: ${err.message}`,
    });
  });

  installShutdown(link);

  return {
    tool: buildTools(link),

    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(link.systemPrompt());
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

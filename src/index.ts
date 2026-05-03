import { createRequire } from "node:module";
import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin";
import { loadIdentity, loadSalt } from "./identity.ts";
import { Link } from "./link.ts";
import { buildTools } from "./tools.ts";

const require = createRequire(import.meta.url);

let shutdownInstalled = false;
function installShutdown(): void {
  if (shutdownInstalled) return;
  shutdownInstalled = true;

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    // Hard tear-down of libdatachannel from underneath any in-flight
    // connections. We deliberately do NOT call peer.destroy() / conn.close()
    // first — those go through the WebRTC graceful-close path which fires
    // datachannel error events back to JS just as the JS engine is shutting
    // down, producing a NAPI panic on process exit. cleanup() bypasses that
    // by yanking the native side directly. Idempotent: safe to call from
    // multiple lifecycle events.
    try {
      const nd = require("node-datachannel");
      nd?.cleanup?.();
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

  // If a salt is configured, eagerly boot the peer so this agent is reachable
  // from the moment opencode loads. If no salt is set, link.start() throws and
  // we just log it — tools will surface the configuration error to the agent.
  if (salt.value) {
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

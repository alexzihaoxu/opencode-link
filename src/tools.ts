import { tool } from "@opencode-ai/plugin";
import type { Link } from "./link.ts";

export function buildTools(link: Link) {
  const bind = (ctx: { sessionID?: string } | undefined) => link.bindSession(ctx?.sessionID);

  /**
   * Run an action that requires the peer to be online (i.e. salt configured).
   * If no salt is set, return a clear, agent-readable error instead of an
   * opaque rejection so the LLM can surface the guidance to the user.
   */
  const requirePeer = async <T>(fn: () => Promise<T>): Promise<T | string> => {
    if (!link.salt.value) {
      return "ERROR: opencode-link is not configured. No shared salt is set, so no connection can be made. Tell the user to either set the OPENCODE_LINK_SALT env var or write a salt to the salt file (see system prompt for details). Both you and your peer must use the same salt.";
    }
    return fn();
  };

  return {
    link_whoami: tool({
      description: "Return this agent's link code, display name, and current configuration status (whether the shared salt is set).",
      args: {},
      async execute(_args, ctx) {
        bind(ctx);
        const out: Record<string, unknown> = {
          code: link.identity.code,
          name: link.identity.name,
          salt: link.salt.origin, // "env" | "file" | "none"
          ready: link.salt.value !== null,
        };
        if (!link.salt.value) {
          out.warning =
            "NO SHARED SALT IS CONFIGURED. The link code alone is not usable yet — opencode-link needs a shared salt before any peer-to-peer connection can be established. Tell the user this and how to fix it (set OPENCODE_LINK_SALT env var, or write the salt to the salt file shown in your system prompt). You and your peer must use the SAME salt.";
        }
        return JSON.stringify(out);
      },
    }),

    link_set_name: tool({
      description: "Set or change this agent's display name. Persists for the session; broadcasts to currently connected peers if any. Works even before a salt is configured.",
      args: {
        name: tool.schema.string().min(1).max(64),
      },
      async execute(args, ctx) {
        bind(ctx);
        await link.setName(args.name);
        return `name set to ${args.name}`;
      },
    }),

    link_connect: tool({
      description: "Open a peer-to-peer connection to another agent by their 6-character code (e.g. `A1GH35`). Requires a shared salt to be configured.",
      args: {
        code: tool.schema.string().describe("The other agent's 6-char link code (case-insensitive)."),
      },
      async execute(args, ctx) {
        bind(ctx);
        return requirePeer(async () => {
          await link.connect(args.code);
          return `connected to ${args.code.toUpperCase()}`;
        });
      },
    }),

    link_send: tool({
      description: "Send a text message to a connected peer (identified by their link code). Requires a shared salt and an active connection.",
      args: {
        code: tool.schema.string(),
        text: tool.schema.string(),
      },
      async execute(args, ctx) {
        bind(ctx);
        return requirePeer(async () => {
          await link.send(args.code, args.text);
          return `sent ${args.text.length} chars to ${args.code.toUpperCase()}`;
        });
      },
    }),

    link_inbox: tool({
      description: "Drain and return all pending messages received since the last call. Returns an empty array if no salt is configured.",
      args: {},
      async execute(_args, ctx) {
        bind(ctx);
        return JSON.stringify(link.inbox());
      },
    }),

    link_peers: tool({
      description: "List currently connected peers with their codes and display names. Returns an empty array if no salt is configured.",
      args: {},
      async execute(_args, ctx) {
        bind(ctx);
        return JSON.stringify(link.peers());
      },
    }),

    link_rotate: tool({
      description: "Rotate this agent's link code. Generates a fresh 6-char code, re-registers on signaling under it, and drops any existing connections (their addressing used the old code). Useful if the current code has leaked or the user wants a clean identity. Returns the new code.",
      args: {},
      async execute(_args, ctx) {
        bind(ctx);
        return requirePeer(async () => {
          const newCode = await link.rotateCode();
          return `rotated link code; new code is ${newCode}`;
        });
      },
    }),
  };
}

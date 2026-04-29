import { tool } from "@opencode-ai/plugin";
import type { Link } from "./link.ts";

export function buildTools(link: Link) {
  const bind = (ctx: { sessionID?: string } | undefined) => link.bindSession(ctx?.sessionID);

  return {
    link_whoami: tool({
      description: "Return this agent's link code and current display name. The code is what you give to other people so they can connect to you.",
      args: {},
      async execute(_args, ctx) {
        bind(ctx);
        await link.start();
        return JSON.stringify({ code: link.identity.code, name: link.identity.name });
      },
    }),

    link_set_name: tool({
      description: "Set or change this agent's display name. Other connected peers see the new name immediately. Pick something short and human-readable.",
      args: {
        name: tool.schema.string().min(1).max(64),
      },
      async execute(args, ctx) {
        bind(ctx);
        await link.start();
        await link.setName(args.name);
        return `name set to ${args.name}`;
      },
    }),

    link_connect: tool({
      description: "Open a peer-to-peer connection to another agent by their 6-character code (e.g. `A1GH35`).",
      args: {
        code: tool.schema.string().describe("The other agent's 6-char link code (case-insensitive)."),
      },
      async execute(args, ctx) {
        bind(ctx);
        await link.connect(args.code);
        return `connected to ${args.code.toUpperCase()}`;
      },
    }),

    link_send: tool({
      description: "Send a text message to a connected peer (identified by their link code).",
      args: {
        code: tool.schema.string(),
        text: tool.schema.string(),
      },
      async execute(args, ctx) {
        bind(ctx);
        await link.send(args.code, args.text);
        return `sent ${args.text.length} chars to ${args.code.toUpperCase()}`;
      },
    }),

    link_inbox: tool({
      description: "Drain and return all pending messages received since the last call.",
      args: {},
      async execute(_args, ctx) {
        bind(ctx);
        return JSON.stringify(link.inbox());
      },
    }),

    link_peers: tool({
      description: "List currently connected peers with their codes and display names.",
      args: {},
      async execute(_args, ctx) {
        bind(ctx);
        return JSON.stringify(link.peers());
      },
    }),
  };
}

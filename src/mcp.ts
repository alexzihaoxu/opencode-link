#!/usr/bin/env bun
// Claude Code MCP server entry point.
//
// Same wire / peer / salt machinery as the opencode plugin (src/index.ts);
// the differences live here:
//
//  - Tools are exposed via the MCP stdio protocol instead of opencode's
//    `tool: { ... }` plugin shape.
//  - Push delivery on incoming peer messages emits a Claude Code "channel"
//    notification (`notifications/claude/channel`) so the agent gets woken
//    up and the message is injected into the running session as
//    `<channel source="opencode-link">[link from <name>] <text></channel>`.
//
// Note on the package name: the repo is called `opencode-link` because it
// started as an opencode-only thing. The same plugin now also targets
// Claude Code via this MCP entry — the name is a historical artifact.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadIdentity, loadSalt, saltFilePath } from "./identity.ts";
import { Link, type InboxEntry, type PeerInfo } from "./link.ts";

const SERVER_NAME = "opencode-link";
const SERVER_VERSION = "0.0.1";
const CHANNEL_NOTIFICATION = "notifications/claude/channel";

/** Single text-content reply, the only shape we ever return. */
function text(s: string): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: s }] };
}

const TOOL_DEFS = [
  {
    name: "link_whoami",
    description:
      "Return this agent's link code, display name, and configuration status. Call this at the start of any link-related conversation so you know your own identity before sharing it. The response also tells you whether a shared salt is configured — if not, peer connections will not work and you should ask the user to set one (see the `warning` field).",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "link_set_name",
    description:
      "Set or change this agent's display name. Other connected peers see the new name immediately. Pick something short and human-readable. Works even before a salt is configured (just doesn't broadcast since no peers).",
    inputSchema: {
      type: "object" as const,
      properties: { name: { type: "string", minLength: 1, maxLength: 64 } },
      required: ["name"],
    },
  },
  {
    name: "link_connect",
    description:
      "Open a peer-to-peer connection to another agent by their 6-character link code (e.g. `A1GH35`, case-insensitive). Requires a shared salt to be configured.",
    inputSchema: {
      type: "object" as const,
      properties: {
        code: {
          type: "string",
          description: "The other agent's 6-char link code (case-insensitive).",
        },
      },
      required: ["code"],
    },
  },
  {
    name: "link_send",
    description:
      "Send a text message to a connected peer (identified by their link code). Requires a shared salt and an active connection (call link_connect first).\n\nReply rules: only call this when you have a real answer / question / status / new info. Do NOT reply to acknowledgments, 'understood', 'thanks', 'ok' — those end the exchange and replying creates an ack-loop. Silence is a valid response.",
    inputSchema: {
      type: "object" as const,
      properties: {
        code: { type: "string" },
        text: { type: "string" },
      },
      required: ["code", "text"],
    },
  },
  {
    name: "link_inbox",
    description:
      "Drain and return all pending messages received since the last call. Returns an empty array if no salt is configured. Useful if you suspect background messages may have queued up while you were busy.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "link_peers",
    description:
      "List currently connected peers with their codes and display names.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "link_rotate",
    description:
      "Rotate this agent's link code. Generates a fresh 6-char code, re-registers on signaling under it, and drops any existing connections. Useful if the current code has leaked.",
    inputSchema: { type: "object" as const, properties: {} },
  },
];

async function main() {
  const [identity, salt] = await Promise.all([loadIdentity(), loadSalt()]);
  const link = new Link(identity, salt);

  const mcp = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: {},
        // Declares this server as a Claude Code channel emitter.
        // Without this Claude Code won't accept the channel notifications.
        experimental: { "claude/channel": {} },
      },
    },
  );

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFS,
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    const requireSalt = (): string | null => {
      if (link.salt.value) return null;
      return [
        "ERROR: opencode-link is not configured.",
        "No shared salt is set, so no peer-to-peer connection can be made.",
        "Tell the user to either:",
        `  1. set the env var OPENCODE_LINK_SALT=<a long random string> (e.g. \`openssl rand -hex 32\`), or`,
        `  2. write the salt to ${saltFilePath()} (one line of text).`,
        "Both you and your peer must use the SAME salt.",
        "After configuring, restart the MCP server (restart Claude Code).",
      ].join("\n");
    };

    switch (req.params.name) {
      case "link_whoami": {
        // Did the client negotiate the experimental.claude/channel capability
        // at initialize? If not, the user launched Claude Code without the
        // --dangerously-load-development-channels flag. Tools still work; we
        // just can't auto-wake the agent on incoming peer messages.
        const clientCaps = mcp.getClientCapabilities();
        const channelsEnabled =
          (clientCaps?.experimental as Record<string, unknown> | undefined)?.["claude/channel"] !== undefined;

        const out: Record<string, unknown> = {
          code: link.identity.code,
          name: link.identity.name,
          salt: link.salt.origin,
          ready: link.salt.value !== null,
          channels_enabled: channelsEnabled,
        };
        if (!link.salt.value) {
          out.warning =
            "NO SHARED SALT IS CONFIGURED. The link code alone is not usable yet — opencode-link needs a shared salt before any peer-to-peer connection can be established. Tell the user how to fix it (set OPENCODE_LINK_SALT env var, or write to the salt file shown). You and your peer must use the same salt.";
          out.saltFilePath = saltFilePath();
        }
        if (!channelsEnabled) {
          out.notice =
            "CHANNELS ARE NOT ENABLED for this Claude Code session. Outbound link tools (link_connect, link_send) still work, but incoming peer messages will NOT auto-wake you — they queue in link_inbox and you have to drain it manually. If the user wants real-time receive, tell them to relaunch Claude Code with: claude --dangerously-load-development-channels server:opencode-link";
        }
        return text(JSON.stringify(out));
      }
      case "link_set_name": {
        const name = String(args.name ?? "");
        if (!name) return text("ERROR: name is required and must be non-empty");
        await link.setName(name);
        return text(`name set to ${name}`);
      }
      case "link_connect": {
        const err = requireSalt();
        if (err) return text(err);
        const code = String(args.code ?? "");
        try {
          await link.connect(code);
          return text(`connected to ${code.toUpperCase()}`);
        } catch (e) {
          return text(`ERROR: ${(e as Error).message}`);
        }
      }
      case "link_send": {
        const err = requireSalt();
        if (err) return text(err);
        const code = String(args.code ?? "");
        const body = String(args.text ?? "");
        try {
          await link.send(code, body);
          return text(`sent ${body.length} chars to ${code.toUpperCase()}`);
        } catch (e) {
          return text(`ERROR: ${(e as Error).message}`);
        }
      }
      case "link_inbox": {
        const entries: InboxEntry[] = link.inbox();
        return text(JSON.stringify(entries));
      }
      case "link_peers": {
        const peers: PeerInfo[] = link.peers();
        return text(JSON.stringify(peers));
      }
      case "link_rotate": {
        const err = requireSalt();
        if (err) return text(err);
        try {
          const newCode = await link.rotateCode();
          return text(`rotated link code; new code is ${newCode}`);
        } catch (e) {
          return text(`ERROR: ${(e as Error).message}`);
        }
      }
      default:
        return text(`ERROR: unknown tool ${req.params.name}`);
    }
  });

  // Wire push delivery: every received peer message becomes a channel
  // notification. Claude Code injects the content into the running session
  // as a <channel source="opencode-link">…</channel> element, waking the
  // agent the same way a typed user message would.
  link.setOutbound(async (push) => {
    const content =
      push.kind === "event"
        ? `[link event] ${push.text}`
        : `[link from ${push.fromName}] ${push.text}`;
    await mcp.notification({
      method: CHANNEL_NOTIFICATION,
      params: {
        content,
        meta: {
          source: "opencode-link",
          kind: push.kind,
          ...(push.fromCode ? { from_code: push.fromCode } : {}),
          ...(push.fromName ? { from_name: push.fromName } : {}),
        },
      },
    });
  });

  await mcp.connect(new StdioServerTransport());

  // Eager peer boot: an agent reachable from the moment Claude Code starts
  // is the whole point. Unlike opencode (where the same Bun-on-Windows native
  // unload bug hits the foreground TUI), the MCP server is a child process —
  // any teardown panic is hidden in Claude Code's MCP server logs, not the
  // user's face. So eager is fine here.
  if (link.salt.value) {
    void link.start().catch((err: Error) => {
      // Log to stderr; Claude Code captures MCP server stderr.
      console.error(`[opencode-link] eager peer boot failed: ${err.message}`);
    });
  }
}

main().catch((err) => {
  console.error("[opencode-link] MCP server failed:", err);
  process.exit(1);
});

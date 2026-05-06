#!/usr/bin/env bun
// Claude Code MCP server entry point.
//
// Same wire / peer / salt machinery as the opencode plugin (src/index.ts);
// tools are exposed via the MCP stdio protocol instead of opencode's
// `tool: { ... }` plugin shape.
//
// Note on push delivery: Claude Code 2.1.x has no public mechanism to wake
// an agent on an out-of-band notification (the docs reference a "channels"
// feature gated by --dangerously-load-development-channels, but that flag
// is absent from `claude --help`). Instead we ride Claude Code's existing
// background-task notification flow: every incoming peer message gets
// appended as a JSON line to ~/.config/opencode-link/inbox.log, and the
// agent's recommended pattern is to run a `tail`-based one-liner via Bash
// run_in_background — when a line arrives, that bash task exits, Claude Code
// notifies the agent, the agent drains link_inbox and reacts. The exact
// command is exposed via link_whoami's `delivery` field.
//
// Note on the package name: the repo is called `opencode-link` because it
// started as an opencode-only thing. The same plugin now also targets
// Claude Code via this MCP entry — the name is a historical artifact.

import { mkdir, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
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

function inboxLogPath(): string {
  const home = process.env.OPENCODE_LINK_HOME ?? join(homedir(), ".config", "opencode-link");
  return join(home, "inbox.log");
}

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
      "Drain and return all pending messages received since the last call. Returns immediately (non-blocking). Returns an empty array if no salt is configured. To WAIT for the next message instead of polling, use the background-tail pattern from link_whoami's `delivery.wait_command`.",
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
      capabilities: { tools: {} },
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
        const out: Record<string, unknown> = {
          code: link.identity.code,
          name: link.identity.name,
          salt: link.salt.origin,
          ready: link.salt.value !== null,
        };
        if (!link.salt.value) {
          out.warning =
            "NO SHARED SALT IS CONFIGURED. The link code alone is not usable yet — opencode-link needs a shared salt before any peer-to-peer connection can be established. Tell the user how to fix it (set OPENCODE_LINK_SALT env var, or write to the salt file shown). You and your peer must use the same salt.";
          out.saltFilePath = saltFilePath();
        }
        // Wake-up pattern: Claude Code has no out-of-band push for MCP
        // servers, but its Bash tool's run_in_background flow notifies the
        // agent when a background process exits. We append each new inbox
        // event as a JSON line to inbox.log, so a `tail` watching that file
        // exits as soon as something arrives → agent gets re-engaged.
        const log = inboxLogPath();
        out.delivery = {
          inbox_log: log,
          poll: "Call link_inbox at any time for a non-blocking drain of pending entries.",
          wait_via_bash: [
            "When you've sent a peer a message and want to wait for their reply WITHOUT keeping your turn open:",
            "1. Run this command via the Bash tool with run_in_background=true:",
            `     tail -n 0 -F "${log}" 2>/dev/null | head -n 1`,
            "2. End your turn. Claude Code will re-engage you automatically when the bash task exits — i.e. the moment a new peer event lands.",
            "3. On wake-up, call link_inbox to drain the queue and read what arrived.",
            "If the peer is slow / silent, the bash task just stays running until they reply or the user interrupts.",
          ].join("\n"),
        };
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

  // Append every incoming peer event to inbox.log so an external watcher
  // (e.g. `tail -n 0 -F` running as a background Bash task in Claude Code)
  // can use it as a wake-up signal. The link.inboxQueue still holds the
  // canonical entries — link_inbox drains those — but the file is the
  // signaling channel. Write best-effort; failures don't block delivery.
  const logPath = inboxLogPath();
  let logReady: Promise<void> | null = null;
  const ensureLogDir = async () => {
    if (logReady) return logReady;
    logReady = mkdir(dirname(logPath), { recursive: true }).then(() => undefined);
    return logReady;
  };
  link.setOutbound(async (push) => {
    try {
      await ensureLogDir();
      const line = JSON.stringify({
        ts: Date.now(),
        kind: push.kind,
        from_code: push.fromCode || undefined,
        from_name: push.fromName || undefined,
        text: push.text,
      });
      await appendFile(logPath, line + "\n", "utf8");
    } catch (err) {
      // Best-effort. The in-memory queue still has the entry, so the agent
      // can still read it via link_inbox. Just log to stderr.
      console.error(`[opencode-link] inbox.log append failed: ${(err as Error).message}`);
    }
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

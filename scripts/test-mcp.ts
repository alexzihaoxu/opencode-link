// Smoke-test the MCP server via stdio. Spawns src/mcp.ts as a child, sends
// it `initialize` + `tools/list`, calls each tool that's safe to call without
// a peer (link_whoami, link_inbox, link_peers), checks the responses.

import { spawn } from "node:child_process";

const SHARED_SALT = `test-salt-mcp-${Date.now()}`;
const proc = spawn(
  process.platform === "win32" ? "bun.exe" : "bun",
  ["run", "src/mcp.ts"],
  {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, OPENCODE_LINK_SALT: SHARED_SALT },
    cwd: process.cwd(),
  },
);

let stdoutBuf = "";
let stderrBuf = "";
const pending = new Map<number, { resolve: (m: any) => void; reject: (e: Error) => void }>();
let nextId = 1;

proc.stdout!.on("data", (chunk) => {
  stdoutBuf += chunk.toString();
  let i: number;
  while ((i = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, i).trim();
    stdoutBuf = stdoutBuf.slice(i + 1);
    if (!line) continue;
    let msg: any;
    try { msg = JSON.parse(line); } catch { continue; }
    if ("id" in msg && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    } else if (msg.method) {
      console.log(`[server-notification] ${msg.method}`, msg.params);
    }
  }
});
proc.stderr!.on("data", (chunk) => {
  stderrBuf += chunk.toString();
});
proc.on("exit", (code, sig) => {
  console.log(`[child exit] code=${code} sig=${sig}`);
});

function rpc<T = any>(method: string, params?: unknown): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`rpc timeout: ${method}`));
      }
    }, 8000);
  });
}

function send(method: string, params?: unknown): void {
  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

async function main() {
  // 1. initialize handshake
  console.log("---initialize---");
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: { experimental: { "claude/channel": {} } },
    clientInfo: { name: "opencode-link-test", version: "0.0.0" },
  });
  console.log("server:", init.serverInfo, "capabilities:", JSON.stringify(init.capabilities));

  send("notifications/initialized");

  // 2. tools/list
  console.log("---tools/list---");
  const tools = await rpc<{ tools: Array<{ name: string; description: string }> }>("tools/list");
  console.log("tool count:", tools.tools.length);
  for (const t of tools.tools) console.log(" -", t.name);

  const expected = [
    "link_whoami",
    "link_set_name",
    "link_connect",
    "link_send",
    "link_inbox",
    "link_peers",
    "link_rotate",
  ];
  const missing = expected.filter((n) => !tools.tools.find((t) => t.name === n));
  if (missing.length) {
    console.error("MISSING TOOLS:", missing);
    process.exit(1);
  }

  // 3. link_whoami — safe to call, doesn't require a peer to be connectable
  console.log("---tools/call link_whoami---");
  const whoami = await rpc("tools/call", { name: "link_whoami", arguments: {} });
  console.log("whoami:", whoami.content[0].text);

  // 4. link_inbox — empty initially
  console.log("---tools/call link_inbox---");
  const inbox = await rpc("tools/call", { name: "link_inbox", arguments: {} });
  console.log("inbox:", inbox.content[0].text);

  // 5. link_peers — empty initially
  console.log("---tools/call link_peers---");
  const peers = await rpc("tools/call", { name: "link_peers", arguments: {} });
  console.log("peers:", peers.content[0].text);

  // 6. link_set_name
  console.log("---tools/call link_set_name---");
  const named = await rpc("tools/call", { name: "link_set_name", arguments: { name: "mcp-tester" } });
  console.log("set_name:", named.content[0].text);

  // 7. End-to-end: connect a peer to the MCP server's link, send a message,
  //    confirm the MCP server emits a `notifications/claude/channel` event.
  console.log("---channel-notification test---");
  const whoamiData = JSON.parse(whoami.content[0].text);
  const mcpCode: string = whoamiData.code;

  const channelMessages: any[] = [];
  // Hook into stdout to capture channel notifications. Since the proc.stdout
  // listener at the top of this file already routes notifications via the
  // `[server-notification]` log path, we add a sniffer here. Easiest: tap the
  // existing flow by wrapping the listener — instead, reuse a tiny intercept.
  proc.stdout!.removeAllListeners("data");
  let buf = "";
  proc.stdout!.on("data", (chunk) => {
    buf += chunk.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.method === "notifications/claude/channel") {
        channelMessages.push(msg);
      }
      if ("id" in msg && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    }
  });

  const { Link } = await import("../src/link.ts");
  const peerCode = `RX${Math.random().toString(36).slice(2, 6).toUpperCase()}`.slice(0, 6);
  const peer = new Link(
    { code: peerCode, name: "test-peer" },
    { value: SHARED_SALT, origin: "env" as const },
  );
  await peer.start();
  console.log(`peer started with code ${peerCode}, dialing MCP server (${mcpCode})`);
  await peer.connect(mcpCode);
  await new Promise((r) => setTimeout(r, 300)); // hello roundtrip
  await peer.send(mcpCode, "hello from external peer");
  console.log("waiting for channel notification...");
  await new Promise((r) => setTimeout(r, 1500));

  const msgChannels = channelMessages.filter(
    (m) => m.params?.meta?.kind === "msg",
  );
  if (msgChannels.length === 0) {
    console.error("FAIL: no channel notification emitted for the peer message");
    console.error("all channel messages:", channelMessages);
    proc.kill("SIGKILL");
    process.exit(1);
  }
  console.log(`got ${channelMessages.length} channel notification(s):`);
  for (const m of channelMessages) {
    console.log("  content:", JSON.stringify(m.params.content));
    console.log("  meta:   ", JSON.stringify(m.params.meta));
  }

  console.log("---all checks passed, shutting down---");
  proc.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  if (stderrBuf) console.log("---stderr---\n" + stderrBuf);
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL:", err);
  if (stderrBuf) console.error("---stderr---\n" + stderrBuf);
  proc.kill("SIGKILL");
  process.exit(1);
});

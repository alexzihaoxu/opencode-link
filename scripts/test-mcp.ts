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
  //    confirm the MCP server appends to inbox.log (the wake-up signal for
  //    the agent's tail-based bash watcher) AND that link_inbox returns the
  //    message.
  console.log("---inbox-log + receive test---");
  const whoamiData = JSON.parse(whoami.content[0].text);
  const mcpCode: string = whoamiData.code;
  const inboxLog: string = whoamiData.delivery?.inbox_log;
  if (!inboxLog) {
    console.error("FAIL: link_whoami response is missing delivery.inbox_log");
    process.exit(1);
  }
  console.log("inbox_log path:", inboxLog);

  // Snapshot log size BEFORE the peer sends, so we can detect growth.
  const fs = await import("node:fs/promises");
  let beforeSize = 0;
  try { beforeSize = (await fs.stat(inboxLog)).size; } catch {}
  console.log("inbox.log size before:", beforeSize);

  const { Link } = await import("../src/link.ts");
  const peerCode = `RX${Math.random().toString(36).slice(2, 6).toUpperCase()}`.slice(0, 6);
  const peer = new Link(
    { code: peerCode, name: "test-peer" },
    { value: SHARED_SALT, origin: "env" as const },
  );
  await peer.start();
  console.log(`peer started with code ${peerCode}, dialing MCP server (${mcpCode})`);
  await peer.connect(mcpCode);
  await new Promise((r) => setTimeout(r, 300));
  await peer.send(mcpCode, "hello from external peer");
  console.log("waiting for inbox.log to grow + link_inbox to see message...");
  await new Promise((r) => setTimeout(r, 1500));

  // Verify inbox.log has new content
  let afterSize = 0;
  let logTail = "";
  try {
    afterSize = (await fs.stat(inboxLog)).size;
    const buf = await fs.readFile(inboxLog, "utf8");
    logTail = buf.split("\n").filter(Boolean).slice(-3).join("\n");
  } catch (e) {
    console.error("FAIL: cannot read inbox.log:", (e as Error).message);
    proc.kill("SIGKILL");
    process.exit(1);
  }
  if (afterSize <= beforeSize) {
    console.error(`FAIL: inbox.log did not grow (before=${beforeSize}, after=${afterSize})`);
    proc.kill("SIGKILL");
    process.exit(1);
  }
  console.log(`inbox.log grew ${beforeSize} → ${afterSize} bytes; last entries:\n${logTail}`);

  // Verify link_inbox tool also sees the message
  const inboxAfter = await rpc("tools/call", { name: "link_inbox", arguments: {} });
  const inboxResp = JSON.parse(inboxAfter.content[0].text);
  if (!inboxResp.wait_for_next?.command || !inboxResp.wait_for_next.command.includes("tail -c")) {
    console.error("FAIL: link_inbox response missing wait_for_next.command (byte-anchored tail)");
    console.error("response:", inboxResp);
    proc.kill("SIGKILL");
    process.exit(1);
  }
  const entries = inboxResp.entries;
  const msgEntry = entries.find((e: any) => e.kind === "msg" && e.text === "hello from external peer");
  if (!msgEntry) {
    console.error("FAIL: link_inbox did not return the peer message");
    console.error("entries:", entries);
    proc.kill("SIGKILL");
    process.exit(1);
  }
  console.log("link_inbox returned the msg entry:", JSON.stringify(msgEntry));

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

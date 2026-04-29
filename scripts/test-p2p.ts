// Round-trip test for the vendored peerjs-on-node fork (lobbify-client build).
// Confirms two peers can register on PeerJS public signaling, open a data
// channel, and exchange messages.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const { Peer } = require("peerjs-on-node");

function log(tag: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString().slice(11, 23)}] [${tag}]`, ...args);
}

const SERVER_ID = `oclink-test-server-${process.pid}`;

let success = false;

async function main() {
  log("main", "starting two-peer round-trip");

  const server: any = new Peer(SERVER_ID, { debug: 2 });
  const client: any = new Peer({ debug: 2 });

  server.on("open", (id: string) => log("server", "open", id));
  server.on("error", (e: Error) => log("server", "error", e.message));
  server.on("connection", (conn: any) => {
    log("server", "incoming connection from", conn.peer);
    conn.on("open", () => {
      log("server", "conn open");
    });
    conn.on("data", (msg: unknown) => {
      log("server", "received", msg);
      conn.send(`echo: ${msg}`);
    });
    conn.on("error", (e: Error) => log("server", "conn error", e.message));
  });

  client.on("open", (id: string) => log("client", "open", id));
  client.on("error", (e: Error) => log("client", "error", e.message));

  await new Promise<void>((resolve) => {
    let opened = 0;
    const tick = () => {
      opened++;
      if (opened === 2) resolve();
    };
    server.once("open", tick);
    client.once("open", tick);
  });

  log("main", "both peers open, dialling server from client");
  const conn = client.connect(SERVER_ID, { reliable: true });

  conn.on("open", () => {
    log("client", "conn open, sending hello");
    conn.send("hello");
  });
  conn.on("error", (e: Error) => log("client", "conn error", e.message));
  conn.on("data", (reply: unknown) => {
    log("client", "received reply", reply);
    success = reply === "echo: hello";
    finish();
  });

  setTimeout(() => {
    if (!success) {
      log("main", "TIMEOUT — connection did not complete");
      finish();
    }
  }, 12000);
}

function finish() {
  log("main", `SUCCESS=${success}`);
  // Skip explicit destroy() — see Bun + native wrtc teardown notes.
  setTimeout(() => process.exit(success ? 0 : 1), 200);
}

main().catch((err) => {
  log("main", "FAILED", err);
  process.exit(2);
});

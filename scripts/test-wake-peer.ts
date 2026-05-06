// Spawned in background by the agent to simulate a remote peer arriving and
// sending a message. Connects to whatever code is in argv[2], using the salt
// from ~/.config/opencode-link/salt, after a delay (argv[3] ms, default 3000).

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const targetCode = process.argv[2];
const delayMs = Number(process.argv[3] ?? "3000");

if (!targetCode || targetCode.length !== 6) {
  console.error("usage: test-wake-peer.ts <6-char-code> [delayMs]");
  process.exit(2);
}

const salt = (
  await readFile(join(homedir(), ".config", "opencode-link", "salt"), "utf8")
).trim();

// Reuse the installed copy so we share the same vendored peerjs-on-node.
const linkModulePath = join(
  homedir(),
  ".config/opencode-link/install/node_modules/opencode-link/src/link.ts",
);
const { Link } = await import(linkModulePath);

const peerCode = `WAKE${Math.random().toString(36).slice(2, 4).toUpperCase()}`.slice(0, 6);
const peer = new Link({ code: peerCode, name: "wake-test-peer" }, { value: salt, origin: "file" });
await peer.start();
console.log(`peer ${peerCode} up; dialing ${targetCode}...`);
await peer.connect(targetCode);
console.log(`connected to ${targetCode}; sleeping ${delayMs}ms before send`);
await new Promise((r) => setTimeout(r, delayMs));
await peer.send(targetCode, `WAKE-UP TEST: hello from ${peerCode} at ${new Date().toISOString()}`);
console.log("message sent; exiting");
process.exit(0);

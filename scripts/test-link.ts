// End-to-end exercise of the Link class. Boots two Link instances with
// distinct codes, has one connect to the other, sends a message, checks
// delivery on both sides via inbox.

import type { Identity } from "../src/identity.ts";
import { Link } from "../src/link.ts";

function log(tag: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString().slice(11, 23)}] [${tag}]`, ...args);
}

const aIdentity: Identity = { code: "TESTAA", name: "alice" };
const bIdentity: Identity = { code: "TESTBB", name: "bob" };

async function main() {
  log("main", "creating Links");
  const linkA = new Link(aIdentity);
  const linkB = new Link(bIdentity);

  await linkA.start();
  log("a", "started");
  await linkB.start();
  log("b", "started");

  log("a", "connecting to b");
  await linkA.connect(bIdentity.code);
  log("a", "connected");

  await new Promise((r) => setTimeout(r, 300));

  log("a", "sending message to b");
  await linkA.send(bIdentity.code, "ping from alice");

  await new Promise((r) => setTimeout(r, 600));

  const aInbox = linkA.inbox();
  const bInbox = linkB.inbox();

  log("a", "inbox", aInbox);
  log("b", "inbox", bInbox);

  const helloOnA = aInbox.find((e) => e.kind === "system" && e.from === bIdentity.code);
  const helloOnB = bInbox.find((e) => e.kind === "system" && e.from === aIdentity.code);
  const msgOnB = bInbox.find((e) => e.kind === "msg" && e.text === "ping from alice");

  const ok = !!(helloOnA && helloOnB && msgOnB);
  log("main", `helloOnA=${!!helloOnA} helloOnB=${!!helloOnB} msgOnB=${!!msgOnB}`);

  log("main", "peers from A:", linkA.peers());
  log("main", "peers from B:", linkB.peers());

  log("main", `SUCCESS=${ok}`);
  setTimeout(() => process.exit(ok ? 0 : 1), 200);
}

main().catch((err) => {
  log("main", "FAILED", err);
  process.exit(2);
});

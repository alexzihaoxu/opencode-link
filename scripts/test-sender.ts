// Counterpart to test-receiver.ts. Boots a Link, connects to a target code,
// sends one message, then exits. Used to exercise cross-process delivery
// since the in-process test in test-link.ts cannot detect bugs that only
// surface when two opencode instances live in different processes.

import type { Identity, SaltSource } from "../src/identity.ts";
import { Link } from "../src/link.ts";

const identity: Identity = {
  code: process.env.SENDER_CODE ?? "SENDAA",
  name: process.env.SENDER_NAME ?? "test-sender",
};
const salt: SaltSource = {
  value: process.env.OPENCODE_LINK_SALT ?? "test-receiver-salt",
  origin: "env",
};
const target = process.env.TARGET_CODE ?? "RECVAA";
const text = process.env.TARGET_TEXT ?? "hello from sender";

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[+${Date.now() - t0}ms]`, ...a);

const link = new Link(identity, salt);
log("starting peer");
await link.start();
log("peer ready, connecting to", target);
await link.connect(target);
log("connected, sending message");
await link.send(target, text);
log("sent");
await new Promise((r) => setTimeout(r, 1000));
log("inbox snapshot:", link.inbox());
process.exit(0);

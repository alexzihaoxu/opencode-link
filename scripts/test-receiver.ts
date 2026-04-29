// Background receiver. Boots a Link with a fixed code, listens for incoming
// messages, prints them. Pair with an opencode session calling
// link_connect / link_send to verify end-to-end delivery.

import type { Identity } from "../src/identity.ts";
import { Link } from "../src/link.ts";

const identity: Identity = {
  code: process.env.RECEIVER_CODE ?? "RECVAA",
  name: process.env.RECEIVER_NAME ?? "test-receiver",
};

const link = new Link(identity);
await link.start();
console.log(`READY code=${identity.code} name=${identity.name}`);

setInterval(() => {
  const messages = link.inbox();
  for (const m of messages) {
    console.log(`MSG kind=${m.kind} from=${m.fromName}(${m.from}) text=${JSON.stringify(m.text)}`);
  }
}, 250);

await new Promise(() => {});

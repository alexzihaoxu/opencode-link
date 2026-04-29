# opencode-link

Peer-to-peer messaging between [opencode](https://opencode.ai) agents over WebRTC. Each agent gets a short 6-character link code; share the code, and two agents on different machines (or two terminals on one machine) can talk directly.

> Status: pre-alpha. Tested on Windows + Bun 1.3 with PeerJS public signaling. macOS and Linux should work but are untested.

## Quick install

```bash
# macOS / Linux / Git Bash on Windows
curl -fsSL https://raw.githubusercontent.com/AlexZihaoXu/opencode-link/main/install.sh | bash
```
```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/AlexZihaoXu/opencode-link/main/install.ps1 | iex
```

Then restart opencode. The agent has six new tools (`link_whoami`, `link_set_name`, `link_connect`, `link_send`, `link_inbox`, `link_peers`). Ask it *"what's your link code?"* in one terminal; paste that code in another and ask *"connect to ABC123 and say hi."*

## How it works

- Every `opencode` process gets a freshly generated **6-character link code** like `A1GH35` (uppercase letters + digits). That code is what users share between agents.
- The actual PeerJS id used on the public signaling server is `sha256("opencode-link.v1::" + code)` — a 64-char hex string. The hash namespaces opencode-link agents away from random PeerJS users (so codes don't collide with unrelated apps) while keeping the user-facing token short and typeable.
- The agent has no display name by default — the system prompt instructs it to pick one for itself via `link_set_name` on its first link-related turn.
- The peer is started **eagerly** when opencode loads (not lazily on first tool call), so the agent is reachable from the moment it boots — even before the user has asked it to do anything.
- Other agents call `link_connect(code)` to open a direct WebRTC data channel; messages are JSON frames over that channel.
- Incoming peer messages are **pushed** into the agent's running session via `client.session.prompt()` — the agent gets woken up the same way a user typing would wake it. Messages are also queued in a fallback inbox.
- A system-prompt entry is injected on every turn (via `experimental.chat.system.transform`) telling the agent its own code, name, and how to recognize and reply to incoming peer messages.

## Install details

The quick install at the top covers most cases. Some details:

**What the installer does**

1. `bun add github:AlexZihaoXu/opencode-link` into `~/.config/opencode/`.
2. Trusts `node-datachannel`'s postinstall so the prebuilt native binary actually downloads.
3. Drops a one-line bridge file at `~/.config/opencode/plugins/opencode-link.ts` that re-exports the plugin (avoids opencode's npm-name resolver fetching a different package by the same name).

**Upgrade**: re-run the install command (idempotent).

**Uninstall**:

```bash
curl -fsSL https://raw.githubusercontent.com/AlexZihaoXu/opencode-link/main/uninstall.sh | bash
```
```powershell
irm https://raw.githubusercontent.com/AlexZihaoXu/opencode-link/main/uninstall.ps1 | iex
```

Removes the package and the bridge file; run interactively to also wipe persisted identities at `~/.config/opencode-link/`.

**Manual install** (sandbox / CI):

```bash
cd ~/.config/opencode
bun add github:AlexZihaoXu/opencode-link
bun pm trust node-datachannel
mkdir -p plugins
echo 'export { server } from "opencode-link";' > plugins/opencode-link.ts
```

**Requirements**

- [`bun`](https://bun.sh) on `PATH`
- [`opencode`](https://opencode.ai) ≥ 1.14
- The plugin transitively depends on [`node-datachannel`](https://www.npmjs.com/package/node-datachannel) for WebRTC. Prebuilt native binaries ship for Windows / macOS / Linux on common architectures; other platforms need a working C++ toolchain.

**Native shim**

PeerJS in Bun runs through a vendored, **patched** fork of `peerjs-on-node` at `lib/peerjs-on-node/` — see `lib/peerjs-on-node/NOTICE.md` for upstream attribution and a description of the local patches.

## Tools

| Tool            | Args                            | Returns                                                       |
| --------------- | ------------------------------- | ------------------------------------------------------------- |
| `link_whoami`   | —                               | `{ code, name }` for this agent                               |
| `link_set_name` | `name: string`                  | confirmation; broadcasts the rename to live peers             |
| `link_connect`  | `code: string`                  | opens a connection to another agent by 6-char code            |
| `link_send`     | `code: string, text: string`    | sends a text message                                          |
| `link_inbox`    | —                               | drains and returns all pending `InboxEntry`s                  |
| `link_peers`    | —                               | lists currently connected peers with their codes and names   |

`InboxEntry` shape:

```ts
{
  from: string;       // remote agent's 6-char code
  fromName: string;   // remote's last-known display name (or code if unset)
  text: string;
  ts: number;         // ms since epoch
  kind: "msg" | "system";   // "system" for hello/rename notifications
}
```

Codes are case-insensitive on input but always normalized to uppercase. Anything that isn't 6 characters of `[A-Z0-9]` after normalization is rejected.

## Quickstart

Just run `opencode` in two terminals — no env vars needed. Each one gets its own fresh 6-char link code and the agents will each pick a name for themselves.

1. In terminal **A**: ask the agent *"what's your link code?"* — it calls `link_whoami` and reports something like `A1GH35` (and a name if it picked one).
2. Paste A's code into terminal **B** and ask *"connect to `A1GH35` and send 'hi'."*
3. Terminal **A** sees a new user-side message: `[link from <B's name>] hi` and replies via `link_send`.

If A is mid-turn when the message lands, opencode queues it behind the in-flight response. If no session is bound yet, the message sits in the inbox until one binds.

## Delivery model

Every received peer message goes two places:

1. **Pushed** to the most recently active session via `client.session.prompt({ parts: [{ type: "text", text: "[link from <name>] <text>" }] })`. This wakes the agent for that session.
2. **Inboxed** in an in-memory queue, drainable via `link_inbox`. Useful if the push fails (no session, transport error) or the agent wants to batch-read background traffic.

Session binding: the plugin tracks session ids via `session.created` / `session.idle` / `session.deleted` events, and updates "current session" on every `link_*` tool call (using `ctx.sessionID`). If multiple sessions are open, the most recently active one wins.

## Configuration

All env vars are optional. Plain `opencode` works.

| Variable                 | Default                                  | Purpose                                                                                                                      |
| ------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `OPENCODE_LINK_NAME`     | unset (agent picks one)                  | Pre-assign a display name instead of letting the agent self-name on its first turn.                                          |
| `OPENCODE_LINK_PROFILE`  | unset (fresh code per process)           | Opt into a stable code persisted at `~/.config/opencode-link/identity-<profile>.json`. Same profile next launch = same code. |
| `OPENCODE_LINK_HOME`     | `~/.config/opencode-link`                | Where profile identity files live (only used when `OPENCODE_LINK_PROFILE` is set).                                          |
| `OPENCODE_LINK_HOST`     | PeerJS public cloud (`0.peerjs.com`)     | Signaling server hostname                                                                                                    |
| `OPENCODE_LINK_PORT`     | `443`                                    | Signaling server port                                                                                                        |
| `OPENCODE_LINK_PATH`     | `/`                                      | Signaling server path                                                                                                        |
| `OPENCODE_LINK_KEY`      | PeerJS default                           | Signaling api key                                                                                                            |
| `OPENCODE_LINK_SECURE`   | `true`                                   | Use `wss://` instead of `ws://`                                                                                              |

The link code is always randomly generated — you don't pick it. Without `OPENCODE_LINK_PROFILE`, every launch gets a fresh 6-char code (so two terminals never collide). Set `OPENCODE_LINK_PROFILE=foo` if you want a friend's saved code of yours to keep working across restarts:

```bash
# terminal A — same code every launch under this profile
OPENCODE_LINK_PROFILE=alice OPENCODE_LINK_NAME=alice opencode

# terminal B
OPENCODE_LINK_PROFILE=bob OPENCODE_LINK_NAME=bob opencode
```

Each agent calls `link_whoami` to fetch its 6-char code. Paste A's code into B's session and ask: *"connect to `A1GH35` and send 'hi'."* A wakes with `[link from bob] hi`.

To self-host signaling, run [`peerjs-server`](https://github.com/peers/peerjs-server) and point the env vars at it. WebRTC media itself is still peer-to-peer; the signaling server only carries the initial handshake (offer/answer/ICE) on top of which the data channel runs directly between agents.

## What the agent sees

On every turn, the system prompt is appended with something like:

```
You have access to opencode-link, a peer-to-peer messaging tool that connects you with other opencode agents over WebRTC.
Use it when the user asks you to talk to or coordinate with another agent.

Your identity:
- Link code (random per session, share with others so they can reach you): A1GH35
- Display name: <name>  (or instructions to pick one if unset)

Tools: link_whoami, link_set_name(name), link_connect(code), link_send(code, text), link_inbox, link_peers.
Codes are 6 characters of A-Z and 0-9 (e.g. `A1GH35`). Anything else is invalid.

Incoming peer messages arrive as new user-side messages prefixed `[link from <name>]`. They are not from the human — they are from another agent.

When to reply via link_send (and only via link_send — plain output is not routed back):
- Reply when you have a real answer, question, status update, or new information to deliver.
- Do NOT reply to acknowledgments, 'understood', 'thanks', 'ok', or other purely social/closing messages. Replying just bounces another ack back and creates an infinite politeness loop.
- Do NOT repeat what you said in your previous turn.
- Silence is a valid response. If the exchange has reached a natural close, stop calling link_send.

Treat the link as async coordination, not chat. Send only when something substantive needs to cross.
If you suspect background messages may have queued up while you were busy, call link_inbox at the start of your turn.
```

This re-renders each turn, so renaming via `link_set_name` is reflected immediately.

## Layout

```
src/
  identity.ts   # 6-char code generation + per-profile persistence
  link.ts       # PeerJS wrapper, connection map, inbox queue, push delivery
  tools.ts      # @opencode-ai/plugin tool() bindings (each binds session id from ctx)
  index.ts      # plugin entry — boots Link, registers tools, system.transform + event hooks
lib/
  peerjs-on-node/   # vendored fork (committed pre-built dist, see NOTICE.md)
scripts/
  test-p2p.ts       # raw two-peer round-trip (peerjs-on-node directly)
  test-link.ts      # round-trip exercising the Link class end-to-end via codes
  test-receiver.ts  # background receiver for opencode↔bun integration testing
```

Run the tests with `bun run scripts/test-p2p.ts` and `bun run scripts/test-link.ts`. Both contact the public PeerJS signaling server, so they need internet.

## Roadmap

- [ ] Wire-protocol versioning so future message kinds don't break older peers.
- [ ] `link_disconnect(code)`.
- [ ] Optional encryption layer (NaCl box) so payloads aren't readable by the signaling relay if it's TURN-fallback'd.
- [ ] Discovery/directory mode — connect by name to an agent in a known group rather than by raw code.
- [ ] File transfer (chunked binary messages).

## License

MIT

# opencode-link

Peer-to-peer messaging between AI coding agents — [opencode](https://opencode.ai) and [Claude Code](https://claude.com/claude-code) — over WebRTC. Each agent gets a 6-character link code under a **shared salt** (a group secret); share both, and agents on different machines, different terminals, or different harnesses can talk directly.

> **About the name:** the project started life targeting opencode and got the name from there. The same codebase now also ships as a Claude Code MCP server. Don't read too much into "opencode" in the package name — it's a historical artifact, not a scoping decision. Both harnesses are fully supported.

> **Status: pre-alpha.** Tested on Windows + Bun 1.3 against PeerJS public signaling. macOS x64 / arm64 and Linux x64 / arm64 use the same prebuilt native binary path and should work but haven't been physically verified.

## Install

Pick the harness(es) you use. Installs are independent — install one or both.

### opencode

```bash
# macOS / Linux / Git Bash on Windows
curl -fsSL https://raw.githubusercontent.com/AlexZihaoXu/opencode-link/main/install.sh | bash
```
```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/AlexZihaoXu/opencode-link/main/install.ps1 | iex
```

### Claude Code

```bash
# macOS / Linux / Git Bash on Windows
curl -fsSL https://raw.githubusercontent.com/AlexZihaoXu/opencode-link/main/install-claude.sh | bash
```
```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/AlexZihaoXu/opencode-link/main/install-claude.ps1 | iex
```

Registers as a user-scope MCP server via `claude mcp add`. After install, restart any open `claude` sessions. To enable the wake-up-on-incoming-message feature (Claude Code "channels", currently experimental), launch with:

```bash
claude --dangerously-load-development-channels server:opencode-link
```

Without that flag, the link tools (`link_whoami`, `link_connect`, `link_send`, etc.) all work fine — incoming peer messages just go to the inbox and the agent reads them via `link_inbox` instead of being woken automatically.

After installing, **set a shared salt** — both ends of any conversation must use the same salt or they cannot reach each other.

```bash
# Pick one of these. The env var wins if both are set.

# Option A: env var (highest priority, ephemeral)
export OPENCODE_LINK_SALT="$(openssl rand -hex 32)"

# Option B: persisted file (survives shells)
mkdir -p ~/.config/opencode-link
openssl rand -hex 32 > ~/.config/opencode-link/salt
```

Share that salt out of band (Signal, password manager, in-person) with anyone you want to talk to. They set the same value on their machine. Without a salt configured on both sides, no connection can be established — the agent will surface this and ask the user to set one.

Then restart opencode. Manual install, uninstall, and requirements are at the bottom of this README.

## Try it

Once the salt is set on both ends, agents in either harness can talk to each other.

1. In terminal **A** (e.g. `opencode`): ask the agent *"what's your link code?"* It calls `link_whoami` and reports something like `A1GH35`.
2. In terminal **B** (e.g. `claude`, same salt): paste A's code and say *"connect to `A1GH35` and send 'hi'."*
3. Terminal **A**'s agent is woken with a new user-side message: `[link from <B's name>] hi`. It can reply by calling `link_send`.

A and B can be different harnesses (one opencode, one Claude Code) — the wire protocol is host-agnostic.

If A is mid-turn when the message lands, the host queues it behind the in-flight response (same machinery as a user typing while the agent is busy). If A's plugin hasn't bound a session yet (opencode) or the channels flag wasn't passed (Claude Code), the message lands in `link_inbox` instead — the agent reads it on its next call.

## Tools

| Tool            | Args                            | Returns                                                       |
| --------------- | ------------------------------- | ------------------------------------------------------------- |
| `link_whoami`   | —                               | `{ code, name }` for this agent                               |
| `link_set_name` | `name: string`                  | confirmation; broadcasts the rename to live peers             |
| `link_connect`  | `code: string`                  | opens a connection to another agent by 6-char code            |
| `link_send`     | `code: string, text: string`    | sends a text message to a connected peer                      |
| `link_inbox`    | —                               | drains and returns all pending `InboxEntry`s                  |
| `link_peers`    | —                               | lists currently connected peers (`{ code, name, connectedAt }`) |

`link_whoami` returns:

```ts
{
  code: string;            // 6-char A-Z0-9
  name: string;            // empty until link_set_name has been called
  salt: "env" | "file" | "none";  // where the salt came from
  ready: boolean;          // false iff salt is "none" — connections won't work
  warning?: string;        // only present when ready === false
}
```

`InboxEntry` shape:

```ts
{
  from: string;       // remote agent's 6-char code (or "" if hello hasn't arrived yet)
  fromName: string;   // remote's display name; falls back to code, then to a short
                      // hex prefix of the peer hash if neither is known
  text: string;
  ts: number;         // ms since epoch
  kind: "msg" | "system";   // "system" for hello / rename notifications
}
```

**Code format.** Six characters of `[A-Z0-9]`. Input is case-insensitive — anything else is normalized away (whitespace, punctuation) and rejected if the result isn't exactly 6 chars. The character set includes the visually-confusable pairs `I`/`1` and `O`/`0`; if you're sharing codes verbally, double-check those.

## How it works

- **Identity.** Every host process (opencode plugin or Claude Code MCP server) generates a random 6-char code at load. Without `OPENCODE_LINK_PROFILE`, the code lives only in memory — restart and you get a fresh one. With a profile, the code is persisted at `~/.config/opencode-link/identity-<profile>.json` and reused on next launch.
- **Hashed PeerJS id, salted by group secret.** The actual id registered on PeerJS public signaling is `sha256(salt + "|" + code)` — a 64-char hex string. The salt is the **shared group secret** (env var `OPENCODE_LINK_SALT` or file `~/.config/opencode-link/salt`). Only agents using the same salt produce matching hashes and can reach each other. There is no default salt: without one, the host refuses to start the peer and any `link_*` tool returns a clear error telling the agent to ask the user to configure one.
- **Eager peer boot.** The host starts the PeerJS peer at load (opencode under `OPENCODE_LINK_EAGER=1`; Claude Code unconditionally), so an agent is reachable from the moment its session opens. Lazy boot is the opencode default because of an unrelated Bun-on-Windows native-module unload bug; the MCP server is a child process so the bug is hidden there even if it fires.
- **Connect & wire format.** `link_connect(code)` opens a direct WebRTC data channel via PeerJS. Both sides exchange a `hello` message containing their code + name, then exchange `msg` frames as JSON.
- **Push delivery.** When a peer message arrives, the host wakes the agent. On opencode this calls `client.session.prompt()` to inject `[link from <name>] <text>` as a new user-side message in the most recently active session. On Claude Code it emits a `notifications/claude/channel` MCP event with the same content; Claude Code injects it into the running session as a `<channel source="opencode-link">…</channel>` element. Either way the agent processes it as if the user typed it. Messages are also queued in an in-memory inbox (`link_inbox`) as a fallback for when no session is bound, or for batch reads.
- **Per-turn system-prompt injection (opencode only).** opencode's `experimental.chat.system.transform` hook prepends a block telling the agent its own code, name, salt status, and reply rules — re-rendered each turn so renames and connection state are always current. Claude Code has no equivalent hook, so MCP tool descriptions carry the equivalent guidance and the agent learns its identity on first `link_whoami` call. End behaviour is the same.

## Configuration

All env vars are optional. Plain `opencode` works.

| Variable                | Default                              | Purpose                                                                                                                       |
| ----------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `OPENCODE_LINK_SALT`    | **unset — required**                 | Shared group secret. Hashed with the code to derive the PeerJS id. Falls back to the salt file if unset; if neither, no connection works. |
| `OPENCODE_LINK_NAME`    | unset (agent picks one)              | Pre-assign the display name instead of letting the agent self-name on its first link turn.                                     |
| `OPENCODE_LINK_PROFILE` | unset (fresh code per process)       | Opt into a stable code persisted at `~/.config/opencode-link/identity-<profile>.json`. Same profile next launch = same code.  |
| `OPENCODE_LINK_HOME`    | `~/.config/opencode-link`            | Identity / salt file directory.                                                                                                |
| `OPENCODE_LINK_EAGER`   | unset (lazy boot)                    | Set to `1` to load peerjs / `node-datachannel` and register on signaling at plugin init. Otherwise these load on first link tool call. Lazy is the default because Bun on Windows panics during native-module unload when node-datachannel was loaded — a clean ctrl+c right after `opencode` launch would crash. Eager mode is fine if you don't ctrl+c bare sessions. |
| `OPENCODE_LINK_HOST`    | PeerJS public cloud (`0.peerjs.com`) | Signaling server hostname.                                                                                                     |
| `OPENCODE_LINK_PORT`    | `443`                                | Signaling server port.                                                                                                         |
| `OPENCODE_LINK_PATH`    | `/`                                  | Signaling server path.                                                                                                         |
| `OPENCODE_LINK_KEY`     | PeerJS default                       | Signaling api key.                                                                                                             |
| `OPENCODE_LINK_SECURE`  | `true`                               | Use `wss://` instead of `ws://`.                                                                                               |

**Salt** (the security primitive). The salt is a shared secret that scopes who can reach you. Two agents with different salts compute different PeerJS hashes from the same code and simply do not see each other on the signaling server. There is no default — without one, no connection is possible.

Resolution order, highest priority first:

1. `OPENCODE_LINK_SALT` env var (if set and non-empty).
2. File at `~/.config/opencode-link/salt` (or `$OPENCODE_LINK_HOME/salt`). Plain text, leading/trailing whitespace trimmed.
3. Neither set → `link.start()` refuses; the agent's system prompt and `link_whoami`'s response both carry a clear "set a salt" message.

Pick a salt with real entropy (e.g. `openssl rand -hex 32`) and treat it like a Wi-Fi PSK: share with the group via a trusted channel, rotate when needed, never paste it where the 6-char code might be screenshotted.

**Profiles.** Codes are random by default — fresh one per `opencode` launch — so two terminals on the same machine never collide. If you want a code that survives restarts (e.g. so a friend's saved code keeps working), give the launch a profile name:

```bash
# stable code under "alice", with display name preset
OPENCODE_LINK_PROFILE=alice OPENCODE_LINK_NAME=alice opencode
```

**Self-hosted signaling.** Run [`peerjs-server`](https://github.com/peers/peerjs-server) and point `OPENCODE_LINK_HOST` / `_PORT` / `_PATH` at it. WebRTC media is still peer-to-peer; the signaling server only carries the offer / answer / ICE handshake before the direct data channel takes over.

## What the agent sees

The two harnesses give the agent context differently.

**On opencode**, the plugin uses the `experimental.chat.system.transform` hook to append a system-prompt block on every turn. The content depends on whether a salt is configured. With a salt configured (code `A1GH35`, unset display name) the block looks like this:

```
You have access to opencode-link, a peer-to-peer messaging tool that connects you with other opencode agents over WebRTC.
Use it when the user asks you to talk to or coordinate with another agent.

Your identity:
- Link code (random per session, share with others so they can reach you): A1GH35
- Display name: NOT SET. Pick a short fun name for yourself and call link_set_name once at the start of any link-related conversation. The user has not assigned one.
- Namespace salt: configured (from env var OPENCODE_LINK_SALT). You can only reach agents whose salt matches.

Tools: link_whoami, link_set_name(name), link_connect(code), link_send(code, text), link_inbox, link_peers.
Codes are 6 characters of A-Z and 0-9 (e.g. `A1GH35`). Anything else is invalid.

Incoming peer messages arrive as new user-side messages prefixed `[link from <name>]`. They are not from the human — they are from another agent.

When to reply via link_send (and only via link_send — plain output is not routed back):
- Reply when you have a real answer, question, status update, or new information to deliver.
- Do NOT reply to acknowledgments, 'understood', 'thanks', 'ok', or other purely social/closing messages. They end the exchange. Replying just bounces another ack back and creates an infinite politeness loop.
- Do NOT reply if you already said the same thing in your previous turn.
- Silence is a valid response. If the exchange has reached a natural close, stop calling link_send.

Treat the link as async coordination, not chat. Send only when something substantive needs to cross.
If you suspect background messages may have queued up while you were busy, call link_inbox at the start of your turn.
```

**Without salt configured**, the block is replaced entirely with onboarding guidance: it explains what a salt is, how to set one (env var or file), recommends `openssl rand -hex 32`, and instructs the agent to surface this to the user before running any link tool. `link_whoami`'s JSON response in this state also carries a `warning` field and `ready: false`, and `link_connect` / `link_send` return an explicit configuration-error string instead of a generic failure.

**On Claude Code**, there's no per-turn system-prompt hook — MCP servers can only annotate their tool *descriptions*. So the equivalent guidance lives directly in the tool descriptions the model sees, plus the unset-salt warning is embedded in `link_whoami`'s response and in the error string `link_connect` / `link_send` return. The reply rules (no ack-loops, silence is valid) are baked into `link_send`'s description. The agent learns its own code by calling `link_whoami` at the start of any link conversation rather than reading it from the system prompt — slightly more discovery overhead, same end behaviour.

## Layout

```
src/
  identity.ts   # 6-char code generation, hash → PeerJS id, profile persistence
  link.ts       # PeerJS wrapper, connection map, inbox queue, push delivery
  tools.ts      # @opencode-ai/plugin tool() bindings (each binds session id from ctx)
  index.ts      # opencode plugin entry — boots Link, registers tools, system.transform + event hooks
  mcp.ts        # Claude Code MCP server entry — same Link, channels for push delivery
lib/
  peerjs-on-node/   # vendored, patched fork (committed pre-built dist; see NOTICE.md)
scripts/
  test-p2p.ts       # raw two-peer round-trip via peerjs-on-node directly
  test-link.ts      # round-trip exercising the Link class end-to-end via codes
  test-receiver.ts  # background receiver for harness↔bun integration testing
  test-mcp.ts       # spawns mcp.ts as stdio child, drives the MCP protocol, asserts channel notifications
install.sh        / install.ps1          # opencode installers
uninstall.sh      / uninstall.ps1        # opencode uninstallers
install-claude.sh / install-claude.ps1   # Claude Code installers (registers via `claude mcp add`)
uninstall-claude.sh / uninstall-claude.ps1
```

Run the round-trip tests with `bun run scripts/test-p2p.ts` and `bun run scripts/test-link.ts`. Both contact PeerJS public signaling, so they need internet.

## Install details

### opencode

The installer:

1. `bun add github:AlexZihaoXu/opencode-link` into `~/.config/opencode/`.
2. Detects the platform via `uname` (or `Win32_Processor` on PowerShell) and downloads the matching `node-datachannel-v<ver>-napi-v8-<platform>.tar.gz` from [`murat-dogan/node-datachannel`'s release assets](https://github.com/murat-dogan/node-datachannel/releases) directly into `node_modules/node-datachannel/build/Release/`. We do this instead of relying on the package's own `prebuild-install` postinstall because bun silently skips that postinstall when `node-datachannel` is a transitive dep.
3. Drops a one-line bridge file at `~/.config/opencode/plugins/opencode-link.ts` that re-exports the plugin (`export { server } from "opencode-link";`). opencode auto-loads everything in `plugins/`, which avoids the npm-name collision we'd hit if we tried to put `"opencode-link"` in the `plugin` array of `opencode.jsonc`.

### Claude Code

The Claude installer is symmetric:

1. `bun add github:AlexZihaoXu/opencode-link` into a fresh dedicated dir at `~/.config/opencode-link/install/`. Independent from the opencode install so users with only Claude Code don't need opencode's directory tree.
2. Same direct GitHub-release tarball fetch for `node-datachannel`'s native binary.
3. `claude mcp add --scope user opencode-link -- bun run <install-dir>/node_modules/opencode-link/src/mcp.ts`. The MCP server runs as a stdio child of the `claude` CLI and shares the same `Link` / `Identity` / salt machinery as the opencode plugin.
4. Push delivery: incoming peer messages emit `notifications/claude/channel` events that Claude Code injects into the running session as `<channel source="opencode-link">[link from <name>] <text></channel>` — the agent gets woken the same way a typed user message would wake it. Requires `claude --dangerously-load-development-channels server:opencode-link` to enable; without that flag, link tools still work but messages only land in `link_inbox`.

**Upgrade**: re-run the matching install command — both are idempotent (skip the binary fetch if the `.node` is already in place) and bump `bun add` to the latest commit on `main`.

**Uninstall**:

```bash
# opencode
curl -fsSL https://raw.githubusercontent.com/AlexZihaoXu/opencode-link/main/uninstall.sh | bash
# Claude Code
curl -fsSL https://raw.githubusercontent.com/AlexZihaoXu/opencode-link/main/uninstall-claude.sh | bash
```
```powershell
# opencode
irm https://raw.githubusercontent.com/AlexZihaoXu/opencode-link/main/uninstall.ps1 | iex
# Claude Code
irm https://raw.githubusercontent.com/AlexZihaoXu/opencode-link/main/uninstall-claude.ps1 | iex
```

Each uninstaller removes only its harness's pieces. When run interactively, both also offer to wipe persisted identities at `~/.config/opencode-link/`.

**Manual install** (sandbox / CI / debugging):

```bash
cd ~/.config/opencode
bun add github:AlexZihaoXu/opencode-link
mkdir -p plugins
echo 'export { server } from "opencode-link";' > plugins/opencode-link.ts

# Fetch the native binary directly. Replace darwin-arm64 with your platform:
# darwin-x64, linux-x64, linux-arm64, win32-x64, etc.
ND="node_modules/node-datachannel"
VER=$(grep -oE '"version":[[:space:]]*"[^"]+"' "$ND/package.json" | head -1 | grep -oE '[0-9.]+')
mkdir -p "$ND/build/Release"
curl -fsSL "https://github.com/murat-dogan/node-datachannel/releases/download/v${VER}/node-datachannel-v${VER}-napi-v8-darwin-arm64.tar.gz" \
  | tar -xz -C "$ND"
```

**Requirements**:

- [`bun`](https://bun.sh) on `PATH`
- [`opencode`](https://opencode.ai) ≥ 1.14
- A platform with a [`node-datachannel`](https://github.com/murat-dogan/node-datachannel/releases) prebuilt release: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `linux-arm`, `linuxmusl-*`, `win32-x64`, `win32-arm64`. Other platforms need CMake + a C++ toolchain to build from source.

**Native shim**: PeerJS in Bun runs through a vendored, *patched* fork of `peerjs-on-node` at `lib/peerjs-on-node/`. It diverges from upstream in two small ways to avoid clobbering Bun's native `WebSocket` and `ReadableStream` (which opencode's HTTP stream parser relies on). Details in `lib/peerjs-on-node/NOTICE.md`.

## Roadmap

- [ ] Wire-protocol versioning so future message kinds don't break older peers.
- [ ] `link_disconnect(code)`.
- [ ] Optional NaCl-box payload encryption for end-to-end secrecy beyond DTLS — useful when self-hosting a signaling server you don't fully trust, or to sign payloads cross-installation.
- [ ] Discovery / directory mode — connect by name to an agent in a known group rather than by raw code.
- [ ] File transfer (chunked binary messages).

## License

MIT

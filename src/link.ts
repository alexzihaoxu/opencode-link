import { createRequire } from "node:module";
import { peerIdForCode, persist, normalizeCode, type Identity } from "./identity.ts";

const require = createRequire(import.meta.url);

export interface InboxEntry {
  /** The remote agent's 6-char code. */
  from: string;
  fromName: string;
  text: string;
  ts: number;
  kind: "msg" | "system";
}

export interface PeerInfo {
  code: string;
  name: string;
  connectedAt: number;
}

type WireMessage =
  | { type: "hello"; code: string; name: string }
  | { type: "rename"; name: string }
  | { type: "msg"; text: string };

export interface LinkOptions {
  host?: string;
  port?: number;
  path?: string;
  key?: string;
  secure?: boolean;
}

function envOptions(): LinkOptions {
  const opts: LinkOptions = {};
  if (process.env.OPENCODE_LINK_HOST) opts.host = process.env.OPENCODE_LINK_HOST;
  if (process.env.OPENCODE_LINK_PORT) opts.port = Number(process.env.OPENCODE_LINK_PORT);
  if (process.env.OPENCODE_LINK_PATH) opts.path = process.env.OPENCODE_LINK_PATH;
  if (process.env.OPENCODE_LINK_KEY) opts.key = process.env.OPENCODE_LINK_KEY;
  if (process.env.OPENCODE_LINK_SECURE) opts.secure = process.env.OPENCODE_LINK_SECURE === "true";
  return opts;
}

interface PendingPush {
  fromCode: string;
  fromName: string;
  text: string;
}

interface ConnSlot {
  conn: any;
  /** The remote's 6-char code, learned from their hello. Empty until then. */
  code: string;
  name: string;
  connectedAt: number;
}

export class Link {
  private peer: any | null = null;
  /** Keyed by remote PeerJS id (the sha256 hash of their code). */
  private connections = new Map<string, ConnSlot>();
  private inboxQueue: InboxEntry[] = [];
  private ready: Promise<void> | null = null;

  private client: any | null = null;
  private sessions = new Set<string>();
  private lastSessionId: string | null = null;
  private pendingPushes: PendingPush[] = [];

  constructor(public readonly identity: Identity, private readonly options: LinkOptions = envOptions()) {}

  setClient(client: any): void {
    this.client = client;
  }

  bindSession(sessionId: string | undefined): void {
    if (!sessionId) return;
    this.sessions.add(sessionId);
    this.lastSessionId = sessionId;
    this.flushPending();
  }

  noteSession(sessionId: string, kind: "created" | "active" | "deleted"): void {
    if (kind === "deleted") {
      this.sessions.delete(sessionId);
      if (this.lastSessionId === sessionId) {
        this.lastSessionId = this.sessions.values().next().value ?? null;
      }
      return;
    }
    this.sessions.add(sessionId);
    this.lastSessionId = sessionId;
    if (kind === "active") this.flushPending();
  }

  systemPrompt(): string {
    const lines = [
      "You have access to opencode-link, a peer-to-peer messaging tool that connects you with other opencode agents over WebRTC.",
      "Use it when the user asks you to talk to or coordinate with another agent.",
      "",
      "Your identity:",
      `- Link code (random per session, share with others so they can reach you): ${this.identity.code}`,
    ];
    if (this.identity.name) {
      lines.push(`- Display name: ${this.identity.name}`);
    } else {
      lines.push(
        `- Display name: NOT SET. Pick a short fun name for yourself and call link_set_name once at the start of any link-related conversation. The user has not assigned one.`
      );
    }
    lines.push(
      "",
      "Tools: link_whoami, link_set_name(name), link_connect(code), link_send(code, text), link_inbox, link_peers.",
      "Codes are 6 characters of A-Z and 0-9 (e.g. `A1GH35`). Anything else is invalid.",
      "",
      "Incoming peer messages arrive as new user-side messages prefixed `[link from <name>]`. They are not from the human — they are from another agent.",
      "",
      "When to reply via link_send (and only via link_send — plain output is not routed back):",
      "- Reply when you have a real answer, question, status update, or new information to deliver.",
      "- Do NOT reply to acknowledgments, 'understood', 'thanks', 'ok', or other purely social/closing messages. They end the exchange. Replying just bounces another ack back and creates an infinite politeness loop.",
      "- Do NOT reply if you already said the same thing in your previous turn.",
      "- Silence is a valid response. If the exchange has reached a natural close, stop calling link_send.",
      "",
      "Treat the link as async coordination, not chat. Send only when something substantive needs to cross.",
      "If you suspect background messages may have queued up while you were busy, call link_inbox at the start of your turn."
    );
    return lines.join("\n");
  }

  async start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.bootPeer();
    return this.ready;
  }

  private async bootPeer(): Promise<void> {
    // The vendored peerjs-on-node bundle has been patched to declare its
    // WebSocket / RTC* aliases as module-local vars instead of implicit
    // globals (see lib/peerjs-on-node/dist/peerjs-on-node.js header). This
    // means require()ing it no longer pollutes globalThis — opencode's
    // stream parser (which uses Bun's native WebSocket) keeps working.
    const mod = require("peerjs-on-node");
    const Peer = mod.Peer ?? mod.default?.Peer ?? mod;
    const myPeerId = peerIdForCode(this.identity.code);
    this.peer = new Peer(myPeerId, this.options);

    await new Promise<void>((resolve, reject) => {
      this.peer.on("open", () => resolve());
      this.peer.on("error", (err: Error) => reject(err));
    });

    this.peer.on("connection", (conn: any) => this.attach(conn));
  }

  private attach(conn: any): void {
    conn.on("open", () => {
      this.connections.set(conn.peer, {
        conn,
        code: "",
        name: "",
        connectedAt: Date.now(),
      });
      this.sendWire(conn, {
        type: "hello",
        code: this.identity.code,
        name: this.identity.name,
      });
    });

    conn.on("data", (raw: unknown) => {
      const msg = this.parse(raw);
      if (!msg) return;
      const slot = this.connections.get(conn.peer);
      const labelFor = (s: ConnSlot | undefined, fallback?: string) =>
        s?.name || s?.code || fallback || conn.peer.slice(0, 8);
      switch (msg.type) {
        case "hello": {
          if (slot) {
            slot.code = msg.code;
            slot.name = msg.name;
          }
          const label = msg.name || msg.code;
          this.inboxQueue.push({
            from: msg.code,
            fromName: label,
            text: `connected as ${label}`,
            ts: Date.now(),
            kind: "system",
          });
          break;
        }
        case "rename": {
          if (slot) slot.name = msg.name;
          const label = msg.name || (slot?.code ?? labelFor(slot));
          this.inboxQueue.push({
            from: slot?.code ?? "",
            fromName: label,
            text: `renamed to ${label}`,
            ts: Date.now(),
            kind: "system",
          });
          break;
        }
        case "msg": {
          const fromCode = slot?.code ?? "";
          const fromName = labelFor(slot);
          this.inboxQueue.push({
            from: fromCode,
            fromName,
            text: msg.text,
            ts: Date.now(),
            kind: "msg",
          });
          this.deliver({ fromCode, fromName, text: msg.text });
          break;
        }
      }
    });

    conn.on("close", () => {
      this.connections.delete(conn.peer);
    });

    conn.on("error", () => {
      this.connections.delete(conn.peer);
    });
  }

  private parse(raw: unknown): WireMessage | null {
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw) as WireMessage;
      } catch {
        return null;
      }
    }
    if (raw && typeof raw === "object" && "type" in (raw as Record<string, unknown>)) {
      return raw as WireMessage;
    }
    return null;
  }

  private sendWire(conn: any, msg: WireMessage): void {
    conn.send(JSON.stringify(msg));
  }

  private deliver(push: PendingPush): void {
    if (!this.client || !this.lastSessionId) {
      this.pendingPushes.push(push);
      return;
    }
    void this.pushToSession(this.lastSessionId, push);
  }

  private flushPending(): void {
    if (!this.client || !this.lastSessionId || this.pendingPushes.length === 0) return;
    const sid = this.lastSessionId;
    const drained = this.pendingPushes;
    this.pendingPushes = [];
    for (const push of drained) void this.pushToSession(sid, push);
  }

  private async pushToSession(sessionId: string, push: PendingPush): Promise<void> {
    if (!this.client?.session?.prompt) return;
    const text = `[link from ${push.fromName}] ${push.text}`;
    try {
      await this.client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text }],
        },
      });
    } catch (err) {
      this.pendingPushes.push(push);
      this.client?.app?.log?.({ service: "opencode-link", level: "warn", message: `push failed: ${(err as Error).message}` });
    }
  }

  /** Look up an existing connection by remote code (or null if not connected). */
  private slotByCode(code: string): ConnSlot | null {
    const peerId = peerIdForCode(code);
    return this.connections.get(peerId) ?? null;
  }

  async connect(rawCode: string): Promise<void> {
    const code = normalizeCode(rawCode);
    if (code.length !== 6) throw new Error(`invalid code "${rawCode}" — expected 6 chars of A-Z and 0-9`);
    if (code === this.identity.code) throw new Error(`cannot connect to your own code`);
    await this.start();
    const peerId = peerIdForCode(code);
    if (this.connections.has(peerId)) return;
    const conn = this.peer.connect(peerId, { reliable: true });
    this.attach(conn);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`connect to ${code} timed out — is the other side running?`)), 15000);
      conn.on("open", () => {
        clearTimeout(t);
        resolve();
      });
      conn.on("error", (err: Error) => {
        clearTimeout(t);
        reject(err);
      });
    });
  }

  async send(rawCode: string, text: string): Promise<void> {
    const code = normalizeCode(rawCode);
    const slot = this.slotByCode(code);
    if (!slot) throw new Error(`not connected to ${code} — call link_connect first`);
    this.sendWire(slot.conn, { type: "msg", text });
  }

  inbox(): InboxEntry[] {
    const out = this.inboxQueue;
    this.inboxQueue = [];
    return out;
  }

  peers(): PeerInfo[] {
    return Array.from(this.connections.values())
      .filter((slot) => slot.code) // skip half-handshaken
      .map((slot) => ({
        code: slot.code,
        name: slot.name,
        connectedAt: slot.connectedAt,
      }));
  }

  async setName(name: string): Promise<void> {
    this.identity.name = name;
    await persist(this.identity);
    for (const slot of this.connections.values()) {
      this.sendWire(slot.conn, { type: "rename", name });
    }
  }

  async stop(): Promise<void> {
    for (const slot of this.connections.values()) {
      try {
        slot.conn.close();
      } catch {}
    }
    this.connections.clear();
    if (this.peer) {
      try {
        this.peer.destroy();
      } catch {}
      this.peer = null;
    }
    this.ready = null;
  }
}

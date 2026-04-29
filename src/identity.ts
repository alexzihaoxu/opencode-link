import { randomBytes, createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export interface Identity {
  /**
   * Short user-facing code (e.g. `A1GH35`). This is what users share with
   * each other; the actual PeerJS id is derived by hashing this with a salt
   * (see `peerIdForCode`).
   */
  code: string;
  name: string;
}

const CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const CODE_LEN = 6;

/**
 * Common salt prefixed before the code when hashing to a PeerJS id. Hardcoded
 * so two opencode-link installs derive the same hash from the same code.
 */
const PEER_ID_SALT = "opencode-link.v1::";

export function generateCode(): string {
  const bytes = randomBytes(CODE_LEN);
  let out = "";
  for (let i = 0; i < CODE_LEN; i++) {
    out += CODE_CHARS[bytes[i]! % CODE_CHARS.length];
  }
  return out;
}

export function normalizeCode(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function peerIdForCode(code: string): string {
  return createHash("sha256").update(PEER_ID_SALT + normalizeCode(code)).digest("hex");
}

function homeDir(): string {
  return process.env.OPENCODE_LINK_HOME ?? join(homedir(), ".config", "opencode-link");
}

function profileSlug(): string | null {
  const raw = process.env.OPENCODE_LINK_PROFILE;
  if (!raw) return null;
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_") || null;
}

function identityPath(profile: string): string {
  return join(homeDir(), `identity-${profile}.json`);
}

export async function loadIdentity(): Promise<Identity> {
  const profile = profileSlug();
  const envName = process.env.OPENCODE_LINK_NAME ?? "";

  if (!profile) {
    return { code: generateCode(), name: envName };
  }

  const path = identityPath(profile);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<Identity> & { id?: string };
    // Migrate older files that used `id` (UUID) — discard, regenerate as code.
    if (parsed.code && /^[A-Z0-9]+$/.test(parsed.code)) {
      return { code: parsed.code, name: envName || parsed.name || "" };
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const fresh: Identity = { code: generateCode(), name: envName };
  await persist(fresh);
  return fresh;
}

export async function persist(identity: Identity): Promise<void> {
  const profile = profileSlug();
  if (!profile) return;
  await mkdir(homeDir(), { recursive: true });
  await writeFile(identityPath(profile), JSON.stringify(identity, null, 2), "utf8");
}

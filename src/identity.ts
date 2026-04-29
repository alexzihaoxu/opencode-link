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

export interface SaltSource {
  /** The salt value, or null if none was found. */
  value: string | null;
  /** Where it came from — used in the system prompt so the agent knows. */
  origin: "env" | "file" | "none";
}

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

/**
 * Compute the PeerJS id for a code under a given salt. The salt is the shared
 * secret that namespaces a group: only agents using the same salt produce the
 * same hash and can reach each other. Without a salt this function cannot be
 * called — the caller must check `loadSalt().value` first.
 */
export function peerIdForCode(code: string, salt: string): string {
  return createHash("sha256").update(`${salt}|${normalizeCode(code)}`).digest("hex");
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

function saltPath(): string {
  return join(homeDir(), "salt");
}

/**
 * Resolve the shared salt. Env var `OPENCODE_LINK_SALT` wins if set and
 * non-empty; otherwise read `~/.config/opencode-link/salt` (override the dir
 * with `OPENCODE_LINK_HOME`); otherwise return `{ value: null, origin: "none" }`.
 *
 * No default. If neither source is set the plugin will refuse to boot the
 * peer — connection requires both sides to share a salt out of band.
 */
export async function loadSalt(): Promise<SaltSource> {
  const env = process.env.OPENCODE_LINK_SALT;
  if (env && env.trim()) return { value: env.trim(), origin: "env" };

  try {
    const raw = await readFile(saltPath(), "utf8");
    const trimmed = raw.trim();
    if (trimmed) return { value: trimmed, origin: "file" };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return { value: null, origin: "none" };
}

export function saltFilePath(): string {
  return saltPath();
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

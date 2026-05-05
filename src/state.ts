// Shared state file written by the server plugin and read by the TUI plugin.
// opencode has no plugin-to-plugin IPC, so the file is the bridge.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

export interface LinkState {
  code: string;
  name: string;
  salt: {
    origin: "env" | "file" | "none";
    /** Truncated preview — `abcdef…123456` or `—` if unset. Never the full salt. */
    preview: string;
  };
  ready: boolean;
  peers: { code: string; name: string }[];
  saltFilePath: string;
  updatedAt: number;
}

function homeDir(): string {
  return process.env.OPENCODE_LINK_HOME ?? join(homedir(), ".config", "opencode-link");
}

export function statePath(): string {
  return join(homeDir(), "state.json");
}

export function saltPreview(value: string | null): string {
  if (!value) return "—";
  if (value.length <= 14) return value;
  return `${value.slice(0, 6)}…${value.slice(-6)}`;
}

export async function writeState(state: LinkState): Promise<void> {
  await mkdir(homeDir(), { recursive: true });
  // Atomic-ish write: temp + rename so the TUI never reads a half-written file.
  const final = statePath();
  const tmp = final + ".tmp";
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await rename(tmp, final);
}

export async function readState(): Promise<LinkState | null> {
  try {
    const raw = await readFile(statePath(), "utf8");
    return JSON.parse(raw) as LinkState;
  } catch {
    return null;
  }
}

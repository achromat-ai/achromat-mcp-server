/**
 * Configuration, read from the environment. Reading a path here never reads the file: the key is loaded
 * lazily, on the first tool call (see client.ts).
 */
import { homedir } from "node:os";
import { resolve } from "node:path";

/** The service this proxy talks to. */
export const DEFAULT_BASE_URL = "https://mom.achromat.ai";

/** Where the agent's Ed25519 private key is expected when ACHROMAT_AGENT_KEY_FILE is not set. */
export const DEFAULT_KEY_FILE = "~/.achromat/achromat_agent_key.pem";

/** The service accepts a ref tag of 1 to 32 characters from a-z, 0-9, _ and -, starting with a letter or digit. */
const REF_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * A marketing ref tag (ACHROMAT_REF), or "" when it is missing or malformed. The same rule as the service's own, applied
 * quietly: a bad tag only costs the attribution and must never stop an identity from being registered.
 */
export function parseRef(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  const ref = raw.trim().toLowerCase();
  return REF_PATTERN.test(ref) ? ref : "";
}

export interface Config {
  /** Origin of the Achromat MOM service, without a trailing slash. */
  baseUrl: string;
  /** Absolute path to the agent's Ed25519 private key (PEM). */
  keyFile: string;
  /**
   * Marketing ref tag from ACHROMAT_REF, sent as `?ref=` on the challenge and register calls only, so the service can
   * tell which link brought this install. "" or absent: none is sent.
   */
  ref?: string;
}

/** Expands a leading `~` to the home directory. MCP hosts pass environment values through literally. */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(home, path.slice(2));
  return path;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): Config {
  const raw = env.ACHROMAT_BASE_URL?.trim() || DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`ACHROMAT_BASE_URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("ACHROMAT_BASE_URL must be an https URL (http is allowed only for localhost).");
  }
  const keyFile = resolve(expandHome(env.ACHROMAT_AGENT_KEY_FILE?.trim() || DEFAULT_KEY_FILE, home));
  return { baseUrl: url.origin, keyFile, ref: parseRef(env.ACHROMAT_REF) };
}

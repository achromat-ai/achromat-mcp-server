/**
 * Configuration, read from the environment. Nothing here reads a key: the signing client is not built yet.
 */

/** The service this proxy talks to. */
export const DEFAULT_BASE_URL = "https://mom.achromat.ai";

export interface Config {
  /** Origin of the Achromat MOM service, without a trailing slash. */
  baseUrl: string;
  /** Path to the agent's Ed25519 private key (PEM). Unused until request signing is implemented. */
  keyFile: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
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
  return { baseUrl: url.origin, keyFile: env.ACHROMAT_KEY_FILE?.trim() || null };
}

/**
 * Request signing for Achromat MOM. Everything here is the byte-level contract of the agent protocol
 * (https://mom.achromat.ai/skill.md, sections 2 and 3), and nothing else.
 *
 *   canonical = "achromat-mom-v1" LF host LF METHOD LF path+query LF sha256hex(body) LF timestamp LF nonce
 *   Achromat-Signature = base64url( Ed25519( privateKey, UTF8(canonical) ) )
 *
 * Ed25519 is deterministic, so the same inputs always give the same signature. That is what lets the
 * published test vector in skill.md (section 8) pin this file down byte for byte.
 *
 * No function here logs, and no error message contains key material.
 */
import { createHash, createPrivateKey, createPublicKey, sign as nodeSign, type KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export const SIGNING_CONTEXT = "achromat-mom-v1";
/** A request nonce is 16 random bytes, 22 characters of base64url. */
export const NONCE_BYTES = 16;

/** RFC 4648 section 5, no padding. */
export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

// ───────────────────────────── the key ─────────────────────────────

export type KeyFileProblem = "NOT_FOUND" | "UNREADABLE" | "INVALID" | "ENCRYPTED" | "WRONG_TYPE";

/** A key file that cannot be used. The message says what to do and never quotes the file's content. */
export class KeyFileError extends Error {
  readonly problem: KeyFileProblem;

  constructor(problem: KeyFileProblem, message: string) {
    super(message);
    this.name = "KeyFileError";
    this.problem = problem;
  }
}

export interface AgentKey {
  /** The raw 32-byte public key, base64url (43 characters): the Achromat-Agent-Key header. */
  readonly publicKey: string;
  /** base64url of the 64-byte Ed25519 signature over the UTF-8 bytes of `message`. */
  sign(message: string): string;
}

/** Builds a key from PEM text. Accepts an unencrypted PKCS#8 Ed25519 private key, which is what skill.md produces. */
export function parseAgentKey(pem: string): AgentKey {
  // Detected from the text, not from the error Node raises: the error code for a missing passphrase differs
  // between Node and OpenSSL versions. Covers PKCS#8 ("ENCRYPTED PRIVATE KEY") and the legacy "Proc-Type" form.
  if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(pem) || /^Proc-Type:\s*4,ENCRYPTED/m.test(pem)) {
    throw new KeyFileError("ENCRYPTED", "The key file is passphrase-protected. Use an unencrypted PKCS#8 Ed25519 key (delete this file and use the achromat_register_identity tool to create a new one).");
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: pem, format: "pem" });
  } catch {
    throw new KeyFileError("INVALID", "The key file is not a readable PEM private key. Expected an unencrypted PKCS#8 Ed25519 key (delete this file and use the achromat_register_identity tool to create a new one).");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new KeyFileError("WRONG_TYPE", `The key file holds a ${privateKey.asymmetricKeyType ?? "non-asymmetric"} key. Achromat requires an Ed25519 key.`);
  }
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  if (typeof jwk.x !== "string" || Buffer.from(jwk.x, "base64url").length !== 32) {
    throw new KeyFileError("INVALID", "Could not derive an Ed25519 public key from the key file.");
  }
  const publicKey = jwk.x;
  return {
    publicKey,
    sign: (message) => base64url(nodeSign(null, Buffer.from(message, "utf8"), privateKey)),
  };
}

export interface LoadedKey {
  key: AgentKey;
  /** Set when the file is readable by other users on this machine. The key still works. */
  warning: string | null;
}

/** Reads and parses the key file. Throws KeyFileError with an actionable message. */
export function loadAgentKey(path: string, platform: NodeJS.Platform = process.platform): LoadedKey {
  let pem: string;
  try {
    pem = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") {
      throw new KeyFileError(
        "NOT_FOUND",
        `No agent key found at ${path}. Ask the user whether to create one with the achromat_register_identity tool (if it is not listed, restart the host), or point ACHROMAT_AGENT_KEY_FILE at an existing key.`,
      );
    }
    throw new KeyFileError("UNREADABLE", `The key file at ${path} could not be read (${code ?? "unknown error"}). Check that this user may read it.`);
  }
  const key = parseAgentKey(pem);
  let warning: string | null = null;
  if (platform !== "win32") {
    try {
      const mode = statSync(path).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        warning = `The key file ${path} is accessible to other users (mode ${mode.toString(8)}). Run: chmod 600 "${path}"`;
      }
    } catch {
      // The file was just read; a failing stat changes nothing about whether the key works.
    }
  }
  return { key, warning };
}

// ───────────────────────────── the request ─────────────────────────────

export interface SigningInput {
  /** The request host, lowercased, with a port if the URL has one (URL.host). */
  host: string;
  method: string;
  /** Path plus query string exactly as sent, starting with "/". */
  pathAndQuery: string;
  bodySha256Hex: string;
  /** Unix seconds, as the text of the Achromat-Timestamp header. */
  timestamp: string;
  /** The text of the Achromat-Nonce header. */
  nonce: string;
}

/** The seven-part string that gets signed: parts joined by one LF (0x0A), no trailing newline. */
export function canonicalString(input: SigningInput): string {
  return [SIGNING_CONTEXT, input.host.toLowerCase(), input.method.toUpperCase(), input.pathAndQuery, input.bodySha256Hex, input.timestamp, input.nonce].join("\n");
}

export interface SignedHeaders {
  "Achromat-Agent-Key": string;
  "Achromat-Timestamp": string;
  "Achromat-Nonce": string;
  "Achromat-Signature": string;
}

export interface SignRequestInput {
  key: AgentKey;
  method: string;
  url: URL;
  /** The exact bytes that will be sent. Empty for a request without a body. */
  body: Uint8Array;
  /** Server time in whole seconds (local clock plus the learned offset). */
  timestampSeconds: number;
  nonce: string;
}

/** The four headers for a request. The caller must send exactly `body`, byte for byte. */
export function signRequest(input: SignRequestInput): SignedHeaders {
  const timestamp = String(input.timestampSeconds);
  const canonical = canonicalString({
    host: input.url.host,
    method: input.method,
    pathAndQuery: `${input.url.pathname}${input.url.search}`,
    bodySha256Hex: sha256Hex(input.body),
    timestamp,
    nonce: input.nonce,
  });
  return {
    "Achromat-Agent-Key": input.key.publicKey,
    "Achromat-Timestamp": timestamp,
    "Achromat-Nonce": input.nonce,
    "Achromat-Signature": input.key.sign(canonical),
  };
}

// ───────────────────────────── the clock ─────────────────────────────

/**
 * The server's clock relative to this machine's. A signed request must carry a timestamp within 60 seconds of
 * the server's time, and a device clock can be minutes off. The offset is learned from the HTTP `Date` header of
 * any response (Cloudflare sets it on every response, including errors):
 *
 *   offset = serverTime - localTimeWhenTheResponseArrived
 *
 * `Date` has one-second resolution, so the estimate is a second or two out, which the 60-second window absorbs.
 */
export class ServerClock {
  private offset = 0;
  private learned = false;

  /** Milliseconds to add to the local clock to get server time. */
  get offsetMs(): number {
    return this.offset;
  }

  get isSynchronised(): boolean {
    return this.learned;
  }

  /** Server time, in epoch milliseconds, for a local epoch-millisecond reading. */
  serverTime(localMs: number): number {
    return localMs + this.offset;
  }

  /** Learns the offset from a response's Date header. Returns false, changing nothing, if there is none to read. */
  observe(response: { headers: { get(name: string): string | null } }, receivedAtMs: number): boolean {
    const header = response.headers.get("Date");
    if (header === null) return false;
    const serverMs = Date.parse(header);
    if (!Number.isFinite(serverMs)) return false;
    this.offset = serverMs - receivedAtMs;
    this.learned = true;
    return true;
  }
}

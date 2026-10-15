/**
 * The signed HTTP client for Achromat MOM. It owns the lifecycle of one request: load the key (once, and
 * lazily), sign, send, learn the server clock from the answer, and retry once if the clock was the problem.
 *
 * It never throws for anything a tool call can run into. It returns an ApiResult, and format.ts turns that
 * into text for the agent. A bad key file is a result too, not a crash: an MCP host shows only "server
 * disconnected" when a child process dies, so the server stays up and each call explains what to fix.
 */
import { randomBytes as nodeRandomBytes } from "node:crypto";
import type { Config } from "./config.js";
import { KeyFileError, ServerClock, base64url, loadAgentKey, NONCE_BYTES, signRequest, type LoadedKey } from "./crypto.js";

/** The service rejects signed bodies over 64 KiB. */
export const MAX_BODY_BYTES = 64 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;

export type ApiResult =
  /** The service answered. `body` is the parsed JSON, or null if the answer was not JSON. */
  | { kind: "response"; status: number; body: unknown; retryAfterSeconds: number | null; clockOffsetMs: number | null }
  /** The request never produced an answer: a key problem, an oversized body, or the network. */
  | { kind: "local"; code: LocalErrorCode; message: string };

export type LocalErrorCode = "KEY_NOT_FOUND" | "KEY_UNREADABLE" | "KEY_INVALID" | "BODY_TOO_LARGE" | "TIMEOUT" | "NETWORK";

export interface ClientDeps {
  fetch?: typeof fetch;
  /** Local epoch milliseconds. */
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
  loadKey?: (path: string) => LoadedKey;
  /** Called once if the key file is readable by other users. Defaults to stderr. */
  warn?: (message: string) => void;
  timeoutMs?: number;
  /** Sent as the User-Agent, so the service can tell this client from a generic one. */
  userAgent?: string;
}

const KEY_PROBLEM_CODE: Record<KeyFileError["problem"], LocalErrorCode> = {
  NOT_FOUND: "KEY_NOT_FOUND",
  UNREADABLE: "KEY_UNREADABLE",
  INVALID: "KEY_INVALID",
  ENCRYPTED: "KEY_INVALID",
  WRONG_TYPE: "KEY_INVALID",
};

function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - nowMs) / 1000)) : null;
}

export class MomClient {
  readonly clock = new ServerClock();
  private loaded: LoadedKey | null = null;
  private warned = false;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly randomBytes: (size: number) => Uint8Array;
  private readonly loadKey: (path: string) => LoadedKey;
  private readonly warn: (message: string) => void;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(
    private readonly config: Config,
    deps: ClientDeps = {},
  ) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
    this.randomBytes = deps.randomBytes ?? nodeRandomBytes;
    this.loadKey = deps.loadKey ?? loadAgentKey;
    this.warn = deps.warn ?? ((message) => console.error(`achromat-mcp-server: ${message}`));
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = deps.userAgent ?? "achromat-mcp-server";
  }

  /** The key, loaded on first use. A failed load is retried on the next call, so a fixed file works without a restart. */
  private key(): LoadedKey {
    if (this.loaded === null) {
      this.loaded = this.loadKey(this.config.keyFile);
      if (this.loaded.warning !== null && !this.warned) {
        this.warned = true;
        this.warn(this.loaded.warning);
      }
    }
    return this.loaded;
  }

  /** A signed POST of a JSON object. */
  async post(path: string, payload: Record<string, unknown>): Promise<ApiResult> {
    let loaded: LoadedKey;
    try {
      loaded = this.key();
    } catch (error) {
      if (error instanceof KeyFileError) return { kind: "local", code: KEY_PROBLEM_CODE[error.problem], message: error.message };
      throw error;
    }

    // Serialised once: these exact bytes are hashed, signed and sent.
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    if (body.length > MAX_BODY_BYTES) {
      return { kind: "local", code: "BODY_TOO_LARGE", message: `The request is ${body.length} bytes; the service accepts at most ${MAX_BODY_BYTES} (64 KiB). Send fewer or smaller arguments.` };
    }

    const url = new URL(path, this.config.baseUrl);
    let result = await this.attempt(loaded, url, body);
    // A clock more than 60 seconds out is rejected before anything else happens, so it is safe to resend.
    // The rejection itself carries the server's Date, so the second attempt is signed with the right time.
    if (result.kind === "response" && result.status === 401 && errorCode(result.body) === "AGENT_SIGNATURE_EXPIRED" && this.clock.isSynchronised) {
      result = await this.attempt(loaded, url, body);
    }
    return result;
  }

  private async attempt(loaded: LoadedKey, url: URL, body: Buffer): Promise<ApiResult> {
    const timestampSeconds = Math.floor(this.clock.serverTime(this.now()) / 1000);
    const nonce = base64url(this.randomBytes(NONCE_BYTES));
    const signed = signRequest({ key: loaded.key, method: "POST", url, body, timestampSeconds, nonce });

    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { ...signed, "Content-Type": "application/json", Accept: "application/json", "User-Agent": this.userAgent },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === "TimeoutError" || name === "AbortError") {
        return { kind: "local", code: "TIMEOUT", message: `No answer from ${url.origin} within ${Math.round(this.timeoutMs / 1000)} seconds.` };
      }
      return { kind: "local", code: "NETWORK", message: `Could not reach ${url.origin}. Check the connection and try again.` };
    }

    const receivedAt = this.now();
    this.clock.observe(response, receivedAt);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return {
      kind: "response",
      status: response.status,
      body: parsed,
      retryAfterSeconds: parseRetryAfter(response.headers.get("Retry-After"), receivedAt),
      clockOffsetMs: this.clock.isSynchronised ? this.clock.offsetMs : null,
    };
  }
}

/** The `code` of an error body, if it has one. */
export function errorCode(body: unknown): string | null {
  if (typeof body === "object" && body !== null && "code" in body && typeof (body as { code: unknown }).code === "string") return (body as { code: string }).code;
  return null;
}

import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { canonicalString, parseAgentKey, sha256Hex, type AgentKey, type LoadedKey } from "../src/crypto.js";

export const BASE_URL = "https://mom.achromat.ai";

/** A fresh Ed25519 key in memory. */
export function freshKey(): AgentKey {
  const { privateKey } = generateKeyPairSync("ed25519");
  return parseAgentKey(privateKey.export({ type: "pkcs8", format: "pem" }).toString());
}

export const loaded = (key: AgentKey, warning: string | null = null): LoadedKey => ({ key, warning });

export interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: string;
  nonce: string;
  timestamp: number;
}

export interface FakeServiceOptions {
  /** The service's clock, epoch milliseconds. Defaults to the real one. */
  serverNow?: () => number;
  /** Which public keys are registered (base64url). Unset: any key is accepted. */
  registered?: ReadonlySet<string>;
  /** Produces the answer once the request has been authenticated. */
  respond?: (seen: Seen) => { status: number; body?: unknown; headers?: Record<string, string> };
  /** Leave the Date header off every response. */
  omitDate?: boolean;
  /** Reject every request for clock skew, whatever it carries. */
  alwaysExpired?: boolean;
}

/**
 * A stand-in for the service that authenticates a request the way the real middleware does: the four headers,
 * a timestamp within 60 seconds of its own clock, a nonce it has not seen, and an Ed25519 signature over the
 * canonical string built from the bytes it actually received.
 */
export function fakeService(options: FakeServiceOptions = {}) {
  const serverNow = options.serverNow ?? Date.now;
  const nonces = new Set<string>();
  const calls: Seen[] = [];

  const json = (status: number, body: unknown, extra: Record<string, string> = {}) => {
    const headers = new Headers({ "Content-Type": "application/json", ...extra });
    if (!options.omitDate) headers.set("Date", new Date(serverNow()).toUTCString());
    return new Response(JSON.stringify(body), { status, headers });
  };
  const reject = (status: number, code: string, error: string) => json(status, { success: false, error, code });

  const fetchImpl = async (input: URL | string | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const body = init?.body == null ? "" : Buffer.from(init.body as Uint8Array).toString("utf8");
    const bodyBytes = init?.body == null ? new Uint8Array(0) : (init.body as Uint8Array);

    const agentKey = headers.get("Achromat-Agent-Key");
    const timestamp = headers.get("Achromat-Timestamp");
    const nonce = headers.get("Achromat-Nonce");
    const signature = headers.get("Achromat-Signature");
    if (!agentKey || !timestamp || !nonce || !signature) return reject(401, "AGENT_SIGNATURE_REQUIRED", "missing header");
    if (!/^[A-Za-z0-9_-]{43}$/.test(agentKey) || !/^\d{10}$/.test(timestamp) || !/^[A-Za-z0-9_-]{22}$/.test(nonce) || !/^[A-Za-z0-9_-]{86}$/.test(signature)) {
      return reject(401, "AGENT_SIGNATURE_INVALID", "malformed header");
    }
    if (options.alwaysExpired || Math.abs(serverNow() / 1000 - Number(timestamp)) > 60) {
      return reject(401, "AGENT_SIGNATURE_EXPIRED", "Achromat-Timestamp must be within 60 seconds of server time");
    }
    const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: agentKey }, format: "jwk" });
    const canonical = canonicalString({ host: url.host, method: init?.method ?? "GET", pathAndQuery: `${url.pathname}${url.search}`, bodySha256Hex: sha256Hex(bodyBytes), timestamp, nonce });
    if (!verify(null, Buffer.from(canonical), publicKey, Buffer.from(signature, "base64url"))) {
      return reject(401, "AGENT_SIGNATURE_INVALID", "signature does not verify");
    }
    if (options.registered && !options.registered.has(agentKey)) return reject(401, "AGENT_KEY_UNKNOWN", "unknown key");
    if (nonces.has(nonce)) return reject(401, "AGENT_NONCE_REPLAYED", "nonce replayed");
    nonces.add(nonce);

    const seen: Seen = { url: url.href, method: init?.method ?? "GET", headers, body, nonce, timestamp: Number(timestamp) };
    calls.push(seen);
    const answer = options.respond?.(seen) ?? { status: 200, body: { success: true } };
    return json(answer.status, answer.body ?? {}, answer.headers ?? {});
  };
  return { fetch: fetchImpl as typeof fetch, calls, nonces };
}

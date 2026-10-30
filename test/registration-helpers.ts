import { createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { verifyPow } from "../src/pow.js";
import { proofOfPossessionMessage } from "../src/registration.js";

export interface FakeRegistrarOptions {
  difficultyBits?: number;
  /** Wrong-network and expiry are simulated for the first N registration attempts. */
  failRegisterWith?: Array<{ status: number; code: string; headers?: Record<string, string> }>;
  failChallengeWith?: { status: number; code?: string; headers?: Record<string, string>; rawBody?: string };
  /** Replace the challenge response (for malformed or hostile answers). */
  challengeOverride?: (base: Record<string, unknown>) => Record<string, unknown>;
  algorithm?: string;
}

/**
 * A stand-in for the two unauthenticated registration endpoints. It enforces what the real ones do: the
 * challenge is one we issued and has not been used, the signature we issued is echoed back, the nonce meets the
 * difficulty for exactly challenge + public_key, the proof of possession verifies against the public key, the
 * body stays under 4 KiB, and a key registers once.
 */
export function fakeRegistrar(options: FakeRegistrarOptions = {}) {
  const issued = new Map<string, { challenge: string; signature: string; used: boolean; bits: number }>();
  const keys = new Set<string>();
  const calls: Array<{ method: string; path: string; search: string; body: string; userAgent: string | null }> = [];
  const queuedFailures = [...(options.failRegisterWith ?? [])];

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  const error = (status: number, code: string, headers?: Record<string, string>) => json(status, { success: false, error: code.toLowerCase(), code }, headers);

  const fetchImpl = (async (input: URL | string, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.href);
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ method, path: url.pathname, search: url.search, body, userAgent: headers.get("User-Agent") });
    // Registration is unauthenticated: a signed request here would be a bug.
    if (headers.has("Achromat-Signature") || headers.has("Achromat-Agent-Key")) return error(400, "UNEXPECTED_SIGNATURE");

    if (url.pathname === "/api/v1/agents/challenge" && method === "GET") {
      if (options.failChallengeWith) {
        const f = options.failChallengeWith;
        return f.rawBody !== undefined ? new Response(f.rawBody, { status: f.status, headers: f.headers }) : error(f.status, f.code ?? "ERROR", f.headers);
      }
      const bits = options.difficultyBits ?? 12;
      const challenge = randomBytes(32).toString("base64url");
      const signature = randomBytes(32).toString("base64url");
      const id = randomUUID();
      issued.set(id, { challenge, signature, used: false, bits });
      const base = { success: true, challenge_id: id, challenge, challenge_signature: signature, algorithm: options.algorithm ?? "sha256-hashcash-v1", difficulty_bits: bits, expires_at: new Date(Date.now() + 600_000).toISOString() };
      return json(200, options.challengeOverride ? options.challengeOverride(base) : base);
    }

    if (url.pathname === "/api/v1/agents/register" && method === "POST") {
      const queued = queuedFailures.shift();
      if (queued) return error(queued.status, queued.code, queued.headers);
      if (Buffer.byteLength(body) > 4096) return error(413, "BODY_TOO_LARGE");
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(body);
      } catch {
        return error(400, "INVALID_REQUEST");
      }
      const fields = ["public_key", "challenge_id", "challenge_signature", "nonce", "proof_signature"];
      if (Object.keys(parsed).sort().join() !== [...fields].sort().join()) return error(400, "INVALID_REQUEST");
      const { public_key, challenge_id, challenge_signature, nonce, proof_signature } = parsed as { public_key: string; challenge_id: string; challenge_signature: string; nonce: string; proof_signature: string };
      if (!/^[A-Za-z0-9_-]{43}$/.test(public_key) || !/^[A-Za-z0-9_-]{86}$/.test(proof_signature) || !/^[0-9a-f]{1,32}$/.test(nonce)) return error(400, "INVALID_REQUEST");
      const record = issued.get(challenge_id);
      if (!record) return error(400, "CHALLENGE_INVALID");
      if (record.signature !== challenge_signature) return error(400, "INVALID_CHALLENGE");
      if (!verifyPow(record.challenge, public_key, nonce, record.bits)) return error(400, "POW_INVALID");
      const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: public_key }, format: "jwk" });
      if (!verify(null, Buffer.from(proofOfPossessionMessage(record.challenge, public_key)), publicKey, Buffer.from(proof_signature, "base64url"))) return error(401, "PROOF_OF_POSSESSION_FAILED");
      if (record.used) return error(409, "CHALLENGE_USED");
      if (keys.has(public_key)) return error(409, "AGENT_KEY_EXISTS");
      record.used = true;
      keys.add(public_key);
      return json(201, { success: true, agent: { public_key, agent_key: Buffer.from(public_key, "base64url").toString("hex"), role: "community", status: "active", registered_at: new Date().toISOString() } });
    }
    return error(404, "NOT_FOUND");
  }) as typeof fetch;

  return { fetch: fetchImpl, calls, keys, issued };
}

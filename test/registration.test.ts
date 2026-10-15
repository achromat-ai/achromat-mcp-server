import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { loadAgentKey } from "../src/crypto.js";
import { PowError } from "../src/pow.js";
import { registerIdentity } from "../src/registration.js";
import { BASE_URL, fakeService } from "./helpers.js";
import { fakeRegistrar, type FakeRegistrarOptions } from "./registration-helpers.js";

const root = mkdtempSync(join(tmpdir(), "achromat-reg-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
/** A fresh key location that does not exist yet, inside a directory that does not exist yet. */
const place = () => {
  const keyFile = join(root, `case-${++counter}`, ".achromat", "achromat_agent_key.pem");
  return { baseUrl: BASE_URL, keyFile };
};
const run = (config: ReturnType<typeof place>, options: FakeRegistrarOptions = {}, extra: Parameters<typeof registerIdentity>[1] = {}) => {
  const service = fakeRegistrar(options);
  return registerIdentity(config, { fetch: service.fetch, threads: 1, ...extra }).then((outcome) => ({ outcome, service }));
};
const leftovers = (config: ReturnType<typeof place>) => (existsSync(join(config.keyFile, "..")) ? readdirSync(join(config.keyFile, "..")) : []);

describe("a successful registration", () => {
  it("creates the key, registers it, and saves it where the server looks", async () => {
    const config = place();
    const { outcome, service } = await run(config);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.keyFile).toBe(config.keyFile);
    expect(outcome.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(outcome.role).toBe("community");
    expect(outcome.agentKey).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.pow.attempts).toBeGreaterThan(0);
    expect(service.keys.has(outcome.publicKey)).toBe(true);

    // The saved file is exactly the key the service now knows, and the server can use it as it stands.
    const loaded = loadAgentKey(config.keyFile);
    expect(loaded.key.publicKey).toBe(outcome.publicKey);
    expect(loaded.warning).toBeNull();
  });

  it("makes the folder private and the file private to its owner", async () => {
    if (process.platform === "win32") return;
    const config = place();
    expect((await run(config)).outcome.ok).toBe(true);
    expect(statSync(join(config.keyFile, "..")).mode & 0o777).toBe(0o700);
    expect(statSync(config.keyFile).mode & 0o777).toBe(0o600);
  });

  it("leaves no temporary file behind", async () => {
    const config = place();
    await run(config);
    expect(leftovers(config)).toEqual(["achromat_agent_key.pem"]);
  });

  it("does not change the permissions of a folder that was already there", async () => {
    if (process.platform === "win32") return;
    const config = place();
    const folder = join(config.keyFile, "..");
    mkdirSync(folder, { recursive: true });
    chmodSync(folder, 0o755);
    expect((await run(config)).outcome.ok).toBe(true);
    expect(statSync(folder).mode & 0o777).toBe(0o755);
    expect(statSync(config.keyFile).mode & 0o777).toBe(0o600);
  });

  it("writes a PKCS#8 PEM, and the result never contains the private key", async () => {
    const config = place();
    const { outcome } = await run(config);
    const pem = readFileSync(config.keyFile, "utf8");
    expect(pem).toMatch(/^-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+-----END PRIVATE KEY-----\n$/);
    const body = pem.replace(/-----[A-Z ]+-----|\s/g, "");
    expect(JSON.stringify(outcome)).not.toContain(body);
    expect(JSON.stringify(outcome)).not.toContain(body.slice(20, 50));
  });

  it("sends only the public half and the proofs, with no signature headers, and identifies itself", async () => {
    const config = place();
    const { service, outcome } = await run(config, {}, { userAgent: "achromat-mcp-server/9.9.9" });
    if (!outcome.ok) throw new Error("expected success");
    expect(service.calls.map((call) => `${call.method} ${call.path}`)).toEqual(["GET /api/v1/agents/challenge", "POST /api/v1/agents/register"]);
    expect(service.calls.every((call) => call.userAgent === "achromat-mcp-server/9.9.9")).toBe(true);
    const sent = JSON.parse(service.calls[1]!.body) as Record<string, string>;
    expect(Object.keys(sent).sort()).toEqual(["challenge_id", "challenge_signature", "nonce", "proof_signature", "public_key"]);
    expect(sent.public_key).toBe(outcome.publicKey);
    expect(service.calls[1]!.body).not.toContain(readFileSync(config.keyFile, "utf8").replace(/-----[A-Z ]+-----|\s/g, "").slice(20, 50));
    expect(Buffer.byteLength(service.calls[1]!.body)).toBeLessThan(4096);
  });

  it("registers a different key every time", async () => {
    const [a, b] = [await run(place()), await run(place())];
    if (!a.outcome.ok || !b.outcome.ok) throw new Error("expected success");
    expect(a.outcome.publicKey).not.toBe(b.outcome.publicKey);
  });

  it("works with several proof-of-work threads too", async () => {
    const config = place();
    const { outcome } = await run(config, { difficultyBits: 14 }, { threads: 3 });
    expect(outcome.ok).toBe(true);
  });
});

describe("it never replaces a key", () => {
  it("refuses, before any network call, when a key file is already there", async () => {
    const config = place();
    mkdirSync(join(config.keyFile, "..", ""), { recursive: true });
    writeFileSync(config.keyFile, "PRECIOUS", { mode: 0o600 });
    const { outcome, service } = await run(config);
    expect(outcome).toMatchObject({ ok: false, code: "KEY_EXISTS" });
    expect(service.calls).toHaveLength(0);
    expect(readFileSync(config.keyFile, "utf8")).toBe("PRECIOUS");
  });

  it("does not overwrite a key that appears while it was registering", async () => {
    const config = place();
    const { outcome } = await run(config, {}, {
      beforeCommit: ({ final }) => writeFileSync(final, "ARRIVED FIRST", { mode: 0o600 }),
    });
    expect(readFileSync(config.keyFile, "utf8")).toBe("ARRIVED FIRST");
    // The service accepted the key, so the only copy of it is kept and reported, never deleted.
    expect(outcome).toMatchObject({ ok: false, code: "COMMIT_FAILED" });
    const kept = leftovers(config).filter((name) => name.endsWith(".tmp"));
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(config.keyFile, "..", kept[0]!), "utf8")).toMatch(/BEGIN PRIVATE KEY/);
    if (!outcome.ok) expect(outcome.message).toContain(kept[0]!);
  });
});

describe("a failure leaves no key behind and says what to do", () => {
  const cases: Array<[string, FakeRegistrarOptions, string, string | RegExp]> = [
    ["the challenge cannot be fetched (429)", { failChallengeWith: { status: 429, code: "RATE_LIMITED", headers: { "Retry-After": "45" } } }, "RATE_LIMITED", "Wait 45 seconds"],
    ["the service is down (503)", { failChallengeWith: { status: 503, code: "SERVICE_MISCONFIGURED" } }, "UNAVAILABLE", "temporarily unavailable"],
    ["the registration limit is reached (429)", { failRegisterWith: [{ status: 429, code: "REGISTRATION_LIMIT" }] }, "REGISTRATION_LIMIT", "Try again tomorrow"],
    ["registrations are rate limited (429)", { failRegisterWith: [{ status: 429, code: "RATE_LIMITED", headers: { "Retry-After": "30" } }] }, "RATE_LIMITED", "Wait 30 seconds"],
    ["the proof of possession is refused (401)", { failRegisterWith: [{ status: 401, code: "PROOF_OF_POSSESSION_FAILED" }] }, "REJECTED", /PROOF_OF_POSSESSION_FAILED/],
    ["the proof of work is refused (400)", { failRegisterWith: [{ status: 400, code: "POW_INVALID" }] }, "REJECTED", /POW_INVALID/],
    ["the key is already registered (409)", { failRegisterWith: [{ status: 409, code: "AGENT_KEY_EXISTS" }] }, "REJECTED", /AGENT_KEY_EXISTS/],
    ["the service errors (500)", { failRegisterWith: [{ status: 500, code: "INTERNAL" }] }, "UNAVAILABLE", "temporarily unavailable"],
  ];

  it.each(cases)("when %s", async (_name, options, code, text) => {
    const config = place();
    const { outcome } = await run(config, options);
    expect(outcome).toMatchObject({ ok: false, code });
    if (!outcome.ok) {
      if (typeof text === "string") expect(outcome.message).toContain(text);
      else expect(outcome.message).toMatch(text);
      expect(outcome.message).toContain("Nothing was registered");
    }
    expect(existsSync(config.keyFile)).toBe(false);
    expect(leftovers(config)).toEqual([]);
  });

  it("when the answer is not JSON at all", async () => {
    const config = place();
    const { outcome } = await run(config, { failChallengeWith: { status: 502, rawBody: "<html>Bad gateway</html>" } });
    expect(outcome).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    expect(leftovers(config)).toEqual([]);
  });

  it("when the network is down, without leaking its detail", async () => {
    const config = place();
    const down = (async () => {
      throw new TypeError("fetch failed: getaddrinfo ENOTFOUND internal-secret-host");
    }) as unknown as typeof fetch;
    const outcome = await registerIdentity(config, { fetch: down, threads: 1 });
    expect(outcome).toMatchObject({ ok: false, code: "NETWORK" });
    if (!outcome.ok) expect(outcome.message).not.toContain("internal-secret-host");
    expect(leftovers(config)).toEqual([]);
  });

  it("when the service does not answer in time", async () => {
    const config = place();
    const hang = ((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const outcome = await registerIdentity(config, { fetch: hang, threads: 1, timeoutMs: 20 });
    expect(outcome).toMatchObject({ ok: false, code: "TIMEOUT" });
    expect(leftovers(config)).toEqual([]);
  });

  it("when the user cancels while the proof of work runs", async () => {
    const config = place();
    const controller = new AbortController();
    const service = fakeRegistrar({ difficultyBits: 12 });
    const outcome = await registerIdentity(config, {
      fetch: service.fetch,
      signal: controller.signal,
      solve: async (options) => {
        controller.abort();
        throw new PowError("ABORTED", "The proof of work was cancelled.");
        void options;
      },
    });
    expect(outcome).toMatchObject({ ok: false, code: "CANCELLED" });
    expect(leftovers(config)).toEqual([]);
    expect(service.calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("when the folder cannot be written, before it registers anything", async () => {
    const blocker = join(root, `blocker-${++counter}`);
    writeFileSync(blocker, "a file where a folder should be");
    const config = { baseUrl: BASE_URL, keyFile: join(blocker, "sub", "key.pem") };
    const { outcome, service } = await run(config);
    expect(outcome).toMatchObject({ ok: false, code: "WRITE_FAILED" });
    expect(service.calls).toHaveLength(0);
    if (!outcome.ok) {
      expect(outcome.message).toContain("Nothing was registered");
      expect(outcome.message).toContain("ACHROMAT_AGENT_KEY_FILE");
    }
  });
});

describe("a hostile or odd challenge", () => {
  it("refuses a difficulty above the cap instead of burning CPU", async () => {
    const config = place();
    const { outcome } = await run(config, { challengeOverride: (base) => ({ ...base, difficulty_bits: 255 }) });
    expect(outcome).toMatchObject({ ok: false, code: "POW_FAILED" });
    if (!outcome.ok) expect(outcome.message).toContain("at most");
    expect(leftovers(config)).toEqual([]);
  });

  it("refuses an algorithm it does not know", async () => {
    const config = place();
    const { outcome } = await run(config, { algorithm: "argon2-v9" });
    expect(outcome).toMatchObject({ ok: false, code: "REJECTED" });
    if (!outcome.ok) expect(outcome.message).toContain("sha256-hashcash-v1");
  });

  it("refuses a challenge with fields missing or of the wrong type", async () => {
    for (const mutate of [
      (base: Record<string, unknown>) => ({ ...base, challenge: undefined }),
      (base: Record<string, unknown>) => ({ ...base, challenge_id: 7 }),
      (base: Record<string, unknown>) => ({ ...base, difficulty_bits: "22" }),
      (base: Record<string, unknown>) => ({ ...base, challenge_signature: "" }),
    ]) {
      const config = place();
      const { outcome } = await run(config, { challengeOverride: mutate });
      expect(outcome, JSON.stringify(mutate({}))).toMatchObject({ ok: false, code: "REJECTED" });
      expect(existsSync(config.keyFile)).toBe(false);
    }
  });
});

describe("it asks for a new challenge when the first goes stale", () => {
  it.each(["CHALLENGE_EXPIRED", "CHALLENGE_WRONG_NETWORK"])("once, on %s", async (code) => {
    const config = place();
    const { outcome, service } = await run(config, { failRegisterWith: [{ status: 400, code }] });
    expect(outcome.ok).toBe(true);
    expect(service.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /api/v1/agents/challenge",
      "POST /api/v1/agents/register",
      "GET /api/v1/agents/challenge",
      "POST /api/v1/agents/register",
    ]);
    expect(existsSync(config.keyFile)).toBe(true);
  });

  it("but not a second time", async () => {
    const config = place();
    const { outcome, service } = await run(config, { failRegisterWith: [{ status: 400, code: "CHALLENGE_EXPIRED" }, { status: 400, code: "CHALLENGE_EXPIRED" }] });
    expect(outcome).toMatchObject({ ok: false, code: "REJECTED" });
    expect(service.calls).toHaveLength(4);
    expect(existsSync(config.keyFile)).toBe(false);
  });
});

describe("the registered key works", () => {
  it("is accepted by the signing client once the service knows it", async () => {
    const config = place();
    const { outcome } = await run(config);
    if (!outcome.ok) throw new Error("expected success");
    const { MomClient } = await import("../src/client.js");
    const known = fakeService({ registered: new Set([outcome.publicKey]) });
    const client = new MomClient(config, { fetch: known.fetch });
    const result = await client.post("/api/v1/recall", { domain: "fintech", tool: "dispatch_wire", task_description: "Remit funds to a supplier for an invoice", arguments: { a: 1 } });
    expect(result).toMatchObject({ kind: "response", status: 200 });
  });
});

describe("hooks", () => {
  it("runs the commit hook only after the service accepted the key", async () => {
    const config = place();
    const hook = vi.fn();
    await run(config, { failRegisterWith: [{ status: 429, code: "REGISTRATION_LIMIT" }] }, { beforeCommit: hook });
    expect(hook).not.toHaveBeenCalled();
  });
});

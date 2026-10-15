import { describe, expect, it, vi } from "vitest";
import { MAX_BODY_BYTES, MomClient, errorCode } from "../src/client.js";
import { KeyFileError } from "../src/crypto.js";
import { BASE_URL, fakeService, freshKey, loaded } from "./helpers.js";

const config = { baseUrl: BASE_URL, keyFile: "/nowhere/key.pem" };
const PAYLOAD = { domain: "fintech", tool: "dispatch_wire", task_description: "Remit funds to a supplier for an invoice", arguments: { amount_usd: 100 } };

function client(service: ReturnType<typeof fakeService>, extra: ConstructorParameters<typeof MomClient>[1] = {}) {
  const key = freshKey();
  return { key, client: new MomClient(config, { fetch: service.fetch, loadKey: () => loaded(key), ...extra }) };
}

describe("a signed request", () => {
  it("is accepted by a service that checks the way the real one does", async () => {
    const service = fakeService();
    const { client: c, key } = client(service);
    const result = await c.post("/api/v1/recall", PAYLOAD);
    expect(result).toMatchObject({ kind: "response", status: 200 });
    expect(service.calls).toHaveLength(1);
    const call = service.calls[0]!;
    expect(call.url).toBe(`${BASE_URL}/api/v1/recall`);
    expect(call.method).toBe("POST");
    expect(call.headers.get("Achromat-Agent-Key")).toBe(key.publicKey);
    expect(call.headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(call.body)).toEqual(PAYLOAD);
  });

  it("signs the very bytes it sends, whatever the key order or characters in the body", async () => {
    const service = fakeService();
    const { client: c } = client(service);
    const odd = { b: 1, a: { z: "ü—\u2028 \"quoted\" \\ slash", y: [3, 2, 1] }, tool: "x" };
    expect(await c.post("/api/v1/calibrate", odd)).toMatchObject({ status: 200 });
  });

  it("uses a fresh nonce every time", async () => {
    const service = fakeService();
    const { client: c } = client(service);
    for (let i = 0; i < 25; i++) await c.post("/api/v1/recall", PAYLOAD);
    const nonces = service.calls.map((call) => call.nonce);
    expect(new Set(nonces).size).toBe(25);
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("refuses redirects, so a signed request can never be forwarded elsewhere", async () => {
    const fetchSpy = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response("{}", { status: 200 }));
    const { client: c } = client(fakeService(), { fetch: fetchSpy as unknown as typeof fetch });
    await c.post("/api/v1/recall", PAYLOAD);
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({ redirect: "error", method: "POST" });
  });

  it("identifies itself with a User-Agent", async () => {
    const service = fakeService();
    const { client: c } = client(service, { userAgent: "achromat-mcp-server/9.9.9" });
    await c.post("/api/v1/recall", PAYLOAD);
    expect(service.calls[0]!.headers.get("User-Agent")).toBe("achromat-mcp-server/9.9.9");
    const fallback = fakeService();
    await client(fallback)[`client`].post("/api/v1/recall", PAYLOAD);
    expect(fallback.calls[0]!.headers.get("User-Agent")).toBe("achromat-mcp-server");
  });

  it("goes only to the configured service", async () => {
    const service = fakeService();
    const key = freshKey();
    const c = new MomClient({ baseUrl: "https://example.test", keyFile: "x" }, { fetch: service.fetch, loadKey: () => loaded(key) });
    await c.post("/api/v1/recall", PAYLOAD);
    expect(service.calls[0]!.url).toBe("https://example.test/api/v1/recall");
  });
});

describe("the key", () => {
  it("is read on the first call only", async () => {
    const service = fakeService();
    const key = freshKey();
    const loadKey = vi.fn(() => loaded(key));
    const c = new MomClient(config, { fetch: service.fetch, loadKey });
    expect(loadKey).not.toHaveBeenCalled();
    await c.post("/api/v1/recall", PAYLOAD);
    await c.post("/api/v1/recall", PAYLOAD);
    expect(loadKey).toHaveBeenCalledTimes(1);
    expect(loadKey).toHaveBeenCalledWith(config.keyFile);
  });

  it("comes back as a result, not a crash, when it is missing, and is retried once the file exists", async () => {
    const service = fakeService();
    const key = freshKey();
    let present = false;
    const loadKey = vi.fn(() => {
      if (!present) throw new KeyFileError("NOT_FOUND", "No agent key found at /nowhere/key.pem.");
      return loaded(key);
    });
    const c = new MomClient(config, { fetch: service.fetch, loadKey });
    expect(await c.post("/api/v1/recall", PAYLOAD)).toEqual({ kind: "local", code: "KEY_NOT_FOUND", message: "No agent key found at /nowhere/key.pem." });
    expect(service.calls).toHaveLength(0);
    present = true;
    expect(await c.post("/api/v1/recall", PAYLOAD)).toMatchObject({ kind: "response", status: 200 });
    expect(loadKey).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["UNREADABLE", "KEY_UNREADABLE"],
    ["INVALID", "KEY_INVALID"],
    ["ENCRYPTED", "KEY_INVALID"],
    ["WRONG_TYPE", "KEY_INVALID"],
  ] as const)("maps a %s key file to %s", async (problem, code) => {
    const c = new MomClient(config, {
      fetch: fakeService().fetch,
      loadKey: () => {
        throw new KeyFileError(problem, "explained");
      },
    });
    expect(await c.post("/api/v1/recall", PAYLOAD)).toEqual({ kind: "local", code, message: "explained" });
  });

  it("does not hide a bug that is not a key problem", async () => {
    const c = new MomClient(config, {
      fetch: fakeService().fetch,
      loadKey: () => {
        throw new TypeError("programming error");
      },
    });
    await expect(c.post("/api/v1/recall", PAYLOAD)).rejects.toThrow("programming error");
  });

  it("warns once about a key file other users can read, and still signs", async () => {
    const service = fakeService();
    const warn = vi.fn();
    const key = freshKey();
    const c = new MomClient(config, { fetch: service.fetch, loadKey: () => loaded(key, "The key file is accessible to other users."), warn });
    await c.post("/api/v1/recall", PAYLOAD);
    await c.post("/api/v1/recall", PAYLOAD);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("The key file is accessible to other users.");
    expect(service.calls).toHaveLength(2);
  });
});

describe("the server's clock", () => {
  const MINUTES = 60_000;

  it("recovers from a local clock that is ten minutes slow: one rejection, then a corrected retry", async () => {
    const realNow = Date.now();
    const service = fakeService({ serverNow: () => realNow });
    const { client: c } = client(service, { now: () => realNow - 10 * MINUTES });
    const result = await c.post("/api/v1/recall", PAYLOAD);
    expect(result).toMatchObject({ kind: "response", status: 200 });
    // The first attempt never got past the skew check, so only the corrected one was recorded as received.
    expect(service.calls).toHaveLength(1);
    expect(Math.abs(service.calls[0]!.timestamp - realNow / 1000)).toBeLessThanOrEqual(1);
    // Date has one-second resolution, so the learned offset is right to within about a second.
    expect(Math.abs(c.clock.offsetMs - 10 * MINUTES)).toBeLessThanOrEqual(1500);
  });

  it("recovers from a local clock that is ten minutes fast", async () => {
    const realNow = Date.now();
    const service = fakeService({ serverNow: () => realNow });
    const { client: c } = client(service, { now: () => realNow + 10 * MINUTES });
    expect(await c.post("/api/v1/recall", PAYLOAD)).toMatchObject({ status: 200 });
    expect(Math.abs(c.clock.offsetMs + 10 * MINUTES)).toBeLessThanOrEqual(1500);
  });

  it("uses the learned offset from the start of the next request, with no further rejection", async () => {
    const realNow = Date.now();
    const fetchSpy = vi.fn();
    const service = fakeService({ serverNow: () => realNow });
    const { client: c } = client(service, { now: () => realNow - 10 * MINUTES, fetch: ((...args: Parameters<typeof fetch>) => (fetchSpy(), service.fetch(...args))) as typeof fetch });
    await c.post("/api/v1/recall", PAYLOAD);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    fetchSpy.mockClear();
    await c.post("/api/v1/recall", PAYLOAD);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("retries a skew rejection once and no more, then reports it", async () => {
    const fetchSpy = vi.fn();
    const service = fakeService({ alwaysExpired: true });
    const { client: c } = client(service, { fetch: ((...args: Parameters<typeof fetch>) => (fetchSpy(), service.fetch(...args))) as typeof fetch });
    const result = await c.post("/api/v1/recall", PAYLOAD);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ kind: "response", status: 401 });
    expect(errorCode((result as { body: unknown }).body)).toBe("AGENT_SIGNATURE_EXPIRED");
  });

  it("does not retry when the answer carries no date to learn the time from", async () => {
    const fetchSpy = vi.fn();
    const service = fakeService({ alwaysExpired: true, omitDate: true });
    const { client: c } = client(service, { fetch: ((...args: Parameters<typeof fetch>) => (fetchSpy(), service.fetch(...args))) as typeof fetch });
    await c.post("/api/v1/recall", PAYLOAD);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("sends a different nonce on the retry", async () => {
    const realNow = Date.now();
    const seenNonces: string[] = [];
    const service = fakeService({ serverNow: () => realNow });
    const wrapped = ((input: URL, init: RequestInit) => {
      seenNonces.push(new Headers(init.headers).get("Achromat-Nonce")!);
      return service.fetch(input, init);
    }) as unknown as typeof fetch;
    const { client: c } = client(service, { now: () => realNow - 10 * MINUTES, fetch: wrapped });
    await c.post("/api/v1/recall", PAYLOAD);
    expect(seenNonces).toHaveLength(2);
    expect(seenNonces[0]).not.toBe(seenNonces[1]);
  });
});

describe("failures a tool call can run into", () => {
  it("refuses a body over 64 KiB without sending it", async () => {
    const fetchSpy = vi.fn();
    const { client: c } = client(fakeService(), { fetch: fetchSpy as unknown as typeof fetch });
    const result = await c.post("/api/v1/calibrate", { ...PAYLOAD, arguments: { blob: "x".repeat(MAX_BODY_BYTES) } });
    expect(result).toMatchObject({ kind: "local", code: "BODY_TOO_LARGE" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("measures the limit in bytes, not characters", async () => {
    const fetchSpy = vi.fn();
    const { client: c } = client(fakeService(), { fetch: fetchSpy as unknown as typeof fetch });
    const result = await c.post("/api/v1/calibrate", { ...PAYLOAD, arguments: { blob: "€".repeat(MAX_BODY_BYTES / 2) } });
    expect(result).toMatchObject({ kind: "local", code: "BODY_TOO_LARGE" });
  });

  it("reports a timeout", async () => {
    const hang = ((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const { client: c } = client(fakeService(), { fetch: hang, timeoutMs: 20 });
    expect(await c.post("/api/v1/recall", PAYLOAD)).toMatchObject({ kind: "local", code: "TIMEOUT" });
  });

  it("reports a network failure without leaking its detail", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed: getaddrinfo ENOTFOUND secret-internal-host");
    }) as unknown as typeof fetch;
    const { client: c } = client(fakeService(), { fetch: down });
    const result = await c.post("/api/v1/recall", PAYLOAD);
    expect(result).toMatchObject({ kind: "local", code: "NETWORK" });
    expect(JSON.stringify(result)).not.toContain("secret-internal-host");
  });

  it("returns an answer that is not JSON as an unreadable body, not an exception", async () => {
    const service = fakeService({ respond: () => ({ status: 502 }) });
    const html = (async (input: URL, init: RequestInit) => {
      await service.fetch(input, init);
      return new Response("<html>Bad gateway</html>", { status: 502, headers: { Date: new Date().toUTCString() } });
    }) as unknown as typeof fetch;
    const { client: c } = client(service, { fetch: html });
    expect(await c.post("/api/v1/recall", PAYLOAD)).toMatchObject({ kind: "response", status: 502, body: null });
  });

  it("reads Retry-After as seconds or as a date", async () => {
    const now = Date.parse("2026-10-15T12:00:00Z");
    for (const [header, expected] of [["37", 37], ["Thu, 15 Oct 2026 12:01:00 GMT", 60], ["soon", null]] as const) {
      const service = fakeService({ serverNow: () => now, respond: () => ({ status: 429, body: { success: false, code: "RATE_LIMITED" }, headers: { "Retry-After": header } }) });
      const { client: c } = client(service, { now: () => now });
      expect(await c.post("/api/v1/recall", PAYLOAD), header).toMatchObject({ status: 429, retryAfterSeconds: expected });
    }
  });
});

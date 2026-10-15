import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { KeyFileError, ServerClock, base64url, canonicalString, loadAgentKey, parseAgentKey, sha256Hex, signRequest } from "../src/crypto.js";

/** The self-check vector published in the agent protocol (skill.md, section 8). Ed25519 is deterministic, so this pins the code down. */
const VECTOR = {
  seedHex: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  publicKey: "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg",
  host: "mom.achromat.ai",
  path: "/api/v1/recall",
  timestamp: "1790000000",
  nonce: "AAECAwQFBgcICQoLDA0ODw",
  body: '{"domain":"fintech","tool":"transfer_funds","task_description":"Move client funds to the settlement account","arguments":{"amount":50000}}',
  bodySha256: "91f119d8da6881e815ac07761bfc9b89a3d0289af5dceb724b42926a455bbf88",
  signature: "mPAMbWJ24bSAseFFTHQL0zo7UcmAb50J9LjFPHU8jxXuweWXE9J9pdzuOQqHMp4801FXi3SSLKHKRRzmB0t9BA",
};

/** An unencrypted PKCS#8 Ed25519 key for a 32-byte seed: the fixed DER prefix, then the seed. */
function pemFromSeed(seedHex: string): string {
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seedHex, "hex")]);
  return `-----BEGIN PRIVATE KEY-----\n${der.toString("base64")}\n-----END PRIVATE KEY-----\n`;
}

const directory = mkdtempSync(join(tmpdir(), "achromat-mcp-test-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("request signing against the published test vector", () => {
  const key = parseAgentKey(pemFromSeed(VECTOR.seedHex));

  it("derives the published public key", () => {
    expect(key.publicKey).toBe(VECTOR.publicKey);
    expect(key.publicKey).toHaveLength(43);
  });

  it("hashes the body bytes to the published digest", () => {
    expect(sha256Hex(Buffer.from(VECTOR.body, "utf8"))).toBe(VECTOR.bodySha256);
    expect(sha256Hex(new Uint8Array(0))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("produces the published signature byte for byte", () => {
    const headers = signRequest({
      key,
      method: "POST",
      url: new URL(`https://${VECTOR.host}${VECTOR.path}`),
      body: Buffer.from(VECTOR.body, "utf8"),
      timestampSeconds: Number(VECTOR.timestamp),
      nonce: VECTOR.nonce,
    });
    expect(headers).toEqual({
      "Achromat-Agent-Key": VECTOR.publicKey,
      "Achromat-Timestamp": VECTOR.timestamp,
      "Achromat-Nonce": VECTOR.nonce,
      "Achromat-Signature": VECTOR.signature,
    });
    expect(headers["Achromat-Signature"]).toHaveLength(86);
  });

  it("builds the canonical string from seven parts joined by a single LF", () => {
    const canonical = canonicalString({
      host: VECTOR.host,
      method: "POST",
      pathAndQuery: VECTOR.path,
      bodySha256Hex: VECTOR.bodySha256,
      timestamp: VECTOR.timestamp,
      nonce: VECTOR.nonce,
    });
    expect(canonical).toBe(["achromat-mom-v1", VECTOR.host, "POST", VECTOR.path, VECTOR.bodySha256, VECTOR.timestamp, VECTOR.nonce].join("\n"));
    expect(canonical.split("\n")).toHaveLength(7);
    expect(canonical.endsWith("\n")).toBe(false);
    expect(canonical).not.toContain("\r");
    expect(canonical).not.toContain("\\n");
  });

  it("lowercases the host and uppercases the method, as the protocol says", () => {
    const base = { pathAndQuery: "/x", bodySha256Hex: "00", timestamp: "1", nonce: "n" };
    expect(canonicalString({ ...base, host: "MOM.Achromat.AI", method: "post" })).toBe(canonicalString({ ...base, host: "mom.achromat.ai", method: "POST" }));
  });

  it("signs the host with its port, and the path with its query string, exactly as sent", () => {
    const sign = (url: string) =>
      signRequest({ key, method: "POST", url: new URL(url), body: new Uint8Array(0), timestampSeconds: 1790000000, nonce: VECTOR.nonce })["Achromat-Signature"];
    expect(sign("https://mom.achromat.ai/api/v1/recall")).not.toBe(sign("https://mom.achromat.ai:8443/api/v1/recall"));
    expect(sign("https://mom.achromat.ai/api/v1/recall")).not.toBe(sign("https://mom.achromat.ai/api/v1/recall?x=1"));
  });

  it("verifies with an independent Ed25519 verifier, and not after the body changes", () => {
    const url = new URL(`https://${VECTOR.host}${VECTOR.path}`);
    const headers = signRequest({ key, method: "POST", url, body: Buffer.from(VECTOR.body), timestampSeconds: 1790000000, nonce: VECTOR.nonce });
    const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: headers["Achromat-Agent-Key"] }, format: "jwk" });
    const canonical = (body: string) =>
      Buffer.from(canonicalString({ host: url.host, method: "POST", pathAndQuery: url.pathname, bodySha256Hex: sha256Hex(Buffer.from(body)), timestamp: "1790000000", nonce: VECTOR.nonce }));
    const signature = Buffer.from(headers["Achromat-Signature"], "base64url");
    expect(signature).toHaveLength(64);
    expect(verify(null, canonical(VECTOR.body), publicKey, signature)).toBe(true);
    expect(verify(null, canonical(VECTOR.body + " "), publicKey, signature)).toBe(false);
  });

  it("uses unpadded base64url", () => {
    expect(base64url(new Uint8Array([251, 255, 254]))).toBe("-__-");
    expect(base64url(new Uint8Array([1]))).toBe("AQ");
  });
});

describe("parseAgentKey", () => {
  it("rejects text that is not a PEM key, without quoting it", () => {
    const secretLooking = "-----BEGIN PRIVATE KEY-----\nTOPSECRETTOPSECRET\n-----END PRIVATE KEY-----\n";
    for (const input of ["", "hello", secretLooking]) {
      let error: unknown;
      try {
        parseAgentKey(input);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(KeyFileError);
      expect((error as KeyFileError).problem).toBe("INVALID");
      expect((error as KeyFileError).message).not.toContain("TOPSECRET");
    }
  });

  it("explains a passphrase-protected key", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const encrypted = privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "x" }).toString();
    expect(() => parseAgentKey(encrypted)).toThrowError(expect.objectContaining({ problem: "ENCRYPTED" }));
  });

  it("refuses a key of another type", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() => parseAgentKey(privateKey.export({ type: "pkcs8", format: "pem" }).toString())).toThrowError(expect.objectContaining({ problem: "WRONG_TYPE" }));
  });

  it("accepts a freshly generated Ed25519 key", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const key = parseAgentKey(privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    expect(key.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(key.sign("hello")).toHaveLength(86);
  });
});

describe("loadAgentKey", () => {
  const pem = pemFromSeed(VECTOR.seedHex);

  it("reads a key file and sees nothing wrong with a private one", () => {
    const path = join(directory, "private.pem");
    writeFileSync(path, pem, { mode: 0o600 });
    chmodSync(path, 0o600);
    const loaded = loadAgentKey(path);
    expect(loaded.key.publicKey).toBe(VECTOR.publicKey);
    expect(loaded.warning).toBeNull();
  });

  it("warns, and still works, when other users can read the file", () => {
    const path = join(directory, "open.pem");
    writeFileSync(path, pem);
    chmodSync(path, 0o644);
    const loaded = loadAgentKey(path);
    expect(loaded.key.publicKey).toBe(VECTOR.publicKey);
    expect(loaded.warning).toContain("chmod 600");
    expect(loaded.warning).toContain(path);
  });

  it("does not check permissions on Windows", () => {
    const path = join(directory, "open-win.pem");
    writeFileSync(path, pem);
    chmodSync(path, 0o644);
    expect(loadAgentKey(path, "win32").warning).toBeNull();
  });

  it("says where it looked and what to do when the file is missing", () => {
    const path = join(directory, "missing.pem");
    expect(() => loadAgentKey(path)).toThrowError(expect.objectContaining({ problem: "NOT_FOUND", message: expect.stringContaining(path) }));
    expect(() => loadAgentKey(path)).toThrowError(/ACHROMAT_AGENT_KEY_FILE/);
  });

  it("reports an unreadable path as such", () => {
    expect(() => loadAgentKey(directory)).toThrowError(expect.objectContaining({ problem: "UNREADABLE" }));
  });

  it("reports a file that is not a key", () => {
    const path = join(directory, "junk.pem");
    writeFileSync(path, "not a key");
    expect(() => loadAgentKey(path)).toThrowError(expect.objectContaining({ problem: "INVALID" }));
  });
});

describe("ServerClock", () => {
  const response = (date: string | null) => ({ headers: { get: (name: string) => (name === "Date" ? date : null) } });

  it("is zero and unsynchronised until it hears from the server", () => {
    const clock = new ServerClock();
    expect(clock.offsetMs).toBe(0);
    expect(clock.isSynchronised).toBe(false);
    expect(clock.serverTime(1000)).toBe(1000);
  });

  it("learns the offset from the Date header", () => {
    const clock = new ServerClock();
    const local = Date.parse("2026-10-15T12:00:00Z");
    expect(clock.observe(response("Thu, 15 Oct 2026 12:05:00 GMT"), local)).toBe(true);
    expect(clock.offsetMs).toBe(300_000);
    expect(clock.serverTime(local)).toBe(local + 300_000);
    expect(clock.isSynchronised).toBe(true);
  });

  it("learns a negative offset too, and keeps the old one when a header is missing or garbage", () => {
    const clock = new ServerClock();
    const local = Date.parse("2026-10-15T12:00:00Z");
    clock.observe(response("Thu, 15 Oct 2026 11:59:00 GMT"), local);
    expect(clock.offsetMs).toBe(-60_000);
    expect(clock.observe(response(null), local)).toBe(false);
    expect(clock.observe(response("not a date"), local)).toBe(false);
    expect(clock.offsetMs).toBe(-60_000);
  });
});

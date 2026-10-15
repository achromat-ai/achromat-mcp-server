import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_DIFFICULTY_BITS, MAX_THREADS, PowError, defaultThreads, leadingZeroBits, solvePow, verifyPow } from "../src/pow.js";

/** The published self-check vector (skill.md, section 8): difficulty 16, found by counting up from 0. */
const VECTOR = {
  challenge: "EoI8yTsHQvEUsyaAHydHIjYhx8tIlHh26aHmIaKqZlQ",
  publicKey: "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg",
  nonce: "7549",
  preimage: "EoI8yTsHQvEUsyaAHydHIjYhx8tIlHh26aHmIaKqZlQA6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg7549",
  sha256: "0000646354041268aa8fbf9d704f08bf54591d4f0247fef3b95ec8a117c257ec",
};

const b64u = (bytes: number) => randomBytes(bytes).toString("base64url");

describe("leadingZeroBits", () => {
  it("counts from the most significant bit of the first byte", () => {
    expect(leadingZeroBits(Buffer.from("ff", "hex"))).toBe(0);
    expect(leadingZeroBits(Buffer.from("7f", "hex"))).toBe(1);
    expect(leadingZeroBits(Buffer.from("0f", "hex"))).toBe(4);
    expect(leadingZeroBits(Buffer.from("01", "hex"))).toBe(7);
    expect(leadingZeroBits(Buffer.from("0000ff", "hex"))).toBe(16);
    expect(leadingZeroBits(Buffer.from("00006000", "hex"))).toBe(17);
    expect(leadingZeroBits(Buffer.from("0000", "hex"))).toBe(16);
    expect(leadingZeroBits(new Uint8Array(0))).toBe(0);
  });

  it("agrees with the published digest: 17 leading zero bits", () => {
    expect(leadingZeroBits(Buffer.from(VECTOR.sha256, "hex"))).toBe(17);
    expect(createHash("sha256").update(VECTOR.preimage).digest("hex")).toBe(VECTOR.sha256);
  });
});

describe("solvePow against the published vector", () => {
  it("counts up from zero and finds the published nonce", async () => {
    const solution = await solvePow({ challenge: VECTOR.challenge, publicKey: VECTOR.publicKey, difficultyBits: 16, threads: 1 });
    expect(solution.nonce).toBe(VECTOR.nonce);
    expect(solution.attempts).toBe(parseInt(VECTOR.nonce, 16) + 1);
    expect(verifyPow(VECTOR.challenge, VECTOR.publicKey, solution.nonce, 16)).toBe(true);
  });

  it("verifies the published nonce, and refuses a neighbour", () => {
    expect(verifyPow(VECTOR.challenge, VECTOR.publicKey, VECTOR.nonce, 16)).toBe(true);
    expect(verifyPow(VECTOR.challenge, VECTOR.publicKey, VECTOR.nonce, 17)).toBe(true);
    expect(verifyPow(VECTOR.challenge, VECTOR.publicKey, VECTOR.nonce, 18)).toBe(false);
    expect(verifyPow(VECTOR.challenge, VECTOR.publicKey, "754a", 16)).toBe(false);
  });

  it("only accepts nonces in the form the service accepts", () => {
    for (const nonce of ["", "7549X", "7549 ", "-1", "0x7549", "A".repeat(2), "a".repeat(33)]) expect(verifyPow(VECTOR.challenge, VECTOR.publicKey, nonce, 0), JSON.stringify(nonce)).toBe(false);
    expect(verifyPow(VECTOR.challenge, VECTOR.publicKey, "a".repeat(32), 0)).toBe(true);
  });
});

describe("solvePow", () => {
  it("finds the same nonce every time for the same inputs on one thread", async () => {
    const options = { challenge: "fixed-challenge", publicKey: VECTOR.publicKey, difficultyBits: 12, threads: 1 };
    const [a, b] = [await solvePow(options), await solvePow(options)];
    expect(a.nonce).toBe(b.nonce);
    expect(a.attempts).toBe(b.attempts);
  });

  it("returns a valid nonce in lowercase hex whatever the difficulty, including zero", async () => {
    for (const bits of [0, 1, 8, 14]) {
      const challenge = b64u(32);
      const { nonce } = await solvePow({ challenge, publicKey: VECTOR.publicKey, difficultyBits: bits, threads: 1 });
      expect(nonce).toMatch(/^[0-9a-f]{1,32}$/);
      expect(verifyPow(challenge, VECTOR.publicKey, nonce, bits), `${bits} bits`).toBe(true);
    }
  });

  it("with several threads finds a valid nonce, and no thread repeats another's work", async () => {
    for (let i = 0; i < 5; i++) {
      const challenge = b64u(32);
      const { nonce } = await solvePow({ challenge, publicKey: VECTOR.publicKey, difficultyBits: 16, threads: 4 });
      expect(verifyPow(challenge, VECTOR.publicKey, nonce, 16)).toBe(true);
    }
  });

  it("refuses a difficulty above the cap, and a difficulty that is not a whole number, without searching", async () => {
    for (const bits of [MAX_DIFFICULTY_BITS + 1, 255, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(solvePow({ challenge: "x", publicKey: "y", difficultyBits: bits }), String(bits)).rejects.toMatchObject({ name: "PowError", reason: "DIFFICULTY" });
    }
  });

  it("gives up at its deadline, on one thread and on several", async () => {
    // 40 bits can never be found, but the cap would refuse it: use a clock that jumps instead.
    let clock = 0;
    await expect(solvePow({ challenge: "x", publicKey: "y", difficultyBits: MAX_DIFFICULTY_BITS, threads: 1, deadlineMs: 50, now: () => (clock += 100) })).rejects.toMatchObject({ reason: "TIMEOUT" });
    await expect(solvePow({ challenge: "x", publicKey: "y", difficultyBits: MAX_DIFFICULTY_BITS, threads: 2, deadlineMs: 30 })).rejects.toMatchObject({ reason: "TIMEOUT" });
  });

  it("stops when cancelled, before starting and part-way, on one thread and on several", async () => {
    const already = new AbortController();
    already.abort();
    await expect(solvePow({ challenge: "x", publicKey: "y", difficultyBits: MAX_DIFFICULTY_BITS, threads: 1, signal: already.signal })).rejects.toMatchObject({ reason: "ABORTED" });
    await expect(solvePow({ challenge: "x", publicKey: "y", difficultyBits: MAX_DIFFICULTY_BITS, threads: 3, signal: already.signal })).rejects.toMatchObject({ reason: "ABORTED" });

    for (const threads of [1, 3]) {
      const controller = new AbortController();
      const pending = solvePow({ challenge: "never-found", publicKey: "y", difficultyBits: MAX_DIFFICULTY_BITS, threads, signal: controller.signal });
      setTimeout(() => controller.abort(), 40);
      const started = Date.now();
      await expect(pending, `${threads} thread(s)`).rejects.toBeInstanceOf(PowError);
      expect(Date.now() - started).toBeLessThan(2000);
    }
  });

  it("keeps the event loop responsive while it works on one thread", async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    await solvePow({ challenge: "responsiveness", publicKey: VECTOR.publicKey, difficultyBits: 18, threads: 1 });
    clearInterval(timer);
    // 18 bits is a couple of hundred thousand hashes, over 100 ms: a loop that never yielded would tick zero times.
    expect(ticks).toBeGreaterThan(3);
  });

  it("chooses a sensible default number of threads", () => {
    expect(defaultThreads()).toBeGreaterThanOrEqual(1);
    expect(defaultThreads()).toBeLessThanOrEqual(MAX_THREADS);
  });
});

describe("production difficulty (22 bits)", () => {
  // A fixed challenge, so the work is the same every run: 3,666,886 attempts, close to the 4.19 million average.
  const FIXED = { challenge: "deterministic-benchmark-challenge-03", publicKey: VECTOR.publicKey, nonce: "37f3c5", attempts: 3_666_886 };

  it("finds the known nonce for a typical amount of work on one thread, and reports its speed", async () => {
    const solution = await solvePow({ challenge: FIXED.challenge, publicKey: FIXED.publicKey, difficultyBits: 22, threads: 1 });
    expect(solution.nonce).toBe(FIXED.nonce);
    expect(solution.attempts).toBe(FIXED.attempts);
    expect(verifyPow(FIXED.challenge, FIXED.publicKey, solution.nonce, 22)).toBe(true);
    const rate = solution.attempts / (solution.elapsedMs / 1000) / 1e6;
    console.log(`22-bit solve, one thread: ${(solution.elapsedMs / 1000).toFixed(2)} s for ${solution.attempts.toLocaleString("en-US")} attempts (${rate.toFixed(2)} M hashes/s)`);
    // Generous on purpose: this guards against the loop becoming pathologically slow, on a loaded CI machine too.
    expect(solution.elapsedMs).toBeLessThan(30_000);
  }, 60_000);

  it("is faster with the default threads, and still correct", async () => {
    const threads = defaultThreads();
    if (threads === 1) return; // a one-core machine has nothing to compare
    const solution = await solvePow({ challenge: FIXED.challenge, publicKey: FIXED.publicKey, difficultyBits: 22, threads });
    expect(verifyPow(FIXED.challenge, FIXED.publicKey, solution.nonce, 22)).toBe(true);
    console.log(`22-bit solve, ${threads} threads: ${(solution.elapsedMs / 1000).toFixed(2)} s`);
    expect(solution.elapsedMs).toBeLessThan(30_000);
  }, 60_000);
});

/**
 * The Hashcash proof of work that registration asks for (agent protocol, skill.md section 2.2):
 *
 *   preimage = UTF8( challenge + public_key + nonce )      plain concatenation, no separator
 *   valid    = leadingZeroBits( SHA-256(preimage) ) >= difficulty_bits
 *
 * `nonce` is the lowercase hex text of a counter (1 to 32 characters), appended as text. Counting up from 0
 * is a valid way to enumerate nonces, and finds the same nonce every time for the same inputs.
 *
 * Production asks for 22 bits, about 4.2 million hashes on average. One thread does roughly 2 million a
 * second, so a solve takes about 2 seconds on average but with a long tail (a few in a hundred take over 10).
 * The search is therefore split across worker threads: the work divides by the thread count and the tail
 * shrinks with it. With one thread (a small machine, or a test that wants a deterministic nonce) the loop
 * works in slices and yields to the event loop between them. Either way the main thread stays free: this
 * process is an MCP server, and a loop that spun for seconds would stop it answering its host's pings and
 * cancellations.
 */
import { createHash, hash as nodeHash } from "node:crypto";
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";

export const POW_ALGORITHM = "sha256-hashcash-v1";

/**
 * The most work this client will do for one registration. The difficulty comes from the server, so without a
 * cap a faulty or hostile answer (255 bits) would pin a CPU forever. 28 bits is about 64x the production work.
 */
export const MAX_DIFFICULTY_BITS = 28;

/** Attempts per slice, about 15 ms at the speeds above. */
const SLICE_ATTEMPTS = 25_000;

/** Leading zero bits of a digest, counted from the most significant bit of the first byte. */
export function leadingZeroBits(digest: Uint8Array): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

export type PowFailure = "ABORTED" | "TIMEOUT" | "DIFFICULTY";

export class PowError extends Error {
  readonly reason: PowFailure;

  constructor(reason: PowFailure, message: string) {
    super(message);
    this.name = "PowError";
    this.reason = reason;
  }
}

export interface SolveOptions {
  challenge: string;
  publicKey: string;
  difficultyBits: number;
  /** Stops the search at the next slice boundary. */
  signal?: AbortSignal;
  /** Gives up after this long. Defaults to 2 minutes (the challenge lives for 10). */
  deadlineMs?: number;
  /**
   * Worker threads to search with. Default: spare cores, between 1 and 8. With 1 the search runs on the main
   * thread, counts up from 0, and finds the same nonce every time. With more, any valid nonce may come back.
   */
  threads?: number;
  /** Test hooks. */
  now?: () => number;
  sliceAttempts?: number;
}

export interface Solution {
  /** Lowercase hex text, 1 to 32 characters. */
  nonce: string;
  attempts: number;
  elapsedMs: number;
}

export const DEFAULT_DEADLINE_MS = 120_000;

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** SHA-256 of a string. The one-shot form is faster where it exists (Node 20.12+, 21.7+). */
const sha256: (input: string) => Uint8Array =
  typeof nodeHash === "function" ? (input) => nodeHash("sha256", input, "buffer") : (input) => createHash("sha256").update(input).digest();

/**
 * One thread per spare core, at most 8. The work lasts about a second, so briefly using most of a laptop is
 * fine; past 8 threads the hashing is already quicker than the network round trips around it.
 */
export const MAX_THREADS = 8;
export function defaultThreads(): number {
  return Math.max(1, Math.min(MAX_THREADS, availableParallelism() - 1));
}

/**
 * The search loop a worker runs, as source text so that nothing extra has to be shipped or resolved. Worker k
 * tries counters k, k + T, k + 2T, ... so no two workers test the same nonce.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { createHash, hash } = require("node:crypto");
const { prefix, bits, start, stride } = workerData;
const sha = typeof hash === "function" ? (s) => hash("sha256", s, "buffer") : (s) => createHash("sha256").update(s).digest();
function zeros(d) { let b = 0; for (const x of d) { if (x === 0) { b += 8; continue; } return b + Math.clz32(x) - 24; } return b; }
let attempts = 0;
for (let counter = start; ; counter += stride) {
  attempts++;
  if (zeros(sha(prefix + counter.toString(16))) >= bits) { parentPort.postMessage({ nonce: counter.toString(16), attempts }); break; }
}
`;

function solveInWorkers(options: SolveOptions, threads: number, deadline: number, now: () => number): Promise<Solution> {
  const started = now();
  const prefix = options.challenge + options.publicKey;
  return new Promise<Solution>((resolve, reject) => {
    const workers: Worker[] = [];
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      for (const worker of workers) void worker.terminate();
      outcome();
    };
    const onAbort = () => finish(() => reject(new PowError("ABORTED", "The proof of work was cancelled.")));
    if (options.signal?.aborted) return onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish(() => reject(new PowError("TIMEOUT", `The proof of work was not found within ${Math.round(deadline / 1000)} seconds.`))), deadline);

    for (let index = 0; index < threads; index++) {
      const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { prefix, bits: options.difficultyBits, start: index, stride: threads } });
      workers.push(worker);
      worker.once("message", (found: { nonce: string; attempts: number }) =>
        finish(() => resolve({ nonce: found.nonce, attempts: found.attempts * threads, elapsedMs: now() - started })),
      );
      worker.once("error", (error) => finish(() => reject(error)));
    }
  });
}

export async function solvePow(options: SolveOptions): Promise<Solution> {
  const { challenge, publicKey, difficultyBits } = options;
  if (!Number.isInteger(difficultyBits) || difficultyBits < 0 || difficultyBits > MAX_DIFFICULTY_BITS) {
    throw new PowError("DIFFICULTY", `The service asked for ${difficultyBits} bits of proof of work; this client does at most ${MAX_DIFFICULTY_BITS}.`);
  }
  const now = options.now ?? (() => performance.now());
  const threads = Math.max(1, Math.floor(options.threads ?? defaultThreads()));
  if (threads > 1) return solveInWorkers(options, threads, options.deadlineMs ?? DEFAULT_DEADLINE_MS, now);
  const slice = options.sliceAttempts ?? SLICE_ATTEMPTS;
  const deadline = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const prefix = challenge + publicKey;
  const started = now();

  let counter = 0;
  for (;;) {
    if (options.signal?.aborted) throw new PowError("ABORTED", "The proof of work was cancelled.");
    if (now() - started > deadline) throw new PowError("TIMEOUT", `The proof of work was not found within ${Math.round(deadline / 1000)} seconds.`);
    const end = counter + slice;
    for (; counter < end; counter++) {
      const nonce = counter.toString(16);
      if (leadingZeroBits(sha256(prefix + nonce)) >= difficultyBits) {
        return { nonce, attempts: counter + 1, elapsedMs: now() - started };
      }
    }
    await yieldToEventLoop();
  }
}

/** Checks a nonce the way the service does. */
export function verifyPow(challenge: string, publicKey: string, nonce: string, difficultyBits: number): boolean {
  if (!/^[0-9a-f]{1,32}$/.test(nonce)) return false;
  return leadingZeroBits(sha256(challenge + publicKey + nonce)) >= difficultyBits;
}

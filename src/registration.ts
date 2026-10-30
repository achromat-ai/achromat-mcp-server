/**
 * Registering an identity with Achromat MOM, end to end, so that nobody has to run a separate script:
 *
 *   1. generate an Ed25519 key pair
 *   2. write the private key to a private temporary file next to its final path
 *   3. GET  /api/v1/agents/challenge
 *   4. solve the Hashcash proof of work (pow.ts) and sign the proof of possession
 *   5. POST /api/v1/agents/register
 *   6. move the temporary file to its final path, refusing to overwrite anything that is there
 *
 * The protocol is skill.md section 2. Neither call is signed (there is no identity yet), so this module does
 * not use MomClient. When ACHROMAT_REF is set, both calls carry it as `?ref=<tag>` (and so does the retry's fresh
 * challenge), which is how the service attributes a registration to the link that brought the install. It is sent
 * nowhere else.
 *
 * The private key cannot be replaced, and registration is limited to 10 a day per network, so the order above
 * is what keeps two states from ever existing:
 *   - "registered, but the key was never saved": the key is on disk (step 2) before the service hears of it.
 *   - "a key file that the service does not know": the file only gets its final name (step 6) after the
 *     service has accepted the key. Any failure before that deletes the temporary file.
 * If the service accepts the key and the final move then fails, the temporary file is KEPT and its path is
 * reported, because it is now the only copy of a registered identity.
 *
 * Nothing here logs, and no message or result contains the private key.
 */
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { parseRef, type Config } from "./config.js";
import { parseAgentKey, type AgentKey } from "./crypto.js";
import { POW_ALGORITHM, PowError, solvePow, type SolveOptions, type Solution } from "./pow.js";

export const REGISTER_CONTEXT = "achromat-register-v1";
export const CHALLENGE_PATH = "/api/v1/agents/challenge";
export const REGISTER_PATH = "/api/v1/agents/register";
export const REQUEST_TIMEOUT_MS = 30_000;

/** `path` with `?ref=<tag>` when there is a valid tag, otherwise `path` unchanged. */
export function withRef(path: string, ref: string | undefined): string {
  const tag = parseRef(ref);
  return tag === "" ? path : `${path}?ref=${encodeURIComponent(tag)}`;
}

/** What the new key signs to prove it holds the private half: `achromat-register-v1` LF challenge LF public_key. */
export function proofOfPossessionMessage(challenge: string, publicKey: string): string {
  return `${REGISTER_CONTEXT}\n${challenge}\n${publicKey}`;
}

export type RegistrationErrorCode =
  | "KEY_EXISTS"
  | "WRITE_FAILED"
  | "NETWORK"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "REGISTRATION_LIMIT"
  | "UNAVAILABLE"
  | "REJECTED"
  | "POW_FAILED"
  | "CANCELLED"
  | "COMMIT_FAILED";

export type RegistrationOutcome =
  | {
      ok: true;
      /** The new key's public half, base64url. */
      publicKey: string;
      /** The service's id for the key (hex). */
      agentKey: string | null;
      role: string | null;
      keyFile: string;
      pow: { attempts: number; elapsedMs: number };
    }
  | { ok: false; code: RegistrationErrorCode; message: string; retryAfterSeconds?: number | null };

export interface RegistrationDeps {
  fetch?: typeof fetch;
  solve?: (options: SolveOptions) => Promise<Solution>;
  /** Passed to the solver: how many threads to search with. */
  threads?: number;
  signal?: AbortSignal;
  userAgent?: string;
  timeoutMs?: number;
  /** Test hook: runs between a successful registration and the final move. */
  beforeCommit?: (paths: { tmp: string; final: string }) => void;
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

interface Challenge {
  id: string;
  challenge: string;
  signature: string;
  difficultyBits: number;
}

function fail(code: RegistrationErrorCode, message: string, retryAfterSeconds?: number | null): RegistrationOutcome {
  return { ok: false, code, message, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) };
}

function retryAfter(response: Response): number | null {
  const header = response.headers.get("Retry-After");
  const seconds = header === null ? NaN : Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : null;
}

/** An AbortSignal that fires when either input does. (AbortSignal.any needs Node 20.3.) */
function anySignal(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

class Registration {
  private readonly fetchImpl: typeof fetch;
  private readonly solve: (options: SolveOptions) => Promise<Solution>;

  constructor(
    private readonly config: Config,
    private readonly deps: RegistrationDeps,
  ) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.solve = deps.solve ?? solvePow;
  }

  /** One HTTP exchange. Returns the response, or the outcome that explains why there is none. */
  private async exchange(path: string, init: RequestInit): Promise<{ response: Response; body: unknown } | RegistrationOutcome> {
    const timeoutMs = this.deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
    try {
      const response = await this.fetchImpl(new URL(path, this.config.baseUrl), {
        ...init,
        headers: { Accept: "application/json", "User-Agent": this.deps.userAgent ?? "achromat-mcp-server", ...(init.headers as Record<string, string> | undefined) },
        redirect: "error",
        signal: anySignal(AbortSignal.timeout(timeoutMs), this.deps.signal),
      });
      let body: unknown = null;
      try {
        body = JSON.parse(await response.text());
      } catch {
        body = null;
      }
      return { response, body };
    } catch (error) {
      if (this.deps.signal?.aborted) return fail("CANCELLED", "Registration was cancelled.");
      const name = (error as { name?: string }).name;
      if (name === "TimeoutError" || name === "AbortError") return fail("TIMEOUT", `No answer from ${this.config.baseUrl} within ${Math.round(timeoutMs / 1000)} seconds. Nothing was registered.`);
      return fail("NETWORK", `Could not reach ${this.config.baseUrl}. Nothing was registered. Check the connection and try again.`);
    }
  }

  /** Turns a non-success answer into the outcome the caller should return. */
  private refusal(response: Response, body: unknown): RegistrationOutcome {
    const code = isRecord(body) ? str(body.code) : null;
    const status = response.status;
    const tag = `HTTP ${status}${code ? `, ${code}` : ""}`;
    if (code === "REGISTRATION_LIMIT") {
      return fail("REGISTRATION_LIMIT", `The service has reached its registration limit for this network (${tag}). Try again tomorrow, or from another network. Nothing was registered.`);
    }
    if (status === 429) {
      const wait = retryAfter(response);
      return fail("RATE_LIMITED", `Too many registration requests from this network (${tag}). Wait ${wait === null ? "a minute" : `${wait} seconds`} and try again. Nothing was registered.`, wait);
    }
    if (status === 503 || status >= 500) {
      return fail("UNAVAILABLE", `Registration is temporarily unavailable (${tag}). Try again shortly. Nothing was registered.`, retryAfter(response));
    }
    return fail("REJECTED", `The service refused the registration (${tag}). This points to a fault in the client or the service, not to anything the user can change. Nothing was registered.`);
  }

  private async fetchChallenge(): Promise<Challenge | RegistrationOutcome> {
    const result = await this.exchange(withRef(CHALLENGE_PATH, this.config.ref), { method: "GET" });
    if (!("response" in result)) return result;
    const { response, body } = result;
    if (response.status !== 200) return this.refusal(response, body);
    if (!isRecord(body)) return fail("REJECTED", "The service sent a challenge this client could not read. Nothing was registered.");
    const id = str(body.challenge_id);
    const challenge = str(body.challenge);
    const signature = str(body.challenge_signature);
    const bits = body.difficulty_bits;
    if (!id || !challenge || !signature || typeof bits !== "number" || body.algorithm !== POW_ALGORITHM) {
      return fail("REJECTED", `The service sent a challenge in a form this client does not support (expected ${POW_ALGORITHM}). Nothing was registered.`);
    }
    return { id, challenge, signature, difficultyBits: bits };
  }

  /** Steps 3 to 5. Retries once with a fresh challenge if this one expired or was issued to another network. */
  async run(key: AgentKey): Promise<{ outcome: RegistrationOutcome; agentKey: string | null; role: string | null; pow: Solution | null }> {
    let lastPow: Solution | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const challenge = await this.fetchChallenge();
      if (!("id" in challenge)) return { outcome: challenge, agentKey: null, role: null, pow: lastPow };

      let solution: Solution;
      try {
        solution = await this.solve({ challenge: challenge.challenge, publicKey: key.publicKey, difficultyBits: challenge.difficultyBits, ...(this.deps.signal ? { signal: this.deps.signal } : {}), ...(this.deps.threads === undefined ? {} : { threads: this.deps.threads }) });
      } catch (error) {
        if (error instanceof PowError) {
          const code = error.reason === "ABORTED" ? "CANCELLED" : "POW_FAILED";
          return { outcome: fail(code, `${error.message} Nothing was registered.`), agentKey: null, role: null, pow: lastPow };
        }
        throw error;
      }
      lastPow = solution;

      const body = JSON.stringify({
        public_key: key.publicKey,
        challenge_id: challenge.id,
        challenge_signature: challenge.signature,
        nonce: solution.nonce,
        proof_signature: key.sign(proofOfPossessionMessage(challenge.challenge, key.publicKey)),
      });
      const result = await this.exchange(withRef(REGISTER_PATH, this.config.ref), { method: "POST", headers: { "Content-Type": "application/json" }, body });
      if (!("response" in result)) return { outcome: result, agentKey: null, role: null, pow: lastPow };
      const { response, body: answer } = result;

      if (response.status === 201 && isRecord(answer) && answer.success === true && isRecord(answer.agent) && answer.agent.public_key === key.publicKey) {
        return { outcome: { ok: true, publicKey: key.publicKey, agentKey: str(answer.agent.agent_key), role: str(answer.agent.role), keyFile: this.config.keyFile, pow: { attempts: solution.attempts, elapsedMs: solution.elapsedMs } }, agentKey: str(answer.agent.agent_key), role: str(answer.agent.role), pow: solution };
      }
      const code = isRecord(answer) ? str(answer.code) : null;
      if (response.status === 400 && (code === "CHALLENGE_EXPIRED" || code === "CHALLENGE_WRONG_NETWORK") && attempt === 0) continue;
      return { outcome: this.refusal(response, answer), agentKey: null, role: null, pow: lastPow };
    }
    return { outcome: fail("REJECTED", "The service rejected two challenges in a row. Nothing was registered."), agentKey: null, role: null, pow: lastPow };
  }
}

// ───────────────────────────── the key file ─────────────────────────────

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or not ours to remove: nothing more to do.
  }
}

/** Gives the temporary file its final name without ever replacing a file that is already there. */
function commitKeyFile(tmp: string, final: string): void {
  try {
    linkSync(tmp, final); // fails with EEXIST instead of overwriting
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "EEXIST") throw error;
    // No hard links here (some network or removable file systems): fall back to a checked rename.
    if (existsSync(final)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
    renameSync(tmp, final);
    return;
  }
  removeQuietly(tmp);
}

/**
 * Creates the key, registers it, and saves it at `config.keyFile`. Never throws for anything a user can run
 * into: every failure is an outcome with a message that says what happened and what is safe to do next.
 */
export async function registerIdentity(config: Config, deps: RegistrationDeps = {}): Promise<RegistrationOutcome> {
  const final = config.keyFile;
  if (existsSync(final)) {
    return fail("KEY_EXISTS", `A key file already exists at ${final}, so no new identity was created. To register a different identity, move or delete that file and restart the host.`);
  }

  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const key = parseAgentKey(pem);

  // Step 2, before any network call: if the disk cannot take the key, find out now and register nothing.
  const directory = dirname(final);
  const tmp = join(directory, `.${basename(final)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const existed = existsSync(directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!existed) {
      try {
        chmodSync(directory, 0o700); // mkdir's mode is filtered by the umask
      } catch {
        // Not every file system has modes.
      }
    }
    writeFileSync(tmp, pem, { flag: "wx", mode: 0o600 });
  } catch (error) {
    removeQuietly(tmp);
    const code = (error as { code?: string }).code ?? "unknown error";
    return fail("WRITE_FAILED", `The key could not be saved at ${final} (${code}). Nothing was registered. Check that the folder exists and this user may write to it, or set ACHROMAT_AGENT_KEY_FILE to a writable path.`);
  }

  let result: Awaited<ReturnType<Registration["run"]>>;
  try {
    result = await new Registration(config, deps).run(key);
  } catch (error) {
    removeQuietly(tmp);
    throw error;
  }
  if (!result.outcome.ok) {
    removeQuietly(tmp); // not registered, so the key is worthless
    return result.outcome;
  }

  // The service has accepted the key. From here the file on disk is the only copy: never delete it.
  try {
    deps.beforeCommit?.({ tmp, final });
    commitKeyFile(tmp, final);
  } catch (error) {
    const code = (error as { code?: string }).code ?? "unknown error";
    return fail(
      "COMMIT_FAILED",
      `The identity was registered, but the key file could not be moved to ${final} (${code}). The key is saved at ${tmp}. Move it to ${final} yourself, or set ACHROMAT_AGENT_KEY_FILE to ${tmp}. Do not delete it: it is the only copy.`,
    );
  }
  try {
    chmodSync(final, 0o600);
  } catch {
    // Not every file system has modes.
  }
  return result.outcome;
}

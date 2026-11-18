import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { MomClient } from "../src/client.js";
import { KeyFileError } from "../src/crypto.js";
import { COVERAGE, DOMAINS, calibrateInput, recallInput, registerTools, toRequestBody } from "../src/tools.js";
import { BASE_URL, fakeService, freshKey, loaded, type FakeServiceOptions } from "./helpers.js";

/** A real MCP client talking to the real server over an in-memory pipe. */
async function connect(options: FakeServiceOptions = {}, loadKey?: () => ReturnType<typeof loaded>) {
  const service = fakeService(options);
  const key = freshKey();
  const momClient = new MomClient({ baseUrl: BASE_URL, keyFile: "/k.pem" }, { fetch: service.fetch, loadKey: loadKey ?? (() => loaded(key)) });
  const server = new McpServer({ name: "test", version: "0.0.0" });
  // These tests are about recall and calibrate, so a key is "in place" and those two tools are offered.
  registerTools(server, momClient, { config: { baseUrl: BASE_URL, keyFile: "/k.pem" }, keyExists: () => true });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "host", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, service, key };
}

const TASK = "Remit settlement funds to an overseas supplier for the outstanding parts invoice";
const text = (result: unknown) => ((result as { content: Array<{ text: string }> }).content ?? []).map((part) => part.text).join("\n");

describe("the tools a host sees", () => {
  it("lists exactly achromat_recall and achromat_calibrate once a key is in place", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["achromat_calibrate", "achromat_recall"]);
  });

  it("requires arguments on recall, as the service does, and says the key names drive matching", async () => {
    const { client } = await connect();
    const recall = (await client.listTools()).tools.find((tool) => tool.name === "achromat_recall")!;
    expect(recall.inputSchema.required).toEqual(expect.arrayContaining(["domain", "tool_name", "task_description", "arguments"]));
    const description = (recall.inputSchema.properties as Record<string, { description: string }>).arguments!.description;
    expect(description).toContain("REQUIRED");
    expect(description).toMatch(/names of the keys/i);
    expect(description).toMatch(/never the values/i);
    expect(recall.description).toMatch(/names of their keys \(not the values\)/);
  });

  it("requires arguments on calibrate too, and leaves trap_id optional", async () => {
    const { client } = await connect();
    const calibrate = (await client.listTools()).tools.find((tool) => tool.name === "achromat_calibrate")!;
    expect(calibrate.inputSchema.required).toEqual(expect.arrayContaining(["domain", "tool_name", "task_description", "arguments"]));
    expect(calibrate.inputSchema.required).not.toContain("trap_id");
  });

  it("rejects a recall without arguments, or with an empty object, before anything is sent", async () => {
    const { client, service } = await connect();
    for (const args of [{ domain: "fintech", tool_name: "dispatch_wire", task_description: TASK }, { domain: "fintech", tool_name: "dispatch_wire", task_description: TASK, arguments: {} }]) {
      const result = await client.callTool({ name: "achromat_recall", arguments: args }).catch((error: Error) => ({ isError: true, content: [{ text: error.message }] }));
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(text(result)).toMatch(/arguments/);
    }
    expect(service.calls).toHaveLength(0);
  });

  it("rejects bad input of every other kind before anything is sent", async () => {
    const { client, service } = await connect();
    const good = { domain: "fintech", tool_name: "dispatch_wire", task_description: TASK, arguments: { amount_usd: 1 } };
    for (const bad of [{ ...good, domain: "healthcare" }, { ...good, tool_name: "../etc" }, { ...good, task_description: "wire money" }, { ...good, task_description: "x".repeat(1001) }]) {
      const result = await client.callTool({ name: "achromat_recall", arguments: bad }).catch((error: Error) => ({ isError: true, content: [{ text: error.message }] }));
      expect((result as { isError?: boolean }).isError).toBe(true);
    }
    expect(service.calls).toHaveLength(0);
  });
});

describe("achromat_recall", () => {
  it("sends a signed POST /api/v1/recall with tool_name sent as tool, and returns the blueprint", async () => {
    const { client, service, key } = await connect({
      respond: () => ({
        status: 200,
        body: { success: true, match: true, tier: "semantic", score: 0.85, lesson: { violation_rule: "Rule 5", steering_directive: "Add a ref.", compliant_arguments: { beneficiary_account_ref: "[VERIFIED_STATE]" }, changed_paths: [] } },
      }),
    });
    const result = await client.callTool({ name: "achromat_recall", arguments: { domain: "fintech", tool_name: "dispatch_wire", task_description: TASK, arguments: { amount_usd: 100 } } });
    expect(result.isError).toBe(false);
    expect(text(result)).toContain("MATCH: semantic tier");
    expect(text(result)).toContain("[VERIFIED_STATE]");

    const sent = service.calls[0]!;
    expect(sent.url).toBe(`${BASE_URL}/api/v1/recall`);
    expect(sent.headers.get("Achromat-Agent-Key")).toBe(key.publicKey);
    expect(JSON.parse(sent.body)).toEqual({ domain: "fintech", tool: "dispatch_wire", task_description: TASK, arguments: { amount_usd: 100 } });
    expect(JSON.parse(sent.body)).not.toHaveProperty("tool_name");
  });

  it("returns a rate limit as an error result with the wait, not as a protocol failure", async () => {
    const { client } = await connect({ respond: () => ({ status: 429, body: { success: false, code: "RATE_LIMITED", error: "slow down" }, headers: { "Retry-After": "90" } }) });
    const result = await client.callTool({ name: "achromat_recall", arguments: { domain: "fintech", tool_name: "dispatch_wire", task_description: TASK, arguments: { a: 1 } } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Rate limited on recall (HTTP 429)");
    expect(text(result)).toContain("Wait 90 seconds");
  });

  it.each([
    [401, "AGENT_KEY_UNKNOWN", "does not know this key"],
    [403, "AGENT_KEY_INACTIVE", "revoked or rotated"],
  ] as const)("returns HTTP %i %s as readable text", async (status, code, expected) => {
    const { client } = await connect({ respond: () => ({ status, body: { success: false, code, error: "x" } }) });
    const result = await client.callTool({ name: "achromat_recall", arguments: { domain: "fintech", tool_name: "dispatch_wire", task_description: TASK, arguments: { a: 1 } } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(expected);
  });

  it("reaches an unregistered key's rejection through the real signature check", async () => {
    const { client } = await connect({ registered: new Set(["someone-else-entirely-0123456789abcdefghijk"]) });
    const result = await client.callTool({ name: "achromat_recall", arguments: { domain: "fintech", tool_name: "dispatch_wire", task_description: TASK, arguments: { a: 1 } } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("AGENT_KEY_UNKNOWN");
  });

  it("sends recall without a signature when there is no key file, and signs it once the file exists", async () => {
    let present = false;
    const key = freshKey();
    const { client, service } = await connect({ optionalSignature: true, respond: () => ({ status: 200, body: { success: true, match: false } }) }, () => {
      if (!present) throw new KeyFileError("NOT_FOUND", "No agent key found at /k.pem. Create and register one.");
      return loaded(key);
    });
    const args = { domain: "fintech", tool_name: "dispatch_wire", task_description: TASK, arguments: { a: 1 } };
    const first = await client.callTool({ name: "achromat_recall", arguments: args });
    expect(first.isError).toBe(false);
    expect(text(first)).toContain("NO MATCH");
    expect(service.calls).toHaveLength(1);
    expect(service.calls[0]!.signed).toBe(false);
    present = true;
    const second = await client.callTool({ name: "achromat_recall", arguments: args });
    expect(second.isError).toBe(false);
    expect(service.calls).toHaveLength(2);
    expect(service.calls[1]!.signed).toBe(true);
    expect(service.calls[1]!.headers.get("Achromat-Agent-Key")).toBe(key.publicKey);
  });

  it("never sends recall unsigned because a key file is broken: a key that exists but cannot be used is reported", async () => {
    for (const problem of ["UNREADABLE", "INVALID", "ENCRYPTED", "WRONG_TYPE"] as const) {
      const { client, service } = await connect({ optionalSignature: true }, () => {
        throw new KeyFileError(problem, `the key file is ${problem}`);
      });
      const result = await client.callTool({ name: "achromat_recall", arguments: { domain: "fintech", tool_name: "dispatch_wire", task_description: TASK, arguments: { a: 1 } } });
      expect(result.isError, problem).toBe(true);
      expect(text(result), problem).toContain(`the key file is ${problem}`);
      expect(text(result), problem).toContain("Nothing was sent");
      expect(service.calls, problem).toHaveLength(0);
    }
  });

  it("explains a missing key file for calibrate in the tool result, sends nothing, and keeps the server alive", async () => {
    let present = false;
    const key = freshKey();
    const { client, service } = await connect({ respond: () => ({ status: 200, body: { success: true, verdict: "ALLOW" } }) }, () => {
      if (!present) throw new KeyFileError("NOT_FOUND", "No agent key found at /k.pem. Create and register one.");
      return loaded(key);
    });
    const args = { domain: "fintech", tool_name: "dispatch_wire", task_description: TASK, arguments: { a: 1 } };
    const first = await client.callTool({ name: "achromat_calibrate", arguments: args });
    expect(first.isError).toBe(true);
    expect(text(first)).toContain("No agent key found at /k.pem");
    expect(text(first)).toContain("Nothing was sent");
    expect(service.calls).toHaveLength(0); // calibrate is never sent unsigned
    present = true;
    await client.callTool({ name: "achromat_calibrate", arguments: args });
    expect(service.calls).toHaveLength(1);
    expect(service.calls[0]!.signed).toBe(true);
  });
});

describe("achromat_calibrate", () => {
  const args = { domain: "fintech", tool_name: "dispatch_wire", task_description: TASK, arguments: { amount_usd: 100 } };

  it("sends a signed POST /api/v1/calibrate and returns a BLOCK with its directive and trap_id", async () => {
    const { client, service } = await connect({
      respond: () => ({
        status: 200,
        body: { success: true, verdict: "BLOCK", steering_directive: "Add a second approver.", receipt_id: "r-1", receipt_verified: true, violations: [], trap: { recorded: true, trap_id: "11111111-1111-4111-8111-111111111111" } },
      }),
    });
    const result = await client.callTool({ name: "achromat_calibrate", arguments: args });
    expect(result.isError).toBe(false);
    expect(text(result)).toContain("VERDICT: BLOCK");
    expect(text(result)).toContain("Steering directive: Add a second approver.");
    expect(text(result)).toContain("Receipt: r-1 (verified)");
    expect(text(result)).toContain("trap_id: 11111111-1111-4111-8111-111111111111");
    expect(service.calls[0]!.url).toBe(`${BASE_URL}/api/v1/calibrate`);
    expect(JSON.parse(service.calls[0]!.body)).toEqual({ domain: "fintech", tool: "dispatch_wire", task_description: TASK, arguments: { amount_usd: 100 } });
  });

  it("sends the trap_id on a retry, and returns the ALLOW with its receipt", async () => {
    const trapId = "11111111-1111-4111-8111-111111111111";
    const { client, service } = await connect({
      respond: (seen) => ({
        status: 200,
        body: JSON.parse(seen.body).trap_id === trapId ? { success: true, verdict: "ALLOW", receipt_id: "r-2", receipt_verified: true, pairing: { paired: true, lesson_id: "L-9" } } : { success: true, verdict: "BLOCK" },
      }),
    });
    const result = await client.callTool({ name: "achromat_calibrate", arguments: { ...args, trap_id: trapId } });
    expect(text(result)).toContain("VERDICT: ALLOW");
    expect(text(result)).toContain("Receipt: r-2 (verified)");
    expect(text(result)).toContain("Lesson: L-9");
    expect(JSON.parse(service.calls[0]!.body).trap_id).toBe(trapId);
  });

  it("returns a 429 and a validation error as readable text", async () => {
    const limited = await connect({ respond: () => ({ status: 429, body: { success: false, code: "RATE_LIMITED" }, headers: { "Retry-After": "10" } }) });
    const a = await limited.client.callTool({ name: "achromat_calibrate", arguments: args });
    expect(a.isError).toBe(true);
    expect(text(a)).toContain("120 calibrations per hour");

    const invalid = await connect({ respond: () => ({ status: 400, body: { success: false, code: "INVALID_REQUEST", error: "bad", details: [{ path: "arguments", message: "contains a credential" }] } }) });
    const b = await invalid.client.callTool({ name: "achromat_calibrate", arguments: args });
    expect(b.isError).toBe(true);
    expect(text(b)).toContain("- arguments: contains a credential");
  });
});

describe("toRequestBody", () => {
  it("maps tool_name to tool and omits an absent trap_id", () => {
    const body = toRequestBody({ domain: "fintech", tool_name: "dispatch_wire", task_description: TASK, arguments: { a: 1 } });
    expect(body).toEqual({ domain: "fintech", tool: "dispatch_wire", task_description: TASK, arguments: { a: 1 } });
    expect(Object.keys(body)).not.toContain("trap_id");
  });

  it("schemas keep arguments required in both tools", () => {
    expect(recallInput.arguments.safeParse(undefined).success).toBe(false);
    expect(recallInput.arguments.safeParse({}).success).toBe(false);
    expect(recallInput.arguments.safeParse({ a: 1 }).success).toBe(true);
    expect(calibrateInput.arguments.safeParse(undefined).success).toBe(false);
  });
});

describe("the achromat_recall description tells the agent what has coverage", () => {
  it("lists every covered domain and tool name, so a host passes a name that can match", async () => {
    const { client } = await connect();
    const recall = (await client.listTools()).tools.find((tool) => tool.name === "achromat_recall")!;
    for (const [domain, tools] of Object.entries(COVERAGE)) {
      expect(recall.description, domain).toContain(domain);
      for (const tool of tools) expect(recall.description, `${domain}/${tool}`).toContain(tool);
      expect((DOMAINS as readonly string[]).includes(domain), `${domain} is a domain the tool accepts`).toBe(true);
    }
    expect(Object.keys(COVERAGE).sort()).toEqual(["devsecops", "fintech", "industrial_iot"]);
  });

  it("says matching is exact, names examples that have no lessons, and points robot commands at industrial_iot", async () => {
    const { client } = await connect();
    const recall = (await client.listTools()).tools.find((tool) => tool.name === "achromat_recall")!;
    expect(recall.description).toMatch(/exact on domain and tool_name/);
    expect(recall.description).toMatch(/bash, psql or postgres_query/);
    expect(recall.description).toMatch(/Use industrial_iot for robot and plant commands/);
    expect(recall.description).toMatch(/robotics domain has no lessons yet/);
    const toolName = (recall.inputSchema.properties as Record<string, { description: string }>).tool_name!.description;
    expect(toolName).toMatch(/exact on domain and tool name/);
  });

  it("says recall needs no identity, and that calibrate does", async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools;
    expect(tools.find((tool) => tool.name === "achromat_recall")!.description).toMatch(/needs no identity/);
    expect(tools.find((tool) => tool.name === "achromat_calibrate")!.description).toMatch(/needs a registered identity/);
  });

  it("keeps the full product name in the model-facing descriptions", async () => {
    const { client } = await connect();
    for (const tool of (await client.listTools()).tools) expect(tool.description ?? "", tool.name).not.toMatch(/Achromat MOM\b/);
    expect((await client.listTools()).tools.find((tool) => tool.name === "achromat_recall")!.description).toContain("Achromat Machine Operational Memory");
  });
});

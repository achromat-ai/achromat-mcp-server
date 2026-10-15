import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, describe, expect, it, vi } from "vitest";
import { MomClient } from "../src/client.js";
import { registerTools, type ToolDeps } from "../src/tools.js";
import { BASE_URL, fakeService } from "./helpers.js";
import { fakeRegistrar } from "./registration-helpers.js";

const root = mkdtempSync(join(tmpdir(), "achromat-gate-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;

const TASK = "Remit settlement funds to an overseas supplier for the outstanding parts invoice";
const text = (result: unknown) => ((result as { content: Array<{ text: string }> }).content ?? []).map((part) => part.text).join("\n");

/** The real server wiring, a real MCP client, a real key file location, and fake services for the network. */
async function boot(extra: Partial<ToolDeps> = {}, registrarOptions: Parameters<typeof fakeRegistrar>[0] = {}) {
  const keyFile = join(root, `case-${++counter}`, ".achromat", "achromat_agent_key.pem");
  const config = { baseUrl: BASE_URL, keyFile };
  const registrar = fakeRegistrar({ difficultyBits: 12, ...registrarOptions });
  const momService = fakeService({ respond: () => ({ status: 200, body: { success: true, match: false } }) });
  const momClient = new MomClient(config, { fetch: momService.fetch });
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const controller = registerTools(server, momClient, { config, registrationDeps: { fetch: registrar.fetch, threads: 1 }, ...extra });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "host", version: "0.0.0" });
  const changed = vi.fn();
  client.setNotificationHandler(ToolListChangedNotificationSchema, changed);
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const names = async () => (await client.listTools()).tools.map((tool) => tool.name).sort();
  return { client, server, controller, keyFile, registrar, momService, changed, names };
}

describe("which tools are offered", () => {
  it("offers only achromat_register_identity while there is no key file", async () => {
    const { names, controller } = await boot();
    expect(await names()).toEqual(["achromat_register_identity"]);
    expect(controller.active()).toEqual(["achromat_register_identity"]);
  });

  it("offers only recall and calibrate once a key file exists", async () => {
    const { names, controller } = await boot({ keyExists: () => true });
    expect(await names()).toEqual(["achromat_calibrate", "achromat_recall"]);
    expect(controller.active().sort()).toEqual(["achromat_calibrate", "achromat_recall"]);
  });

  it("refuses to run a tool that is not offered", async () => {
    const withoutKey = await boot();
    const recall = await withoutKey.client.callTool({ name: "achromat_recall", arguments: { domain: "fintech", tool_name: "dispatch_wire", task_description: TASK, arguments: { a: 1 } } }).catch((error: Error) => ({ isError: true, content: [{ text: error.message }] }));
    expect((recall as { isError?: boolean }).isError).toBe(true);
    expect(text(recall)).toMatch(/disabled/i);
    expect(withoutKey.momService.calls).toHaveLength(0);

    const withKey = await boot({ keyExists: () => true });
    const register = await withKey.client.callTool({ name: "achromat_register_identity", arguments: { user_confirmed: true } }).catch((error: Error) => ({ isError: true, content: [{ text: error.message }] }));
    expect(text(register)).toMatch(/disabled/i);
    expect(withKey.registrar.calls).toHaveLength(0);
  });

  it("follows the file when refresh() is called", async () => {
    let present = false;
    const { names, controller, changed } = await boot({ keyExists: () => present });
    expect(await names()).toEqual(["achromat_register_identity"]);
    present = true;
    controller.refresh();
    expect(await names()).toEqual(["achromat_calibrate", "achromat_recall"]);
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    present = false;
    controller.refresh();
    expect(await names()).toEqual(["achromat_register_identity"]);
    controller.refresh(); // idempotent
    expect(await names()).toEqual(["achromat_register_identity"]);
  });
});

describe("achromat_register_identity", () => {
  it("states that the user must be asked first, and what the tool does", async () => {
    const { client } = await boot();
    const tool = (await client.listTools()).tools.find((candidate) => candidate.name === "achromat_register_identity")!;
    expect(tool.description).toContain("ASK THE USER FIRST");
    expect(tool.description).toMatch(/private key/i);
    expect(tool.description).toMatch(/only the public half is sent/i);
    expect(tool.inputSchema.required).toEqual(["user_confirmed"]);
  });

  it("will not run without the user's confirmation", async () => {
    const { client, registrar, keyFile } = await boot();
    for (const args of [{}, { user_confirmed: false }, { user_confirmed: "yes" }]) {
      const result = await client.callTool({ name: "achromat_register_identity", arguments: args }).catch((error: Error) => ({ isError: true, content: [{ text: error.message }] }));
      expect((result as { isError?: boolean }).isError, JSON.stringify(args)).toBe(true);
    }
    expect(registrar.calls).toHaveLength(0);
    expect(existsSync(keyFile)).toBe(false);
  });

  it("registers, saves the key, and switches the host to recall and calibrate", async () => {
    const { client, names, keyFile, registrar, changed } = await boot();
    expect(await names()).toEqual(["achromat_register_identity"]);

    const result = await client.callTool({ name: "achromat_register_identity", arguments: { user_confirmed: true } });
    expect(result.isError).toBe(false);
    expect(text(result)).toContain("REGISTERED");
    expect(text(result)).toContain(`Key file: ${keyFile}`);
    expect(text(result)).toMatch(/Public key: [A-Za-z0-9_-]{43}/);
    expect(text(result)).toContain("never be shared");
    expect(text(result)).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    expect(existsSync(keyFile)).toBe(true);
    expect(registrar.keys.size).toBe(1);

    expect(await names()).toEqual(["achromat_calibrate", "achromat_recall"]);
    await vi.waitFor(() => expect(changed).toHaveBeenCalled()); // the host is told the list changed
  });

  it("makes the new key usable straight away, with no restart", async () => {
    const { client, momService, registrar } = await boot();
    await client.callTool({ name: "achromat_register_identity", arguments: { user_confirmed: true } });
    const [publicKey] = [...registrar.keys];
    const result = await client.callTool({ name: "achromat_recall", arguments: { domain: "fintech", tool_name: "dispatch_wire", task_description: TASK, arguments: { amount_usd: 1 } } });
    expect(result.isError).toBe(false);
    expect(text(result)).toContain("NO MATCH");
    expect(momService.calls[0]!.headers.get("Achromat-Agent-Key")).toBe(publicKey);
  });

  it("reports a failure, leaves the tool set alone, and can be tried again", async () => {
    const { client, names, keyFile } = await boot({}, { failChallengeWith: { status: 429, code: "RATE_LIMITED", headers: { "Retry-After": "20" } } });
    const result = await client.callTool({ name: "achromat_register_identity", arguments: { user_confirmed: true } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Wait 20 seconds");
    expect(text(result)).toContain("nothing was created");
    expect(existsSync(keyFile)).toBe(false);
    expect(await names()).toEqual(["achromat_register_identity"]);
  });

  it("runs only one registration when asked twice at once, and creates one identity", async () => {
    const { client, registrar, keyFile } = await boot();
    const call = () => client.callTool({ name: "achromat_register_identity", arguments: { user_confirmed: true } });
    const [a, b] = await Promise.all([call(), call()]);
    expect(a.isError).toBe(false);
    expect(b.isError).toBe(false);
    expect(registrar.keys.size).toBe(1);
    expect(registrar.calls.filter((entry) => entry.path.endsWith("/register"))).toHaveLength(1);
    const publicKeys = [text(a), text(b)].map((out) => /Public key: (\S+)/.exec(out)![1]);
    expect(publicKeys[0]).toBe(publicKeys[1]);
    expect(readFileSync(keyFile, "utf8")).toMatch(/BEGIN PRIVATE KEY/);
  });

  it("does not replace a key file that is already there, and switches to the working tools instead", async () => {
    const { client, names, keyFile, registrar } = await boot();
    await client.callTool({ name: "achromat_register_identity", arguments: { user_confirmed: true } });
    const before = readFileSync(keyFile, "utf8");
    // The tool is no longer offered, and the file is untouched whatever happens next.
    expect(await names()).toEqual(["achromat_calibrate", "achromat_recall"]);
    expect(registrar.keys.size).toBe(1);
    expect(readFileSync(keyFile, "utf8")).toBe(before);
  });
});

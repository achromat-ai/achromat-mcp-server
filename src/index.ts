#!/usr/bin/env node
/**
 * Achromat MCP server: lets any MCP host (Claude Desktop, an IDE, an agent framework) call Achromat MOM's
 * recall and calibrate endpoints as native tools. It runs locally as a child process of the host and speaks
 * MCP over stdio.
 *
 * stdout is the protocol channel. Nothing else may be written to it, so every log line goes to stderr.
 * The agent key is read on the first tool call, not at startup: a missing or unreadable key then comes back
 * as a tool result the agent can relay, instead of a dead process the host can only call "disconnected".
 */
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MomClient } from "./client.js";
import { loadConfig } from "./config.js";
import { registerTools } from "./tools.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

async function main(): Promise<void> {
  const config = loadConfig();
  const server = new McpServer({ name: "achromat-mcp-server", version });
  registerTools(server, new MomClient(config, { userAgent: `achromat-mcp-server/${version}` }));

  await server.connect(new StdioServerTransport());
  console.error(`achromat-mcp-server ${version} ready on stdio (service: ${config.baseUrl}, key: ${config.keyFile})`);
}

main().catch((error: unknown) => {
  console.error("achromat-mcp-server failed to start:", error instanceof Error ? error.message : error);
  process.exit(1);
});

/**
 * The two tools this server exposes to a host agent, and their input schemas.
 *
 *   achromat_recall     Turn 0: is there a verified compliant version of this call?   POST /api/v1/recall
 *   achromat_calibrate  Turn 1 / Turn 2: check the call against live policy.          POST /api/v1/calibrate
 *
 * Field names follow the host-facing convention (`tool_name`); the service's own field is `tool`, and
 * `toRequestBody` is the one place that maps between them.
 *
 * SCAFFOLD: the handlers validate input and say what they would send, but they do not send it. The signed
 * client (an Ed25519 key, the 7-part request string, a fresh nonce per call) is not written yet, so every
 * call returns an `isError` result with code NOT_IMPLEMENTED. Nothing here pretends to have succeeded.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Config } from "./config.js";

export const DOMAINS = ["fintech", "industrial_iot", "robotics", "devsecops"] as const;

// Limits the service enforces, repeated here so a bad call fails in the host's own tool UI and not after a round trip.
const TOOL_NAME = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/, "1 to 64 characters from A-Z a-z 0-9 _ . : / -, starting with a letter or digit")
  .describe("The exact name of the tool you are about to call, for example dispatch_wire.");

const TASK_DESCRIPTION = z
  .string()
  .min(16)
  .max(1000)
  .refine((value) => value.trim().split(/\s+/).length >= 3, "at least 3 words")
  .describe(
    "What you are trying to do, in plain words, as you would write a ticket title (16 to 1000 characters). Name the concrete action and object. Leave out amounts, identifiers, dates and personal data. Use the same wording for the same task every time.",
  );

const DOMAIN = z.enum(DOMAINS).describe("The area the tool call belongs to.");

const ARGUMENTS = z
  .record(z.string(), z.unknown())
  .describe("The arguments of the tool call, as a JSON object. Never put secrets or credentials in it.");

export const recallInput = {
  domain: DOMAIN,
  tool_name: TOOL_NAME,
  task_description: TASK_DESCRIPTION,
  arguments: ARGUMENTS.optional().describe(
    "The arguments you intend to send to the tool. Optional here, but pass them: the service matches on the names of their keys (never the values), and it requires an arguments object on every recall.",
  ),
};

export const calibrateInput = {
  domain: DOMAIN,
  tool_name: TOOL_NAME,
  task_description: TASK_DESCRIPTION.describe(
    "What you are trying to do. Use exactly the same wording on the first attempt and on the retry: it is what pairs a blocked call with its fix.",
  ),
  arguments: ARGUMENTS.refine((value) => Object.keys(value).length > 0, "arguments must not be empty").describe(
    "The arguments of the tool call you want checked. A non-empty JSON object. Never put secrets or credentials in it.",
  ),
  trap_id: z
    .string()
    .uuid()
    .optional()
    .describe("Only on a retry: the trap_id the earlier BLOCK answer gave you. Send the corrected arguments with it."),
};

type RecallArgs = z.infer<z.ZodObject<typeof recallInput>>;
type CalibrateArgs = z.infer<z.ZodObject<typeof calibrateInput>>;

/** The request the service expects: `tool_name` becomes `tool`, and absent optional fields are left out. */
export function toRequestBody(input: RecallArgs | CalibrateArgs): Record<string, unknown> {
  const { tool_name, ...rest } = input;
  return Object.fromEntries(Object.entries({ domain: rest.domain, tool: tool_name, task_description: rest.task_description, arguments: rest.arguments, trap_id: "trap_id" in rest ? rest.trap_id : undefined }).filter(([, value]) => value !== undefined));
}

function notImplemented(path: string, input: RecallArgs | CalibrateArgs, config: Config): CallToolResult {
  const body = {
    error: "NOT_IMPLEMENTED",
    message: "This build of the Achromat MCP server validates the call but cannot send it yet: request signing is not implemented. Nothing was sent to the service and no verdict was produced.",
    wouldSend: { method: "POST", url: `${config.baseUrl}${path}`, body: toRequestBody(input) },
  };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
}

export function registerTools(server: McpServer, config: Config): void {
  server.registerTool(
    "achromat_recall",
    {
      title: "Recall a verified compliant tool call",
      description:
        "Call this BEFORE you run a tool that policy might block (payments, credit decisions, robot or plant commands, shell, SQL, web requests). It asks Achromat MOM whether a verified compliant version of this call already exists. On a match you receive compliant_arguments, a steering_directive and the rule that applied: use the whole compliant_arguments object as your template, keep any [VERIFIED_STATE] placeholders exactly as written, and change only your own operational values (amounts, routing numbers, file paths). On no match, continue with achromat_calibrate.",
      inputSchema: recallInput,
      annotations: { title: "Recall a verified compliant tool call", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (input) => notImplemented("/api/v1/recall", input, config),
  );

  server.registerTool(
    "achromat_calibrate",
    {
      title: "Check a tool call against live policy",
      description:
        "Use this when achromat_recall found nothing, or when the stakes are high. It evaluates your candidate tool call against live policy and returns a verdict. BLOCK comes with a steering_directive and a trap_id: change the arguments as the directive says, then call this tool again with the same task_description and the trap_id. ALLOW means the call complies. A BLOCK followed by an ALLOW is recorded as a lesson for other agents. Do not invent signatures, approvals or names to get an ALLOW; if the directive needs evidence you do not have, stop.",
      inputSchema: calibrateInput,
      annotations: { title: "Check a tool call against live policy", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (input) => notImplemented("/api/v1/calibrate", input, config),
  );
}

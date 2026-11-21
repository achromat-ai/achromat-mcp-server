/**
 * The tools this server exposes to a host agent, and their input schemas.
 *
 *   achromat_register_identity  Create and register this machine's key (only while there is no key file).
 *   achromat_recall             Turn 0: is there a verified compliant version of this call?   POST /api/v1/recall
 *   achromat_calibrate          Turn 1 / Turn 2: check the call against live policy.          POST /api/v1/calibrate
 *
 * achromat_recall is offered from startup, with or without a key file. Without one it sends no signature and the
 * service answers it as an anonymous caller (public approved lessons only); with one it signs, as before. The other two
 * tools follow the key file: without it achromat_register_identity is listed, and achromat_calibrate (which the service
 * only answers when signed) is not; with it the reverse. The switch happens at startup and again right after a
 * registration, and the SDK tells the host when the list changes.
 *
 * Field names follow the host-facing convention (`tool_name`); the service's own field is `tool`, and
 * `toRequestBody` is the one place that maps between them. Both tools require `arguments`, as the service does.
 */
import { existsSync } from "node:fs";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { MomClient } from "./client.js";
import type { Config } from "./config.js";
import { formatCalibrate, formatRecall, formatRegistration } from "./format.js";
import { registerIdentity, type RegistrationDeps, type RegistrationOutcome } from "./registration.js";

export const DOMAINS = ["fintech", "industrial_iot", "devsecops", "contractual_eligibility", "compliance_provenance"] as const;

/**
 * The (domain, tool) pairs the service holds public approved lessons for, as of 2026-11-21. Recall matches the domain and
 * the tool name exactly, so a name outside this list always comes back with no match. Written into the tool description
 * so that a host's agent passes a name that can match. A snapshot, not an API: the service may cover more tomorrow, and a
 * tool missing here is only a reason to expect no match, never a reason to refuse the call.
 */
export const COVERAGE: Readonly<Record<string, readonly string[]>> = {
  fintech: ["dispatch_wire", "issue_credit_adverse_action", "commit_corporate_spend", "approve_expenditure", "release_payment"],
  industrial_iot: ["dispatch_manipulation", "mutate_safety_parameter", "adjust_plc_setpoint"],
  devsecops: ["execute_command", "run_sql_statement", "http_request", "run_pipeline_job", "read_file", "monitor_logs", "modify_iam_policy", "process_retrieved_content"],
  contractual_eligibility: ["approve_eligibility_claim", "confirm_eligibility", "bind_contract_terms"],
  compliance_provenance: ["submit_regulated_record", "submit_filing", "release_report"],
};

const COVERAGE_TEXT = Object.entries(COVERAGE)
  .map(([domain, tools]) => `${domain}: ${tools.join(", ")}`)
  .join("; ");

// Limits the service enforces, repeated here so a bad call fails in the host's own tool UI and not after a round trip.
const TOOL_NAME = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/, "1 to 64 characters from A-Z a-z 0-9 _ . : / -, starting with a letter or digit")
  .describe(
    "The exact name of the tool you are about to call, for example dispatch_wire. Matching is exact on domain and tool name; lessons exist only for the names listed in the achromat_recall description, and any other name returns no match.",
  );

const TASK_DESCRIPTION = z
  .string()
  .min(16)
  .max(1000)
  .refine((value) => value.trim().split(/\s+/).length >= 3, "at least 3 words")
  .describe(
    "What you are trying to do, in plain words, as you would write a ticket title (16 to 1000 characters). Name the concrete action and object. Leave out amounts, identifiers, dates and personal data. Use the same wording for the same task every time.",
  );

const DOMAIN = z.enum(DOMAINS).describe("The area the tool call belongs to.");

const nonEmpty = (value: Record<string, unknown>) => Object.keys(value).length > 0;

export const recallInput = {
  domain: DOMAIN,
  tool_name: TOOL_NAME,
  task_description: TASK_DESCRIPTION,
  arguments: z
    .record(z.string(), z.unknown())
    .refine(nonEmpty, "arguments must not be empty")
    .describe(
      "REQUIRED. The arguments you intend to send to the tool, as a non-empty JSON object, using the key names the tool really uses. Only the names of the keys (and their nesting) are used for semantic matching, never the values, so the real key names make a recall find the right lesson; an invented or generic shape finds the wrong one or none. Never put secrets or credentials in it.",
    ),
};

export const calibrateInput = {
  domain: DOMAIN,
  tool_name: TOOL_NAME,
  task_description: TASK_DESCRIPTION.describe(
    "What you are trying to do. Use exactly the same wording on the first attempt and on the retry: it is what pairs a blocked call with its fix.",
  ),
  arguments: z
    .record(z.string(), z.unknown())
    .refine(nonEmpty, "arguments must not be empty")
    .describe("The arguments of the tool call you want checked. A non-empty JSON object. Never put secrets or credentials in it."),
  trap_id: z
    .string()
    .uuid()
    .optional()
    .describe("Only on a retry: the trap_id the earlier BLOCK answer gave you. Send the corrected arguments with it."),
};

type RecallArgs = z.infer<z.ZodObject<typeof recallInput>>;
type CalibrateArgs = z.infer<z.ZodObject<typeof calibrateInput>>;

/** The request the service expects: `tool_name` becomes `tool`, and an absent trap_id is left out. */
export function toRequestBody(input: RecallArgs | CalibrateArgs): Record<string, unknown> {
  const body: Record<string, unknown> = {
    domain: input.domain,
    tool: input.tool_name,
    task_description: input.task_description,
    arguments: input.arguments,
  };
  if ("trap_id" in input && input.trap_id !== undefined) body.trap_id = input.trap_id;
  return body;
}

/** Signed if a key file exists, and unsigned if there is none: recall needs no identity. */
export async function recall(client: MomClient, input: RecallArgs): Promise<CallToolResult> {
  return formatRecall(await client.postOptionallySigned("/api/v1/recall", toRequestBody(input)));
}

export async function calibrate(client: MomClient, input: CalibrateArgs): Promise<CallToolResult> {
  return formatCalibrate(await client.post("/api/v1/calibrate", toRequestBody(input)));
}

export const registerInput = {
  user_confirmed: z
    .literal(true)
    .describe("Set to true ONLY after the user has said yes to creating an identity. If they have not been asked, ask first and do not call this tool."),
};

export interface ToolDeps {
  config: Config;
  /** Whether a key file is in place. Defaults to checking the configured path. */
  keyExists?: () => boolean;
  /** Creates and registers an identity. Defaults to the real one. */
  register?: (config: Config, deps: RegistrationDeps) => Promise<RegistrationOutcome>;
  registrationDeps?: RegistrationDeps;
}

export interface ToolController {
  /** Re-reads whether the key file exists and switches the tool set to match. Safe to call at any time. */
  refresh(): void;
  /** The tools the host should currently see, by name. */
  active(): string[];
}

export function registerTools(server: McpServer, client: MomClient, deps: ToolDeps): ToolController {
  const keyExists = deps.keyExists ?? (() => existsSync(deps.config.keyFile));
  const register = deps.register ?? registerIdentity;

  const recallTool: RegisteredTool = server.registerTool(
    "achromat_recall",
    {
      title: "Recall a verified compliant tool call",
      description:
        `Call this BEFORE you run a tool that policy might block (payments, corporate spend, credit decisions, claim and contract decisions, regulated filings, robot or plant commands, shell, SQL, web requests). It asks Achromat Machine Operational Memory whether a verified compliant version of this call already exists. It works immediately and needs no identity: without one it searches the public, approved lessons; once the user has registered an identity it also finds the user's own pending lessons. Pass the arguments you intend to send: the names of their keys (not the values) are what the semantic match uses. On a match you receive compliant_arguments, a steering_directive and the statutory anchor: use the whole compliant_arguments object as your template, keep any [VERIFIED_STATE] placeholders exactly as written, and change only your own operational values (amounts, routing numbers, file paths).\n\nCOVERAGE. Matching is exact on domain and tool_name. Lessons exist for these tool names, by domain: ${COVERAGE_TEXT}. Use industrial_iot for robot and plant commands. A tool name that is not listed, such as bash, psql or postgres_query, returns no match because nothing was recorded for it, so use the listed name only when it really is the tool you are about to call. On no match, continue with achromat_calibrate if it is available, or proceed under your own checks.`,
      inputSchema: recallInput,
      annotations: { title: "Recall a verified compliant tool call", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (input) => recall(client, input),
  );

  const calibrateTool: RegisteredTool = server.registerTool(
    "achromat_calibrate",
    {
      title: "Check a tool call against live policy",
      description:
        "Use this when achromat_recall found nothing, or when the stakes are high. It needs a registered identity, which is why it only appears after achromat_register_identity. It evaluates your candidate tool call against live policy and returns a verdict. BLOCK comes with a steering_directive and a trap_id: change the arguments as the directive says, then call this tool again with the same task_description and the trap_id. ALLOW means the call complies. A BLOCK followed by an ALLOW is recorded as a lesson for other agents. Do not invent signatures, approvals or names to get an ALLOW; if the directive needs evidence you do not have, stop.",
      inputSchema: calibrateInput,
      annotations: { title: "Check a tool call against live policy", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (input) => calibrate(client, input),
  );

  // One registration at a time: a second call while one is running gets the same answer, not a second identity.
  let inFlight: Promise<RegistrationOutcome> | null = null;

  const registerTool: RegisteredTool = server.registerTool(
    "achromat_register_identity",
    {
      title: "Create and register an Achromat identity",
      description:
        "achromat_recall already works without an identity. An identity is needed only for achromat_calibrate (checking a call against live policy, which is how new lessons are made) and to see the user's own pending lessons. This tool creates one: it generates an Ed25519 key pair, completes a short proof of work (about a second), registers the public key with Achromat Machine Operational Memory, and saves the private key to a file that only this user can read. ASK THE USER FIRST and wait for a yes, because it writes a private key file on their machine and creates an identity on the service. Explain that the key never leaves the machine, that only the public half is sent, and that the file cannot be recovered if lost. Then call this tool with user_confirmed set to true. Afterwards achromat_calibrate becomes available and achromat_recall signs its requests.",
      inputSchema: registerInput,
      annotations: { title: "Create and register an Achromat identity", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (_input, extra) => {
      inFlight ??= register(deps.config, { ...deps.registrationDeps, signal: extra.signal }).finally(() => {
        inFlight = null;
      });
      const outcome = await inFlight;
      controller.refresh(); // a new key file (or one found in place) changes which tools make sense
      return formatRegistration(outcome);
    },
  );

  const controller: ToolController = {
    refresh() {
      const haveKey = keyExists();
      // Recall is always on: it needs no key. Calibrate needs one; registering is only for a machine that has none.
      if (!recallTool.enabled) recallTool.enable();
      if (calibrateTool.enabled !== haveKey) (haveKey ? calibrateTool.enable() : calibrateTool.disable());
      if (registerTool.enabled === haveKey) (haveKey ? registerTool.disable() : registerTool.enable());
    },
    active() {
      return [
        ...(registerTool.enabled ? ["achromat_register_identity"] : []),
        ...(recallTool.enabled ? ["achromat_recall"] : []),
        ...(calibrateTool.enabled ? ["achromat_calibrate"] : []),
      ];
    },
  };
  controller.refresh();
  return controller;
}

# Achromat MCP server

An [MCP](https://modelcontextprotocol.io) server that lets any MCP host (Claude Desktop, an IDE, an agent framework) use [Achromat Machine Operational Memory (MOM)](https://achromat.ai) as native tools. MOM keeps verified memory of tool calls that policy blocked and the corrected calls that were then allowed. With this server your agent can ask for the compliant version of a call **before** it acts, and check a call against live policy, without you writing any integration code.

The server runs on your machine as a child process of the host and talks to it over stdio. **`achromat_recall` works straight away, with no setup and no identity**: it searches the public, approved lessons. Everything that writes, `achromat_calibrate`, needs an identity: the server signs those requests with an Ed25519 key that stays on your machine, so only signatures leave it, never the key.

## Add it to Claude Desktop

Open the configuration file:

| OS | Path |
| --- | --- |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

Add the server under `mcpServers`, then restart Claude Desktop:

```json
{
  "mcpServers": {
    "achromat": {
      "command": "npx",
      "args": ["-y", "@achromat-ai/mcp-server"]
    }
  }
}
```

That is the whole setup. Requires Node.js 20 or newer; `-y` lets `npx` install the package without asking. Other MCP hosts take the same command and arguments in their own configuration.

## When you need an identity

`achromat_recall` needs no key. `achromat_calibrate` (checking a call against live policy, which is also how new lessons are made) does, and so does seeing your own not-yet-published lessons. You do not create or register a key yourself. While there is no key file the server offers `achromat_recall` and `achromat_register_identity`, and your agent will **ask you** before it uses the second. If you say yes, the server:

1. generates an Ed25519 key pair on your machine,
2. does a short proof of work (about a second; it is how MOM limits automated sign-ups),
3. registers the **public** key with MOM, and
4. saves the **private** key to `~/.achromat/achromat_agent_key.pem`, readable only by you.

Then `achromat_calibrate` appears in place of the registration tool, and `achromat_recall` starts signing its requests. If your host does not refresh its tool list by itself, restart it once.

What leaves your machine: the public key, the proof of work, and a signature proving you hold the private key. The private key never does. MOM keeps a record of the registration and limits it to 10 a day per network.

**The key file is the identity.** Keep it private, out of git and out of screenshots, and back it up: it cannot be recovered if you lose it. The server never overwrites an existing key file, and it only saves the file once MOM has accepted the key, so a failed attempt leaves nothing behind.

## Choosing where the key lives

By default the key is at `~/.achromat/achromat_agent_key.pem`. To use another path, set `ACHROMAT_AGENT_KEY_FILE` in the host configuration. This works for a new key (the server creates it there) and for one you already have:

```json
{
  "mcpServers": {
    "achromat": {
      "command": "npx",
      "args": ["-y", "@achromat-ai/mcp-server"],
      "env": {
        "ACHROMAT_AGENT_KEY_FILE": "/Users/you/keys/achromat_agent_key.pem"
      }
    }
  }
}
```

On Windows use the full path with escaped backslashes, for example `"C:\\Users\\you\\keys\\achromat_agent_key.pem"`. A leading `~` is expanded by the server. A desktop app may start the server with a different home directory than your terminal has, so spelling the path out removes any doubt.

An existing key must be an unencrypted PKCS#8 Ed25519 PEM file that MOM already knows.

## Attributing an install to a link (optional)

If you share a link or a setup snippet and want to know which one brought an install, add an `ACHROMAT_REF` tag to the host configuration. It is a short label of 1 to 32 characters from `a-z`, `0-9`, `_` and `-`, for example `launch-post`:

```json
{
  "mcpServers": {
    "achromat": {
      "command": "npx",
      "args": ["-y", "@achromat-ai/mcp-server"],
      "env": { "ACHROMAT_REF": "launch-post" }
    }
  }
}
```

The tag is sent as `?ref=launch-post` on the two registration calls, and on a recall made without an identity (so the service can tell which link brought the install), and nowhere else. It is the label itself and nothing about you or your machine. A tag that does not fit the rule is ignored; it never stops a registration or a recall.

## Run from source

```bash
git clone https://github.com/achromat-ai/achromat-mcp-server.git
cd achromat-mcp-server
npm install
npm run build
```

Point the host at the build instead of `npx`:

```json
{
  "mcpServers": {
    "achromat": {
      "command": "node",
      "args": ["/absolute/path/to/achromat-mcp-server/dist/index.js"]
    }
  }
}
```

To try the tools in a browser without a host, use the MCP Inspector:

```bash
npm run inspect
```

## Tools

### `achromat_register_identity`

Offered only while there is no key file. Creates and registers an identity as described above. Recall does not need it. It requires `user_confirmed: true`, which the agent may set only after you have agreed; the tool description tells it to ask first.

| Parameter | Required | Description |
| --- | --- | --- |
| `user_confirmed` | yes | Must be `true`, and only after the user has said yes. |

### `achromat_recall`

Call this **before** running a tool that policy might block (payments, corporate spend, credit decisions, claim and contract decisions, regulated filings, robot or plant commands, shell, SQL, web requests). It asks whether a verified compliant version of the call already exists. On a match you get `compliant_arguments`, a `steering_directive` and the statutory anchor. Use the whole `compliant_arguments` object as your template, keep any `[VERIFIED_STATE]` placeholders exactly as written, and change only your own operational values.

**With or without an identity.** Without a key file the request is sent unsigned and the service answers it as an anonymous caller: only public, approved lessons, no receipts, and at most 30 requests a minute per network. With a key file the request is signed, and it also finds your own pending lessons. A key file that exists but cannot be used is reported as an error; the server never falls back to an unsigned request because of a broken key.

**Coverage.** Matching is exact on `domain` and `tool_name`. Lessons exist for: `fintech`: `dispatch_wire`, `issue_credit_adverse_action`, `commit_corporate_spend`, `approve_expenditure`, `release_payment`; `industrial_iot`: `dispatch_manipulation`, `mutate_safety_parameter`, `adjust_plc_setpoint`; `devsecops`: `execute_command`, `run_sql_statement`, `http_request`, `run_pipeline_job`, `read_file`, `monitor_logs`, `modify_iam_policy`, `process_retrieved_content`; `contractual_eligibility`: `approve_eligibility_claim`, `confirm_eligibility`, `bind_contract_terms`; `compliance_provenance`: `submit_regulated_record`, `submit_filing`, `release_report`. Use `industrial_iot` for robot and plant commands. Any other tool name, such as `bash` or `postgres_query`, returns no match. The same list is in the tool description, so your agent passes a name that can match.

When the lesson is an approved one, the answer ends with a **citation line**: `Tool arguments follow a verified Achromat MOM lesson: https://achromat.ai/?ref=audit#lesson-<id>`. The agent is told to add it to text a person reads (its final answer, a pull request description, a commit message), never to the tool's arguments, and to skip it if you ask for no attribution. The link opens that lesson on the Achromat site. A lesson that is only your own, not yet shared, gets no citation.

| Parameter | Required | Description |
| --- | --- | --- |
| `domain` | yes | `fintech`, `industrial_iot`, `devsecops`, `contractual_eligibility` or `compliance_provenance`. |
| `tool_name` | yes | The exact name of the tool you are about to call. |
| `task_description` | yes | What you are trying to do, in plain words (16 to 1000 characters, at least 3 words). No amounts, identifiers or personal data. |
| `arguments` | **yes** | The arguments you intend to send, as a non-empty JSON object using the tool's real key names. **Only the names of the keys (and their nesting) are used for semantic matching, never the values**, so real key names find the right lesson and an invented shape finds the wrong one or none. |

### `achromat_calibrate`

Call this when recall found nothing, or when the stakes are high. It evaluates the call against live policy and returns the verdict, the steering directive and the receipt id. A `BLOCK` comes with a `trap_id`: fix the arguments as the directive says and call the tool again with the **same** `task_description` and the `trap_id`. An `ALLOW` means the call complies. A block followed by an allow becomes a lesson for other agents.

| Parameter | Required | Description |
| --- | --- | --- |
| `domain` | yes | As above. |
| `tool_name` | yes | As above. |
| `task_description` | yes | Use exactly the same wording on the retry: it is what pairs a block with its fix. |
| `arguments` | yes | The arguments of the call to check. A non-empty JSON object. |
| `trap_id` | no | Only on a retry: the `trap_id` from the earlier `BLOCK`. |

Never put secrets or credentials in `arguments` or `task_description`; the service rejects them.

The tools use the name `tool_name`; the service's own field is `tool`, and the server maps between them.

Lesson text (rules, directives, arguments) comes from the community. The server labels it as data in every answer, and your agent should use it only to choose parameter values.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ACHROMAT_AGENT_KEY_FILE` | `~/.achromat/achromat_agent_key.pem` | Where the agent's Ed25519 private key is, or will be created. |
| `ACHROMAT_BASE_URL` | `https://achromat.ai` | The service origin. Must be `https` (plain `http` only for `localhost`). |
| `ACHROMAT_REF` | none | Optional attribution tag (see above), sent while registering and on a recall made without an identity. An invalid tag is ignored. |

`achromat_recall` is always offered. Whether the key file exists decides whether `achromat_calibrate` or `achromat_register_identity` is offered with it, and it is checked at startup and right after a registration. If you delete, move or replace the key file while the host is running, restart the host. The key itself is read on the first tool call, so a wrong key never makes the server disappear from your host: the tool call returns a message saying what to fix.

## When something goes wrong

Every failure comes back to the agent as a readable tool result, with the next step.

| What you see | Cause and fix |
| --- | --- |
| `achromat_calibrate` is not listed | There is no key file yet, which is normal: recall works without one. Say yes when your agent asks to create an identity if you want to check calls against live policy. |
| `A key file already exists at …` | An identity is already set up there. To start over, move or delete the file and restart the host. |
| `The key could not be saved at …` | The folder is not writable. Fix its permissions or set `ACHROMAT_AGENT_KEY_FILE`. Nothing was registered. |
| `Too many registration requests` / `registration limit` | MOM limits sign-ups per network (10 a day). Wait, or try from another network. Nothing was created. |
| `Could not reach …` / `No answer from …` | A network problem. Nothing was created; try again. |
| `The identity was registered, but the key file could not be moved …` | Rare. The message gives the path where the key was saved; move it to the path you want. Do not delete it. |
| `The key file is passphrase-protected` / `…holds a rsa key` | An existing key must be unencrypted PKCS#8 Ed25519. |
| `The key file … is accessible to other users` (in the host's server log) | Run `chmod 600` on the key file. It still works until you do. |
| `AGENT_KEY_UNKNOWN` (401) | A key file exists but MOM does not know it. Move or delete the file and restart the host to create a new identity. |
| `AGENT_KEY_INACTIVE` (403) | The key was revoked or rotated. Move or delete the file and restart the host. |
| `AGENT_SIGNATURE_EXPIRED` (401) | Your clock is more than 60 seconds off. The server corrects for this by itself using the service's clock; if it still fails, check your system time. |
| `Rate limited` (429) | Recall with a key allows 240 an hour and 50 distinct lessons a day; recall without one allows 30 a minute per network; calibrate allows 120 an hour. Wait for the time given. |
| `HTTP 400 INVALID_REQUEST` | The service lists the offending fields. Often a credential or personal data in the text or arguments. |

Server logs go to stderr, which hosts write to their own MCP log files (Claude Desktop keeps them in its logs folder; on macOS that is under `~/Library/Logs/Claude/`). The server never logs keys, signatures or request contents.

If the host cannot start `npx`, it may not see the `PATH` your terminal does (common with `nvm`). Put the absolute path of `npx` or `node` in `command`.

## Development

```bash
npm run typecheck   # source and tests
npm test            # vitest
npm run build       # compile to dist/ and mark dist/index.js executable
npm start           # run the built server on stdio (waits for a host)
```

stdout is the protocol channel, so the server writes nothing else to it.

The signing and registration code follows the byte-level contract in the [agent protocol](https://achromat.ai/skill.md) (sections 2 and 3), and the tests reproduce its published self-check vectors exactly: the request signature, and the proof-of-work nonce. Ed25519 is deterministic, so a change that alters a single byte of what is signed fails them.

The proof of work searches on several worker threads (up to 8, never all cores) so that it takes about a second and the server stays responsive while it runs.

## Licence

[MIT](LICENSE)

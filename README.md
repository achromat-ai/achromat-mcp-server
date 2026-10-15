# Achromat MCP server

An [MCP](https://modelcontextprotocol.io) server that lets any MCP host (Claude Desktop, an IDE, an agent framework) use [Achromat MOM](https://mom.achromat.ai) as native tools. MOM keeps verified memory of tool calls that policy blocked and the corrected calls that were then allowed. With this server, your agent can ask for the compliant version of a call **before** it acts, and check a call against live policy, without you writing any integration code.

The server runs on your machine as a child process of the host and talks to it over stdio.

> **Status: scaffold.** The server starts, lists its two tools and validates their input. It does **not** call the service yet: request signing is not written, so every tool call returns an `isError` result with code `NOT_IMPLEMENTED` that shows what would have been sent. Nothing leaves your machine, and no verdict is ever faked.
>
> **Not published to npm yet.** The `npx` command below will work once `@achromat-ai/mcp-server` is published. Until then, run it from a local build (see [Run from source](#run-from-source)).

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

Requires Node.js 20 or newer. `-y` lets `npx` install the package without asking.

Other MCP hosts take the same command and arguments in their own configuration.

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

### `achromat_recall`

Call this **before** running a tool that policy might block (payments, credit decisions, robot or plant commands, shell, SQL, web requests). It asks whether a verified compliant version of the call already exists. On a match you get `compliant_arguments`, a `steering_directive` and the rule that applied. Use the whole `compliant_arguments` object as your template, keep any `[VERIFIED_STATE]` placeholders exactly as written, and change only your own operational values.

| Parameter | Required | Description |
| --- | --- | --- |
| `domain` | yes | `fintech`, `industrial_iot`, `robotics` or `devsecops`. |
| `tool_name` | yes | The exact name of the tool you are about to call. |
| `task_description` | yes | What you are trying to do, in plain words (16 to 1000 characters, at least 3 words). No amounts, identifiers or personal data. |
| `arguments` | no | The arguments you intend to send. Optional here, but pass them: the service matches on the *names* of the keys, never the values, and it requires an arguments object on every recall. |

### `achromat_calibrate`

Call this when recall found nothing, or when the stakes are high. It evaluates the call against live policy. A `BLOCK` comes with a `steering_directive` and a `trap_id`: fix the arguments as the directive says and call the tool again with the **same** `task_description` and the `trap_id`. An `ALLOW` means the call complies. A block followed by an allow becomes a lesson for other agents.

| Parameter | Required | Description |
| --- | --- | --- |
| `domain` | yes | As above. |
| `tool_name` | yes | As above. |
| `task_description` | yes | Use exactly the same wording on the retry: it is what pairs a block with its fix. |
| `arguments` | yes | The arguments of the call to check. A non-empty JSON object. |
| `trap_id` | no | Only on a retry: the `trap_id` from the earlier `BLOCK`. |

Never put secrets or credentials in `arguments` or `task_description`; the service rejects them.

The tools use the name `tool_name`; the service's own field is `tool`, and the server maps between them.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ACHROMAT_BASE_URL` | `https://mom.achromat.ai` | The service origin. Must be `https` (plain `http` only for `localhost`). |
| `ACHROMAT_KEY_FILE` | unset | Path to your agent's Ed25519 private key (PEM). Read once signing is implemented. |

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run build       # compile to dist/
npm start           # run the built server on stdio (waits for a host)
```

stdout is the protocol channel, so the server writes nothing else to it. Logs go to stderr.

### What is missing

- **The signed client.** Every request to the service carries an Ed25519 signature over a canonical string (method, path, body hash, timestamp, nonce). The exact byte-level contract is in the [agent protocol](https://mom.achromat.ai/skill.md), sections 2 and 3.
- **Identity.** A key has to be registered once (a small proof of work and a proof-of-possession signature) and stored safely on disk.
- **Result handling.** Turning the service's answers into tool results, including the rate-limit and error cases.
- **Tests.**

## Licence

Not yet chosen.

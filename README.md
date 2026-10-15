# Achromat MCP server

An [MCP](https://modelcontextprotocol.io) server that lets any MCP host (Claude Desktop, an IDE, an agent framework) use [Achromat MOM](https://mom.achromat.ai) as native tools. MOM keeps verified memory of tool calls that policy blocked and the corrected calls that were then allowed. With this server your agent can ask for the compliant version of a call **before** it acts, and check a call against live policy, without you writing any integration code.

The server runs on your machine as a child process of the host and talks to it over stdio. It signs every request to MOM with an Ed25519 key that stays on your machine: only signatures leave it, never the key.

> **Until the first release is published to npm,** the `npx` command below will not find the package. Use [Run from source](#run-from-source) instead.

## Before you start: create and register a key

Every request is signed, so the server needs an Ed25519 key that MOM knows. You do this once.

1. Open the agent protocol at <https://mom.achromat.ai/skill.md> and copy the Python program in **section 2.4** into a file called `register.py`.
2. Run it from the directory that will hold your key:

   ```bash
   mkdir -p ~/.achromat
   cd ~/.achromat
   pip install cryptography requests
   python3 /path/to/register.py
   ```

   It solves a short proof of work, registers the public key, and writes the private key to `achromat_agent_key.pem` (mode `0600`) in the current directory. That is exactly the default location this server looks in: `~/.achromat/achromat_agent_key.pem`.
3. Keep the file private and out of version control. Anyone who holds it can act as your agent.

Registration is limited to 10 a day per network, and the challenge and the registration must come from the same network.

## Add it to Claude Desktop

Open the configuration file:

| OS | Path |
| --- | --- |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

Add the server under `mcpServers`, **including the path to your key in `env`**, then restart Claude Desktop:

```json
{
  "mcpServers": {
    "achromat": {
      "command": "npx",
      "args": ["-y", "@achromat-ai/mcp-server"],
      "env": {
        "ACHROMAT_AGENT_KEY_FILE": "/Users/you/.achromat/achromat_agent_key.pem"
      }
    }
  }
}
```

On Windows use the full path with escaped backslashes, for example `"C:\\Users\\you\\.achromat\\achromat_agent_key.pem"`.

`ACHROMAT_AGENT_KEY_FILE` is optional if your key is at the default `~/.achromat/achromat_agent_key.pem`, but a desktop app may start the server with a different environment or home directory than your terminal has, so spelling the path out removes any doubt. A leading `~` is expanded by the server. Other MCP hosts take the same command, arguments and environment in their own configuration.

Requires Node.js 20 or newer. `-y` lets `npx` install the package without asking.

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
      "args": ["/absolute/path/to/achromat-mcp-server/dist/index.js"],
      "env": {
        "ACHROMAT_AGENT_KEY_FILE": "/Users/you/.achromat/achromat_agent_key.pem"
      }
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
| `ACHROMAT_AGENT_KEY_FILE` | `~/.achromat/achromat_agent_key.pem` | Path to your agent's Ed25519 private key: an unencrypted PKCS#8 PEM file. |
| `ACHROMAT_BASE_URL` | `https://mom.achromat.ai` | The service origin. Must be `https` (plain `http` only for `localhost`). |

The key is read on the first tool call, not at startup, so a missing or wrong key never makes the server disappear from your host. The tool call returns a message saying what to fix, and the next call picks up the corrected file without a restart.

## When something goes wrong

Every failure comes back to the agent as a readable tool result, with the next step.

| What you see | Cause and fix |
| --- | --- |
| `No agent key found at …` | The file is not where the server looked. Create and register a key (above), or set `ACHROMAT_AGENT_KEY_FILE`. |
| `The key file is passphrase-protected` / `…is not a readable PEM private key` / `…holds a rsa key` | The server needs an unencrypted PKCS#8 **Ed25519** key. |
| `The key file … is accessible to other users` (in the host's server log) | Run `chmod 600` on the key file. It still works until you do. |
| `AGENT_KEY_UNKNOWN` (401) | The key is not registered. Register it (above). |
| `AGENT_KEY_INACTIVE` (403) | The key was revoked or rotated. Register a new one. |
| `AGENT_SIGNATURE_EXPIRED` (401) | Your clock is more than 60 seconds off. The server corrects for this by itself using the service's clock; if it still fails, check your system time. |
| `Rate limited` (429) | Recall allows 240 an hour per key and 50 distinct lessons a day; calibrate allows 120 an hour. Wait for the time given. |
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

The signing code follows the byte-level contract in the [agent protocol](https://mom.achromat.ai/skill.md) (sections 2 and 3), and the tests reproduce its published self-check vector exactly. Ed25519 is deterministic, so a change that alters a single byte of the canonical string fails that test.

## Licence

Not yet chosen.

# LVNDR agent kit

Everything an AI agent needs to change a Shopify store safely with
[LVNDR by Toolfora](https://toolfora.com/lvndr/developers), the store time machine for Shopify:
the MCP server connection, the `lvndr` skill, plugins for Claude Code, Cursor and Codex, a Cursor
rule, the MCP registry entry and the zero-dependency `lvndr` CLI.

LVNDR records changes to the parts of a store it tracks (products, variants, inventory,
collections, pages, blogs and posts, media, publication, metafields and definitions, menus,
themes), says who made each one as far as Shopify reveals it, and puts it back with a preview
first. Themes are tracked but not written back; orders and customers are not tracked. An agent starts a **run** with a restore point before it
writes; afterwards it lists exactly what the run changed and undoes the whole run, one batch or one
field. The LVNDR Shopify app must be installed on the store. This repository holds no app source.

- Developer page: <https://toolfora.com/lvndr/developers>
- For language models: <https://toolfora.com/lvndr/llms.txt>
- OpenAPI: <https://lvndr.toolfora.com/api/v1/openapi.json>
- Operator guide: [`docs/AGENT-PLAYBOOK.md`](docs/AGENT-PLAYBOOK.md)

## Step 0: install LVNDR on the store

Install the LVNDR Shopify app on the store and wait for its first snapshot (the app's change log
shows the progress; a few minutes for most catalogues). Then connect your agent and call
`lvndr_status` (CLI: `lvndr status`) to confirm which store it reached.

## Connect

MCP endpoint: `https://lvndr.toolfora.com/mcp` (Streamable HTTP).

The first option for every client is keyless: give it only the URL, and it signs in through the
Shopify admin with OAuth (you pick the store and approve the scopes). The second option is an API
key: create one in **LVNDR > Settings > Agents & API** (starts with `lv_`, shown once), export
it, and send it as `Authorization: Bearer <key>`:

```sh
export LVNDR_API_KEY=lv_...
```

API access is included on every LVNDR plan and free on development stores. New keys can read
and undo; rollback and export are opt-in per key.

## Claude Code

Plugin (MCP server + skill; signs in with OAuth on first use):

```
/plugin marketplace add toolfora/lvndr-agent
/plugin install lvndr@lvndr
```

Or the MCP server alone, keyless (then run `/mcp` in Claude Code to sign in):

```sh
claude mcp add -t http lvndr https://lvndr.toolfora.com/mcp
```

With an API key instead:

```sh
claude mcp add -t http -H "Authorization: Bearer $LVNDR_API_KEY" lvndr https://lvndr.toolfora.com/mcp
```

## Cursor

Keyless: add the URL to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project); Cursor signs in
with OAuth when the server is first used:

```json
{ "mcpServers": { "lvndr": { "url": "https://lvndr.toolfora.com/mcp" } } }
```

With an API key, one-click install (Cursor reads `LVNDR_API_KEY` from its environment):

```
cursor://anysphere.cursor-deeplink/mcp/install?name=lvndr&config=eyJ1cmwiOiJodHRwczovL2x2bmRyLnRvb2xmb3JhLmNvbS9tY3AiLCJoZWFkZXJzIjp7IkF1dGhvcml6YXRpb24iOiJCZWFyZXIgJHtlbnY6TFZORFJfQVBJX0tFWX0ifX0=
```

The `config` value is the base64 of
`{"url":"https://lvndr.toolfora.com/mcp","headers":{"Authorization":"Bearer ${env:LVNDR_API_KEY}"}}`.
The Cursor plugin in [`.cursor-plugin/`](.cursor-plugin/plugin.json) bundles the URL-only server
(OAuth), the skill and the rule in [`rules/lvndr.mdc`](rules/lvndr.mdc).

## VS Code

```
vscode:mcp/install?%7B%22name%22%3A%22lvndr%22%2C%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Flvndr.toolfora.com%2Fmcp%22%2C%22headers%22%3A%7B%22Authorization%22%3A%22Bearer%20%24%7Benv%3ALVNDR_API_KEY%7D%22%7D%7D
```

As a web link: [Install in VS Code](https://vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522lvndr%2522%252C%2522type%2522%253A%2522http%2522%252C%2522url%2522%253A%2522https%253A%252F%252Flvndr.toolfora.com%252Fmcp%2522%252C%2522headers%2522%253A%257B%2522Authorization%2522%253A%2522Bearer%2520%2524%257Benv%253ALVNDR_API_KEY%257D%2522%257D%257D).
VS Code must be started from a shell where `LVNDR_API_KEY` is set.

## Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.lvndr]
url = "https://lvndr.toolfora.com/mcp"
bearer_token_env_var = "LVNDR_API_KEY"
```

[`.codex-plugin/plugin.json`](.codex-plugin/plugin.json) packages the skill and points at
[`.mcp.json`](.mcp.json), the URL-only server (`codex plugin marketplace add toolfora/lvndr-agent`).
If your Codex build does not do MCP OAuth, use the `config.toml` snippet above with a key.

## Claude Desktop

Through [`mcp-remote`](https://www.npmjs.com/package/mcp-remote), in
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "lvndr": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://lvndr.toolfora.com/mcp", "--header", "Authorization:${LVNDR_AUTH}"],
      "env": { "LVNDR_AUTH": "Bearer lv_..." }
    }
  }
}
```

## CLI

```sh
npm i -g @toolfora/lvndr          # once: installs the `lvndr` command
lvndr login                       # paste the key; saved to ~/.config/lvndr/config.json
lvndr status
lvndr changes --since 24h
lvndr undo <changeId>             # preview; prints the --plan-hash to write it
lvndr undo <changeId> --run --plan-hash <hash>   # write exactly that plan
lvndr guard -- shopify store execute --allow-mutations ...   # run + restore point around a command
```

Every command, flag and exit code: [`cli/README.md`](cli/README.md).

## Skill only

The skill follows the [Agent Skills](https://agentskills.io/specification) format. Copy
[`skills/lvndr/`](skills/lvndr/SKILL.md) into your agent's skills directory (for Claude Code,
`~/.claude/skills/lvndr/`), or `npx skills add toolfora/lvndr-agent`. Endpoint and tool reference:
[`skills/lvndr/references/`](skills/lvndr/references/).

## MCP registry

[`server.json`](server.json) describes the remote server for the official MCP registry as
`io.github.toolfora/lvndr-agent`.

## Layout

| Path | What |
|---|---|
| `.claude-plugin/` | Claude Code plugin and marketplace manifests |
| `.cursor-plugin/` | Cursor plugin manifest and its MCP config |
| `.codex-plugin/` | Codex plugin manifest |
| `.mcp.json` | The LVNDR HTTP MCP server, URL only (OAuth sign-in; no secrets) |
| `skills/lvndr/` | The safe-change skill and its references |
| `rules/lvndr.mdc` | Cursor rule (opt-in) |
| `cli/` | The `lvndr` npm package |
| `server.json` | MCP registry entry |
| `docs/AGENT-PLAYBOOK.md` | Guide for the person running agents |

## License

MIT, see [`LICENSE`](LICENSE). The LVNDR app itself is a hosted service and is not part of this
repository.

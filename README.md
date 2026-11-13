# lvndr agent kit

Everything an AI agent needs to change a Shopify store safely with
[lvndr](https://app-production-559c.up.railway.app/developers), the store time machine for Shopify:
the MCP server connection, the `lvndr` skill, plugins for Claude Code, Cursor and Codex, a Cursor
rule, the MCP registry entry and the zero-dependency `lvndr` CLI.

lvndr records every change to a store (products, variants, inventory, collections, pages, blogs and
posts, media, publication, metafields and definitions, menus, themes), says who made it, and puts
any of it back with a preview first. An agent starts a **run** with a restore point before it
writes; afterwards it lists exactly what the run changed and undoes the whole run, one batch or one
field. The lvndr Shopify app must be installed on the store. This repository holds no app source.

- Developer page: <https://app-production-559c.up.railway.app/developers>
- For language models: <https://app-production-559c.up.railway.app/llms.txt>
- OpenAPI: <https://app-production-559c.up.railway.app/api/v1/openapi.json>
- Operator guide: [`docs/AGENT-PLAYBOOK.md`](docs/AGENT-PLAYBOOK.md)

## Get a key

MCP endpoint: `https://app-production-559c.up.railway.app/mcp` (Streamable HTTP). Every client
below sends `Authorization: Bearer <key>`. Create a key in **lvndr > Settings > Agents & API**
(starts with `lv_`, shown once) and export it:

```sh
export LVNDR_API_KEY=lv_...
```

API access is included on every lvndr plan and free on development stores. New keys can read
and undo; rollback and export are opt-in per key. Clients that support MCP
OAuth (Claude, Cursor) can also connect with only the URL and sign in through the Shopify admin.

## Claude Code

Plugin (MCP server + skill; reads `LVNDR_API_KEY` from the environment):

```
/plugin marketplace add kasazen/lvndr-agent
/plugin install lvndr@lvndr
```

Or the MCP server alone:

```sh
claude mcp add -t http -H "Authorization: Bearer $LVNDR_API_KEY" lvndr https://app-production-559c.up.railway.app/mcp
```

## Cursor

One-click install (Cursor reads `LVNDR_API_KEY` from its environment):

```
cursor://anysphere.cursor-deeplink/mcp/install?name=lvndr&config=eyJ1cmwiOiJodHRwczovL2FwcC1wcm9kdWN0aW9uLTU1OWMudXAucmFpbHdheS5hcHAvbWNwIiwiaGVhZGVycyI6eyJBdXRob3JpemF0aW9uIjoiQmVhcmVyICR7ZW52OkxWTkRSX0FQSV9LRVl9In19
```

The `config` value is the base64 of
`{"url":"https://app-production-559c.up.railway.app/mcp","headers":{"Authorization":"Bearer ${env:LVNDR_API_KEY}"}}`.
The Cursor plugin in [`.cursor-plugin/`](.cursor-plugin/plugin.json) bundles the same server, the
skill and the rule in [`rules/lvndr.mdc`](rules/lvndr.mdc); it asks for the key as the plugin
variable `LVNDR_API_KEY`.

## VS Code

```
vscode:mcp/install?%7B%22name%22%3A%22lvndr%22%2C%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fapp-production-559c.up.railway.app%2Fmcp%22%2C%22headers%22%3A%7B%22Authorization%22%3A%22Bearer%20%24%7Benv%3ALVNDR_API_KEY%7D%22%7D%7D
```

As a web link: [Install in VS Code](https://vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522lvndr%2522%252C%2522type%2522%253A%2522http%2522%252C%2522url%2522%253A%2522https%253A%252F%252Fapp-production-559c.up.railway.app%252Fmcp%2522%252C%2522headers%2522%253A%257B%2522Authorization%2522%253A%2522Bearer%2520%2524%257Benv%253ALVNDR_API_KEY%257D%2522%257D%257D).
VS Code must be started from a shell where `LVNDR_API_KEY` is set.

## Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.lvndr]
url = "https://app-production-559c.up.railway.app/mcp"
bearer_token_env_var = "LVNDR_API_KEY"
```

[`.codex-plugin/plugin.json`](.codex-plugin/plugin.json) packages the skill and points at
[`.mcp.json`](.mcp.json) (`codex plugin marketplace add kasazen/lvndr-agent`). If your Codex build
does not expand `${LVNDR_API_KEY}` in plugin MCP headers, use the `config.toml` snippet above.

## Claude Desktop

Through [`mcp-remote`](https://www.npmjs.com/package/mcp-remote), in
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "lvndr": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://app-production-559c.up.railway.app/mcp", "--header", "Authorization:${LVNDR_AUTH}"],
      "env": { "LVNDR_AUTH": "Bearer lv_..." }
    }
  }
}
```

## CLI

```sh
npx lvndr login                       # paste the key; saved to ~/.config/lvndr/config.json
npx lvndr status
npx lvndr changes --since 24h
npx lvndr undo <changeId>             # preview
npx lvndr undo <changeId> --run       # write
npx lvndr guard -- shopify store execute --allow-mutations ...   # run + restore point around a command
```

Every command, flag and exit code: [`cli/README.md`](cli/README.md).

## Skill only

The skill follows the [Agent Skills](https://agentskills.io/specification) format. Copy
[`skills/lvndr/`](skills/lvndr/SKILL.md) into your agent's skills directory (for Claude Code,
`~/.claude/skills/lvndr/`), or `npx skills add kasazen/lvndr-agent`. Endpoint and tool reference:
[`skills/lvndr/references/`](skills/lvndr/references/).

## MCP registry

[`server.json`](server.json) describes the remote server for the official MCP registry as
`io.github.kasazen/lvndr-agent`.

## Layout

| Path | What |
|---|---|
| `.claude-plugin/` | Claude Code plugin and marketplace manifests |
| `.cursor-plugin/` | Cursor plugin manifest and its MCP config |
| `.codex-plugin/` | Codex plugin manifest |
| `.mcp.json` | The lvndr HTTP MCP server, bearer from `LVNDR_API_KEY` (no secrets) |
| `skills/lvndr/` | The safe-change skill and its references |
| `rules/lvndr.mdc` | Cursor rule (opt-in) |
| `cli/` | The `lvndr` npm package |
| `server.json` | MCP registry entry |
| `docs/AGENT-PLAYBOOK.md` | Guide for the person running agents |

## License

MIT, see [`LICENSE`](LICENSE). The lvndr app itself is a hosted service and is not part of this
repository.

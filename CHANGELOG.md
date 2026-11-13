# Changelog

## 0.1.0 (2026-11-13)

First public release, split out of the private lvndr app repository.

- MCP server connection for Claude Code, Cursor, VS Code, Codex and Claude Desktop
  (`https://app-production-559c.up.railway.app/mcp`, bearer `LVNDR_API_KEY` or MCP OAuth).
- Plugins: Claude Code (`.claude-plugin/`, with a marketplace manifest), Cursor (`.cursor-plugin/`,
  with the `lvndr.mdc` rule) and Codex (`.codex-plugin/`).
- The `lvndr` skill: restore point or run first, verify what changed, undo by change, batch, run or
  restore point with a preview and confirmation token.
- `lvndr` CLI 0.1.0: login and profiles, status, changes, history, undo, undo-batch, preview,
  rollback, alerts, runs, `guard` around any command, JSON output and exit codes 0 to 6.
- MCP registry entry `io.github.kasazen/lvndr-agent`.

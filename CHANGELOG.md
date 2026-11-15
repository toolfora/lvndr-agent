# Changelog

## 0.2.0 (2026-11-15): undo only what went wrong

- `lvndr_undo` takes `fields` (paths from the preview's `items[].path`): put back one variant's
  price without touching the description edited in the same change. REST `POST /changes/:id/undo`
  takes `fields`; the CLI takes `--field <path>` (repeatable) and lists each field's path.
- Runs, batches and rollbacks can be narrowed: `fieldKinds` (e.g. `["Price"]`, from the preview's
  new `kinds`) and `excludeChangeIds`, on the previews and the writes, over MCP and REST; the CLI
  takes `--only <kind>` and `--exclude <changeId>`. Whatever is left out stays undoable later.
- The CLI ships on npm as `@toolfora/lvndr`; the command is still `lvndr`.

## Unreleased (2026-11-14)

- Every store write is bound to a preview: `lvndr_undo` needs a `confirmation_token` for every key
  (no `confirm: true`); `lvndr_undo_run` and `lvndr_undo_batch` take a token from the new
  `lvndr_preview_undo_run` and `lvndr_preview_undo_batch` and no longer have `dryRun`. REST writes
  need `planHash` (400 `plan_required` without it); the CLI needs `--plan-hash` with `--run`, or
  `--yes` at a terminal.
- `lvndr_get_run` / `GET /runs/:id` report `attributedThrough` and `pendingDeliveries`; agents poll
  them instead of sleeping. `guard` waits up to `--wait 300` that way.
- `lvndr_search_changes` takes `resourceId`. The two deprecated alias tools (list changes,
  batch) are gone; use `lvndr_search_changes` and `lvndr_get_batch`.
- Runs report `capture`: only keys with `undo` open catch-all runs.
- `POST /runs` marks a restore point by default, like MCP and the CLI.
- Plugin and registry MCP configs are URL-only: clients sign in with OAuth, no env var needed.
- CLI: per-command `--help`, exit 7 for conflicts (409), 8 when the plan lacks the API (402).

## 0.1.0 (2026-11-13)

First public release, split out of the private LVNDR app repository.

- MCP server connection for Claude Code, Cursor, VS Code, Codex and Claude Desktop
  (`https://lvndr.toolfora.com/mcp`, bearer `LVNDR_API_KEY` or MCP OAuth).
- Plugins: Claude Code (`.claude-plugin/`, with a marketplace manifest), Cursor (`.cursor-plugin/`,
  with the `lvndr.mdc` rule) and Codex (`.codex-plugin/`).
- The `lvndr` skill: restore point or run first, verify what changed, undo by change, batch, run or
  restore point with a preview and confirmation token.
- `lvndr` CLI 0.1.0: login and profiles, status, changes, history, undo, undo-batch, preview,
  rollback, alerts, runs, `guard` around any command, JSON output and exit codes 0 to 6.
- MCP registry entry `io.github.kasazen/lvndr-agent`.

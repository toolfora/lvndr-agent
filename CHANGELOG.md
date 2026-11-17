# Changelog

## Unreleased (2026-11-17): theme files are view only

- Removed `lvndr theme restore` and the MCP tool `lvndr_theme_file_at`; `lvndr_theme_change_files`
  and `GET /changes/:id/theme-files` no longer take `live` or `content` and return no `restore`
  plan. LVNDR no longer hands out whole theme files or pushes them (Shopify App Store requirement
  1.1.3: no theme downloads). A new or deleted file shows its line count, not its lines.
- To put a theme file back: open it in Online Store > Themes > Edit code and use its Timeline.

## 0.3.0 (2026-11-15): review, time travel, agent QA, theme code, wider coverage

- Agent QA: `lvndr_list_findings`, `lvndr_get_insights`, `lvndr_dismiss_finding`; findings per
  change and run (zeroed or jumped prices, emptied or duplicated text, switched language, broken
  HTML, SEO length, tug of war, `seo.missing_redirect`); pattern groups with the narrowing that
  undoes only one group. CLI `findings`, `insights`, `run undo --flagged | --group`.
- Run budgets: `lvndr_start_run` / `POST /runs` take `budget` (max records, kinds, max price
  change, optional auto-undo of the excess); CLI `run start --max-records --only --max-price-change --auto-undo`.
- Plain-language undo: `lvndr_plan_undo` / `POST /plan-undo` / `lvndr plan "..."`, then
  `lvndr_undo_selection` with its token.
- Theme code: `lvndr_theme_file_history`, `lvndr_theme_file_at`, `lvndr_theme_change_files`; CLI
  `lvndr theme history|diff|restore` (restore through your own Shopify CLI).
- Coverage: URL redirects, discounts and translations tracked and undoable; `lvndr_coverage` /
  `GET /coverage` / `lvndr coverage` say what is tracked and what needs permission.
- Toolfora suite: `lvndr_field_edits` / `GET /records/:record/edits` / `lvndr edits`: who last
  wrote each field, so an agent never overwrites a person's edit.

### Review and time

- Proposals (store pull requests): `lvndr_propose_changes`, `POST /proposals`, `lvndr propose`
  propose field edits for the merchant to review instead of writing them (scope `read`). Review
  with `lvndr_get_proposal` / `GET /proposals/:id` / `lvndr proposal <id>`. The merchant applies
  in the app; a key applies only with the new opt-in scope `propose:apply`. The applied writes form
  one run named after the proposer, so the whole proposal undoes as one.
- Time travel: `lvndr_compare_versions`, `lvndr_preview_restore_version` + `lvndr_restore_version`;
  REST `GET /records/:id/versions/:v`, `GET /records/:id/compare`, `POST /records/:id/restore`;
  CLI `lvndr compare`, `lvndr restore-version`.
- Scheduled undo: `lvndr_schedule_undo` (with the matching preview's token),
  `lvndr_list_scheduled_undos`, `lvndr_cancel_scheduled_undo`; REST `/scheduled-undos`; CLI
  `lvndr schedule`, `lvndr scheduled`, `lvndr unschedule`. Re-previewed when due and skipped with
  the reason if the plan moved.

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

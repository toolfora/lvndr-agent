---
name: lvndr
description: Safety net for changing a Shopify store through lvndr's change log. Use whenever you change a Shopify store with any tool (Admin API, Shopify CLI, store MCP, an app, a CSV import): mark a restore point or start a run first, verify afterwards what actually changed and who changed it, and undo precisely by change, batch, run or restore point with a preview before any write. Also use when asked what changed in a store, who changed a product, price, collection, page, menu or theme, or to roll a store back.
license: MIT
compatibility: Needs the lvndr Shopify app installed on the store and an lvndr API key (LVNDR_API_KEY); every lvndr plan includes API access. Works through the lvndr MCP server or the `lvndr` CLI (Node 20+); network access to the lvndr app URL.
metadata:
  author: HereNow Labs
  version: "0.1.0"
---

# lvndr: change a Shopify store safely

lvndr records every change to a Shopify store (products, variants, inventory, collections, pages,
blogs and posts, media, sales-channel publication, metafields and definitions, menus, themes) with
a before/after diff and the best attribution Shopify allows, and can put any of it back.

You reach it two ways. Prefer MCP when the `lvndr_*` tools are available; otherwise use the CLI.

- MCP: server `lvndr` at `https://app-production-559c.up.railway.app/mcp`, bearer `LVNDR_API_KEY`.
- CLI: `npx lvndr <command>` (or `lvndr` if installed), key from `LVNDR_API_KEY` or `lvndr login`.
  Add `--json` to any command for machine-readable output.

## The safe workflow

Follow these steps every time you are about to write to a store, whatever tool does the writing.

1. **Check access.** `lvndr_status` (CLI: `lvndr status`). If it fails with auth (CLI exit 3),
   stop and tell the user the key is missing, revoked, lacks a scope, or the store has no active
   lvndr plan. New keys carry `read` and `undo`; `rollback` and `export` are opt-in.
2. **Start a run with a restore point.** `lvndr_start_run` with `agent` (your name),
   `task` (one line: what you are about to do) and `markRestorePoint: true`. Keep the returned
   run id. CLI: `lvndr run start --agent <name> --task "<task>"` (prints the id; also
   `export LVNDR_RUN_ID=<id>`). For a single shell command, `lvndr guard -- <command...>` does
   steps 2, 4 and 5 for you.
   If you cannot start a run, at least `lvndr_mark_restore_point` with a label naming the task.
   Through the REST API and CLI, marking a restore point (`lvndr mark`, or a run with one) needs
   the `rollback` scope; with a default key use `lvndr run start ... --no-restore-point`.
3. **Make the change** with whatever tool the task needs. When your writes go through the lvndr
   API or CLI, send the run id (`X-Lvndr-Run-Id`, or `LVNDR_RUN_ID` in the environment) so they
   are tagged to the run.
4. **End the run.** `lvndr_end_run` (CLI: `lvndr run end`).
5. **Verify.** Shopify delivers change events a few seconds late, so wait about 5 to 10 seconds,
   then `lvndr_get_run` (CLI: `lvndr run show <id>`) or `lvndr_search_changes` with `runId` or
   `since`. Compare what changed with what you intended: right records, right fields, nothing
   extra. Report the change ids to the user.
6. **Undo precisely when something is wrong.** Always preview first, then write:
   - one change: `lvndr_preview_undo`, then `lvndr_undo` with the `confirmation_token` it returned
     (CLI: `lvndr undo <id>` then `lvndr undo <id> --run --plan-hash <hash>` as the preview prints)
   - everything in your run: `lvndr_undo_run` with `dryRun: true`, then `dryRun: false` plus its `confirmation_token`
     (CLI: `lvndr run undo <id>` then `--run`)
   - one actor's burst: `lvndr_undo_batch`, same dry run then token pattern (CLI: `lvndr undo-batch <changeId>`)
   - everything since a restore point: `lvndr_preview_rollback`, then `lvndr_rollback` with
     its `confirmation_token` (CLI: `lvndr preview <pointId>`, `lvndr rollback <pointId> --confirm`)
   Tokens are single use and expire after 10 minutes; if the store moved since the preview,
   the write is refused and you preview again.
   Run undo, batch undo and rollback run in the background: the write returns a `job`. Poll
   `lvndr_get_job` with its id every few seconds until `status` is `done`, `partial` or
   `failed`, then report it (the CLI waits and polls for you; `lvndr job <id>` checks later).
   Prefer the narrowest undo that fixes the problem. A rollback also reverts changes other people
   made after the point; read the preview and say so to the user before running it.
   Pass a `reason` on every undo, rollback and restore point; it lands in the audit log.

Never run an undo, batch undo, run undo or rollback without showing or reading its preview
first, and never on your own initiative when the user asked only for a report.

## Reading the change log

- Recent changes: `lvndr_search_changes` (`since`, `until`, `type`, `action`, `resourceId`,
  `actor`, `q`, `hideUndos`, `runId`, `limit`, `cursor`). CLI: `lvndr changes --since 24h`.
- One change with its diff: `lvndr_get_change` (CLI: `lvndr change <id>`).
- A record's history: `lvndr_record_history` with a gid or `Product-123` (CLI: `lvndr history`).
- What one actor did together: `lvndr_get_batch` (CLI: `lvndr batch <changeId>`).
- Restore points: `lvndr_list_restore_points` (CLI: `lvndr points`).
- Anomaly alerts (N records changed in M minutes by one actor): `lvndr_list_alerts`
  (CLI: `lvndr alerts`); dismiss with `lvndr_dismiss_alert` only after the user agrees.

Attribution has three tiers and every change says which: `exact` (Shopify's admin events name
the staff member or app, for creates, deletes, publishes and status changes), `channel` (only
the channel is known) and `inferred` (field edits, metafields, menus and themes, which Shopify
never attributes). Report the tier; never present an inferred actor as certain.

## Failure handling

| What you see | What to do |
|---|---|
| 401, 402, 403 (CLI exit 3) | Stop. Key missing or revoked, a scope missing (read, undo, rollback, export), or the store has no active lvndr plan. Tell the user. |
| 409 `plan_changed`, or a job `error` starting `plan_changed` | The changes to undo moved since the preview. Preview again and show the user the new plan. |
| 404 (CLI exit 4) | Wrong id, or a change older than the plan's retention. Search again. |
| 429 (CLI exit 5) | Wait for `Retry-After` seconds, then retry the same call with the same `Idempotency-Key`. Limits are per key per minute and follow the plan (reads/writes: Starter 60/10, Growth 120/20, Scale 300/60). |
| Network error (CLI exit 6) | Retry once; writes are idempotent per `Idempotency-Key`. |
| Undo or job `partial` or `failed` (CLI exit 2) | Read each result's `detail`; do not retry blindly. Re-preview: the record may have changed again (a `conflict`). |
| Preview item `conflict` | The field was changed again after this change. Only overwrite with `includeConflicts` when the user agrees. |
| Preview item `unsupported` | lvndr cannot write that field; tell the user and show the earlier value for a manual fix. |
| No changes after your write | Events arrive late; wait and search again. Collection rules, SEO and alt-text edits can take up to 10 minutes or the daily sweep to appear. |

## Limits

- Themes are tracked (settings and template JSON) but never written back: Shopify requires an
  exemption for theme writes. lvndr shows the earlier value for a manual restore.
- Orders, customers and other protected data are out of scope: not tracked, not undoable.
- An undone delete is rebuilt from the last snapshot with a **new id** and without inventory
  history; product media are re-attached or re-uploaded where possible.
- Lists longer than one snapshot page are flagged truncated and are not undoable.
- Retention follows the store's plan; older changes cannot be undone.
- Per-edit staff names are not available from Shopify; see attribution tiers above.

## References

- `references/mcp-tools.md`: every MCP tool with its arguments and when to use it.
- `references/api.md`: the REST API, CLI commands, headers, errors and exit codes.

---
name: lvndr
description: "Safety net for changing a Shopify store through LVNDR's change log. Use whenever you change a Shopify store with any tool (Admin API, Shopify CLI, store MCP, an app, a CSV import): mark a restore point or start a run first, verify afterwards what actually changed and who changed it, and undo precisely by change, batch, run or restore point with a preview before any write. Also use when asked what changed in a store, who changed a product, price, collection, page, menu or theme, or to roll a store back."
license: MIT
compatibility: "Needs the LVNDR Shopify app installed on the store, and either an MCP client that signs in with OAuth or an LVNDR API key (LVNDR_API_KEY); every LVNDR plan includes API access. Works through the LVNDR MCP server or the `lvndr` CLI (Node 20+); network access to the LVNDR app URL."
metadata:
  author: HereNow Labs
  version: "0.1.0"
---

# lvndr: change a Shopify store safely

LVNDR records changes to the parts of a Shopify store it tracks (products, variants, inventory,
collections, pages, blogs and posts, media, sales-channel publication, metafields and definitions,
menus, themes) with a before/after diff and the best attribution Shopify allows, and can put most
of it back (themes are tracked but never written; see Limits).

You reach it two ways. Prefer MCP when the `lvndr_*` tools are available; otherwise use the CLI.

- MCP: server `lvndr` at `https://lvndr.toolfora.com/mcp` (OAuth sign-in, or bearer
  `LVNDR_API_KEY`).
- CLI: `lvndr <command>` (install once with `npm i -g @toolfora/lvndr`), key from `LVNDR_API_KEY` or `lvndr login`.
  Add `--json` to any command for machine-readable output.

## The safe workflow

Follow these steps every time you are about to write to a store, whatever tool does the writing.

1. **Check access.** `lvndr_status` (CLI: `lvndr status`). If it fails with auth (CLI exit 3),
   stop and tell the user the key is missing, revoked or expired, or the app is not installed on
   the store. A 402 (CLI exit 8) means the store has no LVNDR plan that includes the API. New keys carry `read` and `undo`; `rollback` and `export` are opt-in.
2. **Start a run with a restore point.** `lvndr_start_run` with `agent` (your name),
   `task` (one line: what you are about to do) and `markRestorePoint: true`. Keep the returned
   run id. CLI: `lvndr run start --agent <name> --task "<task>"` (prints the id; also
   `export LVNDR_RUN_ID=<id>`). For a single shell command, `lvndr guard -- <command...>` does
   steps 2, 4 and 5 for you.
   If you cannot start a run, at least `lvndr_mark_restore_point` with a label naming the task.
   Marking a restore point and starting a run need only the `read` scope, on every surface.
   Read the start response's `capture`: `all-unattributed` (the key has `undo`) means the run
   takes every unattributed or inferred change while open (up to 24 hours), staff edits too, so
   end it promptly; `client` (an OAuth token without `undo`, or a `clientId` that is your own OAuth
   client id) means only your OAuth client's changes; `none` (a Settings key without `undo`) means
   nothing is tagged, so verify with `lvndr_search_changes` by `since` instead of by `runId`.
3. **Make the change** with whatever tool the task needs. When your writes go through the LVNDR
   API or CLI, send the run id (`X-Lvndr-Run-Id`, or `LVNDR_RUN_ID` in the environment) so they
   are tagged to the run.
4. **End the run.** `lvndr_end_run` (CLI: `lvndr run end`).
5. **Verify, once LVNDR has caught up.** Changes are tagged within about 4 minutes (collection rules,
   SEO, menus and themes up to 10, from a 10-minute check). Poll `lvndr_get_run` (CLI:
   `lvndr run show <id> --json`) about every 20 seconds until `attributedThrough` is after your
   last write and `pendingDeliveries` is 0; do not judge the run from an earlier read. Then compare
   what changed with what you intended: right records, right fields, nothing extra. Report the
   change ids to the user. `lvndr guard` does this wait for you.
6. **Undo precisely when something is wrong.** Always preview first, then write:
   - one change: `lvndr_preview_undo`, then `lvndr_undo` with the `confirmation_token` it returned
     (CLI: `lvndr undo <id>` then `lvndr undo <id> --run --plan-hash <hash>` as the preview prints)
   - everything in your run: `lvndr_preview_undo_run`, then `lvndr_undo_run` with its
     `confirmation_token` (CLI: `lvndr run undo <id>` then `--run --plan-hash <hash>`)
   - one actor's burst: `lvndr_preview_undo_batch`, then `lvndr_undo_batch` with its token
     (CLI: `lvndr undo-batch <changeId>` then `--run --plan-hash <hash>`)
   - everything since a restore point: `lvndr_preview_rollback`, then `lvndr_rollback` with
     its `confirmation_token` (CLI: `lvndr preview <pointId>`, then
     `lvndr rollback <pointId> --confirm --plan-hash <hash>`)
   Every store write needs the token (MCP) or plan hash (CLI, REST) from its preview; there is no
   way around it. Tokens are single use and expire after 10 minutes; if the store moved since the
   preview, the write is refused and you preview again. A preview with nothing to write returns
   no token. Never use the CLI's `--yes`: it is for a
   person at a terminal.
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
- Anomaly alerts (N records changed in M minutes by one actor; on plans that include alerts):
  `lvndr_list_alerts` (CLI: `lvndr alerts`); dismiss with `lvndr_dismiss_alert` only after the
  user agrees. An alert whose burst was undone by a batch, run or rollback undo is `resolved`.

Attribution has tiers and every change says which: `exact` (Shopify's admin events name
the staff member or app, for creates, deletes, publishes and status changes), `channel` (only
the channel is known), `inferred` (a labelled guess for field edits, metafields, menus and
themes, which Shopify never attributes) and `unknown` (no evidence at all yet). `unknown` is
common: most plain field edits arrive with no actor and stay unknown until LVNDR can guess, or
until an open catch-all run adopts them. Report the tier; never present an inferred actor as
certain, and never read `unknown` as "nobody". LVNDR's own undos are always `exact` with name
`lvndr undo`, and never join a run or a batch.

## Failure handling

| What you see | What to do |
|---|---|
| 401, 403 (CLI exit 3), or a tool result "This key lacks the ... scope" | Stop. Key missing, revoked or expired, a scope missing (read, undo, rollback, export), or 403 `not_installed` (the app is not installed on the store). Tell the user; a key with the scope is made in LVNDR Settings > Agents & API. |
| 402 (CLI exit 8) | The store has no active LVNDR plan with the API. Tell the user. |
| 400 `plan_required` | You sent a write without the preview's `planHash`. Preview, show it, then send the hash. |
| 409 `plan_changed` (CLI exit 7), or a job `error` starting `plan_changed` | The changes to undo moved since the preview. Preview again and show the user the new plan. |
| 404 (CLI exit 4) | Wrong id, or a change older than the plan's retention. Search again. |
| 429 (CLI exit 5), or a tool result "Rate limited; retry in N s" | Wait for `Retry-After` (or N) seconds, then retry the same call with the same `Idempotency-Key`. Limits are per key per minute and follow the plan (reads/writes: Starter 60/10, Growth 120/20, Scale 300/60, development stores 120/20 once billing is on; during early access every store gets the top rate, 300/60). |
| Network error (CLI exit 6) | Retry once; writes are idempotent per `Idempotency-Key`. |
| Undo or job `partial` or `failed` (CLI exit 2) | Read each result's `detail`; do not retry blindly. Re-preview: the record may have changed again (a `conflict`). |
| Preview item `conflict` | The field was changed again after this change. Only overwrite with `includeConflicts` when the user agrees. |
| Preview item `unsupported` | LVNDR cannot write that field; tell the user and show the earlier value for a manual fix. |
| No changes after your write | Check `attributedThrough` and `pendingDeliveries` on the run and keep polling. Collection rules, SEO, menus and themes take up to 10 minutes; alt-text edits wait for the daily sweep. With `capture` `none`, search by `since` instead. |

## Limits

- Themes are tracked (settings and template JSON) but never written back: Shopify requires an
  exemption for theme writes. LVNDR shows the earlier value for a manual restore.
- Orders, customers and other protected data are out of scope: not tracked, not undoable.
- An undone delete is rebuilt from the last snapshot with a **new id**. A rebuilt product has
  its options, variants, metafields and manual-collection memberships, but no media, inventory
  quantities or sales-channel publication. A deleted theme cannot be rebuilt.
- Undoing a removed image re-attaches it by id, or re-uploads it from its stored URL.
- Lists longer than one snapshot page are flagged truncated and are not undoable.
- Retention follows the store's plan; older changes cannot be undone.
- Per-edit staff names are not available from Shopify; see attribution tiers above.

## References

- `references/mcp-tools.md`: every MCP tool with its arguments and when to use it.
- `references/api.md`: the REST API, CLI commands, headers, errors and exit codes.

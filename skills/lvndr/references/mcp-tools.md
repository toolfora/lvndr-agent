# LVNDR MCP tools

Endpoint: `POST https://lvndr.toolfora.com/mcp` (Streamable HTTP, JSON-RPC:
`initialize`, `tools/list`, `tools/call`, `ping`). Auth: MCP OAuth (the client signs in through
the Shopify admin with only the URL) or `Authorization: Bearer <LVNDR_API_KEY>`, the same key as
the REST API. A key carries scopes (`read`, `undo`, `rollback`, `export`); new keys and OAuth
grants that ask for no scope get `read` and `undo`, so `lvndr_rollback` needs a key the merchant
gave `rollback` on purpose.

A tool that needs a scope the key lacks: a Settings key gets a tool result with `isError: true`
and the text "This key lacks the undo scope; create a key with Undo in LVNDR Settings > Agents &
API"; an OAuth token gets HTTP 403 with an `insufficient_scope` challenge so the client can ask
for the scope. A rate-limited call is likewise "Rate limited; retry in N s" (Settings key) or
HTTP 429 (OAuth).

The server's `tools/list` response is authoritative for argument schemas. The tables below are
the intent of each tool and the arguments you will normally pass (values and hints in
parentheses).

## Read (scope `read`)

| Tool | Use it to | Main arguments |
|---|---|---|
| `lvndr_status` | Check the key works; plan, tracked counts, last activity check | none |
| `lvndr_search_changes` | List changes, newest first | `since`, `until` (ISO date-time or how long ago: 30m, 24h, 7d, 2w), `type` (PRODUCT, COLLECTION, PAGE, BLOG, ARTICLE, MENU, THEME, METAFIELD_DEFINITION; any case), `action`, `resourceId` (gid or Product-123), `actor`, `q`, `hideUndos`, `runId`, `limit`, `cursor` |
| `lvndr_get_change` | One change with its full before/after diff and attribution tier | `id` |
| `lvndr_record_history` | Every stored version and change of one record | `resourceId` (gid or Product-123), `cursor` |
| `lvndr_get_batch` | Everything one actor did around a change (no gap over 10 minutes) | `anchorChangeId` (any change in the batch) |
| `lvndr_list_restore_points` | Restore points, newest first; the daily check's points only with `kind` sweep or all | `limit`, `cursor`, `kind` (manual, burst, app_install, sweep, all) |
| `lvndr_preview_undo` | Per-field plan for undoing one change: ready, conflict, noop, unsupported, with current and target values. `items` has the same fields in merchant words (field label, current and target as text). Returns the `confirmation_token` for `lvndr_undo` | `id`, `includeConflicts` |
| `lvndr_preview_undo_run` | Plan for undoing every change tagged with a run (the newest 50 planned). Returns the token for `lvndr_undo_run` | `id`, `reason`, `runId` (your current run, not the one being undone) |
| `lvndr_preview_undo_batch` | Plan for undoing one actor's batch. Returns the token for `lvndr_undo_batch` | `anchorChangeId`, `reason`, `runId` |
| `lvndr_preview_rollback` | What rolling back to a restore point would undo. Returns the token for `lvndr_rollback` | `pointId` |
| `lvndr_list_alerts` | Anomaly alerts (bursts by one actor) | `status` (open, dismissed, resolved, all), `limit` |
| `lvndr_get_run` | One agent run with the changes tagged to it, plus `attributedThrough` and `pendingDeliveries` (how far LVNDR has caught up) | `id`, `limit`, `cursor` |
| `lvndr_list_runs` | Recent agent runs | `limit`, `openOnly` |
| `lvndr_get_job` | Progress of a background undo job (from `lvndr_undo_run`, `lvndr_undo_batch` or `lvndr_rollback`): status (queued, running, done, partial, failed), total, done, failed, skipped, remaining, error, one result per change | `id` (the job id) |

## Write

| Tool | Scope | Use it to | Main arguments |
|---|---|---|---|
| `lvndr_start_run` | read | Open a run before changing the store; marks a restore point by default. Returns `capture`, `captureNote` and `warning` (set when the run will collect nothing: tell the user) | `task` (recommended), `agent`, `clientId` (used only if it is the key's own OAuth client id), `markRestorePoint` (default true) |
| `lvndr_end_run` | read | Close the run when done | `id` |
| `lvndr_mark_restore_point` | read | Mark a point to roll back to | `label`, `reason`, `runId` |
| `lvndr_undo` | undo | Undo one change (snapshot first, then write) | `id`, `confirmation_token` (required, from lvndr_preview_undo), `includeConflicts` (must match the preview), `reason`, `runId` |
| `lvndr_undo_run` | undo | Undo every change tagged with a run, newest first. Returns a background `job` | `id`, `confirmation_token` (required, from lvndr_preview_undo_run), `reason`, `runId` |
| `lvndr_undo_batch` | undo | Undo one actor's batch, newest first. Returns a background `job` | `anchorChangeId`, `confirmation_token` (required, from lvndr_preview_undo_batch), `reason`, `runId` |
| `lvndr_rollback` | rollback | Undo everything after a restore point, newest first. Returns a background `job` | `pointId`, `confirmation_token` (required, from lvndr_preview_rollback), `reason`, `runId` |
| `lvndr_dismiss_alert` | undo | Dismiss an alert after the user has looked at it (a read-only key cannot) | `id` |

Every store write needs the `confirmation_token` from its preview: 10 minutes, single use, bound
to the key, the target and what the preview saw. There is no `confirm` or `dryRun` shortcut. A
preview with nothing to write (no `ready` field, counting `conflict` fields only with
`includeConflicts`, or no change to undo) returns `confirmation_token: null` and
`nothingToUndo: true`.

Every preview (`lvndr_preview_undo`, `_undo_run`, `_undo_batch`, `_rollback`) carries `items`:
one entry per field per change, `{changeId, record: {id, type, title}, field, current, target,
status, reason}`, with `field` in merchant words and both values as text ("(empty)" when empty).
Show those to the user rather than `path`. `lvndr_undo` answers `undoRunId` (the undo record; `run`
is the same object, kept for older clients) and `resultChangeId`, the change the undo's own write
produced, once Shopify has reported it (null until then; find it later with
`lvndr_search_changes` and `resourceId`). Refusals say what happened: the store changed since the
preview, the change was already undone (with the undo or job id), or `includeConflicts` differs
from the preview.

## Run capture

`lvndr_start_run` answers `capture`:

- `all-unattributed`: the key has `undo`; while the run is open (up to 24 hours) it takes every
  change Shopify leaves unattributed or only inferred, staff edits included. End it promptly.
- `client`: an OAuth token without `undo`, or a `clientId` that is the token's own OAuth client
  id; only changes linked to that OAuth client.
- `none`: a Settings key without `undo`; nothing is tagged. Review with `lvndr_search_changes`
  by `since` instead.

`captureNote` says the same in one line, including when a `clientId` you passed was ignored.

## Order of calls for a safe change

```
lvndr_status
lvndr_start_run {task, agent}                               -> run.id, run.restorePointId, capture
  ... change the store with whatever tool ...
lvndr_end_run {id}
lvndr_get_run {id}  every ~20 s until attributedThrough is after your last write
                    and pendingDeliveries is 0               -> changes tagged to the run
  if wrong: lvndr_preview_undo_run {id}                      -> plan + confirmation_token
            show the plan, then lvndr_undo_run {id, confirmation_token, reason} -> job
            lvndr_get_job {id: job.id} every few seconds until status is done, partial or failed
```

Changes are tagged within about 4 minutes; collection rules, SEO, menus and themes come from a
10-minute check and can take up to 10. Do not review a run before `attributedThrough` has passed
your last write.

## Background jobs

`lvndr_undo_run`, `lvndr_undo_batch` and `lvndr_rollback` do not write while you wait: they queue
a job and return it at once (`status: "queued"`). Poll `lvndr_get_job {id}` every few seconds
until `status` is `done`, `partial` or `failed`, then report the outcome. Do not call the write
tool again while the job is `queued` or `running`; a second request for the same target returns
the job already in progress.

The `confirmation_token` from the preview is bound to the set of changes it showed. If changes
were added or removed since (new edits arrived, a run picked up more), the write is refused, or
the job ends `failed` with an `error` starting `plan_changed`. Preview again and show the merchant
the new plan.

## Results to check

- Undo of one change: `run.status` is `done`, `partial` or `failed`; each op has `ok` and `errors`.
- Batch and run undo previews: `counts` (`planned`, ...), `results[]` for the newest 50 changes,
  `total`, `more` (changes the undo covers that the preview did not plan) and the
  `confirmation_token`.
- Batch, run undo and rollback jobs (`lvndr_get_job`): `done`, `failed`, `skipped` of `total`,
  and `results[]` with `changeId`, `status` and `detail`. One job covers up to 500 changes; when
  `remaining` is above 0, preview and run again for the rest.
- An undo is itself recorded as a change ("lvndr undo") and can be undone.

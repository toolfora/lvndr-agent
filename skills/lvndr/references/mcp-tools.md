# lvndr MCP tools

Endpoint: `POST https://app-production-559c.up.railway.app/mcp` (Streamable HTTP, JSON-RPC:
`initialize`, `tools/list`, `tools/call`, `ping`). Auth: `Authorization: Bearer <LVNDR_API_KEY>`,
the same key as the REST API. A key carries scopes (`read`, `undo`, `rollback`, `export`); new
keys and OAuth grants that ask for no scope get `read` and `undo`, so `lvndr_rollback` needs a
key the merchant gave `rollback` on purpose. A tool that needs a scope the key lacks returns an
error naming it.

The server's `tools/list` response is authoritative for argument schemas. The tables below are
the intent of each tool and the arguments you will normally pass.

## Read (scope `read`)

| Tool | Use it to | Main arguments |
|---|---|---|
| `lvndr_status` | Check the key works; plan, tracked counts, last activity check | none |
| `lvndr_search_changes` | List changes, newest first | `since`, `until` (ISO), `type` (PRODUCT, COLLECTION, PAGE, BLOG, ARTICLE, MENU, THEME, METAFIELD_DEFINITION), `action`, `resourceId`, `actor`, `q`, `hideUndos`, `runId`, `limit`, `cursor` |
| `lvndr_get_change` | One change with its full before/after diff and attribution tier | `id` |
| `lvndr_record_history` | Every stored version and change of one record | `resourceId` (gid or `Product-123`), `cursor` |
| `lvndr_get_batch` | Everything one actor did around a change (no gap over 10 minutes) | `id` (any change in the batch) |
| `lvndr_list_restore_points` | Restore points, newest first | none |
| `lvndr_preview_undo` | Per-field plan for undoing one change: `ready`, `conflict`, `noop`, `unsupported`, with current and target values | `id`, `includeConflicts` |
| `lvndr_preview_rollback` | What rolling back to a restore point would undo | `pointId` |
| `lvndr_list_alerts` | Anomaly alerts (bursts by one actor) | `status` (`open`, `dismissed`, `all`) |
| `lvndr_get_run` | One agent run with the changes tagged to it | `id`, `cursor` |
| `lvndr_list_runs` | Recent agent runs | `limit`, `openOnly` |
| `lvndr_get_job` | Progress of a background undo job (from `lvndr_undo_run`, `lvndr_undo_batch` or `lvndr_rollback`): `status` (`queued`, `running`, `done`, `partial`, `failed`), `total`, `done`, `failed`, `skipped`, `remaining`, `error`, one result per change | `id` (the job id) |

## Write

| Tool | Scope | Use it to | Main arguments |
|---|---|---|---|
| `lvndr_start_run` | read | Open a run before changing the store | `agent`, `task`, `clientId`, `markRestorePoint` |
| `lvndr_end_run` | read | Close the run when done | `id` |
| `lvndr_mark_restore_point` | read | Mark a point to roll back to | `label`, `reason` |
| `lvndr_undo` | undo | Undo one change (snapshot first, then write) | `id`, `confirmation_token` (from `lvndr_preview_undo`), `includeConflicts`, `reason` |
| `lvndr_undo_run` | undo | Undo every change tagged with a run, newest first. The real run returns a background `job` | `id`, `dryRun`, `confirmation_token` (from the dry run), `reason` |
| `lvndr_undo_batch` | undo | Undo one actor's batch, newest first. The real run returns a background `job` | `anchorChangeId`, `dryRun`, `confirmation_token` (from the dry run), `reason` |
| `lvndr_rollback` | rollback | Undo everything after a restore point, newest first. Returns a background `job` | `pointId`, `confirmation_token` (from `lvndr_preview_rollback`), `reason` |
| `lvndr_dismiss_alert` | read | Dismiss an alert after the user has looked at it | `id` |

## Order of calls for a safe change

```
lvndr_status
lvndr_start_run {agent, task, markRestorePoint: true}      -> run.id, run.restorePointId
  ... change the store with whatever tool ...
lvndr_end_run {id}
(wait 5-10 s)
lvndr_get_run {id}                                          -> changes tagged to the run
  if wrong: lvndr_undo_run {id, dryRun: true}                -> plan + confirmation_token
            show the plan, then lvndr_undo_run {id, dryRun: false, confirmation_token, reason} -> job
            lvndr_get_job {id: job.id} every few seconds until status is done, partial or failed
```

## Background jobs

`lvndr_undo_run` and `lvndr_undo_batch` with `dryRun: false`, and `lvndr_rollback`, do not write
while you wait: they queue a job and return it at once (`status: "queued"`). Poll
`lvndr_get_job {id}` every few seconds until `status` is `done`, `partial` or `failed`, then
report the outcome. Do not call the write tool again while the job is `queued` or `running`; a
second request for the same target returns the job already in progress.

The `confirmation_token` from the dry run or preview is bound to the set of changes it showed.
If changes were added or removed since (new edits arrived, a run picked up more), the write is
refused, or the job ends `failed` with an `error` starting `plan_changed`. Preview again and show
the merchant the new plan.

## Results to check

- Undo of one change: `run.status` is `done`, `partial` or `failed`; each op has `ok` and `errors`.
- Batch and run undo dry runs: `counts` (`planned`, ...), `results[]` for the newest 50 changes,
  `total`, `more` (changes the undo covers that the preview did not plan) and the
  `confirmation_token`.
- Batch, run undo and rollback jobs (`lvndr_get_job`): `done`, `failed`, `skipped` of `total`,
  and `results[]` with `changeId`, `status` and `detail`. One job covers up to 500 changes; when
  `remaining` is above 0, preview and run again for the rest.
- An undo is itself recorded as a change ("lvndr undo") and can be undone.

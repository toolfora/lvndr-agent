# LVNDR MCP tools

Endpoint: `POST https://lvndr.toolfora.com/mcp` (Streamable HTTP, JSON-RPC:
`initialize`, `tools/list`, `tools/call`, `ping`). Auth: MCP OAuth (the client signs in through
the Shopify admin with only the URL) or `Authorization: Bearer <LVNDR_API_KEY>`, the same key as
the REST API. A key carries scopes (`read`, `undo`, `rollback`, `export`, `propose:apply`); new keys and OAuth
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
| `lvndr_coverage` | What is tracked and undoable per record type (`tracked`, `read_only`, `needs_permission`), translations, kept media originals, and the scopes still to grant | none |
| `lvndr_search_changes` | List changes, newest first | `since`, `until` (ISO date-time or how long ago: 30m, 24h, 7d, 2w), `type` (PRODUCT, COLLECTION, PAGE, BLOG, ARTICLE, MENU, THEME, METAFIELD_DEFINITION, REDIRECT, DISCOUNT; any case), `action`, `resourceId` (gid or Product-123), `actor`, `q`, `hideUndos`, `runId`, `limit`, `cursor` |
| `lvndr_get_change` | One change with its full before/after diff and attribution tier | `id` |
| `lvndr_record_history` | Every stored version and change of one record | `resourceId` (gid or Product-123), `cursor` |
| `lvndr_field_edits` | Who last wrote each field of a record (`by`: person, app, agent, lvndr, shopify, unknown). Ask before overwriting a field; skip what a person edited | `resourceId`, `fields` (paths, e.g. `title`, `translations[fr:title]`) |
| `lvndr_get_batch` | Everything one actor did around a change (no gap over 10 minutes) | `anchorChangeId` (any change in the batch) |
| `lvndr_list_restore_points` | Restore points, newest first; the daily check's points only with `kind` sweep or all | `limit`, `cursor`, `kind` (manual, burst, app_install, sweep, all) |
| `lvndr_preview_undo` | Per-field plan for undoing one change: ready, conflict, noop, unsupported, with current and target values. `items` has the same fields in merchant words (field label, current and target as text). Returns the `confirmation_token` for `lvndr_undo` | `id`, `includeConflicts` |
| `lvndr_preview_undo_run` | Plan for undoing every change tagged with a run (the newest 50 planned). Returns the token for `lvndr_undo_run` and `kinds` (each kind of field, e.g. Price) | `id`, `reason`, `runId` (your current run, not the one being undone), `excludeChangeIds`, `fieldKinds` (narrowing: see below) |
| `lvndr_preview_undo_batch` | Plan for undoing one actor's batch. Returns the token for `lvndr_undo_batch` and `kinds` | `anchorChangeId`, `reason`, `runId`, `excludeChangeIds`, `fieldKinds` (narrowing: see below) |
| `lvndr_preview_rollback` | What rolling back to a restore point would undo. Returns the token for `lvndr_rollback` and `kinds` | `pointId`, `excludeChangeIds`, `fieldKinds` (narrowing: see below) |
| `lvndr_list_alerts` | Anomaly alerts (bursts by one actor) | `status` (open, dismissed, resolved, all), `limit` |
| `lvndr_get_run` | One agent run with the changes tagged to it, plus `attributedThrough` and `pendingDeliveries` (how far LVNDR has caught up) | `id`, `limit`, `cursor` |
| `lvndr_list_runs` | Recent agent runs | `limit`, `openOnly` |
| `lvndr_get_job` | Progress of a background undo job (from `lvndr_undo_run`, `lvndr_undo_batch`, `lvndr_undo_selection` or `lvndr_rollback`): status (queued, running, done, partial, failed), total, done, failed, skipped, remaining, error, one result per change | `id` (the job id) |
| `lvndr_list_proposals` | Proposals on the store (open and partly applied by default), to see whether the merchant applied or rejected yours | `status` (open, applied, partly-applied, rejected, expired, all), `limit` |
| `lvndr_get_proposal` | One proposal compared with the live store: each field now, as proposed and as it was when proposed; `changedSince` and status conflict when the store moved since | `id` |
| `lvndr_compare_versions` | What differs between two stored versions of a record, in merchant words | `resourceId` (gid or Product-123), `from`, `to` (version numbers from lvndr_record_history) |
| `lvndr_preview_restore_version` | What restoring a record to an earlier version would write (every differing field: ready, or unsupported with the reason). Returns the token for `lvndr_restore_version` | `resourceId`, `version` |
| `lvndr_list_scheduled_undos` | Undos set to run later; status all also lists the ones that ran (done, skipped with the reason, failed) | `status` (scheduled, done, skipped, failed, cancelled, all), `limit` |
| `lvndr_list_findings` | What agent QA, run budgets and the tug-of-war detector found, worst first (see "Agent QA" below) | `status` (open, dismissed, all), `runId`, `changeId`, `kind` (qa.price_zero, or a family: qa., budget., tugofwar), `limit` |
| `lvndr_get_insights` | One run's or batch's findings, its changes grouped by pattern, and the narrowing that undoes only the flagged changes or only one group | `runId` or `anchorChangeId` (exactly one) |
| `lvndr_plan_undo` | Plain words to a previewed undo: `understood` (how the request was read), the preview, a `confirmation_token` and `writeWith` (the write tool and its arguments) | `query` (the merchant's words) |

## Theme code (scope `read`)

Every file of the live and unpublished themes is tracked (Liquid, CSS, JS, JSON, locales; binary
assets and text over 2 MB by checksum and size only), found by a check every 10 minutes. LVNDR
cannot write theme files itself (Shopify allows `themeFilesUpsert` only to exempted apps), so these
tools read, and the restore runs through the merchant's own Shopify CLI.

| Tool | Use it to | Main arguments |
|---|---|---|
| `lvndr_theme_file_history` | A theme's changes, or one file's, newest first, each with the files it added, removed or modified | `themeId` (digits as Shopify CLI shows them, or OnlineStoreTheme-123), `file` (e.g. sections/header.liquid), `limit`, `cursor` |
| `lvndr_theme_file_at` | One file's full content before (default) or after a change, at a stored version, or at the last check | `file`, `themeId` or `changeId`, `side` (before, after), `version` |
| `lvndr_theme_change_files` | The files one theme change touched with a unified diff each, and `restore`: per file ready, conflict, noop or unsupported, the diff from the file now to its earlier content, `planHash` (`planHashWithConflicts` for a restore with --include-conflicts) and `commands` | `id` (a change to a theme), `files`, `live` (compare with the store now) |

To put theme files back after you broke them: call `lvndr_theme_change_files` with `live: true`,
show the merchant the restore diff, then run (or ask them to run) `restore.commands.restore`
(`lvndr theme restore <changeId>`) in their terminal. It previews again, asks, and pushes exactly
the earlier files with `shopify theme push --only <file> --nodelete`. A file the change added
cannot be pushed back (delete it in the code editor); binary files cannot either.

## Write

| Tool | Scope | Use it to | Main arguments |
|---|---|---|---|
| `lvndr_start_run` | read | Open a run before changing the store; marks a restore point by default. Returns `capture`, `captureNote` and `warning` (set when the run will collect nothing: tell the user) | `task` (recommended), `agent`, `clientId` (used only if it is the key's own OAuth client id), `markRestorePoint` (default true), `budget` (maxRecords, fieldKinds, maxPriceChangePct, autoUndo; see "Run budgets") |
| `lvndr_end_run` | read | Close the run when done | `id` |
| `lvndr_mark_restore_point` | read | Mark a point to roll back to | `label`, `reason`, `runId` |
| `lvndr_undo` | undo | Undo one change (snapshot first, then write), or only some of its fields | `id`, `confirmation_token` (required, from lvndr_preview_undo), `includeConflicts` (must match the preview), `fields` (paths from the preview's `items[].path`; omit for every ready field), `reason`, `runId` |
| `lvndr_undo_run` | undo | Undo every change tagged with a run, newest first. Returns a background `job` | `id`, `confirmation_token` (required, from lvndr_preview_undo_run), `reason`, `runId`, `excludeChangeIds`, `fieldKinds` (narrowing: see below) |
| `lvndr_undo_batch` | undo | Undo one actor's batch, newest first. Returns a background `job` | `anchorChangeId`, `confirmation_token` (required, from lvndr_preview_undo_batch), `reason`, `runId`, `excludeChangeIds`, `fieldKinds` (narrowing: see below) |
| `lvndr_rollback` | rollback | Undo everything after a restore point, newest first. Returns a background `job` | `pointId`, `confirmation_token` (required, from lvndr_preview_rollback), `reason`, `runId`, `excludeChangeIds`, `fieldKinds` (narrowing: see below) |
| `lvndr_dismiss_alert` | undo | Dismiss an alert after the user has looked at it (a read-only key cannot) | `id` |
| `lvndr_propose_changes` | read | Propose field edits for the merchant to review and apply in LVNDR instead of writing them; writes only to LVNDR | `records` (one `{resourceId, changes: {"<field path>": value}}` per record), `title`, `note`, `agent`, `runId` |
| `lvndr_restore_version` | undo | Put a record back to an earlier version (snapshot first), or only some fields of it | `resourceId`, `version`, `confirmation_token` (required, from lvndr_preview_restore_version), `fields` (paths from the preview's `items[].path`), `reason`, `runId` |
| `lvndr_schedule_undo` | undo | Run a previewed undo at a set time; it runs only if the plan is unchanged then, else it is skipped with the reason. A rollback also needs `rollback` | `kind` (change, run, batch, rollback), `targetId`, `runAt` (ISO 8601 with a time zone), `confirmation_token` (required, from the matching preview), `fields`, `includeConflicts`, `excludeChangeIds`, `fieldKinds`, `reason`, `runId` |
| `lvndr_cancel_scheduled_undo` | undo | Cancel a scheduled undo before it runs | `id` |
| `lvndr_undo_selection` | undo | Undo every change matching change-log filters, newest first, as `lvndr_plan_undo` planned it. Returns a background `job` | `filters` (from writeWith.arguments), `confirmation_token` (required, from lvndr_plan_undo), `reason`, `runId`, `excludeChangeIds`, `fieldKinds` |
| `lvndr_dismiss_finding` | undo | Dismiss a QA finding once it is explained or undone (a read-only key cannot) | `id` |
| `lvndr_list_stores` | read | Stores connected to this one (a workspace), with health and what each allowed; any other tool acts on one with `store` |  |
| `lvndr_hub_changes` | read | One change log across every store in the workspace, newest first | `store_filter`, `type`, `kind` (agent, app, staff), `q`, `cursor`, `limit` |
| `lvndr_start_fleet_run` | read | Start a run (and restore point) on many stores, grouped as one fleet run; writes only to LVNDR | `task` (required), `agent`, `stores` ("all" or a list), `markRestorePoint`, `budget` |
| `lvndr_get_fleet_run` | read | One fleet run: each store's run id, changes and latest undo | `id` |
| `lvndr_end_fleet_run` | read | End the fleet run on every store | `id` |
| `lvndr_preview_fleet_undo` | read | Plan undoing a fleet run on each store; returns `confirm` and a `confirmation_token` | `id` |
| `lvndr_undo_fleet_run` | undo | Undo a fleet run on the confirmed stores, each its own job bound to its preview | `id`, `confirm`, `confirmation_token` (required, from lvndr_preview_fleet_undo), `only_stores`, `reason` |
| `lvndr_mark_fleet_point` | read | Mark a restore point on many stores at once; writes only to LVNDR | `label`, `stores` |
| `lvndr_preview_fleet_restore` | read | Plan restoring each store to a fleet restore point; returns `confirm` and a `confirmation_token` | `id` |
| `lvndr_restore_fleet_point` | rollback | Restore the confirmed stores to a fleet restore point, each its own job | `id`, `confirm`, `confirmation_token` (required, from lvndr_preview_fleet_restore), `only_stores`, `reason` |

Workspaces: every tool except the workspace ones (`lvndr_list_stores`, `lvndr_hub_changes` and the `*_fleet_*` tools) takes `store`, a connected store's domain, and then acts on that store; it is refused unless that store allowed it (reading, undo for one change, restore for runs, batches, selections and rollbacks). A fleet preview returns `confirm` (`{store: planHash}`) and one token; pass both back unchanged, with `only_stores` to write fewer. Poll each store's job with `lvndr_get_job` and its `store`.

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

## Narrowing an undo

Undo only what went wrong. On `lvndr_undo`, `fields` takes paths from the preview's `items[].path`
(one variant's price, not the description). On a run, batch or rollback, `fieldKinds` takes kinds
from the preview's `kinds[].kind` ("Price", "Tags") and `excludeChangeIds` leaves changes out.
Preview with the same arguments to show the merchant the narrowed plan; the confirmation token
covers any subset of what it previewed. Whatever is left out stays undoable later.

## Proposals instead of writes

When the merchant should approve a change before it lands (prices, descriptions, translations,
alt text), propose it instead of writing it: `lvndr_propose_changes` with one
`{resourceId, changes: {"<field path>": value}}` per record. Paths are the ones undo previews use
(`title`, `variants[ProductVariant/1].price`, `metafields[Metafield/9].value`); a field LVNDR
cannot write is refused with the reason. Then tell the merchant the proposal waits in LVNDR
(Review) and link `reviewUrl`. They see each field now, as proposed, and whether it changed since
you proposed it, and apply all or part. LVNDR marks a restore point first, and the applied writes
form one agent run named after you, so the whole proposal can be undone as one
(`lvndr_preview_undo_run` with the proposal's `appliedRunId`). Applying is the merchant's
decision: no MCP tool applies a proposal, and a REST key needs the `propose:apply` scope.

## Time travel and scheduled undo

`lvndr_record_history` lists a record's versions; `lvndr_compare_versions` shows what differs
between two of them; `lvndr_preview_restore_version` then `lvndr_restore_version` puts the record
back to one (same token rules as an undo). `lvndr_schedule_undo` runs any previewed undo later
("put the prices back Monday at 9"): pass the preview's `confirmation_token`; at `runAt` LVNDR
previews again and runs it only if nothing moved, otherwise the scheduled undo is `skipped` with
the reason (`lvndr_list_scheduled_undos {status: "all"}`).
## Agent QA

LVNDR checks every change and every run as a whole, a few minutes after attribution:

- per change: a price set to 0 or below, a price moved more than +900% or -90%, text emptied,
  broken HTML;
- per run or batch: prices moved more than the run's `task` says ("raise prices 10%") or far from
  the run's median move, the same text written to many records or a sentence repeated, a language
  switch, SEO title or description over length, a SKU or barcode that breaks its siblings'
  pattern, stock zeroed on many records, and (when the merchant's LVNDR has a model key) a review
  of the task against the diffs;
- a run over its budget, and two actors flipping one field back and forth (`tugofwar`, with
  `tug.sides[i].keep`: the `lvndr_preview_undo` call, `id` and `fields`, that keeps side i).

After your run, call `lvndr_get_insights {runId}`. `flagged.narrowing` and each
`patterns[].narrowing` are `excludeChangeIds` and `fieldKinds` for `lvndr_preview_undo_run`: pass
them, show the merchant the narrowed plan, then `lvndr_undo_run` with the same narrowing. A
pattern group marked `odd` is smaller than the biggest group of its kind ("20 prices +100%" next to
"40 prices +10%"): usually the mistake.

## Run budgets

`lvndr_start_run {budget: {maxRecords, fieldKinds, maxPriceChangePct, autoUndo}}` declares what the
run will do: at most N distinct records, only these kinds of field (as previews name them: Price,
Compare-at price, Tags, ...; a create or delete counts as outside), no price moved more than the
percentage either way. A change that goes over raises a `budget.*` finding and an alert within the
same scheduler tick. With `autoUndo: true` (needs the undo scope) LVNDR also queues a narrowed undo
of the excess: changes beyond `maxRecords` whole, otherwise only the kinds of field that broke the
budget. Stay inside the budget you declared.

## Plain-language plans

`lvndr_plan_undo {query: "undo the price changes Claude made yesterday, except on snowboards"}`
reads who, when, which records, which kinds of field and what to leave out, resolves it to an agent
run or a change-log selection, and previews it. Show the merchant `understood` and the preview. If
they agree, call `writeWith.tool` with `writeWith.arguments` plus the `confirmation_token`. If the
reading is wrong, ask them to rephrase; never write a plan they have not seen.

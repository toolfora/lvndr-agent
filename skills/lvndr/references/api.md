# lvndr REST API and CLI

Base URL: `https://app-production-559c.up.railway.app/api/v1` (set `LVNDR_API_URL` to the app
URL, without `/api/v1`, for another deployment). OpenAPI: `GET /api/v1/openapi.json` (no auth).
Human docs: `/developers`. For language models: `/llms.txt`.

## Auth and headers

| Header | Meaning |
|---|---|
| `Authorization: Bearer lv_...` | API key from lvndr > Settings > Agents & API. Scopes: `read`, `undo`, `rollback`, `export` (below). |
| `X-Lvndr-Agent: <name>` | Who is writing (agent, script, CLI). Shown in the change log and audit log. |
| `X-Lvndr-Run-Id: <runId>` | Tag this write to an open run. Must name a run on the same shop. |
| `Idempotency-Key: <uuid>` | On POST. Replayed for 24 h; the same key with another body is 409. |

Responses carry `X-RateLimit-Limit` and `X-RateLimit-Remaining`; a 429 carries `Retry-After`.
Limits are per key per minute and follow the store's plan (reads/writes): Starter 60/10, Growth
120/20, Scale 300/60, development stores 120/20 (`LVNDR_RATE_READ` / `LVNDR_RATE_WRITE` override
them on a self-hosted deployment). A request to a path that does not exist (404) spends no token.
Failed bearer lookups are limited per IP (30 a minute, then 429). The API is included on every
plan; without an active plan every call is 402 `subscription_required`. Errors are
`{"error": {"code", "message", "status"}}`. Unknown body fields are 400 `unknown_field` (so a typo
such as `plan_hash` is never silently ignored); bodies over 64 KB are 413 `payload_too_large`.

## Scopes

New keys (and OAuth grants that ask for no scope) get `read` and `undo`. `rollback` and `export`
are opt-in when the key is made.

| Scope | Allows |
|---|---|
| `read` | Every GET, plus marking a restore point, starting and ending runs, dismissing alerts |
| `undo` | Undo one change, a batch or a run; a run started with this scope captures every unattributed change |
| `rollback` | Roll the store back to a restore point (marking a point needs only `read`) |
| `export` | Download the change log (`GET /export`, audited) |

## Endpoints

| Method and path | Scope | Body or query | CLI |
|---|---|---|---|
| `GET /me` | read | | `lvndr me` |
| `GET /status` | read | | `lvndr status` |
| `GET /changes` | read | `since, until, type, action, resourceId, actor, q, hideUndos, runId, limit, cursor` -> `{changes, nextCursor}` | `lvndr changes` |
| `GET /changes/:id` | read | | `lvndr change <id>` |
| `POST /changes/:id/undo` | undo | `{dryRun, includeConflicts, planHash, reason}`; `dryRun` defaults to true; `planHash` required when `dryRun` is false; returns `{plan, planHash, run}` | `lvndr undo <id> [--run --plan-hash h]` |
| `GET /records/:gid/history` | read | gid URL-encoded or `Product-123`; `cursor` | `lvndr history <ref>` |
| `GET /batches/:id` | read | | `lvndr batch <id>` |
| `POST /batches/:id/undo` | undo | `{dryRun, planHash, reason}`; dry run 200, real run (with `planHash`) 202 `{job}` | `lvndr undo-batch <id> [--run --plan-hash h]` |
| `GET /restore-points` | read | | `lvndr points` |
| `POST /restore-points` | read | `{label, reason}` | `lvndr mark <label>` |
| `GET /restore-points/:id` | read | one restore point | |
| `GET /restore-points/:id/preview` | read | returns `{preview, planHash}` | `lvndr preview <id>` |
| `POST /restore-points/:id/rollback` | rollback | `{confirm: true, planHash, reason}`, both required; 202 `{pointId, job}` | `lvndr rollback <id> --confirm --plan-hash h` |
| `GET /alerts` | read | `status=open|dismissed|all` (`all` also lists `resolved`), `limit` | `lvndr alerts [--all]` |
| `POST /alerts/:id/dismiss` | read | | `lvndr dismiss <id>` |
| `POST /runs` | read | `{agent, task, clientId, markRestorePoint}` (`markRestorePoint` defaults to true); returns `{run, capture, captureNote}` | `lvndr run start --agent <name>` |
| `GET /runs` | read | `limit, open` | `lvndr run list` |
| `GET /runs/:id` | read | `cursor, limit`; returns `{run, changes, nextCursor, attributedThrough, pendingDeliveries}` | `lvndr run show [id]` |
| `POST /runs/:id/end` | read | | `lvndr run end [id]` |
| `POST /runs/:id/undo` | undo | `{dryRun, planHash, reason}`; dry run 200, real run (with `planHash`) 202 `{job}` | `lvndr run undo [id] [--run --plan-hash h]` |
| `GET /jobs/:id` | read | one background undo job | `lvndr job <id>` |
| `GET /export` | export | `format=csv|json, since, until` | `lvndr export` |
| `GET /openapi.json` | none | | `lvndr openapi` |

## Plan binding (`planHash`)

Every dry run or preview returns `planHash`. Every write must send it back (`dryRun: false`
without `planHash` is 400 `plan_required`: dry-run first), which binds the write to what was
shown:

- single undo: the write is refused with 409 `plan_changed` if the per-field plan moved since
  the dry run (someone edited the record again);
- run undo, batch undo and rollback: the hash covers the set of change ids. The write is refused
  with 409 `plan_changed` if changes were added or removed since the preview, and the job itself
  checks again before it starts (it then ends `failed` with an `error` starting `plan_changed`).

Preview again on `plan_changed`. The CLI sends `--plan-hash`, which every preview prints.

## Runs: capture and freshness

`POST /runs` answers `capture` and `captureNote`. A key with `undo` opens a catch-all run
(`all-unattributed`): every change Shopify leaves unattributed or only inferred while it is open
(up to 24 h), staff edits included. A key without `undo` gets `client` (only changes linked to its
own OAuth client) or `none` (a Settings key: nothing is captured). `clientId` is used only when it
equals the key's own OAuth client id; the run is then `client` whatever the key's scopes.
Otherwise it is ignored and `captureNote` says so.

Changes are tagged within about 4 minutes (collection rules, SEO, menus and themes up to 10, from a
10-minute check). After your last write, poll `GET /runs/:id` about every 20 s until
`attributedThrough` is after that write and `pendingDeliveries` is 0, then review the changes.

## Background jobs

`POST /runs/:id/undo` and `POST /batches/:id/undo` with `dryRun: false`, and
`POST /restore-points/:id/rollback`, answer **202** with `{job}` (plus `runId`, `anchorId` or
`pointId`). Nothing has been written yet. Poll `GET /jobs/:id` (scope `read`) every few seconds:

```json
{"job": {"id": "...", "kind": "run", "targetId": "...", "status": "running",
         "total": 40, "done": 12, "failed": 0, "skipped": 1, "remaining": 0, "error": null,
         "createdAt": "...", "startedAt": "...", "finishedAt": null, "results": [...]}}
```

`status` goes `queued` -> `running` -> `done` | `partial` | `failed`. `results[]` has one entry
per change handled so far (`changeId`, `status`, `detail`). One job covers up to 500 changes;
`remaining` counts the rest, so undo again after it finishes. Asking again for a target whose job
is still queued or running returns that job. The dry run plans the newest 50 changes and reports
`total` and `more` (covered by the undo but not planned in the preview).

## CLI conventions

- Every undo command previews unless `--run`, and `--run` needs `--plan-hash <hash>` (printed by
  the preview); without it the CLI fails with `preview first: lvndr undo <id>`. `rollback` needs
  `--confirm --plan-hash <hash>` (preview with `lvndr preview <pointId>`). `--yes` previews and
  writes in one go, for a person at a terminal only (refused when stdin is not a TTY).
- `undo-batch`, `run undo` and `rollback` writes wait for the job: progress on stderr every 2 s,
  the finished job on stdout, exit 0 for `done`, 2 for `partial` or `failed`.
- `lvndr <command> --help` prints that command's usage.
- `--json` prints the API response as one compact JSON line on stdout and nothing else; errors
  in `--json` mode are `{"error": {...}}` on stdout. `--ndjson` prints list items one per line.
  `--quiet` prints only ids.
- `lvndr guard -- <command...>` starts a run with a restore point, runs the command with
  `LVNDR_RUN_ID` set, ends the run, polls the run until it is attributed (`--wait`, default
  300 s), lists its changes and prints the undo preview line.
  Its report goes to stderr; the command's own stdout is untouched; it exits with the
  command's exit code.
- Time flags take `30m`, `24h`, `7d`, `2w` or an ISO timestamp.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | OK (an undo preview is OK) |
| 1 | Usage error (including `--run` without `--plan-hash`), bad parameter, or server error |
| 2 | Undo, batch undo, run undo or rollback was partial or failed |
| 3 | Auth: no key, 401 (missing, revoked or expired key), 403 (`insufficient_scope` or `not_installed`) |
| 4 | Not found |
| 5 | Rate limited after retries |
| 6 | Network: could not reach the app |
| 7 | Conflict (409): `plan_changed` (preview again) or an undo already running |
| 8 | Plan required (402): the store's lvndr plan does not include the API |

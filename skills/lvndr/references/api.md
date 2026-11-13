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
120/20, Scale 300/60, development stores 120/20. The API is included on every plan; without an
active plan every call is 402. Errors are `{"error": {"code", "message", "status"}}`.

## Scopes

New keys (and OAuth grants that ask for no scope) get `read` and `undo`. `rollback` and `export`
are opt-in when the key is made.

| Scope | Allows |
|---|---|
| `read` | Every GET, plus runs (start, end), dismissing alerts |
| `undo` | Undo one change, a batch or a run |
| `rollback` | Roll the store back to a restore point (marking a point needs only `read`) |
| `export` | Download the change log (`GET /export`, audited) |

## Endpoints

| Method and path | Scope | Body or query | CLI |
|---|---|---|---|
| `GET /me` | read | | `lvndr me` |
| `GET /status` | read | | `lvndr status` |
| `GET /changes` | read | `since, until, type, action, resourceId, actor, q, hideUndos, runId, limit, cursor` -> `{changes, nextCursor}` | `lvndr changes` |
| `GET /changes/:id` | read | | `lvndr change <id>` |
| `POST /changes/:id/undo` | undo | `{dryRun, includeConflicts, planHash, reason}`; `dryRun` defaults to true; returns `{plan, planHash, run}` | `lvndr undo <id> [--run]` |
| `GET /records/:gid/history` | read | gid URL-encoded or `Product-123`; `cursor` | `lvndr history <ref>` |
| `GET /batches/:id` | read | | `lvndr batch <id>` |
| `POST /batches/:id/undo` | undo | `{dryRun, planHash, reason}`; dry run 200, real run 202 `{job}` | `lvndr undo-batch <id> [--run]` |
| `GET /restore-points` | read | | `lvndr points` |
| `POST /restore-points` | read | `{label, reason}` | `lvndr mark <label>` |
| `GET /restore-points/:id/preview` | read | returns `{preview, planHash}` | `lvndr preview <id>` |
| `POST /restore-points/:id/rollback` | rollback | `{confirm: true, planHash, reason}`; 202 `{pointId, job}` | `lvndr rollback <id> --confirm` |
| `GET /alerts` | read | `status=open|dismissed|all` | `lvndr alerts [--all]` |
| `POST /alerts/:id/dismiss` | read | | `lvndr dismiss <id>` |
| `POST /runs` | read | `{agent, task, clientId, markRestorePoint}` | `lvndr run start --agent <name>` |
| `GET /runs` | read | `limit, open` | `lvndr run list` |
| `GET /runs/:id` | read | `cursor, limit` | `lvndr run show [id]` |
| `POST /runs/:id/end` | read | | `lvndr run end [id]` |
| `POST /runs/:id/undo` | undo | `{dryRun, planHash, reason}`; dry run 200, real run 202 `{job}` | `lvndr run undo [id] [--run]` |
| `GET /jobs/:id` | read | one background undo job | `lvndr job <id>` |
| `GET /export` | export | `format=csv|json, since, until` | `lvndr export` |
| `GET /openapi.json` | none | | `lvndr openapi` |

## Plan binding (`planHash`)

Every dry run or preview returns `planHash`. Send it back with the write to bind the write to
what was shown:

- single undo: the write is refused with 409 `plan_changed` if the per-field plan moved since
  the dry run (someone edited the record again);
- run undo, batch undo and rollback: the hash covers the set of change ids. The write is refused
  with 409 `plan_changed` if changes were added or removed since the preview, and the job itself
  checks again before it starts (it then ends `failed` with an `error` starting `plan_changed`).

Preview again on `plan_changed`. Without `planHash` the write uses whatever the plan is at that
moment. The CLI sends it for a single `undo --run` (it previews first) and for `--plan-hash`.

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

- Every undo command previews unless `--run`; `rollback` refuses without `--confirm`.
- `undo-batch --run`, `run undo --run` and `rollback --confirm` wait for the job: progress on
  stderr every 2 s, the finished job on stdout, exit 0 for `done`, 2 for `partial` or `failed`.
  `--plan-hash <hash>` (printed by the preview) binds the write to that preview.
- `--json` prints the API response as one compact JSON line on stdout and nothing else; errors
  in `--json` mode are `{"error": {...}}` on stdout. `--ndjson` prints list items one per line.
  `--quiet` prints only ids.
- `lvndr guard -- <command...>` starts a run with a restore point, runs the command with
  `LVNDR_RUN_ID` set, ends the run, lists its changes and prints `lvndr run undo <id> --run`.
  Its report goes to stderr; the command's own stdout is untouched; it exits with the
  command's exit code.
- Time flags take `30m`, `24h`, `7d`, `2w` or an ISO timestamp.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | OK (an undo preview is OK) |
| 1 | Usage error, bad parameter, conflict (409, e.g. `plan_changed`), or server error |
| 2 | Undo, batch undo, run undo or rollback was partial or failed |
| 3 | Auth: 401 (key), 402 (no active lvndr plan), 403 (scope or app not installed) |
| 4 | Not found |
| 5 | Rate limited after retries |
| 6 | Network: could not reach the app |

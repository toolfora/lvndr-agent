# lvndr CLI

The command line for [lvndr](https://github.com/kasazen/lvndr-agent), the store time machine for
Shopify: the change log, undo by change, batch or run, restore points and rollback, anomaly
alerts and agent runs. One file, no dependencies, Node 20 or newer. It talks to the lvndr REST API
(`/api/v1`) with an API key.

## Install

```sh
npx lvndr status          # run without installing
npm i -g lvndr            # or install the `lvndr` command
```

From a checkout of [kasazen/lvndr-agent](https://github.com/kasazen/lvndr-agent): `node cli/lvndr.mjs <command>`
(in the lvndr app repository the same file is `agent-kit/cli/lvndr.mjs`).

## Log in

Create a key in the app: **lvndr > Settings > API keys** (starts with `lv_`, shown once). A key
has scopes: `read`, `undo`, `rollback`, `export`. New keys get `read` and `undo`; tick
`rollback` (mark restore points, roll back) and `export` (download the change log) when the key
needs them. The API, MCP and this CLI are included on every lvndr plan and free on development
stores; requests per minute per key follow the plan (reads/writes: Starter 60/10, Growth 120/20,
Scale 300/60, development stores 120/20).

```sh
lvndr login                                  # prompts for the key, checks it with GET /me
lvndr login --key lv_... --profile staging --url https://my-tunnel.example.com
```

`login` writes `~/.config/lvndr/config.json` (mode 600; `$XDG_CONFIG_HOME` and `$LVNDR_CONFIG`
are honoured) with one entry per profile. The first profile saved becomes the default.

Where each setting comes from, first match wins:

| Setting | Flag | Environment | Profile | Default |
|---|---|---|---|---|
| API key | `--key` | `LVNDR_API_KEY` | `key` | none (exit 3) |
| App URL | `--url` | `LVNDR_API_URL` | `url` | `https://app-production-559c.up.railway.app` |
| Profile | `--profile` | `LVNDR_PROFILE` | | `defaultProfile`, else `default` |
| Agent name (`X-Lvndr-Agent`) | `--agent` | `LVNDR_AGENT` | `agent` | `lvndr-cli` |
| Run id (`X-Lvndr-Run-Id`) | `--run-id` | `LVNDR_RUN_ID` | | none |

## Commands

Undo commands preview unless `--run` is given. `rollback` refuses without `--confirm`.
`undo-batch --run`, `run undo --run` and `rollback --confirm` start a background job on the
server and wait for it (see [Background jobs](#background-jobs)).

| Command | What it does |
|---|---|
| `lvndr me` | Shop, key label, scopes and plan |
| `lvndr status` | Plan, tracked record counts, last activity check, pending deliveries |
| `lvndr changes [filters]` | Changes, newest first. Filters: `--since`, `--until`, `--type`, `--action`, `--resource-id`, `--actor`, `--q`, `--hide-undos`, `--run-id`, `--limit`, `--cursor` |
| `lvndr change <id>` | One change with its diff and attribution tier |
| `lvndr history <gid\|Type-digits>` | A record's stored versions and changes (`Product-123`, `gid://shopify/Product/123`) |
| `lvndr undo <id> [--run] [--include-conflicts] [--plan-hash h] [--reason text]` | Preview, or with `--run` write, the undo of one change. `--run` previews first and sends that plan's `planHash`, so the write is refused if the store moved in between; pass `--plan-hash` from an earlier preview to bind it to what you saw |
| `lvndr batch <id>` | Everything the same actor did around a change, no gap over 10 minutes |
| `lvndr undo-batch <id> [--run] [--plan-hash h] [--reason text]` | Preview or undo that batch, newest first (a job) |
| `lvndr points` | Restore points |
| `lvndr mark <label...> [--reason text]` | Mark a restore point now |
| `lvndr preview <pointId>` | What rolling back to a point would undo |
| `lvndr rollback <pointId> --confirm [--plan-hash h] [--reason text]` | Undo everything after the point, newest first (a job) |
| `lvndr job <id>` | One background undo job: status, counts and per-change results |
| `lvndr alerts [--all]` | Open anomaly alerts (`--all` adds dismissed ones) |
| `lvndr dismiss <alertId>` | Dismiss an alert |
| `lvndr run start --agent <name> [--task text] [--client-id id] [--no-restore-point]` | Open an agent run with a restore point; saves it as the current run for the profile |
| `lvndr run end [id]` | End the run (default: the current run) |
| `lvndr run show [id]` | The run and the changes tagged to it |
| `lvndr run list` | Recent runs |
| `lvndr run undo [id] [--run] [--plan-hash h] [--reason text]` | Preview or undo every change in the run (a job) |
| `lvndr export [--format csv\|json] [--since] [--until] [--out file]` | Download the change log |
| `lvndr guard [--agent name] [--task text] [--wait 5] -- <command...>` | Run a command inside a run with a restore point (below) |
| `lvndr login` | Save a profile |
| `lvndr openapi` | Print the OpenAPI document |
| `lvndr help`, `lvndr --version` | |

Time flags accept `30m`, `24h`, `7d`, `2w` or an ISO timestamp. `--type` takes `PRODUCT`,
`COLLECTION`, `PAGE`, `BLOG`, `ARTICLE`, `MENU`, `THEME`, `METAFIELD_DEFINITION` in any case.
For `run end`, `run show` and `run undo` the id defaults to `--run-id`, then `LVNDR_RUN_ID`, then
the run saved by `run start`.

### Global flags

| Flag | Effect |
|---|---|
| `--json` | Print the API response as one compact JSON line on stdout, nothing else. Errors become `{"error":{...}}` on stdout. |
| `--ndjson` | For list commands, one JSON object per line. |
| `--quiet`, `-q` | Print only ids (for `mark`, `run start`, lists), nothing on success otherwise. |
| `--key`, `--url`, `--profile`, `--agent`, `--run-id` | See the table above. |
| `--no-retry` | Fail on the first 429 instead of waiting for `Retry-After` (up to 3 retries, 60 s each). |
| `--timeout <s>` | Request timeout, default 120 s. |

Every POST carries a fresh `Idempotency-Key`, reused on retries, so a retried write is not
applied twice.

## Background jobs

A run undo, batch undo or rollback can cover hundreds of changes, so the API queues it and
answers `202 { job }`. The CLI then polls `GET /api/v1/jobs/:id` every 2 seconds (waiting out
`Retry-After` on a 429) until the job is `done`, `partial` or `failed`:

- progress goes to stderr when it moves: `lvndr: job <id> running: 12 done, 0 failed, 1 skipped of 40`;
- the final job goes to stdout (with `--json`, one line: the 202 response with `job` replaced by
  the finished job);
- the exit code is 0 for `done` and 2 for `partial` or `failed`.

Interrupting the CLI does not stop the job; check it later with `lvndr job <id>`. A job covers up
to 500 changes; when there are more, `remaining` says how many, and running the same command
again undoes the rest.

The preview of a batch, run or rollback prints its `planHash` and the command that runs exactly
that plan, for example `lvndr run undo <id> --run --plan-hash <hash>`. With `--plan-hash`, the
job is refused (409 `plan_changed`, exit 1) or fails with `plan_changed` if changes were added
to or removed from the set since the preview; preview again. `LVNDR_POLL_MS` changes the polling
interval.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | OK. An undo preview is OK. |
| 1 | Usage error, bad parameter (400), conflict such as `plan_changed` (409), or server error |
| 2 | Undo, batch undo, run undo or rollback finished `partial` or `failed` (also `lvndr job` on such a job) |
| 3 | Auth: no key, 401 (bad or revoked key), 402 (no active lvndr plan), 403 (missing scope, app uninstalled) |
| 4 | Not found (404) |
| 5 | Rate limited (429) after retries |
| 6 | Network: the app could not be reached |

`guard` exits with the wrapped command's exit code.

## Guard: a run around any command

`guard` starts a run with a restore point, runs the command with inherited stdio and
`LVNDR_RUN_ID` / `LVNDR_AGENT` in its environment, ends the run, waits `--wait` seconds (default
5, Shopify delivers change events a few seconds late), lists the run's changes and prints the
exact undo line. Its own report goes to stderr, so the command's stdout is untouched. If the run
cannot be started, the command is not run.

```sh
$ lvndr guard --agent bulk-price-fix -- shopify store execute --allow-mutations \
    --store example.myshopify.com --query-file raise-prices.graphql
lvndr: run cm9run0000000000000000001 started, restore point cm9pt00000000000000000001
... shopify output ...
lvndr: command exited 0; run cm9run0000000000000000001 ended; 3 change(s) recorded so far
cm9ch00000000000000000001  2026-11-13 10:02:11 PRODUCT    update The Minimal Snowboard ...
To preview the undo:  lvndr run undo cm9run0000000000000000001
To undo this run:     lvndr run undo cm9run0000000000000000001 --run
```

Changes made by other tools are tagged to the run by the server; writes made through the lvndr
API inside the command (for example a nested `lvndr` call) carry `X-Lvndr-Run-Id` from
`LVNDR_RUN_ID`. If changes show up late, `lvndr run show <id>` lists them again.

## Scripting

```sh
# ids of everything changed in the last hour by an inferred actor
lvndr changes --since 1h --ndjson | jq -r 'select(.actor.tier == "inferred") | .id'

# a run around a multi-step job
RUN=$(lvndr run start --agent nightly-import --task "supplier feed" --quiet)
export LVNDR_RUN_ID=$RUN
./import.sh
lvndr run end
lvndr run show "$RUN" --json | jq '.changes | length'

# fail a pipeline when an undo does not complete
lvndr undo "$CHANGE" --run --reason "bad import" --quiet || echo "undo exit $?"
```

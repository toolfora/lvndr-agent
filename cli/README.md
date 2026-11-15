# LVNDR CLI

The command line for [lvndr](https://github.com/toolfora/lvndr-agent), the store time machine for
Shopify: the change log, undo by change, batch or run, restore points and rollback, anomaly
alerts and agent runs. One file, no dependencies, Node 20 or newer. It talks to the LVNDR REST API
(`/api/v1`) with an API key.

## Install

```sh
npm i -g @toolfora/lvndr   # once: installs the `lvndr` command
lvndr status
```

From a checkout of [toolfora/lvndr-agent](https://github.com/toolfora/lvndr-agent): `node cli/lvndr.mjs <command>`
(in the LVNDR app repository the same file is `agent-kit/cli/lvndr.mjs`).

## Log in

Create a key in the app: **LVNDR > Settings > Agents & API** (starts with `lv_`, shown once). A
key has scopes: `read`, `undo`, `rollback`, `export`. New keys get `read` and `undo`; tick
`rollback` (roll the store back to a restore point) and `export` (download the change log) when
the key needs them. Marking a restore point and starting a run need only `read`. The API, MCP and this CLI are included on every LVNDR plan and free on development
stores; requests per minute per key follow the plan (reads/writes: Starter 60/10, Growth 120/20,
Scale 300/60, development stores 120/20 once billing is on; during early access every store gets
the top rate, 300/60).

```sh
lvndr login                                  # prompts for the key (not echoed), checks it with GET /me
lvndr login --with-token < key.txt           # reads the key from stdin (scripts, CI)
lvndr login --key lv_... --profile staging --url https://my-tunnel.example.com
lvndr login --key lv_... --agent nightly-import --no-verify   # save an agent name; skip the GET /me check
```

`login` writes `~/.config/lvndr/config.json` (mode 600; `$XDG_CONFIG_HOME` and `$LVNDR_CONFIG`
are honoured) with one entry per profile. The first profile saved becomes the default.

Where each setting comes from, first match wins:

| Setting | Flag | Environment | Profile | Default |
|---|---|---|---|---|
| API key | `--key` | `LVNDR_API_KEY` | `key` | none (exit 3) |
| App URL | `--url` | `LVNDR_API_URL` | `url` | `https://lvndr.toolfora.com` |
| Profile | `--profile` | `LVNDR_PROFILE` | | `defaultProfile`, else `default` |
| Agent name (`X-Lvndr-Agent`) | `--agent` | `LVNDR_AGENT` | `agent` | `lvndr-cli` (`guard`: `lvndr-guard`) |
| Run id (`X-Lvndr-Run-Id`) | `--run-id` | `LVNDR_RUN_ID` | | none |

## Commands

Every write is bound to a plan someone saw. The undo commands preview by default and print the
`planHash` of what they would write, with the exact command that writes it:

```sh
lvndr undo cm3abc                               # preview; ends with the line below
lvndr undo cm3abc --run --plan-hash q3Xl0c2V    # write exactly that plan
```

`--run` without `--plan-hash` writes nothing and fails with `preview first: lvndr undo <id>`. The
same holds for `undo-batch <id> --run --plan-hash h`, `run undo [id] --run --plan-hash h` and
`rollback <pointId> --confirm --plan-hash h` (preview a rollback with `lvndr preview <pointId>`).
If the store moved since the preview, the write is refused with `plan_changed` (exit 7); preview
again.

`--yes` is for a person at a terminal: it previews, prints the preview once, asks `Apply? [y/N]`
and writes that exact plan only on yes. A preview with nothing to write says "Nothing to undo" and
prints no write command. It is refused when stdin is not a terminal, so scripts and agents always preview and
pass `--plan-hash`. It works on `undo`, `undo-batch`, `run undo` and `rollback`.

`undo-batch`, `run undo` and `rollback` writes start a background job on the server and wait for
it (see [Background jobs](#background-jobs)). `lvndr <command> --help` (or `lvndr help <command>`)
prints one command's usage.

| Command | What it does |
|---|---|
| `lvndr me` | Shop, key label, scopes and plan |
| `lvndr status` | Plan, tracked record counts, last activity check, pending deliveries |
| `lvndr changes [filters]` | Changes, newest first. Filters: `--since`, `--until`, `--type`, `--action`, `--resource-id`, `--actor`, `--q`, `--hide-undos`, `--run-id`, `--limit`, `--cursor` |
| `lvndr change <id>` | One change with its diff and attribution tier |
| `lvndr history <gid\|Type-digits>` | A record's stored versions and changes (`Product-123`, `gid://shopify/Product/123`) |
| `lvndr undo <id> [--run --plan-hash h \| --yes] [--include-conflicts] [--reason text]` | Preview the undo of one change, or write the previewed plan |
| `lvndr batch <id>` | Everything the same actor did around a change, no gap over 10 minutes |
| `lvndr undo-batch <id> [--run --plan-hash h \| --yes] [--reason text]` | Preview or undo that batch, newest first (a job) |
| `lvndr points [--all \| --kind k] [--limit n] [--cursor c]` | Restore points (the daily check's only with `--all`) |
| `lvndr mark <label...> [--reason text]` | Mark a restore point now |
| `lvndr preview <pointId>` | What rolling back to a point would undo |
| `lvndr rollback <pointId> (--confirm --plan-hash h \| --yes) [--reason text]` | Undo everything after the point, newest first (a job); preview with `lvndr preview` |
| `lvndr job <id>` | One background undo job: status, counts and per-change results |
| `lvndr alerts [--all]` | Open anomaly alerts (`--all` adds dismissed and resolved ones) |
| `lvndr dismiss <alertId>` | Dismiss an alert |
| `lvndr run start [--agent name] [--task text] [--client-id id] [--no-restore-point]` | Open an agent run with a restore point; saves it as the current run for the profile and prints what the run will capture (a WARNING when it captures nothing) |
| `lvndr run end [id]` | End the run (default: the current run) |
| `lvndr run show [id]` | The run and the changes tagged to it |
| `lvndr run list` | Recent runs |
| `lvndr run undo [id] [--run --plan-hash h \| --yes] [--reason text]` | Preview or undo every change in the run (a job) |
| `lvndr export [--format csv\|json] [--since] [--until] [--out file]` | Download the change log |
| `lvndr guard [--agent name] [--task text] [--client-id id] [--no-restore-point] [--wait 300] -- <command...>` | Run a command inside a run with a restore point (below) |
| `lvndr login [--key k \| --with-token] [--url u] [--profile p] [--agent a] [--no-verify]` | Save a profile (checks the key with `GET /me` unless `--no-verify`; the key is not echoed; `--with-token` reads it from stdin) |
| `lvndr openapi` | Print the OpenAPI document |
| `lvndr help [command]`, `lvndr <command> --help`, `lvndr --version` | All commands, or one command's usage |

Time flags accept `30m`, `24h`, `7d`, `2w` or an ISO timestamp. `--type` takes `PRODUCT`,
`COLLECTION`, `PAGE`, `BLOG`, `ARTICLE`, `MENU`, `THEME`, `METAFIELD_DEFINITION` in any case.
For `run end`, `run show` and `run undo` the id defaults to `--run-id`, then `LVNDR_RUN_ID`, then
the run saved by `run start`.

`run start` prints what the run will capture. A key with the `undo` scope opens a catch-all run
(`all-unattributed`: every change Shopify leaves unattributed or only inferred, staff edits
included, for up to 24 hours). A key without `undo` gets a run that captures only changes linked
to its own OAuth client (`client`), or nothing (`none`) for a Settings key. `--client-id` is used
only when it is the key's own OAuth client id, and then the run is `client`.

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
job is refused (409 `plan_changed`, exit 7) or fails with `plan_changed` if changes were added
to or removed from the set since the preview; preview again. `LVNDR_POLL_MS` changes the polling
interval.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | OK. An undo preview is OK. |
| 1 | Usage error (including `--run` without `--plan-hash`), bad parameter (400), or server error |
| 2 | Undo, batch undo, run undo or rollback finished `partial` or `failed` (also `lvndr job` on such a job) |
| 3 | Auth: no key, 401 (bad, revoked or expired key), 403 (missing scope, app not installed) |
| 4 | Not found (404) |
| 5 | Rate limited (429) after retries |
| 6 | Network: the app could not be reached |
| 7 | Conflict (409): `plan_changed` (preview again) or an undo already running |
| 8 | Plan required (402): the store's LVNDR plan does not include the API |

`guard` exits with the wrapped command's exit code.

## Guard: a run around any command

`guard` checks the command exists (exit 127 and nothing started when it does not), starts a run
with a restore point, runs the command with inherited stdio and
`LVNDR_RUN_ID` / `LVNDR_AGENT` in its environment and ends the run. Changes are tagged within about
4 minutes (collection rules, SEO, menus and themes up to 10, from a 10-minute check), so it
then polls `GET /api/v1/runs/:id` about every 20 seconds until `attributedThrough` is after the
run's end and `pendingDeliveries` is 0, for at most `--wait` seconds (default 300; `--wait 0`
skips waiting), printing each change as it is tagged, the seconds waited and what it still waits
for. Then it lists the run's changes and prints the undo line; if attribution has not
caught up by then, it says so and names `lvndr run show <id>`. Its own report goes to stderr (with
`--json`, one JSON line on stderr), so the command's stdout is untouched. If the run cannot be
started, the command is not run.

```sh
$ lvndr guard --agent bulk-price-fix -- shopify store execute --allow-mutations \
    --store example.myshopify.com --query-file raise-prices.graphql
lvndr: run cm9run0000000000000000001 started, restore point cm9pt00000000000000000001
lvndr: capture all-unattributed: This run records every change Shopify left unattributed ...
... shopify output ...
lvndr: command exited 0; run cm9run0000000000000000001 ended; 3 change(s) tagged
cm9ch00000000000000000001  2026-11-13 10:02:11 PRODUCT    update The Minimal Snowboard ...
To preview the undo:  lvndr run undo cm9run0000000000000000001   (it prints the --run --plan-hash line that runs it)
```

Changes made by other tools are tagged to the run by the server; writes made through the LVNDR
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
HASH=$(lvndr undo "$CHANGE" --json | jq -r .planHash)
lvndr undo "$CHANGE" --run --plan-hash "$HASH" --reason "bad import" --quiet || echo "undo exit $?"
```

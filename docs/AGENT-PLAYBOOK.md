# Agent playbook

For the person who lets AI agents, scripts or other automation change a Shopify store that has
lvndr installed. It covers how to give an agent access, how to keep its work reversible, how to
hear about trouble and what to do when an agent goes wrong. The agent-side instructions are in
[`skills/lvndr/SKILL.md`](../skills/lvndr/SKILL.md).

## 1. Give each agent its own key

Create keys in **lvndr > Settings > Agents & API**. The key is shown once and stored only as a hash.
One key per agent or pipeline: the key id is recorded on every undo, restore point and export it
makes, and revoking one key does not stop the others.

| Scopes | Use for | Can |
|---|---|---|
| `read` | Reporting agents, dashboards, "what changed?" questions | Read changes, history, batches, restore points, alerts; mark restore points; start and end runs (a run from a read-only key captures nothing unless it is an OAuth token, see below); dismiss alerts |
| `read` + `undo` | Agents that may fix their own mistakes | Also undo one change, a batch or a run; its runs capture every unattributed change while open |
| `read` + `undo` + `rollback` | Operators who may need to roll the whole store back to a moment | Also roll back to a restore point (marking one needs only `read`) |
| `export` | Backups and audits | Download the change log as CSV or JSON |

Every key has `read`. New keys (and OAuth grants that ask for no scope) get `read` and `undo`;
`rollback` and `export` are opt-in. Start an agent on `read` and add scopes when it has earned them. A
read-only key cannot write to the store through lvndr, but lvndr does not control the agent's
other tools (its Shopify Admin token, the Shopify CLI): lvndr records and reverses, it does not
block.

Runs and capture: a run started by a key with `undo` is catch-all (`capture: "all-unattributed"`):
while it is open (up to 24 hours) it takes every change Shopify leaves unattributed or only
inferred, staff edits included. A run from a key without `undo` captures only changes linked to
its own OAuth client (`client`) or nothing (`none`), so a read-only key cannot sweep other
people's edits into a run that someone might later undo as one. The start response says which in
`capture` and `captureNote`.

Set the agent's name: the CLI sends `--agent` / `LVNDR_AGENT`, any HTTP client can send
`X-Lvndr-Agent`. Runs, undos and restore points then show who asked.

## 2. Wrap every writing session in a run

A run is an agent's unit of work: it has an agent name, a task, an optional restore point and the
changes tagged to it. Undoing a run reverts exactly those changes, newest first, and leaves
everything else alone.

- MCP: `lvndr_start_run` (`markRestorePoint: true`) ... `lvndr_end_run`.
- CLI: `lvndr run start --agent <name> --task "<task>"` ... `lvndr run end`.
- One command: `lvndr guard --agent <name> -- <command...>` starts the run with a restore point,
  runs the command with `LVNDR_RUN_ID` set, ends the run, waits (up to `--wait`, default 300 s)
  until the run's changes are attributed, lists what changed and prints the undo preview line. It
  exits with the command's exit code.

```sh
lvndr guard --agent price-bot -- shopify store execute --allow-mutations \
  --store example.myshopify.com --query-file update-prices.graphql
```

Runs show in the app under **Runs**. Changes are tagged to a run within about 4 minutes; collection
rules, SEO, menus and themes come from a 10-minute check, and alt text from the daily sweep. Before
calling a run clean, poll `lvndr_get_run` / `GET /api/v1/runs/:id` about every 20 seconds until
`attributedThrough` is after the last write and `pendingDeliveries` is 0.

## 3. Hear about trouble

lvndr raises an anomaly alert when one actor changes more than the shop's threshold of records
(default 10 in 10 minutes). Actors that look like agents, CLIs or automation trip it at half the
threshold (minimum 3). Alerts appear as a banner on the change log, by email when an alert address
is set, and by webhook.

**Alert webhook.** In **Settings**, set an https URL. lvndr POSTs each new or growing burst as
JSON with `X-Lvndr-Event: alert.burst` and `X-Lvndr-Signature: sha256=<hex>`, an HMAC-SHA256 of
the raw body with the webhook secret shown in Settings:

```json
{
  "type": "alert.burst",
  "shop": "example.myshopify.com",
  "alert": { "id": "...", "actorLabel": "price-bot", "count": 42, "windowStart": "...", "windowEnd": "...", "anchorChangeId": "...", "resourceTypes": ["PRODUCT"], "status": "open" },
  "batchUrl": "https://admin.shopify.com/store/example/apps/.../app/batches/...",
  "sentAt": "..."
}
```

Verify the signature over the raw body before acting on it. A receiver can page someone, post to
chat, or call `lvndr batch <anchorChangeId>` to list the burst.

## 4. When an agent goes wrong

1. **Stop the agent.** Revoke its key in Settings if it may keep going; revoke its Shopify access
   too if it writes through its own token.
2. **Find the damage.** `lvndr alerts`, then `lvndr run show <runId>` or
   `lvndr batch <anchorChangeId>`, or `lvndr changes --since 1h --actor <name>`. Check the
   attribution tier: field edits are `inferred`, so confirm the actor before blaming one.
3. **Pick the narrowest undo.**

   | Situation | Command |
   |---|---|
   | One bad field or record | `lvndr undo <changeId>`, then `--run --plan-hash <hash>` |
   | Everything the agent's run did | `lvndr run undo <runId>`, then `--run --plan-hash <hash>` |
   | A burst by one actor with no run | `lvndr undo-batch <changeId>`, then `--run --plan-hash <hash>` |
   | The store must go back to a moment, whoever changed it | `lvndr preview <pointId>`, then `lvndr rollback <pointId> --confirm --plan-hash <hash>` |

   Each preview prints the exact write command with its `--plan-hash`. At a terminal, `--yes`
   previews, prints the preview and writes it in one go.

   Always read the preview. `conflict` means the field changed again later (someone may have
   fixed it already); `unsupported` means lvndr cannot write that field and shows the earlier
   value for a manual fix. A rollback also reverts other people's changes after the point.
   Add `--reason` so the audit log says why.
4. **Check the result.** Exit code 2 means partial or failed: read each result's `detail` and
   re-preview; exit 7 means the store moved since the preview (`plan_changed`), so preview again.
   `run undo`, `undo-batch` and `rollback` writes run as a background
   job: the CLI polls it and prints progress; `lvndr job <id>` checks it later. A job that
   reports `remaining` needs another pass. Undos are changes too and can themselves be undone.
5. **Dismiss the alert** (`lvndr dismiss <alertId>`) once handled.

## Limits to tell people about

- Themes are tracked but not written back; lvndr shows the earlier value for a manual restore.
- Orders, customers and other protected data are not tracked.
- An undone delete comes back with a new id and without inventory history.
- Shopify never names the staff member behind a field edit; per-edit names are not available.
- Changes older than the plan's retention cannot be undone.

#!/usr/bin/env node
/* eslint-env node */
/**
 * lvndr CLI: the Shopify store change log, undo and restore points from a terminal or an agent.
 * One file, no dependencies, Node 20+. Talks to the public REST API (`/api/v1`) with an API key
 * made in lvndr > Settings > API keys.
 *
 *   lvndr login                         # saves a profile to ~/.config/lvndr/config.json
 *   lvndr guard -- <command...>         # restore point + run around any command, then the undo line
 *   lvndr help                          # every command
 *
 * Run, batch and rollback undos run on the server as background jobs (202 { job }); the CLI
 * polls GET /api/v1/jobs/:id every 2 s until the job is done, partial or failed.
 *
 * Exit codes: 0 ok, 1 usage or other error, 2 undo partial/failed, 3 auth (401/402/403),
 * 4 not found, 5 rate limited, 6 network. The module also exports its helpers for tests.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { constants as osConstants, homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const VERSION = "0.1.0";
export const DEFAULT_URL = "https://app-production-559c.up.railway.app";
export const EXIT = Object.freeze({ OK: 0, USAGE: 1, UNDO_FAILED: 2, AUTH: 3, NOT_FOUND: 4, RATE_LIMITED: 5, NETWORK: 6 });

export class CliError extends Error {
  constructor(message, exitCode = EXIT.USAGE, details = {}) {
    super(message);
    this.exitCode = exitCode;
    this.details = details;
  }
}

const BOOLEAN_FLAGS = new Set([
  "json", "ndjson", "quiet", "help", "version", "run", "yes", "include-conflicts", "confirm", "all",
  "no-restore-point", "hide-undos", "no-verify", "no-retry",
]);
const VALUE_FLAGS = new Set([
  "key", "url", "profile", "agent", "run-id", "reason", "task", "client-id", "format", "since", "until",
  "out", "limit", "cursor", "type", "action", "resource-id", "actor", "q", "status", "wait", "timeout",
  "plan-hash",
]);
const SHORT_FLAGS = { h: "help", q: "quiet", v: "version" };

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/** argv (without node and script) -> { command, args, flags, passthrough }. Throws CliError(1). */
export function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  let passthrough = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      passthrough = argv.slice(i + 1);
      break;
    }
    if (a.startsWith("--")) {
      let name = a.slice(2);
      let value;
      const eq = name.indexOf("=");
      if (eq >= 0) {
        value = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      if (BOOLEAN_FLAGS.has(name)) {
        if (value !== undefined) throw new CliError(`--${name} takes no value`);
        flags[camel(name)] = true;
      } else if (VALUE_FLAGS.has(name)) {
        if (value === undefined) {
          value = argv[++i];
          if (value === undefined || value.startsWith("--")) throw new CliError(`--${name} needs a value`);
        }
        flags[camel(name)] = value;
      } else {
        throw new CliError(`unknown flag --${name}`);
      }
    } else if (/^-[a-z]$/.test(a)) {
      const long = SHORT_FLAGS[a[1]];
      if (!long) throw new CliError(`unknown flag ${a}`);
      flags[long] = true;
    } else {
      positionals.push(a);
    }
  }
  if (flags.yes) flags.run = true; // --yes was the 0.0 spelling of --run
  const [command, ...args] = positionals;
  return { command, args, flags, passthrough };
}

/** HTTP status -> CLI exit code. */
export function exitCodeForStatus(status) {
  if (status === 401 || status === 402 || status === 403) return EXIT.AUTH;
  if (status === 404) return EXIT.NOT_FOUND;
  if (status === 429) return EXIT.RATE_LIMITED;
  return EXIT.USAGE;
}

/** Retry-After (seconds or HTTP date) -> milliseconds; 1 s when absent or unreadable. */
export function retryAfterMs(header, now = Date.now()) {
  if (!header) return 1000;
  if (/^\d+(\.\d+)?$/.test(header.trim())) return Math.round(Number(header) * 1000);
  const t = Date.parse(header);
  return Number.isNaN(t) ? 1000 : Math.max(0, t - now);
}

/** "30m" | "24h" | "7d" | "2w" | ISO -> ISO. */
export function toIso(value, now = Date.now()) {
  if (value === undefined) return undefined;
  const m = /^(\d+)([smhdw])$/.exec(value);
  if (!m) {
    if (Number.isNaN(Date.parse(value))) throw new CliError(`not a duration (30m, 24h, 7d) or ISO time: ${value}`);
    return value;
  }
  const unit = { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7, w: 6.048e8 }[m[2]];
  return new Date(now - Number(m[1]) * unit).toISOString();
}

/** "gid://shopify/Product/1" | "Product-1" | "product/1" | "metafield_definition:1" -> gid. */
export function toGid(ref) {
  if (/^gid:\/\/shopify\/[A-Za-z]+\/\d+$/.test(ref)) return ref;
  const m = /^([A-Za-z_]+)[-/:](\d+)$/.exec(ref ?? "");
  if (!m) throw new CliError(`not a record id: ${ref} (use gid://shopify/Product/123 or Product-123)`);
  const type = m[1].split("_").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
  return `gid://shopify/${type}/${m[2]}`;
}

/** True when an undo/rollback response reports a partial or failed write. */
export function undoFailed(r) {
  if (!r || typeof r !== "object") return false;
  const bad = (s) => s === "failed" || s === "partial" || s === "error";
  if (bad(r.status) || r.ok === false || (typeof r.failed === "number" && r.failed > 0)) return true;
  if (r.counts && ((r.counts.failed ?? 0) > 0 || (r.counts.partial ?? 0) > 0)) return true;
  for (const k of ["run", "result", "rollback", "undo"]) if (r[k] && undoFailed(r[k])) return true;
  for (const k of ["runs", "results"]) if (Array.isArray(r[k]) && r[k].some(undoFailed)) return true;
  if (Array.isArray(r.ops) && r.ops.some((o) => o && o.ok === false)) return true;
  return false;
}

/** Job statuses that will not change again. */
export const JOB_FINAL = Object.freeze(["done", "partial", "failed"]);
export const isJobFinal = (status) => JOB_FINAL.includes(status);

/** One progress line for a background undo job. */
export function jobProgress(job) {
  const total = job?.total ?? 0;
  return `job ${job?.id ?? "?"} ${job?.status ?? "?"}: ${job?.done ?? 0} done, ${job?.failed ?? 0} failed, ${job?.skipped ?? 0} skipped of ${total}`;
}

// ---------------------------------------------------------------------------------------------
// Config: ~/.config/lvndr/config.json (or $XDG_CONFIG_HOME/lvndr, or $LVNDR_CONFIG)
// { "defaultProfile": "default", "profiles": { "default": { "url", "key", "agent"? } },
//   "currentRun": { "default": "<runId>" } }

export function configPath(env = process.env) {
  if (env.LVNDR_CONFIG) return env.LVNDR_CONFIG;
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "lvndr", "config.json");
}

export function loadConfig(env = process.env) {
  try {
    const parsed = JSON.parse(readFileSync(configPath(env), "utf8"));
    return { profiles: {}, currentRun: {}, ...parsed };
  } catch (e) {
    if (e && e.code === "ENOENT") return { profiles: {}, currentRun: {} };
    throw new CliError(`cannot read ${configPath(env)}: ${e.message}`);
  }
}

export function saveConfig(config, env = process.env) {
  const path = configPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** Flags beat environment beats the saved profile beats defaults. */
export function resolveContext(flags, env = process.env, { allowMissingProfile = false } = {}) {
  const config = loadConfig(env);
  const profileName = flags.profile ?? env.LVNDR_PROFILE ?? config.defaultProfile ?? "default";
  const profile = config.profiles?.[profileName];
  if (!profile && (flags.profile || env.LVNDR_PROFILE) && !allowMissingProfile) {
    throw new CliError(`no profile "${profileName}" in ${configPath(env)}; run \`lvndr login --profile ${profileName}\``);
  }
  return {
    env,
    config,
    profileName,
    url: String(flags.url || env.LVNDR_API_URL || profile?.url || DEFAULT_URL).replace(/\/+$/, ""),
    key: flags.key || env.LVNDR_API_KEY || profile?.key,
    agent: flags.agent || env.LVNDR_AGENT || profile?.agent || "lvndr-cli",
    runId: flags.runId || env.LVNDR_RUN_ID || undefined,
    retry: !flags.noRetry,
    timeoutMs: flags.timeout ? Number(flags.timeout) * 1000 : 120_000,
  };
}

// ---------------------------------------------------------------------------------------------
// HTTP

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function errorFromResponse(status, text, retryAfter) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const e = body?.error;
  const message = typeof e === "string" ? e : e?.message ?? (text ? text.slice(0, 200) : `HTTP ${status}`);
  const code = typeof e === "object" && e ? e.code : undefined;
  const suffix = status === 429 && retryAfter ? ` (retry after ${retryAfter}s)` : "";
  return new CliError(`${message}${suffix}`, exitCodeForStatus(status), { status, code, retryAfter: retryAfter ?? undefined });
}

/** One API call. Returns parsed JSON (or text when raw). Retries 429 up to 3 times (<= 60 s). */
export async function request(ctx, method, path, { body, query, raw = false, auth = true } = {}) {
  if (auth && !ctx.key) {
    throw new CliError("No API key. Run `lvndr login`, set LVNDR_API_KEY, or pass --key (lvndr > Settings > API keys).", EXIT.AUTH);
  }
  const url = new URL(`${ctx.url}/api/v1${path}`);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== false && v !== "") url.searchParams.set(k, String(v));
  const headers = { Accept: raw ? "*/*" : "application/json", "User-Agent": `lvndr-cli/${VERSION}`, "X-Lvndr-Agent": ctx.agent };
  if (ctx.key) headers.Authorization = `Bearer ${ctx.key}`;
  if (ctx.runId) headers["X-Lvndr-Run-Id"] = ctx.runId;
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    headers["Idempotency-Key"] = randomUUID(); // same key on every retry of this call
  }
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(ctx.timeoutMs ?? 120_000),
      });
    } catch (e) {
      const cause = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(e);
      throw new CliError(`cannot reach ${ctx.url}: ${cause}`, EXIT.NETWORK);
    }
    if (res.status === 429 && ctx.retry !== false && attempt < 3) {
      const wait = retryAfterMs(res.headers.get("retry-after"));
      if (wait <= 60_000) {
        await res.text().catch(() => "");
        await sleep(wait);
        continue;
      }
    }
    const text = await res.text();
    if (!res.ok) throw errorFromResponse(res.status, text, res.headers.get("retry-after"));
    if (raw) return text;
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new CliError(`${method} ${url.pathname}: expected JSON, got ${text.slice(0, 120)}`);
    }
  }
}

/**
 * Poll GET /jobs/:id until the job is done, partial or failed. Progress goes to stderr (only
 * when it moves). A 429 waits for Retry-After instead of failing. Resolves to the final job.
 */
export async function waitForJob(ctx, job, io, { intervalMs } = {}) {
  const every = intervalMs ?? Number(ctx.env?.LVNDR_POLL_MS ?? 2000);
  let last = "";
  const report = (j) => {
    const line = jobProgress(j);
    if (line !== last && !io.silent) io.stderr.write(`lvndr: ${line}\n`);
    last = line;
  };
  report(job);
  let current = job;
  while (!isJobFinal(current?.status)) {
    await sleep(every);
    try {
      const r = await request({ ...ctx, retry: false }, "GET", `/jobs/${encodeURIComponent(job.id)}`);
      current = r.job ?? r;
    } catch (e) {
      if (e instanceof CliError && e.details?.status === 429) {
        await sleep(Math.max(every, retryAfterMs(e.details.retryAfter ?? null)));
        continue;
      }
      throw e;
    }
    report(current);
  }
  return current;
}

// ---------------------------------------------------------------------------------------------
// Output

function pad(s, n) {
  s = String(s ?? "");
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}
const when = (iso) => (iso ? String(iso).slice(0, 19).replace("T", " ") : "-");
const show = (v) => (v === undefined ? "(unset)" : JSON.stringify(v));
const actorOf = (c) => c?.actor?.label ?? c?.actor?.name ?? c?.actor?.appTitle ?? c?.actor?.tier ?? c?.actorLabel ?? "";

function changeLine(c) {
  return `${pad(c.id, 26)} ${pad(when(c.occurredAt), 19)} ${pad(c.resourceType, 10)} ${pad(c.action, 6)} ${pad(c.resourceTitle ?? "", 32)} ${pad(actorOf(c), 24)} ${c.summary ?? c.fields ?? ""}`;
}

function planLines(plan) {
  const out = [];
  for (const i of plan?.items ?? []) out.push(`  ${pad(i.status, 12)} ${i.path}: ${show(i.current)} -> ${show(i.target)}${i.reason ? `  (${i.reason})` : ""}`);
  if (plan?.counts) out.push(`  ${Object.entries(plan.counts).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  return out;
}

function runLines(run) {
  if (!run) return [];
  const out = [`undo ${run.status ?? "sent"}${run.id ? ` (${run.id})` : ""}`];
  for (const o of run.ops ?? []) out.push(`  ${o.ok ? "ok " : "ERR"} ${o.op}${o.errors?.length ? `: ${o.errors.join("; ")}` : ""}`);
  return out;
}

/** Human rendering for anything plan-shaped: one undo, a batch, a run, a rollback. */
function undoLines(r, ran) {
  const out = [];
  if (r.plan) out.push(...planLines(r.plan));
  for (const p of r.plans ?? r.items ?? []) {
    if (p?.changeId || p?.change) out.push(`${p.changeId ?? p.change?.id}${p.status ? `  ${p.status}` : ""}`);
    if (p?.plan) out.push(...planLines(p.plan));
    if (p?.run) out.push(...runLines(p.run));
  }
  if (r.run) out.push(...runLines(r.run));
  for (const x of r.runs ?? r.results ?? []) {
    if (x?.ops) out.push(...runLines(x));
    else out.push(`  ${pad(x?.changeId ?? x?.id ?? "", 26)} ${pad(x?.status ?? "", 8)} ${pad(x?.action ?? "", 6)} ${pad(x?.resourceTitle ?? "", 32)} ${x?.detail ?? x?.error ?? ""}`);
  }
  if (r.counts && !r.plan) out.push(`  ${Object.entries(r.counts).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  if (r.status && !r.run) out.push(`status: ${r.status}`);
  const remaining = Array.isArray(r.remaining) ? r.remaining.length : r.remaining;
  if (remaining) out.push(`not covered in this pass: ${remaining}; run it again`);
  if (typeof r.more === "number" && r.more > 0) out.push(`${r.more} more change(s) not planned in this preview (of ${r.total ?? "?"}); the undo covers them too`);
  if (!out.length) out.push(JSON.stringify(r, null, 2));
  if (!ran) out.push("preview only; nothing was written. Re-run with --run to write.");
  return out;
}

/** Human rendering of a finished (or running) job. */
function jobLines(job) {
  const out = [jobProgress(job)];
  for (const x of job?.results ?? []) out.push(`  ${pad(x?.changeId ?? "", 26)} ${pad(x?.status ?? "", 8)} ${pad(x?.action ?? "", 6)} ${pad(x?.resourceTitle ?? "", 32)} ${x?.detail ?? ""}`);
  if (job?.error) out.push(`error: ${job.error}`);
  if (job?.remaining) out.push(`not covered by this job: ${job.remaining}; run the undo again`);
  return out;
}

/** A queued undo (202 { job }): wait for it, then { result, human, exitCode }. */
async function finishQueued(ctx, r, io, flags) {
  if (!r?.job?.id) return { result: r, human: undoLines(r, true), exitCode: undoFailed(r) ? EXIT.UNDO_FAILED : EXIT.OK };
  const job = await waitForJob(ctx, r.job, { ...io, silent: flags.quiet });
  return { result: { ...r, job }, human: jobLines(job), quietIds: [job.id], exitCode: job.status === "done" ? EXIT.OK : EXIT.UNDO_FAILED };
}

/** The line that runs a previewed undo bound to its plan. */
const planHashHint = (r, command) => (r?.planHash ? [`To run exactly this plan: ${command} --plan-hash ${r.planHash}`] : []);

const firstArray = (r, keys) => {
  for (const k of keys) if (Array.isArray(r?.[k])) return r[k];
  return null;
};

// ---------------------------------------------------------------------------------------------
// Commands

const HELP = `lvndr ${VERSION}: Shopify store change log, undo and restore points

Usage: lvndr <command> [options]

Read
  me                                   which shop and key this is
  status                               plan, tracked counts, last activity check
  changes [--since 24h] [--until ISO] [--type PRODUCT] [--action update] [--resource-id Product-1]
          [--actor name] [--q text] [--hide-undos] [--run-id id] [--limit 50] [--cursor c]
  change <id>                          one change with its diff
  history <gid|Type-digits>            every version of one record
  batch <id>                           everything one actor did around a change
  points                               restore points
  preview <pointId>                    what rolling back to a point would write
  alerts [--all]                       open anomaly alerts (--all includes dismissed)
  run show [id] | run list             agent runs
  export [--format csv|json] [--since] [--until] [--out file]
  openapi                              the API's OpenAPI document

Write (every undo previews unless --run)
  undo <id> [--run] [--include-conflicts] [--plan-hash h] [--reason text]
                                       --run previews first and binds the write to that plan
  undo-batch <id> [--run] [--plan-hash h] [--reason text]
  mark <label...> [--reason text]      mark a restore point now
  rollback <pointId> --confirm [--plan-hash h] [--reason text]
  job <id>                             one background undo job and its progress
  dismiss <alertId>
  run start --agent <name> [--task text] [--client-id id] [--no-restore-point]
  run end [id]
  run undo [id] [--run] [--plan-hash h] [--reason text]
                                       undo-batch, run undo and rollback queue a job and wait for it
  guard [--agent name] [--task text] [--wait 5] -- <command...>
                                       restore point + run around a command, then the undo line

Setup
  login [--key lv_...] [--url URL] [--profile name] [--no-verify]

Global options
  --json  compact JSON on stdout     --ndjson  one JSON object per line for lists
  --quiet  ids only                  --key, --url, --profile, --agent (X-Lvndr-Agent), --run-id
  --no-retry  fail on 429 at once    --timeout <seconds>

Exit codes: 0 ok, 1 usage/other, 2 undo partial or failed, 3 auth (401/402/403), 4 not found,
5 rate limited, 6 network. Environment: LVNDR_API_KEY, LVNDR_API_URL, LVNDR_PROFILE,
LVNDR_AGENT, LVNDR_RUN_ID, LVNDR_CONFIG, LVNDR_POLL_MS (job polling, default 2000).`;

function need(args, n, usage) {
  if (args.length < n || args.slice(0, n).some((a) => !a)) throw new CliError(`usage: lvndr ${usage}`);
  return args;
}

function currentRun(ctx, explicit) {
  const id = explicit ?? ctx.runId ?? ctx.config.currentRun?.[ctx.profileName];
  if (!id) throw new CliError("no run id: pass one, set LVNDR_RUN_ID, or start one with `lvndr run start --agent <name>`");
  return id;
}

const runIdOf = (r) => r?.run?.id ?? r?.id;

function readLine(prompt, io) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: io.stdin ?? process.stdin, output: io.stderr, terminal: false });
    if ((io.stdin ?? process.stdin).isTTY) io.stderr.write(prompt);
    rl.once("line", (line) => {
      rl.close();
      resolve(line.trim());
    });
    rl.once("close", () => resolve(""));
  });
}

async function guard(ctx, parsed, io) {
  const { flags, passthrough } = parsed;
  if (!passthrough?.length) throw new CliError("usage: lvndr guard [--agent name] [--task text] -- <command...>");
  const err = (s) => io.stderr.write(`${s}\n`);
  const agent = flags.agent ?? ctx.env.LVNDR_AGENT ?? "lvndr-guard";
  const started = await request({ ...ctx, agent }, "POST", "/runs", {
    body: { agent, task: flags.task ?? passthrough.join(" ").slice(0, 200), clientId: flags.clientId, markRestorePoint: !flags.noRestorePoint },
  });
  const id = runIdOf(started);
  if (!id) throw new CliError("the API did not return a run id; not running the command");
  const point = started.restorePoint?.id ?? started.run?.restorePointId;
  err(`lvndr: run ${id} started${point ? `, restore point ${point}` : ""}`);

  const childEnv = { ...ctx.env, LVNDR_RUN_ID: id, LVNDR_AGENT: agent };
  const exitCode = await new Promise((resolve) => {
    const ignore = () => {}; // let the child handle Ctrl-C; we still end the run afterwards
    process.on("SIGINT", ignore);
    process.on("SIGTERM", ignore);
    const child = spawn(passthrough[0], passthrough.slice(1), { stdio: "inherit", env: childEnv });
    const done = (code) => {
      process.off("SIGINT", ignore);
      process.off("SIGTERM", ignore);
      resolve(code);
    };
    child.once("error", (e) => {
      err(`lvndr: cannot start ${passthrough[0]}: ${e.message}`);
      done(127);
    });
    child.once("exit", (code, signal) => done(code ?? 128 + (osConstants.signals[signal] ?? 0)));
  });

  let endError;
  try {
    await request({ ...ctx, agent }, "POST", `/runs/${encodeURIComponent(id)}/end`, { body: { exitCode } });
  } catch (e) {
    endError = e;
    err(`lvndr: could not end run ${id}: ${e.message}`);
  }
  const waitS = Number(flags.wait ?? 5);
  if (waitS > 0) await sleep(waitS * 1000); // Shopify delivers change events a few seconds late
  let changes = [];
  try {
    const r = await request({ ...ctx, agent }, "GET", "/changes", { query: { runId: id, limit: 200 } });
    changes = r.changes ?? [];
  } catch (e) {
    err(`lvndr: could not list the run's changes: ${e.message}`);
  }
  const undoLine = `lvndr run undo ${id} --run`;
  if (flags.json) {
    err(JSON.stringify({ runId: id, restorePointId: point ?? null, exitCode, ended: !endError, changes, undo: undoLine }));
  } else {
    err(`lvndr: command exited ${exitCode}; run ${id} ${endError ? "NOT ended" : "ended"}; ${changes.length} change(s) recorded so far`);
    for (const c of changes) err(changeLine(c));
    if (!changes.length) err(`lvndr: changes can arrive late; check again with: lvndr changes --run-id ${id}`);
    err(`To preview the undo:  lvndr run undo ${id}`);
    err(`To undo this run:     ${undoLine}`);
  }
  return exitCode;
}

async function login(parsed, io) {
  const { flags } = parsed;
  const ctx = resolveContext(flags, io.env, { allowMissingProfile: true });
  let key = flags.key ?? ctx.env.LVNDR_API_KEY;
  if (!key) key = await readLine("lvndr API key (Settings > API keys): ", io);
  if (!key) throw new CliError("no key given");
  const url = ctx.url;
  let me = null;
  if (!flags.noVerify) me = await request({ ...ctx, key, url }, "GET", "/me");
  const config = ctx.config;
  config.profiles = { ...(config.profiles ?? {}), [ctx.profileName]: { url, key, ...(flags.agent ? { agent: flags.agent } : {}) } };
  config.defaultProfile ??= ctx.profileName;
  const path = saveConfig(config, ctx.env);
  const shop = me?.shop ?? me?.key?.shop ?? null;
  return { result: { profile: ctx.profileName, url, shop, configPath: path }, human: [`saved profile "${ctx.profileName}"${shop ? ` for ${shop}` : ""} to ${path}`] };
}

/** Runs one command; returns { result, human: string[], list?, quietIds?, exitCode? }. */
async function dispatch(parsed, io) {
  const { command, args, flags } = parsed;
  if (command === "login") return login(parsed, io);
  const ctx = resolveContext(flags, io.env);
  const enc = encodeURIComponent;
  switch (command) {
    case "me": {
      const r = await request(ctx, "GET", "/me");
      const k = r.key ?? {};
      const scopes = Array.isArray(k.scopes) ? k.scopes.join(",") : k.scopes;
      return { result: r, human: [`${r.shop ?? "?"}  key: ${k.label ?? k.id ?? "?"}${scopes ? `  scopes: ${scopes}` : ""}${r.plan ? `  plan: ${r.plan.label ?? r.plan.handle ?? r.plan}` : ""}${k.expiresAt ? `  expires: ${k.expiresAt}` : ""}`] };
    }
    case "status": {
      const s = await request(ctx, "GET", "/status");
      return {
        result: s,
        human: [
          `${s.shop}  plan: ${s.plan?.label ?? s.plan?.handle ?? "?"}`,
          `tracked: ${Object.entries(s.tracked ?? {}).map(([k, v]) => `${k.toLowerCase()} ${v}`).join(", ") || "-"}`,
          `last activity check: ${s.lastPolledAt ?? "never"}  pending deliveries: ${s.deliveries?.pending ?? "?"}`,
        ],
      };
    }
    case "changes": {
      const query = {
        since: toIso(flags.since),
        until: toIso(flags.until),
        type: flags.type?.toUpperCase(),
        action: flags.action,
        resourceId: flags.resourceId ? toGid(flags.resourceId) : undefined,
        actor: flags.actor,
        q: flags.q,
        hideUndos: flags.hideUndos ? "true" : undefined,
        runId: flags.runId,
        limit: flags.limit,
        cursor: flags.cursor,
      };
      const r = await request(ctx, "GET", "/changes", { query });
      const list = r.changes ?? [];
      const human = list.map(changeLine);
      if (!list.length) human.push("no changes");
      if (r.nextCursor) io.stderr.write(`more: lvndr changes --cursor ${r.nextCursor}\n`);
      return { result: r, human, list, quietIds: list.map((c) => c.id) };
    }
    case "change": {
      need(args, 1, "change <id>");
      const r = await request(ctx, "GET", `/changes/${enc(args[0])}`);
      const c = r.change ?? r;
      const human = [
        `${c.resourceType} ${c.resourceTitle ?? ""} (${c.resourceId})`,
        `${c.action} at ${c.occurredAt} by ${actorOf(c)} [${c.actor?.tier ?? "?"}]`,
      ];
      if (c.summary) human.push(c.summary);
      for (const e of c.diff ?? []) human.push(`  ${e.path}: ${show(e.before)} -> ${show(e.after)}`);
      return { result: r, human };
    }
    case "history": {
      need(args, 1, "history <gid|Type-digits>");
      const r = await request(ctx, "GET", `/records/${enc(toGid(args[0]))}/history`);
      const list = firstArray(r, ["changes", "history"]) ?? [];
      const rec = r.record ?? {};
      const human = [`${rec.resourceType ?? ""} ${rec.title ?? ""} (${rec.resourceId ?? toGid(args[0])})${rec.deleted ? "  [deleted]" : ""}`];
      for (const v of r.versions ?? []) human.push(`  v${v.version}  ${when(v.capturedAt)}  ${v.source ?? ""}`);
      human.push(...list.map(changeLine));
      if (!list.length) human.push("no changes");
      if (r.nextCursor) io.stderr.write(`more changes exist (cursor ${r.nextCursor})\n`);
      return { result: r, human, list };
    }
    case "undo": {
      need(args, 1, "undo <id> [--run] [--include-conflicts] [--plan-hash h] [--reason text]");
      const path = `/changes/${enc(args[0])}/undo`;
      const includeConflicts = !!flags.includeConflicts;
      if (!flags.run) {
        const r = await request(ctx, "POST", path, { body: { dryRun: true, includeConflicts, reason: flags.reason } });
        return { result: r, human: [...undoLines(r, false), ...planHashHint(r, `lvndr undo ${args[0]} --run${includeConflicts ? " --include-conflicts" : ""}`)] };
      }
      // Bind the write to a plan: the one the user previewed (--plan-hash), else a fresh dry run.
      let planHash = flags.planHash;
      if (!planHash) {
        const preview = await request(ctx, "POST", path, { body: { dryRun: true, includeConflicts, reason: flags.reason } });
        planHash = preview.planHash;
      }
      const r = await request(ctx, "POST", path, { body: { dryRun: false, includeConflicts, planHash, reason: flags.reason } });
      return { result: r, human: undoLines(r, true), exitCode: undoFailed(r) ? EXIT.UNDO_FAILED : EXIT.OK };
    }
    case "batch": {
      need(args, 1, "batch <id>");
      const r = await request(ctx, "GET", `/batches/${enc(args[0])}`);
      const list = r.changes ?? [];
      return { result: r, human: [`${list.length} changes by ${r.actorLabel ?? "?"}`, ...list.map(changeLine)], list };
    }
    case "undo-batch": {
      need(args, 1, "undo-batch <id> [--run] [--plan-hash h] [--reason text]");
      const r = await request(ctx, "POST", `/batches/${enc(args[0])}/undo`, { body: { dryRun: !flags.run, planHash: flags.run ? flags.planHash : undefined, reason: flags.reason } });
      if (flags.run) return finishQueued(ctx, r, io, flags);
      return { result: r, human: [...undoLines(r, false), ...planHashHint(r, `lvndr undo-batch ${args[0]} --run`)] };
    }
    case "points": {
      const r = await request(ctx, "GET", "/restore-points");
      const list = r.points ?? r.restorePoints ?? [];
      const human = list.map((p) => `${pad(p.id, 26)} ${when(p.at)} ${pad(p.kind, 8)} ${p.label ?? ""}`);
      if (!list.length) human.push("no restore points");
      return { result: r, human, list, quietIds: list.map((p) => p.id) };
    }
    case "mark": {
      const label = args.join(" ") || undefined;
      const r = await request(ctx, "POST", "/restore-points", { body: { label, reason: flags.reason } });
      const p = r.point ?? r.restorePoint ?? r;
      return { result: r, human: [`marked ${p.id} at ${p.at}${p.label ? `  ${p.label}` : ""}`], quietIds: [p.id] };
    }
    case "preview": {
      need(args, 1, "preview <pointId>");
      const r = await request(ctx, "GET", `/restore-points/${enc(args[0])}/preview`);
      const hint = r.planHash ? `To roll back exactly this: lvndr rollback ${args[0]} --confirm --plan-hash ${r.planHash}` : `To roll back: lvndr rollback ${args[0]} --confirm`;
      return { result: r, human: undoLines(r.preview ?? r, true).concat(hint) };
    }
    case "rollback": {
      need(args, 1, "rollback <pointId> --confirm [--plan-hash h] [--reason text]");
      if (!flags.confirm) throw new CliError(`rollback writes to the store. Preview first with \`lvndr preview ${args[0]}\`, then add --confirm.`);
      const r = await request(ctx, "POST", `/restore-points/${enc(args[0])}/rollback`, { body: { confirm: true, planHash: flags.planHash, reason: flags.reason } });
      return finishQueued(ctx, r, io, flags);
    }
    case "job": {
      need(args, 1, "job <id>");
      const r = await request(ctx, "GET", `/jobs/${enc(args[0])}`);
      const job = r.job ?? r;
      const failed = job.status === "partial" || job.status === "failed";
      return { result: r, human: jobLines(job), quietIds: [job.id], exitCode: failed ? EXIT.UNDO_FAILED : EXIT.OK };
    }
    case "alerts": {
      const r = await request(ctx, "GET", "/alerts", { query: { status: flags.all ? "all" : flags.status ?? "open" } });
      const list = r.alerts ?? [];
      const human = list.map((a) => `${pad(a.id, 26)} ${when(a.createdAt ?? a.windowStart)} ${pad(a.status, 9)} ${pad(a.count ?? a.changeCount ?? "", 5)} ${a.actorLabel ?? a.actorKey ?? ""}${a.anchorChangeId ? `  lvndr batch ${a.anchorChangeId}` : ""}`);
      if (!list.length) human.push("no alerts");
      return { result: r, human, list, quietIds: list.map((a) => a.id) };
    }
    case "dismiss": {
      need(args, 1, "dismiss <alertId>");
      const r = await request(ctx, "POST", `/alerts/${enc(args[0])}/dismiss`, { body: {} });
      return { result: r, human: [`dismissed ${args[0]}`] };
    }
    case "run":
    case "runs": {
      const sub = command === "runs" ? "list" : args[0];
      const id = args[1];
      if (sub === "start") {
        if (!flags.agent) throw new CliError("usage: lvndr run start --agent <name> [--task text] [--client-id id] [--no-restore-point]");
        const r = await request(ctx, "POST", "/runs", { body: { agent: flags.agent, task: flags.task, clientId: flags.clientId, markRestorePoint: !flags.noRestorePoint } });
        const runId = runIdOf(r);
        if (runId) {
          ctx.config.currentRun = { ...(ctx.config.currentRun ?? {}), [ctx.profileName]: runId };
          saveConfig(ctx.config, ctx.env);
        }
        const point = r.restorePoint?.id ?? r.run?.restorePointId;
        return { result: r, human: [`run ${runId} started${point ? `, restore point ${point}` : ""}`, `export LVNDR_RUN_ID=${runId}`], quietIds: [runId] };
      }
      if (sub === "end") {
        const runId = currentRun(ctx, id);
        const r = await request(ctx, "POST", `/runs/${enc(runId)}/end`, { body: {} });
        if (ctx.config.currentRun?.[ctx.profileName] === runId) {
          delete ctx.config.currentRun[ctx.profileName];
          saveConfig(ctx.config, ctx.env);
        }
        const run = r.run ?? r;
        return { result: r, human: [`run ${runId} ended${run.changeCount !== undefined ? `; ${run.changeCount} change(s)` : ""}`, `To undo it: lvndr run undo ${runId} --run`] };
      }
      if (sub === "show") {
        const runId = currentRun(ctx, id);
        const r = await request(ctx, "GET", `/runs/${enc(runId)}`);
        const run = r.run ?? r;
        const list = r.changes ?? run.changes ?? [];
        return {
          result: r,
          human: [`${run.id}  ${run.agent ?? ""}  ${run.task ?? ""}`, `started ${run.startedAt ?? "?"}  ended ${run.endedAt ?? "running"}${run.restorePointId ? `  restore point ${run.restorePointId}` : ""}`, ...list.map(changeLine)],
          list,
        };
      }
      if (sub === "list") {
        const r = await request(ctx, "GET", "/runs");
        const list = r.runs ?? [];
        const human = list.map((x) => `${pad(x.id, 26)} ${when(x.startedAt)} ${pad(x.status ?? (x.endedAt ? "ended" : "open"), 6)} ${pad(x.agent, 20)} ${pad(x.changeCount ?? "", 5)} ${x.task ?? ""}`);
        if (!list.length) human.push("no runs");
        return { result: r, human, list, quietIds: list.map((x) => x.id) };
      }
      if (sub === "undo") {
        const runId = currentRun(ctx, id);
        const r = await request(ctx, "POST", `/runs/${enc(runId)}/undo`, { body: { dryRun: !flags.run, planHash: flags.run ? flags.planHash : undefined, reason: flags.reason } });
        if (flags.run) return finishQueued(ctx, r, io, flags);
        return { result: r, human: [...undoLines(r, false), ...planHashHint(r, `lvndr run undo ${runId} --run`)] };
      }
      throw new CliError("usage: lvndr run start|end|show|list|undo");
    }
    case "export": {
      const text = await request(ctx, "GET", "/export", { raw: true, query: { format: flags.format, since: toIso(flags.since), until: toIso(flags.until) } });
      if (flags.out) {
        writeFileSync(flags.out, text);
        return { result: { out: flags.out, bytes: Buffer.byteLength(text) }, human: [`wrote ${Buffer.byteLength(text)} bytes to ${flags.out}`] };
      }
      return { rawText: text };
    }
    case "openapi": {
      const r = await request(ctx, "GET", "/openapi.json", { auth: false });
      return { result: r, human: [JSON.stringify(r, null, 2)] };
    }
    default:
      throw new CliError(`unknown command: ${command}\n\n${HELP}`);
  }
}

/** Entry point. io = { env, stdout, stderr, stdin }. Resolves to the exit code. */
export async function main(argv, io = {}) {
  io = { env: process.env, stdout: process.stdout, stderr: process.stderr, stdin: process.stdin, ...io };
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    io.stderr.write(`lvndr: ${e.message}\n`);
    return EXIT.USAGE;
  }
  const { command, flags } = parsed;
  if (flags.version) {
    io.stdout.write(`${VERSION}\n`);
    return EXIT.OK;
  }
  if (!command || command === "help" || flags.help) {
    io.stdout.write(`${HELP}\n`);
    return command && command !== "help" && !flags.help ? EXIT.USAGE : EXIT.OK;
  }
  try {
    if (command === "guard") return await guard(resolveContext(flags, io.env), parsed, io);
    const out = await dispatch(parsed, io);
    if (out.rawText !== undefined) {
      io.stdout.write(out.rawText);
    } else if (flags.json) {
      io.stdout.write(`${JSON.stringify(out.result)}\n`);
    } else if (flags.ndjson && out.list) {
      for (const item of out.list) io.stdout.write(`${JSON.stringify(item)}\n`);
    } else if (flags.quiet) {
      for (const id of out.quietIds ?? []) if (id) io.stdout.write(`${id}\n`);
    } else {
      for (const line of out.human ?? []) io.stdout.write(`${line}\n`);
    }
    return out.exitCode ?? EXIT.OK;
  } catch (e) {
    const err = e instanceof CliError ? e : new CliError(e?.message ?? String(e));
    if (flags.json || flags.ndjson) {
      io.stdout.write(`${JSON.stringify({ error: { message: err.message, exitCode: err.exitCode, ...err.details } })}\n`);
    } else {
      io.stderr.write(`lvndr: ${err.message}\n`);
    }
    return err.exitCode;
  }
}

function invokedDirectly() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

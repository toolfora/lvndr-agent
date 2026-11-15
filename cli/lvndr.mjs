#!/usr/bin/env node
/* eslint-env node */
/**
 * lvndr CLI: the Shopify store change log, undo and restore points from a terminal or an agent.
 * One file, no dependencies, Node 20+. Talks to the public REST API (`/api/v1`) with an API key
 * made in lvndr > Settings > Agents & API.
 *
 *   lvndr login                         # saves a profile to ~/.config/lvndr/config.json
 *   lvndr guard -- <command...>         # restore point + run around any command, then the undo line
 *   lvndr help                          # every command
 *
 * Run, batch and rollback undos run on the server as background jobs (202 { job }); the CLI
 * polls GET /api/v1/jobs/:id (as often as the job's pollAfterMs says) until it is done, partial
 * or failed.
 *
 * Every write is bound to a plan someone saw: `undo --run`, `undo-batch --run`, `run undo --run`
 * and `rollback --confirm` need the --plan-hash their preview printed. `--yes` (a person at a
 * terminal only) previews, prints the preview, asks "Apply? [y/N]" and writes that plan.
 *
 * Exit codes: 0 ok, 1 usage or other error, 2 undo partial/failed, 3 auth (401/403),
 * 4 not found, 5 rate limited, 6 network, 7 conflict (409, e.g. plan_changed), 8 the shop's
 * plan lacks the API (402). The module also exports its helpers for tests.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, chmodSync, constants as fsConstants, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { constants as osConstants, homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const VERSION = "0.2.0";
export const DEFAULT_URL = "https://lvndr.toolfora.com";
export const EXIT = Object.freeze({ OK: 0, USAGE: 1, UNDO_FAILED: 2, AUTH: 3, NOT_FOUND: 4, RATE_LIMITED: 5, NETWORK: 6, CONFLICT: 7, PLAN_REQUIRED: 8 });

export class CliError extends Error {
  constructor(message, exitCode = EXIT.USAGE, details = {}) {
    super(message);
    this.exitCode = exitCode;
    this.details = details;
  }
}

const BOOLEAN_FLAGS = new Set([
  "json", "ndjson", "quiet", "help", "version", "run", "yes", "include-conflicts", "confirm", "all",
  "no-restore-point", "hide-undos", "no-verify", "no-retry", "with-token",
]);
const VALUE_FLAGS = new Set([
  "key", "url", "profile", "agent", "run-id", "reason", "task", "client-id", "format", "since", "until",
  "out", "limit", "cursor", "type", "action", "resource-id", "actor", "q", "status", "wait", "timeout",
  "plan-hash", "kind", "field", "only", "exclude",
]);
/** Value flags that may be given more than once; they collect into an array. */
const REPEATABLE_FLAGS = new Set(["field", "only", "exclude"]);
const SHORT_FLAGS = { h: "help", q: "quiet", v: "version" };

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
/**
 * --only <kind> / --exclude <changeId> (both repeatable): narrow a batch, run or rollback to some
 * kinds of field ("Price") and leave changes out. Returns the body fields and the flags to echo.
 */
function narrowing(flags) {
  const body = {};
  if (flags.only?.length) body.fieldKinds = flags.only;
  if (flags.exclude?.length) body.excludeChangeIds = flags.exclude;
  const echo = [...(flags.only ?? []).map((k) => ` --only ${shellQuote(k)}`), ...(flags.exclude ?? []).map((x) => ` --exclude ${shellQuote(x)}`)].join("");
  return { body, echo };
}

/** After a multi-change preview: the kinds of field in it, and how to put back only some. */
function kindHints(r, flags, command) {
  const kinds = r?.kinds ?? r?.preview?.kinds ?? [];
  if (flags.only?.length || kinds.filter((k) => k.ready > 0).length < 2) return flags.only?.length ? [`only: ${flags.only.join(", ")}`] : [];
  return [`Kinds of field: ${kinds.filter((k) => k.ready > 0).map((k) => `${k.kind} (${k.ready})`).join(", ")}`, `To put back only some: ${command} --only ${shellQuote(kinds[0].kind)}  (repeat --only; --exclude <changeId> leaves a change out)`];
}

/** A shell word for a printed command line: plain when safe, else single-quoted. */
const shellQuote = (s) => (/^[A-Za-z0-9_./:@=-]+$/.test(String(s)) ? String(s) : `'${String(s).replace(/'/g, `'\\''`)}'`);

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
        if (REPEATABLE_FLAGS.has(name)) (flags[camel(name)] ??= []).push(value);
        else flags[camel(name)] = value;
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
  const [command, ...args] = positionals;
  return { command, args, flags, passthrough };
}

/** HTTP status -> CLI exit code. */
export function exitCodeForStatus(status) {
  if (status === 401 || status === 403) return EXIT.AUTH;
  if (status === 402) return EXIT.PLAN_REQUIRED;
  if (status === 404) return EXIT.NOT_FOUND;
  if (status === 409) return EXIT.CONFLICT;
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

/** --limit: a whole number from 1 to 100, refused otherwise (never silently changed). */
export function parseLimit(value, max = 100) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new CliError(`--limit takes a whole number from 1 to ${max}, not ${value}`);
  return n;
}

/** Edit distance, for "did you mean". */
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** The closest known command to a mistyped one, or null when nothing is close. */
export function suggestCommand(input, commands) {
  let best = null;
  let bestD = Infinity;
  for (const c of commands) {
    const dist = distance(String(input), c);
    if (dist < bestD) {
      best = c;
      bestD = dist;
    }
  }
  const len = String(input).length;
  return best && bestD <= (len <= 3 ? 1 : Math.max(2, Math.floor(len / 3))) ? best : null;
}

/** A time as the reader's local time with its UTC offset: "2026-11-14 10:05:00 +01:00". */
export function localTime(iso, tzOffsetMinutes) {
  if (!iso) return "-";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return String(iso);
  const offset = tzOffsetMinutes ?? -new Date(t).getTimezoneOffset();
  const local = new Date(t + offset * 60_000);
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const zone = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return `${local.toISOString().slice(0, 19).replace("T", " ")} ${zone}`;
}

/** A value as a merchant reads it: "(empty)" for nothing, strings unquoted, the rest as JSON. */
export function showValue(v) {
  if (v === undefined || v === null || v === "") return "(empty)";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v) && v.length === 0) return "(none)";
  const s = JSON.stringify(v);
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
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

/** A response that is not lvndr's JSON (an HTML page, a proxy's error): the --url is wrong. */
function notLvndr(ctx, status, text) {
  const looksHtml = /^\s*<(!doctype|html|head|body)/i.test(text ?? "");
  const what = looksHtml ? "an HTML page" : text ? "something that is not JSON" : "an empty answer";
  return new CliError(`${ctx.url} is not an lvndr server (HTTP ${status}, ${what}). Check --url or LVNDR_API_URL; it is the app's base URL, without /api/v1.`, EXIT.USAGE, { status, code: "not_lvndr" });
}

function errorFromResponse(ctx, status, text, retryAfter) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const e = body?.error;
  if (!e) return notLvndr(ctx, status, text);
  let message = typeof e === "string" ? e : e?.message ?? `HTTP ${status}`;
  const code = typeof e === "object" && e ? e.code : undefined;
  const scope = /lacks the (\w+) scope/.exec(message)?.[1];
  if (status === 403 && scope) message = `${message}. Create a key with the ${scope.charAt(0).toUpperCase()}${scope.slice(1)} scope in lvndr > Settings > Agents & API, then run \`lvndr login\` with it.`;
  if (status === 401 && (code === "key_expired" || code === "key_revoked")) message = `${message} Then run \`lvndr login\` with the new key.`;
  const suffix = status === 429 && retryAfter ? ` (retry after ${retryAfter}s)` : "";
  return new CliError(`${message}${suffix}`, exitCodeForStatus(status), { status, code, retryAfter: retryAfter ?? undefined });
}

/** One API call. Returns parsed JSON (or text when raw). Retries 429 up to 3 times (<= 60 s). */
export async function request(ctx, method, path, { body, query, raw = false, auth = true } = {}) {
  if (auth && !ctx.key) {
    throw new CliError("No API key. Run `lvndr login`, set LVNDR_API_KEY, or pass --key (lvndr > Settings > Agents & API).", EXIT.AUTH);
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
    if (!res.ok) throw errorFromResponse(ctx, res.status, text, res.headers.get("retry-after"));
    if (raw) {
      if (/text\/html/i.test(res.headers.get("content-type") ?? "")) throw notLvndr(ctx, res.status, text);
      return text;
    }
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw notLvndr(ctx, res.status, text);
    }
  }
}

/**
 * Poll GET /jobs/:id until the job is done, partial or failed. Progress goes to stderr (only
 * when it moves). A 429 waits for Retry-After instead of failing. Resolves to the final job.
 */
export async function waitForJob(ctx, job, io, { intervalMs } = {}) {
  // LVNDR_POLL_MS wins; otherwise the server's hint (job.pollAfterMs), else 2 s.
  const fixed = intervalMs ?? (ctx.env?.LVNDR_POLL_MS ? Number(ctx.env.LVNDR_POLL_MS) : null);
  const interval = (j) => fixed ?? (Number.isFinite(j?.pollAfterMs) && j.pollAfterMs > 0 ? Math.min(j.pollAfterMs, 30_000) : 2000);
  let last = "";
  const report = (j) => {
    const line = jobProgress(j);
    if (line !== last && !io.silent) io.stderr.write(`lvndr: ${line}\n`);
    last = line;
  };
  report(job);
  let current = job;
  while (!isJobFinal(current?.status)) {
    const every = interval(current);
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
  return s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s + " ".repeat(n - s.length);
}
const when = (iso) => localTime(iso);
const actorOf = (c) => c?.actor?.label ?? c?.actor?.name ?? c?.actor?.appTitle ?? c?.actor?.tier ?? c?.actorLabel ?? "";
/** "METAFIELD_DEFINITION" -> "metafield definition": the record type as a column reads it. */
const typeOf = (t) => String(t ?? "").toLowerCase().replace(/_/g, " ");

/**
 * Rows as a table with a header row: each column as wide as its widest cell (capped), the last
 * column free. `columns` = [[header, width cap], ...].
 */
export function table(columns, rows) {
  if (!rows.length) return [];
  const widths = columns.map(([h, cap], i) => (i === columns.length - 1 ? 0 : Math.min(cap, Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)))));
  const line = (cells) => cells.map((c, i) => (i === columns.length - 1 ? String(c ?? "") : pad(c, widths[i]))).join("  ").trimEnd();
  return [line(columns.map(([h]) => h)), ...rows.map(line)];
}

const CHANGE_COLUMNS = [["ID", 26], ["WHEN", 26], ["TYPE", 20], ["ACTION", 6], ["RECORD", 32], ["BY", 28], ["WHAT", 0]];
function changeRow(c) {
  return [c.id, when(c.occurredAt), typeOf(c.resourceType), c.action, c.resourceTitle ?? "", `${actorOf(c)}${c.actor?.tier ? ` (${c.actor.tier})` : ""}`, c.summary ?? c.fields ?? ""];
}
export function changeTable(list) {
  return table(CHANGE_COLUMNS, list.map(changeRow));
}

function runLines(run) {
  if (!run) return [];
  const out = [`undo ${run.status ?? "sent"}${run.id ? ` (undo record ${run.id})` : ""}`];
  for (const o of run.ops ?? []) out.push(`  ${o.ok ? "ok " : "ERR"} ${o.op}${o.errors?.length ? `: ${o.errors.join("; ")}` : ""}`);
  return out;
}

const STATUS_WORD = { ready: "will restore", conflict: "changed since", noop: "already back", unsupported: "can't undo" };

/** The per-field items every preview carries: grouped by record, "field: current -> target". */
function itemLines(items) {
  const out = [];
  let last = null;
  for (const i of items ?? []) {
    const key = `${i.changeId}`;
    if (key !== last) {
      const r = i.record ?? {};
      out.push(`${typeOf(r.type)} ${r.title ?? r.id ?? ""}  (change ${i.changeId})`);
      last = key;
    }
    out.push(`  ${pad(STATUS_WORD[i.status] ?? i.status, 13)} ${i.field}: ${showValue(i.current)} -> ${showValue(i.target)}${i.reason ? `  (${i.reason})` : ""}`);
  }
  return out;
}

/** The older plan shape (no items): one line per field with its path. */
function planLines(plan) {
  const out = [];
  for (const i of plan?.items ?? []) out.push(`  ${pad(STATUS_WORD[i.status] ?? i.status, 13)} ${i.path}: ${showValue(i.current)} -> ${showValue(i.target)}${i.reason ? `  (${i.reason})` : ""}`);
  return out;
}

/** True when a preview has nothing to write (the server says so, or nothing is ready). */
export function nothingToUndo(r) {
  if (!r || typeof r !== "object") return false;
  if (typeof r.nothingToUndo === "boolean") return r.nothingToUndo;
  if (r.plan?.counts) return (r.plan.counts.ready ?? 0) === 0;
  if (r.counts && "planned" in r.counts) return r.counts.planned === 0 && !(r.more > 0);
  if (r.outcomes) return (r.outcomes.restore ?? 0) === 0 && !(r.remaining > 0);
  return false;
}

/** Human rendering for a preview of any kind (one change, a run, a batch, a rollback). */
function previewLines(r) {
  const out = [];
  const p = r.preview ?? r; // a rollback preview nests under `preview`
  const items = Array.isArray(p.items) && p.items.length && p.items[0]?.field !== undefined ? p.items : null;
  if (items) out.push(...itemLines(items));
  else if (r.plan) out.push(...planLines(r.plan));
  // Changes the preview skips without a field list (already undone, not found).
  const listed = new Set((items ?? []).map((i) => i.changeId));
  for (const x of p.results ?? []) {
    if (listed.has(x.changeId)) continue;
    out.push(`  ${pad(x.status ?? "", 8)} ${x.resourceTitle ?? x.changeId ?? ""}: ${x.detail ?? ""}  (change ${x.changeId})`);
  }
  for (const c of p.changes ?? []) {
    if (listed.has(c.changeId)) continue;
    out.push(`  ${pad(c.outcome ?? "", 12)} ${typeOf(c.resourceType)} ${c.resourceTitle ?? c.resourceId ?? ""}: ${c.detail ?? ""}  (change ${c.changeId})`);
  }
  // What the undo also repairs (stock, links and redirects after a rebuild; a redirect turned around).
  for (const repair of r.plan?.repairs ?? []) out.push(`  also         ${repair.label}`);
  if (p.counts && "planned" in p.counts) out.push(`${p.counts.planned} change(s) to undo, ${p.counts.skipped ?? 0} skipped`);
  if (p.outcomes) out.push(`${p.outcomes.restore ?? 0} change(s) to undo, ${(p.outcomes["already-back"] ?? 0) + (p.outcomes.conflict ?? 0) + (p.outcomes.unsupported ?? 0)} left alone${p.outcomes.error ? `, ${p.outcomes.error} could not be read` : ""}`);
  if (typeof p.more === "number" && p.more > 0) out.push(`${p.more} more change(s) not planned in this preview (of ${p.total ?? "?"}); the undo covers them too`);
  if (typeof p.remaining === "number" && p.remaining > 0) out.push(`${p.remaining} more change(s) beyond this one pass; preview and run it again after it`);
  return out;
}

/** Human rendering of a single undo that ran: what it wrote and the undo's own ids. */
function undoResultLines(r) {
  const out = runLines(r.run);
  if (r.resultChangeId) out.push(`the undo's change: ${r.resultChangeId}`);
  else if (r.run) out.push("the undo's own change appears in the log within a minute (lvndr changes --hide-undos leaves it out)");
  return out;
}

/** Human rendering of a finished (or running) job. */
function jobLines(job) {
  const out = [jobProgress(job)];
  out.push(...table([["CHANGE", 26], ["STATUS", 8], ["ACTION", 6], ["RECORD", 32], ["DETAIL", 0]], (job?.results ?? []).map((x) => [x?.changeId ?? "", x?.status ?? "", x?.action ?? "", x?.resourceTitle ?? "", x?.detail ?? ""])).map((l) => `  ${l}`));
  if (job?.error) out.push(`error: ${job.error}`);
  if (job?.remaining) out.push(`not covered by this job: ${job.remaining}; run the undo again`);
  return out;
}

/** A queued undo (202 { job }): wait for it, then { result, human, exitCode }. */
async function finishQueued(ctx, r, io, flags) {
  if (!r?.job?.id) return { result: r, human: undoResultLines(r), exitCode: undoFailed(r) ? EXIT.UNDO_FAILED : EXIT.OK };
  const job = await waitForJob(ctx, r.job, { ...io, silent: flags.quiet });
  return { result: { ...r, job }, human: jobLines(job), quietIds: [job.id], exitCode: job.status === "done" ? EXIT.OK : EXIT.UNDO_FAILED };
}

/** Ask a yes/no question at the terminal; true only for y or yes. */
async function confirm(question, io) {
  const answer = await readLine(question, io, { prompt: true });
  return /^y(es)?$/i.test(answer.trim());
}

/**
 * Every store write goes through here, so it is bound to a plan someone saw:
 *   no flag                 preview, print it and the line that writes exactly that plan
 *   --run --plan-hash <h>   write that plan (the server refuses it, 409, if the store moved)
 *   --run without the hash  refused: preview first
 *   --yes                   a person at a terminal: preview, print it once, ask, then write it
 * A preview with nothing to write says "Nothing to undo" and prints no write command.
 */
async function writeFlow({ flags, io, preview, write, previewCommand, runCommand, extra = () => [] }) {
  if (flags.yes) {
    if (!(io.stdin ?? process.stdin).isTTY) {
      throw new CliError(`--yes is for a person at a terminal. Preview with \`${previewCommand}\`, show the plan, then pass the --plan-hash it prints.`);
    }
    const r = await preview();
    const out = flags.json || flags.quiet ? io.stderr : io.stdout;
    if (nothingToUndo(r)) return { result: r, human: [...previewLines(r), "Nothing to undo; nothing was written."] };
    for (const line of previewLines(r)) out.write(`${line}\n`);
    if (!r?.planHash) throw new CliError("the preview returned no plan to write");
    if (!(await confirm("Apply this undo to the live store? [y/N] ", io))) return { result: { ...r, applied: false }, human: ["Not applied; nothing was written."] };
    return write(r.planHash);
  }
  if (flags.run) {
    if (!flags.planHash) throw new CliError(`preview first: ${previewCommand} (it prints the --plan-hash to pass; or --yes at a terminal)`);
    return write(flags.planHash);
  }
  const r = await preview();
  if (nothingToUndo(r)) return { result: r, human: [...previewLines(r), "Nothing to undo; nothing was written."] };
  const hint = r?.planHash ? [`To run exactly this plan: ${runCommand} --plan-hash ${r.planHash}`] : [];
  return { result: r, human: [...previewLines(r), "preview only; nothing was written.", ...hint, ...extra(r)] };
}


const firstArray = (r, keys) => {
  for (const k of keys) if (Array.isArray(r?.[k])) return r[k];
  return null;
};

// ---------------------------------------------------------------------------------------------
// Commands

/** One usage line per command (and run subcommand), for errors and `lvndr <command> --help`. */
export const USAGE = Object.freeze({
  me: "me",
  status: "status",
  coverage: "coverage",
  changes: "changes [--since 24h] [--until ISO] [--type PRODUCT] [--action update] [--resource-id Product-1] [--actor name] [--q text] [--hide-undos] [--run-id id] [--limit 50] [--cursor c]",
  change: "change <id>",
  history: "history <gid|Type-digits> [--cursor c]",
  batch: "batch <id>",
  points: "points [--all | --kind manual|burst|app_install|sweep] [--limit 50] [--cursor c]",
  preview: "preview <pointId> [--only <kind>]... [--exclude <changeId>]...",
  alerts: "alerts [--all] [--limit 50]",
  export: "export [--format csv|json] [--since 7d] [--until ISO] [--out file]",
  openapi: "openapi",
  undo: "undo <id> [--field <path>]... [--include-conflicts] [--reason text]  |  undo <id> --run --plan-hash <h> [--field <path>]...  |  undo <id> --yes",
  "undo-batch": "undo-batch <id> [--only <kind>]... [--exclude <changeId>]... [--reason text]  |  undo-batch <id> --run --plan-hash <h> [--only <kind>]...  |  undo-batch <id> --yes",
  mark: "mark <label...> [--reason text]",
  rollback: "rollback <pointId> --confirm --plan-hash <h> [--only <kind>]... [--exclude <changeId>]... [--reason text]  |  rollback <pointId> --yes",
  job: "job <id>",
  dismiss: "dismiss <alertId>",
  "run start": "run start [--agent name] [--task text] [--client-id id] [--no-restore-point]",
  "run end": "run end [id]",
  "run show": "run show [id] [--cursor c]",
  "run list": "run list [--limit 20]",
  "run undo": "run undo [id] [--only <kind>]... [--exclude <changeId>]... [--reason text]  |  run undo [id] --run --plan-hash <h> [--only <kind>]...  |  run undo [id] --yes",
  guard: "guard [--agent name] [--task text] [--wait 300] -- <command...>",
  login: "login [--key lv_... | --with-token] [--url URL] [--profile name] [--no-verify]",
});

/** What each command does, shown under its usage by `lvndr <command> --help`. */
const DETAIL = {
  me: "Which shop and key this is, with the key's scopes and the plan.",
  status: "Plan, tracked record counts, the last activity check and pending deliveries.",
  coverage: "What LVNDR tracks and can undo in this store, per record type, with the types that need a permission (and which Shopify scopes to grant in the app), translations and kept media originals.",
  changes: "Changes, newest first. --since/--until take 30m, 24h, 7d, 2w or an ISO time. Pages with --cursor.",
  change: "One change with its full before/after diff and attribution.",
  history: "Every stored version and change of one record (gid://shopify/Product/1 or Product-1).",
  batch: "Everything one actor did around a change (no gap over ten minutes).",
  points: "Restore points, newest first. The daily check's points are hidden unless --all (or --kind sweep).",
  preview: "What rolling back to a restore point would undo. Prints the `lvndr rollback <pointId> --confirm --plan-hash <h>` line that runs exactly that plan.",
  alerts: "Open anomaly alerts; --all includes dismissed ones.",
  export: "Download the change log as CSV (default) or JSON.",
  openapi: "The API's OpenAPI document.",
  undo:
    "Without flags: preview the undo of one change (writes nothing) and print the line that runs exactly that plan.\n--field <path> (repeatable): put back only those fields; the preview lists each field's path.\n--run --plan-hash <h>: write the previewed plan; refused (exit 7) if the store moved since or it was already undone.\n--yes: for a person at a terminal: preview, ask Apply? [y/N], then write that plan.",
  "undo-batch":
    "Without flags: preview undoing one actor's batch around a change.\n--only <kind> (repeatable): put back only those kinds of field, as the preview lists them (e.g. --only Price).\n--exclude <changeId> (repeatable): leave a change out; it stays undoable.\n--run --plan-hash <h>: queue that plan as a background job and wait for it.\n--yes: for a person at a terminal: preview, ask, then run it.",
  mark: "Mark a restore point now, for example before a bulk job.",
  rollback:
    "Undo every change after a restore point, newest first. Preview first with `lvndr preview <pointId>`, then pass --confirm and the --plan-hash it printed.\n--yes: for a person at a terminal: preview, ask, then roll back.",
  job: "One background undo job and its progress.",
  dismiss: "Dismiss an anomaly alert (needs a key with the Undo scope).",
  "run start": "Announce an agent run (marks a restore point unless --no-restore-point). The agent name defaults to --agent, LVNDR_AGENT or the profile's agent. Prints what the run will collect, and a WARNING when it will collect nothing.",
  "run end": "Close the current (or named) run. Ending it again is harmless.",
  "run show": "One run, its changes and how fresh the tagging is (attributedThrough, pending deliveries).",
  "run list": "Recent agent runs.",
  "run undo":
    "Without flags: preview undoing every change tagged with the run.\n--run --plan-hash <h>: queue that plan as a background job and wait for it.\n--yes: for a person at a terminal: preview, ask, then run it.",
  guard:
    "Check the command exists, start a run (with a restore point), run the command with LVNDR_RUN_ID set, end the run, then poll the run every 20 s for up to --wait seconds (default 300) until attribution has caught up, printing the changes tagged so far and what it still waits for; then the changes and the undo line. --wait 0 skips waiting.",
  login: "Save a profile (URL and key) to ~/.config/lvndr/config.json after checking the key. Without --key it asks for the key without echoing it; --with-token reads it from stdin (lvndr login --with-token < key.txt).",
};

/** Help for one command ("undo", "run undo", or "run" for all run subcommands), or null. */
export function commandHelp(topic) {
  const name = String(topic ?? "").trim().replace(/\s+/g, " ");
  if (name === "run" || name === "runs") {
    return ["Usage:", ...Object.keys(USAGE).filter((k) => k.startsWith("run ")).map((k) => `  lvndr ${USAGE[k]}`), "", "Agent runs: announce, review and undo a unit of agent work."].join("\n");
  }
  if (!USAGE[name]) return null;
  return [`Usage: lvndr ${USAGE[name].split("  |  ").join("\n       lvndr ")}`, "", DETAIL[name] ?? "", "", "Global options: --json --ndjson --quiet --key --url --profile --agent --run-id --no-retry --timeout"].join("\n");
}

const HELP = `lvndr ${VERSION}: Shopify store change log, undo and restore points

Usage: lvndr <command> [options]       lvndr <command> --help for one command

Read
  me                                   which shop and key this is
  status                               plan, tracked counts, last activity check
  coverage                             what is tracked and undoable; types that need a permission
  changes [--since 24h] [--until ISO] [--type PRODUCT] [--action update] [--resource-id Product-1]
          [--actor name] [--q text] [--hide-undos] [--run-id id] [--limit 50] [--cursor c]
  change <id>                          one change with its diff
  history <gid|Type-digits>            every version of one record
  batch <id>                           everything one actor did around a change
  points [--all]                       restore points (--all includes the daily check's)
  preview <pointId>                    what rolling back to a point would write
  alerts [--all]                       open anomaly alerts (--all includes dismissed)
  run show [id] | run list             agent runs
  export [--format csv|json] [--since] [--until] [--out file]
  openapi                              the API's OpenAPI document

Write (every write is bound to the plan its preview printed)
  undo <id> [--include-conflicts]      preview; prints the line that runs exactly that plan
  undo <id> --run --plan-hash <h>      write the previewed plan
  undo-batch <id> [--run --plan-hash <h>]
  run undo [id] [--run --plan-hash <h>]
  rollback <pointId> --confirm --plan-hash <h>   (preview with: lvndr preview <pointId>)
  --yes                                a person at a terminal: preview, ask Apply? [y/N], write
  mark <label...> [--reason text]      mark a restore point now
  job <id>                             one background undo job and its progress
  dismiss <alertId>                    (needs the Undo scope)
  run start [--agent name] [--task text] [--client-id id] [--no-restore-point]
  run end [id]
                                       undo-batch, run undo and rollback queue a job and wait for it
  guard [--agent name] [--task text] [--wait 300] -- <command...>
                                       run + restore point around a command, then the undo line

Setup
  login [--key lv_... | --with-token] [--url URL] [--profile name] [--no-verify]
                                       asks for the key without echoing it; --with-token reads stdin

Global options
  --json  compact JSON on stdout     --ndjson  one JSON object per line for lists
  --quiet  ids only                  --key, --url, --profile, --agent (X-Lvndr-Agent), --run-id
  --no-retry  fail on 429 at once    --timeout <seconds>     --reason <text> on writes

Exit codes: 0 ok, 1 usage/other, 2 undo partial or failed, 3 auth (401/403), 4 not found,
5 rate limited, 6 network, 7 conflict (409, e.g. plan_changed: preview again), 8 the shop's
plan lacks the API (402). Environment: LVNDR_API_KEY, LVNDR_API_URL, LVNDR_PROFILE,
LVNDR_AGENT, LVNDR_RUN_ID, LVNDR_CONFIG, LVNDR_POLL_MS (job polling; default: the server's pollAfterMs),
LVNDR_GUARD_POLL_MS (guard's run polling, default 20000). Keys: lvndr > Settings > Agents & API.`;

function need(args, n, usage) {
  if (args.length < n || args.slice(0, n).some((a) => !a)) throw new CliError(`usage: lvndr ${usage}`);
  return args;
}

function currentRun(ctx, explicit) {
  const id = explicit ?? ctx.runId ?? ctx.config.currentRun?.[ctx.profileName];
  if (!id) throw new CliError("no run id: pass one, set LVNDR_RUN_ID, or start one with `lvndr run start`");
  return id;
}

const runIdOf = (r) => r?.run?.id ?? r?.id;

/**
 * One line from stdin. At a terminal the prompt is shown on stderr and, with `mask`, nothing
 * typed is echoed (an API key must not end up on screen or in scrollback). Resolves "" at EOF.
 */
export function readLine(prompt, io, { mask = false, prompt: show = true } = {}) {
  const input = io.stdin ?? process.stdin;
  const tty = !!input.isTTY;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const rl = createInterface({ input, output: io.stderr, terminal: tty && mask && typeof input.setRawMode === "function" });
    if (tty && show) io.stderr.write(prompt);
    // Muted: readline echoes each keystroke through _writeToOutput; drop them.
    if (mask && rl.terminal) rl._writeToOutput = () => {};
    rl.once("line", (line) => {
      // Resolve before close: close fires "close" synchronously, which would resolve "" first.
      finish(line.trim());
      if (mask && tty) io.stderr.write("\n");
      rl.close();
    });
    rl.once("close", () => finish(""));
  });
}

/** Everything on stdin until EOF (for `login --with-token < key.txt`), first line trimmed. */
export async function readAll(input) {
  let text = "";
  input.setEncoding?.("utf8");
  for await (const chunk of input) text += chunk;
  return text.split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";
}

/** Attribution has caught up with the run: everything up to its end is tagged, nothing pending. */
export function runIsFresh(detail, through) {
  if (!detail?.attributedThrough || detail.pendingDeliveries !== 0) return false;
  return Date.parse(detail.attributedThrough) >= Date.parse(through);
}

/** What a run read is still waiting for, in words: "attribution to reach 10:05:00 (now 10:03:12), 2 deliveries pending". */
export function waitingFor(detail, through) {
  const parts = [];
  const at = detail?.attributedThrough;
  if (!at || Date.parse(at) < Date.parse(through)) parts.push(`attribution to reach the run's end (${localTime(through)}; it is at ${at ? localTime(at) : "never"})`);
  const pending = detail?.pendingDeliveries;
  if (pending !== 0) parts.push(`${pending ?? "?"} Shopify deliver${pending === 1 ? "y" : "ies"} to be processed`);
  return parts.join(" and ");
}

/**
 * Poll GET /runs/:id every LVNDR_GUARD_POLL_MS (20 s) until attribution has covered `through`
 * and no delivery is pending, or `waitS` runs out. One read when waitS is 0. While waiting it
 * prints each newly tagged change once and, when nothing new arrived, one line with the elapsed
 * time and what it still waits for. Resolves to the last run detail (or null) and whether it was fresh.
 */
async function waitForRun(ctx, id, through, waitS, io, { quiet = false } = {}) {
  const every = Number(ctx.env?.LVNDR_GUARD_POLL_MS ?? 20_000);
  const started = Date.now();
  const deadline = started + Math.max(0, waitS) * 1000;
  const shown = new Set();
  let detail = null;
  for (;;) {
    try {
      detail = await request(ctx, "GET", `/runs/${encodeURIComponent(id)}`, { query: { limit: 200 } });
    } catch (e) {
      io.stderr.write(`lvndr: could not read run ${id}: ${e.message}\n`);
      return { detail, fresh: false };
    }
    if (runIsFresh(detail, through)) return { detail, fresh: true };
    if (Date.now() + every > deadline) return { detail, fresh: false };
    if (!quiet) {
      const fresh = (detail?.changes ?? []).filter((c) => !shown.has(c.id));
      for (const c of fresh) shown.add(c.id);
      const elapsed = Math.round((Date.now() - started) / 1000);
      if (fresh.length) {
        io.stderr.write(`lvndr: ${fresh.length} more change(s) tagged so far (${shown.size} in all):\n`);
        for (const line of changeTable(fresh)) io.stderr.write(`  ${line}\n`);
      }
      io.stderr.write(`lvndr: ${elapsed}s of ${waitS}s: waiting for ${waitingFor(detail, through)}\n`);
    }
    await sleep(every);
  }
}

/** Whether `command` can be started: a path to an executable file, or a name found on PATH. */
export function commandExists(command, env = process.env) {
  if (!command) return false;
  const isExe = (p) => {
    try {
      accessSync(p, fsConstants.X_OK);
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (command.includes("/") || command.includes("\\")) return isExe(command);
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of String(env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) if (isExe(join(dir, command + ext))) return true;
  }
  return false;
}

async function guard(ctx, parsed, io) {
  const { flags, passthrough } = parsed;
  if (!passthrough?.length) throw new CliError(`usage: lvndr ${USAGE.guard}`);
  const err = (s) => io.stderr.write(`${s}\n`);
  const waitS = Number(flags.wait ?? 300);
  if (!Number.isFinite(waitS) || waitS < 0) throw new CliError("--wait takes seconds, e.g. --wait 300");
  // Check before anything is written to lvndr: a typo must not leave a run and a restore point behind.
  if (!commandExists(passthrough[0], ctx.env)) throw new CliError(`cannot run ${passthrough[0]}: no such command (nothing was started)`, 127);
  const agent = flags.agent ?? ctx.env.LVNDR_AGENT ?? "lvndr-guard";
  const started = await request({ ...ctx, agent }, "POST", "/runs", {
    body: { agent, task: flags.task ?? passthrough.join(" ").slice(0, 200), clientId: flags.clientId, markRestorePoint: !flags.noRestorePoint },
  });
  const id = runIdOf(started);
  if (!id) throw new CliError("the API did not return a run id; not running the command");
  const point = started.restorePoint?.id ?? started.run?.restorePointId;
  err(`lvndr: run ${id} started${point ? `, restore point ${point}` : ""}`);
  if (started.captureNote) err(`lvndr: capture ${started.capture ?? "?"}: ${started.captureNote}`);
  if (started.warning) err(`lvndr: WARNING: ${started.warning}`);

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
  // The run's end, on the server's clock: attribution must cover writes up to here.
  let through = new Date().toISOString();
  try {
    const ended = await request({ ...ctx, agent }, "POST", `/runs/${encodeURIComponent(id)}/end`, { body: {} });
    through = ended.run?.endedAt ?? through;
  } catch (e) {
    endError = e;
    err(`lvndr: could not end run ${id}: ${e.message}`);
  }
  if (!flags.json && waitS > 0) err(`lvndr: command exited ${exitCode}; waiting up to ${waitS}s for lvndr to tag the run's changes (Shopify reports them over a few minutes)`);
  const { detail, fresh } = await waitForRun({ ...ctx, agent }, id, through, waitS, io, { quiet: !!flags.json });
  const changes = detail?.changes ?? [];
  const previewLine = `lvndr run undo ${id}`;
  if (flags.json) {
    err(JSON.stringify({ runId: id, restorePointId: point ?? null, exitCode, ended: !endError, fresh, attributedThrough: detail?.attributedThrough ?? null, pendingDeliveries: detail?.pendingDeliveries ?? null, changes, undo: previewLine }));
  } else {
    err(`lvndr: command exited ${exitCode}; run ${id} ${endError ? "NOT ended" : "ended"}; ${changes.length} change(s) tagged${fresh ? "" : " so far"}`);
    for (const line of changeTable(changes)) err(`  ${line}`);
    if (!fresh) err(`lvndr: attribution has not caught up yet (still waiting for ${waitingFor(detail, through)}); check again with: lvndr run show ${id}`);
    err(`To preview the undo:  ${previewLine}   (it prints the --run --plan-hash line that runs it)`);
  }
  return exitCode;
}

async function login(parsed, io) {
  const { flags } = parsed;
  const ctx = resolveContext(flags, io.env, { allowMissingProfile: true });
  const stdin = io.stdin ?? process.stdin;
  let key = flags.key ?? (flags.withToken ? undefined : ctx.env.LVNDR_API_KEY);
  if (!key && flags.withToken) key = await readAll(stdin);
  else if (!key) key = await readLine("lvndr API key (Settings > Agents & API; not shown as you type): ", io, { mask: true });
  if (!key) throw new CliError(flags.withToken ? "no key on stdin (lvndr login --with-token < file-with-key)" : "no key given");
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

/** The `lvndr changes` command line that repeats these filters, for the "more" hint. */
export function changesCommand(flags, cursor) {
  const parts = ["lvndr changes"];
  const q = (v) => (/^[\w@%+=:,./-]+$/.test(v) ? v : `'${String(v).replace(/'/g, `'\\''`)}'`);
  for (const name of ["since", "until", "type", "action", "resource-id", "actor", "q", "run-id", "limit"]) {
    const v = flags[camel(name)];
    if (v !== undefined && v !== "") parts.push(`--${name} ${q(String(v))}`);
  }
  if (flags.hideUndos) parts.push("--hide-undos");
  if (flags.profile) parts.push(`--profile ${q(flags.profile)}`);
  parts.push(`--cursor ${cursor}`);
  return parts.join(" ");
}

/** Runs one command; returns { result, human: string[], notes?: string[], list?, quietIds?, exitCode? }. */
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
      return { result: r, human: [`${r.shop ?? "?"}  key: ${k.label ?? k.id ?? "?"}${scopes ? `  scopes: ${scopes}` : ""}${r.plan ? `  plan: ${r.plan.label ?? r.plan.handle ?? r.plan}` : ""}${k.expiresAt ? `  expires: ${when(k.expiresAt)}` : ""}`] };
    }
    case "status": {
      const s = await request(ctx, "GET", "/status");
      return {
        result: s,
        human: [
          `${s.shop}  plan: ${s.plan?.label ?? s.plan?.handle ?? "?"}`,
          `tracked: ${Object.entries(s.tracked ?? {}).map(([k, v]) => `${typeOf(k)} ${v}`).join(", ") || "-"}`,
          `last activity check: ${s.lastPolledAt ? when(s.lastPolledAt) : "never"}  pending deliveries: ${s.deliveries?.pending ?? "?"}`,
        ],
      };
    }
    case "coverage": {
      // A type that needs a permission is a status line, never a failure (exit 0).
      const r = await request(ctx, "GET", "/coverage");
      const word = { tracked: "tracked", read_only: "tracked, undo needs permission", needs_permission: "needs permission" };
      const human = (r.types ?? []).map((t) => `${String(t.label ?? t.type).padEnd(22)} ${word[t.status] ?? t.status}${t.undo && t.status === "tracked" ? `  undo: ${t.undo}` : ""}${t.missingScopes?.length ? `  (${t.missingScopes.join(", ")})` : ""}`);
      if (r.translations) human.push(`${"Translations".padEnd(22)} ${word[r.translations.status] ?? r.translations.status}${r.translations.missingScopes?.length ? `  (${r.translations.missingScopes.join(", ")})` : ""}`);
      if (r.mediaOriginals) human.push(`${"Media originals".padEnd(22)} ${r.mediaOriginals.status}${r.mediaOriginals.files ? `  ${r.mediaOriginals.files} file${r.mediaOriginals.files === 1 ? "" : "s"} kept` : ""}`);
      const notes = r.missingScopes?.length ? [`To grant: open LVNDR in the Shopify admin, Settings > Tracking coverage (${r.missingScopes.join(", ")}).`] : [];
      return { result: r, human, notes };
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
        limit: parseLimit(flags.limit),
        cursor: flags.cursor,
      };
      const r = await request(ctx, "GET", "/changes", { query });
      const list = r.changes ?? [];
      const human = changeTable(list);
      if (!list.length) human.push("no changes");
      const notes = r.nextCursor ? [`more: ${changesCommand(flags, r.nextCursor)}`] : [];
      return { result: r, human, notes, list, quietIds: list.map((c) => c.id) };
    }
    case "change": {
      need(args, 1, USAGE.change);
      const r = await request(ctx, "GET", `/changes/${enc(args[0])}`);
      const c = r.change ?? r;
      const human = [
        `${typeOf(c.resourceType)} ${c.resourceTitle ?? ""} (${c.resourceId})`,
        `${c.action} at ${when(c.occurredAt)} by ${actorOf(c)} [${c.actor?.tier ?? "?"}]${c.actor?.note ? `: ${c.actor.note}` : ""}`,
      ];
      if (c.summary) human.push(c.summary);
      for (const e of c.diff ?? []) human.push(`  ${e.field ?? e.path}: ${e.beforeText ?? showValue(e.before)} -> ${e.afterText ?? showValue(e.after)}`);
      return { result: r, human };
    }
    case "history": {
      need(args, 1, USAGE.history);
      const r = await request(ctx, "GET", `/records/${enc(toGid(args[0]))}/history`, { query: { cursor: flags.cursor } });
      const list = firstArray(r, ["changes", "history"]) ?? [];
      const rec = r.record ?? {};
      const human = [`${typeOf(rec.resourceType)} ${rec.title ?? ""} (${rec.resourceId ?? toGid(args[0])})${rec.deleted ? "  [deleted]" : ""}`];
      human.push(...table([["VERSION", 8], ["CAPTURED", 26], ["SOURCE", 0]], (r.versions ?? []).map((v) => [`v${v.version}`, when(v.capturedAt), v.source ?? ""])).map((l) => `  ${l}`));
      human.push(...changeTable(list));
      if (!list.length) human.push("no changes");
      const notes = r.nextCursor ? [`more: lvndr history ${args[0]} --cursor ${r.nextCursor}`] : [];
      return { result: r, human, notes, list };
    }
    case "undo": {
      need(args, 1, USAGE.undo);
      const path = `/changes/${enc(args[0])}/undo`;
      const includeConflicts = !!flags.includeConflicts;
      // --field <path> (repeatable): put back only those fields, e.g. one variant's price.
      const fields = flags.field?.length ? flags.field : undefined;
      const fieldArgs = (fields ?? []).map((f) => ` --field ${shellQuote(f)}`).join("");
      const runCommand = `lvndr undo ${args[0]} --run${includeConflicts ? " --include-conflicts" : ""}${fieldArgs}`;
      const preview = () => request(ctx, "POST", path, { body: { dryRun: true, includeConflicts, fields, reason: flags.reason } });
      const write = async (planHash) => {
        const r = await request(ctx, "POST", path, { body: { dryRun: false, includeConflicts, fields, planHash, reason: flags.reason } });
        return { result: r, human: undoResultLines(r), quietIds: [r.undoRunId ?? r.run?.id], exitCode: undoFailed(r) ? EXIT.UNDO_FAILED : EXIT.OK };
      };
      // With several fields to put back and no --field, show how to put back only some of them.
      const extra = (r) => {
        const ready = (r?.items ?? []).filter((i) => i.status === "ready" || (includeConflicts && i.status === "conflict"));
        if (fields || ready.length < 2) return fields ? [`only: ${fields.join(", ")}`] : [];
        return ["To put back only some fields, add --field <path> for each:", ...ready.map((i) => `  --field ${shellQuote(i.path)}   ${i.field}`)];
      };
      return writeFlow({ flags, io, preview, write, previewCommand: `lvndr undo ${args[0]}${includeConflicts ? " --include-conflicts" : ""}${fieldArgs}`, runCommand, extra });
    }
    case "batch": {
      need(args, 1, USAGE.batch);
      const r = await request(ctx, "GET", `/batches/${enc(args[0])}`);
      const list = r.changes ?? [];
      return { result: r, human: [`${list.length} changes by ${r.actorLabel ?? "?"}`, ...changeTable(list)], list };
    }
    case "undo-batch": {
      need(args, 1, USAGE["undo-batch"]);
      const path = `/batches/${enc(args[0])}/undo`;
      const n = narrowing(flags);
      return writeFlow({
        flags,
        io,
        preview: () => request(ctx, "POST", path, { body: { dryRun: true, reason: flags.reason, ...n.body } }),
        write: async (planHash) => finishQueued(ctx, await request(ctx, "POST", path, { body: { dryRun: false, planHash, reason: flags.reason, ...n.body } }), io, flags),
        previewCommand: `lvndr undo-batch ${args[0]}${n.echo}`,
        runCommand: `lvndr undo-batch ${args[0]} --run${n.echo}`,
        extra: (r) => kindHints(r, flags, `lvndr undo-batch ${args[0]}`),
      });
    }
    case "points": {
      const r = await request(ctx, "GET", "/restore-points", { query: { kind: flags.all ? "all" : flags.kind, limit: parseLimit(flags.limit), cursor: flags.cursor } });
      const list = r.points ?? r.restorePoints ?? [];
      const human = table([["ID", 26], ["AT", 26], ["KIND", 11], ["LABEL", 0]], list.map((p) => [p.id, when(p.at), p.kind, p.label ?? ""]));
      if (!list.length) human.push("no restore points");
      const notes = r.nextCursor ? [`more: lvndr points${flags.all ? " --all" : flags.kind ? ` --kind ${flags.kind}` : ""}${flags.limit ? ` --limit ${flags.limit}` : ""} --cursor ${r.nextCursor}`] : [];
      if (!flags.all && !flags.kind) notes.push("(the daily check's points are hidden; --all shows them)");
      return { result: r, human, notes, list, quietIds: list.map((p) => p.id) };
    }
    case "mark": {
      const label = args.join(" ") || undefined;
      const r = await request(ctx, "POST", "/restore-points", { body: { label, reason: flags.reason } });
      const p = r.point ?? r.restorePoint ?? r;
      return { result: r, human: [`marked ${p.id} at ${when(p.at)}${p.label ? `  ${p.label}` : ""}`], quietIds: [p.id] };
    }
    case "preview": {
      need(args, 1, USAGE.preview);
      const n = narrowing(flags);
      const r = await request(ctx, "GET", `/restore-points/${enc(args[0])}/preview`, { query: { kinds: flags.only?.join(","), exclude: flags.exclude?.join(",") } });
      if (nothingToUndo(r)) return { result: r, human: [...previewLines(r), "Nothing to undo after this restore point; nothing was written."] };
      const hint = `To roll back exactly this: lvndr rollback ${args[0]} --confirm --plan-hash ${r.planHash}${n.echo}`;
      return { result: r, human: [...previewLines(r), "preview only; nothing was written.", hint, ...kindHints(r, flags, `lvndr preview ${args[0]}`)] };
    }
    case "rollback": {
      need(args, 1, USAGE.rollback);
      const path = `/restore-points/${enc(args[0])}/rollback`;
      if (!flags.confirm && !flags.yes) throw new CliError(`rollback writes to the store. Preview first: lvndr preview ${args[0]} (it prints the --confirm --plan-hash line to run).`);
      const n = narrowing(flags);
      return writeFlow({
        flags: { ...flags, run: true },
        io,
        preview: async () => {
          const r = await request(ctx, "GET", `${path.replace(/\/rollback$/, "")}/preview`, { query: { kinds: flags.only?.join(","), exclude: flags.exclude?.join(",") } });
          return { ...(r.preview ?? {}), planHash: r.planHash, ...(typeof r.nothingToUndo === "boolean" ? { nothingToUndo: r.nothingToUndo } : {}) };
        },
        write: async (planHash) => finishQueued(ctx, await request(ctx, "POST", path, { body: { confirm: true, planHash, reason: flags.reason, ...n.body } }), io, flags),
        previewCommand: `lvndr preview ${args[0]}${n.echo}`,
        runCommand: `lvndr rollback ${args[0]} --confirm${n.echo}`,
      });
    }
    case "job": {
      need(args, 1, USAGE.job);
      const r = await request(ctx, "GET", `/jobs/${enc(args[0])}`);
      const job = r.job ?? r;
      const failed = job.status === "partial" || job.status === "failed";
      return { result: r, human: jobLines(job), quietIds: [job.id], exitCode: failed ? EXIT.UNDO_FAILED : EXIT.OK };
    }
    case "alerts": {
      const r = await request(ctx, "GET", "/alerts", { query: { status: flags.all ? "all" : flags.status ?? "open", limit: parseLimit(flags.limit) } });
      const list = r.alerts ?? [];
      const human = table(
        [["ID", 26], ["CREATED", 26], ["STATUS", 9], ["COUNT", 5], ["BY", 28], ["BATCH", 0]],
        list.map((a) => [a.id, when(a.createdAt ?? a.windowStart), a.status, a.count ?? a.changeCount ?? "", a.actorLabel ?? a.actorKey ?? "", a.anchorChangeId ? `lvndr batch ${a.anchorChangeId}` : ""]),
      );
      if (!list.length) human.push("no alerts");
      return { result: r, human, list, quietIds: list.map((a) => a.id) };
    }
    case "dismiss": {
      need(args, 1, USAGE.dismiss);
      const r = await request(ctx, "POST", `/alerts/${enc(args[0])}/dismiss`, { body: {} });
      return { result: r, human: [r.dismissed === false ? `alert ${args[0]} was not open (${r.alert?.status ?? "already closed"}); nothing changed` : `dismissed ${args[0]}`] };
    }
    case "run":
    case "runs": {
      const sub = command === "runs" ? "list" : args[0];
      const id = args[1];
      if (sub === "start") {
        // Same rule as POST /runs: an agent name is required, and the CLI always has one
        // (--agent, LVNDR_AGENT, the profile's agent, or "lvndr-cli"). The task is optional.
        const agent = flags.agent ?? ctx.agent;
        const r = await request({ ...ctx, agent }, "POST", "/runs", { body: { agent, task: flags.task, clientId: flags.clientId, markRestorePoint: !flags.noRestorePoint } });
        const runId = runIdOf(r);
        if (runId) {
          ctx.config.currentRun = { ...(ctx.config.currentRun ?? {}), [ctx.profileName]: runId };
          saveConfig(ctx.config, ctx.env);
        }
        const point = r.restorePoint?.id ?? r.run?.restorePointId;
        if (r.warning && (flags.json || flags.quiet)) io.stderr.write(`lvndr: WARNING: ${r.warning}\n`);
        return {
          result: r,
          human: [...(r.warning ? [`WARNING: ${r.warning}`] : []), `run ${runId} started${point ? `, restore point ${point}` : ""}`, ...(r.captureNote ? [`capture ${r.capture ?? "?"}: ${r.captureNote}`] : []), `export LVNDR_RUN_ID=${runId}`],
          quietIds: [runId],
        };
      }
      if (sub === "end") {
        // A second `run end` (the current run already cleared) ends the last run again: harmless.
        const runId = id ?? ctx.runId ?? ctx.config.currentRun?.[ctx.profileName] ?? ctx.config.lastRun?.[ctx.profileName];
        if (!runId) throw new CliError("no run id: pass one, set LVNDR_RUN_ID, or start one with `lvndr run start`");
        const r = await request(ctx, "POST", `/runs/${enc(runId)}/end`, { body: {} });
        if (ctx.config.currentRun?.[ctx.profileName] === runId || ctx.config.lastRun?.[ctx.profileName] !== runId) {
          if (ctx.config.currentRun?.[ctx.profileName] === runId) delete ctx.config.currentRun[ctx.profileName];
          ctx.config.lastRun = { ...(ctx.config.lastRun ?? {}), [ctx.profileName]: runId };
          saveConfig(ctx.config, ctx.env);
        }
        const run = r.run ?? r;
        const head = r.alreadyEnded ? `run ${runId} had already ended at ${when(run.endedAt)}; nothing changed` : `run ${runId} ended${run.changeCount !== undefined ? `; ${run.changeCount} change(s) so far` : ""}`;
        return { result: r, human: [head, `Changes arrive over a few minutes; review with: lvndr run show ${runId}`, `To preview the undo:  lvndr run undo ${runId}`] };
      }
      if (sub === "show") {
        const runId = currentRun(ctx, id);
        const r = await request(ctx, "GET", `/runs/${enc(runId)}`, { query: { cursor: flags.cursor, limit: parseLimit(flags.limit, 200) } });
        const run = r.run ?? r;
        const list = r.changes ?? run.changes ?? [];
        return {
          result: r,
          human: [
            `${run.id}  ${run.agent ?? ""}  ${run.task ?? ""}`,
            `started ${when(run.startedAt)}  ${run.endedAt ? `ended ${when(run.endedAt)}` : "still open"}${run.restorePointId ? `  restore point ${run.restorePointId}` : ""}  capture ${run.capture ?? "?"}`,
            `attributed through ${r.attributedThrough ? when(r.attributedThrough) : "never"}  pending deliveries ${r.pendingDeliveries ?? "?"}`,
            ...changeTable(list),
            ...(list.length ? [] : ["no changes tagged yet"]),
          ],
          notes: r.nextCursor ? [`more: lvndr run show ${runId} --cursor ${r.nextCursor}`] : [],
          list,
        };
      }
      if (sub === "list") {
        const r = await request(ctx, "GET", "/runs", { query: { limit: parseLimit(flags.limit) } });
        const list = r.runs ?? [];
        const human = table(
          [["ID", 26], ["STARTED", 26], ["STATUS", 6], ["AGENT", 20], ["CHANGES", 7], ["TASK", 0]],
          list.map((x) => [x.id, when(x.startedAt), x.status ?? (x.endedAt ? "ended" : "open"), x.agent, x.changeCount ?? "", x.task ?? ""]),
        );
        if (!list.length) human.push("no runs");
        return { result: r, human, list, quietIds: list.map((x) => x.id) };
      }
      if (sub === "undo") {
        const runId = currentRun(ctx, id);
        const path = `/runs/${enc(runId)}/undo`;
        const n = narrowing(flags);
        return writeFlow({
          flags,
          io,
          preview: () => request(ctx, "POST", path, { body: { dryRun: true, reason: flags.reason, ...n.body } }),
          write: async (planHash) => finishQueued(ctx, await request(ctx, "POST", path, { body: { dryRun: false, planHash, reason: flags.reason, ...n.body } }), io, flags),
          previewCommand: `lvndr run undo ${runId}${n.echo}`,
          runCommand: `lvndr run undo ${runId} --run${n.echo}`,
          extra: (r) => kindHints(r, flags, `lvndr run undo ${runId}`),
        });
      }
      const hint = sub ? suggestCommand(sub, ["start", "end", "show", "list", "undo"]) : null;
      throw new CliError(`${sub ? `unknown run command: ${sub}${hint ? ` (did you mean \`lvndr run ${hint}\`?)` : ""}` : "usage: lvndr run start|end|show|list|undo"}\n\n${commandHelp("run")}`);
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
    default: {
      const hint = suggestCommand(command, COMMANDS);
      throw new CliError(`unknown command: ${command}${hint ? ` (did you mean \`lvndr ${hint}\`?)` : ""}\n\nRun \`lvndr help\` for every command.`);
    }
  }
}

/** Every top-level command, for "did you mean". */
export const COMMANDS = Object.freeze([...new Set([...Object.keys(USAGE).map((k) => k.split(" ")[0]), "runs", "help", "login", "guard"])]);

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
    // `lvndr undo --help`, `lvndr help undo`, `lvndr run undo --help`: that command's usage.
    const words = command === "help" ? parsed.args : command ? [command, ...parsed.args] : [];
    const topic = words.join(" ");
    const text = words.length ? (commandHelp(words.slice(0, 2).join(" ")) ?? commandHelp(words[0])) : null;
    if (topic && !text) {
      const hint = suggestCommand(words[0], COMMANDS);
      io.stderr.write(`lvndr: no command "${topic}"${hint ? ` (did you mean \`lvndr ${hint}\`?)` : ""}\n\n${HELP}\n`);
      return EXIT.USAGE;
    }
    io.stdout.write(`${text ?? HELP}\n`);
    return EXIT.OK;
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
    // Hints ("more: ..."), after the output and off stdout, so pipes and --quiet stay clean.
    if (!flags.json) for (const note of out.notes ?? []) io.stderr.write(`${note}\n`);
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
  // `lvndr openapi | head`: the reader went away; that is not an error worth a stack trace.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (e) => {
      if (e?.code === "EPIPE") process.exit(process.exitCode ?? 0);
      throw e;
    });
  }
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

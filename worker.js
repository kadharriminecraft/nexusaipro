/* =====================================================================
   NEXUS BACKGROUND RELAY v15 — Cloudflare Worker
   THE WORKER OWNS THE REQUEST — AND NOW YOUR FILES.
   =====================================================================
   v15 — "CLOUDFLARE IS THE BACKUP": the workspace file mirror + the
   server-side agent loop.
   The v14-and-earlier design executed EVERY agentic tool round on the
   phone — by design, that is where the credentials and the files lived.
   Two consequences the user hit in production: (1) a tool round could
   only progress while the phone was attached, so an agent coding run
   stalled the moment the phone left; (2) a tool-call argument cut
   (free models mid-write_file) PARKED the job, and a parked job never
   progresses on its own — the panel filled with "Parked (tools)" rows
   while the chat showed a cut-off response error.
   v15 mirrors the app's per-chat workspace into D1 (ws_files/ws_chunks)
   and, when a submit declares a synced workspace ("X-Nexus-WS: 1"),
   executes FILE-TOOL rounds ON THE WORKER against that mirror:
     list_files / read_file / grep_files / write_file / edit_file /
     rename_file / delete_file — the exact same implementations and result
     strings the app uses, so the model cannot tell the difference.
   The loop runs INSIDE the same job: each executed round appends
     data: {"nexus_server_round":N,...}   (the app renders the tool cards,
                                            splits the message timeline)
     extends the job's request messages with the assistant tool_calls +
     tool results (durable in D1 — any driver continues the run), and
     re-requests the model. Rounds containing ANY tool the worker cannot
     execute (gh_* writes, web_search, run_javascript…) still finish as
     DONE and the app executes them locally — the phone is only needed
     for what only the phone can do.
   Tool-arg cuts in mirror mode no longer park: the worker appends
     data: {"nexus_round_reset":1} (both parsers discard the fragment
     accumulator; the text stays) and re-asks the model with the app's
     exact CONTINUE protocol — same buffer, no duplication.
   The SYNC (the user's words: "if I turn off the worker and use it
   locally then turn it back on it should sync over properly"):
     POST /ws/:chatKey  { files, mtime, deleted } → last-write-wins per
     file by mtime; response = manifest. GET /ws/:chatKey?paths=… pulls
     contents. The app pushes before every submit, pulls after runs,
     pushes local edits when the relay is re-enabled. The mirror is
   NEVER pruned by TTL — it is the backup.
   Old apps never send X-Nexus-WS → 100% legacy behavior. Old workers
   ignore the header → the app falls back to the per-round protocol.

   v12 — NO MORE INSTANT "Connection failed" (fixes the post-deploy
   regression where the app's live-cast attach died instantly with a
   status-0 "Connection failed" error card, no retries):
   1. COLD-ISOLATE COST: v11 re-ran the whole ~50-statement migration
      (26 ALTERs + CREATEs + write-probes) on EVERY fresh worker
      isolate — measured 10–11 SECONDS per request. Requests scattered
      across cold isolates looked randomly dead-slow, breached the
      app's 8s health probe, and racing rebuilds tripped D1 busy
      errors. v12 stores a `schema_v` flag IN the database, written
      only after migration + write-probes succeed: a cold isolate now
      pays ONE cheap SELECT (~0.3s), not 50 statements.
   2. 404 LIES: while an isolate was in its 15s "schema bad →
      passthrough" window, GET /job/:id answered 404 "job not found"
      for jobs that EXISTED. The app reads 404 as "job gone → give up
      instantly" — that was the instant status-0 error. v12 job/status
      endpoints try the read anyway and answer 503 (retryable) on a
      D1 failure; 404 is reserved for "the row is genuinely gone".
   3. An insert failure now INVALIDATES the schema flag so the next
      request re-runs the full self-heal (the flag can never lie
      forever).
   (v11's self-healing schema fix for the v10 502 is preserved below.)

   THE MISSION: submit → the worker takes ownership of the generation the
   instant your prompt arrives (a durable D1 job exists BEFORE any upstream
   request is even opened), drives it to completion server-side (re-requesting
   the model until it gets in, finishing truncated answers), live-casts the
   stream to your app while you watch, and catches you up from the exact byte
   you left at whenever you reopen. Your phone's connection quality has ZERO
   effect on the generation itself.

   v14 — "honest meters + your finger on the pace":
   1. WAIT vs WORK, redefined to match what actually happens: WORK is any
      time the model is actively doing something on an ACCEPTED attempt
      (thinking, writing text, drafting tool arguments, searching); WAIT is
      only the time the request is caught in a line (queue, 429 backoffs,
      refused attempts, waiting for the next driver). Both meters are
      accumulated on the job row (wait_ms / work_ms + live start markers),
      so /job/:id/status and /jobs report the true split at any moment —
      across driver handoffs and isolate teardowns included. A finished
      request reports the time it SPENT WORKING, not how long ago it ended.
   2. The retry pace is yours to pick MID-WAIT: POST /job/:id/retry-mode
      (relaxed | standard | aggressive | relentless — the app's exact four
      paces) changes the backoff of a queued/streaming job live; a faster
      pick shortens the countdown that is already ticking. A submit may
      carry "X-Nexus-Retry: <mode>" to set the starting pace.
   3. Finished requests are removable: DELETE /jobs/:id deletes a terminal
      job's rows outright; POST /jobs/clear removes every finished one.

   v13 — "the tail never lies":
   1. The in-isolate live fast-path is RETIRED: GET /job/:id always serves
      the D1-polling tail. The fast path closed the app's stream when the
      pump exhausted its inline attempt budget — while the job was still
      queued — and the app correctly read that clean close as "the response
      was cut off before it finished (status 0)". The D1 tail closes ONLY
      on justified ends (terminal status + all bytes delivered, row gone,
      age cap, sustained D1 outage).
   2. The tail survives transient D1 errors (backoff + retry; only 15
      consecutive failures give up).
   3. NEW monitoring surface for the app's Settings panel:
      GET /jobs    → newest 40 jobs (status, model, preview, timing, chat)
      DELETE /jobs → stop every non-terminal job (the panel's "Stop all")
      Both want an Authorization header (casual-scan guard; job buffers
      remain readable only by unguessable job id).

   THE v10 ARCHITECTURE — submit + subscribe (replaces proxy+tee):
     POST /chat  + header "X-Nexus-Submit: 1"
       → creates the job row in D1 IMMEDIATELY (the prompt is durable within
         milliseconds of leaving your phone — even a free model that queues
         for 7 minutes before responding can no longer lose your prompt),
         kicks a driver, and returns "202 Accepted" with { jobId }.
       The old behavior (the POST response itself carrying the stream) is
         kept for apps that don't send the submit header — legacy clients
         work unchanged (streaming proxy + X-Nexus-Job + attach-on-continue).
     GET /job/:id?offset=N
       → live-cast: replay from byte N, then stream live progress. Attach,
         drop, re-attach, share — any number of readers at any offset. The
         generation never notices.
     GET /job/:id/status
       → { status, attempts, waitedMs, workMs, bytes, error } — honest queue
         narration ("Waiting for the model · 2m 10s · worker retry 14").
     GET /job/by-key/:chatKey
       → the newest job for a chat (the app tags submissions with
         "X-Nexus-Chat: <chatId>") — rediscovery even if the app lost its
         local vault (hard crash / cleared storage).
     POST /chat + "X-Nexus-Parent: <jobId>"
       → an explicit continuation: the parent job is retired. No fuzzy
         matching, no double generation — the app links its tool-result and
         auto-continue rounds straight to the job they supersede.
     POST /chat + "X-Nexus-Key: <idempotencyKey>"
       → network retries of the SAME submission return the SAME job. A
         connection hiccup can never double-spend a prompt.
     DELETE /job/:id
       → user pressed Stop: the job is cancelled server-side (no more spend).

   AGENTIC TOOL ROUNDS (GitHub writes, phone file-system writes) execute on
   the phone — by design, that is where the credentials and the files live.
   The worker finishes each tool round completely (finish_reason: tool_calls
   + [DONE] = job DONE), then WAITS. The app executes the tools and submits
   the continuation with the parent link. If the phone was away, the app
   replays the finished round on return, executes exactly once (its own
   dedup ledger), and continues. Tool-call arguments cut mid-stream are
   PARKED — never half-executed, never fabricated server-side.

   WHAT KEEPS IT ALIVE (unchanged from v4, proven in production):
     1. ALL job state in D1 (SQLite at the edge): jobs + append-only chunk
        byte log + secrets. Any event context rebuilds full parse state by
        replaying the chunk log byte-exactly.
     2. THREE DRIVERS, each in a fresh event context: the submit event
        itself, a piggyback work pass on any incoming request, and a Cron
        Trigger every minute — the phone-off engine.
     3. ATOMIC JOB CLAIMS (conditional UPDATE on lock_token + heartbeat
        staleness + next_retry backoff) — racing drivers can never
        double-generate.
     4. Discrete upstream attempts with the app's exact CONTINUE protocol:
        truncated attempts append the seamless rest; 429/408/5xx/network
        failures re-request on backoff "until it gets in".

   SETUP / UPGRADE (~4 minutes, dashboard only — no local tools, no secrets):
     1. Cloudflare dashboard → Workers & Pages → nexusaipro → Edit code
        → select all → paste this entire file → Deploy.
     2. Settings → Bindings → Add → D1 database (any name) bound with
        variable name EXACTLY: DB
     3. Settings → Triggers & Events → Cron Trigger → schedule EXACTLY:
        * * * * *
     4. Open https://<your-worker>/health → must say "v":12, "d1":true,
        "schemaOk":true, "cronOk":true. The health output tells you which
        step is missing.

   AUTH NOTE (honest, unchanged): the OpenRouter Bearer key is needed to
   re-request the model while you are away, so it is stored in YOUR OWN D1
   for the job's lifetime only, deleted on finish/fail/park/cancel/prune.
   Never logged, never returned by any endpoint. Without a D1 binding the
   worker degrades to a plain streaming passthrough relay.

   LIMITS (honest): unfinished jobs are worked for up to 30 min / 24
   attempts; finished jobs replay for 2h; 8 MB buffer per job; free-plan
   subrequest budgets degrade gracefully (fresh drivers resume the work).
   ===================================================================== */

const WORKER_VERSION = 16;

/* test tunables — production reads defaults; the local harness overrides
   via globalThis.__nexusTun to run E2E in seconds. */
function TUN(key, def) {
  const t = globalThis.__nexusTun;
  return t && Object.prototype.hasOwnProperty.call(t, key) ? t[key] : def;
}

const MAX_JOB_BYTES = TUN("maxJobBytes", 8 * 1024 * 1024);
const JOB_TTL_MS = TUN("jobTtlMs", 30 * 60 * 1000);
const DONE_TTL_MS = TUN("doneTtlMs", 2 * 60 * 60 * 1000);
const MAX_ATTEMPTS = TUN("maxAttempts", 24);
const RETRY_DELAYS = TUN("retryDelays", [1500, 3000, 6000, 10000, 15000, 20000]);
const UPSTREAM_STALL_MS = TUN("stallMs", 60 * 1000);
const STALE_LOCK_MS = TUN("staleLockMs", 26 * 1000);
const FLUSH_MS = TUN("flushMs", 300);
const FLUSH_BYTES = TUN("flushBytes", 64 * 1024);
const TICK_BUDGET_MS = TUN("tickBudgetMs", 210 * 1000);
const EVENT_BUDGET_MS = TUN("eventBudgetMs", 10 * 60 * 1000);
const TAIL_POLL_FAST = TUN("tailPollFast", 400);
const TAIL_POLL_SLOW = TUN("tailPollSlow", 2000);
const MAX_ACTIVE_JOBS = 64;
const MAX_TOTAL_JOBS = 256;

const FWD_HEADERS = ["authorization", "content-type", "http-referer", "x-title", "accept"];
const NEXUS_HEADERS = ["x-nexus-submit", "x-nexus-chat", "x-nexus-key", "x-nexus-parent", "x-nexus-ws"];

/* v15: how many tool rounds the worker will execute server-side in one
   job (the app's agent step ceiling is 25 by default — mirror that), and
   the mirror's own caps (files per workspace mirrors the app's MAX_FILES). */
const MAX_SERVER_ROUNDS = TUN("maxServerRounds", 25);
const WS_CHUNK_BYTES = 48 * 1024; // per-row content piece (statement-safe for D1)
const MAX_WS_FILES = TUN("maxWsFiles", 80);
const MAX_WS_FILE_BYTES = TUN("maxWsFileBytes", 5 * 1024 * 1024);
const MAX_WS_TOTAL_BYTES = TUN("maxWsTotalBytes", 20 * 1024 * 1024);

/* server-side continue protocol — the EXACT instruction the app sends,
   so worker retries and app continues are interchangeable */
const CONTINUE_INSTRUCTION = "Your previous answer was cut off by a connection drop. Continue exactly where you stopped. Do not repeat any text you already wrote, do not apologize, just continue the content seamlessly.";

/* v15: the app's step-limit instruction, verbatim — the server-side loop
   pushes it at the round cap exactly like the app's own agent loop does */
const STEP_LIMIT_INSTRUCTION = "You have reached the tool-use step limit for this task. Stop calling tools now and write your final answer: summarize what you built, the current state of the files, and anything left to do.";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, HTTP-Referer, X-Title, X-Nexus-Submit, X-Nexus-Chat, X-Nexus-Key, X-Nexus-Parent, X-Nexus-Retry, X-Nexus-WS",
  "Access-Control-Expose-Headers": "X-Nexus-Job, X-Nexus-Offset, X-Nexus-Status",
  "Access-Control-Max-Age": "86400",
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* v14: every job's buffer STARTS with one real SSE comment line. The local
   harness taught us the hard way that a streaming Response whose body has
   produced ZERO bytes can leave the client's fetch promise unresolved until
   the first real byte (curl sees the headers instantly; the browser's fetch
   does not resolve). A refusal-phase job (429 queue, model never took it yet)
   produces no bytes for seconds — the app's attach, its wait narration and
   the pace bubble all stalled behind that. The comment chunk gives the tail
   something byte-real to deliver the instant a reader attaches. It is part
   of the D1 buffer (byte-exact reconnects stay exact) and every SSE parser —
   the app's included — ignores comment lines. */
const OPEN_CHUNK = ": nexus job opened\n\n";

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS, ...headers } });
}

/* ---------- upstream base/path (v2 fix preserved) ---------- */
function upstreamBase(env) {
  return ((env && env.NEXUS_UPSTREAM_BASE) || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
}
function headersFrom(fwd) {
  const h = new Headers();
  for (const k of FWD_HEADERS) { const v = fwd && fwd[k]; if (v) h.set(k, v); }
  if (!h.has("content-type")) h.set("content-type", "application/json");
  return h;
}
function backoffFor(attempts) {
  const d = RETRY_DELAYS[Math.min(Math.max(attempts - 1, 0), RETRY_DELAYS.length - 1)];
  return Math.round(d * (0.8 + Math.random() * 0.4));
}

/* =====================================================================
   v14: RETRY PACES — the exact four profiles the app's pace row offers,
   mirrored server-side so "pick the retry mode while it waits" works even
   while the phone is closed. Stored per-job in meta.retry; the pump
   re-reads it before every backoff sleep, so a mid-wait change lands on
   the countdown that is already ticking.
   ===================================================================== */
const DEFAULT_RETRY_MODES = {
  relaxed:    { label: "Relaxed",    max: 12,  delays: [3000, 6000, 12000, 24000, 60000, 120000] },
  standard:   { label: "Standard",   max: 15,  delays: [2000, 4000, 8000, 15000, 30000, 60000] },
  aggressive: { label: "Aggressive", max: 30,  delays: [800, 1500, 2500, 4000, 6000, 10000, 15000, 30000] },
  relentless: { label: "Relentless", max: 100, delays: [400, 800, 1200, 2000, 3000, 5000, 8000, 12000] },
};
function retryModes() { return TUN("retryModes", DEFAULT_RETRY_MODES) || DEFAULT_RETRY_MODES; }
function profDelays(retry) {
  if (!retry || !Array.isArray(retry.delays) || !retry.delays.length) return RETRY_DELAYS;
  return retry.delays.map(d => Math.max(50, Math.min(600000, Number(d) || 1000)));
}
function profMax(retry) {
  if (!retry || !Number(retry.max)) return MAX_ATTEMPTS;
  return Math.min(200, Math.max(1, Math.floor(Number(retry.max))));
}
function paceDelay(delays, attempts) {
  const d = delays[Math.min(Math.max(attempts - 1, 0), delays.length - 1)] || delays[delays.length - 1];
  return Math.round(d * (0.8 + Math.random() * 0.4));
}
/* the job's live retry profile (meta.retry), or null for the default pace */
async function jobRetryProfile(env, id) {
  try {
    const r = await getSQL(env, `SELECT meta FROM jobs WHERE id = ?`, [id]);
    if (!r || !r.meta) return null;
    const meta = JSON.parse(r.meta);
    return meta && meta.retry ? meta.retry : null;
  } catch (_) { return null; }
}
/* pace-aware sleep between attempts: re-reads the profile while waiting;
   a faster pace picked mid-wait SHORTENS the live countdown (a gentler
   pick applies from the next attempt — the same rule as the app). */
async function pacedSleep(env, jobId, pace, attempts, signal) {
  const delays = profDelays(pace);
  let deadline = Date.now() + paceDelay(delays, attempts);
  while (Date.now() < deadline) {
    await sleep(Math.min(400, Math.max(30, deadline - Date.now())));
    if (signal && signal.aborted) return;
    const fresh = await jobRetryProfile(env, jobId);
    if (fresh) {
      const nd = Date.now() + paceDelay(profDelays(fresh), attempts);
      if (nd < deadline) deadline = nd; // only ever shortens
    }
  }
}
function sanitizeKey(v) {
  return v ? String(v).replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 128) : "";
}

/* =====================================================================
   D1 layer — the durable half of the engine.
   Uses ONLY prepare().bind().run()/all()/get() (the portable subset), so
   the exact same worker file runs under the local Bun test harness with a
   bun:sqlite shim, and under real Cloudflare with real D1.
   ===================================================================== */
/* ---- v11 schema layout, split so it can be applied in the ONLY sane
   order: tables first, then missing columns, then indexes. (v10 created
   idx_jobs_chat on chat_key BEFORE adding chat_key to legacy databases —
   the throw aborted the whole migration and every submit 502ed.) ---- */
const SCHEMA_TABLES = [
  `CREATE TABLE IF NOT EXISTS jobs (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL DEFAULT 'chat',
     status TEXT NOT NULL DEFAULT 'queued',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     heartbeat INTEGER NOT NULL DEFAULT 0,
     next_retry INTEGER NOT NULL DEFAULT 0,
     attempts INTEGER NOT NULL DEFAULT 0,
     finish INTEGER NOT NULL DEFAULT 0,
     bytes INTEGER NOT NULL DEFAULT 0,
     content_text TEXT NOT NULL DEFAULT '',
     req TEXT,
     meta TEXT,
     lock_token TEXT,
     chat_key TEXT,
     req_key TEXT,
     parent TEXT,
     first_byte INTEGER NOT NULL DEFAULT 0,
     wait_ms INTEGER NOT NULL DEFAULT 0,
     work_ms INTEGER NOT NULL DEFAULT 0,
     work_start INTEGER NOT NULL DEFAULT 0,
     wait_start INTEGER NOT NULL DEFAULT 0
     )`,
  `CREATE TABLE IF NOT EXISTS chunks (
     job TEXT NOT NULL,
     seq INTEGER NOT NULL,
     bytes INTEGER NOT NULL,
     data TEXT NOT NULL,
     PRIMARY KEY (job, seq)
     )`,
  `CREATE TABLE IF NOT EXISTS secrets (
     job TEXT PRIMARY KEY,
     auth TEXT NOT NULL
     )`,
  `CREATE TABLE IF NOT EXISTS wstate (
     k TEXT PRIMARY KEY,
     v TEXT NOT NULL
     )`,
  /* v15: the workspace file mirror — Cloudflare as the backup. Contents
     live in ws_chunks pieces (48KB rows) so every INSERT stays far below
     D1's statement limits no matter how big a file is; ws_files carries
     the manifest. ws_meta holds the per-workspace revision counter. */
  `CREATE TABLE IF NOT EXISTS ws_files (
     chat_key TEXT NOT NULL,
     path TEXT NOT NULL,
     bytes INTEGER NOT NULL DEFAULT 0,
     mtime INTEGER NOT NULL DEFAULT 0,
     parts INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (chat_key, path)
     )`,
  `CREATE TABLE IF NOT EXISTS ws_chunks (
     chat_key TEXT NOT NULL,
     path TEXT NOT NULL,
     idx INTEGER NOT NULL,
     data TEXT NOT NULL,
     PRIMARY KEY (chat_key, path, idx)
     )`,
  `CREATE TABLE IF NOT EXISTS ws_meta (
     chat_key TEXT PRIMARY KEY,
     rev INTEGER NOT NULL DEFAULT 0,
     synced_at INTEGER NOT NULL DEFAULT 0
     )`,
];
const SCHEMA_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status, next_retry)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_chat ON jobs (chat_key, created_at)`,
];

/* EVERY column the engine writes, for EVERY table — so a database from
   ANY older worker shape converges. Each statement fails silently when
   the column already exists. NOT NULL entries carry a DEFAULT (SQLite
   requires one for ADD COLUMN). */
const SCHEMA_ALTERS = [
  `ALTER TABLE jobs ADD COLUMN id TEXT`,
  `ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'`,
  `ALTER TABLE jobs ADD COLUMN status TEXT NOT NULL DEFAULT 'queued'`,
  `ALTER TABLE jobs ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE jobs ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE jobs ADD COLUMN heartbeat INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE jobs ADD COLUMN next_retry INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE jobs ADD COLUMN finish INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE jobs ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE jobs ADD COLUMN content_text TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE jobs ADD COLUMN req TEXT`,
  `ALTER TABLE jobs ADD COLUMN meta TEXT`,
  `ALTER TABLE jobs ADD COLUMN lock_token TEXT`,
  `ALTER TABLE jobs ADD COLUMN chat_key TEXT`,
  `ALTER TABLE jobs ADD COLUMN req_key TEXT`,
  `ALTER TABLE jobs ADD COLUMN parent TEXT`,
  `ALTER TABLE jobs ADD COLUMN first_byte INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE jobs ADD COLUMN wait_ms INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE jobs ADD COLUMN work_ms INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE jobs ADD COLUMN work_start INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE jobs ADD COLUMN wait_start INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE chunks ADD COLUMN job TEXT`,
  `ALTER TABLE chunks ADD COLUMN seq INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE chunks ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE chunks ADD COLUMN data TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE secrets ADD COLUMN job TEXT`,
  `ALTER TABLE secrets ADD COLUMN auth TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE wstate ADD COLUMN k TEXT`,
  `ALTER TABLE wstate ADD COLUMN v TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE ws_files ADD COLUMN chat_key TEXT`,
  `ALTER TABLE ws_files ADD COLUMN path TEXT`,
  `ALTER TABLE ws_files ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE ws_files ADD COLUMN mtime INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE ws_files ADD COLUMN parts INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE ws_chunks ADD COLUMN chat_key TEXT`,
  `ALTER TABLE ws_chunks ADD COLUMN path TEXT`,
  `ALTER TABLE ws_chunks ADD COLUMN idx INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE ws_chunks ADD COLUMN data TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE ws_meta ADD COLUMN chat_key TEXT`,
  `ALTER TABLE ws_meta ADD COLUMN rev INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE ws_meta ADD COLUMN synced_at INTEGER NOT NULL DEFAULT 0`,
];

function hasDB(env) { return !!(env && env.DB); }
/* a database that failed migration even after a rebuild — the relay
   degrades to passthrough (chat keeps working) and retries the schema
   check every SCHEMA_RETRY_MS in case D1 recovers */
function schemaBad(env) {
  const t = env && env.DB && env.DB.__nexusSchemaBad;
  return !!(t && Date.now() - t < SCHEMA_RETRY_MS);
}
function jobEngineOk(env) { return hasDB(env) && !schemaBad(env); }
const SCHEMA_RETRY_MS = 15000;

async function trySQL(env, sql) {
  try { await runSQL(env, sql, []); return true; } catch (_) { return false; }
}

/* WRITE-PROBE: run the exact INSERT shapes the engine uses, then clean
   up. Reading the schema is not enough — a legacy table can ACCEPT our
   SELECTs yet reject our INSERTs (e.g. an unknown NOT NULL column with
   no default from an older worker). Probe rows use status 'probe', a
   status no scanner ever looks at, so a concurrent reader can never
   pick one up; if the cleanup DELETE itself fails, TTL pruning removes
   the row (created_at = 0). Random ids keep concurrent boots from
   colliding. One retry absorbs a transient D1 blip so we never rebuild
   on a hiccup. */
async function probeTables(env) {
  const pid = "probe-" + crypto.randomUUID().slice(0, 12);
  const tests = [
    { ins: `INSERT INTO jobs (id, kind, status, created_at, updated_at, heartbeat, next_retry, attempts, finish, bytes, content_text, req, meta, lock_token, chat_key, req_key, parent, first_byte, wait_ms, work_ms, work_start, wait_start) VALUES (?, 'chat', 'probe', 0, 0, 0, 0, 0, 0, 0, '', '{}', '{}', NULL, '', '', '', 0, 0, 0, 0, 0)`, del: `DELETE FROM jobs WHERE id = ?`, params: [pid] },
    { ins: `INSERT INTO chunks (job, seq, bytes, data) VALUES (?, 0, 0, '')`, del: `DELETE FROM chunks WHERE job = ?`, params: [pid] },
    { ins: `INSERT INTO secrets (job, auth) VALUES (?, 'probe')`, del: `DELETE FROM secrets WHERE job = ?`, params: [pid] },
    { ins: `INSERT INTO wstate (k, v) VALUES (?, '0')`, del: `DELETE FROM wstate WHERE k = ?`, params: [pid] },
    { ins: `INSERT INTO ws_files (chat_key, path, bytes, mtime, parts) VALUES (?, 'probe', 0, 0, 0)`, del: `DELETE FROM ws_files WHERE chat_key = ?`, params: [pid] },
    { ins: `INSERT INTO ws_chunks (chat_key, path, idx, data) VALUES (?, 'probe', 0, '')`, del: `DELETE FROM ws_chunks WHERE chat_key = ?`, params: [pid] },
    { ins: `INSERT INTO ws_meta (chat_key, rev, synced_at) VALUES (?, 0, 0)`, del: `DELETE FROM ws_meta WHERE chat_key = ?`, params: [pid] },
  ];
  let allOk = true;
  for (const t of tests) {
    let ok = false;
    for (let i = 0; i < 2 && !ok; i++) {
      try { await runSQL(env, t.ins, t.params); ok = true; }
      catch (_) { if (i === 0) await sleep(300); }
    }
    if (!ok) allOk = false;
    try { await runSQL(env, t.del, t.params); } catch (_) {}
  }
  return allOk;
}

/* last resort for a legacy shape the ALTERs cannot fix — jobs are
   transient by design (TTL minutes-to-hours), so rebuilding the tables
   is ALWAYS safe and always converges to the exact v11 layout */
async function rebuildTables(env) {
  for (const t of ["jobs", "chunks", "secrets", "wstate"]) await trySQL(env, `DROP TABLE IF EXISTS ` + t);
  for (const s of SCHEMA_TABLES) await trySQL(env, s);
  for (const ix of SCHEMA_INDEXES) await trySQL(env, ix);
}

/* schema creation is tracked PER DATABASE (not per module instance): a
   worker process can serve several D1 bindings (the local harness runs the
   real + legacy-sim instances from one module) — each must get its tables.
   v12: the expensive ladder (tables → 26 ALTERs → indexes → write-probes)
   runs ONCE PER DATABASE LIFETIME, not once per cold isolate — a
   `schema_v` row in wstate, written only after the ladder + probes
   succeed, lets every other isolate converge with ONE cheap SELECT
   (measured: 10–11s → ~0.3s). The flag is invalidated (deleted) the
   moment any engine INSERT fails, so it can never lie forever. */
const SCHEMA_V_KEY = "schema_v";
async function schemaFlagOk(env) {
  try {
    const r = await getSQL(env, `SELECT v FROM wstate WHERE k = ?`, [SCHEMA_V_KEY]);
    return !!(r && Number(r.v) === WORKER_VERSION);
  } catch (_) { return false; }
}
/* called when a real engine INSERT failed despite the flag: forget the
   module flag AND the durable flag so the next request re-runs the full
   self-heal ladder (other isolates included) */
async function invalidateSchema(env) {
  try { if (env && env.DB) { env.DB.__nexusSchemaDone = false; env.DB.__nexusSchemaBad = 0; } } catch (_) {}
  try { if (hasDB(env)) await runSQL(env, `DELETE FROM wstate WHERE k = ?`, [SCHEMA_V_KEY]); } catch (_) {}
}
async function ensureSchema(env) {
  if (!hasDB(env)) return;
  const db = env.DB;
  if (db.__nexusSchemaDone) return;
  if (db.__nexusSchemaBad && Date.now() - db.__nexusSchemaBad < SCHEMA_RETRY_MS) return;
  if (await schemaFlagOk(env)) { db.__nexusSchemaBad = 0; db.__nexusSchemaDone = true; return; }
  for (const s of SCHEMA_TABLES) await trySQL(env, s);
  for (const a of SCHEMA_ALTERS) await trySQL(env, a);
  for (const ix of SCHEMA_INDEXES) await trySQL(env, ix);
  if (!(await probeTables(env))) {
    await rebuildTables(env);
    if (!(await probeTables(env))) {
      /* beyond repair → passthrough (chat still works); re-probe later */
      db.__nexusSchemaBad = Date.now();
      return;
    }
  }
  db.__nexusSchemaBad = 0;
  db.__nexusSchemaDone = true;
  try { await wstateSet(env, SCHEMA_V_KEY, WORKER_VERSION); } catch (_) {}
}

async function runSQL(env, sql, params) {
  const p = env.DB.prepare(sql);
  const b = params && params.length ? p.bind(...params) : p;
  return b.run();
}
async function allSQL(env, sql, params) {
  const p = env.DB.prepare(sql);
  const b = params && params.length ? p.bind(...params) : p;
  const r = await b.all();
  return (r && r.results) || [];
}
async function getSQL(env, sql, params) {
  const p = env.DB.prepare(sql);
  const b = params && params.length ? p.bind(...params) : p;
  if (typeof b.get === "function") return await b.get();
  const r = await b.all();
  return (r && r.results && r.results.length) ? r.results[0] : null;
}
async function wstateSet(env, k, v) {
  await runSQL(env, `INSERT INTO wstate (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, [k, String(v)]);
}
async function wstateGet(env, k) {
  const r = await getSQL(env, `SELECT v FROM wstate WHERE k = ?`, [k]);
  return r ? Number(r.v) || 0 : 0;
}

/* =====================================================================
   v15: THE WORKSPACE FILE MIRROR (Cloudflare as the backup).
   One workspace per chat (chat_key = the app's X-Nexus-Chat). Contents
   are stored in 48KB ws_chunks pieces; ws_files is the manifest with a
   wall-clock mtime per file (last-write-wins vs the app's local edits).
   Never pruned by TTL — this is the user's backup, not job state.
   ===================================================================== */
async function wsBumpRev(env, chatKey) {
  try {
    await runSQL(env,
      `INSERT INTO ws_meta (chat_key, rev, synced_at) VALUES (?, 1, ?)
       ON CONFLICT(chat_key) DO UPDATE SET rev = rev + 1, synced_at = excluded.synced_at`,
      [chatKey, Date.now()]);
  } catch (_) {}
}
async function wsRev(env, chatKey) {
  try {
    const r = await getSQL(env, `SELECT rev FROM ws_meta WHERE chat_key = ?`, [chatKey]);
    return r ? Number(r.rev) || 0 : 0;
  } catch (_) { return 0; }
}
async function wsManifest(env, chatKey) {
  const rows = await allSQL(env, `SELECT path, bytes, mtime FROM ws_files WHERE chat_key = ? ORDER BY path ASC`, [chatKey]);
  const meta = {};
  for (const r of rows) meta[r.path] = { bytes: Number(r.bytes) || 0, mtime: Number(r.mtime) || 0 };
  return meta;
}
async function wsGetFile(env, chatKey, path) {
  const row = await getSQL(env, `SELECT parts, mtime FROM ws_files WHERE chat_key = ? AND path = ?`, [chatKey, path]);
  if (!row) return null;
  const parts = await allSQL(env, `SELECT idx, data FROM ws_chunks WHERE chat_key = ? AND path = ? ORDER BY idx ASC`, [chatKey, path]);
  const map = new Map();
  for (const p of parts) map.set(Number(p.idx), p.data);
  let content = "";
  for (let i = 0; i < Number(row.parts); i++) content += map.has(i) ? map.get(i) : "";
  return { content, mtime: Number(row.mtime) || 0, bytes: Number(row.bytes) || 0 };
}
/* chunked write — every INSERT stays statement-sized no matter the file */
async function wsPutFile(env, chatKey, path, content, mtime) {
  const pieces = [];
  for (let i = 0; i < content.length; i += WS_CHUNK_BYTES) pieces.push(content.slice(i, i + WS_CHUNK_BYTES));
  await runSQL(env, `DELETE FROM ws_chunks WHERE chat_key = ? AND path = ?`, [chatKey, path]);
  for (let i = 0; i < pieces.length; i++) {
    await runSQL(env, `INSERT INTO ws_chunks (chat_key, path, idx, data) VALUES (?, ?, ?, ?)`, [chatKey, path, i, pieces[i]]);
  }
  await runSQL(env,
    `INSERT INTO ws_files (chat_key, path, bytes, mtime, parts) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chat_key, path) DO UPDATE SET bytes = excluded.bytes, mtime = excluded.mtime, parts = excluded.parts`,
    [chatKey, path, content.length, mtime, pieces.length]);
}
async function wsDeleteFile(env, chatKey, path) {
  await runSQL(env, `DELETE FROM ws_chunks WHERE chat_key = ? AND path = ?`, [chatKey, path]);
  await runSQL(env, `DELETE FROM ws_files WHERE chat_key = ? AND path = ?`, [chatKey, path]);
}
async function wsClear(env, chatKey) {
  await runSQL(env, `DELETE FROM ws_chunks WHERE chat_key = ?`, [chatKey]);
  await runSQL(env, `DELETE FROM ws_files WHERE chat_key = ?`, [chatKey]);
  await runSQL(env, `DELETE FROM ws_meta WHERE chat_key = ?`, [chatKey]);
}

/* =====================================================================
   v15: FILE TOOLS ON THE WORKER — the app's implementations, ported
   line-for-line (same result strings, same paging, same error wording)
   so the model behaves identically whether the round runs on the phone
   or in the cloud. Only the file tools exist here; anything else in a
   round hands the whole round back to the app.
   ===================================================================== */
const FS_TOOLS = ["list_files", "read_file", "grep_files", "write_file", "edit_file", "rename_file", "delete_file"];
const FS_TOOL_ALIASES = {
  apply_patch: "edit_file", str_replace: "edit_file", str_replace_editor: "edit_file", edit: "edit_file", modify_file: "edit_file", patch_file: "edit_file", replace: "edit_file",
  create_file: "write_file", write_to_file: "write_file", write: "write_file", save_file: "write_file",
  open_file: "read_file", cat: "read_file", read: "read_file", view_file: "read_file", open: "read_file",
  search_files: "grep_files", search_code: "grep_files", find_in_files: "grep_files", grep: "grep_files", code_search: "grep_files", search: "grep_files",
  ls: "list_files", list_directory: "list_files", list_dir: "list_files", dir: "list_files",
  remove_file: "delete_file", rm: "delete_file", delete: "delete_file",
  move_file: "rename_file", move: "rename_file", rename: "rename_file",
};
const FS_ARG_ALIASES = {
  path: ["file", "filename", "file_path", "filePath", "filepath", "target"],
  old_text: ["old_str", "old_string", "oldText", "find", "search", "match", "original", "source_text"],
  new_text: ["new_str", "new_string", "newText", "replace_with", "replacement", "updated_text"],
  new_path: ["to", "new_name", "name", "destination", "dest", "dest_path", "newpath", "new_file"],
  content: ["text", "body", "contents", "file_content", "data"],
  pattern: ["regex", "search_pattern", "needle"],
};
function fsNormalizeArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const out = { ...args };
  for (const [canonical, aliases] of Object.entries(FS_ARG_ALIASES)) {
    for (const a of aliases) {
      if (a in out && !(canonical in out)) { out[canonical] = out[a]; delete out[a]; }
    }
  }
  return out;
}
function fsFormatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}
function fsEscapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function fsValidPath(path) {
  if (typeof path !== "string" || !path.trim()) throw new Error("A file path is required.");
  const p = path.trim().replace(/^\/+/, "");
  if (p.length > 140 || p.split("/").some(seg => seg === ".." || seg.length > 80)) throw new Error("Invalid path: " + path);
  return p;
}
function fsBuildDiffLines(oldText, newText, max = 60) {
  const lines = [];
  oldText.split("\n").forEach(l => lines.push("- " + l));
  newText.split("\n").forEach(l => lines.push("+ " + l));
  if (lines.length > max) return lines.slice(0, max).concat(["… (" + (lines.length - max) + " more changed lines)"]);
  return lines;
}
/* does a request's tools array declare any file tool? (submit-time check) */
function requestHasFileTools(parsed) {
  try {
    const tools = parsed && parsed.tools;
    if (!Array.isArray(tools)) return false;
    for (const t of tools) {
      const n = t && t.function && t.function.name;
      if (FS_TOOLS.includes(n) || FS_TOOL_ALIASES[n]) return true;
    }
  } catch (_) {}
  return false;
}
/* can EVERY call in this round run on the worker? (round-time check —
   one gh_* call hands the whole round back to the phone) */
function roundAllServerExecutable(calls) {
  if (!calls.length) return false;
  for (const c of calls) {
    const resolved = FS_TOOL_ALIASES[c.name] || c.name;
    if (!FS_TOOLS.includes(resolved)) return false;
  }
  return true;
}
/* execute one file tool against the mirror. Returns the app-shaped result
   {text, label, sub, icon, file, failed}. Throws become failed results —
   the model gets the same honest guidance the app gives it. */
async function runServerTool(env, chatKey, rawName, args) {
  const name = FS_TOOL_ALIASES[rawName] || rawName;
  try {
    switch (name) {
      case "list_files": {
        const rows = await allSQL(env, `SELECT path, bytes FROM ws_files WHERE chat_key = ? ORDER BY path ASC`, [chatKey]);
        if (!rows.length) return { text: "The workspace is empty — no files yet.", label: "Checked files", sub: "0 files", icon: "folder" };
        const lines = rows.map(r => r.path + "  (" + fsFormatBytes(Number(r.bytes) || 0) + ")");
        return { text: lines.join("\n"), label: "Checked files", sub: rows.length + " files", icon: "folder" };
      }
      case "read_file": {
        const p = fsValidPath(args.path);
        const row = await wsGetFile(env, chatKey, p);
        if (!row) throw new Error("File not found: " + p + " — use list_files to see what exists.");
        const content = row.content;
        const allLines = content.split("\n");
        const total = allLines.length;
        if (content.length <= 16000 && args.offset == null && args.limit == null) {
          return { text: content, label: "Read " + p, sub: fsFormatBytes(content.length) + " · " + total + " lines", icon: "file", file: p };
        }
        const offset = Math.max(1, Math.floor(Number(args.offset) || 1));
        const limit = Math.min(600, Math.max(1, Math.floor(Number(args.limit) || 400)));
        if (offset > total) throw new Error("offset " + offset + " is past the end of the file (" + total + " lines).");
        const end = Math.min(total, offset - 1 + limit);
        const body = allLines.slice(offset - 1, end).map((l, i) => String(offset + i).padStart(5) + "| " + l).join("\n");
        const footer = end < total
          ? "\n…[lines " + offset + "–" + end + " of " + total + " — call read_file with offset " + (end + 1) + " for the next chunk]"
          : "\n[End of file — " + total + " lines total]";
        return { text: body + footer, label: "Read " + p, sub: "lines " + offset + "–" + end + " of " + total, icon: "file", file: p };
      }
      case "grep_files": {
        const pat = String(args.pattern || "").trim();
        if (!pat) throw new Error("A search pattern is required.");
        let re;
        const rx = pat.match(/^\/(.+)\/([a-z]*)$/);
        try { re = rx ? new RegExp(rx[1], rx[2] || "i") : new RegExp(fsEscapeRegex(pat), "i"); }
        catch (err) { throw new Error("Invalid pattern: " + err.message); }
        const only = args.path ? [fsValidPath(args.path)] : (await allSQL(env, `SELECT path FROM ws_files WHERE chat_key = ? ORDER BY path ASC`, [chatKey])).map(r => r.path);
        const max = Math.min(100, Math.max(1, Math.floor(Number(args.max_results) || 40)));
        const hits = [];
        let scanned = 0;
        for (const p of only) {
          const row = await wsGetFile(env, chatKey, p);
          if (!row) throw new Error("File not found: " + p);
          scanned++;
          const lines = row.content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              hits.push(p + ":" + (i + 1) + ": " + lines[i].trim().slice(0, 200));
              if (hits.length >= max) break;
            }
          }
          if (hits.length >= max) break;
        }
        const head = "Matches for \"" + pat + "\"" + (args.path ? " in " + args.path : " across " + scanned + " file" + (scanned === 1 ? "" : "s")) + ":\n";
        const text = hits.length
          ? head + hits.join("\n") + (hits.length >= max ? "\n…[first " + max + " matches — refine the pattern or raise max_results]" : "")
          : "No matches for \"" + pat + "\"" + (args.path ? " in " + args.path : " across " + scanned + " file" + (scanned === 1 ? "" : "s")) + ".";
        return { text, label: "Searched " + (args.path || "files"), sub: hits.length + " match" + (hits.length === 1 ? "" : "es"), icon: "search", file: args.path ? fsValidPath(args.path) : undefined };
      }
      case "write_file": {
        const p = fsValidPath(args.path);
        const content = String(args.content ?? "");
        if (content.length > MAX_WS_FILE_BYTES) throw new Error("File too large (max " + fsFormatBytes(MAX_WS_FILE_BYTES) + ").");
        const existing = await getSQL(env, `SELECT path FROM ws_files WHERE chat_key = ? AND path = ?`, [chatKey, p]);
        if (!existing) {
          const cnt = await getSQL(env, `SELECT COUNT(*) AS n FROM ws_files WHERE chat_key = ?`, [chatKey]);
          if (cnt && Number(cnt.n) >= MAX_WS_FILES) throw new Error("Too many files (max " + MAX_WS_FILES + ").");
          const tot = await getSQL(env, `SELECT COALESCE(SUM(bytes), 0) AS b FROM ws_files WHERE chat_key = ?`, [chatKey]);
          if (tot && Number(tot.b) + content.length > MAX_WS_TOTAL_BYTES) throw new Error("The workspace mirror is full (max " + fsFormatBytes(MAX_WS_TOTAL_BYTES) + ").");
        }
        await wsPutFile(env, chatKey, p, content, Date.now());
        await wsBumpRev(env, chatKey);
        return { text: "Wrote " + p + " (" + fsFormatBytes(content.length) + ", " + content.split("\n").length + " lines).", label: "Wrote " + p, sub: fsFormatBytes(content.length) + " · " + content.split("\n").length + " lines", icon: "fileCode", file: p };
      }
      case "edit_file": {
        const p = fsValidPath(args.path);
        const row = await wsGetFile(env, chatKey, p);
        if (!row) throw new Error("File not found: " + p + " — use list_files to see what exists, or write_file to create it fresh.");
        const oldText = String(args.old_text ?? "");
        const newText = String(args.new_text ?? "");
        if (!oldText) throw new Error("old_text is required — copy the exact text (with its indentation) from read_file output.");
        if (oldText === newText) throw new Error("old_text and new_text are identical — nothing to change.");
        const content = row.content;
        const count = content.split(oldText).length - 1;
        if (count === 0) throw new Error("old_text was not found in " + p + " — it must match EXACTLY (whitespace, indentation, quotes). Read the file with read_file and copy the text precisely, or locate it with grep_files first.");
        if (count > 1 && args.replace_all !== true) throw new Error("old_text appears " + count + " times in " + p + " — include more surrounding lines so it is unique, or pass replace_all: true to replace every occurrence.");
        const updated = args.replace_all === true ? content.split(oldText).join(newText) : content.replace(oldText, newText);
        if (updated.length > MAX_WS_FILE_BYTES) throw new Error("The edit would make the file too large (max " + fsFormatBytes(MAX_WS_FILE_BYTES) + ").");
        await wsPutFile(env, chatKey, p, updated, Date.now());
        await wsBumpRev(env, chatKey);
        const changed = args.replace_all === true ? count : 1;
        const diffLines = fsBuildDiffLines(oldText, newText);
        return {
          text: "Edited " + p + " — " + changed + " replacement" + (changed === 1 ? "" : "s") + " (" + oldText.split("\n").length + " line" + (oldText.split("\n").length === 1 ? "" : "s") + " out → " + newText.split("\n").length + " in, file now " + updated.split("\n").length + " lines).\n\n" + diffLines.join("\n"),
          label: "Edited " + p, sub: changed + " change" + (changed === 1 ? "" : "s") + " · " + updated.split("\n").length + " lines", icon: "pencil", file: p, diffLines,
        };
      }
      case "rename_file": {
        const p = fsValidPath(args.path), np = fsValidPath(args.new_path);
        const row = await wsGetFile(env, chatKey, p);
        if (!row) throw new Error("File not found: " + p + " — use list_files to see what exists.");
        if (np === p) throw new Error("The new path is the same as the old one.");
        const exists = await getSQL(env, `SELECT path FROM ws_files WHERE chat_key = ? AND path = ?`, [chatKey, np]);
        if (exists) throw new Error("A file called " + np + " already exists — pick a different name or delete it first.");
        await wsPutFile(env, chatKey, np, row.content, Date.now());
        await wsDeleteFile(env, chatKey, p);
        await wsBumpRev(env, chatKey);
        return { text: "Renamed " + p + " → " + np + " (" + fsFormatBytes(row.content.length) + " carried over).", label: "Renamed " + p + " → " + np, sub: fsFormatBytes(row.content.length), icon: "pen", file: np };
      }
      case "delete_file": {
        const p = fsValidPath(args.path);
        const row = await getSQL(env, `SELECT path FROM ws_files WHERE chat_key = ? AND path = ?`, [chatKey, p]);
        if (!row) throw new Error("File not found: " + p);
        await wsDeleteFile(env, chatKey, p);
        await wsBumpRev(env, chatKey);
        return { text: "Deleted " + p + ".", label: "Deleted " + p, sub: "", icon: "trash" };
      }
    }
    throw new Error("Unknown tool: \"" + rawName + "\"");
  } catch (err) {
    return { text: "Tool error: " + (err && err.message || String(err)), label: (FS_TOOL_ALIASES[rawName] || rawName) + " (failed)", sub: String(err && err.message || "").slice(0, 80), icon: "alert", failed: true };
  }
}

function rowToJob(row) {
  if (!row) return null;
  let meta = {};
  try { meta = row.meta ? JSON.parse(row.meta) : {}; } catch (_) {}
  let req = null;
  try { req = row.req ? JSON.parse(row.req) : null; } catch (_) {}
  return {
    id: row.id, kind: row.kind, status: row.status,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    heartbeat: Number(row.heartbeat), nextRetry: Number(row.next_retry),
    attempts: Number(row.attempts), finish: !!Number(row.finish),
    bytes: Number(row.bytes), contentText: row.content_text || "",
    req, meta,
    chatKey: row.chat_key || "", reqKey: row.req_key || "",
    parent: row.parent || "", firstByte: Number(row.first_byte) || 0,
    waitMs: Number(row.wait_ms) || 0, workMs: Number(row.work_ms) || 0,
    workStart: Number(row.work_start) || 0, waitStart: Number(row.wait_start) || 0,
  };
}

/* v14: the honest wait/work meters, computed from the row so ANY isolate
   can answer without the pump's help:
     WAIT = in-line time (queue / backoff / refused / no driver attached)
     WORK = the model actively streaming on an accepted attempt
   Live periods are derived from the start markers (wait_start / work_start);
   a live WORK period is capped at the last heartbeat when the pump looks
   dead, and legacy v13 rows (no markers, no accumulated meters) fall back
   to the old first-byte approximation. */
function liveWaitWork(job, now) {
  const terminal = ["done", "failed", "stopped", "parked"].includes(job.status);
  const hasMeters = !!(job.waitMs || job.workMs || job.waitStart || job.workStart);
  if (!hasMeters) {
    const fb = job.firstByte || 0;
    const done = job.status === "done";
    const running = !done && !terminal;
    const waitedMs = fb ? Math.max(0, fb - job.createdAt) : (done ? 0 : Math.max(0, now - job.createdAt));
    const workMs = fb ? Math.max(0, (running ? now : job.updatedAt) - fb) : (done ? Math.max(0, job.updatedAt - job.createdAt) : 0);
    return { waitedMs, workMs, working: running && fb > 0 };
  }
  let waitedMs = job.waitMs, workMs = job.workMs;
  let working = false;
  if (!terminal) {
    if (job.waitStart) waitedMs += Math.max(0, now - job.waitStart);
    if (job.workStart) {
      const hb = Number(job.heartbeat) || 0;
      const fresh = now - hb < STALE_LOCK_MS + 5000;
      const cut = fresh ? now : Math.max(job.workStart, hb);
      workMs += Math.max(0, cut - job.workStart);
      working = fresh;
    }
  }
  return { waitedMs: Math.max(0, waitedMs), workMs: Math.max(0, workMs), working };
}
async function getJobRow(env, id) {
  const r = await getSQL(env, `SELECT * FROM jobs WHERE id = ?`, [id]);
  return r ? rowToJob(r) : null;
}

/* lock-guarded write — fails (returns 0) once another driver took over */
async function lockWrite(env, id, token, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return 1;
  const sets = keys.map(k => k + " = ?").join(", ");
  const params = keys.map(k => fields[k]);
  params.push(id, token);
  const sql = `UPDATE jobs SET ` + sets + ` WHERE id = ? AND lock_token = ?`;
  try {
    const r = await runSQL(env, sql, params);
    return r && r.meta && Number(r.meta.changes) || 0;
  } catch (_) { return 0; }
}

/* the atomic claim — the heart of "no double generation" */
async function claimJob(env, id) {
  const token = crypto.randomUUID();
  const now = Date.now();
  const r = await runSQL(env,
    `UPDATE jobs SET status = 'streaming', lock_token = ?, heartbeat = ?, updated_at = ? WHERE id = ? AND status IN ('queued','streaming') AND heartbeat < ? AND next_retry <= ?`,
    [token, now, now, id, now - STALE_LOCK_MS, now]);
  const changes = r && r.meta && Number(r.meta.changes) || 0;
  return changes === 1 ? token : null;
}

async function deleteJobRows(env, id) {
  await runSQL(env, `DELETE FROM chunks WHERE job = ?`, [id]);
  await runSQL(env, `DELETE FROM secrets WHERE job = ?`, [id]);
  await runSQL(env, `DELETE FROM jobs WHERE id = ?`, [id]);
}

/* v14: retire job rows OUTSIDE the pump (user stop / stop-all / parent
   retirement) — settles the wait/work meters in SQL so the row's final
   numbers stay honest, then marks it stopped and drops its secret. */
async function stopJobRows(env, ids) {
  const now = Date.now();
  for (const id of ids) {
    try {
      await runSQL(env,
        `UPDATE jobs SET
           wait_ms = wait_ms + CASE WHEN wait_start > 0 THEN ? - wait_start ELSE 0 END,
           work_ms = work_ms + CASE WHEN work_start > 0 THEN ? - work_start ELSE 0 END,
           wait_start = 0, work_start = 0,
           status = 'stopped', heartbeat = 0, lock_token = NULL, updated_at = ?
         WHERE id = ?`, [now, now, now, id]);
    } catch (_) {}
    try { await runSQL(env, `DELETE FROM secrets WHERE job = ?`, [id]); } catch (_) {}
  }
}

/* =====================================================================
   SSE parser — stateless construction, so ANY event context can rebuild
   the full job state by replaying the D1 chunk log (byte-exact).
   ===================================================================== */
function makeParser() {
  return {
    dec: new TextDecoder(),
    pending: "",
    chunkStartByte: 0,
    contentText: "",
    eventIndex: [],        // [{c: contentLen, b: byteOffAfterLine}]
    sawToolCalls: false,
    sawReasoning: false,
    sawData: false,        // any real `data:` line seen (comments/keepalives never count)
    finishSeen: false,
    errorSeen: false,
    errorMessage: "",
    errorCode: 0,
    /* v15 server-round state: tool-call fragments accumulate here exactly
       like the app's readStream accumulator; the nexus_* marker events
       delimit rounds (see line()). roundBase = contentText length at the
       start of the CURRENT round; roundSawData = real events in it. */
    toolAcc: {},
    serverRounds: 0,
    roundBase: 0,
    roundSawData: false,
    sawDeltaContent: false, // v16: round-scoped guard — message.content skips when delta text already streamed
    feed(u8) {
      const text = this.dec.decode(u8, { stream: true });
      const nl = [];
      for (let i = 0; i < u8.length; i++) if (u8[i] === 0x0A) nl.push(i);
      const lines = text.split("\n"); // lines.length === nl.length + 1
      let line = this.pending + lines[0];
      for (let i = 0; i < nl.length; i++) {
        const lineEndByte = this.chunkStartByte + nl[i] + 1;
        this.line(line, lineEndByte);
        line = lines[i + 1];
      }
      this.pending = line;
      this.chunkStartByte += u8.length;
    },
    line(line, lineEndByte) {
      if (!line) return;
      const s = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (!s.startsWith("data:")) return;
      const raw = s.slice(5).trim();
      if (!raw) return;
      this.sawData = true; // a real event line — not a comment/keepalive
      if (raw === "[DONE]") { this.finishSeen = true; return; }
      let obj = null;
      try { obj = JSON.parse(raw); } catch (_) { return; }
      /* ---- v15 round markers (only ever emitted by this worker) ----
         nexus_server_round: the round completed and the WORKER executed
           its tools. Everything round-scoped resets for the next round;
           replaying the buffer rebuilds the same state on any driver.
         nexus_round_reset: a tool-arg cut was discarded; the fragments
           (and only the fragments) go away — text stays, the re-emission
           re-accumulates. */
      if (obj && (obj.nexus_server_round != null || obj.nexus_round_reset != null)) {
        if (obj.nexus_server_round != null) {
          this.serverRounds = Math.max(this.serverRounds, Number(obj.nexus_server_round) || 0);
          this.roundBase = this.contentText.length;
          this.finishSeen = false;
          this.sawToolCalls = false;
          this.toolAcc = {};
          this.roundSawData = false;
          this.sawDeltaContent = false; // a new round may legitimately deliver text as message.content
        } else {
          this.toolAcc = {};
          this.sawToolCalls = false;
        }
        this.eventIndex.push({ c: this.contentText.length, b: lineEndByte });
        return;
      }
      if (obj && obj.error) { this.errorSeen = true; this.errorMessage = String(obj.error.message || "upstream error"); this.errorCode = Number(obj.error.code) || 0; }
      const ch = obj && obj.choices && obj.choices[0];
      if (ch && ch.finish_reason) this.finishSeen = true;
      const d = ch && ch.delta;
      if (d) {
        if (typeof d.content === "string" && d.content.length) { this.contentText += d.content; this.sawDeltaContent = true; }
        if (typeof d.reasoning === "string" && d.reasoning.length) this.sawReasoning = true;
        if (typeof d.reasoning_content === "string" && d.reasoning_content.length) this.sawReasoning = true;
        if (Array.isArray(d.tool_calls) && d.tool_calls.length) {
          this.sawToolCalls = true;
          this.roundSawData = true;
          for (const tc of d.tool_calls) {
            const idx = tc.index ?? 0;
            if (!this.toolAcc[idx]) this.toolAcc[idx] = { id: "", name: "", args: "" };
            if (tc.id) this.toolAcc[idx].id = tc.id;
            if (tc.function && tc.function.name) this.toolAcc[idx].name = tc.function.name;
            if (tc.function && tc.function.arguments) this.toolAcc[idx].args += tc.function.arguments;
          }
        }
        if (typeof d.content === "string" && d.content.length) this.roundSawData = true;
        if ((typeof d.reasoning === "string" && d.reasoning.length) || (typeof d.reasoning_content === "string" && d.reasoning_content.length)) this.roundSawData = true;
      }
      /* v16: MESSAGE-shaped events — providers without delta-style streaming
         deliver the whole round as one choices[0].message event (content,
         reasoning, COMPLETE tool_calls, finish_reason on the same choice).
         Without this the round parsed as silence: the job "finished" with no
         text and the tool round never executed. Guards mirror the app's
         parser: message.content only counts when no delta text preceded it
         (round-scoped), message.tool_calls are the complete authoritative
         form and REPLACE any fragments. */
      const m = ch && ch.message;
      if (ch && m && typeof m === "object") {
        if (typeof m.content === "string" && m.content.length && !this.sawDeltaContent) {
          this.contentText += m.content;
          this.roundSawData = true;
        }
        if ((typeof m.reasoning === "string" && m.reasoning.length) || (typeof m.reasoning_content === "string" && m.reasoning_content.length)) this.sawReasoning = true;
        if (Array.isArray(m.tool_calls) && m.tool_calls.length && !(d && Array.isArray(d.tool_calls))) {
          this.sawToolCalls = true;
          this.roundSawData = true;
          m.tool_calls.forEach((tc, i) => {
            const idx = tc.index ?? i;
            if (!this.toolAcc[idx]) this.toolAcc[idx] = { id: "", name: "", args: "" };
            if (tc.id) this.toolAcc[idx].id = tc.id;
            if (tc.function && tc.function.name) this.toolAcc[idx].name = tc.function.name;
            if (tc.function && tc.function.arguments) this.toolAcc[idx].args = tc.function.arguments;
          });
        }
      }
      if (obj && (obj.usage || (!ch && !obj.error && !obj.choices))) this.roundSawData = true;
      this.eventIndex.push({ c: this.contentText.length, b: lineEndByte });
    },
    /* accumulated calls, ordered by index, app-shaped */
    toolCalls() {
      return Object.keys(this.toolAcc).map(k => ({
        index: Number(k),
        id: this.toolAcc[k].id || "call_" + k,
        name: this.toolAcc[k].name,
        args: this.toolAcc[k].args || "",
      })).filter(c => c.name).sort((a, b) => a.index - b.index);
    },
    /* claim-time: the buffer may end mid-line. If that trailing line is a
       COMPLETE JSON event (the pump died right before its newline),
       count it — the app-side parser does exactly that when its stream
       ends. Both sides then agree on the partial text. */
    flushPending() {
      if (!this.pending) return;
      const s = this.pending.endsWith("\r") ? this.pending.slice(0, -1) : this.pending;
      this.pending = "";
      if (!s.startsWith("data:")) return;
      const raw = s.slice(5).trim();
      if (!raw) return;
      this.line("data: " + raw, this.chunkStartByte);
    },
    boundaryFor(contentLen) {
      if (contentLen <= 0) return 0;
      const idx = this.eventIndex;
      for (let i = idx.length - 1; i >= 0; i--) if (idx[i].c === contentLen) return idx[i].b;
      return -1;
    },
    totalBytes() { return this.chunkStartByte; },
  };
}

/* rebuild a job's byte buffer from the D1 chunk log (byte-exact) */
async function readAllChunkBytes(env, id) {
  const rows = await allSQL(env, `SELECT data FROM chunks WHERE job = ? ORDER BY seq ASC`, [id]);
  const enc = new TextEncoder();
  const parts = [];
  let total = 0;
  for (const r of rows) { const u8 = enc.encode(r.data); parts.push(u8); total += u8.length; }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/* append an error event into the job buffer so ANY later replay (catch-up)
   sees the real upstream failure — honest sync-back of failures */
async function appendErrorChunk(env, id, kind, message, code) {
  const payload = kind === "images"
    ? JSON.stringify({ error: { message: String(message), code: Number(code) || 0 } })
    : "data: " + JSON.stringify({ error: { message: String(message), code: Number(code) || 0 } }) + "\n\n";
  const byteLen = new TextEncoder().encode(payload).length;
  const r = await getSQL(env, `SELECT COALESCE(MAX(seq), -1) AS mx FROM chunks WHERE job = ?`, [id]);
  const seq = (r ? Number(r.mx) : -1) + 1;
  await runSQL(env, `INSERT INTO chunks (job, seq, bytes, data) VALUES (?, ?, ?, ?)`, [id, seq, byteLen, payload]);
  await runSQL(env, `UPDATE jobs SET bytes = bytes + ?, updated_at = ? WHERE id = ?`, [byteLen, Date.now(), id]);
}

/* =====================================================================
   Live registry — in-isolate fan-out for the client that is watching
   right now (zero D1 latency), plus the abort handle used by DELETE,
   parent retirement, and the local harness's teardown simulation.
   ===================================================================== */
const liveMap = globalThis.__nexusLive || (globalThis.__nexusLive = new Map());
function liveFor(id) {
  let l = liveMap.get(id);
  if (!l) {
    l = { id, subs: new Set(), chunks: [], total: 0, done: false, hasPump: false, abortCtl: null };
    liveMap.set(id, l);
  }
  return l;
}
function livePush(live, u8) {
  if (live.total + u8.length <= MAX_JOB_BYTES) {
    live.chunks.push(u8);
    live.total += u8.length;
  }
  for (const c of [...live.subs]) {
    try { c.enqueue(u8); } catch (_) { live.subs.delete(c); }
  }
}
function liveClose(live) {
  live.done = true;
  for (const c of [...live.subs]) { try { c.close(); } catch (_) {} }
  live.subs.clear();
}
/* simulate the runtime killing the pump: subscribers are closed, the D1
   job is left stale (heartbeat frozen) so the next driver claims it */
function liveAbort(live) {
  try { live.abortCtl && live.abortCtl.abort(); } catch (_) {}
  for (const c of [...live.subs]) { try { c.close(); } catch (_) {} }
  live.subs.clear();
  live.hasPump = false;
}
function bufferedFromLive(live, offset) {
  if (offset >= live.total) return new Uint8Array(0);
  const out = new Uint8Array(live.total - offset);
  let pos = 0, written = 0;
  for (const c of live.chunks) {
    if (pos + c.length <= offset) { pos += c.length; continue; }
    const skip = Math.max(0, offset - pos);
    out.set(c.subarray(skip), written);
    written += c.length - skip;
    pos += c.length;
  }
  return out;
}
function liveSubscriber(live, startOffset) {
  let ctl = null;
  return new ReadableStream({
    start(controller) {
      ctl = controller;
      const buffered = bufferedFromLive(live, startOffset);
      if (buffered.length) { try { controller.enqueue(buffered); } catch (_) {} }
      if (live.done) { try { controller.close(); } catch (_) {} return; }
      live.subs.add(controller);
    },
    cancel() { live.subs.delete(ctl); }, // client left — the job keeps going in D1
  });
}

/* =====================================================================
   THE PUMP — one discrete attempt loop for one job.
   Runs inside whatever event claimed the job (the submit event, a
   reconnect piggyback, or the cron tick). Bytes are flushed to D1 FIRST
   and fanned out to live subscribers only once they are durable — a
   subscriber's byte position can never run ahead of the D1 buffer, so
   ANY reconnect at ANY offset is always byte-exact.
   ===================================================================== */
async function driveJob(env, ctx, jobId, opts = {}) {
  if (!jobEngineOk(env)) return;
  const live = liveFor(jobId);
  const token = await claimJob(env, jobId);
  if (!token) return; // another driver owns it — that's the whole race safety
  live.hasPump = true;
  live.abortCtl = new AbortController();
  const signal = live.abortCtl.signal;
  try {
    await pumpLoop(env, jobId, token, live, signal, opts);
  } catch (_) { /* a dead pump must never throw into the event */ }
  finally {
    if (live.abortCtl && live.abortCtl.signal === signal) live.hasPump = false;
  }
}

async function pumpLoop(env, jobId, token, live, signal, opts) {
  let job = await getJobRow(env, jobId);
  if (!job) return;

  /* ---- v14 wait/work meters (see liveWaitWork) ----
     WAIT  = in a line: queued, backoff sleep, refused attempt, no driver.
     WORK  = an accepted upstream attempt is open — the model is thinking,
             writing text, or drafting tool arguments. */
  let waitMs = job.waitMs || 0, workMs = job.workMs || 0;
  let workStart = job.workStart || 0, waitStart = job.waitStart || 0;
  const settleWork = () => { if (workStart) { workMs += Math.max(0, Date.now() - workStart); workStart = 0; } };
  const settleWait = () => { if (waitStart) { waitMs += Math.max(0, Date.now() - waitStart); waitStart = 0; } };
  const timingFields = () => ({ wait_ms: waitMs, work_ms: workMs, work_start: workStart, wait_start: waitStart });
  /* hand-off for the terminal helpers: settles BOTH meters and returns them */
  const tsettle = () => { settleWork(); settleWait(); return { waitMs, workMs }; };
  /* a previous pump died mid-work (isolate teardown): settle its period,
     capped at the last heartbeat it managed to write */
  if (workStart) {
    const hb = job.heartbeat || 0;
    const cut = Date.now() - hb < STALE_LOCK_MS + 5000 ? Date.now() : Math.max(workStart, hb);
    workMs += Math.max(0, cut - workStart);
    workStart = 0;
  }
  if (!waitStart && !workStart) waitStart = Date.now(); // in line until an attempt is accepted
  try { await lockWrite(env, jobId, token, { ...timingFields(), updated_at: Date.now() }); } catch (_) {}

  /* ---- rebuild parse state (byte-exact) ---- */
  const parser = makeParser();
  if (live.total >= job.bytes && (live.chunks.length || job.bytes === 0)) {
    /* this isolate already saw every flushed byte (and maybe more) —
       the in-memory log is a superset of D1 */
    for (const c of live.chunks) parser.feed(c);
    parser.flushPending();
  } else {
    const all = await readAllChunkBytes(env, jobId);
    parser.feed(all);
    parser.flushPending();
  }
  if (parser.errorSeen && !job.finish) { await failJob(env, jobId, token, parser.errorMessage, { live, t: tsettle }); return; }

  /* ---- v15: mirror-mode agent loop -------------------------------
     serverTools jobs run the file-tool rounds HERE against the D1
     workspace mirror. meta.serverTools is set at submit (X-Nexus-WS).
     meta.noServerTools disables further rounds (step cap hit) while
     keeping the round-continue body semantics. */
  const serverToolsMode = !!(job.meta && job.meta.serverTools) && job.kind === "chat" && !!(job.chatKey);
  const serverRoundsOn = () => serverToolsMode && !(job.meta && job.meta.noServerTools);

  let totalBytes = Math.max(parser.totalBytes(), 0);
  let seq = 0;
  {
    const r = await getSQL(env, `SELECT COALESCE(MAX(seq), -1) AS mx FROM chunks WHERE job = ?`, [jobId]);
    seq = r ? Number(r.mx) + 1 : 0;
  }

  const flushDec = new TextDecoder();
  const flushEnc = new TextEncoder();

  /* ---- v15: append a round marker event into the job buffer ----
     Same accounting as flush(): chunk row + bytes + lock-guarded job
     write + live fan-out. Markers are data: lines — byte-real, counted
     by every offset, ignored by pre-v15 app parsers. */
  const appendMarker = async payload => {
    const text = "data: " + JSON.stringify(payload) + "\n\n";
    const u8 = flushEnc.encode(text);
    if (totalBytes + u8.length > MAX_JOB_BYTES) return false;
    await runSQL(env, `INSERT INTO chunks (job, seq, bytes, data) VALUES (?, ?, ?, ?)`, [jobId, seq, u8.length, text]);
    seq++;
    totalBytes += u8.length;
    parser.feed(u8);
    const w = await lockWrite(env, jobId, token, {
      bytes: totalBytes, content_text: parser.contentText, heartbeat: Date.now(), updated_at: Date.now(),
      ...timingFields(),
    });
    if (w !== 1) return false; // lock lost — another driver took over
    livePush(live, u8);
    return true;
  };

  /* ---- v15: execute one complete server-tool round -----------------
     1. run every call against the mirror (app-identical results)
     2. append the nexus_server_round marker (the app builds its message
        timeline from it; any driver replays it to rebuild state)
     3. extend job.req with assistant(tool_calls) + tool(results) — the
        DURABLE conversation, so any future driver continues correctly
     4. reset round-scoped parser state; count the round; keep working.
     Returns false when the lock was lost (caller must stop). */
  async function execServerRound() {
    const calls = parser.toolCalls();
    if (!calls.length) return false;
    const roundText = parser.contentText.slice(parser.roundBase);
    const executed = [];
    for (const c of calls) {
      let args = {};
      let parseOk = true;
      try { args = JSON.parse(c.args || "{}"); } catch (_) { parseOk = false; }
      if (parseOk && args && typeof args === "object" && !Array.isArray(args)) args = fsNormalizeArgs(args);
      let res;
      if (!parseOk) {
        res = { text: "The arguments for " + c.name + " were not valid JSON (truncated or malformed) and the call was NOT executed. Retry with complete, valid JSON — if you keep hitting the length limit, work in smaller pieces (e.g. write_file with less content, or several edit_file calls).", label: "Malformed call · " + c.name, sub: "invalid arguments", icon: "alert", failed: true };
      } else {
        res = await runServerTool(env, job.chatKey, c.name, args || {});
        const resolved = FS_TOOL_ALIASES[c.name] || c.name;
        if (resolved !== c.name) {
          res = { ...res, text: res.text + "\n\n(Note: \"" + c.name + "\" is not an available tool — this ran as " + resolved + ". Call " + resolved + " directly next time.)" };
        }
      }
      executed.push({ i: c.index, id: c.id, name: c.name, ok: !res.failed, text: res.text, label: res.label, sub: res.sub, icon: res.icon, file: res.file });
    }
    const roundNo = parser.serverRounds + 1;
    const markerOk = await appendMarker({
      nexus_server_round: roundNo,
      baseContent: parser.contentText.length,
      calls: executed.map(e => ({ i: e.i, id: e.id, name: e.name, ok: e.ok, text: e.text, label: e.label, sub: e.sub, icon: e.icon, file: e.file })),
    });
    if (!markerOk) return false;
    /* the marker's own parser.feed already reset round-scoped state
       (finishSeen/sawToolCalls/toolAcc/roundBase/roundSawData) */
    /* durable conversation extension: the exact apiMessagesFor shape the
       app would have submitted for the next round */
    let req = job.req;
    if (req && Array.isArray(req.messages)) {
      const asst = { role: "assistant", content: roundText };
      if (calls.length) asst.tool_calls = calls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } }));
      const msgs = [asst];
      for (const e of executed) msgs.push({ role: "tool", tool_call_id: e.id, name: e.name, content: e.text });
      /* step cap: mirror the app's agent step limit — push the wrap-up
         instruction and hand any FURTHER tool rounds to the app */
      if (roundNo + 1 > MAX_SERVER_ROUNDS) {
        msgs.push({ role: "user", content: STEP_LIMIT_INSTRUCTION });
        job.meta = { ...job.meta, noServerTools: true };
      }
      req = { ...req, messages: req.messages.concat(msgs), stream: true };
      const metaOut = { ...job.meta, serverRounds: roundNo };
      job.meta = metaOut;
      const w = await lockWrite(env, jobId, token, { req: JSON.stringify(req), meta: JSON.stringify(metaOut), content_text: parser.contentText, updated_at: Date.now(), ...timingFields() });
      if (w !== 1) return false;
      job.req = req;
    }
    /* tool execution is WORK per the user's own definition ("the AI
       creating files is working") — no wait gap before the next round */
    settleWait();
    workStart = Date.now();
    try { await lockWrite(env, jobId, token, { ...timingFields(), heartbeat: Date.now(), updated_at: Date.now() }); } catch (_) {}
    separatorNeeded = totalBytes > 0;
    return true;
  }

  /* entry window: the previous pump died right after a tool round
     completed but BEFORE it could execute it (finish marker seen, no
     server_round marker for those calls). Execute it now, then run on. */
  if (serverRoundsOn() && !job.finish && parser.finishSeen && parser.sawToolCalls) {
    const calls = parser.toolCalls();
    if (roundAllServerExecutable(calls)) {
      const ok = await execServerRound();
      if (!ok) { await finalizeDone(env, jobId, token, live, tsettle); return; }
    }
  }
  if (parser.finishSeen || job.finish) { await finalizeDone(env, jobId, token, live, tsettle); return; }

  let attempts = job.attempts;      // total across all drivers (persisted)
  let inlineAttempts = 0;           // attempts driven by THIS event
  const maxInline = opts.maxAttempts || 4;
  const deadline = Date.now() + (opts.budgetMs || EVENT_BUDGET_MS);
  let firstUpstream = opts.firstUpstream || null;
  let firstByteAt = job.firstByte || 0;

  let pendingFlush = "";
  let pendingBytes = 0;
  let lastFlushAt = Date.now();
  let separatorNeeded = totalBytes > 0; // a continuation must start line-aligned
  let lastByte = 0x0A;
  { // probe the true last byte of the current buffer
    if (live.chunks.length) {
      const last = live.chunks[live.chunks.length - 1];
      lastByte = last[last.length - 1];
    } else if (totalBytes > 0) {
      const all = await readAllChunkBytes(env, jobId);
      if (all.length) lastByte = all[all.length - 1];
    }
  }

  const flush = async () => {
    if (!pendingFlush) return true;
    const text = pendingFlush;
    pendingFlush = ""; pendingBytes = 0;
    const u8 = flushEnc.encode(text);
    const byteLen = u8.length;
    try {
      await runSQL(env, `INSERT INTO chunks (job, seq, bytes, data) VALUES (?, ?, ?, ?)`, [jobId, seq, byteLen, text]);
      seq++;
      const fields = {
        bytes: totalBytes, content_text: parser.contentText,
        finish: parser.finishSeen ? 1 : 0,
        heartbeat: Date.now(), updated_at: Date.now(),
        ...timingFields(), // v14 meters ride every flush — cheap, always fresh
      };
      if (!firstByteAt && (parser.contentText.length > 0 || parser.sawReasoning)) {
        firstByteAt = Date.now();
        fields.first_byte = firstByteAt; // legacy wait/work split (v13 rows)
      }
      const w = await lockWrite(env, jobId, token, fields);
      if (w !== 1) return false; // lock lost — another driver took over
    } catch (_) { return !signal.aborted; }
    /* fan out ONLY durable bytes: live subscribers stay byte-aligned with
       the D1 buffer, so a reconnect at any offset replays exactly */
    livePush(live, u8);
    lastFlushAt = Date.now();
    return true;
  };

  /* heartbeat while a slow first token takes its time — keeps other
     drivers from falsely claiming an alive-but-quiet pump. Cadence is tied
     to the stale-lock threshold (a third of it): a live pump's heartbeat
     can never age past the claim check, in ANY tunable configuration. */
  const heart = setInterval(() => {
    if (signal.aborted) return;
    lockWrite(env, jobId, token, { heartbeat: Date.now(), updated_at: Date.now() }).catch(() => {});
  }, Math.min(10000, Math.max(400, Math.floor(STALE_LOCK_MS / 3))));

  let gaveUp = false;
  try {
    while (true) {
      if (signal.aborted) return; // killed like the runtime would — leave D1 stale on purpose
      if (Date.now() > deadline) { gaveUp = true; break; }

      /* v14: the attempt ceiling follows the job's pace profile (a
         Relentless pick earns its 100 attempts; the default stays put) */
      const pace = await jobRetryProfile(env, jobId);

      /* park: tool-call cuts are never continued server-side (app protocol).
         images never continue either — they re-issue from zero or park.
         v15 EXCEPT in mirror mode: the cut fragments are discarded (both
         parsers reset on the nexus_round_reset marker) and the model is
         re-asked with the app's exact CONTINUE protocol — the run keeps
         going with NOBODY attached, which is the entire point of the
         worker holding the files. */
      if (parser.sawToolCalls && !parser.finishSeen) {
        if (serverRoundsOn()) {
          const resetOk = await appendMarker({ nexus_round_reset: 1 });
          if (!resetOk) { liveAbort(live); return; }
          attempts++; inlineAttempts++;
          if (!waitStart) waitStart = Date.now();
          try { await lockWrite(env, jobId, token, { attempts, updated_at: Date.now(), ...timingFields() }); } catch (_) {}
          if (inlineAttempts >= maxInline) { gaveUp = true; break; }
          await pacedSleep(env, jobId, pace, attempts, signal);
          separatorNeeded = true; // the re-ask must start line-aligned
          continue;
        }
        await parkJob(env, jobId, token, tsettle); liveClose(live); return;
      }
      if (job.kind !== "chat" && totalBytes > 0 && !parser.finishSeen) { await parkJob(env, jobId, token, tsettle); liveClose(live); return; }
      if (attempts >= profMax(pace)) { await failJob(env, jobId, token, "retry budget used up", { live, t: tsettle }); return; }

      /* ---- build the upstream request ---- */
      let body;
      if (serverToolsMode) {
        /* v15: the conversation lives in job.req — every completed server
           round is already appended there. A round with no events yet
           re-issues it; a partially-streamed round continues from ITS OWN
           partial text (roundBase), never the whole buffer — earlier
           rounds' text is already in the messages. */
        if (!parser.roundSawData) body = job.req;
        else body = {
          ...job.req,
          messages: (job.req.messages || []).concat([
            { role: "assistant", content: parser.contentText.slice(parser.roundBase) },
            { role: "user", content: CONTINUE_INSTRUCTION },
          ]),
          stream: true,
        };
      } else if (job.kind !== "chat" || !parser.sawData) body = job.req; // plain re-issue
      else body = {
        ...job.req,
        messages: (job.req.messages || []).concat([
          { role: "assistant", content: parser.contentText },
          { role: "user", content: CONTINUE_INSTRUCTION },
        ]),
        stream: true,
      };

      const authRow = await getSQL(env, `SELECT auth FROM secrets WHERE job = ?`, [jobId]);
      const fwd = Object.assign({}, job.meta.fwd || {});
      if (authRow && authRow.auth) fwd.authorization = authRow.auth;

      const ac = new AbortController();
      const onOuterAbort = () => { try { ac.abort(); } catch (_) {} };
      signal.addEventListener("abort", onOuterAbort, { once: true });
      let lastBeat = Date.now();
      const wd = setInterval(() => { if (Date.now() - lastBeat > UPSTREAM_STALL_MS) { try { ac.abort(); } catch (_) {} } }, 5000);

      let upstream = null, upstreamErr = null;
      if (firstUpstream) { upstream = firstUpstream; firstUpstream = null; }
      else {
        try {
          upstream = await fetch(upstreamBase(env) + (job.kind === "chat" ? "/chat/completions" : "/images"), {
            method: "POST",
            headers: headersFrom(fwd),
            body: JSON.stringify(body),
            signal: ac.signal,
            // @ts-ignore runtime-specific
            cf: { cacheTtl: 0 },
          });
        } catch (err) { upstreamErr = err; }
      }

      if (!upstreamErr && upstream && upstream.ok && upstream.body) {
        /* ---- ACCEPTED: the model took the request — the line wait ends,
           the work meter starts (thinking, text, tool args all count) ---- */
        settleWait();
        workStart = Date.now();
        try { await lockWrite(env, jobId, token, { ...timingFields(), updated_at: Date.now() }); } catch (_) {}
        /* ---- stream it: fan out + parse + flush ---- */
        const reader = upstream.body.getReader();
        let firstChunk = true;
        let naturalEnd = false;
        try {
          while (true) {
            const res = await reader.read();
            if (signal.aborted) { try { reader.cancel(); } catch (_) {} return; }
            if (res.done) { naturalEnd = true; break; }
            const value = res.value;
            if (value && value.length) {
              lastBeat = Date.now();
              if (firstChunk && separatorNeeded) {
                if (lastByte !== 0x0A) {
                  const sep = new Uint8Array([0x0A, 0x0A]); // line-align before a continuation
                  parser.feed(sep);
                  pendingFlush += "\n\n"; pendingBytes += 2;
                  totalBytes += 2;
                  lastByte = 0x0A;
                }
                separatorNeeded = false;
              }
              firstChunk = false;
              parser.feed(value);
              totalBytes += value.length;
              if (totalBytes <= MAX_JOB_BYTES) {
                pendingFlush += flushDec.decode(value, { stream: true });
                pendingBytes += value.length;
              }
              lastByte = value[value.length - 1];
              if ((Date.now() - lastFlushAt > FLUSH_MS || pendingBytes > FLUSH_BYTES) && totalBytes <= MAX_JOB_BYTES) {
                if (!(await flush())) { clearInterval(wd); signal.removeEventListener("abort", onOuterAbort); liveAbort(live); return; }
              }
            }
          }
          const tailText = flushDec.decode();
          if (tailText) { pendingFlush += tailText; }
        } catch (_) { /* aborted or the socket died mid-stream → truncated */ }
        clearInterval(wd);
        signal.removeEventListener("abort", onOuterAbort);
        if (!(await flush())) { liveAbort(live); return; }
        settleWork(); // the accepted attempt is over — work stops, line resumes below
        if (parser.errorSeen) { await failJob(env, jobId, token, parser.errorMessage, { live, t: tsettle }); return; }
        if (parser.finishSeen) {
          /* v15: a COMPLETE round that asked for file tools and nothing
             else — execute it here against the mirror and keep the loop
             running (this is the server-side agent step). Any non-file
             call hands the whole round to the app: finalizeDone, exactly
             the pre-v15 protocol. */
          if (serverRoundsOn() && parser.sawToolCalls) {
            const calls = parser.toolCalls();
            if (roundAllServerExecutable(calls)) {
              const ok = await execServerRound();
              if (!ok) { liveAbort(live); return; }
              /* a server round is not a failed attempt — the retry budget
                 is untouched; the loop continues immediately */
              continue;
            }
          }
          await finalizeDone(env, jobId, token, live, tsettle); return;
        }
        if (naturalEnd && job.kind !== "chat") { await finalizeDone(env, jobId, token, live, tsettle); return; } // images: full body = done
        if (signal.aborted) return;
        /* truncated → persist the attempt count and try again inline
           (the lock is NOT released: fresh heartbeats prove we're alive,
           so no other driver can steal the job mid-run) */
        attempts++; inlineAttempts++;
        if (!waitStart) waitStart = Date.now(); // backoff = back in line
        try { await lockWrite(env, jobId, token, { attempts, updated_at: Date.now(), ...timingFields() }); } catch (_) {}
        if (inlineAttempts >= maxInline) { gaveUp = true; break; }
        await pacedSleep(env, jobId, pace, attempts, signal);
        separatorNeeded = totalBytes > 0;
        continue;
      }

      clearInterval(wd);
      signal.removeEventListener("abort", onOuterAbort);
      /* ---- the attempt failed to start / was refused ---- */
      let status = 0, message = "network error";
      if (upstream) {
        status = upstream.status;
        try { const t = await upstream.text(); message = String(t).slice(0, 400); } catch (_) {}
      } else if (upstreamErr) message = String((upstreamErr && upstreamErr.message) || upstreamErr);

      const fatal = [400, 401, 403, 404, 422].includes(status);
      if (fatal && totalBytes === 0) {
        await failJob(env, jobId, token, "upstream " + status + ": " + message,
          { errorEvent: { message: message, code: status }, kind: job.kind, live, t: tsettle });
        return;
      }
      if (fatal) { await parkJob(env, jobId, token, tsettle); liveClose(live); return; }
      /* retryable: 429 / 408 / 5xx / network — re-request until it gets in.
         A refused attempt is pure line time: wait_start stays running. */
      attempts++; inlineAttempts++;
      if (!waitStart) waitStart = Date.now();
      try { await lockWrite(env, jobId, token, { attempts, updated_at: Date.now(), ...timingFields() }); } catch (_) {}
      if (inlineAttempts >= maxInline) { gaveUp = true; break; }
      await pacedSleep(env, jobId, pace, attempts, signal);
    }
  } finally {
    clearInterval(heart);
    try { await flush(); } catch (_) {}
    settleWork(); // whatever ended this pump, an open work period is over
    if (gaveUp) {
      /* release for the next driver (cron / piggyback / app reconnect).
         The line WAIT keeps running: wait_start stays set so /status and
         /jobs keep narrating honest in-line time across the handoff. */
      await releaseJob(env, jobId, token, attempts, timingFields());
      liveClose(live);
    } else {
      /* every non-gaveUp exit path already settled via its terminal helper;
         persist the final meters anyway (cheap, and covers the abort path) */
      try { await lockWrite(env, jobId, token, timingFields()); } catch (_) {}
    }
  }
}

async function releaseJob(env, id, token, attempts, timing) {
  const now = Date.now();
  /* v14: next_retry honors the job's pace profile — a gentle pick spaces
     the next driver out the same way an inline backoff would */
  const pace = await jobRetryProfile(env, id);
  try {
    const fields = {
      heartbeat: 0, next_retry: now + paceDelay(profDelays(pace), attempts), attempts, updated_at: now, lock_token: null,
    };
    if (timing) Object.assign(fields, timing); // work settled; wait_start stays live
    await lockWrite(env, id, token, fields);
  } catch (_) {}
}
async function finalizeDone(env, id, token, live, t) {
  const now = Date.now();
  const tv = t ? t() : null; // settle both meters at the true end
  try {
    const fields = { status: "done", finish: 1, heartbeat: 0, updated_at: now, lock_token: null };
    if (tv) Object.assign(fields, { wait_ms: tv.waitMs, work_ms: tv.workMs, wait_start: 0, work_start: 0 });
    await lockWrite(env, id, token, fields);
    await runSQL(env, `DELETE FROM secrets WHERE job = ?`, [id]);
  } catch (_) {}
  liveClose(live);
}
async function parkJob(env, id, token, t) {
  const now = Date.now();
  const tv = t ? t() : null;
  try {
    const fields = { status: "parked", heartbeat: 0, updated_at: now, lock_token: null };
    if (tv) Object.assign(fields, { wait_ms: tv.waitMs, work_ms: tv.workMs, wait_start: 0, work_start: 0 });
    await lockWrite(env, id, token, fields);
    await runSQL(env, `DELETE FROM secrets WHERE job = ?`, [id]);
  } catch (_) {}
}
async function failJob(env, id, token, reason, o = {}) {
  const now = Date.now();
  const tv = o.t ? o.t() : null; // settle both meters — failure is terminal
  /* 1. bytes FIRST: when a pre-stream failure needs an error event, it must
     already be in the job buffer before the status flips to failed — a
     polling tail would otherwise close before the error chunk lands */
  if (o.errorEvent) {
    try { await appendErrorChunk(env, id, o.kind || "chat", o.errorEvent.message, o.errorEvent.code); } catch (_) {}
  }
  /* 2. status + honest reason in meta (so /job/:id/status can report it) */
  const timingFields = tv ? { wait_ms: tv.waitMs, work_ms: tv.workMs, wait_start: 0, work_start: 0 } : {};
  try {
    const row = await getJobRow(env, id);
    if (row) {
      const meta = row.meta || {};
      meta.error = String(reason).slice(0, 300);
      await lockWrite(env, id, token, { status: "failed", heartbeat: 0, updated_at: now, lock_token: null, meta: JSON.stringify(meta), ...timingFields });
    } else {
      await lockWrite(env, id, token, { status: "failed", heartbeat: 0, updated_at: now, lock_token: null, ...timingFields });
    }
  } catch (_) {
    try { await lockWrite(env, id, token, { status: "failed", heartbeat: 0, updated_at: now, lock_token: null, ...timingFields }); } catch (_) {}
  }
  try { await runSQL(env, `DELETE FROM secrets WHERE job = ?`, [id]); } catch (_) {}
  /* 3. live subscribers see the same error immediately */
  if (o.errorEvent && o.live) {
    const payload = (o.kind || "chat") === "images"
      ? JSON.stringify({ error: { message: o.errorEvent.message, code: o.errorEvent.code } })
      : "data: " + JSON.stringify({ error: { message: o.errorEvent.message, code: o.errorEvent.code } }) + "\n\n";
    const u8 = new TextEncoder().encode(payload);
    for (const c of [...o.live.subs]) { try { c.enqueue(u8); } catch (_) {} }
  }
  if (o.live) liveClose(o.live);
}

/* =====================================================================
   SUBMIT — the v10 heart. The prompt becomes a durable D1 job BEFORE any
   upstream request exists; the caller gets 202 { jobId } in milliseconds
   and subscribes separately. Idempotency + explicit parent retirement.
   ===================================================================== */
async function handleSubmit(request, pathname, ctx, env, parsed, fwd) {
  const reqKey = sanitizeKey(request.headers.get("X-Nexus-Key"));
  const chatKey = sanitizeKey(request.headers.get("X-Nexus-Chat"));
  const parent = sanitizeKey(request.headers.get("X-Nexus-Parent"));
  /* v14: the starting retry pace rides the submit (the app's pace row) */
  const retryMode = sanitizeKey(request.headers.get("X-Nexus-Retry"));
  /* v15: the submit declares a SYNCED workspace mirror — the worker may
     execute this chat's file-tool rounds server-side (X-Nexus-WS: 1 after
     a successful syncWorkspace). Only honored when the request actually
     declares file tools; old apps never send the header. */
  const wsSync = request.headers.get("X-Nexus-WS") === "1";
  const serverTools = !!(wsSync && chatKey && pathname === "/chat" && requestHasFileTools(parsed));

  /* idempotency: a network retry of the same submission must not
     double-spend — hand back the job we already created */
  if (reqKey) {
    try {
      const existing = await getSQL(env,
        `SELECT id FROM jobs WHERE req_key = ? AND status IN ('queued','streaming','done') AND created_at > ? ORDER BY created_at DESC LIMIT 1`,
        [reqKey, Date.now() - JOB_TTL_MS]);
      if (existing && existing.id) {
        return json({ ok: true, jobId: existing.id, reused: true, v: WORKER_VERSION }, 202, { "X-Nexus-Job": existing.id });
      }
    } catch (_) {}
  }

  /* explicit continuation: retire the job this one replaces (only a
     RUNNING parent needs stopping; finished ones simply age out) */
  if (parent) {
    try {
      await stopJobRows(env, [parent]);
      const pl = liveMap.get(parent);
      if (pl) liveAbort(pl);
    } catch (_) {}
  }

  const id = crypto.randomUUID();
  const kind = pathname === "/images" ? "images" : "chat";
  const now = Date.now();
  const metaFwd = Object.assign({}, fwd);
  delete metaFwd.authorization;
  const meta = { fwd: metaFwd, contentType: kind === "images" ? "application/json" : "text/event-stream", submit: true };
  if (serverTools) meta.serverTools = true; // v15: mirror-mode agent loop
  if (retryModes()[retryMode]) {
    const prof = retryModes()[retryMode];
    meta.retry = { mode: retryMode, label: prof.label, max: prof.max, delays: prof.delays, at: now };
  }
  const openChunk = kind === "chat" ? OPEN_CHUNK : ""; // images: JSON body, no comment
  const openLen = new TextEncoder().encode(openChunk).length;
  await runSQL(env,
    `INSERT INTO jobs (id, kind, status, created_at, updated_at, heartbeat, next_retry, attempts, finish, bytes, content_text, req, meta, lock_token, chat_key, req_key, parent, first_byte, wait_ms, work_ms, work_start, wait_start) VALUES (?, ?, 'queued', ?, ?, 0, 0, 0, 0, ?, '', ?, ?, NULL, ?, ?, ?, 0, 0, 0, 0, ?)`,
    [id, kind, now, now, openLen, JSON.stringify(parsed), JSON.stringify(meta), chatKey, reqKey, parent, now]);
  if (openLen) {
    try { await runSQL(env, `INSERT INTO chunks (job, seq, bytes, data) VALUES (?, 0, ?, ?)`, [id, openLen, openChunk]); } catch (_) {}
  }
  if (fwd.authorization) {
    try { await runSQL(env, `INSERT INTO secrets (job, auth) VALUES (?, ?)`, [id, fwd.authorization]); } catch (_) {}
  }
  try { ctx && ctx.waitUntil && ctx.waitUntil(prune(env).catch(() => {})); } catch (_) {}
  try { ctx && ctx.waitUntil && ctx.waitUntil(driveJob(env, ctx, id).catch(() => {})); } catch (_) {}
  return json({ ok: true, jobId: id, serverTools, v: WORKER_VERSION }, 202, { "X-Nexus-Job": id });
}

/* =====================================================================
   v15: THE WORKSPACE SYNC ENDPOINTS — "cloudflare is a perfect backup".
   POST /ws/:chatKey  — push local edits (last-write-wins per file by
                        mtime) + tombstones for deletions; the response
                        carries the full server manifest (path/bytes/mtime)
                        so one round-trip is a complete pull decision.
   GET  /ws/:chatKey?paths=a,b — pull file contents (all files when
                        paths is omitted).
   DELETE /ws/:chatKey — the chat was deleted locally; clear its mirror.
   All auth-gated like /jobs (Authorization header). The mirror is never
   TTL-pruned — it is the backup, not job state.
   ===================================================================== */
async function handleWsSync(request, env) {
  if (!request.headers.get("authorization")) {
    return json({ error: "send your API key as the Authorization header (same as /chat)" }, 401);
  }
  if (!hasDB(env)) return json({ error: "workspace sync needs the D1 engine (bind DB)" }, 404);
  try { await ensureSchema(env); } catch (_) {}
  const chatKey = sanitizeKey(new URL(request.url).pathname.split("/")[2]);
  if (!chatKey) return json({ error: "chat key required" }, 400);

  if (request.method === "DELETE") {
    try { await wsClear(env, chatKey); } catch (_) { return json({ error: "clear failed on the database", retry: true }, 503); }
    return json({ ok: true, cleared: chatKey, v: WORKER_VERSION });
  }

  if (request.method === "POST") {
    let body = null;
    try { body = await request.json(); } catch (_) {}
    if (!body || typeof body !== "object") return json({ error: "body must be JSON { files, mtime, deleted }" }, 400);
    const files = (body.files && typeof body.files === "object" && !Array.isArray(body.files)) ? body.files : {};
    const mtimes = (body.mtime && typeof body.mtime === "object" && !Array.isArray(body.mtime)) ? body.mtime : {};
    const deleted = Array.isArray(body.deleted) ? body.deleted.map(d => String(d).slice(0, 140)) : [];
    let adopted = 0, conflicts = 0;
    for (const path of Object.keys(files)) {
      const p = String(path).slice(0, 140);
      if (!p) continue;
      const content = String(files[path] ?? "");
      if (content.length > MAX_WS_FILE_BYTES) continue; // app caps match — belt and braces
      const mtime = Math.floor(Number(mtimes[path]) || Date.now());
      try {
        const row = await getSQL(env, `SELECT mtime FROM ws_files WHERE chat_key = ? AND path = ?`, [chatKey, p]);
        if (row && Number(row.mtime) > mtime) { conflicts++; continue; } // the worker wrote a newer version — it stays; the app pulls it
        await wsPutFile(env, chatKey, p, content, mtime);
        adopted++;
      } catch (_) {}
    }
    for (const p of deleted) {
      try { await wsDeleteFile(env, chatKey, p); } catch (_) {}
    }
    if (adopted || deleted.length) { try { await wsBumpRev(env, chatKey); } catch (_) {} }
    try { await runSQL(env, `INSERT INTO ws_meta (chat_key, rev, synced_at) VALUES (?, 0, ?) ON CONFLICT(chat_key) DO UPDATE SET synced_at = excluded.synced_at`, [chatKey, Date.now()]); } catch (_) {}
    let manifest = {};
    try { manifest = await wsManifest(env, chatKey); } catch (err) { return json({ error: "manifest failed on the database", retry: true }, 503); }
    return json({ ok: true, chatKey, rev: await wsRev(env, chatKey), adopted, conflicts, ws: { meta: manifest }, v: WORKER_VERSION });
  }

  if (request.method === "GET") {
    const q = new URL(request.url).searchParams;
    const wanted = q.get("paths");
    const files = {};
    const mtime = {};
    try {
      if (wanted) {
        for (const p of wanted.split(",").map(s => s.trim()).filter(Boolean).slice(0, MAX_WS_FILES)) {
          const row = await wsGetFile(env, chatKey, p);
          if (row) { files[p] = row.content; mtime[p] = row.mtime; }
        }
      } else {
        const manifest = await wsManifest(env, chatKey);
        for (const p of Object.keys(manifest)) {
          const row = await wsGetFile(env, chatKey, p);
          if (row) { files[p] = row.content; mtime[p] = row.mtime; }
        }
      }
    } catch (err) { return json({ error: "read failed on the database", retry: true }, 503); }
    return json({ ok: true, chatKey, rev: await wsRev(env, chatKey), files, mtime, v: WORKER_VERSION });
  }
  return json({ error: "method not allowed" }, 405);
}

/* =====================================================================
   ATTACH-ON-CONTINUE (legacy clients only) — the app's continue request
   meets a job we already hold. v10 apps use X-Nexus-Parent instead.
   ===================================================================== */
async function matchContinueJob(env, parsed) {
  const msgs = parsed && parsed.messages;
  if (!Array.isArray(msgs) || msgs.length < 3) return null;
  const last = msgs[msgs.length - 1];
  if (!last || last.role !== "user" || last.content !== CONTINUE_INSTRUCTION) return null;
  const prev = msgs[msgs.length - 2];
  if (!prev || prev.role !== "assistant" || typeof prev.content !== "string") return null;
  const prefixKey = JSON.stringify(msgs.slice(0, -2));
  const partial = prev.content;
  const now = Date.now();
  const rows = await allSQL(env,
    `SELECT id, req, content_text FROM jobs WHERE kind = 'chat' AND status IN ('queued','streaming','done') AND updated_at > ? ORDER BY updated_at DESC LIMIT 12`,
    [now - JOB_TTL_MS]);
  let best = null, bestLen = -1;
  const superseded = [];
  for (const r of rows) {
    let req = null;
    try { req = JSON.parse(r.req); } catch (_) { continue; }
    if (!req || !Array.isArray(req.messages)) continue;
    if (JSON.stringify(req.messages) !== prefixKey) continue;
    const ct = r.content_text || "";
    if (!ct.startsWith(partial)) { superseded.push(r.id); continue; } // the app is ahead — retire it
    if (ct.length > bestLen) { best = r; bestLen = ct.length; }
  }
  for (const id of superseded) {
    try { await stopJobRows(env, [id]); } catch (_) {}
  }
  if (!best) return null;
  /* exact byte boundary for the app's partial (replay-parse the job) */
  const all = await readAllChunkBytes(env, best.id);
  const parser = makeParser();
  parser.feed(all);
  parser.flushPending();
  const boundary = parser.boundaryFor(partial.length);
  if (boundary < 0) return null;
  return { id: best.id, boundary };
}

/* =====================================================================
   TAIL: replay a job from byte N, then follow live progress (D1 poll).
   NEVER inject heartbeat bytes — the app's byte-offset math counts every
   byte we send, so the body must be pure buffer bytes.
   ===================================================================== */
/* v13: the tail is now the ONLY delivery path (the in-isolate live
   fast-path was retired — see handleJobGet). Two hard rules it must obey:
   1. it may close ONLY on justified ends: terminal status + all bytes
      delivered, the row is genuinely gone, or the age cap. NEVER because a
      pump gave up its inline attempt budget (the job keeps running for the
      next driver) — that clean close read as "truncated" on the app and
      produced the user's "response was cut off (status 0)" error card.
   2. a transient D1 error must NOT close it — retry with backoff; only a
      SUSTAINED database outage (15 consecutive failures) gives up. */
function tailStream(env, ctx, jobId, startOffset) {
  const enc = new TextEncoder();
  let closed = false;
  return new ReadableStream({
    start(controller) {
      const push = u8 => { if (!closed) { try { controller.enqueue(u8); } catch (_) { closed = true; } } };
      const close = () => { if (!closed) { closed = true; try { controller.close(); } catch (_) {} } };
      (async () => {
        let pos = 0;           // cumulative byte position of the chunk cursor
        let sent = startOffset; // the next byte the client needs
        let lastSeq = -1;
        let lastKick = 0;
        let idlePolls = 0;
        let lastTotal = -1;
        let dbFails = 0;       // consecutive D1 errors — tolerance, then give up
        const deliver = u8 => {
          /* contiguous delivery: a chunk may start BEFORE the client's
             offset (its tail was already seen live before the flush
             landed) — skip exactly that part, never duplicate */
          const skip = Math.max(0, sent - pos);
          if (skip < u8.length) push(u8.subarray(skip));
          pos += u8.length;
          sent = Math.max(sent, pos);
        };
        try {
          /* ---- replay phase (retried — a transient D1 blip must not kill
             the tail before a single byte is served) ---- */
          let rows = null;
          for (let i = 0; i < 4 && !rows; i++) {
            try { rows = await allSQL(env, `SELECT seq, bytes, data FROM chunks WHERE job = ? ORDER BY seq ASC`, [jobId]); dbFails = 0; }
            catch (_) { await sleep(300 * (i + 1)); }
          }
          if (!rows) { close(); return; } // cannot read the buffer at all
          for (const r of rows) {
            deliver(enc.encode(r.data));
            lastSeq = Number(r.seq);
          }
          /* ---- live phase ---- */
          while (!closed) {
            /* a watching tail keeps this job's execution context alive (its
               response is still streaming) — mark the interest so the runtime
               model never treats a watched job as orphaned */
            const liveWatch = liveFor(jobId);
            liveWatch.__tailSeen = Date.now();
            let r;
            try {
              r = await getSQL(env, `SELECT status, bytes, heartbeat, created_at FROM jobs WHERE id = ?`, [jobId]);
              dbFails = 0;
            } catch (_) {
              /* transient D1 hiccup: back off and keep the stream open —
                 the job row is still there on the other side of the blip */
              if (++dbFails >= 15) { close(); return; }
              await sleep(Math.min(2000 * dbFails, 8000));
              continue;
            }
            if (!r) { close(); return; } // row genuinely gone (pruned/expired)
            const status = r.status;
            const total = Number(r.bytes);
            if (total > pos || status === "done") {
              let rows2 = null;
              try {
                rows2 = await allSQL(env, `SELECT seq, data FROM chunks WHERE job = ? AND seq > ? ORDER BY seq ASC`, [jobId, lastSeq]);
              } catch (_) {
                /* skip this delivery round — lastSeq has NOT advanced, so the
                   next poll re-reads the same range; no bytes are lost */
                if (++dbFails >= 15) { close(); return; }
                await sleep(Math.min(2000 * dbFails, 8000));
                continue;
              }
              for (const c of rows2) {
                deliver(enc.encode(c.data));
                lastSeq = Number(c.seq);
              }
            }
            if ((status === "done" || status === "failed" || status === "parked" || status === "stopped") && pos >= total) { close(); return; }
            if (Date.now() - Number(r.created_at) > JOB_TTL_MS + DONE_TTL_MS) { close(); return; }
            /* the job looks stalled — kick a work pass in THIS event (a
               fresh execution context = progress resumes immediately) */
            if (status === "queued" || status === "streaming") {
              const stale = Date.now() - Number(r.heartbeat) > STALE_LOCK_MS;
              if (stale && Date.now() - lastKick > Math.max(3000, TAIL_POLL_SLOW)) {
                lastKick = Date.now();
                try { ctx && ctx.waitUntil && ctx.waitUntil(driveJob(env, ctx, jobId).catch(() => {})); } catch (_) {}
              }
            }
            idlePolls = lastTotal === total ? idlePolls + 1 : 0;
            lastTotal = total;
            await sleep(idlePolls > 4 ? TAIL_POLL_SLOW : TAIL_POLL_FAST);
          }
        } catch (_) { close(); }
      })();
    },
    cancel() { closed = true; },
  });
}

/* ---------- routes ---------- */
function relayHeaders(contentType, jobId, extra) {
  const h = { "Content-Type": contentType || "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" };
  if (jobId) h["X-Nexus-Job"] = jobId;
  for (const k in CORS) h[k] = CORS[k];
  if (extra) for (const k in extra) h[k] = extra[k];
  return h;
}

async function handleProxy(request, pathname, ctx, env) {
  const rawBody = new Uint8Array(await request.arrayBuffer());
  let parsed = null;
  try { parsed = JSON.parse(new TextDecoder().decode(rawBody)); } catch (_) {}
  const fwd = {};
  for (const h of FWD_HEADERS) { const v = request.headers.get(h); if (v) fwd[h] = v; }
  const submitMode = request.headers.get("X-Nexus-Submit") === "1";

  /* no usable D1 (or an unparseable body) → plain passthrough (graceful
     degrade — a submit-mode app sees the streaming response and falls back
     to the legacy protocol automatically). A BROKEN database takes the
     same path: chat must keep working no matter what D1 does. */
  if (!jobEngineOk(env) || !parsed) {
    const upstream = await fetch(upstreamBase(env) + (pathname === "/chat" ? "/chat/completions" : "/images"), {
      method: "POST", headers: headersFrom(fwd), body: rawBody,
      // @ts-ignore runtime-specific
      cf: { cacheTtl: 0 },
    });
    const hdrs = new Headers(upstream.headers);
    for (const k in CORS) hdrs.set(k, CORS[k]);
    return new Response(upstream.body, { status: upstream.status, headers: hdrs });
  }

  /* ---- v10 SUBMIT: the job exists before the upstream does ----
     If D1 hiccups at the exact moment of the INSERT (verified schema, but
     a transient outage), we degrade THIS request to a clean passthrough —
     the user gets their answer instead of an error card, and the schema
     re-verifies on the next request. */
  if (submitMode) {
    try { return await handleSubmit(request, pathname, ctx, env, parsed, fwd); }
    catch (err) {
      try { await invalidateSchema(env); } catch (_) {}
      try {
        const up = await fetch(upstreamBase(env) + (pathname === "/chat" ? "/chat/completions" : "/images"), {
          method: "POST", headers: headersFrom(fwd), body: rawBody,
          // @ts-ignore runtime-specific
          cf: { cacheTtl: 0 },
        });
        const hdrs = new Headers(up.headers);
        for (const k in CORS) hdrs.set(k, CORS[k]);
        return new Response(up.body, { status: up.status, headers: hdrs });
      } catch (_) {
        return json({ error: { message: "submit failed: " + ((err && err.message) || String(err)), code: 502 } }, 502);
      }
    }
  }

  /* ---- legacy proxy+tee (apps without the submit header) ---- */
  if (pathname === "/chat") {
    const m = await matchContinueJob(env, parsed);
    if (m) {
      const job = await getJobRow(env, m.id);
      const live = liveFor(m.id);
      const kick = () => { try { ctx && ctx.waitUntil && ctx.waitUntil(driveJob(env, ctx, m.id).catch(() => {})); } catch (_) {} };
      if (job && (job.status === "streaming" || job.status === "queued")) kick();
      /* X-Nexus-Job is hidden when the boundary is > 0 — the app's
         absolute-offset reconnect math must stay correct */
      const headers = relayHeaders((job && job.meta.contentType) || "text/event-stream", m.boundary > 0 ? null : m.id);
      if (live.hasPump && live.abortCtl && !live.abortCtl.signal.aborted) {
        return new Response(liveSubscriber(live, m.boundary), { status: 200, headers });
      }
      return new Response(tailStream(env, ctx, m.id, m.boundary), { status: 200, headers });
    }
  }

  /* attempt 0 — fatal 4xx passes straight through (the app maps
     auth/path errors itself); retryable failures become a durable
     queued job the pump keeps re-requesting "until it gets in". */
  let upstream = null, upstreamErr = null;
  try {
    upstream = await fetch(upstreamBase(env) + (pathname === "/chat" ? "/chat/completions" : "/images"), {
      method: "POST", headers: headersFrom(fwd), body: rawBody,
      // @ts-ignore runtime-specific
      cf: { cacheTtl: 0 },
    });
  } catch (err) { upstreamErr = err; }
  const retryable = !!(upstreamErr || (upstream && !upstream.ok && [408, 429, 500, 502, 503, 504, 522, 524].includes(upstream.status)));
  if (!retryable && upstream && (!upstream.ok || !upstream.body)) {
    const hdrs = new Headers(upstream.headers);
    for (const k in CORS) hdrs.set(k, CORS[k]);
    return new Response(upstream.body, { status: upstream.status, headers: hdrs });
  }

  /* create the durable job — a D1 hiccup here degrades to streaming the
     attempt-0 response straight to the client (no durability for THIS
     response, but never an error card) */
  const id = crypto.randomUUID();
  const kind = pathname === "/images" ? "images" : "chat";
  const now = Date.now();
  const contentType = (upstream && upstream.headers.get("content-type")) || (kind === "images" ? "application/json" : "text/event-stream");
  const metaFwd = Object.assign({}, fwd);
  delete metaFwd.authorization;
  const meta = { fwd: metaFwd, contentType };
  try {
    const openChunk = kind === "chat" ? OPEN_CHUNK : "";
    const openLen = new TextEncoder().encode(openChunk).length;
    await runSQL(env,
      `INSERT INTO jobs (id, kind, status, created_at, updated_at, heartbeat, next_retry, attempts, finish, bytes, content_text, req, meta, lock_token, chat_key, req_key, parent, first_byte, wait_ms, work_ms, work_start, wait_start) VALUES (?, ?, 'queued', ?, ?, 0, 0, 0, 0, ?, '', ?, ?, NULL, NULL, NULL, NULL, 0, 0, 0, 0, ?)`,
      [id, kind, now, now, openLen, JSON.stringify(parsed), JSON.stringify(meta), now]);
    if (openLen) {
      try { await runSQL(env, `INSERT INTO chunks (job, seq, bytes, data) VALUES (?, 0, ?, ?)`, [id, openLen, openChunk]); } catch (_) {}
    }
  } catch (_) {
    try { await invalidateSchema(env); } catch (_) {}
    const hdrs2 = new Headers(upstream.headers);
    for (const k in CORS) hdrs2.set(k, CORS[k]);
    return new Response(upstream.body, { status: upstream.status, headers: hdrs2 });
  }
  if (fwd.authorization) {
    try { await runSQL(env, `INSERT INTO secrets (job, auth) VALUES (?, ?)`, [id, fwd.authorization]); } catch (_) {}
  }
  try { ctx && ctx.waitUntil && ctx.waitUntil(prune(env).catch(() => {})); } catch (_) {}

  const live = liveFor(id);
  const headers = relayHeaders(contentType, id);
  try { ctx && ctx.waitUntil && ctx.waitUntil(driveJob(env, ctx, id, { firstUpstream: upstream || null }).catch(() => {})); } catch (_) {}
  return new Response(liveSubscriber(live, 0), { status: 200, headers });
}

async function handleJobGet(url, ctx, env) {
  const id = url.pathname.split("/")[2];
  const offset = Math.max(0, Number(url.searchParams.get("offset") || 0) || 0);
  /* v12: NEVER answer 404 just because this isolate's schema view is bad —
     the job EXISTS on the other side of a D1 hiccup, and the app reads 404
     as "job gone → give up instantly" (the instant "Connection failed").
     Try the self-heal, try the read, and answer 503 (retryable) when D1
     itself fails. 404 is reserved for a row that is genuinely absent. */
  let job = null, sqlErr = null;
  if (hasDB(env)) {
    try { await ensureSchema(env); } catch (_) {}
    try { job = await getJobRow(env, id); } catch (err) { sqlErr = err; }
  }
  if (sqlErr) return json({ error: "job lookup failed on the database (the job keeps running — retry is safe)", retry: true }, 503);
  if (!job) return json({ error: "job not found (expired or relay restarted)" }, 404);
  maybeWorkAny(env, ctx); // a live-cast reader just attached — drive due work now
  /* v13: the D1-polling tail is the ONLY delivery path. The old in-isolate
     live fast-path (liveSubscriber) was retired: it closed the client's
     stream whenever the pump gave up its inline attempt budget — while the
     job was still queued — which the app correctly read as a truncated
     response ("cut off before it finished, status 0"). The D1 tail only
     closes on justified ends, and every byte it sends comes from the chunk
     log, so cross-isolate reconnects stay byte-exact by construction. */
  return new Response(tailStream(env, ctx, id, offset), { status: 200, headers: relayHeaders(job.meta.contentType, id, { "X-Nexus-Offset": String(job.bytes) }) });
}

/* honest job status — the app's wait monitor + timing chips read this */
async function handleJobStatus(url, ctx, env) {
  const id = url.pathname.split("/")[2];
  /* v12: same rule as /job/:id — a D1 failure answers 503 (the app's poll
     falls back to local elapsed), never a lying 404 */
  let job = null, sqlErr = null;
  if (hasDB(env)) {
    try { await ensureSchema(env); } catch (_) {}
    try { job = await getJobRow(env, id); } catch (err) { sqlErr = err; }
  }
  if (sqlErr) return json({ error: "status lookup failed on the database", retry: true }, 503);
  if (!job) return json({ error: "job not found (expired or relay restarted)", gone: true }, 404);
  maybeWorkAny(env, ctx); // the app polls this while waiting — progress resumes NOW
  const now = Date.now();
  /* v14: the true wait/work split — WAIT is line time, WORK is the model
     actively streaming on an accepted attempt (see liveWaitWork) */
  const tw = liveWaitWork(job, now);
  const running = !["done", "failed", "stopped", "parked"].includes(job.status);
  const out = {
    ok: true, id: job.id, jobId: job.id, kind: job.kind, status: job.status,
    attempts: job.attempts, waitedMs: tw.waitedMs, workMs: tw.workMs, bytes: job.bytes,
    working: tw.working, waiting: running && !tw.working,
    nextRetryAt: running ? job.nextRetry : 0,
    serverTools: !!(job.meta && job.meta.serverTools),
    serverRounds: Number(job.meta && job.meta.serverRounds) || 0,
    createdAt: job.createdAt, updatedAt: job.updatedAt, v: WORKER_VERSION,
  };
  if (job.meta && job.meta.retry) {
    out.retryMode = String(job.meta.retry.mode || "");
    out.retryLabel = String(job.meta.retry.label || "");
    out.retryMax = Number(job.meta.retry.max) || 0;
  }
  if (job.meta && job.meta.error) out.error = job.meta.error;
  return json(out);
}

/* rediscovery: the newest job for a chat key (X-Nexus-Chat on submit) */
async function handleJobByKey(url, ctx, env) {
  const key = sanitizeKey(decodeURIComponent(url.pathname.split("/")[3] || ""));
  if (!key) return json({ error: "missing key" }, 400);
  /* v12: D1 failure → 503 (the app retries rediscovery), never a lying 404 */
  let rows = null;
  if (hasDB(env)) {
    try { await ensureSchema(env); } catch (_) {}
    try {
      rows = await allSQL(env, `SELECT id, kind, status, bytes, created_at FROM jobs WHERE chat_key = ? ORDER BY created_at DESC LIMIT 8`, [key]);
    } catch (err) { return json({ error: "key lookup failed on the database", retry: true }, 503); }
  } else {
    return json({ error: "no job for this key (passthrough mode)" }, 404);
  }
  maybeWorkAny(env, ctx); // a returning app just asked — drive due work now
  const now = Date.now();
  for (const r of rows) {
    const age = now - Number(r.created_at);
    const st = String(r.status);
    if (["queued", "streaming", "parked"].includes(st) && age < JOB_TTL_MS) {
      return json({ ok: true, jobId: r.id, id: r.id, kind: r.kind, status: st, bytes: Number(r.bytes) });
    }
    if (st === "done" && age < DONE_TTL_MS) {
      return json({ ok: true, jobId: r.id, id: r.id, kind: r.kind, status: st, bytes: Number(r.bytes) });
    }
    if ((st === "failed" || st === "stopped") && age < 120000) {
      return json({ ok: true, jobId: r.id, id: r.id, kind: r.kind, status: st, bytes: Number(r.bytes) });
    }
  }
  return json({ error: "no job for this key" }, 404);
}

async function handleDelete(url, env) {
  const id = url.pathname.split("/")[2];
  const live = liveMap.get(id);
  if (live) liveAbort(live);
  if (jobEngineOk(env)) {
    /* stop the spend AND settle the meters (v14): mark cancelled (running
       pumps lose their lock on the next flush and self-terminate); rows are
       pruned by TTL shortly after */
    try { await stopJobRows(env, [id]); } catch (_) {}
  }
  return json({ ok: true });
}

/* =====================================================================
   v13+v14: WORKER REQUESTS — the monitoring surface for the app's Settings
   panel ("see all current worker requests, cancel/stop them, remove the
   finished ones, pick the retry pace while one waits").
   GET    /jobs        → newest 40 jobs with honest progress fields
   DELETE /jobs        → stop every non-terminal job (the panel's "Stop all")
   DELETE /jobs/:id    → remove a FINISHED job's rows (v14)
   POST   /jobs/clear  → remove every finished job (v14)
   POST   /job/:id/retry-mode → change a waiting job's pace (v14)
   All require an Authorization header — the same Bearer every /chat call
   carries. It is a casual-scan guard, not real auth (the worker cannot
   verify the key without spending a subrequest; job ids stay unguessable
   UUIDs and full buffers are only readable per-id).
   No D1 → 404 with an honest hint (the app's panel shows its upgrade note).
   D1 failure → 503 retryable, same rule as /job/:id.
   ===================================================================== */
const JOBS_LIST_CAP = 40;
function previewFromReq(reqText) {
  try {
    const req = JSON.parse(reqText || "");
    const msgs = Array.isArray(req && req.messages) ? req.messages : [];
    const model = req && typeof req.model === "string" ? req.model : "";
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m && m.role === "user") {
        let t = typeof m.content === "string" ? m.content : "";
        if (!t && Array.isArray(m.content)) t = (m.content.find(p => p && p.type === "text") || {}).text || "";
        t = String(t || "").replace(/\s+/g, " ").trim();
        return { model, preview: t.slice(0, 70) };
      }
    }
    return { model, preview: "" };
  } catch (_) { return { model: "", preview: "" }; }
}
async function handleJobsList(request, ctx, env) {
  if (!request.headers.get("authorization")) {
    return json({ error: "send your API key as the Authorization header (same as /chat)" }, 401);
  }
  if (!hasDB(env)) {
    return json({ error: "job listing needs the job engine (bind a D1 database as DB)", needsEngine: true }, 404);
  }
  try { await ensureSchema(env); } catch (_) {}
  let rows, sqlErr = null;
  try {
    rows = await allSQL(env, `SELECT id, kind, status, created_at, updated_at, attempts, finish, bytes, first_byte, chat_key, req, meta, heartbeat, next_retry, wait_ms, work_ms, work_start, wait_start FROM jobs ORDER BY created_at DESC LIMIT ?`, [JOBS_LIST_CAP]);
  } catch (err) { sqlErr = err; }
  /* same rule as /job/:id: a D1 failure (even a total one) answers 503
     retryable — the app's panel re-polls; 404 means "no engine" only */
  if (sqlErr) return json({ error: "job listing failed on the database", retry: true }, 503);
  maybeWorkAny(env, ctx); // the panel is watching — drive due work while it is
  const now = Date.now();
  let active = 0;
  const jobs = (rows || []).map(r => {
    const born = Number(r.created_at);
    const upd = Number(r.updated_at);
    const st = String(r.status);
    const done = st === "done";
    const running = !done && st !== "failed" && st !== "stopped" && st !== "parked";
    if (running) active++;
    const { model, preview } = previewFromReq(r.req);
    let error = "";
    let retryMode = "", retryLabel = "", retryMax = 0;
    let serverRounds = 0, serverTools = false;
    try {
      const meta = r.meta ? JSON.parse(r.meta) : null;
      if (meta) {
        if (meta.error) error = String(meta.error);
        if (meta.retry) {
          retryMode = String(meta.retry.mode || "");
          retryLabel = String(meta.retry.label || "");
          retryMax = Number(meta.retry.max) || 0;
        }
        serverRounds = Number(meta.serverRounds) || 0; // v15: rounds the WORKER executed
        serverTools = !!meta.serverTools;
      }
    } catch (_) {}
    /* v14: the true wait/work split from the meters (line time vs the model
       actively streaming) — a finished job reports the time it SPENT
       WORKING, not how long ago it ended */
    const tw = liveWaitWork({
      status: st, createdAt: born, updatedAt: upd,
      heartbeat: Number(r.heartbeat) || 0, firstByte: Number(r.first_byte) || 0,
      waitMs: Number(r.wait_ms) || 0, workMs: Number(r.work_ms) || 0,
      waitStart: Number(r.wait_start) || 0, workStart: Number(r.work_start) || 0,
    }, now);
    return {
      id: r.id, kind: String(r.kind), status: st, running,
      attempts: Number(r.attempts), bytes: Number(r.bytes), finish: !!Number(r.finish),
      waitedMs: tw.waitedMs, workMs: tw.workMs,
      working: running && tw.working, waiting: running && !tw.working,
      nextRetryAt: running ? (Number(r.next_retry) || 0) : 0,
      retryMode, retryLabel, retryMax,
      serverTools, serverRounds,
      createdAt: born, updatedAt: upd, chatKey: String(r.chat_key || ""),
      model, preview, error,
    };
  });
  return json({ ok: true, v: WORKER_VERSION, now, active, total: jobs.length, jobs });
}
async function handleJobsDelete(request, env) {
  if (!request.headers.get("authorization")) {
    return json({ error: "send your API key as the Authorization header (same as /chat)" }, 401);
  }
  if (!hasDB(env)) {
    return json({ error: "job listing needs the job engine (bind a D1 database as DB)", needsEngine: true }, 404);
  }
  try { await ensureSchema(env); } catch (_) {}
  let stopped = 0;
  try {
    const r = await allSQL(env, `SELECT id FROM jobs WHERE status IN ('queued','streaming')`);
    stopped = (r || []).length;
    for (const row of r || []) {
      const live = liveMap.get(row.id);
      if (live) liveAbort(live);
    }
    await stopJobRows(env, (r || []).map(x => x.id));
  } catch (err) {
    return json({ error: "stop-all failed on the database", retry: true }, 503);
  }
  return json({ ok: true, stopped });
}

/* v14: remove ONE finished request from the panel — its rows (job + chunk
   log + secret) are deleted outright. Only terminal jobs qualify: a
   running one must be stopped first (the panel offers Stop for those). */
async function handleJobsRemoveOne(request, env) {
  if (!request.headers.get("authorization")) {
    return json({ error: "send your API key as the Authorization header (same as /chat)" }, 401);
  }
  if (!hasDB(env)) {
    return json({ error: "job removal needs the job engine (bind a D1 database as DB)", needsEngine: true }, 404);
  }
  const id = new URL(request.url).pathname.split("/")[2];
  try { await ensureSchema(env); } catch (_) {}
  let row = null, sqlErr = null;
  try { row = await getSQL(env, `SELECT id, status FROM jobs WHERE id = ?`, [id]); } catch (err) { sqlErr = err; }
  if (sqlErr) return json({ error: "job lookup failed on the database", retry: true }, 503);
  if (!row) return json({ ok: true, removed: 0, v: WORKER_VERSION }); // already gone — idempotent
  if (["queued", "streaming"].includes(String(row.status))) {
    return json({ error: "still running — stop it first, then remove it", running: true }, 409);
  }
  const live = liveMap.get(id);
  if (live) liveClose(live); // no pump can live on a terminal row — tidy anyway
  try { await deleteJobRows(env, id); } catch (err) {
    return json({ error: "removal failed on the database", retry: true }, 503);
  }
  return json({ ok: true, removed: 1, v: WORKER_VERSION });
}

/* v14: remove EVERY finished request (the panel's "Clear finished") */
async function handleJobsClearFinished(request, env) {
  if (!request.headers.get("authorization")) {
    return json({ error: "send your API key as the Authorization header (same as /chat)" }, 401);
  }
  if (!hasDB(env)) {
    return json({ error: "job removal needs the job engine (bind a D1 database as DB)", needsEngine: true }, 404);
  }
  try { await ensureSchema(env); } catch (_) {}
  let ids = [];
  try {
    ids = (await allSQL(env, `SELECT id FROM jobs WHERE status IN ('done','failed','parked','stopped')`)).map(r => r.id);
  } catch (err) {
    return json({ error: "clear-finished failed on the database", retry: true }, 503);
  }
  let removed = 0;
  for (const id of ids) {
    try { await deleteJobRows(env, id); removed++; } catch (_) {}
  }
  return json({ ok: true, removed, v: WORKER_VERSION });
}

/* v14: change a waiting job's retry pace — the app's pace row in the chat
   bubble POSTs here while the job sits in the provider queue. The pump
   re-reads meta.retry while it sleeps, so a faster pick shortens the live
   countdown; a gentler one lands on the next attempt. */
async function handleJobRetryMode(request, env) {
  if (!request.headers.get("authorization")) {
    return json({ error: "send your API key as the Authorization header (same as /chat)" }, 401);
  }
  if (!hasDB(env)) {
    return json({ error: "retry pacing needs the job engine (bind a D1 database as DB)", needsEngine: true }, 404);
  }
  const id = new URL(request.url).pathname.split("/")[2];
  let body = null;
  try { body = await request.json(); } catch (_) {}
  const mode = String((body && body.mode) || "");
  const prof = retryModes()[mode];
  if (!prof) return json({ error: "unknown mode", modes: Object.keys(retryModes()) }, 400);
  try { await ensureSchema(env); } catch (_) {}
  let row = null, sqlErr = null;
  try { row = await getSQL(env, `SELECT id, status, meta, next_retry FROM jobs WHERE id = ?`, [id]); } catch (err) { sqlErr = err; }
  if (sqlErr) return json({ error: "lookup failed on the database", retry: true }, 503);
  if (!row) return json({ error: "job not found (expired or relay restarted)" }, 404);
  if (["done", "failed", "stopped", "parked"].includes(String(row.status))) {
    return json({ error: "this request already ended — its pace can't change anymore", ended: true }, 409);
  }
  let meta = {};
  try { meta = row.meta ? JSON.parse(row.meta) : {}; } catch (_) {}
  meta.retry = { mode, label: prof.label, max: prof.max, delays: prof.delays, at: Date.now() };
  try {
    await runSQL(env, `UPDATE jobs SET meta = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(meta), Date.now(), id]);
  } catch (err) {
    return json({ error: "pace change failed on the database", retry: true }, 503);
  }
  return json({ ok: true, id, mode, label: prof.label, max: prof.max, delays: prof.delays, nextRetryAt: Number(row.next_retry) || 0, v: WORKER_VERSION });
}

/* ---------- maintenance ---------- */
async function prune(env) {
  if (!jobEngineOk(env)) return;
  const now = Date.now();
  try {
    const dead = await allSQL(env,
      `SELECT id FROM jobs WHERE (status IN ('done','failed','parked','stopped') AND updated_at < ?) OR (created_at < ?)`,
      [now - DONE_TTL_MS, now - JOB_TTL_MS - DONE_TTL_MS]);
    for (const r of dead) await deleteJobRows(env, r.id);
    await runSQL(env,
      `UPDATE jobs SET status = 'failed', heartbeat = 0, lock_token = NULL, updated_at = ? WHERE status IN ('queued','streaming') AND created_at < ?`,
      [now, now - JOB_TTL_MS]);
    await runSQL(env, `DELETE FROM secrets WHERE job NOT IN (SELECT id FROM jobs)`);
    const total = await getSQL(env, `SELECT COUNT(*) AS n FROM jobs`);
    if (total && Number(total.n) > MAX_TOTAL_JOBS) {
      const old = await allSQL(env, `SELECT id FROM jobs WHERE status IN ('done','stopped','failed','parked') ORDER BY updated_at ASC LIMIT ?`, [Number(total.n) - MAX_TOTAL_JOBS]);
      for (const r of old) await deleteJobRows(env, r.id);
    }
    const n = await getSQL(env, `SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','streaming')`);
    if (n && Number(n.n) > MAX_ACTIVE_JOBS) {
      const old = await allSQL(env, `SELECT id FROM jobs WHERE status IN ('done','stopped') ORDER BY updated_at ASC LIMIT ?`, [Number(n.n) - MAX_ACTIVE_JOBS]);
      for (const r of old) await deleteJobRows(env, r.id);
    }
  } catch (_) {}
}

/* piggyback work: any incoming request can drive one due job in its own
   fresh execution context — this is what makes progress resume the
   instant the app reconnects, without waiting for the cron tick */
async function maybeWorkAny(env, ctx) {
  if (!jobEngineOk(env)) return;
  try {
    const now = Date.now();
    const r = await getSQL(env,
      `SELECT id FROM jobs WHERE status IN ('queued','streaming') AND next_retry <= ? AND heartbeat < ? ORDER BY next_retry ASC LIMIT 1`,
      [now, now - STALE_LOCK_MS]);
    if (r && r.id) {
      try { ctx && ctx.waitUntil && ctx.waitUntil(driveJob(env, ctx, r.id, { maxAttempts: 3, budgetMs: 90000 }).catch(() => {})); } catch (_) {}
    }
  } catch (_) {}
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (hasDB(env)) { try { await ensureSchema(env); } catch (_) {} }

    if (url.pathname === "/health") {
      let out;
      if (jobEngineOk(env)) {
        let cronAge = -1, active = 0;
        try { cronAge = Date.now() - (await wstateGet(env, "cron_beat") || 0); } catch (_) {}
        try { const n = await getSQL(env, `SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','streaming')`); active = n ? Number(n.n) : 0; } catch (_) {}
        out = { ok: true, relay: "nexus", v: WORKER_VERSION, d1: true, schemaOk: true, mode: "job engine (worker owns the request)", cronOk: cronAge >= 0 && cronAge < 3 * 60 * 1000, cronAgeMs: cronAge, active, time: Date.now() };
        if (!out.cronOk) out.setup = "add a Cron Trigger with schedule * * * * * (Settings → Triggers & Events) so jobs finish while your phone is off";
      } else if (hasDB(env)) {
        /* the D1 is bound but unusable — the relay is keeping chat alive in
           passthrough mode and keeps retrying the schema every 15s */
        out = { ok: true, relay: "nexus", v: WORKER_VERSION, d1: true, schemaOk: false, mode: "passthrough (D1 schema problem — chat still works; try Deploy again, or unbind and rebind the DB)", time: Date.now() };
      } else {
        out = { ok: true, relay: "nexus", v: WORKER_VERSION, d1: false, mode: "passthrough (bind D1 as DB for the background job engine)", time: Date.now(), setup: "create a D1 database and bind it with variable name DB (Settings → Bindings)" };
      }
      maybeWorkAny(env, ctx);
      return json(out);
    }

    if (request.method === "POST" && (url.pathname === "/chat" || url.pathname === "/images")) {
      try {
        return await handleProxy(request, url.pathname, ctx, env);
      } catch (err) {
        return json({ error: { message: "relay upstream failed: " + (err && err.message || String(err)), code: 502 } }, 502);
      }
    }
    if (request.method === "GET" && url.pathname === "/jobs") {
      return handleJobsList(request, ctx, env);
    }
    if (request.method === "DELETE" && url.pathname === "/jobs") {
      return handleJobsDelete(request, env);
    }
    /* v14: finished-request removal + waiting-pace control */
    if (request.method === "POST" && url.pathname === "/jobs/clear") {
      return handleJobsClearFinished(request, env);
    }
    if (request.method === "DELETE" && /^\/jobs\/[A-Za-z0-9-]+$/.test(url.pathname)) {
      return handleJobsRemoveOne(request, env);
    }
    if (request.method === "POST" && /^\/job\/[A-Za-z0-9-]+\/retry-mode$/.test(url.pathname)) {
      return handleJobRetryMode(request, env);
    }
    /* v15: the workspace mirror — push/pull/clear per chat */
    if (/^\/ws\/[A-Za-z0-9._:-]+$/.test(url.pathname) && ["GET", "POST", "DELETE"].includes(request.method)) {
      return handleWsSync(request, env);
    }
    if (request.method === "GET" && /^\/job\/by-key\/[A-Za-z0-9._:%-]+$/.test(url.pathname)) {
      return handleJobByKey(url, ctx, env);
    }
    if (request.method === "GET" && /^\/job\/[A-Za-z0-9-]+\/status$/.test(url.pathname)) {
      return handleJobStatus(url, ctx, env);
    }
    if (request.method === "GET" && /^\/job\/[A-Za-z0-9-]+$/.test(url.pathname)) {
      return handleJobGet(url, ctx, env);
    }
    if (request.method === "DELETE" && /^\/job\/[A-Za-z0-9-]+$/.test(url.pathname)) {
      return handleDelete(url, env);
    }
    return json({ error: "not found", hint: "use /chat (X-Nexus-Submit: 1), /job/:id?offset=N, /job/:id/status, /job/:id/retry-mode, /job/by-key/:key, /jobs, DELETE /jobs/:id, POST /jobs/clear, /ws/:chatKey (GET/POST/DELETE), /health" }, 404);
  },

  /* cron tick: heartbeat + prune + up to two jobs of real work */
  async scheduled(_event, env, ctx) {
    if (!hasDB(env)) return;
    try { await ensureSchema(env); } catch (_) { return; }
    if (!jobEngineOk(env)) return;
    try { await wstateSet(env, "cron_beat", Date.now()); } catch (_) {}
    try { await prune(env); } catch (_) {}
    const deadline = Date.now() + TICK_BUDGET_MS;
    for (let i = 0; i < 2; i++) {
      if (Date.now() > deadline - 15000) break;
      try {
        const now = Date.now();
        const r = await getSQL(env,
          `SELECT id FROM jobs WHERE status IN ('queued','streaming') AND next_retry <= ? AND heartbeat < ? ORDER BY next_retry ASC LIMIT 1`,
          [now, now - STALE_LOCK_MS]);
        if (!r || !r.id) break;
        await driveJob(env, ctx, r.id, { maxAttempts: 6, budgetMs: Math.max(30000, deadline - Date.now() - 10000) });
      } catch (_) {}
    }
    try { await wstateSet(env, "last_work", Date.now()); } catch (_) {}
  },
};

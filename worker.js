/* =====================================================================
   NEXUS BACKGROUND RELAY v12 — Cloudflare Worker
   THE WORKER OWNS THE REQUEST.
   =====================================================================
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

const WORKER_VERSION = 12;

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
const NEXUS_HEADERS = ["x-nexus-submit", "x-nexus-chat", "x-nexus-key", "x-nexus-parent"];

/* server-side continue protocol — the EXACT instruction the app sends,
   so worker retries and app continues are interchangeable */
const CONTINUE_INSTRUCTION = "Your previous answer was cut off by a connection drop. Continue exactly where you stopped. Do not repeat any text you already wrote, do not apologize, just continue the content seamlessly.";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, HTTP-Referer, X-Title, X-Nexus-Submit, X-Nexus-Chat, X-Nexus-Key, X-Nexus-Parent",
  "Access-Control-Expose-Headers": "X-Nexus-Job, X-Nexus-Offset, X-Nexus-Status",
  "Access-Control-Max-Age": "86400",
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
     first_byte INTEGER NOT NULL DEFAULT 0
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
  `ALTER TABLE chunks ADD COLUMN job TEXT`,
  `ALTER TABLE chunks ADD COLUMN seq INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE chunks ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE chunks ADD COLUMN data TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE secrets ADD COLUMN job TEXT`,
  `ALTER TABLE secrets ADD COLUMN auth TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE wstate ADD COLUMN k TEXT`,
  `ALTER TABLE wstate ADD COLUMN v TEXT NOT NULL DEFAULT ''`,
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
    { ins: `INSERT INTO jobs (id, kind, status, created_at, updated_at, heartbeat, next_retry, attempts, finish, bytes, content_text, req, meta, lock_token, chat_key, req_key, parent, first_byte) VALUES (?, 'chat', 'probe', 0, 0, 0, 0, 0, 0, 0, '', '{}', '{}', NULL, '', '', '', 0)`, del: `DELETE FROM jobs WHERE id = ?`, params: [pid] },
    { ins: `INSERT INTO chunks (job, seq, bytes, data) VALUES (?, 0, 0, '')`, del: `DELETE FROM chunks WHERE job = ?`, params: [pid] },
    { ins: `INSERT INTO secrets (job, auth) VALUES (?, 'probe')`, del: `DELETE FROM secrets WHERE job = ?`, params: [pid] },
    { ins: `INSERT INTO wstate (k, v) VALUES (?, '0')`, del: `DELETE FROM wstate WHERE k = ?`, params: [pid] },
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
  };
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
    finishSeen: false,
    errorSeen: false,
    errorMessage: "",
    errorCode: 0,
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
      if (raw === "[DONE]") { this.finishSeen = true; return; }
      let obj = null;
      try { obj = JSON.parse(raw); } catch (_) { return; }
      if (obj && obj.error) { this.errorSeen = true; this.errorMessage = String(obj.error.message || "upstream error"); this.errorCode = Number(obj.error.code) || 0; }
      const ch = obj && obj.choices && obj.choices[0];
      if (ch && ch.finish_reason) this.finishSeen = true;
      const d = ch && ch.delta;
      if (d) {
        if (typeof d.content === "string" && d.content.length) this.contentText += d.content;
        if (typeof d.reasoning === "string" && d.reasoning.length) this.sawReasoning = true;
        if (typeof d.reasoning_content === "string" && d.reasoning_content.length) this.sawReasoning = true;
        if (Array.isArray(d.tool_calls) && d.tool_calls.length) this.sawToolCalls = true;
      }
      this.eventIndex.push({ c: this.contentText.length, b: lineEndByte });
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
  if (parser.errorSeen && !job.finish) { await failJob(env, jobId, token, parser.errorMessage, { live }); return; }
  if (parser.finishSeen || job.finish) { await finalizeDone(env, jobId, token, live); return; }

  let totalBytes = Math.max(parser.totalBytes(), 0);
  let attempts = job.attempts;      // total across all drivers (persisted)
  let inlineAttempts = 0;           // attempts driven by THIS event
  const maxInline = opts.maxAttempts || 4;
  const deadline = Date.now() + (opts.budgetMs || EVENT_BUDGET_MS);
  let firstUpstream = opts.firstUpstream || null;
  let firstByteAt = job.firstByte || 0;

  let seq = 0;
  {
    const r = await getSQL(env, `SELECT COALESCE(MAX(seq), -1) AS mx FROM chunks WHERE job = ?`, [jobId]);
    seq = r ? Number(r.mx) + 1 : 0;
  }

  const flushDec = new TextDecoder();
  const flushEnc = new TextEncoder();
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
      };
      if (!firstByteAt && (parser.contentText.length > 0 || parser.sawReasoning)) {
        firstByteAt = Date.now();
        fields.first_byte = firstByteAt; // honest wait/work split for /status
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

      /* park: tool-call cuts are never continued server-side (app protocol).
         images never continue either — they re-issue from zero or park. */
      if (parser.sawToolCalls && !parser.finishSeen) { await parkJob(env, jobId, token); liveClose(live); return; }
      if (job.kind !== "chat" && totalBytes > 0 && !parser.finishSeen) { await parkJob(env, jobId, token); liveClose(live); return; }
      if (attempts >= MAX_ATTEMPTS) { await failJob(env, jobId, token, "retry budget used up", { live }); return; }

      /* ---- build the upstream request ---- */
      let body;
      if (job.kind !== "chat" || totalBytes === 0) body = job.req; // plain re-issue
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
        if (parser.errorSeen) { await failJob(env, jobId, token, parser.errorMessage, { live }); return; }
        if (parser.finishSeen) { await finalizeDone(env, jobId, token, live); return; }
        if (naturalEnd && job.kind !== "chat") { await finalizeDone(env, jobId, token, live); return; } // images: full body = done
        if (signal.aborted) return;
        /* truncated → persist the attempt count and try again inline
           (the lock is NOT released: fresh heartbeats prove we're alive,
           so no other driver can steal the job mid-run) */
        attempts++; inlineAttempts++;
        try { await lockWrite(env, jobId, token, { attempts, updated_at: Date.now() }); } catch (_) {}
        if (inlineAttempts >= maxInline) { gaveUp = true; break; }
        await sleep(backoffFor(attempts));
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
          { errorEvent: { message: message, code: status }, kind: job.kind, live });
        return;
      }
      if (fatal) { await parkJob(env, jobId, token); liveClose(live); return; }
      /* retryable: 429 / 408 / 5xx / network — re-request until it gets in */
      attempts++; inlineAttempts++;
      try { await lockWrite(env, jobId, token, { attempts, updated_at: Date.now() }); } catch (_) {}
      if (inlineAttempts >= maxInline) { gaveUp = true; break; }
      await sleep(backoffFor(attempts));
    }
  } finally {
    clearInterval(heart);
    try { await flush(); } catch (_) {}
    if (gaveUp) {
      /* release for the next driver (cron / piggyback / app reconnect) */
      await releaseJob(env, jobId, token, attempts);
      liveClose(live);
    }
  }
}

async function releaseJob(env, id, token, attempts) {
  const now = Date.now();
  try {
    await lockWrite(env, id, token, {
      heartbeat: 0, next_retry: now + backoffFor(attempts), attempts, updated_at: now, lock_token: null,
    });
  } catch (_) {}
}
async function finalizeDone(env, id, token, live) {
  const now = Date.now();
  try {
    await lockWrite(env, id, token, { status: "done", finish: 1, heartbeat: 0, updated_at: now, lock_token: null });
    await runSQL(env, `DELETE FROM secrets WHERE job = ?`, [id]);
  } catch (_) {}
  liveClose(live);
}
async function parkJob(env, id, token) {
  const now = Date.now();
  try {
    await lockWrite(env, id, token, { status: "parked", heartbeat: 0, updated_at: now, lock_token: null });
    await runSQL(env, `DELETE FROM secrets WHERE job = ?`, [id]);
  } catch (_) {}
}
async function failJob(env, id, token, reason, o = {}) {
  const now = Date.now();
  /* 1. bytes FIRST: when a pre-stream failure needs an error event, it must
     already be in the job buffer before the status flips to failed — a
     polling tail would otherwise close before the error chunk lands */
  if (o.errorEvent) {
    try { await appendErrorChunk(env, id, o.kind || "chat", o.errorEvent.message, o.errorEvent.code); } catch (_) {}
  }
  /* 2. status + honest reason in meta (so /job/:id/status can report it) */
  try {
    const row = await getJobRow(env, id);
    if (row) {
      const meta = row.meta || {};
      meta.error = String(reason).slice(0, 300);
      await lockWrite(env, id, token, { status: "failed", heartbeat: 0, updated_at: now, lock_token: null, meta: JSON.stringify(meta) });
    } else {
      await lockWrite(env, id, token, { status: "failed", heartbeat: 0, updated_at: now, lock_token: null });
    }
  } catch (_) {
    try { await lockWrite(env, id, token, { status: "failed", heartbeat: 0, updated_at: now, lock_token: null }); } catch (_) {}
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
      await runSQL(env, `UPDATE jobs SET status = 'stopped', heartbeat = 0, lock_token = NULL, updated_at = ? WHERE id = ? AND status IN ('queued','streaming')`, [Date.now(), parent]);
      await runSQL(env, `DELETE FROM secrets WHERE job = ?`, [parent]);
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
  await runSQL(env,
    `INSERT INTO jobs (id, kind, status, created_at, updated_at, heartbeat, next_retry, attempts, finish, bytes, content_text, req, meta, lock_token, chat_key, req_key, parent, first_byte) VALUES (?, ?, 'queued', ?, ?, 0, 0, 0, 0, 0, '', ?, ?, NULL, ?, ?, ?, 0)`,
    [id, kind, now, now, JSON.stringify(parsed), JSON.stringify(meta), chatKey, reqKey, parent]);
  if (fwd.authorization) {
    try { await runSQL(env, `INSERT INTO secrets (job, auth) VALUES (?, ?)`, [id, fwd.authorization]); } catch (_) {}
  }
  try { ctx && ctx.waitUntil && ctx.waitUntil(prune(env).catch(() => {})); } catch (_) {}
  try { ctx && ctx.waitUntil && ctx.waitUntil(driveJob(env, ctx, id).catch(() => {})); } catch (_) {}
  return json({ ok: true, jobId: id, v: WORKER_VERSION }, 202, { "X-Nexus-Job": id });
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
    try { await runSQL(env, `UPDATE jobs SET status = 'stopped', heartbeat = 0, updated_at = ? WHERE id = ? AND status IN ('queued','streaming')`, [now, id]); } catch (_) {}
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
          /* ---- replay phase ---- */
          const rows = await allSQL(env, `SELECT seq, bytes, data FROM chunks WHERE job = ? ORDER BY seq ASC`, [jobId]);
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
            const r = await getSQL(env, `SELECT status, bytes, heartbeat, created_at FROM jobs WHERE id = ?`, [jobId]);
            if (!r) { close(); return; }
            const status = r.status;
            const total = Number(r.bytes);
            if (total > pos || status === "done") {
              const rows2 = await allSQL(env, `SELECT seq, data FROM chunks WHERE job = ? AND seq > ? ORDER BY seq ASC`, [jobId, lastSeq]);
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
    await runSQL(env,
      `INSERT INTO jobs (id, kind, status, created_at, updated_at, heartbeat, next_retry, attempts, finish, bytes, content_text, req, meta, lock_token, chat_key, req_key, parent, first_byte) VALUES (?, ?, 'queued', ?, ?, 0, 0, 0, 0, 0, '', ?, ?, NULL, NULL, NULL, NULL, 0)`,
      [id, kind, now, now, JSON.stringify(parsed), JSON.stringify(meta)]);
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
  const live = liveFor(id);
  /* same-isolate live pump → zero-latency fan-out */
  if (live.hasPump && live.abortCtl && !live.abortCtl.signal.aborted) {
    return new Response(liveSubscriber(live, Math.min(offset, live.total)), { status: 200, headers: relayHeaders(job.meta.contentType, id, { "X-Nexus-Offset": String(live.total) }) });
  }
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
  const born = job.createdAt;
  const fb = job.firstByte;
  const done = job.status === "done";
  const running = !done && job.status !== "failed" && job.status !== "stopped";
  /* waitedMs = send → first real token; workMs = first token → end.
     While still waiting (queue, keepalives only) the whole span is wait. */
  const waitedMs = fb ? Math.max(0, fb - born) : (done ? 0 : Math.max(0, now - born));
  const workMs = fb
    ? Math.max(0, (running ? now : job.updatedAt) - fb)
    : (done ? Math.max(0, job.updatedAt - born) : 0);
  const out = {
    ok: true, id: job.id, jobId: job.id, kind: job.kind, status: job.status,
    attempts: job.attempts, waitedMs, workMs, bytes: job.bytes,
    createdAt: born, updatedAt: job.updatedAt, v: WORKER_VERSION,
  };
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
    /* stop the spend: mark cancelled (running pumps lose their lock on the
       next flush and self-terminate); rows are pruned by TTL shortly after */
    try { await runSQL(env, `UPDATE jobs SET status = 'stopped', heartbeat = 0, lock_token = NULL, updated_at = ? WHERE id = ?`, [Date.now(), id]); } catch (_) {}
    try { await runSQL(env, `DELETE FROM secrets WHERE job = ?`, [id]); } catch (_) {}
  }
  return json({ ok: true });
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
    return json({ error: "not found", hint: "use /chat (X-Nexus-Submit: 1), /job/:id?offset=N, /job/:id/status, /job/by-key/:key, /health" }, 404);
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

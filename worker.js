/* =====================================================================
   NEXUS BACKGROUND RELAY v4 — Cloudflare Worker (the durable job engine)
   =====================================================================
   THE MISSION: you send a prompt and walk away. THIS worker owns the
   request from that moment on. It keeps the generation running
   SERVER-SIDE in durable storage, re-requests the model until the
   answer is fully complete (even if OpenRouter is busy or down for
   minutes), and every time you reopen the app you get either live
   progress or the whole finished answer. Nothing depends on your phone
   being on, your screen being unlocked, or the app even being open.

   WHY v4 EXISTS (what v3 got wrong in real Cloudflare):
     v3 held jobs in worker MEMORY. Cloudflare tears down a request's
     execution context roughly 30 seconds after the client disconnects —
     the self-ping keepalive chain kept the ISOLATE warm, but the
     runtime still killed the running pump promise. Result: the stream
     you saw "while you were gone" died early, and the app reported the
     response as interrupted. Local tests never caught it because Bun
     (the test runtime) never kills promises.

   THE v4 FIX — durable state + fresh execution contexts:
     1. ALL job state lives in D1 (SQLite at the edge — strongly
        consistent; survives isolate recycling, worker redeploys, and
        full Cloudflare restarts). Every streamed byte is flushed to the
        job's chunk log while streaming.
     2. Generation happens in DISCRETE upstream attempts, not one
        fragile long-held connection. If an attempt is cut off (no
        [DONE] / finish_reason), the next driver re-asks the model with
        the app's exact CONTINUE protocol and appends the rest to the
        same job. If the upstream is busy/refusing, the worker
        re-requests on a backoff schedule "until it gets in".
     3. THREE DRIVERS keep jobs moving, each in a brand-new event
        context (so the ~30s teardown can't kill them mid-flight):
          - the request event itself (while you're watching),
          - a piggyback work pass on any incoming request (the moment
            your app reconnects or polls a job, progress resumes),
          - a Cron Trigger (every minute) — THIS is what works with
            your phone completely off.
     4. ATOMIC JOB CLAIMS: a driver may only take a job whose pump
        heartbeat went stale and whose retry backoff has elapsed. The
        conditional UPDATE is atomic in D1, so two racing drivers can
        never double-generate.
     5. ATTACH-ON-CONTINUE preserved: when the app sends its own
        continue request (…conversation, assistant partial, "continue"
        instruction) and a matching job is running or finished, the
        worker serves THAT job from the exact byte boundary — no second
        generation, no double spend. If the app is somehow AHEAD of the
        job buffer, the stale job is retired and a fresh generation
        continues from the app's (longer) partial.
     6. Tool-call cuts are PARKED, not continued server-side (mirrors
        the app's discard-partial-tools protocol — a half-written file
        must never be executed). The app finishes those on return via
        its own auto-resume, cleanly.

   WIRE PROTOCOL (what NexusAiPro.html speaks — unchanged from v3):
     POST {relay}/chat      → SSE stream + "X-Nexus-Job: <id>" header
     POST {relay}/images    → JSON + "X-Nexus-Job: <id>" header
     GET  {relay}/job/:id?offset=N → replay from byte N + live tail
                              (404/410 when gone → app auto-continues)
     GET  {relay}/health    → {"ok":true,"v":4,...}   ← deploy check
     DELETE {relay}/job/:id → free the job early

   SETUP / UPGRADE (~4 minutes, dashboard only — no local tools):
     1. Cloudflare dashboard → Workers & Pages → nexusaipro → Edit code
        → select all → paste this entire file → Deploy.
     2. Same worker → Settings → Bindings → Add → D1 database:
        create one (any name, e.g. nexus-jobs) → bind it with variable
        name EXACTLY: DB
     3. Same worker → Settings → Triggers & Events (Cron Triggers)
        → Add Cron Trigger → schedule EXACTLY:  * * * * *
        (every minute — this is what finishes answers while your phone
        is off)
     4. Open https://nexusaipro.kadharri-minecraft.workers.dev/health
        → it must say "v":4, "d1":true, "cronOk":true.
        The health output literally tells you which step is missing.

   AUTH NOTE (honest): the app's "Authorization: Bearer <OpenRouter key>"
   is required to re-request the model while you are away, so it is
   stored in YOUR OWN D1 database for the lifetime of that job only
   (minutes), and deleted the moment the job finishes, fails, is parked
   or is pruned. It is never logged, never returned by any endpoint.
   D1 is private to your Cloudflare account — the same trust boundary
   as the worker that already proxies that header. If you'd rather not,
   simply don't bind D1: the worker then runs as a plain passthrough
   relay (graceful degrade — nothing breaks, you just don't get the
   phone-off job engine).

   LIMITS (honest):
     - Unfinished jobs are worked for up to 30 minutes / 24 attempts,
       then marked failed (the app still auto-continues on return).
     - Finished jobs replay for 10 minutes, then are pruned.
     - 8 MB buffer cap per job (a normal response is < 1 MB).
     - Free plan: D1 + Cron Triggers are both included. Very long jobs
       may hit the free plan's per-request subrequest budget — the
       design degrades gracefully (the stream reconnects in a fresh
       context and work continues).
     - D1 must be bound as "DB" and the cron must be "* * * * *" for
       the full phone-off experience; /health reports both.
   ===================================================================== */

const WORKER_VERSION = 4;

/* test tunables — production reads defaults; the local harness may
   override via globalThis.__nexusTun to run E2E in seconds. */
function TUN(key, def) {
  const t = globalThis.__nexusTun;
  return t && Object.prototype.hasOwnProperty.call(t, key) ? t[key] : def;
}

const MAX_JOB_BYTES = TUN("maxJobBytes", 8 * 1024 * 1024);
const JOB_TTL_MS = TUN("jobTtlMs", 30 * 60 * 1000);
const DONE_TTL_MS = TUN("doneTtlMs", 10 * 60 * 1000);
const MAX_ATTEMPTS = TUN("maxAttempts", 24);
const RETRY_DELAYS = TUN("retryDelays", [1500, 3000, 6000, 10000, 15000, 20000]);
const UPSTREAM_STALL_MS = TUN("stallMs", 60 * 1000);
const STALE_LOCK_MS = TUN("staleLockMs", 26 * 1000);
const FLUSH_MS = TUN("flushMs", 8000);
const FLUSH_BYTES = TUN("flushBytes", 64 * 1024);
const TICK_BUDGET_MS = TUN("tickBudgetMs", 210 * 1000);
const EVENT_BUDGET_MS = TUN("eventBudgetMs", 10 * 60 * 1000);
const TAIL_POLL_FAST = TUN("tailPollFast", 500);
const TAIL_POLL_SLOW = TUN("tailPollSlow", 2000);
const MAX_ACTIVE_JOBS = 64;

const FWD_HEADERS = ["authorization", "content-type", "http-referer", "x-title", "accept"];

/* server-side continue protocol — the EXACT instruction the app sends,
   so worker retries and app continues are interchangeable */
const CONTINUE_INSTRUCTION = "Your previous answer was cut off by a connection drop. Continue exactly where you stopped. Do not repeat any text you already wrote, do not apologize, just continue the content seamlessly.";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, HTTP-Referer, X-Title",
  "Access-Control-Expose-Headers": "X-Nexus-Job",
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

/* =====================================================================
   D1 layer — the durable half of the engine.
   Uses ONLY prepare().bind().run()/all() (the portable subset), so the
   exact same worker file runs under the local Bun test harness with a
   bun:sqlite shim, and under real Cloudflare with real D1.
   ===================================================================== */
const SCHEMA_SQL = [
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
     lock_token TEXT
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
  `CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status, next_retry)`,
];

function hasDB(env) { return !!(env && env.DB); }

let schemaDone = false;
async function ensureSchema(env) {
  if (!hasDB(env) || schemaDone) return;
  for (const s of SCHEMA_SQL) await runSQL(env, s, []);
  schemaDone = true;
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
  const rows = await allSQL(env, sql, params);
  return rows.length ? rows[0] : null;
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
    finishSeen: false,
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
      const ch = obj && obj.choices && obj.choices[0];
      if (ch && ch.finish_reason) this.finishSeen = true;
      const d = ch && ch.delta;
      if (d) {
        if (typeof d.content === "string" && d.content.length) this.contentText += d.content;
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

/* =====================================================================
   Live registry — in-isolate fan-out for the client that is watching
   right now (zero D1 latency), plus the abort handle used by DELETE
   and by the local harness to simulate Cloudflare's context teardown.
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
   Runs inside whatever event claimed the job (POST /chat, a reconnect
   piggyback, or the cron tick). Every byte fans out to live subscribers
   AND flushes to D1, so the next driver can always pick up exactly
   where this one died.
   ===================================================================== */
async function driveJob(env, ctx, jobId, opts = {}) {
  if (!hasDB(env)) return;
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
  if (parser.finishSeen || job.finish) { await finalizeDone(env, jobId, token, live); return; }

  let totalBytes = Math.max(parser.totalBytes(), 0);
  let attempts = job.attempts;      // total across all drivers (persisted)
  let inlineAttempts = 0;           // attempts driven by THIS event
  const maxInline = opts.maxAttempts || 4;
  const deadline = Date.now() + (opts.budgetMs || EVENT_BUDGET_MS);
  let firstUpstream = opts.firstUpstream || null;

  let seq = 0;
  {
    const r = await getSQL(env, `SELECT COALESCE(MAX(seq), -1) AS mx FROM chunks WHERE job = ?`, [jobId]);
    seq = r ? Number(r.mx) + 1 : 0;
  }

  const flushDec = new TextDecoder();
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
    const byteLen = new TextEncoder().encode(text).length;
    try {
      await runSQL(env, `INSERT INTO chunks (job, seq, bytes, data) VALUES (?, ?, ?, ?)`, [jobId, seq, byteLen, text]);
      seq++;
      const w = await lockWrite(env, jobId, token, {
        bytes: totalBytes, content_text: parser.contentText,
        finish: parser.finishSeen ? 1 : 0,
        heartbeat: Date.now(), updated_at: Date.now(),
      });
      if (w !== 1) return false; // lock lost — another driver took over
    } catch (_) { return !signal.aborted; }
    lastFlushAt = Date.now();
    return true;
  };

  /* heartbeat while a slow first token takes its time — keeps other
     drivers from falsely claiming an alive-but-quiet pump */
  const heart = setInterval(() => {
    if (signal.aborted) return;
    lockWrite(env, jobId, token, { heartbeat: Date.now(), updated_at: Date.now() }).catch(() => {});
  }, Math.max(2000, Math.floor(FLUSH_MS / 2)));

  let gaveUp = false;
  try {
    while (true) {
      if (signal.aborted) return; // killed like the runtime would — leave D1 stale on purpose
      if (Date.now() > deadline) { gaveUp = true; break; }

      /* park: tool-call cuts are never continued server-side (app protocol).
         images never continue either — they re-issue from zero or park. */
      if (parser.sawToolCalls && !parser.finishSeen) { await parkJob(env, jobId, token); liveClose(live); return; }
      if (job.kind !== "chat" && totalBytes > 0 && !parser.finishSeen) { await parkJob(env, jobId, token); liveClose(live); return; }
      if (attempts >= MAX_ATTEMPTS) { await failJob(env, jobId, token, "retry budget used up"); liveClose(live); return; }

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
                  livePush(live, sep);
                  parser.feed(sep);
                  pendingFlush += "\n\n"; pendingBytes += 2;
                  totalBytes += 2;
                  lastByte = 0x0A;
                }
                separatorNeeded = false;
              }
              firstChunk = false;
              livePush(live, value);
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
  try {
    await lockWrite(env, id, token, { status: "failed", heartbeat: 0, updated_at: now, lock_token: null });
    await runSQL(env, `DELETE FROM secrets WHERE job = ?`, [id]);
  } catch (_) {}
  if (o.errorEvent && o.live) {
    /* tell a watching client what happened (an SSE error event for chat,
       error JSON for images) — never written into the job buffer */
    const payload = o.kind === "images"
      ? JSON.stringify({ error: { message: o.errorEvent.message, code: o.errorEvent.code } })
      : "data: " + JSON.stringify({ error: { message: o.errorEvent.message, code: o.errorEvent.code } }) + "\n\n";
    const u8 = new TextEncoder().encode(payload);
    for (const c of [...o.live.subs]) { try { c.enqueue(u8); } catch (_) {} }
    liveClose(o.live);
  }
}

/* =====================================================================
   ATTACH: the app's continue request meets a job we already hold
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
            if (Date.now() - Number(r.created_at) > JOB_TTL_MS) { close(); return; }
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

  /* no D1 (or an unparseable body) → plain passthrough (graceful degrade) */
  if (!hasDB(env) || !parsed) {
    const upstream = await fetch(upstreamBase(env) + (pathname === "/chat" ? "/chat/completions" : "/images"), {
      method: "POST", headers: headersFrom(fwd), body: rawBody,
      // @ts-ignore runtime-specific
      cf: { cacheTtl: 0 },
    });
    const hdrs = new Headers(upstream.headers);
    for (const k in CORS) hdrs.set(k, CORS[k]);
    return new Response(upstream.body, { status: upstream.status, headers: hdrs });
  }

  /* ATTACH: a continue request that matches a job we're already holding */
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

  /* attempt 0 — fatal 4xx passes straight through (v2 behavior: the app
     maps auth/path errors itself); retryable failures become a durable
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

  /* create the durable job */
  const id = crypto.randomUUID();
  const kind = pathname === "/images" ? "images" : "chat";
  const now = Date.now();
  const contentType = (upstream && upstream.headers.get("content-type")) || (kind === "images" ? "application/json" : "text/event-stream");
  const metaFwd = Object.assign({}, fwd);
  delete metaFwd.authorization;
  const meta = { fwd: metaFwd, contentType };
  await runSQL(env,
    `INSERT INTO jobs (id, kind, status, created_at, updated_at, heartbeat, next_retry, attempts, finish, bytes, content_text, req, meta, lock_token) VALUES (?, ?, 'queued', ?, ?, 0, 0, 0, 0, 0, '', ?, ?, NULL)`,
    [id, kind, now, now, JSON.stringify(parsed), JSON.stringify(meta)]);
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
  if (!hasDB(env)) return json({ error: "job not found (relay in passthrough mode)" }, 404);
  const id = url.pathname.split("/")[2];
  const offset = Math.max(0, Number(url.searchParams.get("offset") || 0) || 0);
  const job = await getJobRow(env, id);
  if (!job) return json({ error: "job not found (expired or relay restarted)" }, 404);
  if (job.status === "failed" || job.status === "stopped") return json({ error: "job ended (" + job.status + ")" }, 410);
  const live = liveFor(id);
  /* same-isolate live pump → zero-latency fan-out */
  if (live.hasPump && live.abortCtl && !live.abortCtl.signal.aborted) {
    return new Response(liveSubscriber(live, Math.min(offset, live.total)), { status: 200, headers: relayHeaders(job.meta.contentType, id, { "X-Nexus-Offset": String(live.total) }) });
  }
  return new Response(tailStream(env, ctx, id, offset), { status: 200, headers: relayHeaders(job.meta.contentType, id, { "X-Nexus-Offset": String(job.bytes) }) });
}

async function handleDelete(url, env) {
  const id = url.pathname.split("/")[2];
  const live = liveMap.get(id);
  if (live) { liveAbort(live); liveMap.delete(id); }
  if (hasDB(env)) { try { await deleteJobRows(env, id); } catch (_) {} }
  return json({ ok: true });
}

/* ---------- maintenance ---------- */
async function prune(env) {
  if (!hasDB(env)) return;
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
  if (!hasDB(env)) return;
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
      if (hasDB(env)) {
        let cronAge = -1, active = 0;
        try { cronAge = Date.now() - (await wstateGet(env, "cron_beat") || 0); } catch (_) {}
        try { const n = await getSQL(env, `SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','streaming')`); active = n ? Number(n.n) : 0; } catch (_) {}
        out = { ok: true, relay: "nexus", v: WORKER_VERSION, d1: true, mode: "job engine", cronOk: cronAge >= 0 && cronAge < 3 * 60 * 1000, cronAgeMs: cronAge, active, time: Date.now() };
        if (!out.cronOk) out.setup = "add a Cron Trigger with schedule * * * * * (Settings → Triggers & Events) so jobs finish while your phone is off";
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
    if (request.method === "GET" && /^\/job\/[A-Za-z0-9-]+$/.test(url.pathname)) {
      return handleJobGet(url, ctx, env);
    }
    if (request.method === "DELETE" && /^\/job\/[A-Za-z0-9-]+$/.test(url.pathname)) {
      return handleDelete(url, env);
    }
    return json({ error: "not found", hint: "use /chat, /images, /job/:id?offset=N, /health" }, 404);
  },

  /* cron tick: heartbeat + prune + up to two jobs of real work */
  async scheduled(_event, env, ctx) {
    if (!hasDB(env)) return;
    try { await ensureSchema(env); } catch (_) { return; }
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

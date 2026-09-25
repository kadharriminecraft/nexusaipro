/* =====================================================================
   NEXUS BACKGROUND RELAY v3 — Cloudflare Worker (the request holder)
   =====================================================================
   THE MISSION (v3): once the app sends a prompt, THIS worker owns the
   whole request. It starts the upstream immediately, keeps streaming
   SERVER-SIDE even after you close the app, auto-retries the upstream
   when it gets cut off, and finishes the response into its buffer on
   its own. Every time you reopen the app, it re-attaches by byte offset
   and shows the latest thinking / answer / file-writing progress.

   WHAT CHANGED IN v3 (over v2):
     1. SERVER-SIDE AUTO-RETRY — if OpenRouter's stream dies mid-answer
        (no finish_reason / no [DONE]), the worker ITSELF re-asks the
        model to "continue exactly where you stopped" and appends the
        result to the same job. This happens with or without the app
        connected. Tool-call cuts are NOT retried server-side (the app
        protocol discards half-written tools and re-asks — v3 mirrors
        that instead of corrupting the stream).
     2. ATTACH-ON-CONTINUE — when the app sends its own continue request
        (…conversation, assistant partial, "continue" instruction) and a
        matching job is still running or already finished, the worker
        does NOT start a second generation. It serves the matching job
        from the exact byte boundary of the app's partial — zero double
        token spend, seamless continuation.
     3. KEEPALIVE CHAIN — while a job runs, the worker pings itself
        every 20s (up to 15 min) so the isolate stays warm and the job
        keeps making progress with the app closed. If the runtime tears
        down the pump anyway, the next ping (or the app's reconnect)
        REVIVES it from wherever the buffer stopped.
     4. LONGER RETENTION — unfinished jobs live 30 min, finished jobs
        10 min, so late reopens still replay.
     5. UPSTREAM STALL WATCHDOG — a hung upstream (60s no bytes) is
        aborted and retried instead of freezing the job forever.

   Everything from v2 still works: /chat → /api/v1/chat/completions path
   mapping, SSE mirroring + byte-offset replay via /job/:id, /images,
   optional NEXUS_UPSTREAM_BASE, optional NEXUS_KV snapshots.

   WIRE PROTOCOL (what NexusAiPro.html speaks — unchanged):
     POST {relay}/chat      → SSE stream + "X-Nexus-Job: <id>" header
     POST {relay}/images    → JSON + "X-Nexus-Job: <id>" header
     GET  {relay}/job/:id?offset=N → replay from byte N + live tail
                              (404/410 when gone → app auto-continues)
     GET  {relay}/health    → {"ok":true,"v":3}   ← deploy check
     DELETE {relay}/job/:id → free the job early

   AUTH: the client's "Authorization: Bearer <OpenRouter key>" is kept
   in VOLATILE worker memory for the lifetime of a running job (needed
   for server-side retries while you are away). Never logged, never
   written to KV, dropped with the job.

   SETUP / UPGRADE (~2 minutes, code only — no secrets, no config):
     1. Cloudflare dashboard → Workers & Pages → nexusaipro → Edit code
     2. Select all → paste this entire file → Deploy
     3. Visit https://nexusaipro.kadharri-minecraft.workers.dev/health
        → it must say "v":3. Your worker URL does not change.

   LIMITS (honest):
     - Jobs live in worker memory (per isolate). Cloudflare recycles
       isolates eventually; the keepalive chain stretches that window to
       minutes-to-quarters-of-an-hour. For multi-hour gaps use the app's
       auto-resume (it re-asks the model with the partial — nothing is
       ever lost) or bind a KV namespace as NEXUS_KV.
     - 32 MB buffer cap per job (a normal response is well under 1 MB).
     - Free plan: 100k requests/day. A chat message = 1 POST + a few
       GETs; the keepalive chain adds ~3 requests/minute while a job is
       running with nobody attached.
   ===================================================================== */

const WORKER_VERSION = 3;

const MAX_JOB_BYTES = 32 * 1024 * 1024;    // 32MB buffer cap per job
const JOB_TTL_MS = 30 * 60 * 1000;         // sweep unfinished jobs older than 30 min
const DONE_IDLE_MS = 10 * 60 * 1000;       // sweep finished jobs idle 10 min
const KV_TTL = 3600;                       // seconds
const MAX_JOBS = 128;
const FWD_HEADERS = ["authorization", "content-type", "http-referer", "x-title", "accept"];

/* server-side continue protocol — the EXACT instruction the app sends,
   so worker retries and app continues are interchangeable */
const CONTINUE_INSTRUCTION = "Your previous answer was cut off by a connection drop. Continue exactly where you stopped. Do not repeat any text you already wrote, do not apologize, just continue the content seamlessly.";

const MAX_SERVER_RETRIES = 5;
const RETRY_DELAYS = [300, 600, 1200, 2400, 4800];
const UPSTREAM_STALL_MS = 60 * 1000;       // no bytes for 60s → abort + retry
const ZOMBIE_PUMP_MS = 25 * 1000;          // pumping but silent → revive
const KEEPALIVE_INTERVAL_MS = 20 * 1000;   // self-ping while jobs run
const KEEPALIVE_MAX_MS = 15 * 60 * 1000;   // self-ping window per job

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, HTTP-Referer, X-Title",
  "Access-Control-Expose-Headers": "X-Nexus-Job",
  "Access-Control-Max-Age": "86400",
};

/* job registry — module scope persists for the isolate's lifetime.
   globalThis guard survives module re-evaluation. */
const jobs = globalThis.__nexusJobs || (globalThis.__nexusJobs = new Map());

const sleep = ms => new Promise(r => setTimeout(r, ms));

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS, ...headers } });
}

/* ---------- upstream base/path (v2 fix preserved) ---------- */
function upstreamBase(env) {
  return ((env && env.NEXUS_UPSTREAM_BASE) || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
}
function upstreamPath(pathname) {
  if (pathname === "/chat") return "/chat/completions";
  if (pathname === "/images") return "/images";
  return pathname;
}
function headersFrom(fwd) {
  const h = new Headers();
  for (const k of FWD_HEADERS) { const v = fwd && fwd[k]; if (v) h.set(k, v); }
  if (!h.has("content-type")) h.set("content-type", "application/json");
  return h;
}

/* ---------- lifecycle ---------- */
function killJob(id, job) {
  job.gone = true;
  try { job.currentAbort && job.currentAbort.abort(); } catch (_) {}
  for (const c of [...job.subs]) { try { c.close(); } catch (_) {} }
  job.subs.clear();
  jobs.delete(id);
}
function sweep() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.gone) { jobs.delete(id); continue; }
    if (job.done && now - job.lastTouch > DONE_IDLE_MS) { killJob(id, job); continue; }
    if (!job.done && now - job.createdAt > JOB_TTL_MS) { killJob(id, job); continue; }
  }
  if (jobs.size > MAX_JOBS) {
    const doneJobs = [...jobs.values()].filter(j => j.done).sort((a, b) => a.lastTouch - b.lastTouch);
    for (let i = 0; i < doneJobs.length && jobs.size > MAX_JOBS; i++) killJob(doneJobs[i].id, doneJobs[i]);
  }
}

/* ---------- buffer helpers (byte-exact, from v2) ---------- */
function bufferedFrom(job, offset) {
  if (offset >= job.total) return new Uint8Array(0);
  const out = new Uint8Array(job.total - offset);
  let pos = 0, written = 0;
  for (const c of job.chunks) {
    if (pos + c.length <= offset) { pos += c.length; continue; }
    const skip = Math.max(0, offset - pos);
    out.set(c.subarray(skip), written);
    written += c.length - skip;
    pos += c.length;
  }
  return out;
}
function concatChunks(job) {
  const out = new Uint8Array(job.total);
  let off = 0;
  for (const c of job.chunks) { out.set(c, off); off += c.length; }
  return out;
}

/* ---------- incremental SSE parse (feeds contentText + event index) ----------
   Tracks, per data event: cumulative content length → byte offset AFTER
   the event's newline. That index is what lets ATTACH resume a continue
   request at the exact byte boundary matching the app's partial text.
   UTF-8 safe: 0x0A bytes and decoded "\n" chars correspond 1:1. */
function handleDataLine(job, line, lineEndByte) {
  if (!line) return;
  const s = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (!s.startsWith("data:")) return; // SSE comments / keep-alive pings
  const raw = s.slice(5).trim();
  if (!raw) return;
  if (raw === "[DONE]") { job.finishSeen = true; return; }
  let obj = null;
  try { obj = JSON.parse(raw); } catch (_) { return; }
  const ch = obj && obj.choices && obj.choices[0];
  if (ch && ch.finish_reason) job.finishSeen = true; // stop | tool_calls | length | …
  const d = ch && ch.delta;
  if (d) {
    if (typeof d.content === "string" && d.content.length) job.contentText += d.content;
    if (Array.isArray(d.tool_calls) && d.tool_calls.length) job.sawToolCalls = true;
  }
  job.eventIndex.push({ c: job.contentText.length, b: lineEndByte });
}
function feedParse(job, u8) {
  const p = job.parse;
  const text = p.decoder.decode(u8, { stream: true });
  const nl = [];
  for (let i = 0; i < u8.length; i++) if (u8[i] === 0x0A) nl.push(i);
  const lines = text.split("\n"); // lines.length === nl.length + 1
  let line = p.pending + lines[0];
  for (let i = 0; i < nl.length; i++) {
    const lineEndByte = p.chunkStartByte + nl[i] + 1;
    handleDataLine(job, line, lineEndByte);
    p.lineStartByte = lineEndByte;
    line = lines[i + 1];
  }
  p.pending = line;
  p.chunkStartByte += u8.length;
}
/* byte offset right after the event where cumulative content == len */
function boundaryFor(job, contentLen) {
  if (contentLen <= 0) return 0;
  const idx = job.eventIndex;
  for (let i = idx.length - 1; i >= 0; i--) if (idx[i].c === contentLen) return idx[i].b;
  return -1;
}

/* ---------- server-side continue ---------- */
function buildContinueBody(job) {
  const messages = (job.reqBody && job.reqBody.messages ? job.reqBody.messages.slice() : [])
    .concat([{ role: "assistant", content: job.contentText }, { role: "user", content: CONTINUE_INSTRUCTION }]);
  const body = Object.assign({}, job.reqBody, { messages, stream: true });
  return body;
}

/* ---------- the pump: streams upstream → buffer + subscribers, forever ----------
   One loop per job. Survives client disconnects (ctx.waitUntil), retries
   truncated upstreams, and can be revived by maybeRekick after the runtime
   tears down its context. Generation tokens (pumpGen) make revivals safe —
   an orphaned old loop quietly stops instead of double-pumping. */
function pumpLoop(job, ctx, env, firstUpstream) {
  const gen = (job.pumpGen = (job.pumpGen || 0) + 1);
  job.pumping = true;
  const run = (async () => {
    let upstream = firstUpstream;
    const wd = setInterval(() => {
      if (job.pumpGen !== gen) return;
      if (Date.now() - (job.lastPumpBeat || 0) > UPSTREAM_STALL_MS) {
        try { job.currentAbort && job.currentAbort.abort(); } catch (_) {}
      }
    }, 5000);
    try {
      while (!job.finishSeen && !job.gone) {
        if (job.pumpGen !== gen) return;
        if (!upstream) {
          if (job.kind !== "chat") break;           // images: single JSON, no retry
          if (job.sawToolCalls) break;              // app protocol: partial tools are discarded client-side, never re-fed
          if (job.total > 0 && job.retries >= MAX_SERVER_RETRIES) break;
          let body;
          if (job.total === 0) body = job.reqBody;  // nothing received yet → plain re-issue
          else { job.retries++; body = buildContinueBody(job); }
          job.lastPumpBeat = Date.now();
          await sleep(RETRY_DELAYS[Math.min(job.retries, RETRY_DELAYS.length - 1)]);
          if (job.pumpGen !== gen) return;
          const ac = new AbortController();
          job.currentAbort = ac;
          try {
            upstream = await fetch(upstreamBase(env) + "/chat/completions", {
              method: "POST", headers: headersFrom(job.fwd), body: JSON.stringify(body), signal: ac.signal,
              // @ts-ignore runtime-specific
              cf: { cacheTtl: 0 },
            });
          } catch (_) { job.currentAbort = null; upstream = null; continue; }
          if (!upstream.ok || !upstream.body) {
            try { upstream.body && upstream.body.cancel(); } catch (_) {}
            job.currentAbort = null; upstream = null; continue;
          }
        }
        job.lastPumpBeat = Date.now();
        try {
          await streamIntoBuffer(job, upstream.body);
          upstream = null;
        } catch (_) { upstream = null; }            // aborted / died → retry path
        job.currentAbort = null;
      }
      if (job.pumpGen === gen) job.done = true;
    } finally {
      clearInterval(wd);
      if (job.pumpGen === gen) {
        job.pumping = false;
        for (const c of [...job.subs]) { try { c.close(); } catch (_) {} }
        job.subs.clear();
        kvSnapshot(job, env);
      }
    }
  })();
  ctx && ctx.waitUntil && ctx.waitUntil(run.catch(() => {}));
}

async function streamIntoBuffer(job, body) {
  const reader = body.getReader();
  try {
    while (true) {
      const readP = reader.read().then(r => r, () => ({ done: true }));
      const res = await readP; // aborts surface as done/reject via the fetch signal
      if (res.done) break;
      const value = res.value;
      if (value && value.length) {
        job.lastPumpBeat = Date.now();
        job.lastTouch = job.lastPumpBeat;
        if (job.total + value.length > MAX_JOB_BYTES) {
          job.overflow = true; // stop buffering, keep fanning out live
        } else {
          job.chunks.push(value);
          job.total += value.length;
          feedParse(job, value);
        }
        for (const c of [...job.subs]) {
          try { c.enqueue(value); } catch (_) { job.subs.delete(c); }
        }
      }
    }
  } finally {
    try { reader.releaseLock && reader.releaseLock(); } catch (_) {}
  }
}

async function kvSnapshot(job, env) {
  if (!(env && env.NEXUS_KV) || job.overflow || job.total === 0 || job.total > 5 * 1024 * 1024) return;
  try {
    const body = concatChunks(job);
    await env.NEXUS_KV.put("job:" + job.id, body, { expirationTtl: KV_TTL });
    await env.NEXUS_KV.put("meta:" + job.id, JSON.stringify({ done: true, finishSeen: !!job.finishSeen, contentType: job.contentType, bytes: job.total, kind: job.kind }), { expirationTtl: KV_TTL });
  } catch (_) {}
}

/* ---------- revival: bring a zombie job's pump back ---------- */
function maybeRekick(job, ctx, env) {
  if (job.done || job.gone || job.kind !== "chat") return;
  const now = Date.now();
  if (now - (job.lastPumpBeat || 0) < ZOMBIE_PUMP_MS) return; // healthy (or quiet < 25s)
  // the pump's runtime context was likely torn down after the client left —
  // abort whatever it was doing and restart from the current buffer state
  try { job.currentAbort && job.currentAbort.abort(); } catch (_) {}
  pumpLoop(job, ctx, env, null); // pumpGen bump invalidates any zombie loop
}

/* ---------- keepalive: keep the isolate (and the job) alive while you're gone ---------- */
function armKeepalive(job, ctx, env) {
  if (job.done || job.gone) return;
  job.keepaliveUntil = Math.max(job.keepaliveUntil || 0, Date.now() + KEEPALIVE_MAX_MS);
  schedulePing(job, ctx, env);
}
function schedulePing(job, ctx, env) {
  const p = (async () => {
    await sleep(KEEPALIVE_INTERVAL_MS);
    try {
      if (job.gone || job.done || !jobs.has(job.id)) return;
      if (Date.now() > (job.keepaliveUntil || 0)) return;
      const origin = job.origin || "";
      if (!origin) return;
      await fetch(origin + "/internal/ping?j=" + job.id + "&t=" + Date.now(), {
        // @ts-ignore runtime-specific
        cf: { cacheTtl: 0 },
      });
    } catch (_) {}
  })();
  ctx && ctx.waitUntil && ctx.waitUntil(p);
}

/* ---------- attach: the app's continue request meets a live job ----------
   The app sends [ ...conversation, assistant(partial), CONTINUE_INSTRUCTION ].
   If a job holds the SAME conversation and its content extends the partial,
   serve that job from the exact boundary instead of paying for a second
   generation. X-Nexus-Job is only exposed when the boundary is 0 (offsets
   must stay absolute for the app's reconnect math). */
function matchContinueJob(parsed) {
  const msgs = parsed && parsed.messages;
  if (!Array.isArray(msgs) || msgs.length < 3) return null;
  const last = msgs[msgs.length - 1];
  if (!last || last.role !== "user" || last.content !== CONTINUE_INSTRUCTION) return null;
  const prev = msgs[msgs.length - 2];
  if (!prev || prev.role !== "assistant" || typeof prev.content !== "string") return null;
  const prefixKey = JSON.stringify(msgs.slice(0, -2));
  const partial = prev.content;
  const now = Date.now();
  let best = null;
  for (const job of jobs.values()) {
    if (job.gone || job.kind !== "chat" || !job.reqBody || !job.reqBody.messages) continue;
    if (job.done && !job.finishSeen) continue;      // retries exhausted — a fresh generation continues better
    if (now - job.createdAt > JOB_TTL_MS) continue;
    if (JSON.stringify(job.reqBody.messages) !== prefixKey) continue;
    if (!job.contentText.startsWith(partial)) continue;
    const b = boundaryFor(job, partial.length);
    if (b < 0) continue;
    if (!best || b > best.offset) best = { job, offset: b }; // furthest-along match wins
  }
  return best;
}

/* ---------- subscribers ---------- */
function subscriberStream(job, startOffset) {
  let ctl = null;
  return new ReadableStream({
    start(controller) {
      ctl = controller;
      const buffered = bufferedFrom(job, startOffset);
      if (buffered.length) { try { controller.enqueue(buffered); } catch (_) {} }
      if (job.done) { try { controller.close(); } catch (_) {} return; }
      job.subs.add(controller);
    },
    cancel() { job.subs.delete(ctl); }, // client left — the pump keeps going
  });
}
function liveSubscriber(job) {
  let ctl = null;
  return new ReadableStream({
    start(controller) { ctl = controller; job.subs.add(controller); },
    cancel() { job.subs.delete(ctl); },
  });
}
function relayHeaders(job, extra) {
  const h = { "Content-Type": job.contentType || "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no", "X-Nexus-Job": job.id };
  for (const k in CORS) h[k] = CORS[k];
  if (extra) for (const k in extra) h[k] = extra[k];
  return h;
}

/* ---------- routes ---------- */
async function handleProxy(request, pathname, ctx, env) {
  const rawBody = new Uint8Array(await request.arrayBuffer());
  let parsed = null;
  if (pathname === "/chat") {
    try { parsed = JSON.parse(new TextDecoder().decode(rawBody)); } catch (_) {}
  }
  const fwd = {};
  for (const h of FWD_HEADERS) { const v = request.headers.get(h); if (v) fwd[h] = v; }

  // ATTACH: a continue request that matches a job we're already holding
  if (parsed && pathname === "/chat") {
    const m = matchContinueJob(parsed);
    if (m) {
      m.job.lastTouch = Date.now();
      maybeRekick(m.job, ctx, env);
      armKeepalive(m.job, ctx, env);
      const h = relayHeaders(m.job);
      if (m.offset > 0) delete h["X-Nexus-Job"]; // offsets must stay absolute for the app
      return new Response(subscriberStream(m.job, m.offset), { status: 200, headers: h });
    }
  }

  // attempt 0 upstream — errors pass straight through (v2 behavior).
  // The abort controller lets the stall watchdog kill a hung first attempt.
  const ac0 = new AbortController();
  let upstream;
  try {
    upstream = await fetch(upstreamBase(env) + upstreamPath(pathname), {
      method: "POST",
      headers: headersFrom(fwd),
      body: rawBody,
      signal: ac0.signal,
      // @ts-ignore runtime-specific
      cf: { cacheTtl: 0 },
    });
  } catch (err) {
    return json({ error: { message: "relay upstream failed: " + (err && err.message || String(err)), code: 502 } }, 502);
  }
  if (!upstream.ok || !upstream.body) {
    const hdrs = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(CORS)) hdrs.set(k, v);
    return new Response(upstream.body, { status: upstream.status, headers: hdrs });
  }

  const id = crypto.randomUUID();
  const job = {
    id, kind: pathname === "/images" ? "images" : "chat",
    chunks: [], total: 0,
    contentType: upstream.headers.get("content-type") || "text/event-stream",
    done: false, gone: false, overflow: false, failed: null,
    subs: new Set(), createdAt: Date.now(), lastTouch: Date.now(), lastPumpBeat: Date.now(),
    reqBody: parsed, fwd, origin: new URL(request.url).origin,
    // v3 state
    finishSeen: false, sawToolCalls: false, contentText: "",
    eventIndex: [], parse: { decoder: new TextDecoder(), pending: "", chunkStartByte: 0, lineStartByte: 0 },
    retries: 0, pumping: false, pumpGen: 0, currentAbort: ac0, keepaliveUntil: 0,
  };
  jobs.set(id, job);

  pumpLoop(job, ctx, env, upstream);
  armKeepalive(job, ctx, env);
  return new Response(liveSubscriber(job), { status: 200, headers: relayHeaders(job) });
}

async function handleJobGet(url, ctx, env) {
  const id = url.pathname.split("/")[2];
  const offset = Math.max(0, Number(url.searchParams.get("offset") || 0) || 0);
  let job = jobs.get(id);
  if (!job && env && env.NEXUS_KV) {
    try {
      const meta = await env.NEXUS_KV.get("meta:" + id, "json");
      if (meta && meta.done) {
        const body = await env.NEXUS_KV.get("job:" + id, "arrayBuffer");
        if (body) {
          const bytes = new Uint8Array(body);
          if (offset > bytes.length) return json({ error: "offset beyond snapshot" }, 416);
          return new Response(bytes.subarray(offset), { status: 200, headers: { "Content-Type": meta.contentType || "text/event-stream", "X-Nexus-Job": id, ...CORS } });
        }
      }
    } catch (_) {}
  }
  if (!job) return json({ error: "job not found (expired or relay restarted)" }, 404);
  if (offset > 0 && job.overflow) return json({ error: "job buffer overflowed — cannot replay" }, 410);
  maybeRekick(job, ctx, env);   // a client just came back — revive the pump if it died
  armKeepalive(job, ctx, env);
  return new Response(subscriberStream(job, offset), { status: 200, headers: relayHeaders(job, { "X-Nexus-Offset": String(job.total) }) });
}

export default {
  async fetch(request, env, ctx) {
    sweep();
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/health") {
      let running = 0;
      for (const j of jobs.values()) if (!j.done && !j.gone) running++;
      return json({ ok: true, relay: "nexus", v: WORKER_VERSION, jobs: jobs.size, running, time: Date.now() });
    }
    if (url.pathname === "/internal/ping") {
      sweep();
      let running = 0;
      for (const job of jobs.values()) {
        if (job.done || job.gone) continue;
        running++;
        maybeRekick(job, ctx, env); // revival point for zombie pumps
        armKeepalive(job, ctx, env); // perpetuate the chain while work exists
      }
      return json({ ok: true, v: WORKER_VERSION, running, time: Date.now() });
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
      const id = url.pathname.split("/")[2];
      const job = jobs.get(id);
      if (job) killJob(id, job);
      return json({ ok: true });
    }
    return json({ error: "not found", hint: "use /chat, /images, /job/:id?offset=N, /health" }, 404);
  },
};

/* =====================================================================
   NEXUS BACKGROUND RELAY — Cloudflare Worker
   =====================================================================
   Keeps AI streams (chat completions, reasoning, tool calls, images)
   running SERVER-SIDE so they survive: phone off, app killed, tab frozen,
   connection drops. The client reconnects with a byte offset and receives
   a seamless replay + live tail — zero tokens lost.

   WIRE PROTOCOL (what NexusAiPro.html speaks):
     POST {relay}/chat      → forwards to OpenRouter /chat/completions.
                              Response: SSE stream + "X-Nexus-Job: <id>" header
     POST {relay}/images    → forwards to OpenRouter /images (JSON).
                              Response: JSON + "X-Nexus-Job: <id>" header
     GET  {relay}/job/:id?offset=N
                            → replay of buffered bytes from N, then the live
                              tail; ends when the upstream ends. 404/410 when
                              the job is gone (client falls back to auto-resume)
     GET  {relay}/health    → {ok:true}
     DELETE {relay}/job/:id → free the job early

   AUTH: the client's "Authorization: Bearer <OpenRouter key>" header is
   forwarded upstream verbatim. The key is never stored or logged.

   SETUP (free tier is plenty, ~2 minutes):
     1. Go to https://dash.cloudflare.com → Workers & Pages → Create Worker
     2. Name it (e.g. nexus-relay) → Deploy
     3. Edit code → paste this entire file → Deploy
     4. Copy your worker URL (https://nexus-relay.<your-subdomain>.workers.dev)
     5. In Nexus AI Pro: Settings → Connection → Background relay → paste URL
        → Test relay

   v2 FIX (IMPORTANT — re-deploy if your relay says "Model not found"):
     v1 forwarded POST /chat to openrouter.ai/api/v1/chat (a path that does
     not exist). OpenRouter answered 404 and the app showed it as "Model not
     found". v2 maps /chat → /api/v1/chat/completions correctly. Visit
     {relay}/health — it must say "v":2. If it doesn't, you are still
     running v1. Optional: bind env NEXUS_UPSTREAM_BASE to relay through a
     different OpenAI-compatible provider.

   LIMITS (be aware):
     - Jobs live in worker memory (per isolate). Isolates persist for
       minutes-to-hours; a phone-off gap of a few minutes is covered. For
       multi-hour gaps, KV/Durable Objects would be needed.
     - 32 MB buffer cap per job (a normal response is well under 1 MB).
     - Cloudflare's free plan allows 100k requests/day — each chat message
       is 1 POST + occasional reconnect GETs.

   OPTIONAL KV SNAPSHOT (images + completed bodies survive isolates):
     - Create a KV namespace, bind it as NEXUS_KV, and completed jobs'
       final buffers are stored with a 1-hour TTL. /job replay of a
       completed job then works even after an isolate restart.
   ===================================================================== */

const WORKER_VERSION = 2;
const MAX_JOB_BYTES = 32 * 1024 * 1024; // 32MB buffer cap per job
const JOB_TTL_MS = 15 * 60 * 1000;      // sweep jobs idle/finished > 15 min
const KV_TTL = 3600;                    // seconds
const FWD_HEADERS = ["authorization", "content-type", "http-referer", "x-title", "accept"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, HTTP-Referer, X-Title",
  "Access-Control-Expose-Headers": "X-Nexus-Job",
  "Access-Control-Max-Age": "86400",
};

/* job = {
     id, kind: "chat"|"images",
     chunks: Uint8Array[], total, contentType, status: BufferingHeader,
     done, failed, subs: Set<controller>, createdAt, lastTouch,
     kvKey (optional)
   } */
const jobs = new Map();

const enc = new TextEncoder();
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS, ...headers } });
}

function sweepJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if ((job.done && now - job.lastTouch > 120000) || now - job.lastTouch > JOB_TTL_MS) {
      for (const c of job.subs) { try { c.close(); } catch (_) {} }
      jobs.delete(id);
    }
  }
}

function concatChunks(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}
// replay the buffered byte prefix starting at `offset`
function bufferedFrom(job, offset) {
  let total = 0;
  for (const c of job.chunks) total += c.length;
  if (offset >= total) return new Uint8Array(0);
  const out = new Uint8Array(total - offset);
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

/* ---------- upstream pump: runs to completion regardless of the client ----------
   Reads the upstream stream chunk by chunk, appends to the job buffer, and
   fans out to every attached subscriber. Driven by ctx.waitUntil(), so it
   keeps going even when the requesting client has vanished (phone off). */
function startPump(job, upstream, ctx, env) {
  const pump = (async () => {
    const reader = upstream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        job.lastTouch = Date.now();
        if (job.total + value.length > MAX_JOB_BYTES) {
          job.overflow = true; // stop buffering, keep fanning out live
        } else {
          job.chunks.push(value);
          job.total += value.length;
        }
        for (const c of [...job.subs]) {
          try { c.enqueue(value); } catch (_) { job.subs.delete(c); }
        }
      }
      job.done = true;
    } catch (err) {
      job.failed = err?.message || "upstream error";
      job.done = true;
    } finally {
      try { reader.releaseLock?.(); } catch (_) {}
      for (const c of [...job.subs]) { try { c.close(); } catch (_) {} }
      job.subs.clear();
      // optional durable snapshot of the finished body
      if (env?.NEXUS_KV && !job.overflow && job.total > 0 && job.total < 5 * 1024 * 1024) {
        try {
          const body = concatChunks(job.chunks);
          await env.NEXUS_KV.put("job:" + job.id, body, { expirationTtl: KV_TTL });
          await env.NEXUS_KV.put("meta:" + job.id, JSON.stringify({ done: true, contentType: job.contentType, bytes: job.total, kind: job.kind }), { expirationTtl: KV_TTL });
          job.kvKey = "job:" + job.id;
        } catch (_) {}
      }
    }
  })();
  ctx?.waitUntil?.(pump.catch(() => {}));
  return pump;
}

function subscriberStream(job, startOffset) {
  let ctl = null;
  return new ReadableStream({
    start(controller) {
      ctl = controller;
      // replay the already-buffered prefix first
      const buffered = bufferedFrom(job, startOffset);
      if (buffered.length) { try { controller.enqueue(buffered); } catch (_) {} }
      if (job.done) { try { controller.close(); } catch (_) {} return; }
      job.subs.add(controller);
    },
    cancel() {
      // client left — just detach; the pump keeps the job alive
      job.subs.delete(ctl);
    },
  });
}

function relayHeaders(job, extra = {}) {
  return { "Content-Type": job.contentType || "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no", "X-Nexus-Job": job.id, ...CORS, ...extra };
}

/* v2 fix: the relay route is NOT the upstream path. /chat is the relay's
   name for OpenRouter's /chat/completions endpoint — v1 concatenated the
   relay route onto the upstream base and got a 404. */
function upstreamBase(env) {
  return ((env && env.NEXUS_UPSTREAM_BASE) || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
}
function upstreamPath(pathname) {
  if (pathname === "/chat") return "/chat/completions";
  if (pathname === "/images") return "/images";
  return pathname;
}

async function handleProxy(request, pathname, ctx, env) {
  const upstreamUrl = upstreamBase(env) + upstreamPath(pathname);
  const headers = new Headers();
  for (const h of FWD_HEADERS) { const v = request.headers.get(h); if (v) headers.set(h, v); }
  const upstream = await fetch(upstreamUrl, {
    method: "POST",
    headers,
    body: await request.arrayBuffer(),
    // @ts-ignore runtime-specific
    cf: { cacheTtl: 0 },
  });

  const id = crypto.randomUUID();
  const job = {
    id, kind: pathname === "/images" ? "images" : "chat",
    chunks: [], total: 0,
    contentType: upstream.headers.get("content-type") || "text/event-stream",
    done: false, failed: null, overflow: false,
    subs: new Set(), createdAt: Date.now(), lastTouch: Date.now(),
  };
  jobs.set(id, job);

  if (!upstream.ok || !upstream.body) {
    // pass the error straight through; no job to track
    jobs.delete(id);
    const hdrs = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(CORS)) hdrs.set(k, v);
    return new Response(upstream.body, { status: upstream.status, headers: hdrs });
  }

  startPump(job, upstream.body, ctx, env);

  // respond with a live subscriber starting at offset 0
  const live = (() => {
    let ctl = null;
    return new ReadableStream({
      start(controller) { ctl = controller; job.subs.add(controller); },
      cancel() { job.subs.delete(ctl); },
    });
  })();
  return new Response(live, { status: 200, headers: relayHeaders(job) });
}

async function handleJobGet(url, env) {
  const id = url.pathname.split("/")[2];
  const offset = Math.max(0, Number(url.searchParams.get("offset") || 0) || 0);
  let job = jobs.get(id);
  if (!job && env?.NEXUS_KV) {
    // memory miss → maybe a completed job snapshotted to KV
    try {
      const meta = await env.NEXUS_KV.get("meta:" + id, "json");
      if (meta?.done) {
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
  return new Response(subscriberStream(job, offset), { status: 200, headers: relayHeaders(job, { "X-Nexus-Offset": String(job.total) }) });
}

export default {
  async fetch(request, env, ctx) {
    sweepJobs();
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/health") return json({ ok: true, relay: "nexus", v: WORKER_VERSION, jobs: jobs.size, time: Date.now() });

    if (request.method === "POST" && (url.pathname === "/chat" || url.pathname === "/images")) {
      try {
        return await handleProxy(request, url.pathname, ctx, env);
      } catch (err) {
        return json({ error: { message: "relay upstream failed: " + (err?.message || String(err)), code: 502 } }, 502);
      }
    }

    if (request.method === "GET" && /^\/job\/[A-Za-z0-9-]+$/.test(url.pathname)) {
      return handleJobGet(url, env);
    }
    if (request.method === "DELETE" && /^\/job\/[A-Za-z0-9-]+$/.test(url.pathname)) {
      const id = url.pathname.split("/")[2];
      const job = jobs.get(id);
      if (job) { for (const c of job.subs) { try { c.close(); } catch (_) {} } jobs.delete(id); }
      return json({ ok: true });
    }
    return json({ error: "not found", hint: "use /chat, /images, /job/:id?offset=N, /health" }, 404);
  },
};

/**
 * Nexus AI Pro — sync + generation worker v2 (free-plan friendly)
 *
 *   GET  /health | /chats | /chat/:id | /job/:id
 *   PUT  /chat
 *   DELETE /chat/:id
 *   POST /generate   (body.poll === true → eco: returns JSON immediately, no stream)
 *   POST /job/:id/cancel
 *
 * v2: chat listing uses KV metadata (1 write per save instead of 2),
 *     eco poll mode, early API-key validation. API surface otherwise unchanged.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Max-Age": "86400",
};

const ALLOWED_PARAMS = new Set([
  "temperature", "top_p", "top_k", "min_p", "frequency_penalty",
  "presence_penalty", "repetition_penalty", "max_tokens", "stop",
  "seed", "response_format", "reasoning",
]);

const activeJobs = new Map();
let nsCache = { key: "", ns: "" };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

const SYNC_KEY_FALLBACK = "nexus7-blue-ox";

async function namespace(request, env) {
  const key = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const expected = env.SYNC_KEY || SYNC_KEY_FALLBACK;
  if (!expected) throw new HttpError(500, "SYNC_KEY secret is not set on the worker.");
  if (!key || key !== expected) throw new HttpError(401, "Invalid sync key."); throw new HttpError(401, "Invalid sync key.");
  if (nsCache.key !== key) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("nexus:" + key));
    nsCache = { key, ns: [...new Uint8Array(digest)].slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join("") };
  }
  return nsCache.ns;
}

function chatMetaOf(chat) {
  return { title: String(chat.title || "Chat").slice(0, 80), updatedAt: chat.updatedAt || Date.now() };
}

async function listChats(kv, ns) {
  const prefix = `chat:${ns}:`;
  const out = new Map();
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const k of page.keys) {
      const id = k.name.slice(prefix.length);
      out.set(id, { id, title: (k.metadata && k.metadata.title) || "Chat", updatedAt: (k.metadata && k.metadata.updatedAt) || 0 });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  // Compatibility with v1's separate index key (so old chats still list).
  try {
    const legacy = await kv.get(`index:${ns}`, "json");
    if (legacy && typeof legacy === "object") {
      for (const [id, meta] of Object.entries(legacy)) {
        if (!out.has(id) && meta) out.set(id, { id, title: meta.title || "Chat", updatedAt: meta.updatedAt || 0 });
      }
    }
  } catch {}
  return [...out.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

function upstreamError(text, status) {
  try {
    const j = JSON.parse(text);
    return (j.error && j.error.message) || j.message || `HTTP ${status}`;
  } catch { return (text || "").slice(0, 300) || `HTTP ${status}`; }
}

function extractStream(raw) {
  let content = "", reasoning = "", error = null;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const data = t.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const j = JSON.parse(data);
      if (j.error) { error = j.error.message || "Upstream error"; continue; }
      const d = j.choices && j.choices[0] && j.choices[0].delta;
      if (d) {
        if (typeof d.content === "string") content += d.content;
        if (typeof d.reasoning === "string") reasoning += d.reasoning;
        if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content;
      }
    } catch {}
  }
  return { content, reasoning, error };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    try {
      if (url.pathname === "/") return new Response("Nexus AI Pro sync worker v2 is running.", { headers: { "Content-Type": "text/plain", ...CORS } });
      if (url.pathname === "/health") return json({ ok: true, version: 2, hasServerKey: !!env.OPENROUTER_API_KEY });
      if (!env.CHAT_KV) throw new HttpError(500, "CHAT_KV binding missing — bind your KV namespace with variable name CHAT_KV.");
      const ns = await namespace(request, env);
      const route = request.method + " " + url.pathname;

      if (route === "GET /chats") return json(await listChats(env.CHAT_KV, ns));

      if (route === "PUT /chat") {
        const chat = await request.json();
        if (!chat || !chat.id) throw new HttpError(400, "Chat must have an id.");
        const body = {
          id: chat.id,
          title: chat.title || "Chat",
          messages: Array.isArray(chat.messages) ? chat.messages : [],
          files: Array.isArray(chat.files) ? chat.files : [],
          createdAt: chat.createdAt || Date.now(),
          updatedAt: chat.updatedAt || Date.now(),
          pendingJob: null,
        };
        if (JSON.stringify(body).length > 24 * 1024 * 1024) throw new HttpError(413, "Chat too large for KV.");
        await env.CHAT_KV.put(`chat:${ns}:${chat.id}`, JSON.stringify(body), { metadata: chatMetaOf(body) });
        return json({ ok: true });
      }

      const chatMatch = url.pathname.match(/^\/chat\/([^/]+)$/);
      if (chatMatch && request.method === "GET") {
        const chat = await env.CHAT_KV.get(`chat:${ns}:${chatMatch[1]}`, "json");
        if (!chat) throw new HttpError(404, "Chat not found.");
        return json(chat);
      }
      if (chatMatch && request.method === "DELETE") {
        await env.CHAT_KV.delete(`chat:${ns}:${chatMatch[1]}`);
        try {
          const legacy = await env.CHAT_KV.get(`index:${ns}`, "json");
          if (legacy && legacy[chatMatch[1]]) { delete legacy[chatMatch[1]]; await env.CHAT_KV.put(`index:${ns}`, JSON.stringify(legacy)); }
        } catch {}
        return json({ ok: true });
      }

      if (route === "POST /generate") return generate(request, env, ctx, ns);

      const cancelMatch = url.pathname.match(/^\/job\/([^/]+)\/cancel$/);
      if (cancelMatch && request.method === "POST") {
        const jobKey = `job:${ns}:${cancelMatch[1]}`;
        const ac = activeJobs.get(jobKey);
        if (ac) ac.abort();
        const job = await env.CHAT_KV.get(jobKey, "json");
        if (job && job.status === "running") {
          job.status = "cancelled"; job.updatedAt = Date.now();
          await env.CHAT_KV.put(jobKey, JSON.stringify(job));
        }
        return json({ ok: true });
      }

      const jobMatch = url.pathname.match(/^\/job\/([^/]+)$/);
      if (jobMatch && request.method === "GET") {
        const job = await env.CHAT_KV.get(`job:${ns}:${jobMatch[1]}`, "json");
        if (!job) throw new HttpError(404, "Job not found.");
        return json(job);
      }

      return json({ error: { message: "Not found" } }, 404);
    } catch (err) {
      return json({ error: { message: err.message || "Worker error" } }, err.status || 500);
    }
  },
};

async function generate(request, env, ctx, ns) {
  const body = await request.json();
  const { jobId, chatId, assistantMessageId, chatMeta = {}, history = [], requestMessages = [], params = {}, apiKey } = body;
  if (!jobId || !chatId || !Array.isArray(requestMessages) || !params.model) {
    throw new HttpError(400, "generate requires jobId, chatId, requestMessages and params.model.");
  }
  const key = apiKey || env.OPENROUTER_API_KEY;
  if (!key) throw new HttpError(400, "No OpenRouter API key. Add one in the app, or set the OPENROUTER_API_KEY secret on the worker.");

  const pollMode = body.poll === true; // eco mode
  const jobKey = `job:${ns}:${jobId}`;
  const chatKey = `chat:${ns}:${chatId}`;
  const startedAt = Date.now();
  await env.CHAT_KV.put(jobKey, JSON.stringify({ chatId, status: "running", startedAt, updatedAt: startedAt }));

  const abort = new AbortController();
  activeJobs.set(jobKey, abort);

  let client = null;
  const relay = pollMode ? null : new ReadableStream({ start(c) { client = c; } });
  const send = (text) => { if (client) { try { client.enqueue(new TextEncoder().encode(text)); } catch {} } };

  // Runs via waitUntil — keeps going and saves to KV even if the client vanished.
  const run = async () => {
    let raw = "";
    let errorMessage = null;
    let status = "done";
    try {
      const genParams = {};
      for (const k of ALLOWED_PARAMS) if (params[k] !== undefined && params[k] !== null) genParams[k] = params[k];
      const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: params.model, messages: requestMessages, stream: true, ...genParams }),
        signal: abort.signal,
      });
      if (!upstream.ok || !upstream.body) {
        throw new HttpError(502, "OpenRouter: " + upstreamError(await upstream.text(), upstream.status));
      }
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        raw += chunk;
        send(chunk);
      }
    } catch (err) {
      errorMessage = err.message || String(err);
      status = abort.signal.aborted ? "cancelled" : "error";
      send(`data: ${JSON.stringify({ error: { message: errorMessage } })}\n\n`);
    }

    try {
      const parsed = extractStream(raw);
      const assistantMessage = {
        id: assistantMessageId || `msg_${startedAt}`,
        role: "assistant",
        content: parsed.content || "",
        reasoning: parsed.reasoning || "",
        model: params.model,
        createdAt: Date.now(),
      };
      if (errorMessage) {
        assistantMessage.error = errorMessage;
        if (assistantMessage.content) assistantMessage.interrupted = true;
      }
      const chat = {
        id: chatId,
        title: chatMeta.title || "Chat",
        files: chatMeta.files || [],
        createdAt: chatMeta.createdAt || startedAt,
        updatedAt: Date.now(),
        messages: history.filter(m => m && m.id !== assistantMessageId).concat([assistantMessage]),
      };
      await env.CHAT_KV.put(chatKey, JSON.stringify(chat), { metadata: chatMetaOf(chat) });
    } catch {}
    try { await env.CHAT_KV.put(jobKey, JSON.stringify({ chatId, status, error: errorMessage, startedAt, updatedAt: Date.now() })); } catch {}
    activeJobs.delete(jobKey);
    if (client) { try { client.close(); } catch {} }
  };

  ctx.waitUntil(run());
  if (pollMode) return json({ ok: true, jobId, chatId });
  return new Response(relay, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no", ...CORS },
  });
}
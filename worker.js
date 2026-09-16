/**
 * Nexus AI Pro — sync + server-side generation worker
 *
 * Endpoints:
 *   GET  /health             – no auth, checks worker is alive
 *   GET  /chats              – list chat metadata (auth)
 *   GET  /chat/:id           – full chat (auth)
 *   PUT  /chat               – save full chat (auth)
 *   DELETE /chat/:id         – delete chat (auth)
 *   POST /generate           – stream a completion through the worker; keeps
 *                              running + saves the result to KV even if the
 *                              client disconnects (auth)
 *   GET  /job/:id            – job status: running | done | error | cancelled
 *   POST /job/:id/cancel     – best-effort cancel
 *
 * Secrets:  wrangler secret put SYNC_KEY            (pairing passphrase)
 *           wrangler secret put OPENROUTER_API_KEY  (optional server-side key)
 * Binding:  CHAT_KV (see wrangler.toml)
 *
 * Note: long generations are I/O bound (tiny CPU). The free Workers plan
 * (10ms CPU/request) is fine for typical chat replies; use the paid plan
 * ($5/mo, 30s CPU) if you generate very long files constantly.
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

const activeJobs = new Map(); // jobId -> AbortController (best effort, per-isolate)
let nsCache = { key: "", ns: "" };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

async function namespace(request, env) {
  const key = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!env.SYNC_KEY) throw new HttpError(500, "SYNC_KEY secret is not set on the worker. Run: wrangler secret put SYNC_KEY");
  if (!key || key !== env.SYNC_KEY) throw new HttpError(401, "Invalid sync key.");
  if (nsCache.key !== key) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("nexus:" + key));
    nsCache = {
      key,
      ns: [...new Uint8Array(digest)].slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join(""),
    };
  }
  return nsCache.ns;
}

async function readIndex(kv, ns) { return (await kv.get(`index:${ns}`, "json")) || {}; }
async function writeIndex(kv, ns, index) { await kv.put(`index:${ns}`, JSON.stringify(index)); }

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
      if (url.pathname === "/" ) {
        return new Response("Nexus AI Pro sync worker is running. Paste this URL + your sync key into the app's Settings.",
          { status: 200, headers: { "Content-Type": "text/plain", ...CORS } });
      }
      if (url.pathname === "/health") {
        return json({ ok: true, hasServerKey: !!env.OPENROUTER_API_KEY, name: "nexus-sync" });
      }
      if (!env.CHAT_KV) throw new HttpError(500, "CHAT_KV binding missing — add a KV namespace in wrangler.toml.");
      const ns = await namespace(request, env);
      const route = request.method + " " + url.pathname;

      if (route === "GET /chats") {
        const index = await readIndex(env.CHAT_KV, ns);
        return json(Object.values(index).sort((a, b) => b.updatedAt - a.updatedAt));
      }

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
          pendingJob: chat.pendingJob || null,
        };
        if (JSON.stringify(body).length > 24 * 1024 * 1024) throw new HttpError(413, "Chat too large for KV storage.");
        await env.CHAT_KV.put(`chat:${ns}:${chat.id}`, JSON.stringify(body));
        const index = await readIndex(env.CHAT_KV, ns);
        index[chat.id] = { id: chat.id, title: body.title, updatedAt: body.updatedAt };
        await writeIndex(env.CHAT_KV, ns, index);
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
        const index = await readIndex(env.CHAT_KV, ns);
        delete index[chatMatch[1]];
        await writeIndex(env.CHAT_KV, ns, index);
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

  const jobKey = `job:${ns}:${jobId}`;
  const chatKey = `chat:${ns}:${chatId}`;
  const startedAt = Date.now();
  await env.CHAT_KV.put(jobKey, JSON.stringify({ chatId, status: "running", startedAt, updatedAt: startedAt }));

  const abort = new AbortController();
  activeJobs.set(jobKey, abort);

  let client;
  const relay = new ReadableStream({ start(c) { client = c; } });

  // Runs independently of the client connection. If the phone dies mid-stream,
  // this keeps reading from OpenRouter and saves the finished reply to KV.
  const run = async () => {
    let raw = "";
    let errorMessage = null;
    let status = "done";
    const send = (text) => { try { client.enqueue(new TextEncoder().encode(text)); } catch {} };
    try {
      const key = apiKey || env.OPENROUTER_API_KEY;
      if (!key) throw new HttpError(400, "No OpenRouter API key. Add one in the app, or set the OPENROUTER_API_KEY secret on the worker.");
      const genParams = {};
      for (const k of ALLOWED_PARAMS) if (params[k] !== undefined && params[k] !== null) genParams[k] = params[k];
      const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
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
        send(chunk); // client may already be gone — errors swallowed on purpose
      }
    } catch (err) {
      errorMessage = err.message || String(err);
      status = abort.signal.aborted ? "cancelled" : "error";
      send(`data: ${JSON.stringify({ error: { message: errorMessage } })}\n\n`);
    }

    // Save the finished (or partial, if cancelled/errored) message + chat.
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
      const messages = history.filter(m => m && m.id !== assistantMessageId).concat([assistantMessage]);
      const chat = {
        id: chatId,
        title: chatMeta.title || "Chat",
        files: chatMeta.files || [],
        createdAt: chatMeta.createdAt || startedAt,
        updatedAt: Date.now(),
        messages,
      };
      await env.CHAT_KV.put(chatKey, JSON.stringify(chat));
      const index = await readIndex(env.CHAT_KV, ns);
      index[chatId] = { id: chatId, title: chat.title, updatedAt: chat.updatedAt };
      await writeIndex(env.CHAT_KV, ns, index);
    } catch {}
    try {
      await env.CHAT_KV.put(jobKey, JSON.stringify({ chatId, status, error: errorMessage, startedAt, updatedAt: Date.now() }));
    } catch {}
    activeJobs.delete(jobKey);
    try { client.close(); } catch {}
  };

  ctx.waitUntil(run());
  return new Response(relay, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no", ...CORS },
  });
}
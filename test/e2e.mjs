/* E2E: drive worker.js with a fake upstream that 429s twice then streams an
   answer. Asserts the v7 contract:
     - status comments are exactly ": nexus-status {json}" (parseable)
     - a rate-limited job reports state=waiting with attempt + waitMs
     - waitedMs accumulates and workMs>0 on a successful finish
     - GET /job/:id carries X-Nexus-Waited / X-Nexus-Attempts / X-Nexus-Status
     - GET /job/by-client finds the job from the client key alone
   Run: node test/e2e.mjs
*/
import { DB } from "./d1-stub.mjs";

globalThis.__nexusTun = {
  retryDelays: [80, 120, 160, 200],
  staleLockMs: 600,
  flushMs: 60,
  tailPollFast: 40,
  tailPollSlow: 120,
  jobTtlMs: 5 * 60 * 1000,
};

const mod = await import("../worker.js");
const worker = mod.default;

const db = new DB();
const env = { DB: db, NEXUS_UPSTREAM_BASE: "https://fake.upstream/v1" };

let upstreamCalls = 0;
const REAL_FETCH = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!u.startsWith("https://fake.upstream/")) return REAL_FETCH(url, init);
  upstreamCalls++;
  if (upstreamCalls <= 2) {
    return new Response(JSON.stringify({ error: { message: "rate limited", metadata: { retry_after_seconds: 0 } } }),
      { status: 429, headers: { "content-type": "application/json", "retry-after": "0" } });
  }
  const body = [
    'data: {"choices":[{"delta":{"content":"Hello "}}]}',
    "",
    'data: {"choices":[{"delta":{"content":"world"},"finish_reason":"stop"}]}',
    "",
    "",
    "",
    "",
  ].join("\n");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
};

const pending = [];
const ctx = { waitUntil: p => { if (p) { pending.push(p); p.catch && p.catch(e => { console.log("WAITUNTIL ERROR:", e && e.stack || e); }); } } };

async function readAll(resp, stopAt = "[DONE]") {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let out = "";
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const got = await Promise.race([
      reader.read().then(v => ({ v })),
      new Promise(r => setTimeout(() => r({ idle: true }), 1500)),
    ]);
    if (got.idle) continue;
    const { value, done } = got.v;
    if (done) break;
    if (value) out += dec.decode(value, { stream: true });
    if (stopAt && out.includes(stopAt)) break;
  }
  try { await reader.cancel(); } catch (_) {}
  return out;
}

const results = [];
const check = (name, cond, extra) => { results.push({ name, ok: !!cond, extra }); console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : "")); };

const clientKey = "chat1:0:1700000000000";
const req = new Request("https://relay.test/chat", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer test", "x-nexus-client": clientKey },
  body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] }),
});
const resp = await worker.fetch(req, env, ctx);
const jobId = resp.headers.get("X-Nexus-Job");
check("POST /chat returns X-Nexus-Job", !!jobId, jobId);
const text = await readAll(resp);

const statuses = [];
for (const line of text.split("\n")) {
  const t = line.trim();
  if (t.startsWith(": nexus-status ")) { try { statuses.push(JSON.parse(t.slice(": nexus-status ".length))); } catch (e) { check("status comment is valid JSON", false, t); } }
}
check("emitted ::nexus-status:: comments", statuses.length > 0, "count=" + statuses.length);
check("no double 'nexus nexus-status' prefix", !text.includes("nexus nexus-status"));
const waiting = statuses.filter(s => s.state === "waiting");
check("rate limit produced state=waiting", waiting.length >= 1, JSON.stringify(waiting[0] || null));
check("waiting carries attempt + max", waiting[0] && waiting[0].attempt >= 1 && waiting[0].max >= 1, waiting[0] && ("attempt=" + waiting[0].attempt + " max=" + waiting[0].max));
check("waiting is flagged rateLimited", waiting[0] && waiting[0].rateLimited === true);
check("waiting.waitMs is a positive number", waiting[0] && typeof waiting[0].waitMs === "number" && waiting[0].waitMs >= 0);
check("final status has cumulative waitedMs>0", statuses.some(s => s.waitedMs > 0), "waited=" + (statuses[statuses.length - 1] || {}).waitedMs);
check("final status has workMs>0", statuses.some(s => s.workMs > 0), "work=" + (statuses[statuses.length - 1] || {}).workMs);
check("stream contains the answer", text.includes("Hello ") && text.includes("world"));
check("upstream was retried", upstreamCalls >= 3, "calls=" + upstreamCalls);

const row = db.jobs.find(j => j.id === jobId);
check("job finished (status done)", row && row.status === "done", row && row.status);
check("job persisted waited_ms > 0", row && Number(row.waited_ms) > 0, row && ("waited_ms=" + row.waited_ms));
check("job persisted client key", row && row.client === clientKey);
const g = await worker.fetch(new Request("https://relay.test/job/" + jobId + "?offset=0", { headers: { authorization: "Bearer test" } }), env, ctx);
check("GET /job/:id exposes X-Nexus-Waited", Number(g.headers.get("X-Nexus-Waited")) > 0, g.headers.get("X-Nexus-Waited"));
check("GET /job/:id exposes X-Nexus-Attempts", Number(g.headers.get("X-Nexus-Attempts")) >= 1, g.headers.get("X-Nexus-Attempts"));
check("GET /job/:id exposes X-Nexus-Status", g.headers.get("X-Nexus-Status") === "done", g.headers.get("X-Nexus-Status"));
check("GET /job/:id exposes X-Nexus-Work", g.headers.get("X-Nexus-Work") !== null, g.headers.get("X-Nexus-Work"));
const replay = await readAll(g);
check("replay is byte-consistent (has the answer)", replay.includes("Hello ") && replay.includes("world"));
const bc = await worker.fetch(new Request("https://relay.test/job/by-client?client=" + encodeURIComponent(clientKey), { headers: { authorization: "Bearer test" } }), env, ctx);
check("GET /job/by-client resolves the job from client key", bc.status === 200 && bc.headers.get("X-Nexus-Job") === jobId, "status=" + bc.status + " job=" + bc.headers.get("X-Nexus-Job"));
check("by-client also exposes wait headers", Number(bc.headers.get("X-Nexus-Waited")) > 0, bc.headers.get("X-Nexus-Waited"));
await readAll(bc);
const h = await worker.fetch(new Request("https://relay.test/health"), env, ctx);
const health = await h.json();
check("health reports v7", health.v === 7, "v=" + health.v);
check("health job digest includes waitedMs", (health.jobs || []).some(j => j.waitedMs > 0));
check("health job digest includes workMs", (health.jobs || []).some(j => j.workMs > 0));

/* clean-run case: no rate limit → waitedMs must stay 0 and no waiting status */
upstreamCalls = 99; // next call succeeds immediately
const cleanKey = "chat2:0:1700000000001";
const cleanResp = await worker.fetch(new Request("https://relay.test/chat", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer test", "x-nexus-client": cleanKey },
  body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] }),
}), env, ctx);
const cleanText = await readAll(cleanResp);
const cleanStatuses = cleanText.split("\n").map(l => l.trim()).filter(l => l.startsWith(": nexus-status "))
  .map(l => { try { return JSON.parse(l.slice(": nexus-status ".length)); } catch (_) { return null; } }).filter(Boolean);
check("clean run emits no waiting state", !cleanStatuses.some(s => s.state === "waiting"));
check("clean run waitedMs stays 0", cleanStatuses.every(s => !s.waitedMs));

/* v7: re-sending the SAME client key must reuse the job, not start a second
   generation (no double spend when the app retries a request it lost track of) */
const jobsBefore = db.jobs.length;
const dupResp = await worker.fetch(new Request("https://relay.test/chat", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer test", "x-nexus-client": cleanKey },
  body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] }),
}), env, ctx);
check("duplicate client key reuses the job (no new job row)", db.jobs.length === jobsBefore, "before=" + jobsBefore + " after=" + db.jobs.length);
check("reused job still returns the same id", dupResp.headers.get("X-Nexus-Job") === cleanResp.headers.get("X-Nexus-Job"));
check("reused job exposes timing headers", dupResp.headers.get("X-Nexus-Work") !== null);
await readAll(dupResp);

const failed = results.filter(r => !r.ok);
console.log("\n" + (results.length - failed.length) + "/" + results.length + " checks passed");
if (failed.length) { console.log("FAILED:", failed.map(f => f.name).join("; ")); process.exit(1); }
process.exit(0);

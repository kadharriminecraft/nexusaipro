/* Resume E2E: the app closes mid-stream, then comes back and must receive
   EVERYTHING the worker has produced so far (thinking/status, partial text)
   and then the finished answer — this is the "send a prompt, close the app,
   come back to the full response" guarantee.
   Run: node test/resume.mjs
*/
import { DB } from "./d1-stub.mjs";

globalThis.__nexusTun = { retryDelays: [50, 60], staleLockMs: 500, flushMs: 30, tailPollFast: 40, tailPollSlow: 80 };

const worker = (await import("../worker.js")).default;
const db = new DB();
const env = { DB: db, NEXUS_UPSTREAM_BASE: "https://fake.upstream/v1" };

/* upstream: slow SSE — one delta every 60ms for ~1.2s */
globalThis.fetch = async (u, init) => {
  if (!String(u).startsWith("https://fake.upstream/")) return new Response("x", { status: 404 });
  const words = ["Alpha ", "Beta ", "Gamma ", "Delta ", "Epsilon ", "Zeta ", "Eta ", "Theta "];
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(c) {
      for (let i = 0; i < words.length; i++) {
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"' + words[i] + '"}}]}\n\n'));
        await new Promise(r => setTimeout(r, 60));
      }
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
};

const pending = [];
const ctx = { waitUntil: p => { pending.push(p); } };

const results = [];
const check = (name, cond, extra) => { results.push({ name, ok: !!cond }); console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : "")); };

const clientKey = "chat9:2:1790000000000";
const resp = await worker.fetch(new Request("https://relay.test/chat", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer t", "x-nexus-client": clientKey },
  body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "long one" }] }),
}), env, ctx);
const jobId = resp.headers.get("X-Nexus-Job");
check("job accepted", !!jobId, jobId);

/* ---- the app reads a little, then CLOSES (cancels the body) ---- */
const reader = resp.body.getReader();
const dec = new TextDecoder();
let seenBeforeClose = "";
let reads = 0;
while (reads < 4) {
  const { value, done } = await reader.read();
  if (done) break;
  seenBeforeClose += dec.decode(value, { stream: true });
  reads++;
  if (seenBeforeClose.includes("Alpha ")) break;
}
await reader.cancel(); // app went away — the pump must keep going in D1
check("client saw partial data before closing", seenBeforeClose.includes("Alpha "), JSON.stringify(seenBeforeClose.slice(0, 80)));
check("partial includes nexus-status", seenBeforeClose.includes(": nexus-status "));

/* ---- the app comes back with only its client key ---- */
await new Promise(r => setTimeout(r, 300));
const back = await worker.fetch(new Request("https://relay.test/job/by-client?client=" + encodeURIComponent(clientKey), { headers: { authorization: "Bearer t" } }), env, ctx);
check("resume by client key succeeds", back.status === 200, "status=" + back.status);
check("resume reports the job id", back.headers.get("X-Nexus-Job") === jobId);

/* follow it to completion from byte 0 (app's simplest recovery path) */
const r2 = back.body.getReader();
let full = "";
const deadline = Date.now() + 15000;
while (Date.now() < deadline) {
  const got = await Promise.race([r2.read().then(v => ({ v })), new Promise(r => setTimeout(() => r({ idle: true }), 1000))]);
  if (got.idle) continue;
  if (got.v.done) break;
  if (got.v.value) full += dec.decode(got.v.value, { stream: true });
  if (full.includes("[DONE]")) break;
}
try { await r2.cancel(); } catch (_) {}

check("resumed stream contains the whole answer", ["Alpha ", "Beta ", "Gamma ", "Delta ", "Epsilon ", "Zeta ", "Eta ", "Theta "].every(w => full.includes(w)));
check("resumed stream replays status events", full.includes(": nexus-status "));
check("no duplicated bytes before the reconnect point", (full.match(/Alpha /g) || []).length === 1, "count=" + (full.match(/Alpha /g) || []).length);

/* v7 regression: by-client must honor ?offset just like /job/:id, otherwise a
   client that already consumed bytes replays them and duplicates the answer. */
const offsetBytes = new TextEncoder().encode(seenBeforeClose).length;
const bcRes = await worker.fetch(new Request("https://relay.test/job/by-client?client=" + encodeURIComponent(clientKey) + "&offset=" + offsetBytes, { headers: { authorization: "Bearer t" } }), env, ctx);
check("by-client honors offset", bcRes.status === 200, "status=" + bcRes.status);
const rd = bcRes.body.getReader();
let bcBody = "";
while (true) {
  const { value, done } = await rd.read();
  if (done) break;
  if (value) bcBody += dec.decode(value, { stream: true });
}
check("by-client offset skips already-seen bytes", !bcBody.includes("Alpha "), JSON.stringify(bcBody.slice(0, 60)));
check("by-client offset still carries the tail", bcBody.includes("Theta "));

const row = db.jobs.find(j => j.id === jobId);
check("job completed in the background", row && row.status === "done", row && row.status);
check("full text persisted server-side", row && row.content_text.includes("Theta "));
check("work_ms persisted > 0", row && Number(row.work_ms) > 0, row && ("work_ms=" + row.work_ms));

/* ---- the hardest case: send a prompt and IMMEDIATELY close the app.
   The client cancels the body without reading a single byte, and we pretend
   it never even saw the response (no X-Nexus-Job captured) — recovery must
   rely on the client key alone and still deliver the finished answer. ---- */
const abruptKey = "chat11:1:1791000000000";
const abrupt = await worker.fetch(new Request("https://relay.test/chat", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer t", "x-nexus-client": abruptKey },
  body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "gone instantly" }] }),
}), env, ctx);
const abruptJob = abrupt.headers.get("X-Nexus-Job");
check("abrupt job accepted", !!abruptJob, abruptJob);
await abrupt.body.cancel(); // read nothing, gone immediately

/* let the background pump finish it with no client attached. The worker
   keeps working via ctx.waitUntil, so we drain those promises and poll the
   persisted row — exactly what the cron would have carried. */
const doneDeadline = Date.now() + 15000;
let abruptRow = null;
while (Date.now() < doneDeadline) {
  while (pending.length) { await Promise.allSettled([pending.shift()]); }
  abruptRow = db.jobs.find(j => j.id === abruptJob && j.status === "done") || null;
  if (abruptRow) break;
  await new Promise(r => setTimeout(r, 150));
}
check("abruptly-closed job still completes server-side", !!abruptRow, abruptRow && abruptRow.status);
check("abruptly-closed job kept the full answer", abruptRow && abruptRow.content_text.includes("Theta "));

/* recovery by client key only — no job id was ever captured */
const recovered = await worker.fetch(new Request("https://relay.test/job/by-client?client=" + encodeURIComponent(abruptKey), { headers: { authorization: "Bearer t" } }), env, ctx);
check("job findable by client key without ever seeing the id", recovered.status === 200 && recovered.headers.get("X-Nexus-Job") === abruptJob, "status=" + recovered.status);
const rr = recovered.body.getReader();
let recoveredText = "";
while (true) {
  const { value, done } = await rr.read();
  if (done) break;
  if (value) recoveredText += dec.decode(value, { stream: true });
  if (recoveredText.includes("[DONE]")) break;
}
try { await rr.cancel(); } catch (_) {}
check("recovery delivers the whole finished answer", ["Alpha ", "Theta "].every(w => recoveredText.includes(w)), recoveredText.slice(-40));

const failed = results.filter(r => !r.ok);
console.log("\n" + (results.length - failed.length) + "/" + results.length + " checks passed");
if (failed.length) { console.log("FAILED:", failed.map(f => f.name).join("; ")); process.exit(1); }
process.exit(0);

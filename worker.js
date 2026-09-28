/* =====================================================================
   NEXUS BACKGROUND RELAY v21 — Cloudflare Worker
   THE WORKER OWNS THE REQUEST — AND YOUR FILES — AND YOUR TOOLS.
   =====================================================================

   v21 — "A PARK(error) IS A DIAGNOSIS, NOT A VERDICT — AND IT TAKES
   MORE THAN ONE REFUSAL TO KILL A RUN":
   the user's report — "when I start a qwen session it eventually when I
   come back it just says request failed and in the settings sessions it
   says parked(error)". parkReason "upstream-fatal" is the provider
   returning a hard 4xx on a MID-RUN re-request — and v20 treated the
   FIRST one as final. Three root causes, all fixed at the source:
     - NO CONTEXT HYGIENE. The app trims every submit (contextTrim, the
       model's real context_length); the worker never did — its agent
       rounds append assistant text + tool results to job.req forever,
       and continuations re-send the WHOLE accumulated answer as an
       assistant message. An hour-long agent run on a big slow model
       grows until the provider 400s "context length exceeded" →
       Parked (error) with the whole run held hostage. v21: the app
       forwards its context budget (X-Nexus-Context); the worker trims
       the WIRE request to it (system messages + newest turns kept,
       durable conversation untouched), caps continuation partials at
       the tail, and on a length-flavored 400 HALVES the budget and
       re-asks (twice max) before parking.
     - ONE FATAL = DEAD. Free-tier routes flap — a request the provider
       already accepted gets a 400/404 "provider unavailable" on the
       retry after a cut. v21 retries fatal 400/404/422 twice with
       backoff before the honest park (401/403 park immediately — a
       revoked key does not heal in seconds).
     - THINKING SILENCE WAS A "DEAD SOCKET". The v19 watchdog's 90s
       streaming-stall applies once ANY byte flowed — including a
       reasoning-only stream that goes quiet mid-think (qwen's norm on
       slow lines). v21: silence before the attempt's first CONTENT or
       tool byte gets the 3-minute firstChunk window, not the 90s kill.
     - Visibility: an upstream-fatal park now also writes meta.error, so
       /jobs renders the provider's actual message under the row and
       the app panel shows the park detail — "Parked (error)" stops
       being a mystery.

   v20 — "A PARKED JOB IS A HANDOFF, NOT A DEAD END":
   the user's report — "tried qwen and left it for a few hours; came back
   to 'the response has been cut off' with no progress but the thinking
   from when I left, and the request on the worker sits PARKED because of
   tools". The parked round is the worker HOLDING THE RUN OPEN for the
   phone to execute its tool calls — but everything around it treated a
   park as a failure:
     - The phone's recovery checked !rs.clean (no finish marker — parked
       buffers never have one) BEFORE the tool-call branch, so it marked
       the chat "Interrupted — response cut off" and never executed the
       round. Fixed on the app side (v16): complete tool calls execute,
       the run continues, the parked job is retired as the parent.
     - by-key rediscovery only covered 30 minutes and the prune deleted
       parked rows at 2h — "left for a few hours" fell outside BOTH.
       v20: parked rows keep for PARKED_KEEP_MS (24h default) and by-key
       rediscovers them for the same window, carrying the park reason.
     - The park itself was SILENT. v20 writes meta.park {reason, detail}:
       "tools" (the device's round — tool names listed), "upstream-fatal"
       (the provider refused mid-run — 401/404/etc, WITH the honest error
       event appended to the buffer so the replay shows WHY), or
       "images-cut". /jobs, /job/:id/status and /job/by-key all expose it.
     - The prune could FAIL A LIVE JOB BY AGE: queued/streaming rows older
       than 30 minutes were failed even with a fresh heartbeat — the
       second half of the slow-model "time out and cut off" (v19 fixed
       the watchdog; this fixes the age ceiling). v20: only stale-
       heartbeat rows past the TTL are failed; JOB_TTL default is 2h and
       the drive budget is 20min per session (seamless release/re-drive).
     - Parent retirement flipped terminal statuses: a DONE parent was
       marked "stopped" by its follow-up submit. v20 stopJobRows only
       retires queued/streaming/parked parents; done/failed keep their
       honest status (the explicit user Stop still stops anything).

   v19 — "SLOW MODELS DON'T TIME OUT, AND THE CLOCK IS THE WORKER'S":
   the user's report — slower models (Qwen-class, minutes of queue or
   silent thinking on free lines) "just seem to time out and cut off for
   the worker"; the times indicators "don't seem to be correct".
   Two root causes, both fixed at the source:
     - THE STALL WATCHDOG WAS FLAT. A single 60s "no bytes" timer armed
       BEFORE the fetch even left — so a provider holding the request in
       its queue (headers not back yet), or a thinking model silent
       before its first token, was killed at 60s, retried, killed again,
       until the attempt budget drained and the job "cut off". v19 makes
       the watchdog phase-aware:
         connect    (headers not back yet — the provider LINE)  → 5 min
         accepted   (headers ok, model thinking before byte 1)  → 3 min
         streaming  (bytes were flowing, now silent = dead)      → 90s
       Any byte — data or an SSE keep-alive comment — is a beat and
       promotes the phase. A genuinely dead socket still dies in 90s and
       takes the truncation-recovery path, exactly as before.
     - THE TIMES WERE THE PHONE'S GUESS. The live path stamped the
       message's wait/work chip from the phone's own t0/first-token —
       meaningless when the phone attached late or left and came back.
       The worker has kept honest meters since v14 (wait = line, work =
       the model on an accepted attempt); v19 FORWARDS them inside the
       stream itself: every terminal chat job appends one final event
           data: {"nexus_timing":{"waitMs":…,"workMs":…,"attempts":…}}
       BEFORE its status flips — so the live tail, every re-attach, the
       D1 replay AND the v18 archive all carry the worker's clock. The
       app prefers it (chip says "synced from worker"), falls back to
       /job/:id/status, and only measures locally for direct runs. The
       wait monitor also becomes a live WORK counter while streaming.

   v17 — "THE AI AND THE WORKER ARE INDEPENDENT": every tool the agent
   can call now runs ON THE WORKER too — the phone is a pure observer.
   v15 made the FILE tools server-side; v17 finishes the job:
     - run_javascript — a real sandbox (fresh scope per run, console
       capture, require('file.js') pre-loading .js files from the
       mirror, 10s async timeout, loop-guard injection so sync infinite
       loops die too — the exact app result strings). If the runtime
       forbids string->code (eval/new Function), the round hands back.
     - web tools — web_search / fetch_url / http_request /
       get_weather / get_time / currency_convert / define_word, the
       app's implementations ported line-for-line (a Worker fetches
       with no CORS constraints — the proxies become pure fallbacks).
     - GitHub tools — gh_list_repos / gh_list_files / gh_read_file /
       gh_write_file / gh_delete_file against the CONNECTED repos.
       The app now rides its GitHub settings (PAT + repo list + the
       chat's resolved repos) on every /ws sync POST; the worker keeps
       them in ws_meta.gh and commits while the phone is gone. No PAT
       synced (or repo disconnected) -> the round hands back, exactly
       as before — the phone is only needed for what only it can do.
   The user's own words for the architecture this completes: "the Ai
   and worker are independent with each other, I just happen to be an
   observer and sync in, but if I turn off the worker then I take over,
   and when the worker is back on I sync to it." Round classification
   (roundAllServerExecutable) now asks, per call: is THIS tool
   executable HERE? (file tools always; run_javascript if eval works;
   web always; gh_* only with a synced PAT). One non-executable call
   still hands the whole round back — pre-v17 apps keep working.

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
   attempts; finished jobs replay for 2h — and are then ARCHIVED (v18:
   the response record lives on after the job rows are pruned, so a
   phone that comes back hours or days later still syncs the whole
   response, exactly like it syncs the files); 8 MB buffer per job;
   free-plan subrequest budgets degrade gracefully (fresh drivers
   resume the work).
   ===================================================================== */

const WORKER_VERSION = 21;

/* test tunables — production reads defaults; the local harness overrides
   via globalThis.__nexusTun to run E2E in seconds. */
function TUN(key, def) {
  const t = globalThis.__nexusTun;
  return t && Object.prototype.hasOwnProperty.call(t, key) ? t[key] : def;
}

const MAX_JOB_BYTES = TUN("maxJobBytes", 8 * 1024 * 1024);
/* v20: JOB_TTL is now the ceiling for a job NOBODY is driving (dead queue
   rows). A LIVE pump heartbeats every few seconds and is exempt from the
   fail-sweep in prune() — a genuinely slow model (big Qwen thinking for
   40+ minutes) streams to completion instead of being failed by age.
   30 minutes was the second half of the slow-model "time out and cut
   off": v19 fixed the watchdog, this fixes the age ceiling. */
const JOB_TTL_MS = TUN("jobTtlMs", 2 * 60 * 60 * 1000);
const DONE_TTL_MS = TUN("doneTtlMs", 2 * 60 * 60 * 1000);
/* v20: a PARKED job is the phone's tool round — the worker is holding the
   buffer open FOR the device to come back and execute it. 30 minutes of
   rediscovery (the old by-key window) and 2 hours of row life (DONE_TTL)
   were both shorter than the user's "left for a few hours" — the phone
   came back to nothing. Parked rows now outlive everything else. */
/* v20: read at CALL time — tests and harnesses retune the window at
   runtime (parkedKeepMs), so it can't be a module-load constant */
const parkedKeepMs = () => TUN("parkedKeepMs", 24 * 60 * 60 * 1000);
const MAX_ATTEMPTS = TUN("maxAttempts", 24);
const RETRY_DELAYS = TUN("retryDelays", [1500, 3000, 6000, 10000, 15000, 20000]);
const UPSTREAM_STALL_MS = TUN("stallMs", 90 * 1000);
/* v19: the watchdog needs to know WHICH silence it is looking at — a
   slow model in a provider line or thinking before its first token is
   ALIVE, and the old flat 60s kill was the slow-model "time out and
   cut off". Phase limits (beats: any body byte, keep-alive comments
   included, promote to streaming):
     connect    — fetch still out, headers not back yet (the line)
     accepted   — headers ok, the model is silent before byte one
     streaming  — bytes flowed, then stopped = a dead socket */
const UPSTREAM_CONNECT_MS = TUN("connectMs", 5 * 60 * 1000);
const UPSTREAM_FIRST_CHUNK_MS = TUN("firstChunkMs", 3 * 60 * 1000);
/* v21: fatal-flap resilience + context hygiene — see the pump's fatal
   branch. A provider that already accepted a request once earns two
   short re-tries when it flaps a 400/404/422 on the continuation;
   401/403 still park immediately (revoked keys do not heal). */
const FATAL_RETRY_MAX = TUN("fatalRetryMax", 2);
const CTX_RESCUE_MAX = TUN("ctxRescueMax", 2);
/* the continuation partial sent back to the model is capped at the TAIL
   (a model continues seamlessly from its last words; the head adds
   nothing but tokens). ~24k chars ≈ 6k tokens — generous for any qwen
   window, and the buffer on OUR side keeps everything. */
const CONT_PARTIAL_CAP = TUN("contPartialCap", 24000);
/* v21: budget math for the WIRE request (never the durable job.req):
   the app forwards the model's context_length × fill; a reactive rescue
   halves it on a length-flavored 400. These bounds keep a rescue sane
   even when no hint arrived (old apps). */
const CTX_MIN_BUDGET = TUN("ctxMinBudget", 8000);
const CTX_FIT_FILL = TUN("ctxFitFill", 0.92);
const STALE_LOCK_MS = TUN("staleLockMs", 26 * 1000);
const FLUSH_MS = TUN("flushMs", 300);
const FLUSH_BYTES = TUN("flushBytes", 64 * 1024);
const TICK_BUDGET_MS = TUN("tickBudgetMs", 210 * 1000);
/* v20: 20 minutes per drive session — a slow-model run crosses session
   boundaries with a release + re-drive (the lock, buffer and meters all
   survive), so fewer swaps = fewer D1 writes for the same progress. */
const EVENT_BUDGET_MS = TUN("eventBudgetMs", 20 * 60 * 1000);
const TAIL_POLL_FAST = TUN("tailPollFast", 400);
const TAIL_POLL_SLOW = TUN("tailPollSlow", 2000);
const MAX_ACTIVE_JOBS = 64;
const MAX_TOTAL_JOBS = 256;
/* v18: how many finished responses each chat keeps in the archive (the
   newest N). The file mirror keeps files forever; the response archive
   keeps the last N runs — anything older was superseded by later runs
   on the same chat. */
const RESP_ARCHIVE_KEEP = TUN("respArchiveKeep", 8);

const FWD_HEADERS = ["authorization", "content-type", "http-referer", "x-title", "accept"];
const NEXUS_HEADERS = ["x-nexus-submit", "x-nexus-chat", "x-nexus-key", "x-nexus-parent", "x-nexus-ws", "x-nexus-context"];

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
  "Access-Control-Allow-Headers": "Authorization, Content-Type, HTTP-Referer, X-Title, X-Nexus-Submit, X-Nexus-Chat, X-Nexus-Key, X-Nexus-Parent, X-Nexus-Retry, X-Nexus-WS, X-Nexus-Context",
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
   v21: CONTEXT HYGIENE — the WIRE request must respect the model's
   window even when the durable conversation has grown for hours.
   The app trims every submit (contextTrim × the model's real
   context_length); the worker's half of the bargain:
     - estimate tokens the same way the app does (chars/4 + per-message
       overhead + tool_calls JSON)
     - fitRequestToBudget: keep EVERY system message + the newest turns,
       drop the OLDEST non-system groups (tool rounds travel with their
       assistant message — never split), cap max_tokens to the room left.
       Returns the wire body; job.req (the durable conversation) is
       NEVER mutated by this.
     - capPartial: a continuation re-sends only the TAIL of the partial
       answer (the model continues from its last words; the head is just
       tokens)
     - isContextLengthError: recognize the provider's "context length
       exceeded" class so the pump can halve its budget and re-ask
       instead of parking the whole run dead.
   ===================================================================== */
const msgTokens = m => {
  let n = 24;
  if (typeof m?.content === "string") n += Math.ceil(m.content.length / 4);
  else if (Array.isArray(m?.content)) { for (const p of m.content) n += p?.type === "text" ? Math.ceil((p.text || "").length / 4) : 900; }
  if (m?.tool_calls) n += Math.ceil(JSON.stringify(m.tool_calls).length / 4);
  return n;
};
const msgsTokens = ms => (Array.isArray(ms) ? ms : []).reduce((s, m) => s + msgTokens(m), 0);
function fitRequestToBudget(body, budget) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  if (msgsTokens(msgs) <= budget) return { body, est: msgsTokens(msgs), trimmed: false };
  let system = msgs.filter(m => m.role === "system");
  const rest = msgs.filter(m => m.role !== "system");
  /* a system prompt that alone busts a tiny window gets truncated to half
     the budget (head kept — the persona lives there) instead of making the
     fit mathematically impossible; real windows (32k+) never hit this */
  const sysCost0 = system.reduce((s, m) => s + msgTokens(m), 0);
  if (sysCost0 > budget * 0.5) {
    const capChars = Math.max(256, Math.floor(budget * 0.5 * 4));
    system = system.map(m => (typeof m.content === "string" && m.content.length > capChars)
      ? { ...m, content: m.content.slice(0, capChars) + "\n…(system instructions trimmed to fit the context window)" }
      : m);
  }
  /* atomic groups — the app's own contextTrim grouping: a user turn or a
     plain assistant turn starts a group; tool results and assistant
     tool_calls travel with what precedes them */
  const groups = [];
  for (const m of rest) {
    if (m.role === "user" || (m.role === "assistant" && !m.tool_calls)) groups.push([m]);
    else { if (!groups.length) groups.push([]); groups[groups.length - 1].push(m); }
  }
  const sysCost = system.reduce((s, m) => s + msgTokens(m), 0);
  const usable = Math.max(400, budget - sysCost - 512); /* completion room */
  const kept = [];
  let used = 0;
  for (let i = groups.length - 1; i >= 0; i--) {
    const cost = groups[i].reduce((s, m) => s + msgTokens(m), 0);
    if (used + cost > usable && kept.length) break;
    kept.unshift(...groups[i]);
    used += cost;
  }
  const out = { ...body, messages: system.concat(kept) };
  if (Number(out.max_tokens) > 0) out.max_tokens = Math.max(512, Math.min(Number(out.max_tokens), Math.floor(Math.max(512, budget - sysCost - used))));
  return { body: out, est: msgsTokens(out.messages), trimmed: true };
}
/* cap the continuation partial to its TAIL (a model continues from its
   last words; the head is just tokens). Without a budget: the fixed
   CONT_PARTIAL_CAP. With one: half the window in chars — the partial
   must SURVIVE the trim as an atomic unit, so it is capped to what the
   fitted request can actually carry. */
const capPartial = (t, cap) => {
  const s = typeof t === "string" ? t : "";
  const c = Math.floor(Math.max(0, Number(cap) || 0)) || CONT_PARTIAL_CAP;
  return s.length > c ? s.slice(-c) : s;
};
const partialCapFor = budget => (budget > 0 ? Math.max(1024, Math.floor(budget * 4 * 0.5)) : 0);
/* the provider's "too big" complaints, in the wild: "context length
   exceeded", "maximum context length is 4096 tokens", "input tokens
   exceed limit", "request too large"... 401/404/429-class words never
   match (auth/model/rate live in other branches) */
const CONTEXT_ERR_RE = /context|too\s+(?:long|large)|exceed|max(?:imum)?[^\n]{0,30}(?:tokens?|length|prompt|input)|length\s*limit|input\s+(?:size|tokens)/i;
function isContextLengthError(message) { return CONTEXT_ERR_RE.test(String(message || "")); }

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
  /* v18: the RESPONSE ARCHIVE — the durable twin of the file mirror.
     The file mirror keeps the chat's FILES forever; the response archive
     keeps the chat's last FINISHED RESPONSES (done + failed) after the
     job rows themselves are TTL-pruned. A phone that comes back hours or
     days later syncs EVERYTHING from the worker — not just the files.
     Buffer bytes live in resp_chunks rows (same shape the live chunks
     table uses, one flush per row) so total size is bounded only by
     MAX_JOB_BYTES, never by a single statement limit. */
  `CREATE TABLE IF NOT EXISTS resp_archive (
     chat_key TEXT NOT NULL,
     job_id TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'chat',
     status TEXT NOT NULL DEFAULT 'done',
     bytes INTEGER NOT NULL DEFAULT 0,
     meta TEXT,
     finished_at INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (chat_key, job_id)
     )`,
  `CREATE TABLE IF NOT EXISTS resp_chunks (
     chat_key TEXT NOT NULL,
     job_id TEXT NOT NULL,
     idx INTEGER NOT NULL,
     data TEXT NOT NULL,
     PRIMARY KEY (chat_key, job_id, idx)
     )`,
];
const SCHEMA_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status, next_retry)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_chat ON jobs (chat_key, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_resp_chat ON resp_archive (chat_key, finished_at)`,
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
  `ALTER TABLE ws_meta ADD COLUMN gh TEXT`,
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
  { ins: `INSERT INTO resp_archive (chat_key, job_id, kind, status, bytes, meta, finished_at) VALUES (?, ?, 'chat', 'done', 0, '{}', 0)`, del: `DELETE FROM resp_archive WHERE chat_key = ? AND job_id = ?`, params: [pid, pid] },
  { ins: `INSERT INTO resp_chunks (chat_key, job_id, idx, data) VALUES (?, ?, 0, '')`, del: `DELETE FROM resp_chunks WHERE chat_key = ? AND job_id = ?`, params: [pid, pid] },
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
/* =====================================================================
   v17: THE REST OF THE TOOLBOX, SERVER-SIDE
   run_javascript (sandboxed eval, mirror-backed require), the web
   tools, and the GitHub tools — ported from the app so a run needs
   NOTHING from the phone. Same aliases, same result strings, so the
   model cannot tell where its code ran.
   ===================================================================== */
const JS_TOOLS = ["run_javascript"];
const WEB_TOOLS = ["web_search", "fetch_url", "http_request", "get_weather", "get_time", "currency_convert", "define_word"];
const GH_TOOLS = ["gh_list_repos", "gh_list_files", "gh_read_file", "gh_write_file", "gh_delete_file"];
const SERVER_TOOL_ALIASES = {
  ...FS_TOOL_ALIASES,
  run_command: "run_javascript", execute_code: "run_javascript", run_code: "run_javascript", eval: "run_javascript", execute: "run_javascript", run: "run_javascript", bash: "run_javascript", shell: "run_javascript", run_python: "run_javascript",
  search_web: "web_search", websearch: "web_search",
  fetch: "fetch_url", open_url: "fetch_url", url_fetch: "fetch_url", browse: "fetch_url", get_url: "fetch_url",
  http: "http_request", request: "http_request", api_request: "http_request",
  time: "get_time", get_date: "get_time", datetime: "get_time",
  weather: "get_weather",
  convert_currency: "currency_convert", exchange_rates: "currency_convert",
  define: "define_word", dictionary: "define_word", lookup_word: "define_word",
  gh_list_repositories: "gh_list_repos", gh_repos: "gh_list_repos", list_repos: "gh_list_repos", list_github_repos: "gh_list_repos", github_list_repos: "gh_list_repos", github_repos: "gh_list_repos", repos: "gh_list_repos",
  github_list_files: "gh_list_files", gh_list: "gh_list_files", list_github_files: "gh_list_files", gh_files: "gh_list_files", github_files: "gh_list_files", repo_files: "gh_list_files", list_repo_files: "gh_list_files",
  github_read_file: "gh_read_file", read_github_file: "gh_read_file", read_repo_file: "gh_read_file", gh_file: "gh_read_file", get_file: "gh_read_file", github_get_file: "gh_read_file",
  github_write_file: "gh_write_file", write_github_file: "gh_write_file", write_repo_file: "gh_write_file", gh_create_file: "gh_write_file", create_github_file: "gh_write_file", github_create_file: "gh_write_file", gh_commit: "gh_write_file", github_commit_file: "gh_write_file", commit_file: "gh_write_file", push_file: "gh_write_file", gh_push: "gh_write_file", github_push: "gh_write_file", push_to_repo: "gh_write_file", gh_update_file: "gh_write_file", update_github_file: "gh_write_file", update_repo_file: "gh_write_file", gh_edit_file: "gh_write_file", edit_github_file: "gh_write_file", edit_repo_file: "gh_write_file",
  github_delete_file: "gh_delete_file", delete_github_file: "gh_delete_file", delete_repo_file: "gh_delete_file", remove_github_file: "gh_delete_file",
};
/* the web tools' shared arg normalizer (the app's normalizeToolArgs subset) */
function webNormalizeArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const out = { ...args };
  const map = { query: ["q", "search", "search_query", "keywords"], url: ["link", "uri", "page", "address"], max_chars: ["max_chars", "limit", "max_length"], method: ["verb"], from: ["base", "source_currency"], to: ["target", "quote", "target_currency"], amount: ["value", "qty"], word: ["term"], timezone: ["tz", "zone"], days: ["forecast_days"], location: ["place", "city"], headers: ["http_headers", "request_headers"], body: ["data", "payload", "json"] };
  for (const [canon, aliases] of Object.entries(map)) {
    for (const a of aliases) if (a in out && !(canon in out)) { out[canon] = out[a]; delete out[a]; }
  }
  return out;
}
function webTruncateOut(text, max) {
  text = String(text ?? "");
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n…[output truncated, " + (text.length - max) + " more chars]";
}
function webHtmlToText(html) {
  return String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#0?39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function webSafeHttpUrl(raw) {
  try {
    const u = new URL(String(raw || ""));
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const h = u.hostname;
    if (/^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) {
      /* the app blocks private ranges; the local test harness points tools
         at 127.0.0.1 mocks on purpose — allow them only under the tun */
      if (!(globalThis.__nexusTun && globalThis.__nexusTun.allowLocalFetch)) return null;
    }
    return u;
  } catch (_) { return null; }
}
function webShortUrl(raw) { try { const u = new URL(String(raw)); return u.host + (u.pathname.length > 1 ? u.pathname.slice(0, 24) : ""); } catch (_) { return String(raw || "").slice(0, 30); } }
/* one fetch with a timeout — the app's toolFetch, ported. A Worker has
   no CORS constraints; the browser proxies are kept purely as fallbacks
   for sites that block bots. */
async function webFetch(url, opts = {}, ms = 12000) {
  const c = new AbortController();
  const t = setTimeout(() => { try { c.abort(); } catch (_) {} }, ms);
  try {
    return await fetch(url, { method: opts.method || "GET", headers: opts.headers || {}, body: opts.body, redirect: opts.redirect || "follow", signal: c.signal, cf: { cacheTtl: 0 } });
  } finally { clearTimeout(t); }
}
const WMO_CODES = { 0: "clear sky", 1: "mostly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "rime fog", 51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "freezing drizzle", 61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "freezing rain", 71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains", 80: "rain showers", 81: "rain showers", 82: "violent rain showers", 85: "snow showers", 86: "snow showers", 95: "thunderstorm", 96: "thunderstorm with hail", 99: "severe thunderstorm with hail" };
/* the local harness can pin canned answers so e2e never depends on the
   live internet: __nexusTun.webToolText = { web_search: "…" } */
function webToolOverride(name) {
  const t = globalThis.__nexusTun && globalThis.__nexusTun.webToolText;
  return t && typeof t === "object" ? String(t[name] || "") : "";
}
async function webSearchImpl(args) {
  const query = String(args.query || "").trim();
  if (!query) return { text: "A search query is required.", label: "Searched the web", sub: "", icon: "search", failed: true };
  const canned = webToolOverride("web_search");
  if (canned) return { text: "Live web results for \"" + query + "\":\n\n" + canned, label: "Searched the web", sub: "“" + (query.length > 44 ? query.slice(0, 44) + "…" : query) + "”", icon: "search" };
  try {
    const r = await webFetch("https://s.jina.ai/" + encodeURIComponent(query), { headers: { Accept: "text/plain" } }, 10000);
    if (r.ok) {
      const text = (await r.text()).trim();
      if (text.length > 60 && !/^\s*</.test(text)) return { text: "Live web results for \"" + query + "\":\n\n" + webTruncateOut(text, 6000), label: "Searched the web", sub: "“" + (query.length > 44 ? query.slice(0, 44) + "…" : query) + "”", icon: "search" };
    }
  } catch (_) {}
  try {
    const r = await webFetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query), {}, 10000);
    if (r.ok) {
      const html = await r.text();
      const picks = [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].slice(0, 5).map(m => {
        let u = m[1];
        const um = u.match(/[?&]uddg=([^&]+)/);
        if (um) { try { u = decodeURIComponent(um[1]); } catch (_) {} }
        return { url: u, title: webHtmlToText(m[2]) };
      }).filter(p => p.title);
      if (picks.length) return { text: "Web results (DuckDuckGo) for \"" + query + "\":\n\n" + picks.map((p, i) => (i + 1) + ". " + p.title + "\n   " + p.url).join("\n"), label: "Searched the web", sub: "“" + (query.length > 44 ? query.slice(0, 44) + "…" : query) + "”", icon: "search" };
    }
  } catch (_) {}
  const r = await webFetch("https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&list=search&srsearch=" + encodeURIComponent(query) + "&srlimit=5", {}, 10000);
  if (!r.ok) return { text: "Search failed (HTTP " + r.status + ").", label: "Searched the web", sub: "", icon: "search", failed: true };
  const j = await r.json().catch(() => null);
  const hits = (j && j.query && j.query.search) || [];
  if (!hits.length) return { text: "No results found for \"" + query + "\". Tell the user and answer from your own knowledge with a caveat.", label: "Searched the web", sub: "no results", icon: "search" };
  return {
    text: "Wikipedia results for \"" + query + "\":\n\n" + hits.map((h, i) => (i + 1) + ". " + h.title + "\n   https://en.wikipedia.org/wiki/" + encodeURIComponent(h.title.replace(/ /g, "_")) + "\n   " + webHtmlToText(h.snippet)).join("\n\n") + "\n\n(Live web search was unavailable — these are Wikipedia results.)",
    label: "Searched the web", sub: "“" + (query.length > 44 ? query.slice(0, 44) + "…" : query) + "”", icon: "search",
  };
}
async function webFetchUrlImpl(args) {
  const canned = webToolOverride("fetch_url");
  if (canned) return { text: "Fetched (canned):\n\n" + canned, label: "Read " + webShortUrl(args.url), sub: "", icon: "globe" };
  const url = webSafeHttpUrl(args.url);
  if (!url) return { text: "Provide a full public http(s) URL.", label: "Read page", sub: "", icon: "globe", failed: true };
  const maxChars = Math.min(Math.max(1000, Number(args.max_chars) || 12000), 20000);
  let text, how;
  try {
    const r = await webFetch(url.href, { headers: { Accept: "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5" } }, 10000);
    if (!r.ok) return { text: "Couldn't fetch the page (HTTP " + r.status + ") — the site may block bots.", label: "Read " + url.host, sub: "", icon: "globe", failed: true };
    const ct = r.headers.get("content-type") || "";
    const body = await r.text();
    text = /html|xml/i.test(ct) || /^\s*<(!doctype|html|\?xml)/i.test(body) ? webHtmlToText(body) : body;
    how = "direct";
  } catch (_) {
    const r2 = await webFetch("https://r.jina.ai/" + url.href, { headers: { Accept: "text/plain" } }, 15000);
    if (!r2.ok) return { text: "Couldn't fetch the page — the site may block bots.", label: "Read " + url.host, sub: "", icon: "globe", failed: true };
    text = (await r2.text()).trim();
    how = "reader proxy";
  }
  return { text: "Fetched " + url.host + url.pathname + " (" + how + ", " + fsFormatBytes(text.length) + " of text):\n\n" + webTruncateOut(text, maxChars), label: "Read " + webShortUrl(url.href), sub: "", icon: "globe" };
}
async function webHttpRequestImpl(args) {
  const url = webSafeHttpUrl(args.url);
  if (!url) return { text: "Provide a full public http(s) URL (private addresses are blocked).", label: "Called API", sub: "", icon: "transfer", failed: true };
  const method = String(args.method || "GET").toUpperCase();
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method)) return { text: "Unsupported method: " + method, label: "Called API", sub: "", icon: "transfer", failed: true };
  const headers = {};
  if (args.headers && typeof args.headers === "object" && !Array.isArray(args.headers)) {
    for (const [k, v] of Object.entries(args.headers).slice(0, 25)) headers[String(k).slice(0, 80)] = String(v).slice(0, 4000);
  }
  const hasBody = args.body != null && String(args.body).length > 0 && method !== "GET" && method !== "HEAD";
  if (hasBody && headers["Content-Type"] == null && headers["content-type"] == null) headers["Content-Type"] = "application/json";
  let resp;
  try {
    resp = await webFetch(url.href, { method, headers, body: hasBody ? String(args.body).slice(0, 64000) : undefined }, 15000);
  } catch (_) {
    return { text: "The request timed out or was blocked by the network.", label: "Called API", sub: webShortUrl(url.href), icon: "transfer", failed: true };
  }
  const text = await resp.text().catch(() => "");
  return { text: "HTTP " + resp.status + (resp.statusText ? " " + resp.statusText : "") + " · worker\nContent-Type: " + (resp.headers && resp.headers.get && resp.headers.get("content-type") || "unknown") + "\n\n" + webTruncateOut(text, 8000), label: "Called API" + (method !== "GET" ? " · " + method : ""), sub: webShortUrl(url.href), icon: "transfer" };
}
async function webWeatherImpl(args) {
  const canned = webToolOverride("get_weather");
  if (canned) return { text: canned, label: "Weather · " + (args.location || "?"), sub: "", icon: "cloud" };
  const loc = String(args.location || "").trim();
  if (!loc) return { text: "Which place?", label: "Weather", sub: "", icon: "cloud", failed: true };
  const days = Math.min(Math.max(1, Math.round(Number(args.days) || 3)), 7);
  const gr = await webFetch("https://geocoding-api.open-meteo.com/v1/search?name=" + encodeURIComponent(loc) + "&count=1&language=en&format=json", {}, 9000);
  const gj = await gr.json().catch(() => null);
  const g = gj && gj.results && gj.results[0];
  if (!g) return { text: "Couldn't find a place called \"" + loc + "\".", label: "Weather", sub: "", icon: "cloud", failed: true };
  const wr = await webFetch("https://api.open-meteo.com/v1/forecast?latitude=" + g.latitude + "&longitude=" + g.longitude + "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=" + days + "&timezone=auto", {}, 10000);
  if (!wr.ok) return { text: "Weather service failed (HTTP " + wr.status + ").", label: "Weather", sub: "", icon: "cloud", failed: true };
  const w = await wr.json();
  const c = w.current || {};
  const lines = ["Weather for " + g.name + (g.admin1 ? ", " + g.admin1 : "") + (g.country ? ", " + g.country : "") + " (" + (w.timezone || "?") + ")", "",
    "Now: " + (c.temperature_2m ?? "?") + "°C (feels like " + (c.apparent_temperature ?? "?") + "°C), " + (WMO_CODES[c.weather_code] || "weather code " + c.weather_code) + ", humidity " + (c.relative_humidity_2m ?? "?") + "%, wind " + (c.wind_speed_10m ?? "?") + " km/h", ""];
  const d = w.daily || {};
  (d.time || []).forEach((day, i) => {
    lines.push(day + ": " + (d.temperature_2m_min && d.temperature_2m_min[i] !== undefined ? d.temperature_2m_min[i] : "?") + "–" + (d.temperature_2m_max && d.temperature_2m_max[i] !== undefined ? d.temperature_2m_max[i] : "?") + "°C · " + (WMO_CODES[d.weather_code && d.weather_code[i]] || "?") + " · " + (d.precipitation_probability_max && d.precipitation_probability_max[i] !== undefined ? d.precipitation_probability_max[i] : "?") + "% rain");
  });
  return { text: lines.join("\n"), label: "Weather · " + (args.location || "?"), sub: "", icon: "cloud" };
}
function webTimeImpl(args) {
  const raw = args.timezone ? String(args.timezone).trim() : "";
  let zone = raw;
  if (zone) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date()); }
    catch (_) { return { text: 'Unknown timezone "' + zone + '" — use IANA names like America/Chicago or Asia/Tokyo.', label: "Checked the time", sub: "", icon: "clock", failed: true }; }
  } else {
    zone = "UTC";
  }
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" }).format(now);
  return { text: "Current time in " + zone + ": " + fmt + "\nUTC reference: " + now.toUTCString(), label: "Checked the time", sub: zone, icon: "clock" };
}
async function webCurrencyImpl(args) {
  const canned = webToolOverride("currency_convert");
  if (canned) return { text: canned, label: "Rates " + String(args.from || "?").toUpperCase() + " → " + String(args.to || "?").toUpperCase(), sub: "", icon: "coins" };
  const from = String(args.from || "").trim().toUpperCase();
  const to = String(args.to || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) return { text: "Use 3-letter currency codes, e.g. USD, EUR, JPY.", label: "Rates", sub: "", icon: "coins", failed: true };
  const r = await webFetch("https://open.er-api.com/v6/latest/" + from, {}, 10000);
  if (!r.ok) return { text: "Rate service failed (HTTP " + r.status + ").", label: "Rates", sub: "", icon: "coins", failed: true };
  const j = await r.json().catch(() => null);
  const rate = j && j.rates && j.rates[to];
  if (!rate) return { text: "No rate found for " + from + " → " + to + ".", label: "Rates", sub: "", icon: "coins", failed: true };
  const amount = Number(args.amount) || 1;
  const out = amount * rate;
  return { text: amount + " " + from + " = " + (Math.abs(out) >= 1 ? out.toFixed(2) : out.toPrecision(4)) + " " + to + "\nRate: 1 " + from + " = " + rate + " " + to + "\nUpdated: " + (j.time_last_update_utc || j.time_last_update_date || "recently"), label: "Rates " + from + " → " + to, sub: "", icon: "coins" };
}
async function webDefineImpl(args) {
  const canned = webToolOverride("define_word");
  if (canned) return { text: canned, label: "Defined “" + String(args.word || "").slice(0, 24) + "”", sub: "", icon: "book" };
  const word = String(args.word || "").trim().split(/\s+/)[0].toLowerCase();
  if (!word) return { text: "Which word?", label: "Dictionary", sub: "", icon: "book", failed: true };
  const r = await webFetch("https://api.dictionaryapi.dev/api/v2/entries/en/" + encodeURIComponent(word), {}, 9000);
  if (r.status === 404) return { text: "No dictionary entry for \"" + word + "\" — it may be a proper noun, brand, or very new word.", label: "Dictionary", sub: "", icon: "book", failed: true };
  if (!r.ok) return { text: "Dictionary service failed (HTTP " + r.status + ").", label: "Dictionary", sub: "", icon: "book", failed: true };
  const j = await r.json().catch(() => null);
  const entry = Array.isArray(j) ? j[0] : null;
  if (!entry) return { text: "Unexpected dictionary response.", label: "Dictionary", sub: "", icon: "book", failed: true };
  const out = [word + (entry.phonetic ? " · " + entry.phonetic : "")];
  let n = 0;
  for (const m of entry.meanings || []) {
    for (const df of m.definitions || []) {
      if (n >= 5) break;
      n++;
      out.push(n + ". (" + m.partOfSpeech + ") " + df.definition + (df.example ? "\n   e.g. " + df.example : ""));
    }
    if (n >= 5) break;
  }
  return { text: out.join("\n"), label: "Defined “" + String(args.word || "").slice(0, 24) + "”", sub: "", icon: "book" };
}

/* ---------- GitHub tools (the connected repos ride the ws sync) ---------- */
const GH_TIMEOUT = 30000;
function ghApiBase(env) { return ((env && env.NEXUS_GH_API) || "https://api.github.com").replace(/\/+$/, ""); }
function ghRepoKeyOf(r) { return String(r.owner || "") + "/" + String(r.repo || ""); }
async function wsGetGh(env, chatKey) {
  try {
    const r = await getSQL(env, `SELECT gh FROM ws_meta WHERE chat_key = ?`, [chatKey]);
    if (!r || !r.gh) return null;
    const g = JSON.parse(r.gh);
    if (!g || typeof g !== "object") return null;
    const repos = Array.isArray(g.repos) ? g.repos.slice(0, 20).map(x => ({
      owner: String(x.owner || "").slice(0, 80), repo: String(x.repo || "").slice(0, 100),
      fullName: String(x.fullName || (x.owner + "/" + x.repo)).slice(0, 200),
      branch: String(x.branch || "main").slice(0, 100), allowEdit: !!x.allowEdit,
    })).filter(x => x.owner && x.repo) : [];
    return { pat: String(g.pat || "").slice(0, 200), repos };
  } catch (_) { return null; }
}
function ghErrText(status, msg, hint) {
  if (status === 401) return "GitHub rejected the token (401) — it is invalid, expired, or was revoked. Reconnect it with a fresh classic token that has the repo scope (Settings → GitHub).";
  if (status === 403) return "GitHub refused (403) — " + (msg || "access denied") + ". Usually the token lacks the repo scope, the rate limit is hit, or the repo is private and the token can't see it.";
  if (status === 404) return "GitHub returned 404 — " + (msg || "not found") + (hint ? ". " + hint : ". The repo, branch, or file path doesn't exist (or the token has no access to the private repo).");
  if (status === 409 || status === 422) return "GitHub rejected the write (" + status + ") — " + (msg || "conflict") + ". The file changed since it was read (sha mismatch); it was re-read and retried automatically once.";
  if (status >= 500) return "GitHub server error (" + status + ") — " + (msg || "try again in a moment") + ".";
  return "GitHub error (" + status + "): " + (msg || "request failed") + ".";
}
async function ghApi(env, pat, path, { method = "GET", body, expect = "json", retry = true } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, GH_TIMEOUT);
  let resp;
  try {
    resp = await fetch(ghApiBase(env) + path, {
      method,
      headers: {
        "Authorization": "Bearer " + pat,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "nexus-ai-pro",
        ...(body != null ? { "Content-Type": "application/json" } : {}),
      },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (retry && err && err.name !== "AbortError") return ghApi(env, pat, path, { method, body, expect, retry: false });
    if (err && err.name === "AbortError") throw new Error("GitHub didn't respond within " + Math.round(GH_TIMEOUT / 1000) + "s (timeout) — the tool call was not left hanging.");
    throw new Error("GitHub request failed: " + (err && err.message || String(err)));
  }
  clearTimeout(timer);
  if (resp.status >= 500 && retry) return ghApi(env, pat, path, { method, body, expect, retry: false });
  if (!resp.ok) {
    let msg = "";
    try { const j = await resp.json(); msg = (j && j.message) || ""; } catch (_) {}
    const e = new Error(ghErrText(resp.status, msg, resp.status === 404 && method !== "GET" ? "Verify the repo name and that the token has repo scope for it." : ""));
    e.status = resp.status;
    throw e;
  }
  if (resp.status === 204 || expect === "none") return null;
  if (expect === "text") return await resp.text();
  return await resp.json();
}
function ghResolveRepoSynced(gh, args) {
  const list = (gh && gh.repos) || [];
  if (!list.length) throw new Error("No GitHub repositories are connected to this app yet. The user connects them once with the ＋ button → GitHub repo — after that every chat can see them.");
  const want = String((args && args.repo) ?? "").trim().toLowerCase();
  if (want) {
    let hit = list.find(r => ghRepoKeyOf(r).toLowerCase() === want) ||
      list.find(r => String(r.repo || "").toLowerCase() === want) ||
      list.find(r => String(r.fullName || "").toLowerCase() === want);
    if (!hit) throw new Error("The repo \"" + (args && args.repo) + "\" is not connected. Connected: " + list.map(ghRepoKeyOf).join(", ") + ".");
    return hit;
  }
  if (list.length === 1) return list[0];
  throw new Error("Several GitHub repos are connected — pass the \"repo\" argument (owner/name) to pick one: " + list.map(ghRepoKeyOf).join(", ") + ". (Check them with gh_list_repos.)");
}
function ghSplitPathForUrl(p) { return p.split("/").map(encodeURIComponent).join("/"); }
async function ghListReposImpl(gh) {
  const list = (gh && gh.repos) || [];
  if (!list.length) return { text: "No GitHub repositories are connected to this app yet. The user can add them with the ＋ button → GitHub repo.", label: "Checked GitHub repos", sub: "none connected", icon: "github" };
  return {
    text: "Connected GitHub repositories (pass repo=\"owner/name\" on gh_* tool calls when several are listed):\n" +
      list.map(r => "- " + ghRepoKeyOf(r) + " · branch " + (r.branch || "main") + (r.allowEdit ? " · read+write (commits allowed)" : " · read-only")).join("\n"),
    label: "Checked GitHub repos", sub: list.length + " connected", icon: "github",
  };
}
async function ghListFilesImpl(env, gh, args) {
  const b = ghResolveRepoSynced(gh, args);
  const path = String(args.path || "").replace(/^\/+/, "").replace(/\/+$/, "");
  const tree = await ghApi(env, gh.pat, "/repos/" + b.owner + "/" + b.repo + "/git/trees/" + encodeURIComponent(b.branch || "main") + "?recursive=1");
  const all = ((tree && tree.tree) || []).filter(t => t.type === "blob" && (!path || String(t.path || "").startsWith(path + "/")));
  if (!all.length) return { text: path ? "No files under \"" + path + "\" in " + b.fullName + " — the folder may be empty or missing (it must exist)." : "The repository " + b.fullName + " is empty — no files yet on branch " + (b.branch || "main") + ". Use gh_write_file to create the first file.", label: "Checked " + b.fullName, sub: "0 files", icon: "github" };
  const rows = all.slice(0, 300).map(t => t.path + "  (" + fsFormatBytes(t.size || 0) + ")");
  const truncated = all.length > 300 ? "\n…[first 300 of " + all.length + " files — narrow with a subfolder path]" : "";
  return { text: "Files in " + b.fullName + " (branch " + (b.branch || "main") + ")" + (path ? " under " + path + "/" : "") + ":\n" + rows.join("\n") + truncated, label: "Checked " + b.fullName, sub: all.length + " files", icon: "github" };
}
async function ghReadFileImpl(env, gh, args) {
  const b = ghResolveRepoSynced(gh, args);
  const p = String(args.path || "").replace(/^\/+/, "");
  if (!p) throw new Error("A file path is required, e.g. index.html — get exact paths from gh_list_files.");
  const data = await ghApi(env, gh.pat, "/repos/" + b.owner + "/" + b.repo + "/contents/" + ghSplitPathForUrl(p) + "?ref=" + encodeURIComponent(b.branch || "main"));
  if (data && data.type === "dir") throw new Error("\"" + p + "\" is a folder, not a file — list its files with gh_list_files path=\"" + p + "\".");
  if (typeof (data && data.content) !== "string") throw new Error("No readable content came back for " + p + " (it may be a symlink or over 1MB — GitHub blocks raw reads above 1MB).");
  const bin = atob(data.content.replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const content = new TextDecoder("utf-8").decode(bytes);
  const allLines = content.split("\n");
  const total = allLines.length;
  const totalBytes = data.size || content.length;
  if (content.length <= 16000 && args.offset == null && args.limit == null) {
    return { text: content, label: "Read " + p, sub: fsFormatBytes(totalBytes) + " · " + total + " lines", icon: "github", file: p };
  }
  const offset = Math.max(1, Math.floor(Number(args.offset) || 1));
  const limit = Math.min(600, Math.max(1, Math.floor(Number(args.limit) || 400)));
  if (offset > total) throw new Error("offset " + offset + " is past the end of the file (" + total + " lines).");
  const end = Math.min(total, offset - 1 + limit);
  const bodyText = allLines.slice(offset - 1, end).map((l, i) => String(offset + i).padStart(5) + "| " + l).join("\n");
  const footer = end < total
    ? "\n…[lines " + offset + "–" + end + " of " + total + " — call gh_read_file with offset " + (end + 1) + " for the next chunk]"
    : "\n[End of file — " + total + " lines total]";
  return { text: bodyText + footer, label: "Read " + p, sub: "lines " + offset + "–" + end + " of " + total, icon: "github", file: p };
}
async function ghWriteFileImpl(env, gh, args) {
  const b = ghResolveRepoSynced(gh, args);
  if (!b.allowEdit) throw new Error("The repo " + ghRepoKeyOf(b) + " is read-only — its \"Allow AI to edit & push\" switch is off (＋ button → GitHub repo). The user must enable it before the AI can write, commit, or push to that repo.");
  const p = String(args.path || "").replace(/^\/+/, "");
  if (!p) throw new Error("A file path is required, e.g. index.html.");
  const content = String(args.content ?? "");
  if (!content.length) throw new Error("The file content is empty — pass the complete file content in the content argument (a 0-byte write was refused on purpose).");
  const message = String(args.message || "").trim() || "AI: create/update " + p + " via Nexus AI Pro";
  const base = "/repos/" + b.owner + "/" + b.repo;
  let sha = null, existed = false, prevSize = 0;
  try {
    const cur = await ghApi(env, gh.pat, base + "/contents/" + ghSplitPathForUrl(p) + "?ref=" + encodeURIComponent(b.branch || "main"));
    if (typeof (cur && cur.content) === "string") { sha = cur.sha; existed = true; prevSize = cur.size || 0; }
    else if (cur && cur.sha) { sha = cur.sha; existed = true; }
  } catch (err) {
    if (!err || err.status !== 404) throw err; // 404 = file doesn't exist yet = create
  }
  const bytes = new TextEncoder().encode(content);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  const payload = { message, content: btoa(bin), branch: b.branch || "main" };
  if (sha) payload.sha = sha;
  let commit;
  try {
    commit = await ghApi(env, gh.pat, base + "/contents/" + ghSplitPathForUrl(p), { method: "PUT", body: payload });
  } catch (err) {
    if (err && (err.status === 409 || err.status === 422) && sha) {
      const fresh = await ghApi(env, gh.pat, base + "/contents/" + ghSplitPathForUrl(p) + "?ref=" + encodeURIComponent(b.branch || "main"));
      payload.sha = (fresh && fresh.sha) || sha;
      commit = await ghApi(env, gh.pat, base + "/contents/" + ghSplitPathForUrl(p), { method: "PUT", body: payload });
    } else throw err;
  }
  const sha7 = String((commit && commit.commit && commit.commit.sha) || "").slice(0, 7);
  const url = "https://github.com/" + b.owner + "/" + b.repo + "/blob/" + (b.branch || "main") + "/" + p;
  return {
    text: "Committed " + p + " to " + b.fullName + " (" + (existed ? "updated, was " + fsFormatBytes(prevSize) : "new file") + ", now " + fsFormatBytes(content.length) + ", " + content.split("\n").length + " lines). Commit " + sha7 + " — " + url + ". The change is LIVE on GitHub now.",
    label: (existed ? "Updated " : "Created ") + p + " on GitHub",
    sub: fsFormatBytes(content.length) + " · commit " + (sha7 || "ok"),
    icon: "github", file: p,
  };
}
async function ghDeleteFileImpl(env, gh, args) {
  const b = ghResolveRepoSynced(gh, args);
  if (!b.allowEdit) throw new Error("The repo " + ghRepoKeyOf(b) + " is read-only — its \"Allow AI to edit & push\" switch is off, so deletes are refused.");
  const p = String(args.path || "").replace(/^\/+/, "");
  if (!p) throw new Error("A file path is required.");
  const base = "/repos/" + b.owner + "/" + b.repo;
  const cur = await ghApi(env, gh.pat, base + "/contents/" + ghSplitPathForUrl(p) + "?ref=" + encodeURIComponent(b.branch || "main"));
  if (typeof (cur && cur.content) !== "string" && !(cur && cur.sha)) throw new Error("File not found: " + p + " — use gh_list_files for exact paths.");
  const commit = await ghApi(env, gh.pat, base + "/contents/" + ghSplitPathForUrl(p), {
    method: "DELETE",
    body: { message: String(args.message || "").trim() || "AI: delete " + p + " via Nexus AI Pro", sha: cur.sha, branch: b.branch || "main" },
  });
  const sha7 = String((commit && commit.commit && commit.commit.sha) || "").slice(0, 7);
  return {
    text: "Deleted " + p + " from " + b.fullName + " (commit " + sha7 + "). The file is gone from branch " + (b.branch || "main") + " — gh_list_files will no longer show it.",
    label: "Deleted " + p, sub: "commit " + (sha7 || "ok"), icon: "github", file: p,
  };
}

/* ---------- run_javascript: the sandbox --------------------------------
   The app runs code in a throwaway Web Worker: fresh scope, captured
   console, require() over the workspace .js files, 10s hard terminate.
   The worker's isolate cannot be terminated — so the sandbox gets:
     - a FRESH FUNCTION SCOPE per run (new Function + direct eval → no
       cross-run leakage, eval semantics for the completion value),
     - a LOCAL console/require shadowing the globals (zero global
       mutation — concurrent jobs stay isolated),
     - pre-loaded mirror .js files for require() (the file write_file
       created seconds ago in the SAME run is right there — the user's
       "it can't run commands and find it immediately after creating a
       file" bug, dead at the root),
     - Promise.race timeouts for async hangs,
     - LOOP-GUARD INJECTION: string/comment-masked scan finds loop
       heads, injects a Date.now() deadline check into the body — a
       sync infinite loop dies in ~10s instead of burning the isolate
       (and a parse-check: if the guarded code doesn't compile, the
       unguarded original runs — injection can never break valid code).
   If the runtime forbids string->code entirely (some sandboxes do),
   run_javascript hands back to the phone — same as v16. */
let EVAL_PROBE = null, EVAL_FORCED = null;
function evalAvailable() {
  const forced = !!(globalThis.__nexusTun && globalThis.__nexusTun.noEval);
  if (EVAL_PROBE === null || EVAL_FORCED !== forced) {
    EVAL_FORCED = forced;
    try { EVAL_PROBE = forced ? false : (new Function("return 1")() === 1); } catch (_) { EVAL_PROBE = false; }
  }
  return EVAL_PROBE;
}
/* mask string/template/comment CONTENT (not structure) with spaces —
   same length, so positions map 1:1 onto the original */
function sandboxMaskLiterals(code) {
  let out = "";
  let i = 0;
  const n = code.length;
  let mode = 0; // 0 code, 1 ', 2 ", 3 `, 4 //, 5 /* */
  while (i < n) {
    const c = code[i];
    if (mode === 0) {
      if (c === "'") { mode = 1; out += " "; i++; }
      else if (c === '"') { mode = 2; out += " "; i++; }
      else if (c === "`") { mode = 3; out += " "; i++; }
      else if (c === "/" && code[i + 1] === "/") { mode = 4; out += "  "; i += 2; }
      else if (c === "/" && code[i + 1] === "*") { mode = 5; out += "  "; i += 2; }
      else { out += c; i++; }
    } else if (mode === 1 || mode === 2) {
      const q = mode === 1 ? "'" : '"';
      if (c === "\\") { out += "  "; i += 2; }
      else if (c === q) { out += " "; i++; mode = 0; }
      else { out += (c === "\n" ? "\n" : " "); i++; }
    } else if (mode === 3) {
      if (c === "\\") { out += "  "; i += 2; }
      else if (c === "`") { out += " "; i++; mode = 0; }
      else { out += (c === "\n" ? "\n" : " "); i++; }
    } else if (mode === 4) {
      if (c === "\n") { out += "\n"; i++; mode = 0; }
      else { out += " "; i++; }
    } else {
      if (c === "*" && code[i + 1] === "/") { out += "  "; i += 2; mode = 0; }
      else { out += (c === "\n" ? "\n" : " "); i++; }
    }
  }
  return out;
}
const SANDBOX_LIMIT_MS = 9500;
function sandboxInjectGuards(code) {
  const masked = sandboxMaskLiterals(code);
  const guard = 'if(Date.now()-__nxT0>' + SANDBOX_LIMIT_MS + ')throw new Error("Execution timed out (10s limit) — possible infinite loop.");';
  const points = [];
  const kw = /\b(while|for)\b/g;
  let m;
  while ((m = kw.exec(masked))) {
    let i = m.index + m[0].length;
    while (i < masked.length && /\s/.test(masked[i])) i++;
    if (masked[i] !== "(") continue;
    let depth = 0, j = i;
    for (; j < masked.length; j++) {
      if (masked[j] === "(") depth++;
      else if (masked[j] === ")") { depth--; if (!depth) break; }
    }
    if (depth) continue;
    let k = j + 1;
    while (k < masked.length && /\s/.test(masked[k])) k++;
    if (masked[k] !== "{") continue; // no-brace body — rare; fail open
    points.push(k + 1);
  }
  const doKw = /\bdo\b/g;
  while ((m = doKw.exec(masked))) {
    let i = m.index + 2;
    while (i < masked.length && /\s/.test(masked[i])) i++;
    if (masked[i] !== "{") continue;
    points.push(i + 1);
  }
  if (!points.length) return code;
  points.sort((a, b) => b - a);
  let out = code;
  for (const p of points) out = out.slice(0, p) + guard + out.slice(p);
  return out;
}
/* the runner: fresh scope, local console + require, direct eval for the
   app's exact completion-value semantics, async-aware */
const SANDBOX_WRAPPER_SRC =
  'const __nxLogs = [];\n' +
  'const __nxFmt = v => { try {' +
  '  if (typeof v === "string") return v;' +
  '  if (v instanceof Error) return v.name + ": " + v.message;' +
  '  const s = JSON.stringify(v, null, 1); return s === undefined ? String(v) : s;' +
  ' } catch (e) { try { return String(v); } catch (_) { return "[unserializable]"; } } };\n' +
  'const console = { log: (...a) => __nxLogs.push({ level: "log", text: a.map(__nxFmt).join(" ") }), warn: (...a) => __nxLogs.push({ level: "warn", text: a.map(__nxFmt).join(" ") }), error: (...a) => __nxLogs.push({ level: "error", text: a.map(__nxFmt).join(" ") }), info: (...a) => __nxLogs.push({ level: "info", text: a.map(__nxFmt).join(" ") }) };\n' +
  'const require = p => {' +
  '  p = String(p).replace(/^\\.\\//, "");' +
  '  if (!(p in __nxFiles)) { const alt = Object.keys(__nxFiles).find(k => k.endsWith("/" + p) || k.endsWith(p)); if (!alt) throw new Error("File not found: " + p + " (available: " + Object.keys(__nxFiles).join(", ") + ")"); p = alt; }' +
  '  return (0, eval)(__nxFiles[p]);' +
  '};\n' +
  'const __nxT0 = Date.now();\n' +
  'try {\n' +
  '  let __nxR = eval(__nxCode);\n' +
  '  if (__nxR && typeof __nxR.then === "function") {\n' +
  '    __nxR = await Promise.race([__nxR, new Promise((_, rej) => setTimeout(() => rej(new Error("Execution timed out (10s limit) — possible infinite loop.")), 10000))]);\n' +
  '  }\n' +
  '  return { logs: __nxLogs, result: __nxFmt(__nxR), ms: Date.now() - __nxT0 };\n' +
  '} catch (e) { return { logs: __nxLogs, error: __nxFmt(e), ms: Date.now() - __nxT0 }; }';
let SANDBOX_MAKER = null;
function sandboxRunner() {
  if (!SANDBOX_MAKER) SANDBOX_MAKER = new Function('return (async function(__nxFiles, __nxCode){\n' + SANDBOX_WRAPPER_SRC + '\n});');
  return SANDBOX_MAKER(); // the async runner itself — call it with (files, code)
}
async function runServerJavascript(env, chatKey, code) {
  const src = String(code ?? "");
  if (!src.trim()) return { text: "No code was provided.", label: "Ran code", sub: "empty", icon: "terminal", failed: true };
  /* pre-load the mirror's .js/.mjs/.cjs files — require() sees exactly
     what the model's earlier write_file rounds created */
  const files = {};
  let loaded = 0;
  try {
    const rows = await allSQL(env, `SELECT path, bytes FROM ws_files WHERE chat_key = ? ORDER BY path ASC`, [chatKey]);
    for (const r of rows) {
      const p = String(r.path || "");
      if (!(p.endsWith(".js") || p.endsWith(".mjs") || p.endsWith(".cjs"))) continue;
      if (loaded > 60 || (Number(r.bytes) || 0) > 256 * 1024) continue;
      const row = await wsGetFile(env, chatKey, p);
      if (row) { files[p] = row.content; loaded++; }
    }
  } catch (_) {}
  /* loop guards + the parse-check safety net: if the guarded version
     doesn't compile, run the original unguarded (injection can never
     break valid code — and if the original is broken too, the eval
     reports the syntax error exactly like the app's sandbox would) */
  let guarded = sandboxInjectGuards(src);
  if (guarded !== src) {
    try { new Function(guarded); } catch (_) { guarded = src; }
  }
  const run = sandboxRunner()(files, guarded);
  const result = await Promise.race([
    run,
    new Promise(r => setTimeout(() => r({ logs: [], error: "Execution timed out (10s limit) — possible infinite loop.", ms: 10000 }), 10500)),
  ]);
  const parts = [];
  if (result && result.logs && result.logs.length) parts.push("Console:\n" + result.logs.map(l => "[" + l.level + "] " + l.text).join("\n"));
  if (result && result.error) parts.push("Error: " + result.error);
  else parts.push("Result: " + ((result && result.result) ?? "undefined"));
  parts.push("(" + ((result && result.ms) || 0) + "ms)");
  return {
    text: webTruncateOut(parts.join("\n\n"), 6000),
    label: "Ran code",
    sub: (result && result.error ? "error" : ((result && result.ms) || 0) + "ms · " + ((result && result.logs && result.logs.length) || 0) + " logs"),
    icon: "terminal",
  };
}

/* does a request's tools array declare anything the worker can run?
   (submit-time check — v17 widens file tools to the full toolbox) */
function requestHasServerTools(parsed) {
  try {
    const tools = parsed && parsed.tools;
    if (!Array.isArray(tools)) return false;
    for (const t of tools) {
      const n = t && t.function && t.function.name;
      if (n && (FS_TOOLS.includes(n) || JS_TOOLS.includes(n) || WEB_TOOLS.includes(n) || GH_TOOLS.includes(n) || SERVER_TOOL_ALIASES[n])) return true;
    }
  } catch (_) {}
  return false;
}
/* can EVERY call in this round run on the worker? (round-time check —
   the answer is per-call and per-capability: gh_* needs a synced PAT,
   run_javascript needs a runtime that allows string->code. One
   non-executable call hands the whole round back to the phone, exactly
   like v15 — pre-v17 apps keep working.) */
async function roundAllServerExecutable(env, chatKey, calls) {
  if (!calls || !calls.length) return false;
  let gh = null, ghChecked = false;
  for (const c of calls) {
    const resolved = SERVER_TOOL_ALIASES[c.name] || c.name;
    if (FS_TOOLS.includes(resolved)) continue;
    if (WEB_TOOLS.includes(resolved)) continue;
    if (JS_TOOLS.includes(resolved)) {
      if (evalAvailable()) continue;
      return false;
    }
    if (GH_TOOLS.includes(resolved)) {
      if (!ghChecked) { gh = await wsGetGh(env, chatKey); ghChecked = true; }
      if (gh && gh.pat && gh.repos.length) continue;
      return false;
    }
    return false;
  }
  return true;
}
/* execute one file tool against the mirror. Returns the app-shaped result
   {text, label, sub, icon, file, failed}. Throws become failed results —
   the model gets the same honest guidance the app gives it. */
async function runServerTool(env, chatKey, rawName, args) {
  const name = SERVER_TOOL_ALIASES[rawName] || rawName;
  try {
    switch (name) {
      /* ---- v17: run_javascript — the sandbox, mirror-backed ---- */
      case "run_javascript": {
        return await runServerJavascript(env, chatKey, String((args && args.code) || ""));
      }
      /* ---- v17: the web tools, worker-side ---- */
      case "web_search": {
        const a = webNormalizeArgs(args);
        const q = String((a && a.query) || "").trim();
        if (!q) throw new Error("A search query is required.");
        return await webSearchImpl(a);
      }
      case "fetch_url": {
        const a = webNormalizeArgs(args);
        if (!a || !String(a.url || "").trim()) throw new Error("Provide a full public http(s) URL.");
        return await webFetchUrlImpl(a);
      }
      case "http_request": {
        const a = webNormalizeArgs(args);
        if (!a || !String(a.url || "").trim()) throw new Error("Provide a full public http(s) URL (private addresses are blocked).");
        return await webHttpRequestImpl(a);
      }
      case "get_weather": {
        const a = webNormalizeArgs(args);
        if (!a || !String(a.location || "").trim()) throw new Error("Which place?");
        return await webWeatherImpl(a);
      }
      case "get_time": {
        return webTimeImpl(webNormalizeArgs(args) || {});
      }
      case "currency_convert": {
        const a = webNormalizeArgs(args);
        if (!a || !String(a.from || "").trim() || !String(a.to || "").trim()) throw new Error("Use 3-letter currency codes, e.g. USD, EUR, JPY.");
        return await webCurrencyImpl(a);
      }
      case "define_word": {
        const a = webNormalizeArgs(args);
        if (!a || !String(a.word || "").trim()) throw new Error("Which word?");
        return await webDefineImpl(a);
      }
      /* ---- v17: the GitHub tools, synced-settings-backed ---- */
      case "gh_list_repos": {
        const gh = await wsGetGh(env, chatKey);
        return await ghListReposImpl(gh);
      }
      case "gh_list_files": {
        const gh = await wsGetGh(env, chatKey);
        if (!gh || !gh.pat) throw new Error("No GitHub token connected — open the + button → GitHub repo to connect one.");
        return await ghListFilesImpl(env, gh, webNormalizeArgs(args) || {});
      }
      case "gh_read_file": {
        const gh = await wsGetGh(env, chatKey);
        if (!gh || !gh.pat) throw new Error("No GitHub token connected — open the + button → GitHub repo to connect one.");
        return await ghReadFileImpl(env, gh, webNormalizeArgs(args) || {});
      }
      case "gh_write_file": {
        const gh = await wsGetGh(env, chatKey);
        if (!gh || !gh.pat) throw new Error("No GitHub token connected — open the + button → GitHub repo to connect one.");
        return await ghWriteFileImpl(env, gh, webNormalizeArgs(args) || {});
      }
      case "gh_delete_file": {
        const gh = await wsGetGh(env, chatKey);
        if (!gh || !gh.pat) throw new Error("No GitHub token connected — open the + button → GitHub repo to connect one.");
        return await ghDeleteFileImpl(env, gh, webNormalizeArgs(args) || {});
      }
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

/* =====================================================================
   v18: THE RESPONSE ARCHIVE — "make sure the sync from the worker is
   EVERYTHING". Done jobs used to be deleted outright after 2h; the
   phone then found a 404, marked the response "interrupted — cut off"
   and tried to re-prompt the model, while the FILES (mirror, never
   pruned) still synced fine — the exact split outcome the user reported.
   Now the prune first ARCHIVES the job: the full byte buffer (copied
   row-for-row from the live chunk log) + the row's meta move into
   resp_archive/resp_chunks, which are NEVER pruned by TTL. /job/:id,
   /job/:id/status and /job/by-key all serve the archived record after
   the job rows are gone, so a phone returning hours or days later
   replays the exact same stream a live done job would have sent —
   snap-in sync, one pass, done. Only SYSTEM prunes archive: an explicit
   user removal (panel "remove"/"clear finished") deletes for real, and
   stopped/parked runs are never archived (the user cancelled; the
   round belongs to the phone). */
async function archiveJob(env, id) {
  try {
    const row = await getJobRow(env, id);
    if (!row || !row.chatKey) return false;       // no chat to sync back to
    const st = String(row.status);
    if (st !== "done" && st !== "failed") return false; // stopped = user cancelled; parked = the phone's round
    /* copy the buffer row-for-row (each live chunk row is already
       statement-sized; total is bounded by MAX_JOB_BYTES) */
    await runSQL(env,
      `INSERT OR REPLACE INTO resp_chunks (chat_key, job_id, idx, data) SELECT ?, ?, seq, data FROM chunks WHERE job = ? ORDER BY seq ASC`,
      [row.chatKey, id, id]);
    const meta = { ...(row.meta || {}) };
    meta.timing = { waitMs: row.waitMs, workMs: row.workMs, finishedAt: row.updatedAt };
    await runSQL(env,
      `INSERT OR REPLACE INTO resp_archive (chat_key, job_id, kind, status, bytes, meta, finished_at) VALUES (?,?,?,?,?,?,?)`,
      [row.chatKey, id, row.kind || "chat", st, row.bytes, JSON.stringify(meta), row.updatedAt]);
    /* retention: newest RESP_ARCHIVE_KEEP runs per chat; orphan chunks go too */
    await runSQL(env,
      `DELETE FROM resp_archive WHERE chat_key = ? AND job_id NOT IN (SELECT job_id FROM (SELECT job_id FROM resp_archive WHERE chat_key = ? ORDER BY finished_at DESC, job_id DESC LIMIT ?))`,
      [row.chatKey, row.chatKey, RESP_ARCHIVE_KEEP]);
    await runSQL(env,
      `DELETE FROM resp_chunks WHERE chat_key = ? AND job_id NOT IN (SELECT job_id FROM resp_archive WHERE chat_key = ?)`,
      [row.chatKey, row.chatKey]);
    return true;
  } catch (_) { return false; }
}
async function getArchiveRow(env, jobId) {
  try {
    const r = await getSQL(env, `SELECT * FROM resp_archive WHERE job_id = ? ORDER BY finished_at DESC LIMIT 1`, [jobId]);
    if (!r) return null;
    let meta = {};
    try { meta = r.meta ? JSON.parse(r.meta) : {}; } catch (_) {}
    return {
      jobId: r.job_id, chatKey: r.chat_key, kind: r.kind || "chat", status: String(r.status),
      bytes: Number(r.bytes) || 0, meta, finishedAt: Number(r.finished_at) || 0,
      waitMs: Number(meta.timing && meta.timing.waitMs) || 0,
      workMs: Number(meta.timing && meta.timing.workMs) || 0,
    };
  } catch (_) { return null; }
}
async function newestArchiveForChat(env, chatKey) {
  try {
    const r = await getSQL(env, `SELECT job_id FROM resp_archive WHERE chat_key = ? ORDER BY finished_at DESC, job_id DESC LIMIT 1`, [chatKey]);
    return r ? getArchiveRow(env, r.job_id) : null;
  } catch (_) { return null; }
}
/* the archived job's full buffer as a Response — byte-identical to what
   the live tail delivered, ending on the same terminal event the job
   finished with, so the app's parser closes it as a clean done stream */
async function archiveReplayResponse(env, arc) {
  let rows = [];
  try {
    rows = await allSQL(env, `SELECT data FROM resp_chunks WHERE chat_key = ? AND job_id = ? ORDER BY idx ASC`, [arc.chatKey, arc.jobId]);
  } catch (_) {}
  const enc = new TextEncoder();
  const parts = (rows || []).map(r => enc.encode(String(r.data)));
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  let off = 0;
  const body = new ReadableStream({
    start(c) {
      for (const p of parts) { try { c.enqueue(p); } catch (_) {} off += p.byteLength; }
      try { c.close(); } catch (_) {}
    },
  });
  return new Response(body, { status: 200, headers: relayHeaders(arc.meta && arc.meta.contentType, arc.jobId, { "X-Nexus-Offset": String(total), "X-Nexus-Archive": "1" }) });
}

/* v14: retire job rows OUTSIDE the pump (user stop / stop-all / parent
   retirement) — settles the wait/work meters in SQL so the row's final
   numbers stay honest, then marks it stopped and drops its secret. */
async function stopJobRows(env, ids, opts = {}) {
  const now = Date.now();
  /* v20: parent retirement must not overwrite a terminal status — a DONE
     parent stays done (the panel and by-key keep the honest state); only
     queued/streaming/parked rows are stoppable. The explicit user Stop
     (handleDelete) passes any: true — user intent overrides. */
  const guard = opts.any ? "" : " AND status IN ('queued','streaming','parked')";
  for (const id of ids) {
    try {
      await runSQL(env,
        `UPDATE jobs SET
           wait_ms = wait_ms + CASE WHEN wait_start > 0 THEN ? - wait_start ELSE 0 END,
           work_ms = work_ms + CASE WHEN work_start > 0 THEN ? - work_start ELSE 0 END,
           wait_start = 0, work_start = 0,
           status = 'stopped', heartbeat = 0, lock_token = NULL, updated_at = ?
         WHERE id = ?` + guard, [now, now, now, id]);
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

/* v19: the honest meters, forwarded IN the stream itself. Every terminal
   chat job appends one final event before its status flips:
     data: {"nexus_timing":{"waitMs":…,"workMs":…,"attempts":…,"finishedAt":…}}
   Ordering rule (same as failJob's error chunk): the event must land in
   the buffer BEFORE the status flips, so the D1-polling tail delivers it
   before it is allowed to close. From there it rides EVERYTHING — the
   live tail, any re-attach, the offset replay, and the v18 archive copy
   (chunks are archived row-for-row) — so the phone's timing chip reads
   the WORKER's clock (the only clock that saw the whole job) whether it
   watched live, left and came back, or snapped in days later. Images
   jobs never get one: their replay is a single JSON body, and a stray
   line would corrupt the app's JSON.parse. Old apps ignore the event
   (unknown nexus_* JSON is skipped by their line parsers). */
async function appendTimingChunk(env, id, meters) {
  try {
    const row = await getSQL(env, `SELECT kind, attempts, status, created_at, updated_at, heartbeat, first_byte, wait_ms, work_ms, work_start, wait_start FROM jobs WHERE id = ?`, [id]);
    if (!row || String(row.kind) !== "chat") return false;
    let waitMs, workMs;
    if (meters && (meters.waitMs != null || meters.workMs != null)) {
      waitMs = Math.max(0, Number(meters.waitMs) || 0);
      workMs = Math.max(0, Number(meters.workMs) || 0);
    } else {
      const tw = liveWaitWork(rowToJob(row), Date.now());
      waitMs = tw.waitedMs; workMs = tw.workMs;
    }
    const payload = "data: " + JSON.stringify({ nexus_timing: { waitMs: Math.round(waitMs), workMs: Math.round(workMs), attempts: Number(row.attempts) || 0, finishedAt: Date.now() } }) + "\n\n";
    const byteLen = new TextEncoder().encode(payload).length;
    const r = await getSQL(env, `SELECT COALESCE(MAX(seq), -1) AS mx FROM chunks WHERE job = ?`, [id]);
    const seq = (r ? Number(r.mx) : -1) + 1;
    await runSQL(env, `INSERT INTO chunks (job, seq, bytes, data) VALUES (?, ?, ?, ?)`, [id, seq, byteLen, payload]);
    await runSQL(env, `UPDATE jobs SET bytes = bytes + ?, updated_at = ? WHERE id = ?`, [byteLen, Date.now(), id]);
    return true;
  } catch (_) { return false; }
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
  if (TUN("debugPark", 0)) console.log("[rebuild] live.total=" + live.total + " job.bytes=" + job.bytes + " liveChunks=" + (live.chunks || []).length + " → sawToolCalls=" + parser.sawToolCalls + " toolAcc=" + Object.keys(parser.toolAcc).length + " contentLen=" + parser.contentText.length);
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
      if (parseOk && args && typeof args === "object" && !Array.isArray(args)) {
        const resolvedProbe = SERVER_TOOL_ALIASES[c.name] || c.name;
        if (WEB_TOOLS.includes(resolvedProbe)) args = webNormalizeArgs(args);
        else args = fsNormalizeArgs(args);
      }
      let res;
      if (!parseOk) {
        res = { text: "The arguments for " + c.name + " were not valid JSON (truncated or malformed) and the call was NOT executed. Retry with complete, valid JSON — if you keep hitting the length limit, work in smaller pieces (e.g. write_file with less content, or several edit_file calls).", label: "Malformed call · " + c.name, sub: "invalid arguments", icon: "alert", failed: true };
      } else {
        res = await runServerTool(env, job.chatKey, c.name, args || {});
        const resolved = SERVER_TOOL_ALIASES[c.name] || c.name;
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
    if (await roundAllServerExecutable(env, job.chatKey, calls)) {
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
  /* v21: fatal-flap retries (a provider that already accepted this body
     once earns two re-tries when it flaps a 400/404/422 on the re-request)
     and context rescues (halve the wire budget on a length-flavored 400 —
     CTX_RESCUE_MAX bounds it, then the honest park). ctxBudget comes from
     the app's X-Nexus-Context hint (meta.contextTokens) or a previous
     rescue (meta.ctxBudget, inherited across driver swaps). */
  let fatalRetries = 0;
  let contextRescues = 0;
  let ctxBudget = Math.max(0, Math.floor(Number(job.meta && (job.meta.ctxBudget || job.meta.contextTokens)) || 0));
  try {
    while (true) {
      if (signal.aborted) return; // killed like the runtime would — leave D1 stale on purpose
      if (Date.now() > deadline) { gaveUp = true; break; }
      if (TUN("debugPark", 0)) console.log("[loop] top: sawToolCalls=" + parser.sawToolCalls + " finishSeen=" + parser.finishSeen + " sawData=" + parser.sawData + " bytes=" + totalBytes + " toolAcc=" + Object.keys(parser.toolAcc).length + " attempt=" + attempts + " ctxBudget=" + ctxBudget + " contentLen=" + parser.contentText.length);

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
        if (TUN("debugPark", 0)) console.log("[park] tools cut: serverRoundsOn=" + serverRoundsOn() + " calls=" + Object.keys(parser.toolAcc).length + " attempt=" + attempts);
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
        await parkJob(env, jobId, token, tsettle, {
          reason: "tools",
          detail: "tool round for the device: " + (parser.toolCalls() || []).map(c => c.name).filter(Boolean).join(", ").slice(0, 240),
        }); liveClose(live); return;
      }
      if (job.kind !== "chat" && totalBytes > 0 && !parser.finishSeen) { await parkJob(env, jobId, token, tsettle, { reason: "images-cut", detail: "image body arrived incomplete" }); liveClose(live); return; }
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
            { role: "assistant", content: capPartial(parser.contentText.slice(parser.roundBase), partialCapFor(ctxBudget)) },
            { role: "user", content: CONTINUE_INSTRUCTION },
          ]),
          stream: true,
        };
      } else if (job.kind !== "chat" || !parser.sawData) body = job.req; // plain re-issue
      else body = {
        ...job.req,
        messages: (job.req.messages || []).concat([
          { role: "assistant", content: capPartial(parser.contentText, partialCapFor(ctxBudget)) },
          { role: "user", content: CONTINUE_INSTRUCTION },
        ]),
        stream: true,
      };
      /* v21: proactive fit — the WIRE request respects the model's window
         (the app's hint, or the halved budget a rescue settled on). The
         durable job.req keeps every round; only what we SEND shrinks. */
      if (job.kind === "chat" && ctxBudget > 0) {
        const fit = fitRequestToBudget(body, Math.floor(ctxBudget * CTX_FIT_FILL));
        if (fit.trimmed) body = fit.body;
      }

      const authRow = await getSQL(env, `SELECT auth FROM secrets WHERE job = ?`, [jobId]);
      const fwd = Object.assign({}, job.meta.fwd || {});
      if (authRow && authRow.auth) fwd.authorization = authRow.auth;

      const ac = new AbortController();
      const onOuterAbort = () => { try { ac.abort(); } catch (_) {} };
      signal.addEventListener("abort", onOuterAbort, { once: true });
      /* v19: phase-aware watchdog — the limit follows the CURRENT silence
         (connect / accepted / streaming, see the constants above), so a
         slow model waiting out a provider line or thinking silently
         before its first token is no longer killed by the old flat 60s
         abort loop (the exact "slower models time out and cut off"
         report). Any body byte is a beat and promotes the phase.
         v21: a REASONING-ONLY stream that goes quiet is a thinking model
         mid-think (qwen's norm), not a dead socket — until the attempt's
         first CONTENT or TOOL byte lands, silence gets the 3-minute
         firstChunk window instead of the 90s kill. */
      let lastBeat = Date.now();
      let wdPhase = "connect"; // connect → accepted → streaming
      const contentBefore = parser.contentText.length;
      let attemptProducedBody = false;
      const wd = setInterval(() => {
        const limit = wdPhase === "connect" ? UPSTREAM_CONNECT_MS
          : (wdPhase === "accepted" ? UPSTREAM_FIRST_CHUNK_MS
          : (attemptProducedBody ? UPSTREAM_STALL_MS : UPSTREAM_FIRST_CHUNK_MS));
        if (Date.now() - lastBeat > limit) { try { ac.abort(); } catch (_) {} }
      }, TUN("wdTickMs", 5000));

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
           the work meter starts (thinking, text, tool args all count).
           v19: headers back = a watchdog beat + phase promotion — the
           request is OUT of the provider line, but the model may still
           sit silent before its first token (thinking), which is the
           firstChunk window, not a stall. ---- */
        settleWait();
        workStart = Date.now();
        lastBeat = Date.now();
        wdPhase = "accepted";
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
              wdPhase = "streaming"; // bytes flowing — silence from here is a dead socket, 90s
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
              if (!attemptProducedBody && (parser.contentText.length > contentBefore || parser.sawToolCalls)) attemptProducedBody = true;
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
            if (await roundAllServerExecutable(env, job.chatKey, calls)) {
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
      /* v20: providers wrap their reason as JSON — surface the actual
         error.message, not the raw body (the park's detail + the replay's
         error event both carry it; the phone shows WHY in one line) */
      try {
        const parsed = JSON.parse(message);
        if (parsed && parsed.error && parsed.error.message) message = String(parsed.error.message).slice(0, 300);
        else if (parsed && parsed.message) message = String(parsed.message).slice(0, 300);
      } catch (_) {}

      const fatal = [400, 401, 403, 404, 422].includes(status);
      if (fatal && totalBytes === 0) {
        await failJob(env, jobId, token, "upstream " + status + ": " + message,
          { errorEvent: { message: message, code: status }, kind: job.kind, live, t: tsettle });
        return;
      }
      if (fatal) {
        /* v21 CONTEXT RESCUE: a 400 that smells like "context length
           exceeded" means the WIRE request outgrew the model's window —
           agent rounds + tool results + the continuation partial grow
           for hours while the durable conversation never shrinks. Parse
           the provider's OWN limit when it states one ("maximum context
           length is 4096 tokens"), else halve what we actually sent —
           the app's hint can simply be optimistic (outdated catalog,
           wrong fill). Trim the wire body to it and re-ask IMMEDIATELY
           (a refusal is instant; no line wait to sleep through). The
           durable job.req is untouched — only what we SEND shrinks.
           CTX_RESCUE_MAX bounds the attempts; then the honest park. */
        if (isContextLengthError(message) && contextRescues < CTX_RESCUE_MAX) {
          contextRescues++;
          const estNow = (body && Array.isArray(body.messages)) ? msgsTokens(body.messages) : 0;
          const stated = String(message).match(/max(?:imum)?[^0-9]{0,60}([0-9,]{3,})\s*tokens?/i);
          const statedN = stated ? Number(stated[1].replace(/,/g, "")) : 0;
          let next;
          if (statedN >= 200) next = Math.floor(statedN * 0.9); /* trust the provider's own number (small windows are real) */
          else {
            /* no stated limit: halve the SMALLER of the hint and what we
               actually sent (a hint above the est is not the constraint);
               the floor never exceeds what we sent — a tiny est is the
               provider's real window, not absurdity */
            const cur = ctxBudget > 0 ? Math.min(ctxBudget, estNow || ctxBudget) : (estNow || 32000);
            const floor = Math.min(CTX_MIN_BUDGET, estNow || CTX_MIN_BUDGET);
            next = Math.max(Math.max(256, floor), Math.floor(cur / 2));
          }
          ctxBudget = Math.max(180, next);
          attempts++;
          try {
            job.meta = { ...job.meta, ctxBudget };
            await lockWrite(env, jobId, token, { meta: JSON.stringify(job.meta), attempts, updated_at: Date.now(), ...timingFields() });
          } catch (_) {}
          if (TUN("debugPark", 0)) console.log("[ctx-rescue] " + contextRescues + " → budget " + ctxBudget + " tokens (est was " + estNow + ", stated " + (statedN || "n/a") + ")");
          separatorNeeded = totalBytes > 0; // the re-ask must start line-aligned
          continue;
        }
        /* v21 PROVIDER FLAP: a fatal on a RETRY of a request this provider
           already ACCEPTED (bytes streamed on an earlier attempt) is often
           a route hiccup, not a verdict — free-tier qwen routes flap
           400/404 "provider unavailable" all the time. Two short
           backed-off re-tries before the park. 401/403 skip this: a
           revoked key does not heal in seconds, so park fast + honest. */
        if (status !== 401 && status !== 403 && fatalRetries < FATAL_RETRY_MAX) {
          fatalRetries++;
          attempts++; inlineAttempts++;
          if (!waitStart) waitStart = Date.now();
          try { await lockWrite(env, jobId, token, { attempts, updated_at: Date.now(), ...timingFields() }); } catch (_) {}
          if (inlineAttempts >= maxInline) { gaveUp = true; break; }
          await pacedSleep(env, jobId, pace, attempts, signal);
          separatorNeeded = totalBytes > 0;
          continue;
        }
        /* v20: an upstream refusal mid-run parks WITH the honest error
           event in the buffer — the phone's replay shows WHY (bad key,
           model route, context) instead of a mystery "cut off", and
           meta.park carries it for the requests panel. v21: the detail
           also says what the worker already tried, and meta.error rides
           /jobs so the panel shows the provider's own words. */
        const tried = (fatalRetries ? " (after " + fatalRetries + " fatal retr" + (fatalRetries === 1 ? "y" : "ies") + ")" : "")
          + (contextRescues ? " — context trimmed " + contextRescues + "x, still refused" : "");
        await parkJob(env, jobId, token, tsettle, {
          reason: "upstream-fatal",
          detail: ("upstream " + status + ": " + message + tried).slice(0, 300),
          error: { message: message, code: status },
        }); liveClose(live); return;
      }
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
  /* v19: the meters ride the stream itself — BEFORE the status flip (the
     same ordering rule as failJob's error chunk: the polling tail must
     see the event before it is allowed to close). Live tails, re-attaches
     and the v18 archive replay all carry the worker's clock. */
  try { await appendTimingChunk(env, id, tv); } catch (_) {}
  try {
    const fields = { status: "done", finish: 1, heartbeat: 0, updated_at: now, lock_token: null };
    if (tv) Object.assign(fields, { wait_ms: tv.waitMs, work_ms: tv.workMs, wait_start: 0, work_start: 0 });
    await lockWrite(env, id, token, fields);
    await runSQL(env, `DELETE FROM secrets WHERE job = ?`, [id]);
  } catch (_) {}
  liveClose(live);
}
/* v20: parkJob writes WHY the job parked into meta.park and — when the
   reason is an upstream refusal — puts the honest error event into the
   buffer BEFORE the status flip (same ordering rule as failJob: the
   polling tail must see the event before it is allowed to close). A
   tools-park appends NO error (it is a handoff, not a failure) but does
   ride the v19 timing chunk so the phone sees the meters. The reasons:
     tools        — the round's tool calls are the phone's to execute
                    (no mirror, or the cut hit mid-round)
     images-cut   — an image body that arrived incomplete
     upstream-fatal — the provider refused mid-run (401/403/404/422...);
                    the phone replays the partial, sees the error event,
                    and can retry with fresh credentials/model */
async function parkJob(env, id, token, t, park) {
  const now = Date.now();
  const tv = t ? t() : null;
  /* bytes FIRST when there is an error event — parked buffer replays must
     carry the honest reason the same way failed ones do */
  if (park && park.error) {
    try { await appendErrorChunk(env, id, "chat", park.error.message, park.error.code); } catch (_) {}
  }
  try { await appendTimingChunk(env, id, tv); } catch (_) {}
  try {
    const fields = { status: "parked", heartbeat: 0, updated_at: now, lock_token: null };
    if (tv) Object.assign(fields, { wait_ms: tv.waitMs, work_ms: tv.workMs, wait_start: 0, work_start: 0 });
    if (park && park.reason) {
      const row = await getJobRow(env, id);
      if (row) {
        const meta = row.meta || {};
        meta.park = { reason: String(park.reason).slice(0, 40), detail: String(park.detail || "").slice(0, 300), at: now };
        /* v21: an error park also rides meta.error — /jobs renders the
           provider's actual message under the row and /status forwards
           it, so "Parked (error)" carries its one-line diagnosis
           everywhere the row is shown */
        if (park.error) meta.error = String(park.detail || park.error.message || "").slice(0, 300);
        fields.meta = JSON.stringify(meta);
      }
    }
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
  /* v19: a failed run's meters ride the stream too — the phone's chip
     shows what the worker actually spent before giving up (chat jobs
     only; appendTimingChunk guards images itself) */
  try { await appendTimingChunk(env, id, tv); } catch (_) {}
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
     execute this chat's tool rounds server-side (X-Nexus-WS: 1 after
     a successful syncWorkspace — v17: ANY worker-executable tool counts,
     not just file tools). Old apps never send the header. */
  const wsSync = request.headers.get("X-Nexus-WS") === "1";
  /* v21: the app forwards the model's context budget (the same number its
     own contextTrim uses — context_length × fill). The worker's server
     rounds and continuations trim the WIRE request to it, so hour-long
     agent runs stop outgrowing the window and 400ing into a park. Old
     apps never send it; their jobs still get the reactive rescue. */
  const ctxHint = Math.floor(Math.abs(Number(request.headers.get("X-Nexus-Context")) || 0));
  const serverTools = !!(wsSync && chatKey && pathname === "/chat" && requestHasServerTools(parsed));

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
  if (ctxHint >= 2000) meta.contextTokens = ctxHint; // v21: the app's context budget (floor: a hint below 2k tokens is junk)
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
    /* v17: the app rides its GitHub connection (PAT + the chat's resolved
       repos) so gh_* rounds can commit while the phone is gone. Sanitized
       hard, stored with the mirror (same trust level as the job's own
       Authorization key in `secrets`), refreshed on every sync. An empty
       pat CLEARS it — a disconnected GitHub disconnects the worker too.
       AFTER the ws_meta upsert above so the row always exists. */
    if (body.gh !== undefined) {
      let ghOut = null;
      try {
        const g = (body.gh && typeof body.gh === "object" && !Array.isArray(body.gh)) ? body.gh : {};
        const pat = String(g.pat || "").trim().slice(0, 200);
        const repos = Array.isArray(g.repos) ? g.repos.slice(0, 20).map(x => {
          if (!x || typeof x !== "object") return null;
          const owner = String(x.owner || "").slice(0, 80), repo = String(x.repo || "").slice(0, 100);
          if (!owner || !repo) return null;
          return { owner, repo, fullName: String(x.fullName || owner + "/" + repo).slice(0, 200), branch: String(x.branch || "main").slice(0, 100), allowEdit: !!x.allowEdit };
        }).filter(Boolean) : [];
        if (pat && repos.length) ghOut = JSON.stringify({ pat, repos });
      } catch (_) { ghOut = null; }
      try { await runSQL(env, `UPDATE ws_meta SET gh = ? WHERE chat_key = ?`, [ghOut, chatKey]); } catch (_) {}
    }
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
  if (!job) {
    /* v18: the job rows were pruned (done past its replay window) — but a
       FINISHED run is never really gone: the archive holds the full buffer.
       Replay it exactly like a live done job so a returning phone snaps to
       the final state instead of reading 404 as "interrupted — cut off". */
    const arc = await getArchiveRow(env, id);
    if (arc) return archiveReplayResponse(env, arc);
    return json({ error: "job not found (expired or relay restarted)" }, 404);
  }
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
  if (!job) {
    /* v18: an archived finished job still answers status — the app's snap
       decision ("is this job terminal?") and its wait/work timing chips
       read this, so an away-and-back run keeps its honest numbers */
    const arc = await getArchiveRow(env, id);
    if (arc) {
      const st = String(arc.status);
      return json({
        ok: true, id: arc.jobId, jobId: arc.jobId, kind: arc.kind, status: st,
        attempts: Number(arc.meta && arc.meta.attempts) || 0,
        waitedMs: arc.waitMs, workMs: arc.workMs, bytes: arc.bytes,
        working: false, waiting: false, nextRetryAt: 0,
        serverTools: !!(arc.meta && arc.meta.serverTools),
        serverRounds: Number(arc.meta && arc.meta.serverRounds) || 0,
        createdAt: Number(arc.meta && arc.meta.createdAt) || arc.finishedAt,
        updatedAt: arc.finishedAt, finishedAt: arc.finishedAt, archived: true, v: WORKER_VERSION,
      });
    }
    return json({ error: "job not found (expired or relay restarted)", gone: true }, 404);
  }
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
  if (job.meta && job.meta.park) { // v20: the park reason rides the status
    out.parkReason = String(job.meta.park.reason || "");
    out.parkDetail = String(job.meta.park.detail || "");
    out.parkedAt = Number(job.meta.park.at) || 0;
  }
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
      rows = await allSQL(env, `SELECT id, kind, status, bytes, created_at, meta FROM jobs WHERE chat_key = ? ORDER BY created_at DESC LIMIT 8`, [key]);
    } catch (err) { return json({ error: "key lookup failed on the database", retry: true }, 503); }
  } else {
    return json({ error: "no job for this key (passthrough mode)" }, 404);
  }
  maybeWorkAny(env, ctx); // a returning app just asked — drive due work now
  const now = Date.now();
  for (const r of rows) {
    const age = now - Number(r.created_at);
    const st = String(r.status);
    if (["queued", "streaming"].includes(st) && age < JOB_TTL_MS) {
      return json({ ok: true, jobId: r.id, id: r.id, kind: r.kind, status: st, bytes: Number(r.bytes) });
    }
    /* v20: a parked job is HELD FOR THIS DEVICE — it stays discoverable
    for PARKED_KEEP_MS (24h), not the 30-minute live window. "Left for a
    few hours" used to fall outside the window: by-key skipped the parked
    row, the app never re-attached, and the chat read "cut off" while the
    round sat on the worker waiting for it. */
    if (st === "parked" && age < parkedKeepMs()) {
      let parkReason = "tools", parkDetail = "";
      try { const meta = r.meta ? JSON.parse(r.meta) : null; if (meta && meta.park) { parkReason = String(meta.park.reason || "tools"); parkDetail = String(meta.park.detail || ""); } } catch (_) {}
      return json({ ok: true, jobId: r.id, id: r.id, kind: r.kind, status: st, bytes: Number(r.bytes), parkReason, parkDetail: parkDetail.slice(0, 200) });
    }
    if (st === "done" && age < DONE_TTL_MS) {
      return json({ ok: true, jobId: r.id, id: r.id, kind: r.kind, status: st, bytes: Number(r.bytes) });
    }
    if ((st === "failed" || st === "stopped") && age < 120000) {
      return json({ ok: true, jobId: r.id, id: r.id, kind: r.kind, status: st, bytes: Number(r.bytes) });
    }
  }
  /* v18: no LIVE row qualifies — but the chat's newest FINISHED response
     may still live in the archive (the job rows were pruned hours or days
     ago). Return it so a returning phone rebuilds the full response
     instead of reading 404 as "nothing happened". */
  const arc = await newestArchiveForChat(env, key);
  if (arc) {
    const out = { ok: true, jobId: arc.jobId, id: arc.jobId, kind: arc.kind, status: String(arc.status), bytes: arc.bytes, archived: true, finishedAt: arc.finishedAt };
    if (arc.meta && arc.meta.error) out.error = String(arc.meta.error); // the honest failure reason (the phone syncs the error, not "interrupted")
    return json(out);
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
       pruned by TTL shortly after. v20 any:true — an explicit user Stop
       also retires a PARKED round (its buffer goes with it; the chat's
       local continue protocol takes over if the user resumes) */
    try { await stopJobRows(env, [id], { any: true }); } catch (_) {}
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
    let parkReason = "", parkDetail = "";
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
        if (meta.park) { // v20: why this job is waiting for the device
          parkReason = String(meta.park.reason || "");
          parkDetail = String(meta.park.detail || "");
        }
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
      parkReason, parkDetail,
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
    /* v20: two liveness rules changed here.
       (1) A row with a FRESH heartbeat has a live pump driving it — it is
           NEVER swept, no matter its age. A big slow model can stream for
           40+ minutes; the old created_at-only sweep failed it mid-run
           ("time out and cut off", the slow-model bug's second half).
       (2) PARKED rows keep for PARKED_KEEP_MS (24h) — they are held FOR
           the device's return, so they outlive done/failed/stopped rows. */
    /* v20 fix: heartbeat 0 is the canonical "no live pump" marker (every
       park/fail/done/release clears it) — `heartbeat < now-stale` alone can
       NEVER match 0, so parked + released rows were unprunable. A row is
       pumpless when heartbeat IS 0 OR has gone stale. The catch-all is
       status-scoped too: queued/streaming rows belong to the fail-sweep
       (which writes the honest error event BEFORE failing them), and
       PARKED rows outlive everything for parkedKeepMs — a bare age clause
       deleted them at JOB_TTL+DONE_TTL (4h in production), INSIDE the 24h
       the park was promised. */
    const dead = await allSQL(env,
      `SELECT id FROM jobs WHERE (COALESCE(heartbeat, 0) = 0 OR COALESCE(heartbeat, 0) < ?) AND (
         (status IN ('done','failed','stopped') AND updated_at < ?)
         OR (status = 'parked' AND updated_at < ?)
         OR (status NOT IN ('done','failed','stopped','parked','queued','streaming') AND created_at < ?))`,
      [now - 4 * STALE_LOCK_MS, now - DONE_TTL_MS, now - parkedKeepMs(), now - JOB_TTL_MS - DONE_TTL_MS]);
    /* v18: a pruned FINISHED run is archived FIRST — its response outlives
       its job rows (the away-and-back sync reads the archive) */
    for (const r of dead) { await archiveJob(env, r.id); await deleteJobRows(env, r.id); }
    /* fail-sweep: only jobs with NO live pump (heartbeat 0 = released or
       never driven; a stale heartbeat = a dead driver) AND past the TTL —
       an actively-streaming slow model is exempt (rule 1). v20 fix: this
       moved from a blind UPDATE to an honest failJob-shaped write — the
       error event lands in the buffer BEFORE the status flip (the tail
       replays WHY, not a mystery 404) and meta.error rides /status. */
    try {
      const sweep = await allSQL(env,
        `SELECT id FROM jobs WHERE status IN ('queued','streaming') AND created_at < ? AND (COALESCE(heartbeat, 0) = 0 OR COALESCE(heartbeat, 0) < ?)`,
        [now - JOB_TTL_MS, now - 4 * STALE_LOCK_MS]);
      for (const r of sweep) {
        try {
          await appendErrorChunk(env, r.id, "chat",
            "The worker gave up on this request — it sat with no driver for over " + Math.max(1, Math.round(JOB_TTL_MS / 60000)) + " minutes. Resume from the app to continue it.", 599);
        } catch (_) {}
        try {
          const row = await getJobRow(env, r.id);
          const meta = (row && row.meta) ? row.meta : {};
          meta.error = "worker TTL exceeded — no driver progress";
          await runSQL(env,
            `UPDATE jobs SET status = 'failed', heartbeat = 0, lock_token = NULL, updated_at = ?, meta = ? WHERE id = ? AND status IN ('queued','streaming')`,
            [now, JSON.stringify(meta), r.id]);
        } catch (_) {}
      }
    } catch (_) {}
    await runSQL(env, `DELETE FROM secrets WHERE job NOT IN (SELECT id FROM jobs)`);
    const total = await getSQL(env, `SELECT COUNT(*) AS n FROM jobs`);
    if (total && Number(total.n) > MAX_TOTAL_JOBS) {
      const old = await allSQL(env, `SELECT id FROM jobs WHERE status IN ('done','stopped','failed','parked') ORDER BY updated_at ASC LIMIT ?`, [Number(total.n) - MAX_TOTAL_JOBS]);
      for (const r of old) { await archiveJob(env, r.id); await deleteJobRows(env, r.id); }
    }
    const n = await getSQL(env, `SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','streaming')`);
    if (n && Number(n.n) > MAX_ACTIVE_JOBS) {
      const old = await allSQL(env, `SELECT id FROM jobs WHERE status IN ('done','stopped') ORDER BY updated_at ASC LIMIT ?`, [Number(n.n) - MAX_ACTIVE_JOBS]);
      for (const r of old) { await archiveJob(env, r.id); await deleteJobRows(env, r.id); }
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

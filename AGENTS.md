# Nexus AI Pro

Two artifacts, no build step:

- `Nexusaipro.html` — the entire single-file app (HTML + CSS + inline JS). ~500KB.
- `worker.js` — a Cloudflare Worker relay (`wrangler.toml`, D1 binding `DB`, cron `* * * * *`).

The app talks to OpenRouter directly, or through the worker when a relay URL is set
and the "Use the worker" toggle is on (`relayOn()`).

## Worker architecture (v7)

The worker turns a streaming chat/image request into a **durable job**:

1. `POST /chat` (or `/images`) creates a `jobs` row and streams via `liveSubscriber`.
2. A pump (`pumpLoop`) drives the upstream request inside `ctx.waitUntil`, persisting
   every byte to the `chunks` table. It survives the client disconnecting — that is
   what makes "send a prompt, close the app, come back to the finished answer" work.
3. Reconnects re-read the chunk log byte-exactly: `GET /job/:id?offset=N`.
4. `GET /job/by-client?client=<key>` finds a job by the app's client key for the case
   where the app died before it ever saw the `X-Nexus-Job` header. **It must honor
   `?offset` too** — otherwise re-attach replays bytes the client already consumed and
   duplicates text in the final answer.
5. A sent-but-unseen request is de-duplicated: a POST carrying a `x-nexus-client` that
   already has a live job reuses that job instead of starting a second generation.

### Structured status events

Alongside the human-readable SSE comment (`: nexus upstream 429 — re-requesting…`) the
pump emits a machine-readable twin, emitted directly so the literal prefix is stable:

```
: nexus-status {"state":"waiting","attempt":3,"max":24,"waitMs":8000,"reason":"upstream 429",...}
```

`state` is `waiting | working | continuing`. This exists because the app used to paint
"Thinking…" for all three, so a rate-limited run looked like a frozen thought. The app
parses it in `readStream` and drives `statusForRun`. `waitedMs` / `workMs` are the
cumulative wait-in-line vs actually-generating split; `waited_ms` and `work_ms` are
persisted to D1 so a reconnect or a fresh isolate keeps the honest totals. When a job is
never rate limited `waitedMs` stays 0 and the app hides the wait figure.

### Migrations

`ensureSchema` runs `ALTER TABLE jobs ADD COLUMN ...` inside `try/catch` every boot —
a no-op once the column exists. Add new columns the same way so pre-existing databases
keep working.

## App conventions

- `state.runs` is a `Map<chatId, run>` — multiple chats stream in parallel. Nothing may
  use a single global "current run" variable.
- `statusForRun(run)` / `waitWorkFor(run)` / `waitWorkHtml(run)` read `run.liveStatus`
  and `run.waitedMs` / `run.workMs`. **Any code that records a wait must write those to
  the run**, not to a side object — a local accumulator that only set its own
  `liveStatus` is exactly the bug that made a worker-off rate limit still say "Thinking…".
- `persistInflight` writes the vault record (content, tool calls, job id, client key)
  to IndexedDB + a capped localStorage fallback; `recoverInflight` replays it on load.
- Unread-done green dot: `markChatUnread` / `clearChatUnread` / `chatHasUnread`, with
  `chat.unreadDoneAt` persisting across reloads.

## Tests

`node test/run.mjs` (or `npm test`) runs all three suites against the real `worker.js`
via an in-memory D1 stub:

- `test/e2e.mjs` — status contract, wait/work split, job reuse, headers, health digest.
- `test/resume.mjs` — disconnect/reconnect, byte-exact resume, by-client + offset, and
  the send-then-immediately-close case.
- `test/app-status.mjs` — extracts the real UI functions out of `Nexusaipro.html` and
  exercises them (the logic is not mocked).

`test/d1-stub.mjs` binds `?` placeholders positionally; keep that property when editing
it, or queries comparing the same column twice (like `prune`'s dead-job test) will
silently treat live rows as dead.

Syntax-only checks: `node --check worker.js` and, for the app,
`node --check` on the concatenated `<script>` bodies.

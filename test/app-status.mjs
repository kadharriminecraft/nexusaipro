/* Verifies the app-side v7 UI logic by extracting the REAL functions out of
   Nexusaipro.html and exercising them (the logic itself is not mocked — we
   eval the shipped source). Covers:
     - a rate-limited run says "Waiting in line", never a bare "Thinking…"
     - the attempt count is shown so the user sees how many tries it made
     - the wait chip appears only when there WAS a wait
     - the worker-off (direct) accumulator publishes into run.liveStatus
   Run: node test/app-status.mjs
*/
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../Nexusaipro.html", import.meta.url), "utf8");

function extract(name) {
  const start = html.indexOf("function " + name + "(");
  if (start < 0) throw new Error("missing function " + name);
  const i = html.indexOf("{", start);
  let depth = 0;
  for (let j = i; j < html.length; j++) {
    if (html[j] === "{") depth++;
    else if (html[j] === "}") { depth--; if (depth === 0) return html.slice(start, j + 1); }
  }
  throw new Error("unbalanced braces in " + name);
}

const src = ["fmtElapsed", "statusForRun", "waitWorkFor", "waitWorkHtml"]
  .map(extract).join("\n");

const ic = () => "";
const escapeAttr = s => String(s);
const factory = new Function("ic", "escapeAttr", src + "\nreturn { statusForRun, waitWorkFor, waitWorkHtml, fmtElapsed };");
const { statusForRun, waitWorkFor, waitWorkHtml } = factory(ic, escapeAttr);

const results = [];
const check = (name, ok, extra) => {
  results.push({ name, ok: !!ok, extra });
  console.log((ok ? "PASS " : "FAIL ") + name + (extra != null ? "  " + extra : ""));
};

/* 1. rate-limited run → "Waiting in line" with attempt count + retry delay */
const waiting = statusForRun({ liveStatus: { state: "waiting", attempt: 3, max: 24, waitMs: 8000, rateLimited: true, code: 429, waitedMs: 21000 } });
check("waiting says 'Waiting in line'", /Waiting in line/.test(waiting.text), waiting.text);
check("waiting names the rate limit", /rate limited/.test(waiting.text), waiting.text);
check("waiting shows the attempt count", /attempt 3\/24/.test(waiting.text), waiting.text);
check("waiting shows the retry delay", /retry in ~8s/.test(waiting.text), waiting.text);
check("waiting is a warn state", waiting.kind === "warn", waiting.kind);
check("waiting does NOT say Thinking", !/Thinking/.test(waiting.text), waiting.text);

/* 2. a busy (non-429) provider is still reported honestly */
const busy = statusForRun({ liveStatus: { state: "waiting", attempt: 2, max: 24, waitMs: 4000, code: 503 } });
check("busy provider says 'provider busy'", /provider busy/.test(busy.text), busy.text);

/* 3. "working" is the ONLY state that may say Thinking */
const working = statusForRun({ liveStatus: { state: "working", attempt: 1, max: 24 } });
check("working says Thinking", /Thinking/.test(working.text), working.text);
check("working is not a warn state", working.kind === "", working.kind);

/* 4. no status yet → legacy Thinking default */
check("no status defaults to Thinking", /Thinking/.test(statusForRun({}).text));

/* 5. continuation is reported distinctly */
const cont = statusForRun({ liveStatus: { state: "continuing", attempt: 2, max: 24 } });
check("continuing is labelled", /Continuing the answer/.test(cont.text), cont.text);

/* 6. wait chip only when there WAS a wait (never-rate-limited run hides it) */
const withWait = waitWorkHtml({ waitedMs: 12000, workMs: 47000, liveStatus: { state: "working" } });
check("wait chip appears when waitedMs>0", /wait 12s/.test(withWait), withWait);
check("work chip appears with work time", /work 47s/.test(withWait), withWait);
const noWait = waitWorkHtml({ waitedMs: 0, workMs: 47000, liveStatus: { state: "working" } });
check("wait chip hidden when never rate limited", !/wait /.test(noWait), noWait);
check("work chip still shown without a wait", /work 47s/.test(noWait), noWait);

/* 7. live work estimate while still generating (no banked workMs yet) */
const live = waitWorkFor({ waitedMs: 5000, workStartAt: Date.now() - 3000, liveStatus: { state: "working" } });
check("live work estimate is positive", live.workMs > 0, "workMs=" + live.workMs);
check("live waitedMs carried through", live.waitedMs === 5000, "waitedMs=" + live.waitedMs);

/* 8. the worker-off (direct) accumulator must publish into run.liveStatus,
      otherwise a locally-observed rate limit still painted a bare Thinking */
const from = html.indexOf("const noteWait = (waitMs");
const to = html.indexOf("while (true) {", from);
if (from < 0 || to < 0) throw new Error("could not locate noteWait in Nexusaipro.html");
const noteSrc = html.slice(from, to);
const makeNoteWait = stats => new Function("stats", "statusForRun", "Date", "Math",
  noteSrc + "\nreturn noteWait;")(stats, statusForRun, Date, Math);

const fakeRun = { genStart: Date.now() - 1000 };
const fakeStats = { waitedMs: 0, attempts: 1, max: 1, since: fakeRun.genStart, run: fakeRun, onUpdate: () => {} };
makeNoteWait(fakeStats)(7000, true, "provider rate limited", 2, 24);
check("direct noteWait publishes run.liveStatus", fakeRun.liveStatus && fakeRun.liveStatus.state === "waiting", JSON.stringify(fakeRun.liveStatus));
check("direct noteWait accumulates waitedMs on the run", fakeRun.waitedMs === 7000, "run.waitedMs=" + fakeRun.waitedMs);
check("direct noteWait tracks attempt + max on the run", fakeRun.attempts === 2 && fakeRun.maxAttempts === 24, "attempts=" + fakeRun.attempts + " max=" + fakeRun.maxAttempts);
const directText = statusForRun(fakeRun).text;
check("direct path renders the waiting text (not Thinking)", /Waiting in line/.test(directText), directText);

/* 9. a second wait accumulates rather than replacing the first */
makeNoteWait(fakeStats)(3000, true, "provider rate limited", 3, 24);
check("direct waits accumulate across retries", fakeRun.waitedMs === 10000, "run.waitedMs=" + fakeRun.waitedMs);
check("direct attempt count advances", fakeRun.attempts === 3, "attempts=" + fakeRun.attempts);

const failed = results.filter(r => !r.ok);
console.log("\n" + (results.length - failed.length) + "/" + results.length + " checks passed");
if (failed.length) { console.log("FAILED:", failed.map(f => f.name).join("; ")); process.exit(1); }

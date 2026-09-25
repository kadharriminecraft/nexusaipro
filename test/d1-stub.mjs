/* In-memory D1 stub for worker.js v7 paths (jobs / chunks / secrets / wstate).
   Small but literal-aware SQL handling: splits SET from WHERE outside quotes
   and parentheses, so "status IN ('queued','streaming')" is not mistaken for
   the WHERE keyword. */

const TOP_KEYWORDS = [" where ", " group ", " order ", " limit ", " return "];

function findTopLevel(s, needles) {
  let depth = 0, quote = null;
  const low = s.toLowerCase();
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
    if (c === "(") { depth++; continue; }
    if (c === ")") { depth--; continue; }
    if (depth !== 0) continue;
    for (const nd of needles) {
      if (low.startsWith(nd, i)) return { at: i, len: nd.length };
    }
  }
  return null;
}

function splitTopLevel(s, sepWord = "and") {
  const re = new RegExp("^\\s+" + sepWord + "\\s+", "i");
  const out = []; let depth = 0, quote = null, last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "(") { depth++; continue; }
    if (c === ")") { depth--; continue; }
    if (depth !== 0) continue;
    if (sepWord === ",") { if (c === ",") { out.push(s.slice(last, i)); last = i + 1; } continue; }
    const m = re.exec(s.slice(i));
    if (m) { out.push(s.slice(last, i)); last = i + m[0].length; i = last - 1; }
  }
  out.push(s.slice(last));
  return out.map(x => x.trim()).filter(Boolean);
}

export class DB {
  constructor() { this.jobs = []; this.chunks = []; this.secrets = []; this.wstate = []; }
  prepare(sql) { return new Stmt(this, sql.replace(/\s+/g, " ").trim()); }
  exec(sql, args) {
    const low = sql.toLowerCase();
    const kind = low.split(" ")[0];
    if (kind === "create" || kind === "alter" || kind === "begin" || kind === "commit") return { meta: { changes: 0 }, results: [] };
    if (/^insert into jobs/.test(low)) return this.insJobs(sql, args);
    if (/^insert into chunks/.test(low)) { this.chunks.push({ job: args[0], seq: args[1], bytes: args[2], data: args[3] }); return { meta: { changes: 1 }, results: [] }; }
    if (/^insert into secrets/.test(low)) { this.secrets.push({ job: args[0], auth: args[1] }); return { meta: { changes: 1 }, results: [] }; }
    if (/^insert into wstate/.test(low)) { const i = this.wstate.findIndex(r => r.k === args[0]); if (i >= 0) this.wstate[i].v = args[1]; else this.wstate.push({ k: args[0], v: args[1] }); return { meta: { changes: 1 }, results: [] }; }
    if (/^update jobs/.test(low)) return this.upd(sql, args);
    if (/^select .* from jobs/.test(low)) return this.selJobs(sql, args);
    if (/^select .* from chunks/.test(low)) return this.selChunks(sql, args);
    if (/^select .* from wstate/.test(low)) { const r = this.wstate.find(x => x.k === args[0]); return { meta: {}, results: r ? [{ v: r.v }] : [] }; }
    if (/^select .* from secrets/.test(low)) { const r = this.secrets.find(x => x.job === args[0]); return { meta: {}, results: r ? [{ auth: r.auth }] : [] }; }
    if (/^delete from chunks/.test(low)) { this.chunks = this.chunks.filter(c => c.job !== args[0]); return { meta: { changes: 1 }, results: [] }; }
    if (/^delete from secrets/.test(low)) { this.secrets = this.secrets.filter(c => c.job !== args[0]); return { meta: { changes: 1 }, results: [] }; }
    if (/^delete from jobs where created_at/.test(low)) { this.jobs = this.jobs.filter(r => Number(r.created_at) > Number(args[0])); return { meta: { changes: 1 }, results: [] }; }
    if (/^delete from jobs/.test(low)) { this.jobs = this.jobs.filter(r => r.id !== args[0]); return { meta: { changes: 1 }, results: [] }; }
    throw new Error("stub: unhandled sql: " + sql);
  }
  insJobs(sql, args) {
    const cols = /\(([^)]*)\)/.exec(sql)[1].split(",").map(x => x.trim());
    const valuesPart = /values\s*\(([^)]*)\)/i.exec(sql)[1];
    const vals = splitTopLevel(valuesPart, ",").map(v => {
      const t = v.trim();
      if (t === "?") return { ph: true };
      if (/^null$/i.test(t)) return { val: null };
      if (/^-?\d+(\.\d+)?$/.test(t)) return { val: Number(t) };
      return { val: t.replace(/^'|'$/g, "") };
    });
    const row = {};
    let ai = 0;
    cols.forEach((c, i) => {
      const v = vals[i];
      row[c] = v && v.ph ? args[ai++] : (v ? v.val : null);
    });
    row.heartbeat = row.heartbeat ?? 0; row.next_retry = row.next_retry ?? 0;
    row.attempts = row.attempts ?? 0; row.finish = row.finish ?? 0; row.bytes = row.bytes ?? 0;
    row.waited_ms = row.waited_ms ?? 0; row.content_text = row.content_text ?? "";
    row.lock_token = row.lock_token ?? null;
    this.jobs.push(row);
    return { meta: { changes: 1 }, results: [] };
  }
  upd(sql, args) {
    const whereIdx = findTopLevel(sql, [" where "]);
    const setStart = sql.toLowerCase().indexOf(" set ") + 5;
    const setPart = sql.slice(setStart, whereIdx ? whereIdx.at : undefined);
    const where = whereIdx ? sql.slice(whereIdx.at + whereIdx.len) : "";
    // each assignment consumes a bound arg only when its value is a `?`
    const assigns = splitTopLevel(setPart, ",").map(a => {
      const eq = a.indexOf("=");
      const col = a.slice(0, eq).trim();
      const val = a.slice(eq + 1).trim();
      return { col, lit: val === "?" ? null : val };
    });
    const nPlaceholders = assigns.filter(a => a.lit === null).length;
    const setVals = args.slice(0, nPlaceholders);
    const whereArgs = args.slice(nPlaceholders);
    let changed = 0;
    for (const row of this.jobs) {
      const wa = [...whereArgs];
      let ok = true;
      for (const cond of splitTopLevel(where)) {
        let m;
        if ((m = /^id = \?$/i.exec(cond))) ok = ok && row.id === wa.shift();
        else if ((m = /^lock_token = \?$/i.exec(cond))) ok = ok && (row.lock_token ?? null) === (wa.shift() ?? null);
        else if ((m = /^status = \?$/i.exec(cond))) ok = ok && row.status === wa.shift();
        else if ((m = /status in \(([^)]*)\)/i.exec(cond))) { const list = m[1].split(",").map(x => x.trim().replace(/'/g, "")); ok = ok && list.includes(row.status); }
        else if ((m = /^heartbeat < \?$/i.exec(cond))) ok = ok && Number(row.heartbeat) < Number(wa.shift());
        else if ((m = /^next_retry <= \?$/i.exec(cond))) ok = ok && Number(row.next_retry) <= Number(wa.shift());
        else if ((m = /^updated_at > \?$/i.exec(cond))) ok = ok && Number(row.updated_at) > Number(wa.shift());
        else if ((m = /^client = \?$/i.exec(cond))) ok = ok && row.client === wa.shift();
        else if ((m = /^job = \?$/i.exec(cond))) ok = ok && row.job === wa.shift();
        else ok = false;
      }
      if (ok) {
        let vi = 0;
        for (const a of assigns) row[a.col] = a.lit === null ? setVals[vi++] : a.lit.replace(/^'|'$/g, "");
        changed++;
      }
    }
    return { meta: { changes: changed }, results: [] };
  }
  selJobs(sql, args) {
    let rows = [...this.jobs];
    /* Bind ? placeholders POSITIONALLY, in the order they appear in the SQL.
       Matching clauses with pop()/shift() is wrong whenever a query compares
       the same column twice (prune's dead-job test does), which silently
       treats live rows as dead. */
    const binds = [...sql.matchAll(/([A-Za-z_]+)\s*(=|>=|<=|>|<|!=)\s*\?/g)]
      .map((m, i) => ({ col: m[1], op: m[2], val: args[i] }));
    const num = v => Number(v);
    for (const b of binds) {
      const c = b.col, v = b.val;
      if (b.op === "=") rows = rows.filter(r => r[c] === v);
      else if (b.op === "!=") rows = rows.filter(r => r[c] !== v);
      else if (b.op === ">") rows = rows.filter(r => num(r[c]) > num(v));
      else if (b.op === "<") rows = rows.filter(r => num(r[c]) < num(v));
      else if (b.op === ">=") rows = rows.filter(r => num(r[c]) >= num(v));
      else if (b.op === "<=") rows = rows.filter(r => num(r[c]) <= num(v));
    }
    const m = /status in \(([^)]*)\)/i.exec(sql);
    if (m) { const list = m[1].split(",").map(x => x.trim().replace(/'/g, "")); rows = rows.filter(r => list.includes(r.status)); }
    if (/order by updated_at desc/i.test(sql)) rows.sort((a, b) => b.updated_at - a.updated_at);
    if (/order by next_retry asc/i.test(sql)) rows.sort((a, b) => a.next_retry - b.next_retry);
    if (/order by seq asc/i.test(sql)) rows.sort((a, b) => a.seq - b.seq);
    const lm = /limit (\d+)/i.exec(sql);
    if (lm) rows = rows.slice(0, Number(lm[1]));
    return { meta: { changes: 0 }, results: rows.map(r => ({ ...r })) };
  }
  selChunks(sql, args) {
    const rows = this.chunks.filter(c => c.job === args[0]).sort((a, b) => a.seq - b.seq);
    if (/count \(\*\)/i.test(sql) || /coalesce\(max\(seq\)/i.test(sql)) return { meta: {}, results: [{ mx: rows.length ? rows[rows.length - 1].seq : -1, n: rows.length }] };
    if (/seq > \?/i.test(sql)) return { meta: {}, results: rows.filter(r => r.seq > Number(args[1])).map(r => ({ seq: r.seq, data: r.data })) };
    return { meta: {}, results: rows.map(r => ({ seq: r.seq, bytes: r.bytes, data: r.data })) };
  }
}

class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...a) { const s = new Stmt(this.db, this.sql); s.args = a; return s; }
  run() { return Promise.resolve(this.db.exec(this.sql, this.args)); }
  all() { return Promise.resolve(this.db.exec(this.sql, this.args)); }
  first() { const r = this.db.exec(this.sql, this.args); return Promise.resolve((r.results || [])[0] || null); }
}

/* ============================================================
 * z.ai pocket — Cloudflare Worker reverse proxy (v3)
 * ------------------------------------------------------------
 * WHAT THIS DOES
 *   Open THIS WORKER'S URL in your phone browser — that URL is
 *   the app. The worker serves the real chat.z.ai full-screen
 *   (no iframe, no local HTML file). Every request the site
 *   makes (HTML, JS/CSS assets, API calls, SSE streams,
 *   uploads, downloads, websockets) is answered by THIS worker,
 *   which forwards it to the z.ai family of hosts. The browser
 *   never talks to z.ai directly.
 *
 * v3 CHANGES — fixes "opens straight to a blocked page"
 *   1. Cloudflare-edge headers that arrive on every request
 *      hitting this worker (cf-connecting-ip, cf-ipcountry,
 *      cf-ray, cf-visitor, x-forwarded-for, cdn-loop,
 *      true-client-ip, ...) are NO LONGER forwarded upstream.
 *      chat.z.ai is itself behind Cloudflare, and handing it
 *      forged CF headers is classic WAF bait: some regions
 *      answer with a block page.
 *   2. If z.ai still answers 403/429 on a GET, the worker
 *      retries ONCE with a minimal clean header set before it
 *      gives up (successful retries are tagged x-zp-retry: 1).
 *   3. New public /__diag page — open it on the phone and it
 *      shows, live, what z.ai returns for this worker: three
 *      probes (browser-like / minimal / the old v2 forged-header
 *      way) with status, colo and body preview, plus what this
 *      worker received from your network. If z.ai is blocking,
 *      this page says so in plain words.
 *
 * DEPLOY (you already have a worker)
 *   1. dash.cloudflare.com → Workers & Pages → your worker
 *   2. "Edit code" / Quick Edit → select all → paste this file
 *   3. Save & Deploy
 *   4. (optional) Settings → Variables → PROXY_TOKEN with a long
 *      random string (then / asks for it once) and/or
 *      EXTRA_HOSTS="a.com,b.com" to allowlist more first-party
 *      hosts.
 *   5. Open the worker URL — that IS the app. The zai-pocket.html
 *      file already saved on your phone keeps working unchanged
 *      (it only talks to /__status, which is unchanged).
 *      If the app ever shows a blocked or error page, open
 *      https://<your-worker>/__diag and read what it says.
 *
 * ROUTES
 *   /            -> https://chat.z.ai/   — the app itself,
 *                    full-screen, no prefix (the SPA only works
 *                    at "/"; on /chat/ it renders its own error
 *                    page). With PROXY_TOKEN set and unsatisfied,
 *                    / shows the token setup page.
 *   /chat/*      -> 302 to /*            (legacy v2 prefix)
 *   /p/<host>/*  -> https://<host>/*     (allowlisted hosts only)
 *   anything else -> https://chat.z.ai/<path> (transparent
 *                    catch-all: runtime-built root-absolute URLs
 *                    like /static/logo.png behave like on the
 *                    real site)
 *   /__status    -> health-check JSON (the pocket file uses this)
 *   /__diag      -> live upstream probe report (see v3 notes)
 *   /__clear     -> wipe all session cookies, back to /
 *
 * SECURITY
 *   - Only z.ai / chatglm.cn / chatglm.site family hosts are
 *     proxied. This is NOT an open proxy.
 *   - With PROXY_TOKEN set, everything except the token page,
 *     /__status and /__diag requires the token.
 *   - Upstream cookies are re-issued for this worker's own domain
 *     so the whole app is one same-origin page; sessions stick.
 * ============================================================ */

const VERSION = 'zai-pocket-proxy 3.1';

/* z.ai first-party family (suffix match — covers subdomains) */
const ALLOW = [
  'z.ai',               // chat.z.ai, zcode.z.ai, *.space-z.ai sandboxes, ...
  'chatglm.cn',         // z-cdn.chatglm.cn (frontend assets), z-cdn-media, cdn-proxy, sdata
  'chatglm.site',       // artifacts-cdn, adapter-prod, test envs
  'glm-chat.oss-cn-hongkong.aliyuncs.com', // file upload/download bucket
  'alicdn.com',         // o.alicdn.com — z.ai's shared frontend libs (jquery …)
  'aliyuncs.com'        // sdk.rum / log endpoints the z.ai frontend loads at boot
];

/* upstream origin for the /chat route (env CHAT_UPSTREAM overrides, e.g. for staging) */
function chatUpstream(event) { return envOf(event).CHAT_UPSTREAM || 'https://chat.z.ai'; }
function chatHost(event) {
  try { return new URL(chatUpstream(event)).host; } catch (e) { return 'chat.z.ai'; }
}

/* markers filled by the build script */
const PATCH_JS = [
"/* ============================================================",
" * z.ai pocket \u2014 runtime patch",
" * Injected by the proxy worker into every proxied HTML document",
" * as the FIRST script inside <head>. It rewrites every network",
" * call, navigation and popup so the SPA believes it lives on its",
" * real origin while every byte actually flows through the worker.",
" *",
" * NOTE: this source is embedded inside a <script> tag in proxied",
" * pages, so it must never contain the literal sequence \"</scr\" +",
" * \"ipt>\" \u2014 keep it that way.",
" * ============================================================ */",
"(function () {",
"  'use strict';",
"  if (window.__ZAI_PATCHED__) return;",
"  window.__ZAI_PATCHED__ = true;",
"",
"  var CFG = window.__ZAI__ || {};",
"  var PFX = CFG.pfx || '';            // proxy prefix for this document, e.g. \"/chat\" or \"/p/z-cdn.chatglm.cn\"",
"  var HOST = (CFG.host || '').toLowerCase(); // upstream host this document belongs to",
"  var WORKER = CFG.worker || '';      // worker origin, e.g. https://name.workers.dev",
"  var TOKEN = CFG.token || '';        // optional shared proxy token",
"  var ALLOW = CFG.allow || [];        // allowlisted host suffixes",
"",
"  var jar = [];                       // fallback cookie jar (mirrored by the shell)",
"  var lsMirror = {};                  // fallback localStorage mirror (for browsers that block it in iframes)",
"  var upQueue = [];",
"",
"  /* ---------- messaging ---------- */",
"  function up(msg) {",
"    try {",
"      msg.zai = 1;",
"      if (window.parent && window.parent !== window) window.parent.postMessage(msg, '*');",
"    } catch (e) { /* ignore */ }",
"  }",
"",
"  /* ---------- on-page toast (top-level mode: no shell above us) ---------- */",
"  var toastCount = 0;",
"  function pageToast(msg) {",
"    try {",
"      if (window.parent && window.parent !== window) return; // shell handles messages",
"      if (toastCount >= 4) return;",
"      toastCount++;",
"      var d = document.createElement('div');",
"      d.textContent = msg;",
"      d.setAttribute('style', 'position:fixed;left:12px;right:12px;bottom:max(18px,env(safe-area-inset-bottom));z-index:2147483647;background:#20232F;color:#E7E9EE;border:1px solid rgba(255,255,255,.16);border-radius:14px;padding:13px 15px;font:13px/1.5 -apple-system,BlinkMacSystemFont,system-ui,\"Segoe UI\",Roboto,sans-serif;box-shadow:0 12px 32px rgba(0,0,0,.45);word-break:break-all;opacity:0;transition:opacity .25s;pointer-events:none');",
"      (document.body || document.documentElement).appendChild(d);",
"      var raf = window.requestAnimationFrame || function (f) { setTimeout(f, 16); };",
"      raf(function () { d.style.opacity = '1'; });",
"      setTimeout(function () {",
"        try { d.style.opacity = '0'; setTimeout(function () { d.remove(); }, 300); } catch (e) { /* ignore */ }",
"      }, 4500);",
"    } catch (e) { /* ignore */ }",
"  }",
"",
"  /* ---------- host matching ---------- */",
"  function allowedHost(h) {",
"    h = (h || '').toLowerCase().replace(/\\.$/, '');",
"    if (!h) return false;",
"    for (var i = 0; i < ALLOW.length; i++) {",
"      var a = String(ALLOW[i]).toLowerCase();",
"      if (h === a || h.slice(-(a.length + 1)) === '.' + a) return true;",
"    }",
"    return false;",
"  }",
"",
"  /* ---------- proxy-path bookkeeping ----------",
"   * Guards against double-prefixing and recognises URLs that already",
"   * point at the worker (same-origin) instead of the upstream host.",
"   */",
"  function originStr() {",
"    try { return location.origin || (location.protocol + '//' + location.host); } catch (e) { return ''; }",
"  }",
"  function hasPfx(str) {",
"    if (!PFX) return true;",
"    if (str === PFX) return true;",
"    return str.indexOf(PFX) === 0 && /^[\\/?#;]/.test(str.charAt(PFX.length));",
"  }",
"  function isCrossHostPath(str) { // \"/p/<allowlisted host>/\u2026\"",
"    if (/^\\/p\\//.test(str)) {",
"      var h = str.slice(3).split(/[\\/?#]/)[0].toLowerCase();",
"      if (allowedHost(h)) return true;",
"    }",
"    return false;",
"  }",
"  function isProxyPath(p) {",
"    if (!p) return false;",
"    if (hasPfx(p)) return true;",
"    if (isCrossHostPath(p)) return true;",
"    if (/^\\/__(status|clear)([\\/?#]|$)/.test(p)) return true;",
"    return false;",
"  }",
"",
"  /* ---------- URL mapping ----------",
"   * absolute / protocol-relative allowlisted URLs -> proxy paths",
"   * same-origin (worker) absolute URLs -> normalised proxy paths",
"   * root-absolute paths -> PFX + path  (they belong to this doc's upstream host)",
"   * relative / data: / blob: / #...   -> untouched",
"   */",
"  function mapUrl(u) {",
"    try {",
"      if (u == null) return u;",
"      if (typeof u === 'object' && u instanceof URL) {",
"        var s = mapUrl(u.href);",
"        return s;",
"      }",
"      if (typeof u !== 'string') return u;",
"      var str = u.trim();",
"      if (!str) return str;",
"      if (/^(data|blob|about|javascript|mailto|tel|sms|intent|ms-|chrome|file|ws|wss):/i.test(str)) {",
"        // wss/ws handled by the WebSocket wrapper below; here pass through",
"        return str;",
"      }",
"      if (str.charAt(0) === '#') return str;",
"      var m;",
"      if ((m = str.match(/^https?:\\/\\/([^\\/?#]+)/i))) {",
"        var host = m[1].toLowerCase();",
"        var org = originStr();",
"        if (org && (str === org || str.indexOf(org + '/') === 0)) {",
"          // same-origin (worker) absolute URL \u2014 either already proxied",
"          // (\"/chat/\u2026\", \"/p/host/\u2026\") or a bare worker-root path that",
"          // still belongs to this document's upstream",
"          var sp = str.slice(org.length) || '/';",
"          if (isProxyPath(sp)) return sp;",
"          return PFX + sp;",
"        }",
"        if (!allowedHost(host)) return str;                    // external: leave (usually analytics)",
"        var rest = str.slice(m[0].length) || '/';",
"        if (host === HOST) return PFX + rest;",
"        return '/p/' + host + rest;",
"      }",
"      if ((m = str.match(/^\\/\\/([^\\/?#]+)/))) {",
"        var h2 = m[1].toLowerCase();",
"        if (!allowedHost(h2)) return str;",
"        var rest2 = str.slice(m[0].length) || '/';",
"        if (h2 === HOST) return PFX + rest2;",
"        return '/p/' + h2 + rest2;",
"      }",
"      if (str.charAt(0) === '/' && str.charAt(1) !== '/') {",
"        if (hasPfx(str)) return str;          // already carries this doc's proxy prefix",
"        if (isCrossHostPath(str)) return str; // already a /p/<host>/ proxy path",
"        return PFX + str;",
"      }",
"      return str; // relative \u2192 resolves against the proxied document URL",
"    } catch (e) { return u; }",
"  }",
"",
"  /* ---------- cookies ---------- */",
"  function docCookies() {",
"    var out = [];",
"    try {",
"      (document.cookie || '').split(';').forEach(function (kv) {",
"        kv = kv.trim();",
"        if (kv) out.push(kv);",
"      });",
"    } catch (e) { /* ignore */ }",
"    return out;",
"  }",
"",
"  function cookieHeader() {",
"    var seen = {};",
"    var parts = [];",
"    docCookies().forEach(function (kv) {",
"      var name = kv.split('=')[0];",
"      if (!seen[name]) { seen[name] = 1; parts.push(kv); }",
"    });",
"    jar.forEach(function (c) {",
"      if (c && c.name && !seen[c.name]) { seen[c.name] = 1; parts.push(c.name + '=' + c.value); }",
"    });",
"    return parts.join('; ');",
"  }",
"",
"  function ingestSetCookie(hdrVal) {",
"    try {",
"      if (!hdrVal) return;",
"      var arr = JSON.parse(decodeURIComponent(hdrVal));",
"      if (!Array.isArray(arr)) return;",
"      var map = {};",
"      jar.forEach(function (c) { map[c.name] = c; });",
"      arr.forEach(function (raw) {",
"        var bits = String(raw).split(';');",
"        var nv = bits[0];",
"        var eq = nv.indexOf('=');",
"        if (eq < 1) return;",
"        var c = { name: nv.slice(0, eq).trim(), value: nv.slice(eq + 1).trim() };",
"        for (var i = 1; i < bits.length; i++) {",
"          var b = bits[i].trim();",
"          var k = b.split('=')[0].toLowerCase();",
"          if (k === 'max-age') {",
"            var ma = parseInt(b.slice(8), 10);",
"            if (ma === 0) { c.del = true; }",
"            c.maxAge = ma;",
"          }",
"        }",
"        if (c.del) delete map[c.name];",
"        else map[c.name] = c;",
"      });",
"      jar = [];",
"      Object.keys(map).forEach(function (k) { jar.push(map[k]); });",
"      up({ type: 'cookies', cookies: jar });",
"    } catch (e) { /* ignore */ }",
"  }",
"",
"  function seedDocumentCookies() {",
"    jar.forEach(function (c) {",
"      try {",
"        document.cookie = c.name + '=' + c.value + '; path=/; Max-Age=31536000; Secure; SameSite=None; Partitioned';",
"      } catch (e) { /* ignore */ }",
"    });",
"  }",
"",
"  /* ---------- header injection ---------- */",
"  function applyHeaders(h) {",
"    try {",
"      var ch = cookieHeader();",
"      if (ch && !h.has('x-cookie')) h.set('x-cookie', ch);",
"      if (TOKEN && !h.has('x-proxy-token')) h.set('x-proxy-token', TOKEN);",
"    } catch (e) { /* ignore */ }",
"    return h;",
"  }",
"",
"  /* ---------- fetch ---------- */",
"  var _fetch = window.fetch ? window.fetch.bind(window) : null;",
"  if (_fetch) {",
"    window.fetch = function (input, init) {",
"      try {",
"        if (input && typeof input === 'object' && typeof input.url === 'string' && input.constructor && input.constructor.name === 'Request') {",
"          var mapped = mapUrl(input.url);",
"          if (mapped !== input.url) {",
"            try { input = new Request(mapped, input); } catch (e2) { /* keep original */ }",
"          }",
"        } else if (typeof input === 'string' || input instanceof URL) {",
"          var u2 = mapUrl(String(input));",
"          if (u2 !== String(input)) input = u2;",
"        }",
"        init = init || {};",
"        var H;",
"        try { H = (init.headers instanceof Headers) ? init.headers : new Headers(init.headers || {}); }",
"        catch (e3) { H = new Headers(); }",
"        init.headers = applyHeaders(H);",
"        var p = _fetch(input, init);",
"        p.then(function (r) {",
"          try { ingestSetCookie(r.headers && r.headers.get('x-set-cookie')); } catch (e4) { /* ignore */ }",
"        }, function () { /* network error \u2014 swallow */ });",
"        return p;",
"      } catch (e) {",
"        return _fetch(input, init);",
"      }",
"    };",
"  }",
"",
"  /* ---------- XMLHttpRequest ---------- */",
"  try {",
"    var _open = XMLHttpRequest.prototype.open;",
"    XMLHttpRequest.prototype.open = function (method, url) {",
"      try {",
"        var mu = mapUrl(String(url));",
"        if (mu !== String(url)) {",
"          if (arguments.length > 2) {",
"            arguments[1] = mu;",
"            return _open.apply(this, arguments);",
"          }",
"          return _open.call(this, method, mu);",
"        }",
"      } catch (e) { /* ignore */ }",
"      return _open.apply(this, arguments);",
"    };",
"    var _send = XMLHttpRequest.prototype.send;",
"    XMLHttpRequest.prototype.send = function () {",
"      try {",
"        var ch = cookieHeader();",
"        if (ch) this.setRequestHeader('x-cookie', ch);",
"        if (TOKEN) this.setRequestHeader('x-proxy-token', TOKEN);",
"      } catch (e) { /* ignore */ }",
"      var xhr = this;",
"      try {",
"        xhr.addEventListener('loadend', function () {",
"          try { ingestSetCookie(xhr.getResponseHeader && xhr.getResponseHeader('x-set-cookie')); } catch (e2) { /* ignore */ }",
"        });",
"      } catch (e3) { /* ignore */ }",
"      return _send.apply(this, arguments);",
"    };",
"  } catch (e) { /* ignore */ }",
"",
"  /* ---------- EventSource ---------- */",
"  try {",
"    if (window.EventSource) {",
"      var _ES = window.EventSource;",
"      window.EventSource = function (url, cfg) {",
"        try {",
"          var mu = mapUrl(String(url));",
"          /* EventSource cannot set headers \u2014 carry the token in the query */",
"          if (TOKEN && mu !== String(url) && String(mu).indexOf('__t=') < 0) {",
"            mu += (mu.indexOf('?') < 0 ? '?' : '&') + '__t=' + encodeURIComponent(TOKEN);",
"          }",
"          url = mu;",
"        } catch (e) { /* ignore */ }",
"        return new _ES(url, cfg);",
"      };",
"      window.EventSource.prototype = _ES.prototype;",
"    }",
"  } catch (e) { /* ignore */ }",
"",
"  /* ---------- WebSocket ---------- */",
"  try {",
"    if (window.WebSocket) {",
"      var _WS = window.WebSocket;",
"      window.WebSocket = function (url, protocols) {",
"        try {",
"          var s = String(url);",
"          var m = s.match(/^(wss?):\\/\\/([^\\/?#]+)(\\/.*)?$/i);",
"          if (m) {",
"            var host = m[2].toLowerCase();",
"            var scheme = m[1].toLowerCase() === 'ws' ? 'ws' : 'wss';",
"            if (allowedHost(host)) {",
"              var rest = m[3] || '/';",
"              var path = (host === HOST ? PFX : '/p/' + host) + rest;",
"              if (TOKEN && path.indexOf('__t=') < 0) {",
"                path += (path.indexOf('?') < 0 ? '?' : '&') + '__t=' + encodeURIComponent(TOKEN);",
"              }",
"              url = (location.protocol === 'https:' ? 'wss' : scheme) + '://' + location.host + path;",
"            }",
"          }",
"        } catch (e) { /* ignore */ }",
"        return protocols === undefined ? new _WS(url) : new _WS(url, protocols);",
"      };",
"      window.WebSocket.prototype = _WS.prototype;",
"      window.WebSocket.CONNECTING = _WS.CONNECTING;",
"      window.WebSocket.OPEN = _WS.OPEN;",
"      window.WebSocket.CLOSING = _WS.CLOSING;",
"      window.WebSocket.CLOSED = _WS.CLOSED;",
"    }",
"  } catch (e) { /* ignore */ }",
"",
"  /* ---------- sendBeacon ---------- */",
"  try {",
"    if (navigator.sendBeacon) {",
"      var _sb = navigator.sendBeacon.bind(navigator);",
"      navigator.sendBeacon = function (url, data) {",
"        try {",
"          var mu = mapUrl(String(url));",
"          if (mu !== String(url)) {",
"            // beacons cannot carry custom headers; fall back to keepalive fetch",
"            return _fetch(mu, { method: 'POST', body: data, keepalive: true, mode: 'no-cors' }) ? true : true;",
"          }",
"        } catch (e) { /* ignore */ }",
"        return _sb(url, data);",
"      };",
"    }",
"  } catch (e) { /* ignore */ }",
"",
"  /* ---------- navigation reporting ---------- */",
"  function curUrl() { return location.pathname + location.search + location.hash; }",
"  function reportNav() { up({ type: 'nav', url: curUrl(), title: document.title || '' }); }",
"",
"  try {",
"    var _push = history.pushState;",
"    var _replace = history.replaceState;",
"    // SPA history entries must stay inside the proxy prefix: a bare",
"    // \"/login\" pushed from \"/chat/\" would escape the sandbox on the next",
"    // reload, and a cross-origin URL would throw SecurityError outright.",
"    function fixHistUrl(u) {",
"      try {",
"        var s = String(u);",
"        if (!s || s.charAt(0) === '#') return s;",
"        var org = originStr();",
"        if (org && (s === org || s.indexOf(org + '/') === 0)) {",
"          var p = s.slice(org.length) || '/';",
"          if (isProxyPath(p)) return p;",
"          return PFX + p;",
"        }",
"        var mapped = mapUrl(s);",
"        if (/^(https?:)?\\/\\//i.test(mapped)) return curUrl(); // cross-origin \u2192 would throw",
"        return mapped;",
"      } catch (e) { return u; }",
"    }",
"    history.pushState = function () {",
"      try { if (arguments.length > 2 && arguments[2] != null) arguments[2] = fixHistUrl(arguments[2]); } catch (e2) { /* ignore */ }",
"      var r = _push.apply(this, arguments); reportNav(); return r;",
"    };",
"    history.replaceState = function () {",
"      try { if (arguments.length > 2 && arguments[2] != null) arguments[2] = fixHistUrl(arguments[2]); } catch (e2) { /* ignore */ }",
"      var r = _replace.apply(this, arguments); reportNav(); return r;",
"    };",
"    window.addEventListener('popstate', reportNav);",
"    window.addEventListener('hashchange', reportNav);",
"    window.addEventListener('pageshow', reportNav);",
"  } catch (e) { /* ignore */ }",
"",
"  /* ---------- Navigation API interception (Chrome/Edge) ----------",
"   * catches location.href=..., form submits, link clicks \u2014 anything",
"   * that would navigate this frame to an absolute or external URL.",
"   */",
"  try {",
"    if (window.navigation && window.navigation.addEventListener) {",
"      window.navigation.addEventListener('navigate', function (e) {",
"        try {",
"          if (!e.canIntercept || !e.destination || e.destination.sameDocument) return;",
"          var dest = String(e.destination.url || '');",
"          if (!dest) return;",
"          var org = originStr();",
"          if (org && (dest === org || dest.indexOf(org + '/') === 0)) {",
"            // same-origin destination on the worker itself: either an",
"            // already-proxied path (proceed natively \u2014 the old code used to",
"            // eat these as \"external\") or a bare worker-root path that must",
"            // regain this document's proxy prefix",
"            var p = dest.slice(org.length) || '/';",
"            if (isProxyPath(p)) return;",
"            e.preventDefault();",
"            location.href = PFX + p;",
"            return;",
"          }",
"          var mapped = mapUrl(dest);",
"          if (mapped !== dest) {",
"            // z.ai-family absolute URL \u2192 swap for the proxied path",
"            e.preventDefault();",
"            location.href = mapped;",
"            return;",
"          }",
"          if (/^https?:\\/\\//i.test(dest) || /^\\/\\//.test(dest)) {",
"            // external site \u2014 the phone will block it anyway; tell the user",
"            e.preventDefault();",
"            up({ type: 'ext', url: dest });",
"            pageToast('Blocked (outside the proxy): ' + dest);",
"          }",
"          // relative destinations proceed natively",
"        } catch (err) { /* ignore */ }",
"      });",
"    }",
"  } catch (e) { /* ignore */ }",
"",
"  /* ---------- window.open ---------- */",
"  function stubWindow() {",
"    return {",
"      closed: false,",
"      close: function () { this.closed = true; },",
"      focus: function () {}, blur: function () {},",
"      postMessage: function () {},",
"      location: { href: 'about:blank', replace: function () {}, assign: function () {} },",
"      document: { write: function () {}, open: function () {}, close: function () {}, createElement: function () { return { setAttribute: function () {}, appendChild: function () {} }; } }",
"    };",
"  }",
"  window.open = function (url) {",
"    try {",
"      var u = url == null ? '' : String(url);",
"      if (!u || u === 'about:blank') return stubWindow();",
"      var mapped = mapUrl(u);",
"      if (mapped !== u) { location.href = mapped; return stubWindow(); }",
"      if (/^(https?:)?\\/\\//i.test(u)) { up({ type: 'ext', url: u }); pageToast('Blocked (outside the proxy): ' + u); return stubWindow(); }",
"      location.href = u;",
"      return stubWindow();",
"    } catch (e) { return stubWindow(); }",
"  };",
"",
"  /* ---------- click / submit capture (fallback layer) ---------- */",
"  document.addEventListener('click', function (e) {",
"    try {",
"      if (e.defaultPrevented || (e.button !== undefined && e.button !== 0)) return;",
"      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;",
"      var el = e.target;",
"      var a = el && el.closest ? el.closest('a[' + 'href]') : null;",
"      if (!a) return;",
"      var href = a.getAttribute('href') || '';",
"      if (!href || href.charAt(0) === '#' || /^(data|blob|javascript|mailto|tel):/i.test(href)) return;",
"      var target = (a.target || '').toLowerCase();",
"      var mapped = mapUrl(href);",
"      if (mapped !== href) {",
"        if (target === '_top' || target === '_parent' || target === '_blank') {",
"          e.preventDefault();",
"          location.href = mapped;",
"        } else {",
"          a.setAttribute('href', mapped); // let native navigation use the proxied href",
"        }",
"        return;",
"      }",
"      if (/^(https?:)?\\/\\//i.test(href)) {",
"        e.preventDefault();",
"        up({ type: 'ext', url: href });",
"        pageToast('Blocked (outside the proxy): ' + href);",
"        return;",
"      }",
"      if (target === '_top' || target === '_parent') {",
"        e.preventDefault();",
"        location.href = href;",
"      }",
"    } catch (err) { /* ignore */ }",
"  }, true);",
"",
"  document.addEventListener('submit', function (e) {",
"    try {",
"      var f = e.target;",
"      if (!f || !f.getAttribute) return;",
"      var action = f.getAttribute('action') || '';",
"      if (action) {",
"        var mapped = mapUrl(action);",
"        if (mapped !== action) f.setAttribute('action', mapped);",
"      }",
"      var target = (f.target || '').toLowerCase();",
"      if (target === '_top' || target === '_parent' || target === '_blank') {",
"        e.preventDefault();",
"        var dest = f.getAttribute('action') || curUrl();",
"        if (/^(https?:)?\\/\\//i.test(dest) && mapUrl(dest) === dest) { up({ type: 'ext', url: dest }); return; }",
"        location.href = dest;",
"      }",
"    } catch (err) { /* ignore */ }",
"  }, true);",
"",
"  /* ---------- service worker: never register ----------",
"   * a SW would bypass every patch we installed.",
"   */",
"  try {",
"    if (navigator.serviceWorker && navigator.serviceWorker.register) {",
"      navigator.serviceWorker.register = function () {",
"        return Promise.resolve({ scope: '/', active: null, installing: null, waiting: null, unregister: function () { return Promise.resolve(true); }, addEventListener: function () {}, state: 'activated' });",
"      };",
"    }",
"  } catch (e) { /* ignore */ }",
"",
"  /* ---------- dynamic subresource rewriting ----------",
"   * The SPA builds absolute URLs at runtime for images, scripts,",
"   * stylesheets and downloads (e.g. https://z-cdn.chatglm.cn/\u2026).",
"   * Those would leave the proxy and die on a network that can only",
"   * reach the worker. Rewrite them as they are inserted \u2014 hosts that",
"   * are not allowlisted are left untouched (they fail quietly, like",
"   * analytics does on the real site in China).",
"   */",
"  var RES_ATTRS = { IMG: ['src', 'srcset'], SCRIPT: ['src'], LINK: ['href'], SOURCE: ['src', 'srcset'], AUDIO: ['src', 'poster'], VIDEO: ['src', 'poster'], IFRAME: ['src'], OBJECT: ['data'], EMBED: ['src'], IMAGE: ['href'] };",
"  function fixEl(el) {",
"    try {",
"      if (!el || !el.tagName || !el.getAttribute || !el.setAttribute) return;",
"      var attrs = RES_ATTRS[el.tagName.toUpperCase()];",
"      if (!attrs) return;",
"      for (var i = 0; i < attrs.length; i++) {",
"        var a = attrs[i];",
"        var v = el.getAttribute(a);",
"        if (!v) continue;",
"        var nv = mapUrl(v);",
"        if (nv !== v) el.setAttribute(a, nv);",
"      }",
"    } catch (e) { /* ignore */ }",
"  }",
"  function scanTree(node) {",
"    try {",
"      if (!node || node.nodeType !== 1) return;",
"      fixEl(node);",
"      if (node.querySelectorAll) {",
"        var els = node.querySelectorAll('img,script,link,source,audio,video,iframe,object,embed,image');",
"        for (var i = 0; i < els.length; i++) fixEl(els[i]);",
"      }",
"    } catch (e) { /* ignore */ }",
"  }",
"  try {",
"    if (window.MutationObserver && document.documentElement) {",
"      var mo = new MutationObserver(function (muts) {",
"        for (var i = 0; i < muts.length; i++) {",
"          var m = muts[i];",
"          if (m.type === 'attributes') { fixEl(m.target); continue; }",
"          for (var j = 0; j < m.addedNodes.length; j++) scanTree(m.addedNodes[j]);",
"        }",
"      });",
"      mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href', 'srcset', 'poster', 'data'] });",
"    }",
"  } catch (e) { /* ignore */ }",
"",
"  /* Detached elements bypass the observer: telemetry beacons and preload",
"   * probes set img.src (or setAttribute) without ever entering the DOM.",
"   * Patch the property setter and setAttribute so those URLs are mapped",
"   * onto the worker as well. */",
"  try {",
"    var imgProto = window.HTMLImageElement && window.HTMLImageElement.prototype;",
"    var srcDesc = imgProto && Object.getOwnPropertyDescriptor(imgProto, 'src');",
"    if (srcDesc && srcDesc.set) {",
"      Object.defineProperty(imgProto, 'src', {",
"        get: function () { return srcDesc.get.call(this); },",
"        set: function (v) {",
"          try {",
"            var mu = mapUrl(String(v));",
"            if (mu !== String(v)) v = mu;",
"          } catch (e) { /* ignore */ }",
"          return srcDesc.set.call(this, v);",
"        },",
"        configurable: true,",
"        enumerable: srcDesc.enumerable",
"      });",
"    }",
"  } catch (e) { /* ignore */ }",
"",
"  try {",
"    var _setattr = Element.prototype.setAttribute;",
"    Element.prototype.setAttribute = function (name, value) {",
"      try {",
"        var n = String(name).toLowerCase();",
"        if ((n === 'src' || n === 'href' || n === 'srcset' || n === 'poster' || n === 'data') &&",
"            typeof value === 'string' && this && this.tagName) {",
"          var attrs = RES_ATTRS[this.tagName.toUpperCase()];",
"          if (attrs && attrs.indexOf(n) >= 0) {",
"            var mu = mapUrl(value);",
"            if (mu !== value) value = mu;",
"          }",
"        }",
"      } catch (e) { /* ignore */ }",
"      return _setattr.call(this, name, value);",
"    };",
"  } catch (e) { /* ignore */ }",
"",
"  /* ---------- analytics shims (their hosts are blocked anyway) ---------- */",
"  window.dataLayer = window.dataLayer || [];",
"  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };",
"",
"  /* ---------- localStorage fallback for browsers that block it in iframes ----------",
"   * backed by the shell through postMessage so sessions survive reloads.",
"   */",
"  (function setupStorage() {",
"    function usable(store) {",
"      try {",
"        var k = '__zai_probe__';",
"        store.setItem(k, '1');",
"        store.removeItem(k);",
"        return true;",
"      } catch (e) { return false; }",
"    }",
"    function makeShim(name) {",
"      var mem = (name === 'localStorage') ? lsMirror : {};",
"      return {",
"        getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },",
"        setItem: function (k, v) { mem[k] = String(v); up({ type: 'ls', store: name, k: String(k), v: String(v) }); },",
"        removeItem: function (k) { delete mem[k]; up({ type: 'ls', store: name, k: String(k), v: null }); },",
"        clear: function () { mem = {}; up({ type: 'ls', store: name, k: '__clear__', v: null }); },",
"        key: function (i) { return Object.keys(mem)[i] || null; }",
"      };",
"    }",
"    ['localStorage', 'sessionStorage'].forEach(function (name) {",
"      try {",
"        if (!usable(window[name])) {",
"          Object.defineProperty(window, name, { value: makeShim(name), configurable: true, writable: false });",
"        }",
"      } catch (e) { /* ignore */ }",
"    });",
"  })();",
"",
"  /* ---------- title watcher ---------- */",
"  function watchTitle() {",
"    try {",
"      var t = document.querySelector('title');",
"      if (t && window.MutationObserver) {",
"        new MutationObserver(reportNav).observe(t, { childList: true, characterData: true, subtree: true });",
"      }",
"    } catch (e) { /* ignore */ }",
"  }",
"  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchTitle);",
"  else watchTitle();",
"",
"  /* ---------- error forwarding (diagnostics) ---------- */",
"  var errCount = 0;",
"  window.addEventListener('error', function (e) {",
"    var msg = String((e && e.message) || e).slice(0, 300);",
"    if (errCount < 10) up({ type: 'err', msg: msg });",
"    if (errCount < 3) pageToast('Page error: ' + msg);",
"    errCount++;",
"  });",
"",
"  /* ---------- shell commands ---------- */",
"  window.addEventListener('message', function (e) {",
"    try {",
"      var d = e.data;",
"      if (!d || d.zai !== 1 || !d.cmd) return;",
"      if (e.origin !== 'null' && WORKER && e.origin !== WORKER) return;",
"      switch (d.cmd) {",
"        case 'init':",
"          jar = Array.isArray(d.jar) ? d.jar : [];",
"          if (d.ls) {",
"            Object.keys(d.ls).forEach(function (k) {",
"              if (!(k in lsMirror)) lsMirror[k] = d.ls[k];",
"            });",
"          }",
"          seedDocumentCookies();",
"          reportNav();",
"          break;",
"        case 'back': history.back(); break;",
"        case 'forward': history.forward(); break;",
"        case 'reload': location.reload(); break;",
"        case 'navigate':",
"          if (d.url) location.href = mapUrl(String(d.url));",
"          break;",
"        case 'getstate': reportNav(); break;",
"      }",
"    } catch (err) { /* ignore */ }",
"  });",
"",
"  /* ---------- boot ---------- */",
"  up({ type: 'hello', url: curUrl(), title: document.title || '' });",
"  reportNav();",
"})();",
""
].join("\n");

/* ============================================================ */

addEventListener('fetch', (event) => {
  event.respondWith(handle(event.request, event));
});

async function handle(req, event) {
  try {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();

    /* ---- CORS preflight ---- */
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(req, new Headers()) });
    }

    /* ---- public endpoints ---- */
    if (url.pathname === '/__status') {
      const env = envOf(event);
      const token = env.PROXY_TOKEN || '';
      let tokenOk = null;
      if (token) {
        const supplied = url.searchParams.has('__t') || req.headers.get('x-proxy-token') != null;
        if (supplied) tokenOk = (url.searchParams.get('__t') === token || req.headers.get('x-proxy-token') === token);
      }
      return json({ ok: true, name: VERSION, time: new Date().toISOString(), token_required: !!token, token_ok: tokenOk }, req);
    }

    /* ---- live upstream probe report (v3) ----
     * Public like /__status: no secrets, and it must stay reachable
     * in every cookie/token state — when the app "opens straight to
     * a blocked page", this page tells the user WHY. */
    if (url.pathname === '/__diag') {
      return diagPage(req, event);
    }
    /* ---- app entry: "/" IS the app ----
     * With a token required and not yet satisfied, / shows the setup
     * page; otherwise it falls through and is proxied like any path. */
    if (url.pathname === '/') {
      const env = envOf(event);
      const token = env.PROXY_TOKEN || '';
      if (token && !(await checkToken(req, url, token))) {
        /* a token was submitted but wrong → show the hint; fresh visit → plain form */
        return landing(event, url.searchParams.has('__t'));
      }
    }

    /* ---- token gate ---- */
    const env = envOf(event);
    const token = env.PROXY_TOKEN || '';
    if (token && !(await checkToken(req, url, token))) {
      const accept = req.headers.get('accept') || '';
      if (method === 'GET' && accept.includes('text/html')) {
        /* a human navigation with a wrong/missing token → the setup page */
        return landing(event, true);
      }
      return json({ error: 'unauthorized', hint: 'set X-Proxy-Token header or __t query param' }, req, 401);
    }

    /* ---- token was supplied in the query: remember it, clean the URL ---- */
    if (token && url.searchParams.has('__t')) {
      const clean = new URL(req.url);
      clean.searchParams.delete('__t');
      const h = new Headers({ location: clean.pathname + (clean.search || ''), 'cache-control': 'no-store' });
      h.append('set-cookie', tokenCookie(token));
      return new Response(null, { status: 302, headers: corsHeaders(req, h) });
    }

    /* ---- session cookie clear ---- */
    if (url.pathname === '/__clear') {
      const h = new Headers({ location: '/', 'cache-control': 'no-store' });
      /* expire every cookie the browser sent, plus the token cookie */
      const ck = req.headers.get('cookie') || '';
      const seen = new Set(['__zai_t']);
      ck.split(';').forEach((kv) => {
        const n = kv.split('=')[0].trim();
        if (n) seen.add(n);
      });
      seen.forEach((n) => h.append('set-cookie', n + '=; Path=/; Max-Age=0; Secure; SameSite=None; Partitioned'));
      return new Response(null, { status: 302, headers: corsHeaders(req, h) });
    }

    /* ---- websocket upgrade ---- */
    if (req.headers.get('upgrade') === 'websocket') {
      return proxyWebsocket(req, url, event);
    }

    /* ---- route resolution ---- */
    let pfx = '';       // proxy prefix for this document ('' = transparent)
    let upstream = null; // absolute upstream URL
    let host = null;     // upstream host

    if (url.pathname === '/chat' || url.pathname.startsWith('/chat/')) {
      /* legacy v2 prefix — the SPA errors on /chat/; move to / */
      const rest = url.pathname.slice('/chat'.length) || '/';
      return redirect(req, rest + url.search);
    } else if (url.pathname.startsWith('/p/')) {
      const rest = url.pathname.slice(3); // "<host>/path..."
      const slash = rest.indexOf('/');
      host = slash < 0 ? rest : rest.slice(0, slash);
      const path = slash < 0 ? '/' : rest.slice(slash);
      if (!hostAllowed(host)) {
        return json({ error: 'host not allowed', host: host, allowed_suffixes: allowList(event) }, req, 403);
      }
      pfx = '/p/' + host;
      upstream = 'https://' + host + path + url.search;
    } else {
      /* transparent catch-all: the whole worker mirrors chat.z.ai.
       * Runtime-built root-absolute URLs (/static/logo.png, /user.png …)
       * and SPA routes (/auth, /#…) behave exactly like the real site. */
      host = chatHost(event);
      upstream = chatUpstream(event) + url.pathname + url.search;
    }

    /* ---- strip proxy token from query ---- */
    const upUrl = new URL(upstream);
    if (upUrl.searchParams.has('__t')) upUrl.searchParams.delete('__t');

    /* ---- build upstream request ---- */
    const h = new Headers();
    const skipReq = new Set(['host', 'origin', 'referer', 'cookie', 'connection', 'keep-alive', 'upgrade',
      'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'content-length', 'accept-encoding',
      'x-cookie', 'x-proxy-token', 'x-set-cookie']);
    /* v3: Cloudflare's edge injects its own connection headers
     * (cf-connecting-ip, cf-ipcountry, cf-ray, cf-visitor,
     * x-forwarded-for, cdn-loop, true-client-ip, ...) into every
     * request that reaches this worker. Forwarding them to
     * chat.z.ai — which runs behind Cloudflare itself — sends
     * forged edge headers into another zone's WAF. They are
     * dropped here, always. */
    const dropExact = new Set(['cdn-loop', 'true-client-ip', 'x-real-ip']);
    const dropPrefix = ['cf-', 'x-forwarded'];
    for (const [k, v] of req.headers) {
      const lk = k.toLowerCase();
      if (skipReq.has(lk)) continue;
      if (dropExact.has(lk)) continue;
      let drop = false;
      for (let i = 0; i < dropPrefix.length; i++) { if (lk.startsWith(dropPrefix[i])) { drop = true; break; } }
      if (drop) continue;
      h.set(k, v);
    }
    h.set('accept-encoding', 'gzip, deflate, br');
    h.set('cookie', mergeCookies(req.headers.get('cookie') || '', req.headers.get('x-cookie') || ''));
    h.set('origin', 'https://' + host);
    h.set('referer', 'https://' + host + '/');

    let body = undefined;
    let needDuplex = false;
    if (method !== 'GET' && method !== 'HEAD') {
      const cl = parseInt(req.headers.get('content-length') || '0', 10);
      if (cl > 0 && cl < 32 * 1024 * 1024) {
        body = await req.arrayBuffer(); // keeps Content-Length intact (important for OSS uploads)
        h.set('content-length', String(body.byteLength));
      } else {
        body = req.body; // stream big/unknown-size uploads
        needDuplex = true;
      }
    }

    let res;
    let retried = false;
    try {
      const fetchInit = { method: method, headers: h, redirect: 'manual' };
      if (body !== undefined) fetchInit.body = body;
      if (needDuplex) fetchInit.duplex = 'half';
      res = await fetch(upUrl.toString(), fetchInit);
      /* ---- v3: a 403/429 on a safe GET can be a WAF trip-wire fed
       * by leftover request headers — retry ONCE with a minimal,
       * clean header set before relaying the block page. ---- */
      if ((res.status === 403 || res.status === 429) && (method === 'GET' || method === 'HEAD')) {
        try {
          const res2 = await fetch(upUrl.toString(), { method: method, headers: minimalHeaders(req, host), redirect: 'manual' });
          retried = true; /* a retry attempt happened — tagged either way */
          if (res2.status !== res.status) {
            try { if (res.body && res.body.cancel) res.body.cancel(); } catch (e) { /* ignore */ }
            res = res2;
            retried = true;
          } else {
            try { if (res2.body && res2.body.cancel) res2.body.cancel(); } catch (e) { /* ignore */ }
          }
        } catch (e2) { /* keep the original response */ }
      }
    } catch (err) {
      return json({ error: 'upstream fetch failed', detail: String(err && err.message || err) }, req, 502);
    }

    /* ---- redirect handling: rewrite Location and let the browser follow inside the worker ---- */
    const loc = res.headers.get('location');
    if (loc && res.status >= 300 && res.status < 400 && res.status !== 304) {
      const mapped = mapLocation(loc, upUrl, event);
      const rh = scrubHeaders(res.headers);
      reissueCookies(res, rh, event);
      rh.set('location', mapped);
      maybeSetTokenCookie(req, rh, event);
      return new Response(null, { status: res.status, headers: corsHeaders(req, rh) });
    }

    /* ---- normal responses ---- */
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const outHeaders = scrubHeaders(res.headers);
    reissueCookies(res, outHeaders, event);
    maybeSetTokenCookie(req, outHeaders, event);
    outHeaders.set('x-final-url', res.url || upUrl.toString());
    if (retried) outHeaders.set('x-zp-retry', '1');
    const outCt = corsHeaders(req, outHeaders);

    if (ct.includes('text/html')) {
      const text = await res.text();
      const html = rewriteHtml(text, pfx, host, new URL(req.url).origin, token, allowList(event));
      return new Response(html, { status: res.status, headers: outCt });
    }
    if (ct.includes('text/css')) {
      const text = await res.text();
      const css = rewriteCss(text, pfx, host, allowList(event));
      return new Response(css, { status: res.status, headers: outCt });
    }

    return new Response(res.body, { status: res.status, headers: outCt });
  } catch (err) {
    return json({ error: 'proxy error', detail: String(err && err.message || err) }, req, 500);
  }
}

/* ============================================================ helpers */

function envOf(event) {
  return (event && event.env) || globalThis.__ZAI_ENV || {};
}
function allowList(event) {
  const extra = envOf(event).EXTRA_HOSTS || '';
  const arr = ALLOW.slice();
  String(extra).split(',').forEach((h) => {
    h = h.trim().toLowerCase();
    if (h && arr.indexOf(h) < 0) arr.push(h);
  });
  return arr;
}
function hostAllowed(host, event) {
  host = String(host || '').toLowerCase();
  const list = allowList(event);
  for (const a of list) {
    if (host === a || host.endsWith('.' + a)) return true;
  }
  return false;
}
async function checkToken(req, url, token) {
  if (req.headers.get('x-proxy-token') === token) return true;
  if (url.searchParams.get('__t') === token) return true;
  const ck = req.headers.get('cookie') || '';
  const m = ck.match(/(?:^|;\s*)__zai_t=([^;]+)/);
  if (m && decodeURIComponent(m[1]) === token) return true;
  return false;
}
function tokenCookie(token) {
  return '__zai_t=' + encodeURIComponent(token) + '; Path=/; Max-Age=31536000; Secure; SameSite=None; Partitioned';
}
function redirect(req, to) {
  const h = new Headers({ location: to, 'cache-control': 'no-store' });
  return new Response(null, { status: 302, headers: corsHeaders(req, h) });
}
function maybeSetTokenCookie(req, h, event) {
  const token = envOf(event).PROXY_TOKEN || '';
  if (!token) return;
  const ck = req.headers.get('cookie') || '';
  if (ck.indexOf('__zai_t=') >= 0) return;
  h.append('set-cookie', tokenCookie(token));
}

function mergeCookies(a, b) {
  const seen = new Map();
  const add = (str) => {
    if (!str) return;
    str.split(';').forEach((kv) => {
      kv = kv.trim();
      if (!kv) return;
      const name = kv.split('=')[0];
      if (!seen.has(name)) seen.set(name, kv);
    });
  };
  add(a); // browser-native cookies win
  add(b); // patch-supplied fallback cookies fill gaps
  return Array.from(seen.values()).join('; ');
}

/* response headers we must not forward */
const SCRUB = new Set(['content-security-policy', 'content-security-policy-report-only', 'x-frame-options',
  'strict-transport-security', 'cross-origin-opener-policy', 'cross-origin-embedder-policy',
  'cross-origin-resource-policy', 'content-encoding', 'content-length', 'transfer-encoding',
  'connection', 'keep-alive', 'upgrade', 'set-cookie', 'report-to', 'nel', 'vary']);

function scrubHeaders(headers) {
  const h = new Headers();
  for (const [k, v] of headers) {
    if (!SCRUB.has(k.toLowerCase())) h.set(k, v);
  }
  return h;
}

/* re-issue upstream cookies for this worker's domain (CHIPS-partitioned so they work in the app iframe) */
function reissueCookies(res, h, event) {
  try {
    let raw = [];
    if (typeof res.headers.getSetCookie === 'function') raw = res.headers.getSetCookie();
    else {
      const single = res.headers.get('set-cookie');
      if (single) raw = [single];
    }
    if (!raw.length) return;
    raw.forEach((sc) => {
      const parts = String(sc).split(';');
      const nv = parts[0].trim();
      if (!nv) return;
      let expires = null, maxAge = null, httpOnly = false;
      for (let i = 1; i < parts.length; i++) {
        const p = parts[i].trim();
        const k = p.split('=')[0].toLowerCase();
        if (k === 'expires') expires = p.slice(8).trim();
        else if (k === 'max-age') maxAge = p.slice(8).trim();
        else if (k === 'httponly') httpOnly = true;
      }
      let out = nv + '; Path=/; Secure; SameSite=None; Partitioned';
      if (expires) out += '; Expires=' + expires;
      if (maxAge !== null && maxAge !== undefined && maxAge !== '') out += '; Max-Age=' + maxAge;
      if (httpOnly) out += '; HttpOnly';
      h.append('set-cookie', out);
    });
    /* expose the raw cookies so the patch/shell can mirror them */
    h.set('x-set-cookie', encodeURIComponent(JSON.stringify(raw)));
  } catch (e) { /* ignore */ }
}

function corsHeaders(req, h) {
  h.set('access-control-allow-origin', '*');
  h.set('access-control-allow-methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
  const reqH = req.headers.get('access-control-request-headers');
  h.set('access-control-allow-headers', reqH || '*');
  h.set('access-control-expose-headers', 'content-disposition, content-type, x-set-cookie, x-final-url, filename, x-zp-retry');
  h.set('access-control-max-age', '86400');
  return h;
}

function json(obj, req, status) {
  const h = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  return new Response(JSON.stringify(obj), { status: status || 200, headers: corsHeaders(req, h) });
}

/* ---- v3: the minimal clean header set used by the 403/429 retry ---- */
function minimalHeaders(req, host) {
  const h = new Headers();
  const ua = req.headers.get('user-agent');
  if (ua) h.set('user-agent', ua);
  const al = req.headers.get('accept-language');
  if (al) h.set('accept-language', al);
  h.set('accept', req.headers.get('accept') || '*/*');
  h.set('accept-encoding', 'gzip, deflate, br');
  const ck = mergeCookies(req.headers.get('cookie') || '', req.headers.get('x-cookie') || '');
  if (ck) h.set('cookie', ck);
  h.set('origin', 'https://' + host);
  h.set('referer', 'https://' + host + '/');
  return h;
}

/* ---- v3: /__diag — live upstream probes ------------------------------
 *
 * Three GETs against the chat upstream, each shaped like a
 * different worker generation, so the page shows exactly WHICH
 * request style z.ai blocks (if any) from this worker's egress:
 *   1. "app"     — what v3 forwards for the app document
 *                  (browser-like, CF edge headers stripped)
 *   2. "minimal" — accept + user-agent + origin/referer only
 *   3. "forged"  — what v2 ACTUALLY forwarded: browser-like plus
 *                  the Cloudflare edge headers that ride along on
 *                  every request hitting the worker
 */
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function diagProbe(event, kind) {
  const host = chatHost(event);
  const up = chatUpstream(event) + '/';
  const h = new Headers();
  h.set('accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
  h.set('accept-encoding', 'gzip, deflate, br');
  h.set('accept-language', 'en-US,en;q=0.9');
  h.set('user-agent', 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36');
  h.set('origin', 'https://' + host);
  h.set('referer', 'https://' + host + '/');
  if (kind === 'minimal') {
    h.delete('accept-language');
  }
  if (kind === 'forged') {
    h.set('cf-connecting-ip', '198.51.100.7');
    h.set('cf-ipcountry', 'US');
    h.set('cf-ray', 'diag-probe');
    h.set('x-forwarded-for', '198.51.100.7');
    h.set('cdn-loop', 'cloudflare');
  }
  try {
    const res = await fetch(up, { method: 'GET', headers: h, redirect: 'manual' });
    let snippet = '';
    try { snippet = (await res.text()).slice(0, 240); } catch (e) { snippet = '(body unreadable)'; }
    return {
      error: false,
      status: res.status,
      type: (res.headers.get('content-type') || '').split(';')[0] || '(none)',
      server: res.headers.get('server') || '(none)',
      ray: res.headers.get('cf-ray') || '(no cf-ray — upstream not on Cloudflare)',
      mitigated: res.headers.get('cf-mitigated') || '',
      location: res.headers.get('location') || '',
      snippet: snippet.trim().replace(/\s+/g, ' ')
    };
  } catch (err) {
    return { error: true, status: 0, detail: String((err && err.message) || err) };
  }
}

async function diagPage(req, event) {
  /* what the phone's own request arrived with (added by Cloudflare's
   * edge on the way in) — the v3 worker no longer forwards these */
  const incoming = [];
  for (const [k, v] of req.headers) {
    const lk = k.toLowerCase();
    if (lk.startsWith('cf-') || lk.startsWith('x-forwarded') || lk === 'cdn-loop' || lk === 'true-client-ip' || lk === 'x-real-ip') {
      incoming.push(k + ': ' + v);
    }
  }
  const p = await Promise.all([diagProbe(event, 'app'), diagProbe(event, 'minimal'), diagProbe(event, 'forged')]);
  const app = p[0], mini = p[1], forged = p[2];

  const verdictOf = (pr) => pr.error ? 'fetch failed' : (pr.status === 200 ? 'answered normally (200)' :
    (pr.status === 403 || pr.status === 429 ? 'BLOCKED (' + pr.status + ')' : 'HTTP ' + pr.status));

  let verdict, verdictColor;
  if (app.error || app.status !== 200) {
    if (!app.error && (app.status === 403 || app.status === 429)) {
      verdict = 'z.ai is BLOCKING this worker\u2019s requests (HTTP ' + app.status + '). That block page is what the app shows. Send this whole page to whoever helps you.';
      verdictColor = '#F87171';
    } else {
      verdict = 'The worker could not fetch the app page from ' + esc(chatHost(event)) + ' (' + esc(app.error ? app.detail : 'HTTP ' + app.status) + '). The app cannot work until this is fixed.';
      verdictColor = '#F87171';
    }
  } else if (!forged.error && (forged.status === 403 || forged.status === 429)) {
    verdict = 'z.ai answers normally, but blocks the OLD v2-style request (with forwarded Cloudflare headers). Your v3 fix is exactly right \u2014 keep it deployed.';
    verdictColor = '#FBBF24';
  } else {
    verdict = 'z.ai answers this worker normally. If the app still shows a block page, the block is NOT between this worker and z.ai \u2014 it is between your phone and this worker (network filter / browser). Try this page from a different network (Wi-Fi vs mobile data) to compare.';
    verdictColor = '#4ADE80';
  }

  const probeRow = (name, desc, pr) =>
    '<div class="probe"><div class="ph"><b>' + name + '</b><span class="code">' + esc(desc) + '</span></div>' +
    '<div class="line">status: <b class="' + (pr.error ? 'bad' : (pr.status === 200 ? 'ok' : (pr.status === 403 || pr.status === 429 ? 'bad' : 'warn'))) + '">' + esc(verdictOf(pr)) + '</b></div>' +
    (pr.error ? '<div class="line">error: ' + esc(pr.detail) + '</div>' :
      '<div class="line meta">type ' + esc(pr.type) + ' \u00b7 server ' + esc(pr.server) + ' \u00b7 cf-ray ' + esc(pr.ray) +
      (pr.mitigated ? ' \u00b7 cf-mitigated ' + esc(pr.mitigated) : '') +
      (pr.location ? ' \u00b7 location ' + esc(pr.location) : '') + '</div>' +
      '<div class="snip">' + esc(pr.snippet) + '</div>') +
    '</div>';

  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    '<title>z.ai pocket \u2014 worker diagnostics</title>' +
    '<style>' +
    ':root{--bg:#0B0D12;--panel:#14161F;--panel2:#1A1D28;--line:rgba(255,255,255,.08);--txt:#E7E9EE;--sub:#9AA1AD}' +
    '*{box-sizing:border-box}body{margin:0;padding:18px 14px 40px;background:var(--bg);color:var(--txt);font-family:-apple-system,BlinkMacSystemFont,system-ui,"Segoe UI",Roboto,sans-serif;font-size:14px;line-height:1.55}' +
    'h1{font-size:18px;margin:0 0 2px}.tag{color:var(--sub);font-size:12.5px;margin-bottom:14px}' +
    '.verdict{padding:12px 14px;border-radius:12px;background:rgba(255,255,255,.05);border-left:3px solid ' + verdictColor + ';margin-bottom:14px;font-size:13.5px}' +
    '.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:13px 14px;margin-bottom:12px}' +
    '.card b{font-size:13px}.card .code,.snip{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:#B9B6FB;word-break:break-all}' +
    '.probe{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:13px 14px;margin-bottom:12px}' +
    '.ph{display:flex;justify-content:space-between;gap:10px;align-items:baseline;margin-bottom:6px}' +
    '.ph .code{color:var(--sub);font-size:10.5px}' +
    '.line{font-size:12.5px;color:#C4C9D4;margin:2px 0}.line b{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}' +
    '.ok{color:#4ADE80}.bad{color:#F87171}.warn{color:#FBBF24}' +
    '.meta{color:var(--sub)}.snip{margin-top:7px;padding:9px 10px;border-radius:9px;background:var(--panel2);border:1px solid var(--line);max-height:110px;overflow:hidden}' +
    'ul{margin:6px 0 0;padding-left:18px}li{font-size:12px;color:var(--sub);margin:3px 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}' +
    '.foot{color:var(--sub);font-size:11.5px;line-height:1.6}' +
    '</style></head><body>' +
    '<h1>z.ai pocket \u2014 worker diagnostics</h1>' +
    '<div class="tag">' + esc(VERSION) + ' \u00b7 ' + esc(new Date().toISOString()) + '</div>' +
    '<div class="verdict">' + esc(verdict) + '</div>' +
    probeRow('Probe 1 \u00b7 as the app (v3 style)', 'browser-like, CF headers stripped', app) +
    probeRow('Probe 2 \u00b7 minimal', 'accept + user-agent + origin only', mini) +
    probeRow('Probe 3 \u00b7 old v2 style', 'browser-like + forwarded CF headers', forged) +
    '<div class="card"><b>What your request arrived with</b>' +
    (incoming.length ? '<ul>' + incoming.map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul>' :
      '<ul><li>(no Cloudflare edge headers seen \u2014 this request did not come through a Cloudflare edge)</li></ul>') +
    '<div class="foot">These headers were what v2 wrongly forwarded to z.ai. v3 strips them; Probe 3 shows what z.ai thinks of them.</div></div>' +
    '<div class="foot">This page made three live calls to ' + esc(chatUpstream(event)) + '/ from inside the worker. It works with or without the PROXY_TOKEN, in any cookie state.</div>' +
    '</body></html>';

  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

/* map a Location header value into proxy space */
function mapLocation(loc, upUrl, event) {
  try {
    const abs = new URL(loc, upUrl);
    if (abs.protocol !== 'https:' && abs.protocol !== 'http:') return loc;
    if (!hostAllowed(abs.host, event)) return loc; // external redirect — pass through untouched
    if (abs.host === upUrl.host) {
      const pfx = prefixForHost(upUrl.host, event);
      return pfx + abs.pathname + abs.search;
    }
    return '/p/' + abs.host + abs.pathname + abs.search;
  } catch (e) {
    return loc;
  }
}
function prefixForHost(host, event) {
  if (host === chatHost(event)) return ''; // transparent: the app lives at /
  return '/p/' + host;
}

/* ---------------- HTML rewriting ---------------- */
function mapAttr(v, pfx, host, allow) {
  try {
    const s = String(v || '').trim();
    if (!s) return v;
    if (/^(data|blob|about|javascript|mailto|tel|sms|intent|ms-|chrome|file|#)/i.test(s)) return v;
    let m;
    if ((m = s.match(/^https?:\/\/([^\/?#]+)/i))) {
      const h = m[1].toLowerCase();
      const ok = allow.some((a) => h === a || h.endsWith('.' + a));
      if (!ok) return v;
      const rest = s.slice(m[0].length) || '/';
      return (h === host ? pfx : '/p/' + h) + rest;
    }
    if ((m = s.match(/^\/\/([^\/?#]+)/))) {
      const h = m[1].toLowerCase();
      const ok = allow.some((a) => h === a || h.endsWith('.' + a));
      if (!ok) return v;
      const rest = s.slice(m[0].length) || '/';
      return (h === host ? pfx : '/p/' + h) + rest;
    }
    if (s.charAt(0) === '/' && s.charAt(1) !== '/') return pfx + s;
    return v;
  } catch (e) {
    return v;
  }
}

const ATTR_NAMES = 'href|src|action|formaction|poster|data-src|data-href|data-url|data-background';

function rewriteHtml(text, pfx, host, workerOrigin, token, allow) {
  try {
    /* strip CSP meta tags and base targets */
    text = text.replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '');
    text = text.replace(/<base\b([^>]*?)\s+target\s*=\s*["'][^"']*["']/gi, '<base$1');

    /* rewrite URL attributes */
    const attrRe = new RegExp('(\\s(?:' + ATTR_NAMES + ')\\s*=\\s*)("([^"]*)"|\'([^\']*)\')', 'gi');
    text = text.replace(attrRe, (whole, pre, quoted, dq, sq) => {
      const v = dq !== undefined ? dq : sq;
      const nv = mapAttr(v, pfx, host, allow);
      if (nv === v) return whole;
      return pre + '"' + String(nv).replace(/"/g, '%22') + '"';
    });

    /* srcset lists */
    const ssRe = /(\ssrcset\s*=\s*)("([^"]*)"|'([^']*)')/gi;
    text = text.replace(ssRe, (whole, pre, quoted, dq, sq) => {
      const v = dq !== undefined ? dq : sq;
      const nv = v.split(',').map((cand) => {
        const t = cand.trim();
        if (!t) return '';
        const sp = t.indexOf(' ');
        const u = sp < 0 ? t : t.slice(0, sp);
        const rest = sp < 0 ? '' : t.slice(sp);
        const nu = mapAttr(u, pfx, host, allow);
        return nu === u ? t : nu + rest;
      }).filter(Boolean).join(', ');
      if (nv === v) return whole;
      return pre + '"' + nv + '"';
    });

    /* url() inside style="..." attributes only (inline JS safety) */
    const styleRe = /(\sstyle\s*=\s*)("([^"]*)"|'([^']*)')/gi;
    text = text.replace(styleRe, (whole, pre, quoted, dq, sq) => {
      const v = dq !== undefined ? dq : sq;
      const nv = v.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (w, q, u) => {
        const nu = mapAttr(u, pfx, host, allow);
        return nu === u ? w : "url('" + nu + "')";
      });
      if (nv === v) return whole;
      return pre + '"' + nv.replace(/"/g, '&quot;') + '"';
    });

    /* inject config + runtime patch as the first script */
    const cfg = { pfx: pfx, host: host, worker: workerOrigin, token: token || '', allow: allow };
    const inject = '<scr' + 'ipt>window.__ZAI__=' + JSON.stringify(cfg) + ';' + PATCH_JS + '</scr' + 'ipt>';
    if (/<head[^>]*>/i.test(text)) text = text.replace(/<head[^>]*>/i, (m) => m + inject);
    else if (/<html[^>]*>/i.test(text)) text = text.replace(/<html[^>]*>/i, (m) => m + inject);
    else text = inject + text;
    return text;
  } catch (e) {
    return text;
  }
}

function rewriteCss(text, pfx, host, allow) {
  try {
    text = text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (w, q, u) => {
      const nu = mapAttr(u, pfx, host, allow);
      return nu === u ? w : 'url("' + nu + '")';
    });
    text = text.replace(/@import\s+(['"])([^'"]+)\1/gi, (w, q, u) => {
      const nu = mapAttr(u, pfx, host, allow);
      return nu === u ? w : '@import "' + nu + '"';
    });
    return text;
  } catch (e) {
    return text;
  }
}

/* ---------------- websocket proxy ---------------- */
async function proxyWebsocket(req, url, event) {
  try {
    /* resolve upstream ws url — the whole worker mirrors chat.z.ai */
    let target;
    if (url.pathname.startsWith('/p/')) {
      const rest = url.pathname.slice(3);
      const slash = rest.indexOf('/');
      const host = slash < 0 ? rest : rest.slice(0, slash);
      const path = slash < 0 ? '/' : rest.slice(slash);
      if (!hostAllowed(host, event)) return json({ error: 'host not allowed' }, req, 403);
      target = 'wss://' + host + path + url.search;
    } else {
      target = chatUpstream(event).replace(/^http/, 'ws') + url.pathname + url.search;
    }
    const t = new URL(target);
    if (t.searchParams.has('__t')) t.searchParams.delete('__t');

    const upHeaders = new Headers({ 'Upgrade': 'websocket' });
    const ck = mergeCookies(req.headers.get('cookie') || '', req.headers.get('x-cookie') || '');
    if (ck) upHeaders.set('cookie', ck);
    upHeaders.set('origin', 'https://' + t.host);

    const upRes = await fetch(t.toString(), { headers: upHeaders });
    const upWs = upRes.webSocket;
    if (!upWs) return json({ error: 'upstream refused websocket' }, req, 502);
    upWs.accept();

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    client.accept();

    upWs.addEventListener('message', (e) => { try { client.send(e.data); } catch (err) { /* ignore */ } });
    client.addEventListener('message', (e) => { try { upWs.send(e.data); } catch (err) { /* ignore */ } });
    upWs.addEventListener('close', (e) => { try { client.close(e.code || 1000, e.reason || ''); } catch (err) { /* ignore */ } });
    client.addEventListener('close', (e) => { try { upWs.close(e.code || 1000, e.reason || ''); } catch (err) { /* ignore */ } });
    upWs.addEventListener('error', () => { try { client.close(); } catch (err) { /* ignore */ } });

    return new Response(null, { status: 101, webSocket: client });
  } catch (err) {
    return json({ error: 'websocket proxy failed', detail: String(err && err.message || err) }, req, 500);
  }
}

/* ---------------- landing / token setup page ---------------- */
const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#171A23"/><path d="M18 20h28v7H33.5L46 44h-8.5L27 30.5V44h-9z" fill="#7C6CF0"/></svg>';

function landing(event, bad) {
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    '<meta name="theme-color" content="#0B0D12">' +
    '<title>z.ai pocket — setup</title>' +
    '<link rel="icon" href="data:image/svg+xml,' + encodeURIComponent(FAVICON_SVG) + '">' +
    '<style>' +
    ':root{--bg:#0B0D12;--panel:#14161F;--panel2:#1A1D28;--line:rgba(255,255,255,.08);--txt:#E7E9EE;--sub:#9AA1AD;--acc:#6E6AF8;--bad:#F87171}' +
    '*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}' +
    'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:radial-gradient(1100px 500px at 50% -12%,rgba(110,106,248,.14),transparent 60%),var(--bg);color:var(--txt);font-family:-apple-system,BlinkMacSystemFont,system-ui,"Segoe UI",Roboto,sans-serif;font-size:15px;line-height:1.5}' +
    '.card{width:100%;max-width:400px;background:var(--panel);border:1px solid var(--line);border-radius:22px;padding:28px 22px;box-shadow:0 24px 60px rgba(0,0,0,.5)}' +
    '.logoRow{display:flex;align-items:center;gap:12px;margin-bottom:18px}' +
    '.logo{width:46px;height:46px;border-radius:13px;background:linear-gradient(135deg,#6E6AF8,#4E4AC8);display:flex;align-items:center;justify-content:center;flex:none;box-shadow:0 8px 24px rgba(110,106,248,.35)}' +
    '.logo svg{width:26px;height:26px}' +
    'h1{margin:0;font-size:21px;letter-spacing:.2px}' +
    '.tag{color:var(--sub);font-size:13px;margin-top:2px}' +
    'label{display:block;font-size:12.5px;color:var(--sub);margin:14px 0 7px;font-weight:600;letter-spacing:.3px}' +
    '.inWrap{display:flex;align-items:center;background:var(--panel2);border:1px solid var(--line);border-radius:13px;padding:0 12px;transition:border-color .15s}' +
    '.inWrap:focus-within{border-color:var(--acc)}' +
    'input{flex:1;background:none;border:none;outline:none;padding:13px 0;font-size:15px;color:var(--txt);min-width:0}' +
    'input::placeholder{color:#5b6270}' +
    '.btn{display:flex;align-items:center;justify-content:center;width:100%;margin-top:16px;padding:14px;border:none;border-radius:14px;font:inherit;font-weight:650;font-size:15px;background:var(--acc);color:#fff;cursor:pointer}' +
    '.btn:active{transform:scale(.985)}' +
    '.err{margin-top:12px;padding:10px 12px;border-radius:10px;background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.35);color:#FDA4AF;font-size:13px;line-height:1.5}' +
    '.hint{margin-top:14px;color:var(--sub);font-size:12.5px;line-height:1.6}' +
    '.hint b{color:var(--txt)}' +
    '</style></head><body><div class="card">' +
    '<div class="logoRow"><div class="logo"><svg viewBox="0 0 64 64"><path d="M18 20h28v7H33.5L46 44h-8.5L27 30.5V44h-9z" fill="#fff"/></svg></div>' +
    '<div><h1>z.ai pocket</h1><div class="tag">This worker is protected by a proxy token.</div></div></div>' +
    (bad ? '<div class="err">That token was not accepted — check it and try again.</div>' : '') +
    '<form method="GET" action="/">' +
    '<label for="t">PROXY TOKEN</label>' +
    '<div class="inWrap"><input id="t" name="__t" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="paste your PROXY_TOKEN" autofocus></div>' +
    '<button class="btn" type="submit">Enter Z.ai&nbsp;&rarr;</button></form>' +
    '<div class="hint">The token lives in your worker\u2019s <b>Settings &rarr; Variables &rarr; PROXY_TOKEN</b> on dash.cloudflare.com. ' +
    'It is stored in a cookie on this device, so you only enter it once.</div>' +
    '</div></body></html>';
  return new Response(html, { status: bad ? 401 : 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

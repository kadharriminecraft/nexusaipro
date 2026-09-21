/* ============================================================
   BASEPLATE MULTIPLAYER RELAY — Cloudflare Worker
   ------------------------------------------------------------
   This is the code for the worker at:
     nexusaipro.kadharri-minecraft.workers.dev

   The game file connects automatically to  wss://<worker>/ws ,
   so once this code is deployed, every player who opens the game
   joins the same world.

   DEPLOY (2 minutes, no tools needed):
     1. Go to  dash.cloudflare.com  →  Workers & Pages
     2. Open the worker  "kadharri-minecraft"
     3. Click  "Edit code"  (Quick edit)
     4. Select ALL of the old code, delete it, and PASTE this file
     5. Click  "Save and Deploy"
     6. Done — open the game in two browser windows to test.

   WHAT IT DOES:
     Every player runs the whole world locally in their own copy
     of the game file. This worker simply holds every open
     WebSocket and relays what each player sends to everyone else:
       - player state (position / yaw / animation / tool) at 12 Hz
       - player chat
       - join / leave notifications (silent in-game)
     The result: everybody renders everybody else in the same
     world. Nothing is stored — it is a pure real-time relay.

   NOTES / LIMITS (fine for a group of friends):
     - Connections live in one Worker instance. Two players routed
       to different Cloudflare instances (rare, different regions)
       may not see each other. For guaranteed global matchmaking,
       upgrade to Durable Objects (single source of truth).
     - MAX 40 concurrent players, messages capped at 1 KB, ~90
       messages per second per player (way above what the game
       sends: 12 states/sec + chat + a 25s keepalive ping).
   ============================================================ */

const MAX_CLIENTS = 40;

const clients = new Set();   // open sockets — lives as long as this Worker instance

function relay(data, except) {
  for (const ws of clients) {
    if (ws === except || ws.readyState !== 1) continue;
    try { ws.send(data); } catch (e) {}
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    /* health check — open the worker URL in a browser to see this */
    if (url.pathname === '/' || url.pathname === '/health')
      return new Response(
        'Baseplate multiplayer relay is live — ' + clients.size + ' player(s) connected\n',
        { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });

    if (url.pathname !== '/ws')
      return new Response('Not found\n', { status: 404 });

    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket')
      return new Response('Expected WebSocket\n', { status: 426 });

    if (clients.size >= MAX_CLIENTS)
      return new Response('Relay is full\n', { status: 503 });

    /* upgrade to WebSocket and join the room */
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    clients.add(server);

    let id = null;                          // bound from the first state message
    let msgs = 0, winStart = Date.now();

    server.addEventListener('message', ev => {
      if (typeof ev.data !== 'string' || ev.data.length > 1024) return;   // size cap
      const now = Date.now();
      if (now - winStart > 1000) { winStart = now; msgs = 0; }             // rate cap
      if (++msgs > 90) return;

      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }

      if (m.t === 'p') { try { server.send('{"t":"q"}'); } catch (e) {} return; }  // keepalive ping

      if (m.t === 's' || m.t === 'c') {     // player state / chat → pass through
        if (typeof m.id === 'string' && m.id.length <= 64) id = m.id;     // remember who this socket is
        relay(ev.data, server);             // everyone EXCEPT the sender
      }
    });

    const bye = () => {
      clients.delete(server);
      if (id) relay(JSON.stringify({ t: 'bye', id }), null);   // tell the others they left
    };
    server.addEventListener('close', bye);
    server.addEventListener('error', bye);

    return new Response(null, { status: 101, webSocket: client });
  }
};

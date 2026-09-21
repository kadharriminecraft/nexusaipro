/* ============================================================
   BASEPLATE MULTIPLAYER RELAY v2 — Durable Object world room
   ------------------------------------------------------------
   This is the code for the worker at:
     nexusaipro.kadharri-minecraft.workers.dev

   WHY v2?  The old version kept the player list in a plain
   Worker variable. Cloudflare runs many copies of a plain
   Worker in parallel (one per edge machine), so two players
   could each get connected ("online") yet be sitting in two
   DIFFERENT copies of the list — invisible to each other.

   THE FIX: a Durable Object ("BaseplateRoom"). A Durable Object
   is ONE single global instance with a fixed name — every
   player, from any device, anywhere in the world, is routed to
   the exact same object. Everyone who opens the game file is
   guaranteed to land in the same world room.

   The game file connects automatically to  wss://<worker>/ws ,
   so once this code is deployed, every player who opens the
   game joins the same world.

   DEPLOY (3 minutes, no tools needed):
     1. Go to  dash.cloudflare.com  →  Workers & Pages
     2. Open the worker  "kadharri-minecraft"  →  "Edit code"
     3. Select ALL of the old code, delete it, PASTE this file
     4. In the editor's left panel (or top bar) open  SETTINGS,
        find  BINDINGS  →  "Add binding"  →  pick
        "Durable Object Namespace"  and enter:
            Variable name:  ROOM
            Class name:     BaseplateRoom
        (the class name must match EXACTLY — capital B and R)
     5. Click  "Save and Deploy"
     6. Open  https://nexusaipro.kadharri-minecraft.workers.dev
        in a browser — it must say:
        "Baseplate multiplayer relay is live — 0 player(s) connected"
        If it mentions a missing binding, step 4 didn't save.

   WHAT IT DOES:
     Every player runs the whole world locally in their own copy
     of the game file. The Durable Object room holds every open
     WebSocket and relays what each player sends to everyone
     else:
       - player state (position / yaw / animation / tool) at 12 Hz
       - player chat
       - join / leave notifications (silent in-game)
     The result: everybody renders everybody else in the same
     world. Nothing is stored — it is a pure real-time relay.

   LIMITS (fine for a group of friends):
     - MAX 40 concurrent players, messages capped at 1 KB,
       ~90 messages per second per player (way above what the
       game sends: 12 states/sec + chat + a 25s keepalive ping).
   ============================================================ */

const MAX_CLIENTS = 40;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /* health check — open the worker URL in a browser to see this */
    if (url.pathname === '/' || url.pathname === '/health') {
      if (!env.ROOM)
        return new Response(
          'Baseplate relay is deployed, but the Durable Object binding is MISSING.\n' +
          'Open the worker → Settings → Bindings → Add binding → Durable Object Namespace:\n' +
          '    Variable name: ROOM\n    Class name: BaseplateRoom\n' +
          'then Save and Deploy.\n',
          { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      try {
        const room = env.ROOM.get(env.ROOM.idFromName('baseplate-world'));
        const n = await (await room.fetch('https://room/count')).text();
        return new Response(
          'Baseplate multiplayer relay is live — ' + n + ' player(s) connected\n',
          { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      } catch (e) {
        return new Response('Relay error: ' + (e && e.message ? e.message : e) + '\n',
          { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
    }

    if (url.pathname !== '/ws')
      return new Response('Not found\n', { status: 404 });

    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket')
      return new Response('Expected WebSocket\n', { status: 426 });

    if (!env.ROOM)
      return new Response('ROOM binding missing — see the deploy steps\n', { status: 500 });

    /* everyone lands in the SAME named room object — one shared world */
    const room = env.ROOM.get(env.ROOM.idFromName('baseplate-world'));
    return room.fetch(request);
  }
};

/* ============================================================
   BaseplateRoom — the single shared world room.
   All WebSockets from every device are forwarded here, so the
   player list below is THE world, not a per-machine copy.
   ============================================================ */
export class BaseplateRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.clients = new Set();   // every open socket in the world
  }

  async fetch(request) {
    const url = new URL(request.url);

    /* the health check asks the room how many players it holds */
    if (url.pathname === '/count')
      return new Response(String(this.clients.size));

    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket')
      return new Response('Expected WebSocket\n', { status: 426 });

    if (this.clients.size >= MAX_CLIENTS)
      return new Response('Relay is full\n', { status: 503 });

    /* upgrade to WebSocket and join the room */
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    this.clients.add(server);

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
        for (const ws of this.clients) {
          if (ws === server || ws.readyState !== 1) continue;
          try { ws.send(ev.data); } catch (e) {}
        }
      }
    });

    const bye = () => {
      this.clients.delete(server);
      if (id) for (const ws of this.clients) {                  // tell the others they left
        if (ws.readyState !== 1) continue;
        try { ws.send(JSON.stringify({ t: 'bye', id })); } catch (e) {}
      }
    };
    server.addEventListener('close', bye);
    server.addEventListener('error', bye);

    return new Response(null, { status: 101, webSocket: client });
  }
}

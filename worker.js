export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    };
    
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Simple Auth Check
    const auth = request.headers.get('Authorization');
    if (auth !== `Bearer ${env.AUTH_TOKEN}`) {
      return new Response('Unauthorized', { status: 401, headers: corsHeaders });
    }

    const url = new URL(request.url);
    
    if (url.pathname === '/api/state') {
      if (request.method === 'GET') {
        const data = await env.NEXUS_KV.get('state');
        return new Response(data || '{"chats":[],"currentId":null}', { 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        });
      }
      if (request.method === 'POST') {
        const body = await request.text();
        await env.NEXUS_KV.put('state', body);
        return new Response('{"status":"ok"}', { 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        });
      }
    }
    
    return new Response('Not found', { status: 404, headers: corsHeaders });
  }
};

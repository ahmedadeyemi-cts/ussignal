//functions/api/admin/oncall/history.js
export async function onRequest({ request, env }) {
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!jwt) return new Response("Unauthorized", { status: 401 });

  const indexRaw = await env.ONCALL_KV.get("ONCALL:HISTORY:INDEX");
  const index = indexRaw ? JSON.parse(indexRaw) : [];

  return new Response(JSON.stringify({ entries: index }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

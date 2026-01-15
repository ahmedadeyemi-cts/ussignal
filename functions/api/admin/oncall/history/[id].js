export async function onRequest({ params, request, env }) {
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!jwt) return new Response("Unauthorized", { status: 401 });

  const raw = await env.ONCALL_KV.get(`ONCALL:HISTORY:${params.id}`);
  if (!raw) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(raw, {
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

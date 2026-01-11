export async function onRequestGet({ request, env }) {
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!jwt) return new Response("Unauthorized", { status: 401 });

  const raw = await env.ONCALL_KV.get("audit");
  const entries = raw ? JSON.parse(raw) : [];

  return new Response(
    JSON.stringify({ entries }),
    { headers: { "content-type": "application/json" } }
  );
}

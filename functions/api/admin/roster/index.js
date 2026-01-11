export async function onRequestGet({ request, env }) {
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!jwt) return new Response("Unauthorized", { status: 401 });

  const raw = await env.ONCALL_KV.get("roster");
  const roster = raw ? JSON.parse(raw) : {
    enterprise_network: [],
    collaboration: [],
    system_storage: []
  };

  return new Response(
    JSON.stringify(roster),
    { headers: { "content-type": "application/json" } }
  );
}

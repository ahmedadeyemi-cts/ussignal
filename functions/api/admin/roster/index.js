// functions/api/admin/roster/index.js
export async function onRequestGet({ request, env }) {
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!jwt) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (!env.ONCALL_KV) {
    return new Response(
      JSON.stringify({ error: "KV binding ONCALL_KV not configured" }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }

  let roster;
  try {
    const raw = await env.ONCALL_KV.get("roster");
    roster = raw
      ? JSON.parse(raw)
      : {
          enterprise_network: [],
          collaboration: [],
          system_storage: []
        };
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Failed to load roster", details: String(err) }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify(roster),
    { headers: { "content-type": "application/json" } }
  );
}

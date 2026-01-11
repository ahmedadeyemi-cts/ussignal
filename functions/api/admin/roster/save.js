// functions/api/admin/roster/save.js
export async function onRequestPost({ request, env }) {
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

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (!body || typeof body.roster !== "object") {
    return new Response("Invalid roster payload", { status: 400 });
  }

  await env.ONCALL_KV.put("roster", JSON.stringify(body.roster));

  return new Response(
    JSON.stringify({ ok: true }),
    { headers: { "content-type": "application/json" } }
  );
}

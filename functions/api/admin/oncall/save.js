//functions/api/admin/oncall/save.js
export async function onRequestPost({ request, env }) {
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!jwt) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = await request.json();
  const { schedule } = body;

  if (!schedule || !Array.isArray(schedule.entries)) {
    return new Response("Invalid payload", { status: 400 });
  }

  // TODO: persist to KV / D1 / Durable Object
  await env.ONCALL_KV.put("schedule", JSON.stringify(schedule));

  return new Response(
    JSON.stringify({ ok: true }),
    { headers: { "content-type": "application/json" } }
  );
}

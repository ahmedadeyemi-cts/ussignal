// functions/api/admin/oncall/revert.js

export async function onRequestPost({ request, env }) {
  // Cloudflare Access check
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!jwt) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Restore last saved schedule
  const saved = await env.ONCALL_KV.get("schedule");

  if (!saved) {
    return new Response(
      JSON.stringify({ error: "No saved schedule to revert to." }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  // Overwrite working schedule with saved version
  await env.ONCALL_KV.put("schedule", saved);

  return new Response(
    JSON.stringify({ ok: true }),
    { headers: { "content-type": "application/json" } }
  );
}

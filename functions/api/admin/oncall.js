// functions/api/admin/oncall.js
export async function onRequest({ request, env }) {
  const jwt = request.headers.get("cf-access-jwt-assertion");

  if (!jwt) {
    return new Response("Unauthorized", { status: 401 });
  }

  const raw = await env.ONCALL_KV.get("ONCALL:CURRENT");

  const schedule = raw
    ? JSON.parse(raw)
    : {
        version: 1,
        updatedAt: new Date().toISOString(),
        entries: []
      };

  return new Response(JSON.stringify(schedule), {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}

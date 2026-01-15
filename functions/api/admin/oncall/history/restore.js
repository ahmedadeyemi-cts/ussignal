export async function onRequest({ request, env }) {
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!jwt) return new Response("Unauthorized", { status: 401 });

  const { id } = await request.json();
  if (!id) return new Response("Missing snapshot id", { status: 400 });

  const raw = await env.ONCALL_KV.get(`ONCALL:HISTORY:${id}`);
  if (!raw) return new Response("Snapshot not found", { status: 404 });

  const snapshot = JSON.parse(raw);
  const schedule = snapshot.schedule;

  // Restore as current schedule
  await env.ONCALL_KV.put(
    "ONCALL:SCHEDULE",
    JSON.stringify({
      ...schedule,
      updatedAt: new Date().toISOString(),
      updatedBy: "admin-restore"
    })
  );

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json" }
  });
}

export async function onRequest({ request, env }) {
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!jwt) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = await request.json();
  const next = body?.schedule;

  if (!next || !Array.isArray(next.entries)) {
    return new Response(
      JSON.stringify({ error: "Invalid schedule payload" }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  const finalized = {
    version: next.version ?? 1,
    tz: next.tz ?? "America/Chicago",
    updatedAt: new Date().toISOString(),
    updatedBy: "admin",
    entries: next.entries
  };

  // 🔑 THIS IS THE FIX
  await env.ONCALL_KV.put(
    "ONCALL:CURRENT",
    JSON.stringify(finalized),
    { expirationTtl: undefined }
  );

  return new Response(
    JSON.stringify({ ok: true }),
    { headers: { "content-type": "application/json" } }
  );
}

export async function onRequest({ request, env }) {
  // Only allow POST
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // Cloudflare Access check
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!jwt) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Read schedule
  const raw = await env.ONCALL_KV.get("ONCALL:CURRENT");
  if (!raw) {
    return new Response(
      JSON.stringify({ error: "No schedule found" }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  const schedule = JSON.parse(raw);
  const entries = schedule.entries || [];

  if (!entries.length) {
    return new Response(
      JSON.stringify({ error: "No on-call entries to notify" }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  // For now, we just ACK the notify
  // (You can wire email/SMS next)
  return new Response(
    JSON.stringify({
      ok: true,
      notifiedEntries: entries.length,
      message: "Notify endpoint executed successfully"
    }),
    {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store"
      }
    }
  );
}

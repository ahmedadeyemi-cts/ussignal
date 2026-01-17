export async function onRequestGet({ env, request }) {
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!jwt) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" }
    });
  }

  const raw = await env.ONCALL_KV.get("ONCALL:CRON_HEALTH");

  return new Response(
    raw || JSON.stringify({ status: "never_run" }),
    {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store"
      }
    }
  );
}

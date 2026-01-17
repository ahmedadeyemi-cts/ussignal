export async function onRequestGet({ env, request }) {
  // Cloudflare Access protection
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!jwt) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401 }
    );
  }

  const raw = await env.ONCALL_KV.get("ONCALL:CRON_HEALTH");

  if (!raw) {
    return new Response(
      JSON.stringify({
        status: "never-run"
      }),
      { headers: { "content-type": "application/json" } }
    );
  }

  return new Response(raw, {
    headers: { "content-type": "application/json" }
  });
}

// functions/api/admin/oncall.js

export async function onRequest({ request, env }) {
  // Cloudflare Access enforcement
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!jwt) {
    return new Response("Unauthorized", { status: 401 });
  }

  let schedule;

  try {
    const raw = await env.ONCALL_KV.get("ONCALL:SCHEDULE");

    if (raw) {
      const parsed = JSON.parse(raw);

      // Normalize shape to what app.js expects
      schedule = {
        version: parsed.version ?? 1,
        tz: parsed.tz ?? "America/Chicago",
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
        updatedBy: parsed.updatedBy ?? "system",
        entries: Array.isArray(parsed.entries) ? parsed.entries : []
      };
    } else {
      // First-run default
      schedule = {
        version: 1,
        tz: "America/Chicago",
        updatedAt: new Date().toISOString(),
        updatedBy: "system",
        entries: []
      };
    }
  } catch (err) {
    // Fail closed but visible
    return new Response(
      JSON.stringify({
        error: "Failed to load on-call schedule",
        detail: String(err)
      }),
      {
        status: 500,
        headers: { "content-type": "application/json" }
      }
    );
  }

  return new Response(JSON.stringify(schedule), {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}

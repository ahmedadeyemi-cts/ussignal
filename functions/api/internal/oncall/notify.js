/**
 * POST /api/internal/oncall/notify
 * Internal-only test endpoint
 */

export async function onRequestPost({ request, env }) {
  const secret = env.CRON_SHARED_SECRET;

  if (!secret) {
    return json({ ok: false, error: "cron_secret_not_set" }, 500);
  }

  const hdr = request.headers.get("x-cron-secret");
  if (hdr !== secret) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let body = {};
  try {
    body = await request.json();
  } catch {}

  return json({
    ok: true,
    received: body,
    message: "POST routing is working"
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" }
  });
}

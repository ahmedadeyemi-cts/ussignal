/**
 * POST /api/internal/oncall/notify
 * Cloudflare Pages Function
 */

export async function onRequest({ request, env }) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const secret = env.CRON_SHARED_SECRET;
    if (!secret) {
      return json({ ok: false, error: "cron_secret_not_set" }, 500);
    }

    if (request.headers.get("x-cron-secret") !== secret) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    const payload = await request.json().catch(() => ({}));

    const res = await fetch(
      `${env.PUBLIC_PORTAL_URL}/api/admin/oncall/notify`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cron-secret": secret
        },
        body: JSON.stringify(payload)
      }
    );

    const text = await res.text();

    return json({
      ok: true,
      status: res.status,
      responseType: res.headers.get("content-type"),
      rawResponse: text
    });

  } catch (err) {
    console.error("[internal-oncall-notify]", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}

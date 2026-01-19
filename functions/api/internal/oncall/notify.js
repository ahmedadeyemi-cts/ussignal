/**
 * POST /api/internal/oncall/notify
 *
 * Internal notify endpoint (cron-safe)
 * NOT protected by Cloudflare Access
 * Protected by x-cron-secret
 */

export async function onRequestPost({ request, env }) {
  try {
    /* ---------------- AUTH ---------------- */
    const secret = env.CRON_SHARED_SECRET;
    if (!secret) {
      return json({ ok: false, error: "cron_secret_not_set" }, 500);
    }

    if (request.headers.get("x-cron-secret") !== secret) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    /* ---------------- PAYLOAD ---------------- */
    let payload = {};
    try {
      payload = await request.json();
    } catch {
      payload = {};
    }

    /* ---------------- CALL NOTIFY ENGINE ---------------- */
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
      called: "/api/admin/oncall/notify",
      responseType: res.headers.get("content-type"),
      rawResponse: text
    });

  } catch (err) {
    console.error("[internal-oncall-notify] fatal", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

/* OPTIONAL: allow GET for testing */
export const onRequestGet = onRequestPost;

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}

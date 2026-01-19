/**
 * POST /api/internal/oncall/notify
 *
 * Internal notification trigger
 * - Used by cron
 * - Protected by x-cron-secret
 * - NOT blocked by Cloudflare Access
 */

export async function onRequestPost({ request, env }) {
  try {
    /* ---------------- AUTH ---------------- */
    const secret = env.CRON_SHARED_SECRET;
    if (!secret) {
      return json({ ok: false, error: "cron_secret_not_set" }, 500);
    }

    const hdr = request.headers.get("x-cron-secret");
    if (hdr !== secret) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    /* ---------------- PARSE BODY ---------------- */
    let payload = {};
    try {
      payload = await request.json();
    } catch {
      payload = {};
    }

    const {
      cronHint = null,
      mode = "email",
      auto = true,
      dryRun = false
    } = payload;

    if (!cronHint) {
      return json({ ok: false, error: "missing_cronHint" }, 400);
    }

    /* ---------------- FIRE AUTHORITATIVE NOTIFY ---------------- */
    const res = await fetch(
      `${env.PUBLIC_PORTAL_URL}/api/admin/oncall/notify`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cron-secret": secret
        },
        body: JSON.stringify({
          cronHint,
          mode,
          auto,
          dryRun
        })
      }
    );

    const text = await res.text();

    if (!res.ok) {
      return json(
        {
          ok: false,
          error: "notify_failed",
          status: res.status,
          response: text
        },
        500
      );
    }

    return json({
      ok: true,
      triggeredBy: "cron",
      cronHint,
      mode,
      response: JSON.parse(text)
    });

  } catch (err) {
    console.error("[internal-notify] fatal", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

/* ❗ OPTIONAL BUT SAFE — allows GET for quick validation */
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

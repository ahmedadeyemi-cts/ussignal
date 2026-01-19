/**
 * POST /api/internal/cron/oncall
 *
 * Manual + Cron trigger endpoint
 * Protected via x-cron-secret
 */

export async function onRequestPost({ request, env }) {
  try {
    /* -------------------- AUTH -------------------- */
    const secret = env.CRON_SHARED_SECRET;
    if (!secret) {
      return json({ ok: false, error: "cron_secret_not_set" }, 500);
    }

    const hdr = request.headers.get("x-cron-secret");
    if (hdr !== secret) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    /* -------------------- TIME -------------------- */
    const now = new Date(
      new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })
    );
    const day = now.getDay(); // 1=Mon, 5=Fri

    let cronHint = null;
    let mode = null;

    if (day === 1) {
      cronHint = "MONDAY";
      mode = "email";
    } else if (day === 5) {
      cronHint = "FRIDAY";
      mode = "both";
    } else {
      return json({
        ok: true,
        cronHint: "NONE",
        message: "Cron takes no action today",
        now: now.toISOString()
      });
    }

    /* -------------------- FIRE NOTIFY -------------------- */
    const res = await fetch(
      `${env.PUBLIC_PORTAL_URL}/api/admin/oncall/notify`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cron-secret": secret
        },
        body: JSON.stringify({
          auto: true,
          cronHint,
          mode
        })
      }
    );

    const text = await res.text();

    if (!res.ok) {
      return json({
        ok: false,
        error: "notify_failed",
        status: res.status,
        response: text
      }, 500);
    }

    return json({
      ok: true,
      cronHint,
      mode,
      notifyResponse: JSON.parse(text)
    });

  } catch (err) {
    console.error("[cron-http] fatal", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

/* Optional: allow GET for debugging */
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

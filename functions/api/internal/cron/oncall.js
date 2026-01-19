/**
 * POST /api/internal/cron/oncall
 *
 * Internal cron + manual trigger endpoint
 * - Used by Cloudflare Scheduled Triggers
 * - Can be manually invoked via Postman
 * - NEVER touches /api/admin/*
 *
 * Security:
 * - Protected by x-cron-secret
 *
 * Behavior:
 * - Monday  → UPCOMING (email only)
 * - Friday  → START_TODAY (email + SMS)
 */

export async function onRequestPost({ request, env }) {
  try {
    /* ============================================================
     * AUTH
     * ============================================================ */
    const secret = env.CRON_SHARED_SECRET;
    if (!secret) {
      return json({ ok: false, error: "cron_secret_not_set" }, 500);
    }

    const hdr = request.headers.get("x-cron-secret");
    if (hdr !== secret) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    /* ============================================================
     * TIME (America/Chicago is source of truth)
     * ============================================================ */
    const now = new Date(
      new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })
    );

    const day = now.getDay(); // 1 = Monday, 5 = Friday

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
        triggeredAt: now.toISOString()
      });
    }

    /* ============================================================
     * FIRE INTERNAL NOTIFY (NO ACCESS PROTECTION)
     * ============================================================ */
    const notifyUrl = `${env.PUBLIC_PORTAL_URL}/api/internal/oncall/notify`;

    const res = await fetch(notifyUrl, {
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
    });

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

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }

    return json({
      ok: true,
      triggeredAt: now.toISOString(),
      cronHint,
      mode,
      notifyResponse: parsed
    });

  } catch (err) {
    console.error("[cron-internal] fatal", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

/* ============================================================
 * Optional GET support (manual testing)
 * ============================================================ */
export const onRequestGet = onRequestPost;

/* ============================================================
 * Helpers
 * ============================================================ */
function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}

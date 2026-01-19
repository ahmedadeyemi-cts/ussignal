/**
 * ============================================================
 * INTERNAL CRON — ON-CALL NOTIFICATIONS
 * ============================================================
 *
 * Endpoint:
 *   POST /api/internal/cron/oncall
 *
 * Triggered ONLY by Cloudflare Scheduled Triggers
 *
 * Behavior:
 * - Monday  → UPCOMING on-call reminder (email)
 * - Friday  → START_TODAY notification (email + SMS)
 *
 * Security:
 * - Protected by CRON_SHARED_SECRET
 * - NOT protected by Cloudflare Access (by design)
 *
 * ENV REQUIRED:
 * - CRON_SHARED_SECRET
 * - PUBLIC_PORTAL_URL
 *
 * OPTIONAL:
 * - CRON_DRY_RUN=true
 */

export async function onRequestPost({ request, env }) {
  try {
    /* --------------------------------------------------------
     * SECURITY — SHARED SECRET
     * ------------------------------------------------------ */
    const secret = env.CRON_SHARED_SECRET;
    if (!secret) {
      return json({ ok: false, error: "cron_secret_not_configured" }, 500);
    }

    const hdr = request.headers.get("x-cron-secret");
    if (hdr !== secret) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    /* --------------------------------------------------------
     * TIME — CENTRAL TIME (AUTHORITATIVE)
     * ------------------------------------------------------ */
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
        now: now.toISOString()
      });
    }

    /* --------------------------------------------------------
     * DRY-RUN SUPPORT
     * ------------------------------------------------------ */
    const dryRun =
      env.CRON_DRY_RUN &&
      String(env.CRON_DRY_RUN).toLowerCase() === "true";

    /* --------------------------------------------------------
     * DELEGATE TO EXISTING NOTIFY ENGINE
     * ------------------------------------------------------ */
    const payload = {
      auto: true,
      cronHint,
      mode,
      dryRun
    };

    const baseUrl = env.PUBLIC_PORTAL_URL;
    if (!baseUrl) {
      return json({ ok: false, error: "missing_PUBLIC_PORTAL_URL" }, 500);
    }

    const res = await fetch(`${baseUrl}/api/admin/oncall/notify`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const text = await res.text();

    if (!res.ok) {
      return json({
        ok: false,
        error: "notify_failed",
        status: res.status,
        response: text
      }, 500);
    }

    /* --------------------------------------------------------
     * SUCCESS
     * ------------------------------------------------------ */
    return json({
      ok: true,
      cronHint,
      mode,
      dryRun,
      triggeredAt: now.toISOString(),
      notifyResponse: safeJson(text)
    });

  } catch (err) {
    console.error("[cron-oncall] error", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

/* ============================================================
 * HELPERS
 * ============================================================
 */

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

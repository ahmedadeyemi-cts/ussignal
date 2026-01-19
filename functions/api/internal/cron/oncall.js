/**
 * POST /api/internal/cron/oncall
 *
 * Cron + manual trigger
 * Protected via x-cron-secret
 */

export async function onRequest({ request, env }) {
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

    /* ---------------- TIME ---------------- */
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
        message: "No cron action today",
        now: now.toISOString()
      });
    }

    /* ---------------- CALL INTERNAL ENGINE ---------------- */
    const res = await fetch(
      `${env.PUBLIC_PORTAL_URL}/api/internal/oncall/notify`,
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

    return json({
      ok: res.ok,
      status: res.status,
      cronHint,
      mode,
      response: safeJSON(text)
    });

  } catch (err) {
    console.error("[cron:oncall] fatal", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

/* ---------------- HELPERS ---------------- */

function safeJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
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

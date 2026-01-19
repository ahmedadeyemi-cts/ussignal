/**
 * POST /api/internal/cron/oncall
 *
 * Internal cron enumerator (SAFE VERSION)
 * - No admin routes
 * - No Access
 * - No side effects
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

    /* ---------------- TIME ---------------- */
    const tz = "America/Chicago";
    const now = new Date(
      new Date().toLocaleString("en-US", { timeZone: tz })
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
        triggeredBy: "cron",
        count: 0,
        notifications: [],
        note: "No cron action today"
      });
    }

    /* ---------------- LOAD SCHEDULE ---------------- */
    const raw = await env.ONCALL_KV.get("ONCALL:SCHEDULE");
    if (!raw) {
      return json({ ok: false, error: "schedule_not_found" }, 404);
    }

    const schedule = JSON.parse(raw);
    const entries = Array.isArray(schedule.entries)
      ? schedule.entries
      : [];

    /* ---------------- ENUMERATE ---------------- */
    const notifications = [];

    for (const entry of entries) {
      notifications.push({
        entryId: entry.id,
        cronHint,
        mode
      });
    }

    /* ---------------- RESPONSE ---------------- */
    return json({
      ok: true,
      triggeredBy: "cron",
      count: notifications.length,
      notifications
    });

  } catch (err) {
    console.error("[cron:oncall] fatal", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

/* ---------------- HELPERS ---------------- */

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}

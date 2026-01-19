/**
 * POST /api/internal/cron/oncall
 *
 * Internal Cron Trigger (SAFE)
 * - Auth via x-cron-secret
 * - Filters entries BEFORE notify
 * - Monday → notify ONLY entries starting this Friday
 * - Friday → notify ONLY entries starting today
 * - No Cloudflare Access /api/admin calls
 */

export async function onRequestPost({ request, env }) {
  try {
    /* =====================================================
     * AUTH
     * ===================================================== */
    const secret = env.CRON_SHARED_SECRET;
    if (!secret) {
      return json({ ok: false, error: "cron_secret_not_set" }, 500);
    }

    const hdr = request.headers.get("x-cron-secret");
    if (hdr !== secret) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    /* =====================================================
     * TIME (CST)
     * ===================================================== */
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

    /* =====================================================
     * LOAD SCHEDULE
     * ===================================================== */
    if (!env.ONCALL_KV) {
      return json({ ok: false, error: "kv_not_bound" }, 500);
    }

    const raw = await env.ONCALL_KV.get("ONCALL:SCHEDULE");
    if (!raw) {
      return json({ ok: false, error: "schedule_not_found" }, 404);
    }

    const schedule = JSON.parse(raw);
    const entries = Array.isArray(schedule.entries)
      ? schedule.entries
      : [];

    /* =====================================================
     * DATE HELPERS
     * ===================================================== */
    const startOfDay = d => {
      const x = new Date(d);
      x.setHours(0, 0, 0, 0);
      return x;
    };

    const endOfDay = d => {
      const x = new Date(d);
      x.setHours(23, 59, 59, 999);
      return x;
    };

    const nextFridayFromMonday = d => {
      const x = new Date(d);
      const diff = (5 - x.getDay() + 7) % 7;
      x.setDate(x.getDate() + diff);
      return x;
    };

    /* =====================================================
     * FILTER TARGET ENTRIES (THIS IS THE FIX)
     * ===================================================== */
    let targetEntries = [];

    if (cronHint === "MONDAY") {
      const friday = nextFridayFromMonday(now);
      const start = startOfDay(friday);
      const end = endOfDay(friday);

      targetEntries = entries.filter(e => {
        const s = new Date(e.startISO);
        return s >= start && s <= end;
      });
    }

    if (cronHint === "FRIDAY") {
      const start = startOfDay(now);
      const end = endOfDay(now);

      targetEntries = entries.filter(e => {
        const s = new Date(e.startISO);
        return s >= start && s <= end;
      });
    }

    if (!targetEntries.length) {
      return json({
        ok: true,
        cronHint,
        message: "No matching on-call entries",
        count: 0
      });
    }

    /* =====================================================
     * FIRE NOTIFY (INTERNAL, NOT ADMIN)
     * ===================================================== */
    const notifications = [];

    for (const entry of targetEntries) {
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
            mode,
            entryId: entry.id
          })
        }
      );

      if (res.ok) {
        notifications.push({
          entryId: entry.id,
          cronHint,
          mode
        });
      }
    }

    /* =====================================================
     * RESPONSE
     * ===================================================== */
    return json({
      ok: true,
      triggeredBy: "cron",
      cronHint,
      mode,
      count: notifications.length,
      notifications
    });

  } catch (err) {
    console.error("[cron:oncall] fatal", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

/* Optional GET for manual testing */
export const onRequestGet = onRequestPost;

/* =====================================================
 * RESPONSE HELPER
 * ===================================================== */
function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}

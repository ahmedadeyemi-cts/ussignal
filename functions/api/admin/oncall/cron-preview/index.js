/**
 * GET /api/admin/oncall/cron-preview
 *
 * Secure dry-run preview of cron behavior.
 * - No emails sent
 * - No SMS sent
 * - No KV writes
 * - Shows exactly who WOULD be notified
 *
 * Requires:
 *   Header: x-cron-secret = CRON_SHARED_SECRET
 */

export async function onRequest({ request, env }) {
  try {
    /* ======================================================
       CRON AUTH (REQUIRED)
    ====================================================== */
    const secret = env.CRON_SHARED_SECRET;
    if (!secret) {
      return json({ ok: false, error: "cron_secret_not_configured" }, 500);
    }

    const hdr = request.headers.get("x-cron-secret");
    if (hdr !== secret) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    /* ======================================================
       ENV VALIDATION
    ====================================================== */
    if (!env.ONCALL_KV) {
      return json({ ok: false, error: "kv_not_bound" }, 500);
    }

    /* ======================================================
       TIME (America/Chicago)
    ====================================================== */
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
        dryRun: true,
        cronHint: "NONE",
        now: now.toISOString(),
        message: "Cron would take no action today",
        targets: []
      });
    }

    /* ======================================================
       LOAD SCHEDULE
    ====================================================== */
    const raw = await env.ONCALL_KV.get("ONCALL:SCHEDULE");
    if (!raw) {
      return json({ ok: false, error: "schedule_not_found" }, 404);
    }

    let schedule;
    try {
      schedule = JSON.parse(raw);
    } catch {
      return json({ ok: false, error: "invalid_schedule_json" }, 500);
    }

    const entries = Array.isArray(schedule.entries)
      ? schedule.entries
      : [];

    const targets = [];

    /* ======================================================
       EVALUATE EACH ENTRY
    ====================================================== */
    for (const entry of entries) {
      const start = new Date(entry.startISO);
      const end = new Date(entry.endISO);

      const hoursUntilStart =
        (start.getTime() - now.getTime()) / (1000 * 60 * 60);

      const notifyType =
        start > now && hoursUntilStart >= 24
          ? "UPCOMING"
          : start <= now && now <= end
            ? "START_TODAY"
            : null;

      if (
        (cronHint === "MONDAY" && notifyType !== "UPCOMING") ||
        (cronHint === "FRIDAY" && notifyType !== "START_TODAY")
      ) {
        continue;
      }

      const emailRecipients = [];
      const smsRecipients = [];

      /* Admin notifications */
      if (env.ADMIN_NOTIFICATION) {
        env.ADMIN_NOTIFICATION
          .split(",")
          .map(e => e.trim())
          .filter(Boolean)
          .forEach(e => emailRecipients.push(e));
      }

      /* Department engineers */
      for (const dept of Object.values(entry.departments || {})) {
        if (!dept) continue;

        if (mode !== "sms" && dept.email) {
          emailRecipients.push(dept.email);
        }

        if (
          mode !== "email" &&
          dept.phone &&
          notifyType === "START_TODAY"
        ) {
          smsRecipients.push(
            String(dept.phone).replace(/^\+/, "")
          );
        }
      }

      targets.push({
        entryId: entry.id,
        notifyType,
        startISO: entry.startISO,
        endISO: entry.endISO,
        emailRecipients,
        smsRecipients,
        reason:
          cronHint === "MONDAY"
            ? "cron_monday_upcoming"
            : "cron_friday_start"
      });
    }

    /* ======================================================
       RESPONSE
    ====================================================== */
    return json({
      ok: true,
      dryRun: true,
      cronHint,
      mode,
      now: now.toISOString(),
      targets
    });

  } catch (err) {
    console.error("[cron-preview] fatal", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

/* ======================================================
   JSON HELPER
====================================================== */
function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}

export const onRequestGet = onRequest;

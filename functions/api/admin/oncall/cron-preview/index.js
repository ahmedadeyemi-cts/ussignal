/**
 * GET /api/admin/oncall/cron-preview
 *
 * Dry-run preview of cron behavior.
 * No sends. No KV writes. No auth required.
 */

export async function onRequest({ env }) {
  try {
    if (!env.ONCALL_KV) {
      return json({ ok: false, error: "kv_not_bound" }, 500);
    }

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
        message: "Cron would take no action today"
      });
    }

    const raw = await env.ONCALL_KV.get("ONCALL:SCHEDULE");
    if (!raw) {
      return json({ ok: false, error: "schedule_not_found" }, 404);
    }

    const schedule = JSON.parse(raw);
    const entries = Array.isArray(schedule.entries)
      ? schedule.entries
      : [];

    const tz = schedule.tz || "America/Chicago";

    const targets = [];

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

      // Admin notifications
      if (env.ADMIN_NOTIFICATION) {
        env.ADMIN_NOTIFICATION.split(",")
          .map(e => e.trim())
          .filter(Boolean)
          .forEach(e => emailRecipients.push(e));
      }

      for (const p of Object.values(entry.departments || {})) {
        if (!p) continue;

        if (mode !== "sms" && p.email) {
          emailRecipients.push(p.email);
        }

        if (mode !== "email" && p.phone && notifyType === "START_TODAY") {
          smsRecipients.push(p.phone);
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

    return json({
      ok: true,
      now: now.toISOString(),
      cronHint,
      mode,
      dryRun: true,
      targets
    });

  } catch (err) {
    console.error("[cron-preview] error", err);
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

export const onRequestGet = onRequest;

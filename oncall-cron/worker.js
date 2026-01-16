/**
 * US Signal — On-Call Cron Notifier
 * --------------------------------
 * - Friday: notify engineers starting TODAY
 * - Monday: notify engineers starting NEXT Friday
 *
 * Supports:
 * - Dry-run logging
 * - Email / SMS / Both modes
 * - Audit logging
 * - Timezone safety (America/Chicago)
 */

export default {
  async scheduled(event, env, ctx) {
    const TZ = env.TIMEZONE || "America/Chicago";
    const DRY_RUN = env.DRY_RUN === "true";
    const MODE = env.NOTIFY_MODE || "both"; // email | sms | both

    const now = zonedNow(TZ);

    const raw = await env.ONCALL_KV.get("ONCALL:CURRENT");
    if (!raw) return;

    const schedule = JSON.parse(raw);
    const entries = schedule.entries || [];

    for (const entry of entries) {
      if (!entry?.id || !entry.startISO) continue;

      const start = zonedDate(entry.startISO, TZ);
      const diffDays = Math.floor(
        (start - now) / (1000 * 60 * 60 * 24)
      );

      let notifyType = null;
      let auditAction = null;

      // -------------------------------
      // BUSINESS LOGIC (UNCHANGED)
      // -------------------------------

      // Monday → upcoming Friday
      if (now.getDay() === 1 && diffDays === 4) {
        notifyType = "upcoming";
        auditAction = "AUTO_NOTIFY_MONDAY";
      }

      // Friday → starts today
      if (now.getDay() === 5 && diffDays === 0) {
        notifyType = "start";
        auditAction = "AUTO_NOTIFY_FRIDAY";
      }

      if (!notifyType) continue;

      // -------------------------------
      // DRY-RUN (NO SEND)
      // -------------------------------
      if (DRY_RUN) {
        console.log("[DRY-RUN]", {
          entryId: entry.id,
          notifyType,
          mode: MODE,
          startISO: entry.startISO
        });

        await audit(env, {
          action: auditAction + "_DRY_RUN",
          entryId: entry.id,
          mode: MODE,
          actor: "cron"
        });

        continue;
      }

      // -------------------------------
      // REAL SEND
      // -------------------------------
      await fetch(`${env.BASE_URL}/api/admin/oncall/notify`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-access-jwt-assertion": "cron"
        },
        body: JSON.stringify({
          entryId: entry.id,
          mode: notifyType,
          channel: MODE,        // 👈 email | sms | both
          auto: true
        })
      });

      // -------------------------------
      // AUDIT
      // -------------------------------
      await audit(env, {
        action: auditAction,
        entryId: entry.id,
        mode: MODE,
        actor: "cron"
      });
    }
  }
};

/* =========================================================
   Helpers
========================================================= */

function zonedNow(tz) {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: tz })
  );
}

function zonedDate(iso, tz) {
  return new Date(
    new Date(iso).toLocaleString("en-US", { timeZone: tz })
  );
}

async function audit(env, record) {
  const raw = (await env.ONCALL_KV.get("ONCALL:AUDIT")) || "[]";
  const audit = JSON.parse(raw);

  audit.unshift({
    ts: new Date().toISOString(),
    ...record
  });

  await env.ONCALL_KV.put(
    "ONCALL:AUDIT",
    JSON.stringify(audit.slice(0, 500))
  );
}

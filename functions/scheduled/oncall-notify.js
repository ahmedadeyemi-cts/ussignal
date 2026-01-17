/**
 * functions/scheduled/oncall-notify.js
 *
 * Cloudflare Pages Scheduled Function
 * - Triggers AUTO notifications
 * - Calls existing /api/admin/oncall/notify endpoint
 * - Supports dry-run
 * - Adds cron-specific audit actions
 */

export async function onScheduled(event, env, ctx) {
  const now = new Date();

  // -------------------------------
  // Timezone alignment (CST)
  // -------------------------------
  const tz = env.ONCALL_TZ || "America/Chicago";
  const localNow = new Date(
    new Date().toLocaleString("en-US", { timeZone: tz })
  );

  const day = localNow.getDay(); // 0=Sun, 1=Mon, 5=Fri
  let cronHint = null;

  if (day === 5) cronHint = "FRIDAY";
  if (day === 1) cronHint = "MONDAY";

  // If it's not Monday or Friday, do nothing
  if (!cronHint) {
    console.log("[CRON] Not a notify day, skipping", {
      day,
      localNow: localNow.toISOString()
    });
    return;
  }

  // -------------------------------
  // Dry-run support via env
  // -------------------------------
  const dryRun =
    String(env.CRON_DRY_RUN || "").toLowerCase() === "true";

  const payload = {
    auto: true,
    cronHint,
    mode: "both",      // email + SMS
    dryRun
  };

  const notifyUrl = `${env.PUBLIC_PORTAL_URL}/api/admin/oncall/notify`;

  console.log("[CRON] Invoking notify", {
    notifyUrl,
    payload,
    tz,
    localNow: localNow.toISOString()
  });

  // -------------------------------
  // Call notify endpoint
  // -------------------------------
  const res = await fetch(notifyUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",

      // This header bypasses Access in your notify.js
      "cf-access-jwt-assertion": "cron"
    },
    body: JSON.stringify(payload)
  });

  const text = await res.text();

  if (!res.ok) {
    console.error("[CRON] Notify failed", {
      status: res.status,
      text
    });
  } else {
    console.log("[CRON] Notify success", text);
  }
}

/**
 * functions/api/admin/oncall/cron.js
 *
 * Pages Function — Scheduled Trigger
 * AUTHORITATIVE CRON HANDLER
 */

export async function onScheduled(event, env, ctx) {
  const tz = env.ONCALL_TZ || "America/Chicago";
  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: tz })
  );

  const day = now.getDay(); // 1 = Monday, 5 = Friday
  let cronHint = null;

  if (day === 1) cronHint = "MONDAY";
  if (day === 5) cronHint = "FRIDAY";

  // Only act on Monday / Friday
  if (!cronHint) {
    console.log("[cron] Not a notify day");
    return;
  }

  console.log(`[cron] Triggered: ${cronHint}`);

  const payload = {
    auto: true,
    cronHint,
    mode: cronHint === "MONDAY" ? "email" : "both"
  };

  try {
    const res = await fetch(
      `${env.PUBLIC_PORTAL_URL}/api/admin/oncall/notify`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cron": "true" // optional audit flag
        },
        body: JSON.stringify(payload)
      }
    );

    const text = await res.text();

    if (!res.ok) {
      console.error("[cron] notify failed", res.status, text);
      return;
    }

    console.log("[cron] notify success", text);
  } catch (err) {
    console.error("[cron] fatal error", err);
  }
}

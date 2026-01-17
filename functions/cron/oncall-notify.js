

/**
* This uses Cloudflare Pages Functions → Scheduled Triggers, not a separate Worker project.
 * functions/cron/oncall-notify.js
 *
 * Cloudflare Scheduled Worker
 *
 * Purpose:
 * - Triggers on-call notifications via notify.js
 * - Friday → START_TODAY notifications
 * - Monday → UPCOMING notifications
 *
 * Safety:
 * - Enforced windows are still validated in notify.js
 * - Dry-run supported
 * - No direct KV writes here
 *
 * ENV REQUIRED:
 * - PUBLIC_BASE_URL   (e.g. https://oncall.onenecklab.com)
 * - CRON_SHARED_SECRET (optional but strongly recommended)
 *
 * OPTIONAL:
 * - CRON_DRY_RUN=true
 */

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env));
  }
};

async function runCron(env) {
  const baseUrl = env.PUBLIC_BASE_URL;
  if (!baseUrl) {
    console.error("[CRON] Missing PUBLIC_BASE_URL");
    return;
  }

  const now = new Date();
  const day = now.getUTCDay(); 
  // NOTE: We rely on notify.js timezone logic (America/Chicago)

  let cronHint = null;

  // Monday = 1, Friday = 5
  if (day === 1) cronHint = "MONDAY";
  if (day === 5) cronHint = "FRIDAY";

  if (!cronHint) {
    console.log("[CRON] No action today");
    return;
  }

  const dryRun =
    env.CRON_DRY_RUN &&
    String(env.CRON_DRY_RUN).toLowerCase() === "true";

  const payload = {
    auto: true,
    cronHint,
    mode: "both",
    dryRun
  };

  console.log("[CRON] Triggering notify", payload);

  try {
    const res = await fetch(`${baseUrl}/api/admin/oncall/notify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.CRON_SHARED_SECRET
          ? { "x-cron-secret": env.CRON_SHARED_SECRET }
          : {})
      },
      body: JSON.stringify(payload)
    });

    const text = await res.text();

    if (!res.ok) {
      console.error("[CRON] Notify failed", res.status, text);
      return;
    }

    console.log("[CRON] Notify success", res.status, text);
  } catch (err) {
    console.error("[CRON] Fetch error", err);
  }
}

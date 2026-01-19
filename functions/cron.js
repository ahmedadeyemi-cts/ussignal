// functions/cron.js
export async function onScheduled(event, env, ctx) {
  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })
  );

  const day = now.getDay(); 
  // 1 = Monday, 5 = Friday

  let cronHint = null;
  let mode = "email";

  // 🔧 TEMP TEST MODE — REMOVE AFTER VERIFICATION
  if (env.CRON_FORCE === "true") {
    cronHint = "MONDAY";
    mode = "email";
    console.log("[CRON] Forced run for testing");
  } else {
    if (day === 1) {
      cronHint = "MONDAY";
      mode = "email";
    }

    if (day === 5) {
      cronHint = "FRIDAY";
      mode = "both";
    }
  }

  if (!cronHint) {
    console.log("[CRON] No action today");
    return;
  }

  const payload = {
    auto: true,
    cronHint,
    mode,
    dryRun:
      env.CRON_DRY_RUN &&
      String(env.CRON_DRY_RUN).toLowerCase() === "true"
  };

  console.log("[CRON] Triggering notify", payload);

  try {
    const res = await fetch(
      `${env.PUBLIC_PORTAL_URL}/api/admin/oncall/notify`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      }
    );

    const text = await res.text();

    if (!res.ok) {
      console.error("[CRON] Notify failed", res.status, text);
      return;
    }

    console.log("[CRON] Notify success", res.status, text);
  } catch (err) {
    console.error("[CRON] Cron fetch error", err);
  }
}

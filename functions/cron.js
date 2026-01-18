// functions/cron.js
export async function onScheduled(event, env, ctx) {
  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })
  );

  const day = now.getDay(); // 1 = Monday, 5 = Friday

  if (day === 1) {
    // MONDAY → upcoming reminder
    await fetch(`${env.PUBLIC_PORTAL_URL}/api/admin/oncall/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        auto: true,
        cronHint: "MONDAY",
        mode: "email"
      })
    });
  }

  if (day === 5) {
    // FRIDAY → start today (email + SMS)
    await fetch(`${env.PUBLIC_PORTAL_URL}/api/admin/oncall/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        auto: true,
        cronHint: "FRIDAY",
        mode: "both"
      })
    });
  }
}

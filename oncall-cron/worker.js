export default {
  async scheduled(event, env, ctx) {
    const now = new Date();

    const raw = await env.ONCALL_KV.get("ONCALL:CURRENT");
    if (!raw) return;

    const schedule = JSON.parse(raw);
    const entries = schedule.entries || [];

    for (const entry of entries) {
      if (!entry.startISO) continue;

      const start = new Date(entry.startISO);
      const diffDays = Math.floor(
        (start - now) / (1000 * 60 * 60 * 24)
      );

      let mode = null;

      /*
        BUSINESS LOGIC (unchanged)
        --------------------------------
        - Friday morning → notify engineers starting TODAY
        - Monday morning → notify engineers starting NEXT Friday
      */

      // Monday reminder (on-call starts Friday)
      if (now.getDay() === 1 && diffDays === 4) {
        mode = "upcoming";
      }

      // Friday reminder (on-call starts today)
      if (now.getDay() === 5 && diffDays === 0) {
        mode = "start";
      }

      if (!mode) continue;

      await fetch(`${env.BASE_URL}/api/admin/oncall/notify`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // bypass Cloudflare Access
          "cf-access-jwt-assertion": "cron"
        },
        body: JSON.stringify({
          entryId: entry.id,
          mode,
          auto: true
        })
      });
    }
  }
};

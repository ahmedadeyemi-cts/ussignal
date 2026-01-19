export async function onCron(event, env, ctx) {
  try {
    console.log("[cron] triggered", event.cron);

    // Call your EXISTING internal cron endpoint logic
    // by importing the same function it already uses
    const res = await fetch(
      "https://oncall.onenecklab.com/api/internal/cron/oncall",
      {
        method: "POST",
        headers: {
          "x-cron-secret": env.CRON_SHARED_SECRET
        }
      }
    );

    const text = await res.text();

    console.log("[cron] result", {
      status: res.status,
      body: text.slice(0, 500)
    });

  } catch (err) {
    console.error("[cron] fatal", err);
  }
}

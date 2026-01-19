export async function runOncallNotify({ env, cronHint, mode, auto }) {
  const raw = await env.ONCALL_KV.get("ONCALL:SCHEDULE");
  if (!raw) {
    throw new Error("schedule_not_found");
  }

  const schedule = JSON.parse(raw);
  const entries = Array.isArray(schedule.entries) ? schedule.entries : [];

  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: schedule.tz || "America/Chicago" })
  );

  const notifications = [];

  for (const entry of entries) {
    // your existing notify logic here
    notifications.push({
      entryId: entry.id,
      cronHint,
      mode
    });
  }

  // send emails + SMS here
  // (Brevo / Twilio / etc)

  return {
    ok: true,
    count: notifications.length,
    notifications
  };
}

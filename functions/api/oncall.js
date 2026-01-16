export async function onRequest({ env }) {
  try {
    // -----------------------------------
    // Load CURRENT on-call schedule
    // (public-safe, read-only)
    // -----------------------------------
    // 🔑 Load FULL schedule (not CURRENT)
const raw = await env.ONCALL_KV.get("ONCALL:SCHEDULE");

    const schedule = raw
      ? JSON.parse(raw)
      : { entries: [] };

    return new Response(
  JSON.stringify({
    version: schedule.version ?? 1,
    tz: schedule.tz ?? "America/Chicago",
    updatedAt: schedule.updatedAt ?? null,
    entries: Array.isArray(schedule.entries)
      ? schedule.entries
      : []
  }),
  {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    }
  }
);


  } catch (err) {
    console.error("PUBLIC ONCALL ERROR:", err);

    return new Response(
      JSON.stringify({
        schedule: { entries: [] },
        error: "Failed to load on-call data"
      }),
      {
        status: 500,
        headers: {
          "content-type": "application/json",
          "access-control-allow-origin": "*"
        }
      }
    );
  }
}

export async function onRequest({ env }) {
  try {
    // -----------------------------------
    // Load FULL schedule for public views
    // -----------------------------------
    const raw =
      (await env.ONCALL_KV.get("ONCALL:SCHEDULE")) ||
      (await env.ONCALL_KV.get("ONCALL:CURRENT"));

    const schedule = raw
      ? JSON.parse(raw)
      : { entries: [] };

    return new Response(
      JSON.stringify({
        // 🔑 IMPORTANT: FLATTEN THE RESPONSE
        entries: Array.isArray(schedule.entries)
          ? schedule.entries
          : [],

        tz: schedule.tz || "America/Chicago",
        updatedAt: schedule.updatedAt || null
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
        entries: [],
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

//export async function onRequest() {
  //return new Response(JSON.stringify({ entries: [] }), {
    //headers: { "content-type": "application/json" }
  //});
//}


export async function onRequest({ env }) {
  try {
    // -----------------------------------
    // Load CURRENT on-call (public-safe)
    // -----------------------------------
    const rawCurrent = await env.ONCALL_KV.get("ONCALL:CURRENT");
    const current = rawCurrent ? JSON.parse(rawCurrent) : null;

    // -----------------------------------
    // Load schedule (for timeline view)
    // -----------------------------------
    const rawSchedule = await env.ONCALL_KV.get("ONCALL:SCHEDULE");
    const schedule = rawSchedule ? JSON.parse(rawSchedule) : null;

    return new Response(
      JSON.stringify({
        ok: true,
        current,                 // single active entry (or null)
        schedule: schedule
          ? {
              tz: schedule.tz,
              updatedAt: schedule.updatedAt,
              entries: schedule.entries
            }
          : null
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
        ok: false,
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

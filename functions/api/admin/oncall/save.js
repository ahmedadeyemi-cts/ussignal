export async function onRequest({ request, env }) {
  try {
    // -------------------------------
    // Auth (ADMIN ONLY)
    // -------------------------------
    const jwt = request.headers.get("cf-access-jwt-assertion");
    if (!jwt) {
      return json({ error: "Unauthorized" }, 401);
    }

    // -------------------------------
    // Parse body
    // -------------------------------
    const body = await request.json();
    const schedule = body?.schedule;

    if (!schedule || !Array.isArray(schedule.entries)) {
      return json({ error: "Invalid schedule payload" }, 400);
    }

    const now = new Date();

    // -------------------------------
    // Archive past entries (immutable)
    // -------------------------------
    for (const entry of schedule.entries) {
      if (!entry?.id || !entry?.endISO) continue;

      const end = new Date(entry.endISO);
      if (end >= now) continue;

      const historyKey = `ONCALL:HISTORY:${entry.id}`;
      const exists = await env.ONCALL_KV.get(historyKey);

      if (!exists) {
        await env.ONCALL_KV.put(
          historyKey,
          JSON.stringify({
            ...entry,
            archivedAt: new Date().toISOString(),
            archivedBy: "admin"
          })
        );
      }
    }

    // -------------------------------
    // Save FULL schedule (admin use)
    // -------------------------------
    const finalizedSchedule = {
      version: schedule.version ?? 1,
      tz: schedule.tz ?? "America/Chicago",
      updatedAt: new Date().toISOString(),
      updatedBy: "admin",
      entries: schedule.entries
    };

    await env.ONCALL_KV.put(
      "ONCALL:SCHEDULE",
      JSON.stringify(finalizedSchedule)
    );

    // -------------------------------
    // Derive CURRENT on-call entry
    // -------------------------------
    const currentEntry = schedule.entries.find(e => {
      if (!e?.startISO || !e?.endISO) return false;
      const start = new Date(e.startISO);
      const end = new Date(e.endISO);
      return now >= start && now < end;
    });

    if (currentEntry) {
      await env.ONCALL_KV.put(
        "ONCALL:CURRENT",
        JSON.stringify({
          ...currentEntry,
          computedAt: new Date().toISOString()
        })
      );
    } else {
      // Optional: clear current if nothing active
      await env.ONCALL_KV.delete("ONCALL:CURRENT");
    }

    return json({ ok: true });

  } catch (err) {
    console.error("SAVE ERROR:", err);
    return json(
      { error: "Save failed", detail: err.message },
      500
    );
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" }
  });
}

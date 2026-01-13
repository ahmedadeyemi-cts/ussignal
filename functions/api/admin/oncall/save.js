export async function onRequest({ request, env }) {
  try {
    // -------------------------------
    // Auth
    // -------------------------------
    const jwt = request.headers.get("cf-access-jwt-assertion");
    if (!jwt) {
      return json({ error: "Unauthorized" }, 401);
    }

    // -------------------------------
    // Parse body
    // -------------------------------
    const body = await request.json();
    const next = body?.schedule;

    if (!next || !Array.isArray(next.entries)) {
      return json({ error: "Invalid schedule payload" }, 400);
    }

    const now = new Date();

    // -------------------------------
    // Archive past entries (ONCE)
    // -------------------------------
    for (const entry of next.entries) {
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
    // OPTIONAL: prune archived entries
    // (uncomment if you want CURRENT = future + active only)
    // -------------------------------
    /*
    next.entries = next.entries.filter(e => {
      const end = new Date(e.endISO);
      return end >= now;
    });
    */

    // -------------------------------
    // Finalize schedule
    // -------------------------------
    const finalized = {
      version: next.version ?? 1,
      tz: next.tz ?? "America/Chicago",
      updatedAt: new Date().toISOString(),
      updatedBy: "admin",
      entries: next.entries
    };

    await env.ONCALL_KV.put(
      "ONCALL:CURRENT",
      JSON.stringify(finalized)
    );

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

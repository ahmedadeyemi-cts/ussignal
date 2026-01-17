export async function onRequestPost(ctx) {
  try {
    const { request, env } = ctx;

    const body = await request.json().catch(() => ({}));
    const { entryId, mode = "both", auto = false, retry = false } = body;

    if (!entryId) {
      return json({ error: "entryId required" }, 400);
    }

    // Load schedule
    const raw = await env.ONCALL_KV.get("ONCALL:SCHEDULE");
    if (!raw) {
      return json({ error: "schedule not found" }, 404);
    }

    const schedule = JSON.parse(raw);
    const entry = (schedule.entries || []).find(e => e.id === entryId);

    if (!entry) {
      return json({ error: "entry not found" }, 404);
    }

    // 🚧 TEMP: stub send logic (next phase)
    const emails = [];
    const sms = [];

    Object.values(entry.departments || {}).forEach(p => {
      if (mode !== "sms" && p.email) emails.push(p.email);
      if (mode !== "email" && p.phone) sms.push(p.phone);
    });

    // Return what WOULD be sent (safe test)
    return json({
      ok: true,
      entryId,
      mode,
      auto,
      retry,
      emails,
      sms
    });

  } catch (err) {
    console.error("notify failed:", err);
    return json({ error: err.message }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" }
  });
}

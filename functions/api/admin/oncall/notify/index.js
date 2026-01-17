export async function onRequestPost(ctx) {
  try {
    const { request, env } = ctx;
    const body = await request.json().catch(() => ({}));

    const {
      entryId,
      mode = "both",
      auto = false
    } = body;

    if (!entryId) {
      return json({ error: "entryId required" }, 400);
    }

    const raw = await env.ONCALL_KV.get("ONCALL:SCHEDULE");
    if (!raw) {
      return json({ error: "schedule not found" }, 404);
    }

    const schedule = JSON.parse(raw);
    const entry = schedule.entries?.find(e => e.id === entryId);
    if (!entry) {
      return json({ error: "entry not found" }, 404);
    }

    // Build recipients (same logic you validated)
    const emails = [];
    const sms = [];

    Object.values(entry.departments || {}).forEach(p => {
      if (mode !== "sms" && p.email) emails.push(p.email);
      if (mode !== "email" && p.phone) sms.push(p.phone);
    });

    // 🔍 Determine audit action
    let action = "NOTIFY_MANUAL";
    if (auto) {
      const day = new Date().getDay();
      action = day === 5
        ? "AUTO_NOTIFY_FRIDAY"
        : day === 1
          ? "AUTO_NOTIFY_MONDAY"
          : "AUTO_NOTIFY";
    }

    // 🧾 Write audit entry
    const audit = {
      ts: new Date().toISOString(),
      action,
      actor: auto ? "system" : "admin",
      entryId,
      mode,
      emails,
      sms
    };

    await env.ONCALL_KV.put(
      `AUDIT:${crypto.randomUUID()}`,
      JSON.stringify(audit)
    );

    return json({
      ok: true,
      action,
      entryId,
      emails,
      sms
    });

  } catch (err) {
    console.error("notify error:", err);
    return json({ error: err.message }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" }
  });
}

export async function onRequest({ request, env }) {
  try {
    auth(request);

    const entries = await request.json();

    for (const e of entries) {
      for (const dept of Object.values(e.departments)) {
        if (!dept.phone || !dept.phone.startsWith("+")) {
          throw new Error("Invalid or missing phone number");
        }
      }
    }

    const schedule = {
      version: 1,
      tz: "America/Chicago",
      updatedAt: new Date().toISOString(),
      updatedBy: "admin",
      entries
    };

    await env.ONCALL_KV.put("schedule", JSON.stringify(schedule));
    await env.ONCALL_KV.put("ONCALL:CURRENT", JSON.stringify(schedule));

    await audit(env, {
      action: "SCHEDULE_BULK_UPLOAD",
      entries: entries.length
    });

    return json({ ok: true });

  } catch (e) {
    return json({ error: e.message }, 400);
  }
}

/* helpers same as roster */

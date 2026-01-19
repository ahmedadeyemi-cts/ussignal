/**
 * POST /api/internal/oncall/notify
 *
 * Internal notification engine
 * NOT protected by Cloudflare Access
 * Protected via x-cron-secret
 */

export async function onRequest({ request, env }) {
  try {
    /* ---------------- AUTH ---------------- */
    const secret = env.CRON_SHARED_SECRET;
    if (!secret) {
      return json({ ok: false, error: "cron_secret_not_set" }, 500);
    }

    const hdr = request.headers.get("x-cron-secret");
    if (hdr !== secret) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    /* ---------------- PAYLOAD ---------------- */
    const body = await request.json().catch(() => ({}));

    const {
      auto = false,
      cronHint = "MANUAL",
      mode = "email"
    } = body;

    /* ---------------- LOAD DATA ---------------- */
    // Example — adapt to your existing KV keys
    const scheduleRaw = await env.ONCALL_KV.get("schedule", "json");

    if (!scheduleRaw || !scheduleRaw.entries) {
      return json({
        ok: false,
        error: "schedule_missing"
      }, 500);
    }

    /* ---------------- BUSINESS LOGIC ---------------- */
    const notified = [];

    for (const entry of scheduleRaw.entries) {
      if (!entry.email) continue;

      // Prevent duplicates
      if (entry.notified === true) continue;

      // 🔔 SEND EMAIL HERE (placeholder)
      // await sendEmail(entry.email, ...)

      entry.notified = true;
      notified.push(entry.email);
    }

    /* ---------------- PERSIST ---------------- */
    await env.ONCALL_KV.put(
      "schedule",
      JSON.stringify(scheduleRaw)
    );

    /* ---------------- AUDIT ---------------- */
    await env.ONCALL_KV.put(
      `audit:${Date.now()}`,
      JSON.stringify({
        ts: new Date().toISOString(),
        auto,
        cronHint,
        mode,
        notified
      })
    );

    return json({
      ok: true,
      auto,
      cronHint,
      mode,
      notifiedCount: notified.length,
      notified
    });

  } catch (err) {
    console.error("[internal:oncall:notify] fatal", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

/* ---------------- HELPERS ---------------- */

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}

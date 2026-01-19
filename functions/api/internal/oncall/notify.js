/**
 * POST /api/internal/oncall/notify
 * Internal-only notification engine
 * Protected via x-cron-secret
 */

export async function onRequestPost({ request, env }) {
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

    /* ---------------- BODY ---------------- */
    let payload = {};
    try {
      payload = await request.json();
    } catch {
      payload = {};
    }

    const {
      auto = false,
      cronHint = "MANUAL",
      mode = "email",
      dryRun = false
    } = payload;

    /* ---------------- LOAD SCHEDULE ---------------- */
    const raw = await env.ONCALL_KV.get("schedule", "json");
    if (!raw || !Array.isArray(raw.entries)) {
      return json({ ok: false, error: "schedule_missing" }, 500);
    }

    /* ---------------- FILTER TARGETS ---------------- */
    const targets = raw.entries.filter(e =>
      e.enabled !== false &&
      (mode === "email" || mode === "both")
    );

    /* ---------------- DRY RUN ---------------- */
    if (dryRun) {
      return json({
        ok: true,
        dryRun: true,
        cronHint,
        mode,
        count: targets.length,
        targets: targets.map(t => ({
          name: t.name,
          email: t.email
        }))
      });
    }

    /* ---------------- SEND (SIMULATED) ---------------- */
    const notified = [];
    for (const t of targets) {
      notified.push(t.email || t.name);
    }

    return json({
      ok: true,
      auto,
      cronHint,
      mode,
      notifiedCount: notified.length,
      notified
    });

  } catch (err) {
    console.error("[internal-notify] fatal", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

/* Explicitly reject other methods */
export async function onRequest() {
  return new Response("Method Not Allowed", { status: 405 });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}

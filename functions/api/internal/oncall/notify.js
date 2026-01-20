/**
 * POST /api/internal/oncall/notify
 *
 * On-Call Notification Engine (DATE-DRIVEN)
 * - Resolves active on-call window from ONCALL:SCHEDULE
 * - Monday: Email on-call + Admin digest
 * - Friday: Email + SMS on-call + Admin digest
 * - Supports dryRun=true
 * - NO admin routes
 * - NO Access
 */

export async function onRequestPost({ request, env }) {
  try {
    /* ---------------- AUTH ---------------- */
    const secret = env.CRON_SHARED_SECRET;
    if (!secret) {
      return json({ ok: false, error: "cron_secret_not_set" }, 500);
    }

    if (request.headers.get("x-cron-secret") !== secret) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    /* ---------------- INPUT ---------------- */
    const url = new URL(request.url);
    const dryRun = url.searchParams.get("dryRun") === "true";

    const body = await request.json().catch(() => ({}));
    const cronHint = body.cronHint || "UNKNOWN";
    const mode = body.mode || "email";

    /* ---------------- TIME ---------------- */
    const tz = "America/Chicago";
    const now = new Date(
      new Date().toLocaleString("en-US", { timeZone: tz })
    );

    /* ---------------- LOAD SCHEDULE ---------------- */
    const raw = await env.ONCALL_KV.get("ONCALL:SCHEDULE");
    if (!raw) {
      return json({ ok: false, error: "schedule_not_found" }, 404);
    }

    const schedule = JSON.parse(raw);
    const entries = Array.isArray(schedule.entries) ? schedule.entries : [];

    /* ---------------- RESOLVE ACTIVE WINDOW ---------------- */
    const active = entries.find(e => {
      const start = new Date(e.startISO);
      const end = new Date(e.endISO);
      return now >= start && now < end;
    });

    if (!active) {
      return json({
        ok: false,
        error: "no_active_oncall_window",
        now: now.toISOString()
      }, 404);
    }

    /* ---------------- RESOLVE PEOPLE ---------------- */
    const oncall = Object.entries(active.departments || {}).map(
      ([department, person]) => ({
        department,
        name: person.name,
        email: person.email,
        phone: person.phone || null
      })
    );

    /* ---------------- SUMMARY ---------------- */
    const summary = {
      window: {
        start: active.startISO,
        end: active.endISO
      },
      count: oncall.length,
      oncall
    };

    /* ---------------- DRY RUN ---------------- */
    if (dryRun) {
      return json({
        ok: true,
        triggeredBy: "engine",
        cronHint,
        mode,
        dryRun: true,
        summary
      });
    }

    /* ---------------- EMAIL: ONCALL ---------------- */
    await sendOncallEmail(env, {
      cronHint,
      window: summary.window,
      recipients: oncall
    });

    /* ---------------- EMAIL: ADMIN DIGEST ---------------- */
    if (env.ADMIN_NOTIFICATION) {
      await sendAdminDigest(env, {
        cronHint,
        now,
        summary
      });
    }

    /* ---------------- SMS (FRIDAY ONLY) ---------------- */
    if (cronHint === "FRIDAY") {
      for (const person of oncall) {
        if (!person.phone) continue;
        await sendSMS(env, {
          phone: person.phone,
          name: person.name,
          window: summary.window
        });
      }
    }

    /* ---------------- RESPONSE ---------------- */
    return json({
      ok: true,
      triggeredBy: "engine",
      cronHint,
      mode,
      dryRun: false,
      summary
    });

  } catch (err) {
    console.error("[oncall:notify] fatal", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

/* ============================================================
   EMAIL — ONCALL
============================================================ */

async function sendOncallEmail(env, payload) {
  if (!env.BREVO_API_KEY) return;

  const html = `
    <h2>📞 You Are On-Call</h2>
    <p><strong>Coverage Window</strong></p>
    <p>${payload.window.start} → ${payload.window.end}</p>
  `;

  const text =
`You are on-call.

Coverage window:
${payload.window.start} → ${payload.window.end}`;

  await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "accept": "application/json",
      "api-key": env.BREVO_API_KEY,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      sender: {
        name: env.BREVO_SENDER_NAME || "On-Call System",
        email: env.BREVO_SENDER_EMAIL
      },
      to: payload.recipients.map(p => ({
        email: p.email,
        name: p.name
      })),
      subject: "📞 On-Call Assignment",
      htmlContent: html,
      textContent: text
    })
  });
}

/* ============================================================
   EMAIL — ADMIN DIGEST
============================================================ */

async function sendAdminDigest(env, payload) {
  const html = `
    <h2>📊 On-Call Digest (${payload.cronHint})</h2>
    <pre>${JSON.stringify(payload.summary, null, 2)}</pre>
    <p><strong>UTC:</strong> ${new Date().toISOString()}</p>
  `;

  await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "accept": "application/json",
      "api-key": env.BREVO_API_KEY,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      sender: {
        name: env.BREVO_SENDER_NAME || "On-Call Cron",
        email: env.BREVO_SENDER_EMAIL
      },
      to: [{ email: env.ADMIN_NOTIFICATION }],
      subject: `📊 On-Call Digest — ${payload.cronHint}`,
      htmlContent: html,
      textContent: JSON.stringify(payload.summary, null, 2)
    })
  });
}

/* ============================================================
   SMS — FRIDAY ONLY
============================================================ */

async function sendSMS(env, payload) {
  if (!env.SMS_PROVIDER_URL || !env.BREVO_API_KEY) return;

  await fetch(env.SMS_PROVIDER_URL, {
    method: "POST",
    headers: {
      "accept": "application/json",
      "api-key": env.BREVO_API_KEY,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      sender: "OnCall",
      recipient: payload.phone,
      content:
        `You are on-call.\n` +
        `Window:\n${payload.window.start} → ${payload.window.end}`
    })
  });
}

/* ============================================================
   HELPERS
============================================================ */

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}

export async function onRequestPost(ctx) {
  try {
    const { request, env } = ctx;
    const body = await request.json().catch(() => ({}));

    const {
      entryId,
      mode = "both",     // email | both
      auto = false
    } = body;

    if (!entryId) {
      return json({ error: "entryId required" }, 400);
    }

    /* =============================
     * Load schedule + entry
     * ============================= */
    const raw = await env.ONCALL_KV.get("ONCALL:SCHEDULE");
    if (!raw) return json({ error: "schedule not found" }, 404);

    const schedule = JSON.parse(raw);
    const entry = schedule.entries?.find(e => e.id === entryId);
    if (!entry) return json({ error: "entry not found" }, 404);

    /* =============================
     * Build recipients
     * ============================= */
    const to = [];
    Object.values(entry.departments || {}).forEach(p => {
      if (p?.email) {
        to.push({
          email: p.email,
          name: p.name || "On-Call Engineer"
        });
      }
    });

    if (!to.length) {
      return json({ error: "no email recipients" }, 400);
    }

    /* =============================
     * Email content
     * ============================= */
    const start = new Date(entry.startISO);
    const end = new Date(entry.endISO);

    const fmt = d =>
      d.toLocaleString("en-US", {
        timeZone: schedule.tz || "America/Chicago",
        weekday: "long",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true
      }) + " CST";

    const subject = auto
      ? "Upcoming On-Call Assignment"
      : "On-Call Notification";

    const html = `
      <div style="font-family:Arial,sans-serif">
        <h2>US Signal On-Call Notice</h2>
        <p>You are scheduled for on-call support.</p>

        <p><strong>Start:</strong> ${fmt(start)}<br/>
           <strong>End:</strong> ${fmt(end)}</p>

        <p>
          View the full schedule:<br/>
          <a href="${env.PUBLIC_PORTAL_URL}">
            ${env.PUBLIC_PORTAL_URL}
          </a>
        </p>

        <hr/>
        <small>This message was sent automatically.</small>
      </div>
    `;

    /* =============================
     * Send email (Brevo)
     * ============================= */
    if (mode === "email" || mode === "both") {
      await sendBrevo(env, {
        to,
        subject,
        html
      });
    }

    /* =============================
     * Audit entry
     * ============================= */
    const action = auto
      ? (new Date().getDay() === 5
          ? "AUTO_NOTIFY_FRIDAY"
          : new Date().getDay() === 1
            ? "AUTO_NOTIFY_MONDAY"
            : "AUTO_NOTIFY")
      : "NOTIFY_MANUAL";

    const audit = {
      ts: new Date().toISOString(),
      action,
      actor: auto ? "system" : "admin",
      entryId,
      emails: to.map(r => r.email)
    };

    await env.ONCALL_KV.put(
      `AUDIT:${crypto.randomUUID()}`,
      JSON.stringify(audit)
    );

    return json({
      ok: true,
      emailsSent: to.length,
      action
    });

  } catch (err) {
    console.error("notify error:", err);
    return json({ error: err.message }, 500);
  }
}

/* =============================
 * Brevo helper
 * ============================= */
async function sendBrevo(env, { to, subject, html }) {
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "api-key": env.BREVO_API_KEY
    },
    body: JSON.stringify({
      sender: {
        email: env.BREVO_SENDER_EMAIL,
        name: env.BREVO_SENDER_NAME
      },
      to,
      subject,
      htmlContent: html
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Brevo error ${res.status}: ${text}`);
  }
  if (!res.ok) {
  const text = await res.text();
  throw new Error(`Brevo error ${res.status}: ${text}`);
}
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" }
  });
}

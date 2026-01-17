export async function onRequestPost(ctx) {
  try {
    const { request, env } = ctx;
    const body = await request.json().catch(() => ({}));

    const {
      entryId,
      mode = "both",     // email | sms | both
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
    const emailRecipients = [];
    const smsRecipients = [];

    Object.values(entry.departments || {}).forEach(p => {
      if (p?.email) {
        emailRecipients.push({
          email: p.email,
          name: p.name || "On-Call Engineer"
        });
      }
      if (p?.phone) {
        smsRecipients.push({
          phone: p.phone,
          name: p.name || "On-Call Engineer"
        });
      }
    });

    if (
      (mode === "email" || mode === "both") &&
      !emailRecipients.length
    ) {
      return json({ error: "no email recipients" }, 400);
    }

    if (
      (mode === "sms" || mode === "both") &&
      !smsRecipients.length
    ) {
      return json({ error: "no sms recipients" }, 400);
    }

    /* =============================
     * Email + SMS content
     * ============================= */
    const start = new Date(entry.startISO);
    const end = new Date(entry.endISO);

    const tz = schedule.tz || "America/Chicago";
    const fmt = d =>
      d.toLocaleString("en-US", {
        timeZone: tz,
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

        <p>
          <strong>Start:</strong> ${fmt(start)}<br/>
          <strong>End:</strong> ${fmt(end)}
        </p>

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

    const smsMessage =
      `US Signal On-Call: Your on-call duty starts ${fmt(start)} and ends ${fmt(end)}.`;

    /* =============================
     * Send Email (FIRST)
     * ============================= */
    if (mode === "email" || mode === "both") {
      await sendBrevoEmail(env, {
        to: emailRecipients,
        subject,
        html
      });
    }

    /* =============================
     * Send SMS (SECOND)
     * ============================= */
    if (mode === "sms" || mode === "both") {
      for (const r of smsRecipients) {
        await sendBrevoSMS(env, {
          to: r.phone,
          message: smsMessage
        });
      }
    }

    /* =============================
     * Audit entry
     * ============================= */
    const day = new Date().getDay();
    const action = auto
      ? (day === 5
          ? "AUTO_NOTIFY_FRIDAY"
          : day === 1
            ? "AUTO_NOTIFY_MONDAY"
            : "AUTO_NOTIFY")
      : "NOTIFY_MANUAL";

    const audit = {
      ts: new Date().toISOString(),
      action,
      actor: auto ? "system" : "admin",
      entryId,
      mode,
      emails: emailRecipients.map(r => r.email),
      phones: smsRecipients.map(r => r.phone)
    };

    await env.ONCALL_KV.put(
      `AUDIT:${crypto.randomUUID()}`,
      JSON.stringify(audit)
    );

    return json({
      ok: true,
      action,
      emailsSent: emailRecipients.length,
      smsSent: smsRecipients.length
    });

  } catch (err) {
    console.error("NOTIFY ERROR:", err);
    return json({ error: err.message }, 500);
  }
}

/* =============================
 * Brevo Email helper
 * ============================= */
async function sendBrevoEmail(env, { to, subject, html }) {
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

  const text = await res.text();
  console.log("BREVO EMAIL STATUS:", res.status);
  console.log("BREVO EMAIL BODY:", text);

  if (!res.ok) {
    throw new Error(`Brevo email error ${res.status}: ${text}`);
  }
}

/* =============================
 * Brevo SMS helper
 * ============================= */
async function sendBrevoSMS(env, { to, message }) {
  const res = await fetch("https://api.brevo.com/v3/transactionalSMS/send", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "api-key": env.BREVO_API_KEY
    },
    body: JSON.stringify({
      sender: env.SMS_SENDER_ID || "USSignal",
      recipient: to,
      content: message,
      type: "transactional"
    })
  });

  const text = await res.text();
  console.log("BREVO SMS STATUS:", res.status);
  console.log("BREVO SMS BODY:", text);

  if (!res.ok) {
    throw new Error(`Brevo SMS error ${res.status}: ${text}`);
  }
}

/* =============================
 * JSON helper
 * ============================= */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" }
  });
}

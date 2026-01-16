export async function onRequest({ request, env }) {
  try {
    // =========================================================
    // AUTH (Cloudflare Access)
    // =========================================================
    const jwt = request.headers.get("cf-access-jwt-assertion");
    if (!jwt) return json({ error: "Unauthorized" }, 401);

    // =========================================================
    // ENV VALIDATION
    // =========================================================
    const required = [
      "BREVO_API_KEY",
      "BREVO_SENDER_EMAIL",
      "BREVO_SENDER_NAME",
      "PUBLIC_PORTAL_URL"
    ];

    const missing = required.filter(k => !env[k]);
    if (missing.length) {
      return json(
        { error: "Missing email configuration", missing },
        500
      );
    }

    // =========================================================
    // CONSTANTS
    // =========================================================
    const TZ = "America/Chicago";

    const DEPT_LABELS = {
      enterprise_network: "Enterprise Network",
      collaboration: "Collaboration Systems",
      system_storage: "System & Storage"
    };

    const BRAND = {
      primary: "#002B5C",
      accent: "#E5E7EB",
      logo: "https://oncall.onenecklab.com/ussignal.jpg",
      footer: "© US Signal. All rights reserved."
    };

    // =========================================================
    // PARSE REQUEST
    // =========================================================
    const payload = request.method === "POST"
      ? await request.json().catch(() => ({}))
      : {};

    const mode = payload.mode || "both";   // email | sms | both
    const entryId = payload.entryId || null;
    const auto = !!payload.auto;

    // =========================================================
    // LOAD FULL SCHEDULE
    // =========================================================
    const raw = await env.ONCALL_KV.get("ONCALL:SCHEDULE");
    if (!raw) return json({ error: "Schedule not found" }, 400);

    const schedule = JSON.parse(raw);
    if (!Array.isArray(schedule.entries)) {
      return json({ error: "Invalid schedule data" }, 500);
    }

    // =========================================================
    // SELECT TARGET ENTRY
    // =========================================================
    const now = new Date(
      new Date().toLocaleString("en-US", { timeZone: TZ })
    );

    const targets = entryId
      ? schedule.entries.filter(e => String(e.id) === String(entryId))
      : schedule.entries.filter(e => {
          const s = new Date(e.startISO);
          const en = new Date(e.endISO);
          return now >= s && now <= en;
        });

    if (!targets.length) {
      return json({ error: "No matching on-call entry found" }, 400);
    }

    let emailsSent = 0;
    let smsSent = [];

    // =========================================================
    // PROCESS EACH ENTRY
    // =========================================================
    for (const entry of targets) {
      entry.notification ||= { email: null, sms: [] };

      // -------------------------------------------------------
      // FORMAT DATES
      // -------------------------------------------------------
      const fmt = d =>
        d.toLocaleString("en-US", {
          timeZone: TZ,
          weekday: "long",
          month: "2-digit",
          day: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: true
        }) + " CST";

      const startLabel = fmt(new Date(entry.startISO));
      const endLabel = fmt(new Date(entry.endISO));

      const weekStart = new Date(entry.startISO)
        .toLocaleDateString("en-US");

      // -------------------------------------------------------
      // BUILD RECIPIENT LIST
      // -------------------------------------------------------
      const to = [];
      const teamLines = [];

      for (const [dep, person] of Object.entries(entry.departments || {})) {
        if (!person?.email) continue;

        to.push({
          email: person.email,
          name: person.name || ""
        });

        teamLines.push(`
          <li>
            <strong>${DEPT_LABELS[dep] || dep}</strong><br/>
            ${person.name || ""}<br/>
            📧 ${person.email}<br/>
            📱 ${person.phone || "—"}
          </li>
        `);
      }

      // -------------------------------------------------------
      // EMAIL
      // -------------------------------------------------------
      if ((mode === "email" || mode === "both") && to.length) {
        await sendBrevo(env, {
          to,
          subject: `REMINDER: ONCALL FOR WEEK STARTING ${weekStart}`,
          html: `
            <table width="100%" style="font-family:Arial;padding:24px">
              <tr><td>
                <img src="${BRAND.logo}" style="max-width:180px" />
                <h2 style="color:${BRAND.primary}">
                  On-Call Reminder
                </h2>

                <p>
                  This is an <strong>REMINDER</strong> message. You are scheduled
                  to provide on-call support during the next week.
                </p>

                <p><strong>Start:</strong><br/>${startLabel}</p>
                <p><strong>End:</strong><br/>${endLabel}</p>

                <ul>${teamLines.join("")}</ul>

                <p>
                  View schedule:
                  <a href="${env.PUBLIC_PORTAL_URL}">
                    ${env.PUBLIC_PORTAL_URL}
                  </a>
                </p>

                <p style="font-size:12px;color:#6b7280">
                  ${BRAND.footer}
                </p>
              </td></tr>
            </table>
          `
        });

        entry.notification.email = {
          sentAt: new Date().toISOString(),
          by: auto ? "system" : "admin"
        };

        emailsSent++;
      }

      // -------------------------------------------------------
      // SMS
      // -------------------------------------------------------
      if (mode === "sms" || mode === "both") {
        for (const person of Object.values(entry.departments || {})) {
          if (!person?.phone) continue;

          const res = await sendSMS(env, {
            to: person.phone,
            message:
              `US Signal On-Call Reminder:\n` +
              `Start: ${startLabel}\nEnd: ${endLabel}`
          });

          entry.notification.sms.push({
            phone: person.phone,
            ok: res.ok,
            status: res.status || "queued",
            ts: new Date().toISOString()
          });

          smsSent.push(person.phone);
        }
      }
    }

    // =========================================================
    // PERSIST SCHEDULE (CRITICAL)
    // =========================================================
    await env.ONCALL_KV.put(
      "ONCALL:SCHEDULE",
      JSON.stringify(schedule)
    );

    // =========================================================
    // AUDIT LOG
    // =========================================================
    await audit(env, {
      action: "NOTIFY",
      entryId,
      emailsSent,
      smsSent,
      actor: auto ? "system" : "admin"
    });

    return json({
      ok: true,
      emailsSent,
      smsSent
    });

  } catch (err) {
    console.error("NOTIFY ERROR:", err);
    return json(
      { error: "Notify failed", detail: err.message },
      500
    );
  }
}

// =============================================================
// HELPERS
// =============================================================
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}

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
    throw new Error(`Brevo email error ${res.status}: ${text}`);
  }
}

async function sendSMS(env, { to, message }) {
  const res = await fetch(
    "https://api.brevo.com/v3/transactionalSMS/send",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${env.BREVO_API_KEY}`
      },
      body: JSON.stringify({
        to,
        message,
        sender: env.SMS_SENDER_ID || "USSignal"
      })
    }
  );

  return { ok: res.ok, status: res.status };
}

async function audit(env, record) {
  const raw = await env.ONCALL_KV.get("ONCALL:AUDIT");
  const log = raw ? JSON.parse(raw) : [];

  log.unshift({
    ts: new Date().toISOString(),
    ...record
  });

  await env.ONCALL_KV.put(
    "ONCALL:AUDIT",
    JSON.stringify(log.slice(0, 500))
  );
}

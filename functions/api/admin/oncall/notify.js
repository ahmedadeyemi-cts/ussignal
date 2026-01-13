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
    // Load schedule
    // -------------------------------
    const raw = await env.ONCALL_KV.get("ONCALL:CURRENT");
    if (!raw) {
      return json({ error: "No schedule found" }, 400);
    }

    const schedule = JSON.parse(raw);
    const entries = schedule.entries || [];

    if (!entries.length) {
      return json({ error: "No entries to notify" }, 400);
    }

    // -------------------------------
    // Determine CURRENT on-call
    // -------------------------------
    const now = new Date();

    const active = entries.filter(e => {
      const start = new Date(e.startISO);
      const end = new Date(e.endISO);
      return now >= start && now <= end;
    });

    if (!active.length) {
      return json({ error: "No active on-call entry" }, 400);
    }

    // -------------------------------
    // Build recipients + content
    // -------------------------------
    const admins = env.ADMIN_NOTIFICATION
      .split(",")
      .map(e => e.trim())
      .filter(Boolean);

    const portal = env.PUBLIC_PORTAL_URL;

    let emailsSent = 0;

    for (const entry of active) {
      const to = [];
      const teamLines = [];

      for (const [team, person] of Object.entries(entry.departments || {})) {
        if (!person?.email) continue;

        to.push({
          email: person.email,
          name: person.name || team
        });

        teamLines.push(
          `<li><strong>${team}</strong>: ${person.name} (${person.email})</li>`
        );
      }

      if (!to.length) continue;

      const html = `
        <p>Hello,</p>
        <p>You are currently on call.</p>

        <ul>${teamLines.join("")}</ul>

        <p>
          View the full on-call schedule:
          <a href="${portal}">${portal}</a>
        </p>
      `;

      await sendBrevo(env, {
        to,
        cc: admins,
        subject: "You Are Currently On Call",
        html
      });

      emailsSent++;
    }

    // -------------------------------
    // Audit
    // -------------------------------
    await audit(env, {
      action: "MANUAL_NOTIFY",
      entries: active.length,
      emailsSent
    });

    return json({ ok: true, emailsSent });

  } catch (err) {
    // THIS is what was missing before
    console.error("NOTIFY ERROR:", err);
    return json(
      { error: "Notify failed", detail: err.message },
      500
    );
  }
}

/* ================================================= */

async function sendBrevo(env, { to, cc, subject, html }) {
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
      cc: cc.map(email => ({ email })),
      subject,
      htmlContent: html
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Brevo error: ${text}`);
  }
}

async function audit(env, record) {
  const raw = (await env.ONCALL_KV.get("ONCALL:AUDIT")) || "[]";
  const audit = JSON.parse(raw);

  audit.unshift({
    ts: new Date().toISOString(),
    actor: "admin",
    ...record
  });

  await env.ONCALL_KV.put(
    "ONCALL:AUDIT",
    JSON.stringify(audit.slice(0, 500))
  );
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" }
  });
}

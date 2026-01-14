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
// Brevo env validation
// -------------------------------
const missing = [];

if (!env.BREVO_API_KEY) missing.push("BREVO_API_KEY");
if (!env.BREVO_SENDER_EMAIL) missing.push("BREVO_SENDER_EMAIL");
if (!env.BREVO_SENDER_NAME) missing.push("BREVO_SENDER_NAME");

if (missing.length) {
  console.error("Missing Brevo env vars:", missing);
  return json(
    {
      error: "Email configuration incomplete",
      missing
    },
    500
  );
}
    // -------------------------------
    // Parse request body
    // -------------------------------
    let payload = {};
    if (request.method === "POST") {
      try {
        payload = await request.json();
      } catch {
        payload = {};
      }
    }

    const mode = payload.mode || "both"; // both | start | end
    const entryId = payload.entryId || null;

    // -------------------------------
    // Load current schedule
    // -------------------------------
    const raw = await env.ONCALL_KV.get("ONCALL:CURRENT");
    if (!raw) {
      return json({ error: "No schedule found" }, 400);
    }

    const schedule = JSON.parse(raw);
    const entries = schedule.entries || [];

    if (!entries.length) {
      return json({ error: "No entries available" }, 400);
    }

    // -------------------------------
    // Determine target entries
    // -------------------------------
    const now = new Date();

    let targets = [];

    if (entryId) {
      const found = entries.find(e => String(e.id) === String(entryId));
      if (!found) {
        return json({ error: "Entry not found" }, 404);
      }
      targets = [found];
    } else {
      targets = entries.filter(e => {
        const start = new Date(e.startISO);
        const end = new Date(e.endISO);
        return now >= start && now <= end;
      });
    }

    if (!targets.length) {
      return json({ error: "No active on-call entries" }, 400);
    }

    // -------------------------------
    // Prevent notify on past entries
    // -------------------------------
    for (const e of targets) {
      const end = new Date(e.endISO);
      if (end <= now) {
        return json(
          { error: "Cannot notify for past on-call entries" },
          400
        );
      }
    }

    // -------------------------------
    // Build recipients + content
    // -------------------------------
    const admins = (env.ADMIN_NOTIFICATION || "")
      .split(",")
      .map(e => e.trim())
      .filter(Boolean);

    const portal = env.PUBLIC_PORTAL_URL;
    let emailsSent = 0;

    for (const entry of targets) {
      const to = [];
const teamLines = [];

// CASE 1: New multi-department structure
if (entry.departments && typeof entry.departments === "object") {
  for (const [team, person] of Object.entries(entry.departments)) {
    if (!person?.email) continue;

    to.push({
      email: person.email,
      name: person.name || team
    });

    teamLines.push(
      `<li><strong>${team}</strong>: ${person.name || ""} (${person.email})</li>`
    );
  }
}

// CASE 2: Legacy / flat entry structure
else if (entry.email) {
  to.push({
    email: entry.email,
    name: entry.name || "On-Call"
  });

  teamLines.push(
    `<li><strong>${entry.department || "On-Call"}</strong>: ${entry.name || ""} (${entry.email})</li>`
  );
}

    if (!to.length) {
  console.warn(
    "Notify skipped — no recipients found",
    {
      entryId: entry.id,
      department: entry.department,
      startISO: entry.startISO,
      endISO: entry.endISO
    }
  );
  continue;
}


      const subject =
        mode === "start"
          ? "On-Call Duty Started"
          : mode === "end"
          ? "On-Call Duty Ending"
          : "You Are Currently On Call";

      const html = `
        <p>Hello,</p>
        <p>
          ${
            mode === "start"
              ? "Your on-call duty has started."
              : mode === "end"
              ? "Your on-call duty is ending."
              : "You are currently on call."
          }
        </p>

        <ul>${teamLines.join("")}</ul>

        <p>
          View the full on-call schedule:<br/>
          <a href="${portal}">${portal}</a>
        </p>
      `;

      await sendBrevo(env, {
        to,
        cc: admins,
        subject,
        html
      });

      emailsSent++;
    }

    // -------------------------------
    // Audit
    // -------------------------------
    await audit(env, {
      action: entryId ? "MANUAL_NOTIFY_ENTRY" : "MANUAL_NOTIFY_ACTIVE",
      mode,
      entryId,
      emailsSent
    });

    return json({ ok: true, emailsSent });

  } catch (err) {
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
      cc: Array.isArray(cc) && cc.length
  ? cc.map(email => ({ email }))
  : undefined,
      subject,
      htmlContent: html
    })
  });

  if (!res.ok) {
  const text = await res.text();
  console.error("BREVO RESPONSE:", res.status, text);
  throw new Error(`Brevo error (${res.status}): ${text}`);
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

/**
 * ============================================================
 * CRON — ON-CALL AUTO NOTIFY
 * ------------------------------------------------------------
 * • Monday: notify upcoming Friday on-call
 * • Friday: notify on-call starts today
 * • Prevents duplicate sends
 * • Persists notify state per entry
 * • Logs to ONCALL:AUDIT
 * ============================================================
 */

export async function onRequest({ env }) {
  try {
    // --------------------------------------------------
    // ENV VALIDATION
    // --------------------------------------------------
    const missing = [];
    if (!env.BREVO_API_KEY) missing.push("BREVO_API_KEY");
    if (!env.BREVO_SENDER_EMAIL) missing.push("BREVO_SENDER_EMAIL");
    if (!env.BREVO_SENDER_NAME) missing.push("BREVO_SENDER_NAME");
    if (!env.PUBLIC_PORTAL_URL) missing.push("PUBLIC_PORTAL_URL");

    if (missing.length) {
      console.error("[cron-notify] Missing env vars:", missing);
      return json({ ok: false, error: "Missing env vars", missing }, 500);
    }

    // --------------------------------------------------
    // LOAD CURRENT SCHEDULE
    // --------------------------------------------------
    const raw = await env.ONCALL_KV.get("ONCALL:CURRENT");
    if (!raw) {
      return json({ ok: true, reason: "No schedule found" });
    }

    const current = JSON.parse(raw);

// Normalize to array
const entries = Array.isArray(current.entries)
  ? current.entries
  : [current];

if (!entries.length || !entries[0]?.startISO) {
  return json({ ok: true, reason: "No entries available" });
}

// Wrap into schedule shape for downstream functions
const schedule = { entries };


    // --------------------------------------------------
    // DATE CONTEXT (UTC)
    // --------------------------------------------------
    const now = new Date();
    const todayYMD = now.toISOString().slice(0, 10);
    const weekday = now.getUTCDay(); // 1=Mon, 5=Fri

    let targets = [];
    let mode = "";

    // --------------------------------------------------
    // MONDAY → UPCOMING FRIDAY
    // --------------------------------------------------
    if (weekday === 1) {
      const friday = new Date(now);
      friday.setUTCDate(friday.getUTCDate() + 4);
      const fridayYMD = friday.toISOString().slice(0, 10);

      targets = entries.filter(e =>
        e.startISO?.startsWith(fridayYMD)
      );

      mode = "UPCOMING";
    }

    // --------------------------------------------------
    // FRIDAY → STARTS TODAY
    // --------------------------------------------------
    if (weekday === 5) {
      targets = entries.filter(e =>
        e.startISO?.startsWith(todayYMD)
      );

      mode = "START_TODAY";
    }

    if (!targets.length) {
      return json({ ok: true, reason: "No matching entries" });
    }

    // --------------------------------------------------
    // SEND NOTIFICATIONS
    // --------------------------------------------------
    const sent = await sendNotifications(env, schedule, targets, mode);

    // --------------------------------------------------
    // SAVE UPDATED SCHEDULE (persist notify state)
    // --------------------------------------------------
    await env.ONCALL_KV.put(
  "ONCALL:CURRENT",
  JSON.stringify(entries[0])
);

    return json({
      ok: true,
      mode,
      notified: sent,
      entriesChecked: targets.length
    });

  } catch (err) {
    console.error("[cron-notify] ERROR:", err);
    return json(
      { ok: false, error: "Cron notify failed", detail: err.message },
      500
    );
  }
}

/* ============================================================
   SEND NOTIFICATIONS
============================================================ */

async function sendNotifications(env, schedule, entries, mode) {
  const admins = (env.ADMIN_NOTIFICATION || "")
    .split(",")
    .map(e => e.trim())
    .filter(Boolean);

  const portal = env.PUBLIC_PORTAL_URL;
  let sent = 0;

  for (const entry of entries) {
    // ----------------------------------------------
    // DUPLICATE PROTECTION
    // ----------------------------------------------
    if (entry.notifiedAt) {
      continue;
    }

    const recipients = [];
    const teamLines = [];

    // ----------------------------------------------
    // MULTI-DEPARTMENT STRUCTURE
    // ----------------------------------------------
    if (entry.departments && typeof entry.departments === "object") {
      for (const [dept, person] of Object.entries(entry.departments)) {
        if (!person?.email) continue;

        recipients.push({
          email: person.email,
          name: person.name || dept
        });

        teamLines.push(
          `<li><strong>${dept}</strong>: ${person.name || ""} (${person.email})</li>`
        );
      }
    }

    // ----------------------------------------------
    // LEGACY STRUCTURE
    // ----------------------------------------------
    else if (entry.email) {
      recipients.push({
        email: entry.email,
        name: entry.name || "On-Call"
      });

      teamLines.push(
        `<li><strong>${entry.department || "On-Call"}</strong>: ${entry.name || ""} (${entry.email})</li>`
      );
    }

    if (!recipients.length) {
      console.warn("[cron-notify] No recipients for entry", entry.id);
      continue;
    }

    // ----------------------------------------------
    // EMAIL CONTENT
    // ----------------------------------------------
    const subject =
      mode === "UPCOMING"
        ? "Upcoming On-Call Begins Friday"
        : "On-Call Begins Today";

    const html = `
      <p>Hello,</p>

      <p>
        ${
          mode === "UPCOMING"
            ? "This is a reminder that your on-call assignment begins this Friday."
            : "Your on-call assignment begins today."
        }
      </p>

      <ul>${teamLines.join("")}</ul>

      <p>
        View the full on-call schedule:<br/>
        <a href="${portal}">${portal}</a>
      </p>
    `;

    // ----------------------------------------------
    // SEND EMAIL
    // ----------------------------------------------
    await sendBrevo(env, {
      to: recipients,
      cc: admins,
      subject,
      html
    });

    // ----------------------------------------------
    // PERSIST NOTIFY STATE
    // ----------------------------------------------
    entry.notifiedAt = new Date().toISOString();
    entry.notifyMode = mode;
    entry.notifiedBy = "system";

    sent++;
  }

  // ----------------------------------------------
  // AUDIT
  // ----------------------------------------------
  await audit(env, {
    action: "CRON_NOTIFY",
    mode,
    sent
  });

  return sent;
}

/* ============================================================
   BREVO
============================================================ */

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
      to: to.map(r => ({
        email: r.email,
        name: r.name
      })),
      cc: Array.isArray(cc) && cc.length
        ? cc.map(email => ({ email }))
        : undefined,
      subject,
      htmlContent: html
    })
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("[Brevo] ERROR:", res.status, text);
    throw new Error(`Brevo error (${res.status})`);
  }
}

/* ============================================================
   AUDIT
============================================================ */

async function audit(env, record) {
  const raw = (await env.ONCALL_KV.get("ONCALL:AUDIT")) || "[]";
  const audit = JSON.parse(raw);

  audit.unshift({
    ts: new Date().toISOString(),
    actor: "system",
    ...record
  });

  await env.ONCALL_KV.put(
    "ONCALL:AUDIT",
    JSON.stringify(audit.slice(0, 500))
  );
}

/* ============================================================
   RESPONSE
============================================================ */

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" }
  });
}

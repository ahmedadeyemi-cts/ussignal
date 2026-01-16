export async function onRequest({ request, env }) {
  try {
    // -------------------------------
    // Auth
    // -------------------------------
    const BRAND = {
  primary: "#002B5C", // US Signal Navy
  accent: "#E5E7EB",
  logo: "https://oncall.onenecklab.com/ussignal.jpg",
  footer: "© US Signal. All rights reserved."
};

    const DEPT_LABELS = {
      enterprise_network: "Enterprise Network",
      collaboration: "Collaboration Systems",
      system_storage: "System & Storage"
    };
    const jwt = request.headers.get("cf-access-jwt-assertion");
    if (!jwt) {
      return json({ error: "Unauthorized" }, 401);
    }
    console.log("NOTIFY ENV CHECK", {
  hasKey: !!env.BREVO_API_KEY,
  senderEmail: env.BREVO_SENDER_EMAIL,
  senderName: env.BREVO_SENDER_NAME,
  admins: env.ADMIN_NOTIFICATION,
  portal: env.PUBLIC_PORTAL_URL
});

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

    const current = JSON.parse(raw);

// Normalize into an array so the rest of the code works
const entries = Array.isArray(current.entries)
  ? current.entries
  : [current];

if (!entries.length) {
  return json({ error: "No on-call entry available" }, 400);
}


// -------------------------------
// Determine target entries (timezone-aware)
// -------------------------------
const tz = current.tz || "America/Chicago";

const now = new Date(
  new Date().toLocaleString("en-US", { timeZone: tz })
);

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

    // Active OR upcoming (admin-triggered)
    return (
      now >= start && now <= end ||   // active
      start > now                     // upcoming
    );
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
            // -------------------------------
      // Prevent duplicate notifications
      // -------------------------------
     if (entry.notifiedAt) {
  console.warn("Notify skipped — already notified", {
    entryId: entry.id,
    notifiedAt: entry.notifiedAt
  });
  continue;
}
          // -------------------------------
// Dynamic date formatting (per entry)
// -------------------------------
const start = new Date(entry.startISO);
const end = new Date(entry.endISO);

const fmt = (d) =>
  d.toLocaleString("en-US", {
    timeZone: "America/Chicago",
    weekday: "long",
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  }) + " CST";

const startLabel = fmt(start);
const endLabel = fmt(end);

const weekStart = start.toLocaleDateString("en-US", {
  month: "2-digit",
  day: "2-digit",
  year: "numeric"
});
const isUpcoming =
  start > new Date() &&
  start.getTime() - Date.now() > 24 * 60 * 60 * 1000;

const notifyType = isUpcoming ? "UPCOMING" : "START_TODAY";

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

   const label = DEPT_LABELS[team] || team;

teamLines.push(`
  <li>
    <strong>${label}</strong>: ${person.name || ""}
    <br/>Email: ${person.email || "—"}
    <br/>Phone: ${person.phone || "—"}
  </li>
`);

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
  notifyType === "UPCOMING"
    ? `REMINDER: ONCALL FOR WEEK STARTING ${weekStart}`
    : `ONCALL STARTS TODAY – ${weekStart}`;

     const html =
  notifyType === "UPCOMING"
    ? `
<table width="100%" cellpadding="0" cellspacing="0" style="font-family: Arial, sans-serif; background:#f4f6f8; padding:24px;">
  <tr>
    <td>
      <img src="${BRAND.logo}" alt="US Signal" style="max-width:180px;margin-bottom:16px;" />

<h2 style="color:${BRAND.primary};">On-Call Reminder</h2>


      <p>
        This is an <strong>REMINDER</strong> message. You are scheduled to provide
        on-call support during the upcoming week.
      </p>

      <p><strong>On-call support begins:</strong><br/>${startLabel}</p>
      <p><strong>On-call support ends:</strong><br/>${endLabel}</p>

      <p>
        If you need to make changes, please contact your Team Lead or Manager.
      </p>

      <hr style="border:none;border-top:1px solid ${BRAND.accent};margin:24px 0;" />

      <ul>${teamLines.join("")}</ul>

      <p>
        View the full on-call schedule:<br/>
        <a href="${portal}">${portal}</a>
      </p>
      <p style="margin-top:32px;font-size:12px;color:#6b7280;text-align:center;">
  ${BRAND.footer}
</p>

    </td>
  </tr>
</table>
`
    : `
<table width="100%" cellpadding="0" cellspacing="0" style="font-family: Arial, sans-serif; background:#fff7ed; padding:24px;">
  <tr>
    <td>
     <img src="${BRAND.logo}" alt="US Signal" style="max-width:180px;margin-bottom:16px;" />

<h2 style="color:${BRAND.primary};">On-Call Starts Today</h2>


      <p>
        This is a notification that your <strong>on-call duty begins today</strong>.
      </p>

      <p><strong>Start:</strong><br/>${startLabel}</p>
      <p><strong>End:</strong><br/>${endLabel}</p>

      <hr style="border:none;border-top:1px solid ${BRAND.accent};margin:24px 0;" />

      <ul>${teamLines.join("")}</ul>

      <p>
        Access the on-call portal:<br/>
        <a href="${portal}">${portal}</a>
      </p>
      <p style="margin-top:32px;font-size:12px;color:#6b7280;text-align:center;">
  ${BRAND.footer}
</p>

    </td>
  </tr>
</table>
`;
      await sendBrevo(env, {
        to,
        cc: admins,
        subject,
        html
      });
      // -------------------------------
// Persist EMAIL notification state
// -------------------------------
entry.notification = entry.notification || {};
entry.notification.email = {
  sentAt: new Date().toISOString(),
  subject
};

entry.smsStatus ||= [];

if (notifyType === "START_TODAY") {
  for (const [_, person] of Object.entries(entry.departments || {})) {
    if (!person?.phone) continue;

    const sms = await sendSMS(env, {
      to: person.phone,
      message: `US Signal On-Call: Your on-call duty starts now and ends ${endLabel}.`
    });

    entry.smsStatus.push({
      phone: person.phone,
      ok: sms.ok,
      messageId: sms.messageId || null,
      error: sms.error || null,
      sentAt: new Date().toISOString()
    });
  }
}
      // -------------------------------
// Persist SMS notification state
// -------------------------------
entry.notification = entry.notification || {};
entry.notification.sms = {
  sentAt: new Date().toISOString()
};

      emailsSent++;
      entry.notifiedAt = new Date().toISOString();
      entry.notifyMode = mode;
      entry.notifiedBy = payload.auto ? "system" : "admin";
    }
// DO NOT overwrite ONCALL:CURRENT here
// It is derived ONLY by save.js

// -------------------------------
// Audit (FINAL – Pages-safe)
// -------------------------------
await audit(env, {
  action: entryId ? "MANUAL_NOTIFY_ENTRY" : "MANUAL_NOTIFY_ACTIVE",
  mode,
  entryId,
  emailsSent,
  actor: payload.auto ? "system" : "admin",

  emails: targets.flatMap(e =>
    Object.values(e.departments || {})
      .map(p => p.email)
      .filter(Boolean)
  ),

  phones: targets.flatMap(e =>
    Object.values(e.departments || {})
      .map(p => p.phone)
      .filter(Boolean)
  )
});
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
    // -------------------------------
    // SMS Sending
    // -------------------------------
async function sendSMS(env, { to, message }) {
  if (!env.SMS_PROVIDER_API_KEY) {
    console.warn("SMS skipped — no Brevo API key");
    return { ok: false, error: "Missing API key" };
  }

  const res = await fetch(
    "https://api.brevo.com/v3/transactionalSMS/send",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${env.SMS_PROVIDER_API_KEY}`
      },
      body: JSON.stringify({
        from: env.SMS_SENDER_ID || "USSignal OnCall",
        to,
        message
      })
    }
  );

  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch {}

  if (!res.ok) {
    console.error("SMS FAILED", res.status, data || text);
    return {
      ok: false,
      status: res.status,
      error: data?.message || text
    };
  }

  return {
    ok: true,
    messageId: data.messageId || null
  };
}

    
// Persist notification marker in schedule
const scheduleRaw = await env.ONCALL_KV.get("ONCALL:SCHEDULE");
if (scheduleRaw) {
  const schedule = JSON.parse(scheduleRaw);

  const target = schedule.entries.find(e => e.id === entry.id);
  if (target) {
    target.notifiedAt = new Date().toISOString();
    target.notifiedType = notifyType;
    target.notifiedBy = payload.auto ? "system" : "admin";

    await env.ONCALL_KV.put(
      "ONCALL:SCHEDULE",
      JSON.stringify({
        ...schedule,
        updatedAt: new Date().toISOString(),
        updatedBy: "notify"
      })
    );
  }
}

async function audit(env, record) {
  const raw = (await env.ONCALL_KV.get("ONCALL:AUDIT")) || "[]";
  const audit = JSON.parse(raw);

  audit.unshift({
    ts: new Date().toISOString(),
    actor: record.actor || "admin",
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
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}

export async function onRequest({ request, env }) {
  // -----------------------------
  // Method guard
  // -----------------------------
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // -----------------------------
  // Cloudflare Access auth
  // -----------------------------
  const jwt = request.headers.get("cf-access-jwt-assertion");
  const actor =
    request.headers.get("cf-access-authenticated-user-email") || "unknown";

  if (!jwt) {
    return new Response("Unauthorized", { status: 401 });
  }

  // -----------------------------
  // Read body (mode + optional entryId)
  // -----------------------------
  let body = {};
  try {
    body = await request.json();
  } catch {}

  const mode = (body.mode || "both").toLowerCase(); // start | end | both
  const entryId = body.entryId || null;

  // -----------------------------
  // Load schedule
  // -----------------------------
  const raw = await env.ONCALL_KV.get("ONCALL:CURRENT");
  if (!raw) {
    return json({ error: "No schedule found" }, 400);
  }

  const schedule = JSON.parse(raw);
  let entries = schedule.entries || [];

  if (entryId) {
    entries = entries.filter(e => String(e.id) === String(entryId));
  }

  if (!entries.length) {
    return json({ error: "No matching entries to notify" }, 400);
  }

  // -----------------------------
  // Brevo config
  // -----------------------------
  if (!env.BREVO_API_KEY) {
    return json({ error: "BREVO_API_KEY not configured" }, 500);
  }

  const senderEmail = env.BREVO_SENDER_EMAIL || "noreply@oncall.onenecklab.com";
  const senderName = env.BREVO_SENDER_NAME || "On-Call Scheduler";

  // -----------------------------
  // Send notifications
  // -----------------------------
  let sent = 0;

  for (const entry of entries) {
    const start = entry.startISO;
    const end = entry.endISO;
    const departments = entry.departments || {};

    for (const dept of Object.keys(departments)) {
      const person = departments[dept];
      if (!person?.email) continue;

      const subject =
        mode === "start"
          ? `On-Call Begins (${start})`
          : mode === "end"
          ? `On-Call Ends (${end})`
          : `On-Call Assignment (${start} → ${end})`;

      const html = `
        <p>Hello ${person.name || ""},</p>
        <p>You have an on-call assignment.</p>
        <ul>
          <li><b>Department:</b> ${dept}</li>
          <li><b>Start:</b> ${start}</li>
          <li><b>End:</b> ${end}</li>
        </ul>
        <p>Please ensure availability.</p>
      `;

      await sendBrevo(env, {
        senderEmail,
        senderName,
        to: person.email,
        subject,
        html
      });

      sent++;
    }
  }

  // -----------------------------
  // Audit log
  // -----------------------------
  const audit = (await env.ONCALL_KV.get("ONCALL:AUDIT")) || "[]";
  const auditLog = JSON.parse(audit);

  auditLog.unshift({
    ts: new Date().toISOString(),
    actor,
    action: "NOTIFY",
    mode,
    entryId: entryId || "ALL",
    sent
  });

  await env.ONCALL_KV.put(
    "ONCALL:AUDIT",
    JSON.stringify(auditLog.slice(0, 500))
  );

  return json({ ok: true, sent });
}

/* ============================= */

async function sendBrevo(env, { senderEmail, senderName, to, subject, html }) {
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "api-key": env.BREVO_API_KEY
    },
    body: JSON.stringify({
      sender: { email: senderEmail, name: senderName },
      to: [{ email: to }],
      subject,
      htmlContent: html
    })
  });

  if (!res.ok) {
    const msg = await res.text();
    throw new Error(`Brevo error ${res.status}: ${msg}`);
  }
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

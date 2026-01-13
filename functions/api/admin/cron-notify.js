export async function onRequest({ env }) {
  const raw = await env.ONCALL_KV.get("ONCALL:CURRENT");
  if (!raw) return json({ ok: false, reason: "No schedule" });

  const schedule = JSON.parse(raw);
  const entries = schedule.entries || [];

  const today = new Date();
  const todayYMD = today.toISOString().slice(0, 10);
  const weekday = today.getUTCDay(); // 1=Mon, 5=Fri

  let targets = [];
  let mode = "";

  // -------------------------------
  // MONDAY → upcoming Friday
  // -------------------------------
  if (weekday === 1) {
    const friday = new Date(today);
    friday.setUTCDate(friday.getUTCDate() + 4);
    const fridayYMD = friday.toISOString().slice(0, 10);

    targets = entries.filter(e => e.startISO.startsWith(fridayYMD));
    mode = "UPCOMING";
  }

  // -------------------------------
  // FRIDAY → starts today
  // -------------------------------
  if (weekday === 5) {
    targets = entries.filter(e => e.startISO.startsWith(todayYMD));
    mode = "START_TODAY";
  }

  if (!targets.length) {
    return json({ ok: true, reason: "No matching entries" });
  }

  await sendNotifications(env, targets, mode);

  return json({ ok: true, mode, entries: targets.length });
}

/* ================================================= */

async function sendNotifications(env, entries, mode) {
  const admins = env.ADMIN_NOTIFICATION.split(",").map(e => e.trim());
  const portal = env.PUBLIC_PORTAL_URL;

  let sent = 0;

  for (const entry of entries) {
    const teamLines = [];
    const recipients = [];

    for (const [dept, person] of Object.entries(entry.departments || {})) {
      if (!person?.email) continue;

      recipients.push({ email: person.email, name: person.name });
      teamLines.push(
        `<li><b>${dept}</b>: ${person.name} (${person.email})</li>`
      );
    }

    if (!recipients.length) continue;

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
        View the full schedule:
        <a href="${portal}">${portal}</a>
      </p>
    `;

    await sendBrevo(env, {
      to: recipients,
      cc: admins,
      subject,
      html
    });

    sent++;
  }

  await audit(env, {
    action: "CRON_NOTIFY",
    mode,
    sent
  });
}

/* ================================================= */

async function sendBrevo(env, { to, cc, subject, html }) {
  await fetch("https://api.brevo.com/v3/smtp/email", {
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
      to: to.map(e => ({ email: e.email, name: e.name })),
      cc: cc.map(email => ({ email })),
      subject,
      htmlContent: html
    })
  });
}

async function audit(env, record) {
  const raw = (await env.ONCALL_KV.get("ONCALL:AUDIT")) || "[]";
  const audit = JSON.parse(raw);

  audit.unshift({
    ts: new Date().toISOString(),
    actor: "system",
    ...record
  });

  await env.ONCALL_KV.put("ONCALL:AUDIT", JSON.stringify(audit.slice(0, 500)));
}

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { "content-type": "application/json" }
  });
}

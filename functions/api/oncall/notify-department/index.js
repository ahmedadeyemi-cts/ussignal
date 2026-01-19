/**
 * POST /api/oncall/notify-department
 *
 * Public IVR-triggered endpoint.
 * Notifies the on-call engineer for a selected department.
 */

export async function onRequest({ request, env }) {
  try {
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ ok: false, error: "Invalid JSON" }, 400);
    }

    const {
      department,
      pin,
      customerName,
      customerPhone
    } = payload || {};

    // --------------------------------------------------
    // Basic validation (IVR-safe)
    // --------------------------------------------------
    if (
      !department ||
      !["collaboration", "system_storage", "enterprise_network"].includes(department) ||
      !pin ||
      !/^\d{4,8}$/.test(pin) ||
      !customerName ||
      !customerPhone
    ) {
      return json({ ok: false, error: "Invalid request" }, 400);
    }

    // --------------------------------------------------
    // Load on-call schedule
    // --------------------------------------------------
    const raw = await env.ONCALL_KV.get("ONCALL:SCHEDULE");
    if (!raw) {
      return json({ ok: false, error: "Schedule unavailable" }, 503);
    }

    const schedule = JSON.parse(raw);
    const entries = Array.isArray(schedule.entries) ? schedule.entries : [];
    if (!entries.length) {
      return json({ ok: false, error: "No schedule entries" }, 404);
    }

    const tz = schedule.tz || "America/Chicago";
    const now = nowInTz(tz);

    // --------------------------------------------------
    // Find active on-call entry
    // --------------------------------------------------
    const active = entries.find(e => {
      const start = new Date(e.startISO);
      const end = new Date(e.endISO);
      return now >= start && now <= end;
    });

    if (!active || !active.departments?.[department]) {
      return json({
        ok: false,
        error: "No on-call engineer found"
      }, 404);
    }

    const engineer = active.departments[department];
    if (!engineer?.email) {
      return json({
        ok: false,
        error: "Engineer missing contact info"
      }, 404);
    }

    // --------------------------------------------------
    // Send email
    // --------------------------------------------------
    await sendBrevoEmail(env, {
      to: [{
        email: engineer.email,
        name: engineer.name || "On-Call Engineer"
      }],
      subject: `Customer Support Call – ${prettyDept(department)}`,
      html: buildEmail({
        engineer,
        department,
        pin,
        customerName,
        customerPhone
      })
    });

    return json({
      ok: true,
      department,
      notified: true
    });

  } catch (err) {
    console.error("[notify-department] error", err);
    return json({ ok: false, error: "Internal error" }, 500);
  }
}

/* =================================================
 * Helpers
 * ================================================= */

function nowInTz(tz) {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: tz })
  );
}

function prettyDept(d) {
  return ({
    collaboration: "Collaboration",
    system_storage: "System & Storage",
    enterprise_network: "Enterprise Network"
  })[d] || d;
}

function buildEmail({ department, pin, customerName, customerPhone }) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:640px">
      <p>
        You are receiving this email because <b>${customerName}</b> called
        the One Assist number for support and selected your department.
      </p>

      <p>
        <b>Department:</b> ${prettyDept(department)}<br/>
        <b>Customer PIN:</b> ${pin}<br/>
        <b>Customer Phone:</b> ${customerPhone}
      </p>

      <p>
        Please ensure you are in communication with the customer as soon as possible.
      </p>
    </div>
  `;
}

async function sendBrevoEmail(env, { to, subject, html }) {
  const replyTo =
    env.BREVO_REPLY_TO ||
    env.BREVO_SENDER_EMAIL;

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
      htmlContent: html,
      replyTo: {
        email: replyTo,
        name: "One Assist"
      }
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Brevo failed: ${body}`);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}

export const onRequestPost = onRequest;

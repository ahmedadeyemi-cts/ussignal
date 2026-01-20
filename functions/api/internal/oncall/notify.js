/**
 * POST /api/internal/oncall/notify
 *
 * Internal on-call notification engine
 * - Email (Mon + Fri)
 * - SMS (Friday only)
 * - Admin digest
 * - dryRun supported
 */

export async function onRequestPost({ request, env }) {
  try {
    /* ---------------- AUTH ---------------- */
    const secret = env.CRON_SHARED_SECRET;
    if (!secret) {
      return json({ ok: false, error: "cron_secret_not_set" }, 500);
    }

    if (request.headers.get("x-cron-secret") !== secret) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    /* ---------------- INPUT ---------------- */
    const body = await request.json().catch(() => ({}));
    const dryRun = body.dryRun === true;
    const cronHint = body.cronHint || "UNKNOWN";
    const mode = body.mode || "email";

    /* ---------------- LOAD SCHEDULE ---------------- */
    const raw = await env.ONCALL_KV.get("ONCALL:SCHEDULE");
    if (!raw) {
      return json({ ok: false, error: "schedule_not_found" }, 404);
    }

    const schedule = JSON.parse(raw);
    const entries = Array.isArray(schedule.entries)
      ? schedule.entries
      : [];

    /* ---------------- BUILD SUMMARY ---------------- */
    const oncall = entries.map(e => ({
      id: e.id,
      name: e.name,
      email: e.email,
      phone: e.phone || null,
      department: e.department
    }));

    /* ---------------- EMAIL: ONCALL ---------------- */
    if (!dryRun && (mode === "email" || mode === "both")) {
      for (const person of oncall) {
        if (!person.email) continue;

        await sendEmail(env, {
          to: person.email,
          subject: `On-Call Reminder (${cronHint})`,
          html: `
            <p>Hello ${person.name},</p>
            <p>You are scheduled for <strong>${cronHint}</strong> on-call coverage.</p>
            <p>Please be ready.</p>
          `
        });
      }
    }

    /* ---------------- SMS: FRIDAY ONLY ---------------- */
    if (!dryRun && cronHint === "FRIDAY") {
      for (const person of oncall) {
        if (!person.phone) continue;

        await sendSMS(env, {
          to: person.phone,
          message: `On-call reminder: You are on-call this Friday. Please be ready.`
        });
      }
    }

    /* ---------------- ADMIN DIGEST ---------------- */
    if (!dryRun && env.ADMIN_NOTIFICATION) {
      await sendEmail(env, {
        to: env.ADMIN_NOTIFICATION,
        subject: `On-Call Digest (${cronHint})`,
        html: `
          <h3>On-Call Summary</h3>
          <ul>
            ${oncall.map(p => `<li>${p.name} – ${p.email}</li>`).join("")}
          </ul>
        `
      });
    }

    /* ---------------- RESPONSE ---------------- */
    return json({
      ok: true,
      triggeredBy: "engine",
      cronHint,
      mode,
      dryRun,
      summary: {
        count: oncall.length,
        oncall
      }
    });

  } catch (err) {
    console.error("[oncall:notify] fatal", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

/* ================= EMAIL ================= */

async function sendEmail(env, { to, subject, html }) {
  if (!env.BREVO_API_KEY) return;

  return fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": env.BREVO_API_KEY,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      sender: {
        name: env.BREVO_SENDER_NAME || "On-Call System",
        email: env.BREVO_SENDER_EMAIL
      },
      to: [{ email: to }],
      subject,
      htmlContent: html
    })
  });
}

/* ================= SMS (BREVO) ================= */

async function sendSMS(env, { to, message }) {
  if (!env.BREVO_API_KEY || !env.SMS_PROVIDER_URL) return;

  return fetch(env.SMS_PROVIDER_URL, {
    method: "POST",
    headers: {
      "api-key": env.BREVO_API_KEY,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      sender: "OnCall",
      recipient: to.replace(/^\+/, ""),
      content: message,
      type: "transactional"
    })
  });
}

/* ================= UTIL ================= */

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}

/**
 * POST /api/internal/cron/oncall
 *
 * Cron + manual trigger
 * Protected via x-cron-secret
 */

export async function onRequest({ request, env }) {
  try {
    /* ---------------- AUTH ---------------- */
    const secret = env.CRON_SHARED_SECRET;
    if (!secret) {
      return json({ ok: false, error: "cron_secret_not_set" }, 500);
    }

    const hdr = request.headers.get("x-cron-secret");
    if (hdr !== secret) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    /* ---------------- TIME ---------------- */
    const now = new Date(
      new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })
    );

    const day = now.getDay(); // 1=Mon, 5=Fri
    let cronHint = null;
    let mode = null;

    if (day === 1) {
      cronHint = "MONDAY";
      mode = "email";
    } else if (day === 5) {
      cronHint = "FRIDAY";
      mode = "both";
    } else {
      return json({
        ok: true,
        cronHint: "NONE",
        message: "No cron action today",
        now: now.toISOString()
      });
    }

    /* ---------------- CALL INTERNAL ENGINE ---------------- */
    const res = await fetch(
      `${env.PUBLIC_PORTAL_URL}/api/internal/oncall/notify`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cron-secret": secret
        },
        body: JSON.stringify({
          auto: true,
          cronHint,
          mode
        })
      }
    );

   const text = await res.text();

await sendCronHeartbeatEmail(env, {
  cronHint,
  mode,
  status: res.status,
  ok: res.ok
});

return json({
  ok: res.ok,
  status: res.status,
  cronHint,
  mode,
  response: safeJSON(text)
});


  } catch (err) {
    console.error("[cron:oncall] fatal", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

/* ---------------- HELPERS ---------------- */
async function sendCronHeartbeatEmail(env, payload) {
  try {
    if (!env.BREVO_API_KEY) return;

    await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "api-key": env.BREVO_API_KEY,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        sender: {
          name: env.BREVO_SENDER_NAME || "On-Call Cron",
          email: env.BREVO_SENDER_EMAIL
        },
        to: [
          { email: "ahmed.adeyemi@ussignal.com", name: "Ahmed Adeyemi" }
        ],
        subject: `✅ On-Call Cron Fired (${payload.cronHint || "NONE"})`,
        htmlContent: `
          <h3>Cron Fired Successfully</h3>
          <pre>${JSON.stringify(payload, null, 2)}</pre>
          <p><strong>UTC:</strong> ${new Date().toISOString()}</p>
        `
      })
    });
  } catch (err) {
    console.warn("[cron-heartbeat] email failed", err);
  }
}

function safeJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}

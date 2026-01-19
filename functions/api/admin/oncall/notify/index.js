/**
 * functions/api/admin/oncall/notify/index.js
 *
 * FINAL — AUTHORITATIVE NOTIFICATION SERVICE
 *
 * Features:
 * - Brevo Email + Brevo SMS
 * - Optional Microsoft Teams webhook
 * - Manual + Cron invocation
 * - Dry-run support (no sends, no KV writes)
 * - Cron time-window enforcement (CST by default)
 * - Per-engineer notification windows
 * - Dedupe via KV (entry + channel + notifyType)
 * - Structured audit logging
 * - Production-safe (cron can never spam)
 *
 * Expected POST payload:
 * {
 *   mode: "both" | "email" | "sms",
 *   entryId?: string,
 *   auto?: boolean,
 *   cronHint?: "FRIDAY" | "MONDAY",
 *   dryRun?: boolean
 * }
 */

export async function onRequest(ctx) {
  const { request, env } = ctx;

  try {
    /* =================================================
     * BRANDING
     * ================================================= */
    const BRAND = {
      primary: "#002B5C",
      accent: "#E5E7EB",
      logo: "https://oncall.onenecklab.com/ussignal.jpg",
      footer: "© US Signal. All rights reserved."
    };

    const DEPT_LABELS = {
      enterprise_network: "Enterprise Network",
      collaboration: "Collaboration Systems",
      system_storage: "System & Storage"
    };

    /* =================================================
     * CONFIG
     * ================================================= */
    const CFG = {
      tzDefault: env.ONCALL_TZ || "America/Chicago",

      cron: {
        enforceWindow:
          env.CRON_ENFORCE_WINDOW === undefined
            ? true
            : String(env.CRON_ENFORCE_WINDOW).toLowerCase() === "true",

        fridayWindow: {
          start: env.CRON_FRIDAY_WINDOW_START || "07:00",
          end: env.CRON_FRIDAY_WINDOW_END || "10:00"
        },
        mondayWindow: {
          start: env.CRON_MONDAY_WINDOW_START || "07:00",
          end: env.CRON_MONDAY_WINDOW_END || "10:00"
        }
      },

      personWindow: {
        start: env.NOTIFY_WINDOW_START || "07:00",
        end: env.NOTIFY_WINDOW_END || "19:00"
      },

      upcoming: {
        minHoursBeforeStart: env.UPCOMING_MIN_HOURS
          ? Number(env.UPCOMING_MIN_HOURS)
          : 24
      },

      kv: {
        scheduleKey: "ONCALL:SCHEDULE",
        auditKey: "ONCALL:AUDIT",
        notifyPrefix: "ONCALL:NOTIFY_STATE:"
      }
    };

    /* =================================================
     * PARSE REQUEST
     * ================================================= */
    let payload = {};
    if (request.method === "POST") {
      try {
        payload = await request.json();
      } catch {}
    }

    const {
  mode = "both",
  entryId = null,
  auto = false,
  cronHint = null,
  dryRun = false,
  force = false
} = payload;


    const sendEmail = mode === "both" || mode === "email";
    const sendSMS = mode === "both" || mode === "sms";

    /* =================================================
     * ENV VALIDATION
     * ================================================= */
    const missing = [];
    if (sendEmail && !env.BREVO_API_KEY) missing.push("BREVO_API_KEY");
    if (sendEmail && !env.BREVO_SENDER_EMAIL) missing.push("BREVO_SENDER_EMAIL");
    if (sendEmail && !env.BREVO_SENDER_NAME) missing.push("BREVO_SENDER_NAME");
    if (sendSMS && !env.BREVO_API_KEY) missing.push("BREVO_API_KEY (SMS)");

    if (missing.length) {
      return json({ error: "Missing env vars", missing }, 500);
    }

    /* =================================================
     * LOAD SCHEDULE
     * ================================================= */
    const raw = await env.ONCALL_KV.get(CFG.kv.scheduleKey);
    if (!raw) return json({ error: "Schedule not found" }, 404);

    const schedule = safeJson(raw, {});
    const entries = Array.isArray(schedule.entries) ? schedule.entries : [];
    if (!entries.length) return json({ error: "No entries found" }, 400);

    const tz = schedule.tz || CFG.tzDefault;
    const now = tzNow(tz);

    /* =================================================
     * TARGET ENTRIES
     * ================================================= */
    let targets = [];

    if (entryId) {
      const found = entries.find(e => String(e.id) === String(entryId));
      if (!found) return json({ error: "Entry not found" }, 404);
      targets = [found];
    } else {
      targets = entries.filter(e => {
        const s = new Date(e.startISO);
        const e2 = new Date(e.endISO);
        return (now >= s && now <= e2) || s > now;
      });
    }

    if (!targets.length) {
      return json({ error: "No active or upcoming entries" }, 400);
    }

    /* =================================================
     * CRON WINDOW ENFORCEMENT
     * ================================================= */
    if (auto && CFG.cron.enforceWindow) {
      const day = dayOfWeekInTz(now, tz);
      const hm = hhmmInTz(now, tz);

      const intended =
  cronHint === "FRIDAY"
    ? "FRIDAY"
    : cronHint === "MONDAY"
      ? "MONDAY"
      : day === "FRIDAY"
        ? "FRIDAY"
        : day === "MONDAY"
          ? "MONDAY"
          : "UNKNOWN";

      const allowed =
        intended === "FRIDAY"
          ? inHhmmWindow(hm, CFG.cron.fridayWindow.start, CFG.cron.fridayWindow.end)
          : intended === "MONDAY"
            ? inHhmmWindow(hm, CFG.cron.mondayWindow.start, CFG.cron.mondayWindow.end)
            : false;

      if (!allowed) {
        await audit(env, CFG, {
          action: "CRON_BLOCKED_WINDOW",
          actor: "system",
          cronHint: intended,
          hm,
          dryRun
        });

        return json({ ok: false, blocked: true, intended, hm }, 403);
      }
    }

    /* =================================================
     * PROCESS ENTRIES
     * ================================================= */
    let emailsSent = 0;
    let smsSent = 0;
    const skipped = [];

    for (const entry of targets) {
      const start = new Date(entry.startISO);
      const end = new Date(entry.endISO);

      const hoursUntilStart =
        (start.getTime() - now.getTime()) / (1000 * 60 * 60);

      const notifyType =
        start > now && hoursUntilStart >= CFG.upcoming.minHoursBeforeStart
          ? "UPCOMING"
          : "START_TODAY";

      const entryKey = entry.id || `${entry.startISO}:${entry.endISO}`;

      const emailKey = `${CFG.kv.notifyPrefix}${entryKey}:email:${notifyType}`;
      const smsKey = `${CFG.kv.notifyPrefix}${entryKey}:sms:${notifyType}`;

    const skipEmail =
  sendEmail &&
  !force &&
  !!(await env.ONCALL_KV.get(emailKey));

const skipSms =
  sendSMS &&
  !force &&
  !!(await env.ONCALL_KV.get(smsKey));

if (skipEmail) {
//  skipped.push({ entryKey, channel: "email", reason: "dedupe" });
  if (skipEmail) {
  skipped.push({
    entryKey,
    channel: "email",
    reason: force ? "forced_bypass_failed" : "dedupe"
  });
}

}
if (skipSms) {
  skipped.push({ entryKey, channel: "sms", reason: "dedupe" });
}

      /* ---------------------------------------------
       * RECIPIENTS
       * --------------------------------------------- */
      const emailTo = [];

// 🔔 Always include admin notification(s)
if (env.ADMIN_NOTIFICATION) {
  const admins = String(env.ADMIN_NOTIFICATION)
    .split(",")
    .map(e => e.trim())
    .filter(e => e.includes("@"));

  for (const email of admins) {
    emailTo.push({
      email,
      name: "On-Call Admin"
    });
  }
}
      const smsTo = [];

      for (const p of Object.values(entry.departments || {})) {
        if (!p) continue;

        const win = getPersonWindow(p, CFG.personWindow);
        const inWindow = inHhmmWindow(hhmmInTz(now, tz), win.start, win.end);

        if (sendEmail && p.email && (!auto || inWindow)) {
          emailTo.push({ email: p.email, name: p.name || "On-Call" });
        }

        if (sendSMS && p.phone && inWindow && notifyType === "START_TODAY") {
          smsTo.push(p.phone);
        }
      }

/* ---------------------------------------------
 * EMAIL
 * --------------------------------------------- */
if (sendEmail) {
  if (skipEmail) {
    skipped.push({
    entryKey,
    channel: "email",
    reason: force ? "forced_bypass_failed" : "dedupe"
  });
}

  } else if (emailTo.length === 0) {
    skipped.push({ entryKey, channel: "email", reason: "no_recipients" });

  } else if (dryRun) {
    skipped.push({
      entryKey,
      channel: "email",
      reason: "dry_run",
      recipients: emailTo.length
    });

  } else {
    // ✅ ACTUAL SEND
    const messageId = await sendBrevoEmail(env, {
      to: emailTo,
      subject:
        notifyType === "UPCOMING"
          ? "On-Call Reminder – Upcoming Week"
          : "On-Call Starts Today – Action Required",
      html: buildEmailHtml(
        BRAND,
        entry,
        tz,
        notifyType,
        env.PUBLIC_PORTAL_URL
      )
    });

    await env.ONCALL_KV.put(
      emailKey,
      JSON.stringify({
        ts: new Date().toISOString(),
        messageId
      }),
      { expirationTtl: 60 * 60 * 24 * 45 }
    );

    // ✅ COUNT ONE SEND PER ENTRY (not per recipient)
    emailsSent += 1;
  }
}


      /* ---------------------------------------------
       * SMS
       * --------------------------------------------- */
      if (sendSMS && smsTo.length && !skipSms) {
  for (const phone of smsTo) {
    if (!dryRun) {
      await sendBrevoSms(env, {
        to: phone,
        message: `US Signal On-Call: Your on-call duty starts now and ends ${formatCstFromIso(
          entry.endISO,
          tz
        )}.`
      });
    }
    smsSent++;
  }

        if (!dryRun) {
          await env.ONCALL_KV.put(
            smsKey,
            JSON.stringify({ ts: new Date().toISOString() }),
            { expirationTtl: 60 * 60 * 24 * 45 }
          );
        }
      }

      /* ---------------------------------------------
       * TEAMS WEBHOOK (OPTIONAL)
       * --------------------------------------------- */
      if (env.TEAMS_WEBHOOK_URL && !dryRun) {
        await sendTeamsWebhook(env.TEAMS_WEBHOOK_URL, entry, notifyType);
      }
    }

    /* =================================================
     * AUDIT
     * ================================================= */
  //**   await audit(env, CFG, {
    //**   action: auto
      //**   ? cronHint === "FRIDAY"
       //**    ? "AUTO_NOTIFY_FRIDAY"
       //**    : cronHint === "MONDAY"
        //**     ? "AUTO_NOTIFY_MONDAY"
        //**     : "AUTO_NOTIFY"
      //**   : "MANUAL_NOTIFY",
    //**   actor: auto ? "system" : "admin",
     //**  mode,
     //**  dryRun,
     //**  emailsSent,
     //**    smsSent,
    //**   skipped
    //** });

    return json({
  ok: emailsSent > 0 || smsSent > 0,
  dryRun,
  emailsSent,
  smsSent,
  skipped,
  note:
    emailsSent === 0 && sendEmail
      ? "No emails sent. Check skipped[] for reasons."
      : undefined
});
    
  } catch (err) {
    console.error("NOTIFY ERROR", err);
    return json({ error: err.message }, 500);
  }
}

/* =================================================
 * HELPERS
 * ================================================= */

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

function safeJson(s, f) {
  try {
    return JSON.parse(s);
  } catch {
    return f;
  }
}

function tzNow(tz) {
  return new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
}

function hhmmInTz(d, tz) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(d);
}

function dayOfWeekInTz(d, tz) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long"
  })
    .format(d)
    .toUpperCase();
}


function inHhmmWindow(hm, start, end) {
  return toMin(hm) >= toMin(start) && toMin(hm) <= toMin(end);
}

function toMin(hm) {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}

function getPersonWindow(p, fallback) {
  return {
    start: p.notifyWindowStart || fallback.start,
    end: p.notifyWindowEnd || fallback.end
  };
}

function formatCstFromIso(iso, tz) {
  return new Date(
    new Date(iso).toLocaleString("en-US", { timeZone: tz })
  ).toLocaleString("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  });
}

function buildEmailHtml(BRAND, entry, tz, type, portal) {
  const start = formatCstFromIso(entry.startISO, tz);
  const end = formatCstFromIso(entry.endISO, tz);

  const deptLines = Object.entries(entry.departments || {})
    .map(([key, p]) => {
      if (!p) return "";
      const label = ({
        enterprise_network: "Enterprise Network",
        collaboration: "Collaboration",
        system_storage: "System & Storage"
      })[key] || key;

      return `<li>
        <b>${label}:</b>
        ${p.name || "Unassigned"} –
        ${p.phone || "N/A"} –
        ${p.email || "N/A"}
      </li>`;
    })
    .join("");

  return `
  <div style="font-family:Arial, sans-serif; max-width:640px">
    <img src="${BRAND.logo}" style="max-width:180px;margin-bottom:16px"/>

    <p>
      This is an <b>on-call reminder</b> message. You are receiving this email
      because you are scheduled to provide on-call support during the upcoming week.
    </p>

    <p>
      <b>On-call support begins:</b><br/>
      ${start}
    </p>

    <p>
      <b>On-call support ends:</b><br/>
      ${end}
    </p>

    <p>
      Please reach out to your Manager or Team Lead if you need to make changes
      to your on-call availability.
    </p>

    <hr/>

    <p>
      <b>On-call schedule for week starting ${start}:</b>
    </p>

    <ul>
      ${deptLines}
    </ul>

    <p style="margin-top:16px">
      <a href="${portal}">View Schedule</a>
    </p>

    <hr/>
    <small>${BRAND.footer}</small>
  </div>
  `;
}
async function sendBrevoEmail(env, { to, subject, html }) {
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
      textContent: "On-call notification from US Signal.",
      replyTo: {
        email: env.ADMIN_NOTIFICATION || env.BREVO_SENDER_EMAIL,
        name: "On-Call Admin"
      }
    })
  });

  const raw = await res.text();
  let body;

  try {
    body = JSON.parse(raw);
  } catch {
    body = raw;
  }

  if (!res.ok) {
    throw new Error(
      `Brevo email failed ${res.status}: ${
        typeof body === "string" ? body : JSON.stringify(body)
      }`
    );
  }

  // ✅ IMPORTANT: return Brevo proof
  return body?.messageId || null;
}

async function sendBrevoSms(env, { to, message }) {
  const res = await fetch("https://api.brevo.com/v3/transactionalSMS/send", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "api-key": env.BREVO_API_KEY
    },
    body: JSON.stringify({
      sender: env.SMS_SENDER_ID || "USSignal",
      to,
      message
    })
  });

  const body = await res.text();

  if (!res.ok) {
    throw new Error(`Brevo SMS failed ${res.status}: ${body}`);
  }
}


async function sendTeamsWebhook(url, entry, type) {
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "On-Call Notification",
      text: `${type}: ${entry.startISO} → ${entry.endISO}`
    })
  });
}

async function audit(env, CFG, record) {
  try {
    const raw = (await env.ONCALL_KV.get(CFG.kv.auditKey)) || "[]";
    const log = safeJson(raw, []);
    log.unshift({ ts: new Date().toISOString(), ...record });

    const payload = JSON.stringify(log.slice(0, 200));
    if (payload.length > 24000) return;

    await env.ONCALL_KV.put(CFG.kv.auditKey, payload);
  } catch (err) {
    console.error("[audit] failed", err);
  }
}

export const onRequestPost = onRequest;
export const onRequestGet = onRequest;

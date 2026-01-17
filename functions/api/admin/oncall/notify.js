/**
 * functions/api/admin/oncall/notify.js
 *
 * DROP-IN (maintainable) notify endpoint:
 * - Brevo Email + Brevo SMS
 * - Cron-specific audit actions: AUTO_NOTIFY_FRIDAY, AUTO_NOTIFY_MONDAY
 * - Dry-run mode: payload.dryRun=true (no email/SMS + no state writes; logs + audit only)
 * - Cron time-window enforcement (CST by default; configurable)
 * - Per-engineer notification windows (configurable + optional per-person overrides)
 * - Dedupe WITHOUT overwriting ONCALL:CURRENT (stores notify state in KV per entry+channel+type)
 *
 * Expected POST payload (admin UI or cron):
 * {
 *   "mode": "both" | "email" | "sms",
 *   "entryId": "optional",
 *   "auto": true/false,          // cron sets true
 *   "cronHint": "FRIDAY"|"MONDAY",
 *   "dryRun": true/false
 * }
 */

export async function onRequest({ request, env }) {
  try {
    // -------------------------------
    // Brand / Labels
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

    // -------------------------------
    // CONFIG (centralized)
    // -------------------------------
    const CFG = {
      tzDefault: env.ONCALL_TZ || "America/Chicago",

      // Cron enforcement:
      // - Friday START_TODAY notifications should only run inside this window
      // - Monday UPCOMING notifications should only run inside this window
      cron: {
        // If true: cron calls outside allowed windows are blocked (and audited)
        enforceWindow: env.CRON_ENFORCE_WINDOW
          ? String(env.CRON_ENFORCE_WINDOW).toLowerCase() === "true"
          : true,

        // "HH:MM" in oncall timezone
        fridayWindow: {
          start: env.CRON_FRIDAY_WINDOW_START || "07:00",
          end: env.CRON_FRIDAY_WINDOW_END || "10:00"
        },
        mondayWindow: {
          start: env.CRON_MONDAY_WINDOW_START || "07:00",
          end: env.CRON_MONDAY_WINDOW_END || "10:00"
        }
      },

      // Per-engineer notification window (defaults)
      // - If person has a window override, it wins
      personWindow: {
        start: env.NOTIFY_WINDOW_START || "07:00",
        end: env.NOTIFY_WINDOW_END || "19:00"
      },

      // “Upcoming” reminder policy
      upcoming: {
        // Require at least this many hours before start to count as "upcoming"
        // (prevents sending UPCOMING on Thursday night for Friday morning if you don’t want it)
        minHoursBeforeStart: env.UPCOMING_MIN_HOURS
          ? Number(env.UPCOMING_MIN_HOURS)
          : 24
      },

      // KV keys
      kv: {
        currentKey: "ONCALL:CURRENT",
        auditKey: "ONCALL:AUDIT",
        notifyStatePrefix: "ONCALL:NOTIFY_STATE:" // + entryId + ":" + channel + ":" + type
      }
    };

    // -------------------------------
    // Auth (Cloudflare Access)
    // -------------------------------
    const jwt = request.headers.get("cf-access-jwt-assertion");
    if (!jwt) return json({ error: "Unauthorized" }, 401);

    // -------------------------------
    // Brevo env validation
    // -------------------------------
    const missing = [];
    if (!env.BREVO_API_KEY) missing.push("BREVO_API_KEY");
    if (!env.BREVO_SENDER_EMAIL) missing.push("BREVO_SENDER_EMAIL");
    if (!env.BREVO_SENDER_NAME) missing.push("BREVO_SENDER_NAME");
    // For SMS: Brevo uses the SAME api-key header (Brevo master key).
    // If you truly have separate keys, keep your separate env var and use it below,
    // but Brevo’s API generally expects the same api-key for transactional SMS too.
    const smsApiKey = env.SMS_PROVIDER_API_KEY || env.BREVO_API_KEY;
    if (!smsApiKey) missing.push("SMS_PROVIDER_API_KEY (or BREVO_API_KEY)");

    if (missing.length) {
      console.error("Missing env vars:", missing);
      return json({ error: "Notification configuration incomplete", missing }, 500);
    }

    console.log("NOTIFY ENV CHECK", {
      hasEmailKey: !!env.BREVO_API_KEY,
      hasSmsKey: !!smsApiKey,
      senderEmail: env.BREVO_SENDER_EMAIL,
      senderName: env.BREVO_SENDER_NAME,
      admins: env.ADMIN_NOTIFICATION,
      portal: env.PUBLIC_PORTAL_URL
    });

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

    const mode = payload.mode || "both"; // both | email | sms
    const entryId = payload.entryId || null;

    // -------------------------------
    // Invocation context (cron + dry-run)
    // -------------------------------
    const isCron = payload.auto === true;
    const dryRun = payload.dryRun === true;
    const cronHint = payload.cronHint || null; // FRIDAY | MONDAY

    const sendEmail = mode === "both" || mode === "email";
    const allowSMS = mode === "both" || mode === "sms";

    // -------------------------------
    // Load current schedule
    // -------------------------------
    const raw = await env.ONCALL_KV.get(CFG.kv.currentKey);
    if (!raw) return json({ error: "No schedule found" }, 400);

    const current = safeJson(raw, {});
    const entries = Array.isArray(current.entries) ? current.entries : [current];
    if (!entries.length) return json({ error: "No on-call entry available" }, 400);

    // -------------------------------
    // Timezone-aware "now"
    // -------------------------------
    const tz = current.tz || CFG.tzDefault;
    const now = tzNow(tz);

    // -------------------------------
    // Determine target entries
    // -------------------------------
    let targets = [];
    if (entryId) {
      const found = entries.find(e => String(e.id) === String(entryId));
      if (!found) return json({ error: "Entry not found" }, 404);
      targets = [found];
    } else {
      targets = entries.filter(e => {
        const start = new Date(e.startISO);
        const end = new Date(e.endISO);
        return (now >= start && now <= end) || start > now; // active OR upcoming
      });
    }

    // if (!targets.length) return json({ error: "No active on-call entries" }, 400);
      if (!targets.length && !entryId) {
  return json({ error: "No active on-call entries" }, 400);
}

    // -------------------------------
    // Prevent notify on past entries
    // -------------------------------
    for (const e of targets) {
      const end = new Date(e.endISO);
      if (end <= now) return json({ error: "Cannot notify for past on-call entries" }, 400);
    }

    // -------------------------------
    // Cron time-window enforcement
    // -------------------------------
    // Enforce ONLY for cron calls (admin manual clicks are allowed anytime).
    if (isCron && CFG.cron.enforceWindow) {
      const day = dayOfWeekInTz(now, tz); // 0=Sun ... 5=Fri ... 1=Mon
      const hm = hhmmInTz(now, tz);

      const isFriday = day === 5;
      const isMonday = day === 1;

      // If cronHint is provided, use it as the intended run kind.
      // Otherwise, infer based on day.
      const intended =
        cronHint === "FRIDAY"
          ? "FRIDAY"
          : cronHint === "MONDAY"
            ? "MONDAY"
            : isFriday
              ? "FRIDAY"
              : isMonday
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
          action:
            intended === "FRIDAY"
              ? "AUTO_NOTIFY_FRIDAY_BLOCKED_WINDOW"
              : intended === "MONDAY"
                ? "AUTO_NOTIFY_MONDAY_BLOCKED_WINDOW"
                : "AUTO_NOTIFY_BLOCKED_WINDOW",
          actor: "system",
          dryRun,
          cronHint: intended,
          tz,
          nowISO: now.toISOString(),
          hm,
          details: {
            fridayWindow: CFG.cron.fridayWindow,
            mondayWindow: CFG.cron.mondayWindow
          }
        });

        return json(
          {
            ok: false,
            error: "Cron execution outside allowed window",
            intended,
            now: now.toISOString(),
            hm,
            tz
          },
          403
        );
      }
    }

    // -------------------------------
    // Build admins list
    // -------------------------------
    const admins = (env.ADMIN_NOTIFICATION || "")
      .split(",")
      .map(e => e.trim())
      .filter(Boolean);

    const portal = env.PUBLIC_PORTAL_URL || "";
    let emailsSent = 0;
    let smsMessagesSent = 0;

    // Track skip reasons for diagnostics
    const skipped = [];

    // -------------------------------
    // Process each target entry
    // -------------------------------
    for (const entry of targets) {
      // -------------------------------
      // Compute notifyType (UPCOMING vs START_TODAY)
      // -------------------------------
      const start = new Date(entry.startISO);
      const end = new Date(entry.endISO);

      const startLabel = formatCst(start, tz);
      const endLabel = formatCst(end, tz);

      const weekStart = start.toLocaleDateString("en-US", {
        timeZone: tz,
        month: "2-digit",
        day: "2-digit",
        year: "numeric"
      });

      const hoursUntilStart = (start.getTime() - now.getTime()) / (1000 * 60 * 60);
      const isUpcoming = start > now && hoursUntilStart >= CFG.upcoming.minHoursBeforeStart;

      // If cron explicitly indicates MONDAY, force UPCOMING behavior.
      // If cron explicitly indicates FRIDAY, force START_TODAY behavior.
      let notifyType = isUpcoming ? "UPCOMING" : "START_TODAY";
      if (isCron && cronHint === "MONDAY") notifyType = "UPCOMING";
      if (isCron && cronHint === "FRIDAY") notifyType = "START_TODAY";

      // -------------------------------
      // Per-entry dedupe (without touching ONCALL:CURRENT)
      // -------------------------------
      // We dedupe per: entryId + channel + notifyType
      const entryKey = entry.id || `${entry.startISO}::${entry.endISO}`;

      const dedupeEmailKey = notifyStateKey(CFG, entryKey, "email", notifyType);
      const dedupeSmsKey = notifyStateKey(CFG, entryKey, "sms", notifyType);

      const priorEmail = await env.ONCALL_KV.get(dedupeEmailKey);
      const priorSms = await env.ONCALL_KV.get(dedupeSmsKey);

      // If both channels are being sent, check both.
      // If only one channel, only check that channel’s state.
      if (sendEmail && priorEmail) {
        skipped.push({ entryId: entryKey, channel: "email", notifyType, reason: "dedupe" });
      }
      if (allowSMS && priorSms) {
        skipped.push({ entryId: entryKey, channel: "sms", notifyType, reason: "dedupe" });
      }

      // If both are blocked by dedupe, skip entry entirely.
      const emailAllowedByDedupe = !sendEmail || !priorEmail;
      const smsAllowedByDedupe = !allowSMS || !priorSms;
      if (!emailAllowedByDedupe && !smsAllowedByDedupe) continue;

      // -------------------------------
      // Build recipient list + team lines
      // -------------------------------
      const recipients = []; // { dep, person }
      const teamLines = [];

      if (entry.departments && typeof entry.departments === "object") {
        for (const [team, person] of Object.entries(entry.departments)) {
          if (!person) continue;

          const label = DEPT_LABELS[team] || team;
          const pEmail = (person.email || "").trim();
          const pPhone = (person.phone || "").trim();

          teamLines.push(`
            <li>
              <strong>${escapeHtml(label)}</strong>: ${escapeHtml(person.name || "")}
              <br/>Email: ${escapeHtml(pEmail || "—")}
              <br/>Phone: ${escapeHtml(pPhone || "—")}
            </li>
          `);

          recipients.push({ dep: team, person });
        }
      } else if (entry.email) {
        recipients.push({
          dep: entry.department || "oncall",
          person: {
            name: entry.name || "On-Call",
            email: entry.email,
            phone: entry.phone || ""
          }
        });
      }

      // Must have at least one recipient to do anything
      if (!recipients.length) {
        skipped.push({ entryId: entryKey, reason: "no_recipients" });
        continue;
      }

      // -------------------------------
      // Per-engineer notification windows
      // -------------------------------
      // We filter who is allowed to receive notifications right now.
      // People can override their windows via:
      //   person.notifyWindowStart / person.notifyWindowEnd
      //   person.windowStart / person.windowEnd
      //
      // Example person object:
      //   { name, email, phone, notifyWindowStart:"08:00", notifyWindowEnd:"18:00" }
      //
      const hmNow = hhmmInTz(now, tz);

      const emailTo = [];
      const smsPeople = [];

      for (const r of recipients) {
        const p = r.person || {};
        const pEmail = (p.email || "").trim();
        const pPhone = (p.phone || "").trim();

        const { start: winStart, end: winEnd } = getPersonWindow(p, CFG.personWindow);

        const inWindow = inHhmmWindow(hmNow, winStart, winEnd);

        if (sendEmail && pEmail) {
          if (inWindow) {
            emailTo.push({ email: pEmail, name: p.name || r.dep });
          } else {
            skipped.push({
              entryId: entryKey,
              channel: "email",
              notifyType,
              person: pEmail,
              reason: `outside_window ${winStart}-${winEnd}`,
              hmNow
            });
          }
        }

        if (allowSMS && pPhone) {
          if (inWindow) {
            smsPeople.push({ phone: pPhone, name: p.name || r.dep, winStart, winEnd });
          } else {
            skipped.push({
              entryId: entryKey,
              channel: "sms",
              notifyType,
              person: pPhone,
              reason: `outside_window ${winStart}-${winEnd}`,
              hmNow
            });
          }
        }
      }

      // If nothing remains after window filtering, skip entry.
      const willSendEmail = emailAllowedByDedupe && sendEmail && emailTo.length > 0;
      const willSendSms = smsAllowedByDedupe && allowSMS && smsPeople.length > 0;

      if (!willSendEmail && !willSendSms) {
        skipped.push({ entryId: entryKey, reason: "all_recipients_outside_windows_or_dedupe" });
        continue;
      }

      // -------------------------------
      // Build message
      // -------------------------------
      const subject =
        notifyType === "UPCOMING"
          ? `REMINDER: ONCALL FOR WEEK STARTING ${weekStart}`
          : `ONCALL STARTS TODAY – ${weekStart}`;

      const html =
        notifyType === "UPCOMING"
          ? `
<table width="100%" cellpadding="0" cellspacing="0" style="font-family: Arial, sans-serif; background:#f4f6f8; padding:24px;">
  <tr><td>
    <img src="${BRAND.logo}" alt="US Signal" style="max-width:180px;margin-bottom:16px;" />
    <h2 style="color:${BRAND.primary};">On-Call Reminder</h2>
    <p>This is an <strong>REMINDER</strong> message. You are scheduled to provide on-call support during the upcoming week.</p>
    <p><strong>On-call support begins:</strong><br/>${escapeHtml(startLabel)}</p>
    <p><strong>On-call support ends:</strong><br/>${escapeHtml(endLabel)}</p>
    <p>If you need to make changes, please contact your Team Lead or Manager.</p>
    <hr style="border:none;border-top:1px solid ${BRAND.accent};margin:24px 0;" />
    <ul>${teamLines.join("")}</ul>
    <p>View the full on-call schedule:<br/><a href="${portal}">${escapeHtml(portal)}</a></p>
    <p style="margin-top:32px;font-size:12px;color:#6b7280;text-align:center;">${BRAND.footer}</p>
  </td></tr>
</table>
`
          : `
<table width="100%" cellpadding="0" cellspacing="0" style="font-family: Arial, sans-serif; background:#fff7ed; padding:24px;">
  <tr><td>
    <img src="${BRAND.logo}" alt="US Signal" style="max-width:180px;margin-bottom:16px;" />
    <h2 style="color:${BRAND.primary};">On-Call Starts Today</h2>
    <p>This is a notification that your <strong>on-call duty begins today</strong>.</p>
    <p><strong>Start:</strong><br/>${escapeHtml(startLabel)}</p>
    <p><strong>End:</strong><br/>${escapeHtml(endLabel)}</p>
    <hr style="border:none;border-top:1px solid ${BRAND.accent};margin:24px 0;" />
    <ul>${teamLines.join("")}</ul>
    <p>Access the on-call portal:<br/><a href="${portal}">${escapeHtml(portal)}</a></p>
    <p style="margin-top:32px;font-size:12px;color:#6b7280;text-align:center;">${BRAND.footer}</p>
  </td></tr>
</table>
`;

      // -------------------------------
      // SEND EMAIL (bulk) — window-filtered
      // -------------------------------
      if (willSendEmail) {
        if (dryRun) {
          console.log("[DRY-RUN] Email suppressed", {
            entryId: entryKey,
            notifyType,
            subject,
            to: emailTo
          });
        } else {
          await sendBrevoEmail(env, {
            to: emailTo,
            cc: admins,
            subject,
            html
          });
          emailsSent += emailTo.length;

          // write dedupe state
          await env.ONCALL_KV.put(
            dedupeEmailKey,
            JSON.stringify({ sentAt: new Date().toISOString(), subject, to: emailTo }),
            { expirationTtl: 60 * 60 * 24 * 45 } // 45 days
          );
        }
      }

      // -------------------------------
      // SEND SMS (per person) — window-filtered
      // NOTE: By default, we only send SMS on START_TODAY (your prior behavior).
      // If you want UPCOMING SMS too, remove the notifyType check below.
      // -------------------------------
      if (willSendSms && notifyType === "START_TODAY") {
        if (dryRun) {
          console.log("[DRY-RUN] SMS suppressed", {
            entryId: entryKey,
            notifyType,
            people: smsPeople
          });
        } else {
          for (const sp of smsPeople) {
            const sms = await sendBrevoSms(env, smsApiKey, {
              to: sp.phone,
              message: `US Signal On-Call: Your on-call duty starts now and ends ${endLabel}.`
            });
            smsMessagesSent += sms.ok ? 1 : 0;

            // You can optionally keep sms status in a separate KV if you want.
            // This file keeps it simple and only dedupes by KV state.
            if (!sms.ok) {
              skipped.push({
                entryId: entryKey,
                channel: "sms",
                person: sp.phone,
                reason: "sms_failed",
                detail: sms.error || sms.status
              });
            }
          }

          // write dedupe state (for the whole entry + sms + type)
          await env.ONCALL_KV.put(
            dedupeSmsKey,
            JSON.stringify({
              sentAt: new Date().toISOString(),
              count: smsPeople.length
            }),
            { expirationTtl: 60 * 60 * 24 * 45 } // 45 days
          );
        }
      }
    }

    // -------------------------------
    // Audit (cron-specific actions + dry-run)
    // -------------------------------
    const auditAction = isCron
      ? cronHint === "FRIDAY"
        ? "AUTO_NOTIFY_FRIDAY"
        : cronHint === "MONDAY"
          ? "AUTO_NOTIFY_MONDAY"
          : "AUTO_NOTIFY_UNKNOWN"
      : entryId
        ? "MANUAL_NOTIFY_ENTRY"
        : "MANUAL_NOTIFY_ACTIVE";

    await audit(env, CFG, {
      action: auditAction,
      actor: isCron ? "system" : "admin",
      mode,
      entryId,
      dryRun,
      cronHint,
      tz,
      nowISO: now.toISOString(),
      emailsSent,
      smsMessagesSent,
      skipped
    });

    return json({
      ok: true,
      dryRun,
      cronHint,
      tz,
      now: now.toISOString(),
      emailsSent,
      smsMessagesSent,
      skippedCount: skipped.length,
      skipped
    });
  } catch (err) {
    console.error("NOTIFY ERROR:", err);
    return json({ error: "Notify failed", detail: err.message }, 500);
  }
}

/* =================================================
 * Brevo Email
 * ================================================= */

async function sendBrevoEmail(env, { to, cc, subject, html }) {
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "api-key": env.BREVO_API_KEY
    },
    body: JSON.stringify({
      sender: { email: env.BREVO_SENDER_EMAIL, name: env.BREVO_SENDER_NAME },
      to,
      cc: Array.isArray(cc) && cc.length ? cc.map(email => ({ email })) : undefined,
      subject,
      htmlContent: html
    })
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("BREVO EMAIL RESPONSE:", res.status, text);
    throw new Error(`Brevo email error (${res.status}): ${text}`);
  }
}

/* =================================================
 * Brevo SMS
 * ================================================= */

async function sendBrevoSms(env, smsApiKey, { to, message }) {
  try {
    const res = await fetch("https://api.brevo.com/v3/transactionalSMS/send", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "api-key": smsApiKey
      },
      body: JSON.stringify({
        from: env.SMS_SENDER_ID || "USSignal OnCall",
        to,
        message
      })
    });

    const text = await res.text();
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }

    if (!res.ok) {
      console.error("BREVO SMS FAILED", res.status, data || text);
      return { ok: false, status: res.status, error: data?.message || text };
    }

    return { ok: true, messageId: data.messageId || null };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

/* =================================================
 * Audit (Pages-safe KV log)
 * ================================================= */

async function audit(env, CFG, record) {
  const raw = (await env.ONCALL_KV.get(CFG.kv.auditKey)) || "[]";
  const auditLog = safeJson(raw, []);

  auditLog.unshift({
    ts: new Date().toISOString(),
    actor: record.actor || "admin",
    ...record
  });

  await env.ONCALL_KV.put(CFG.kv.auditKey, JSON.stringify(auditLog.slice(0, 500)));
}

/* =================================================
 * Helpers
 * ================================================= */

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}

function safeJson(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" }[c])
  );
}

function tzNow(tz) {
  // Creates a Date representing "now" but aligned with the given timezone clock.
  // Good enough for comparisons and hh:mm windows.
  return new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
}

function hhmmInTz(d, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(d);

  const hh = parts.find(p => p.type === "hour")?.value || "00";
  const mm = parts.find(p => p.type === "minute")?.value || "00";
  return `${hh}:${mm}`;
}

function dayOfWeekInTz(d, tz) {
  // 0=Sun..6=Sat
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short"
  }).formatToParts(d);
  const wd = parts.find(p => p.type === "weekday")?.value || "Sun";
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[wd] ?? 0;
}

function inHhmmWindow(hm, startHm, endHm) {
  // Assumes same-day window, non-wrapping. (07:00–19:00)
  // If you ever want wrapping windows (e.g., 22:00–06:00), we can add that.
  const t = toMinutes(hm);
  const s = toMinutes(startHm);
  const e = toMinutes(endHm);
  return t >= s && t <= e;
}

function toMinutes(hm) {
  const m = String(hm).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

function getPersonWindow(person, fallbackWindow) {
  const start =
    (person.notifyWindowStart || person.windowStart || "").trim() || fallbackWindow.start;
  const end =
    (person.notifyWindowEnd || person.windowEnd || "").trim() || fallbackWindow.end;
  return { start, end };
}

function formatCst(d, tz) {
  return (
    d.toLocaleString("en-US", {
      timeZone: tz,
      weekday: "long",
      month: "2-digit",
      day: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true
    }) + " CST"
  );
}

function notifyStateKey(CFG, entryId, channel, notifyType) {
  return `${CFG.kv.notifyStatePrefix}${String(entryId)}:${channel}:${notifyType}`;
}

//functions/api/internal/oncall/notify.js

import { runOncallNotify } from "../../../_lib/oncallNotify";

/**
 * POST /api/internal/oncall/notify
 * Cron-safe internal endpoint
 * Protected by x-cron-secret ONLY
 */

export async function onRequestPost({ request, env }) {
  /* -------- AUTH -------- */
  const secret = env.CRON_SHARED_SECRET;
  if (!secret) {
    return json({ ok: false, error: "cron_secret_not_set" }, 500);
  }

  if (request.headers.get("x-cron-secret") !== secret) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const body = await request.json().catch(() => ({}));

  try {
    const result = await runOncallNotify({
      env,
      cronHint: body.cronHint,
      mode: body.mode,
      auto: true
    });

    return json({
      ok: true,
      triggeredBy: "cron",
      ...result
    });
  } catch (err) {
    console.error("[internal-notify]", err);
    return json({ ok: false, error: err.message }, 500);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" }
  });
}

export const onRequestGet = onRequestPost; // optional for testing

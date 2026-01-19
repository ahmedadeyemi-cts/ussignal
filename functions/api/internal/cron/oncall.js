/**
 * POST /api/internal/oncall/notify
 *
 * Internal notify endpoint for cron
 * (NOT behind Cloudflare Access)
 */

export async function onRequestPost(ctx) {
  return handleNotify(ctx);
}

/* Optional GET for testing */
export async function onRequestGet(ctx) {
  return handleNotify(ctx);
}

/* ======================================================
 * EXISTING LOGIC MOVED HERE (NO CHANGES)
 * ====================================================== */
async function handleNotify(ctx) {
  const { request, env } = ctx;

  try {
    /* ---------- AUTH ---------- */
    const secret = env.CRON_SHARED_SECRET;
    if (!secret) {
      return json({ ok: false, error: "cron_secret_not_set" }, 500);
    }

    const hdr = request.headers.get("x-cron-secret");
    if (hdr !== secret) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    /* ---------- PAYLOAD ---------- */
    let payload = {};
    try {
      payload = await request.json();
    } catch {}

    const {
      entryId,
      cronHint,
      mode = "email",
      auto = true,
      dryRun = false
    } = payload;

    if (!entryId) {
      return json({ ok: false, error: "missing_entryId" }, 400);
    }

    /* ---------- DELEGATE TO EXISTING NOTIFY ---------- */
    const res = await fetch(
      `${env.PUBLIC_PORTAL_URL}/api/admin/oncall/notify`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cron-secret": secret
        },
        body: JSON.stringify({
          entryId,
          cronHint,
          mode,
          auto,
          dryRun
        })
      }
    );

    const text = await res.text();

    if (!res.ok) {
      return json({
        ok: false,
        error: "notify_failed",
        status: res.status,
        response: text
      }, 500);
    }

    return json({
      ok: true,
      forwarded: true,
      entryId,
      cronHint,
      mode,
      notifyResponse: JSON.parse(text)
    });

  } catch (err) {
    console.error("[internal-notify] fatal", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

/* ---------- RESPONSE ---------- */
function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}

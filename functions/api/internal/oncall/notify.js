/**
 * POST /api/internal/oncall/notify
 *
 * Internal notification trigger
 * - Used by cron
 * - Protected by x-cron-secret
 * - NOT blocked by Cloudflare Access
 */

export async function onRequestPost({ request, env }) {
  try {
    const secret = env.CRON_SHARED_SECRET;
    if (!secret) {
      return json({ ok: false, error: "cron_secret_not_set" }, 500);
    }

    const hdr = request.headers.get("x-cron-secret");
    if (hdr !== secret) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    if (!env.PUBLIC_PORTAL_URL) {
      return json({
        ok: false,
        error: "missing_PUBLIC_PORTAL_URL"
      }, 500);
    }

    let payload = {};
    try {
      payload = await request.json();
    } catch {}

    const { cronHint = "MONDAY", mode = "email", dryRun = true } = payload;

    const targetUrl = `${env.PUBLIC_PORTAL_URL}/api/admin/oncall/notify`;

    let res;
    try {
      res = await fetch(targetUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cron-secret": secret
        },
        body: JSON.stringify({
          cronHint,
          mode,
          auto: true,
          dryRun
        })
      });
    } catch (fetchErr) {
      return json({
        ok: false,
        error: "fetch_failed",
        details: String(fetchErr)
      }, 500);
    }

    const rawText = await res.text();

    return json({
      ok: res.ok,
      status: res.status,
      called: targetUrl,
      responseType: res.headers.get("content-type"),
      rawResponse: rawText.slice(0, 500)
    });

  } catch (err) {
    return json({
      ok: false,
      error: "fatal_exception",
      details: String(err)
    }, 500);
  }
}

export const onRequestGet = onRequestPost;

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}

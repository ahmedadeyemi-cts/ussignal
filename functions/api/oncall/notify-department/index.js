/**
 * POST /api/oncall/notify-department
 * URL-driven, IVR-safe notification endpoint
 */

export async function onRequest({ request, env }) {
  try {
    const url = new URL(request.url);

    const department = url.searchParams.get("department")?.trim();
    const pin = url.searchParams.get("pin")?.trim();
    const customerPhone = url.searchParams.get("customerPhone")?.trim();
    const customerName = url.searchParams.get("customerName")?.trim();
    const email = url.searchParams.get("email")?.trim();

    if (!department || !pin || !customerPhone || !customerName || !email) {
      return json(
        { ok: false, error: "missing_parameters" },
        400
      );
    }

    /* -----------------------------
     * Send Notification Email
     * ----------------------------- */
    await sendBrevoEmail(env, {
      to: [{ email, name: "On-Call Engineer" }],
      subject: `OneAssist Support Call – ${department}`,
      html: `
        <p>
          You received a support call from
          <b>${customerName}</b> for <b>OneAssist Support</b>.
        </p>

        <p><b>Department:</b> ${department}</p>
        <p><b>Customer PIN:</b> ${pin}</p>
        <p><b>Customer Phone:</b> ${customerPhone}</p>

        <p>
          Please ensure you reach out to the customer if you missed the call.
        </p>
      `
    });

    return json({ ok: true });

  } catch (err) {
    console.error("[NOTIFY-DEPARTMENT ERROR]", err);
    return json({ ok: false, error: "internal_error" }, 500);
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

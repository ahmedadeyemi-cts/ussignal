/**
 * POST /api/oncall/notify-department
 *
 * Public IVR-safe endpoint.
 * Automatically notifies the on-call engineer
 * for the selected department.
 */

export async function onRequest({ request, env }) {
  try {
    const url = new URL(request.url);

    const department =
      url.searchParams.get("department")?.trim().toLowerCase();
    const pin =
      url.searchParams.get("pin")?.trim();
    const customerPhone =
      url.searchParams.get("customerPhone")?.trim();
    const customerName =
      url.searchParams.get("customerName")?.trim();

    if (!department || !pin || !customerPhone || !customerName) {
      return json({ ok: false, error: "missing_parameters" }, 400);
    }

    /* --------------------------------
     * Load current on-call record
     * -------------------------------- */
    const raw = await env.ONCALL_KV.get("ONCALL:CURRENT");
    if (!raw) {
      return json({ ok: false, error: "oncall_not_found" }, 500);
    }

    const current = JSON.parse(raw);
    const engineer = current?.departments?.[department];

    if (!engineer || !engineer.email) {
      return json({ ok: false, error: "engineer_not_found" }, 404);
    }

    /* --------------------------------
     * Send email to on-call engineer
     * -------------------------------- */
    await sendBrevoEmail(env, {
      to: [{ email: engineer.email, name: engineer.name }],
      subject: `OneAssist Support Call – ${department.replace("_", " ")}`,
      html: `
        <p>
          You are receiving this email because
          <b>${customerName}</b> called the OneAssist support number.
        </p>

        <p><b>Department:</b> ${department}</p>
        <p><b>Customer PIN:</b> ${pin}</p>
        <p><b>Customer Phone:</b> ${customerPhone}</p>

        <p>
          Please ensure you reach out to the customer
          if you missed the call.
        </p>
      `
    });

    return json({
      ok: true,
      notified: {
        name: engineer.name,
        email: engineer.email,
        department
      }
    });

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

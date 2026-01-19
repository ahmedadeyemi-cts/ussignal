/**
 * POST /api/oncall/notify-department
 *
 * Public IVR-triggered endpoint.
 * Notifies the on-call engineer for a selected department.
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

    if (!department || !pin || !customerPhone) {
      return json({ ok: false, error: "missing_parameters" }, 400);
    }

    /* -------------------------------
     * Validate PIN
     * ------------------------------- */
    const rawCustomers = await env.ONCALL_KV.get("ONCALL:PS_CUSTOMERS");
    if (!rawCustomers) {
      return json({ ok: false, error: "customers_not_found" }, 500);
    }

    const customers = JSON.parse(rawCustomers).customers || [];
    const customer = customers.find(c => String(c.pin) === String(pin));

    if (!customer) {
      return json({ ok: false, error: "invalid_pin" }, 404);
    }

    /* -------------------------------
     * Resolve On-Call Engineer
     * ------------------------------- */
    const rawCurrent = await env.ONCALL_KV.get("ONCALL:CURRENT");
    if (!rawCurrent) {
      return json({ ok: false, error: "oncall_not_found" }, 500);
    }

    const current = JSON.parse(rawCurrent);
    const engineer = current?.departments?.[department];

    if (!engineer || !engineer.email) {
      return json({ ok: false, error: "engineer_not_found" }, 404);
    }

    /* -------------------------------
     * Send Email
     * ------------------------------- */
    await sendBrevoEmail(env, {
      to: [{ email: engineer.email, name: engineer.name }],
      subject: `On-Call Alert – ${department.replace("_", " ").toUpperCase()}`,
      html: `
        <p>
          You are receiving this email because customer
          <b>${customer.name}</b> called the One Assist support number
          and selected the <b>${department}</b> department.
        </p>

        <p><b>Customer PIN:</b> ${customer.pin}</p>
        <p><b>Customer Phone:</b> ${customerPhone}</p>

        <p>Please contact the customer as soon as possible.</p>
      `
    });

    return json({ ok: true });

  } catch (err) {
    console.error("[NOTIFY-DEPARTMENT ERROR]", err);
    return json({ ok: false }, 500);
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

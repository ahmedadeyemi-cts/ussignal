/**
 * GET /api/customers?pin=72568
 *
 * Public, unauthenticated PIN validation endpoint.
 * Designed for IVR / automation use.
 *
 * Response:
 * {
 *   match: boolean,
 *   customer?: { id, name, pin }
 * }
 */

export async function onRequest({ request, env }) {
  try {
    const url = new URL(request.url);
    const pin = url.searchParams.get("pin");

    // ---------------------------------------------
    // Basic validation (anti-abuse, IVR-safe)
    // ---------------------------------------------
    if (!pin || !/^\d{4,8}$/.test(pin)) {
      return json({ match: false });
    }

    // ---------------------------------------------
    // Load customer source
    // (reuse same backend as ps-customers)
    // ---------------------------------------------
    const raw = await env.ONCALL_KV.get("PS:CUSTOMERS");
    if (!raw) {
      return json({ match: false });
    }

    let customers;
    try {
      customers = JSON.parse(raw)?.customers || [];
    } catch {
      return json({ match: false });
    }

    // ---------------------------------------------
    // Direct PIN lookup
    // ---------------------------------------------
    const customer = customers.find(
      c => String(c.pin) === String(pin)
    );

    if (!customer) {
      return json({ match: false });
    }

    // ---------------------------------------------
    // Minimal, safe response
    // ---------------------------------------------
    return json({
      match: true,
      customer: {
        id: customer.id || null,
        name: customer.name || "Unknown",
        pin: String(customer.pin)
      }
    });

  } catch (err) {
    console.error("[customers] lookup failed", err);
    return json({ match: false });
  }
}

/* ---------------------------------------------
 * Helpers
 * --------------------------------------------- */

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}

export const onRequestGet = onRequest;

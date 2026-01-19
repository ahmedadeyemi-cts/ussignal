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

    if (!pin) {
      return json({ match: false });
    }

    // ✅ CORRECT KV KEY
    const raw = await env.ONCALL_KV.get("ONCALL:PS_CUSTOMERS");
    if (!raw) {
      console.warn("[PIN] PS customer KV not found");
      return json({ match: false });
    }

    const data = JSON.parse(raw);
    const customers = Array.isArray(data.customers)
      ? data.customers
      : [];

    // ✅ STRING-SAFE MATCH
    const customer = customers.find(c =>
      String(c.pin) === String(pin)
    );

    if (!customer) {
      return json({ match: false });
    }

    return json({
      match: true,
      customer: {
        id: customer.id,
        name: customer.name,
        pin: customer.pin
      }
    });

  } catch (err) {
    console.error("[PIN VALIDATION ERROR]", err);
    return json({ match: false });
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

export const onRequestGet = onRequest;

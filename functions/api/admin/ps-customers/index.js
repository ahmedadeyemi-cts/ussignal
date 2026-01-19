export async function onRequest(ctx) {
  const { request, env } = ctx;

  if (!env.ONCALL_KV) {
    return json({ error: "KV not bound" }, 500);
  }

  const KV_KEY = "ONCALL:PS_CUSTOMERS";

  /* ============================
     GET — Load PS Customers
  ============================ */
  if (request.method === "GET") {
    const raw = await env.ONCALL_KV.get(KV_KEY);

    if (!raw) {
      return json({ customers: [] });
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return json({ customers: [] });
    }

    // 🔒 Normalize legacy / unexpected shapes
    let customers = [];

    if (Array.isArray(data)) {
      customers = data;
    } else if (data && Array.isArray(data.customers)) {
      customers = data.customers;
    } else if (data && typeof data === "object") {
      customers = Object.values(data);
    }

    return json({ customers });
  }

  /* ============================
     POST — Save PS Customers
  ============================ */
  if (request.method === "POST") {
    const body = await request.json();

    if (!Array.isArray(body.customers)) {
      return json({ error: "Invalid payload" }, 400);
    }

    // ✅ Validate PINs + uniqueness
    const seenPins = new Set();

    for (const c of body.customers) {
      if (!c.name || !c.pin) {
        return json({ error: "Missing name or PIN" }, 400);
      }

      if (!/^\d{5}$/.test(c.pin)) {
        return json({ error: `Invalid PIN for ${c.name}` }, 400);
      }

      if (seenPins.has(c.pin)) {
        return json({ error: `Duplicate PIN detected: ${c.pin}` }, 400);
      }

      seenPins.add(c.pin);
    }

    const payload = {
      customers: body.customers,
      updatedAt: new Date().toISOString(),
      updatedBy: "admin"
    };

    await env.ONCALL_KV.put(
      KV_KEY,
      JSON.stringify(payload)
    );

    return json({ ok: true });
  }

  return json({ error: "Method not allowed" }, 405);
}

/* ============================
   Helper
============================ */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}

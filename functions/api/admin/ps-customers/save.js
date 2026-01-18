export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();

    // Basic validation
    if (!Array.isArray(body.customers)) {
      return json({ error: "Invalid payload" }, 400);
    }

    // Validate PIN rules
    const seenPins = new Set();
    for (const c of body.customers) {
      if (!c.name || !c.pin) {
        return json({ error: "Customer name and PIN required" }, 400);
      }

      if (!/^\d{5}$/.test(c.pin)) {
        return json({ error: `Invalid PIN: ${c.pin}` }, 400);
      }

      if (seenPins.has(c.pin)) {
        return json({ error: `Duplicate PIN detected: ${c.pin}` }, 400);
      }

      seenPins.add(c.pin);
    }

    // Persist to KV
    await env.ONCALL_KV.put(
      "ONCALL:PS_CUSTOMERS",
      JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        updatedBy: request.headers.get("CF-Access-Authenticated-User-Email") || "admin",
        customers: body.customers
      })
    );

    return json({ ok: true });

  } catch (err) {
    console.error("PS CUSTOMERS SAVE ERROR", err);
    return json({ error: err.message }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}

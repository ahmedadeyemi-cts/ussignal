export async function onRequest(ctx) {
  const { request, env } = ctx;

  if (!env.ONCALL_KV) {
    return json({ error: "KV not bound" }, 500);
  }

  if (request.method === "GET") {
    const raw = await env.ONCALL_KV.get("PS:CUSTOMERS");
    return json(raw ? JSON.parse(raw) : { customers: [] });
  }

  if (request.method === "POST") {
    const body = await request.json();

    if (!Array.isArray(body.customers)) {
      return json({ error: "Invalid payload" }, 400);
    }

    // Validate PINs
    for (const c of body.customers) {
      if (!/^\d{5}$/.test(c.pin)) {
        return json({ error: `Invalid PIN for ${c.name}` }, 400);
      }
    }

    const payload = {
      customers: body.customers,
      updatedAt: new Date().toISOString(),
      updatedBy: "admin"
    };

    await env.ONCALL_KV.put(
      "PS:CUSTOMERS",
      JSON.stringify(payload)
    );

    return json({ ok: true });
  }

  return json({ error: "Method not allowed" }, 405);
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

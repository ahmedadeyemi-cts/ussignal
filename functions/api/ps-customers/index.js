export async function onRequest({ env }) {
  if (!env.ONCALL_KV) {
    return new Response(JSON.stringify({ customers: [] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }

  const raw =
    (await env.ONCALL_KV.get("PS:CUSTOMERS")) ||
    (await env.ONCALL_KV.get("ONCALL:PS_CUSTOMERS"));

  let data = { customers: [] };

  try {
    if (raw) data = JSON.parse(raw);
  } catch {}

  return new Response(JSON.stringify({
    customers: Array.isArray(data.customers) ? data.customers : []
  }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}

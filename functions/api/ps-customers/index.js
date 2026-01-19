export async function onRequest({ env }) {
  const raw = await env.ONCALL_KV.get("PS:CUSTOMERS");
  return new Response(
    raw || JSON.stringify({ customers: [] }),
    { headers: { "content-type": "application/json", "cache-control": "no-store" } }
  );
}

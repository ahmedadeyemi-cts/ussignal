export async function onRequest({ env }) {
  const raw = await env.ONCALL_KV.get("ONCALL:CURRENT");

  if (!raw) {
    return json({ entries: [] });
  }

  return json(JSON.parse(raw));
}

function json(data) {
  return new Response(JSON.stringify(data), {
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "cache-control": "no-store"
    }
  });
}

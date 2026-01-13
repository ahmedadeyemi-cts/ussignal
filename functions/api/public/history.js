export async function onRequest({ env }) {
  const raw = await env.ONCALL_KV.get("ONCALL:HISTORY");
  return new Response(raw || "[]", {
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*"
    }
  });
}

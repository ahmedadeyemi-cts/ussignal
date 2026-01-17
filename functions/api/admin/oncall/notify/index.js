export async function onRequestPost() {
  return new Response(
    JSON.stringify({ ok: true, message: "notify route hit" }),
    { headers: { "content-type": "application/json" } }
  );
}

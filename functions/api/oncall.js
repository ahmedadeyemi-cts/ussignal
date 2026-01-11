export async function onRequest() {
  return new Response(JSON.stringify({ entries: [] }), {
    headers: { "content-type": "application/json" }
  });
}

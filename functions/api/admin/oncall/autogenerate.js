export async function onRequestPost({ request, env }) {
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!jwt) return new Response("Unauthorized", { status: 401 });

  const body = await request.json();

  // Placeholder logic for now
  // Later you’ll generate real entries
  return new Response(
    JSON.stringify({ ok: true, generated: true }),
    { headers: { "content-type": "application/json" } }
  );
}

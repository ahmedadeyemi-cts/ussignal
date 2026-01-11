export async function onRequest({ request }) {
  const accessJWT = request.headers.get("cf-access-jwt-assertion");

  if (!accessJWT) {
    return new Response("Unauthorized", { status: 401 });
  }

  return new Response(JSON.stringify({ entries: [] }), {
    headers: { "content-type": "application/json" }
  });
}

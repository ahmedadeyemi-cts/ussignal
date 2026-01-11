// functions/api/admin/oncall.js
export async function onRequest({ request }) {
  const jwt = request.headers.get("cf-access-jwt-assertion");

  if (!jwt) {
    return new Response("Unauthorized", { status: 401 });
  }

  return new Response(JSON.stringify({ entries: [] }), {
    headers: { "content-type": "application/json" }
  });
}

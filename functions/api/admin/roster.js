export async function onRequest({ request }) {
  const jwt = request.headers.get("cf-access-jwt-assertion");

  if (!jwt) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" }
    });
  }

  // MUST return JSON
  return new Response(JSON.stringify({
    enterprise_network: [],
    collaboration: [],
    system_storage: []
  }), {
    headers: { "content-type": "application/json" }
  });
}

export async function onRequest({ request, params, env }) {
  const { request, params } = context;
  const path = params.path || "";
  const method = request.method;

  // Cloudflare Access JWT (present ONLY after login)
  const accessJWT = request.headers.get("cf-access-jwt-assertion");

  // ---- PUBLIC ENDPOINT ----
  if (path === "oncall" && method === "GET") {
    return json({
      entries: []
    });
  }

  // ---- ADMIN ENDPOINT ----
  if (path === "admin/oncall" && method === "GET") {
    if (!accessJWT) {
      return new Response("Unauthorized", { status: 401 });
    }

    return json({
      entries: []
    });
  }

  return new Response("Not found", { status: 404 });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

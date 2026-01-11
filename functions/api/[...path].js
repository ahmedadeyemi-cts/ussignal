export async function onRequest(context) {
  const { request, params, env } = context;

  const path = params.path || "";
  const method = request.method;

  // Optional: Access identity (for admin endpoints)
  const accessJWT = request.headers.get("cf-access-jwt-assertion");

  // Simple router
  if (path === "oncall" && method === "GET") {
    return json({
      entries: [] // TODO: load from KV / Durable Object
    });
  }

  if (path === "admin/oncall" && method === "GET") {
    if (!accessJWT) {
      return new Response("Unauthorized", { status: 401 });
    }

    return json({
      entries: [] // admin schedule
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

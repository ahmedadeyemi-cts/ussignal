export async function onRequest({ request, params }) {
  const target = new URL(
    `https://api.onenecklab.com/${params.path || ""}`
  );

  return fetch(target.toString(), {
    method: request.method,
    headers: request.headers,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : request.body,
    redirect: "manual"
  });
}

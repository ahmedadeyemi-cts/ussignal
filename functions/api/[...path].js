export async function onRequest({ request, params }) {
  const url = new URL(request.url);

  // Join path segments safely
  const path = Array.isArray(params.path)
    ? params.path.join("/")
    : "";

  const targetUrl = `https://api.onenecklab.com/${path}${url.search}`;

  return fetch(targetUrl, {
    method: request.method,
    headers: request.headers,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : request.body,
    redirect: "manual"
  });
}

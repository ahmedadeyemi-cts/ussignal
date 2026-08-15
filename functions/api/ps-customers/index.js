export async function onRequest() {
  return new Response(JSON.stringify({
    error: "authentication_required",
    message: "OneAssist PINs are available only after signing in to Pulse."
  }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

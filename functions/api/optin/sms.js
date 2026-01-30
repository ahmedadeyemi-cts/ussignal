export async function onRequest(context) {
  const { request, env } = context;

  // Gracefully handle GET (optional but recommended)
  if (request.method === "GET") {
    return Response.redirect("https://oncall.onenecklab.com", 302);
  }

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const form = await request.formData();

  const phone = form.get("phone");
  const optedIn = form.get("sms_optin");

  if (!phone || !optedIn) {
    return new Response("Missing consent", { status: 400 });
  }

  // Normalize phone (important for KV consistency)
  const normalizedPhone = phone.replace(/[^\d+]/g, "");

  const record = {
    phone: normalizedPhone,
    consented: true,
    consentedAt: new Date().toISOString(),
    ip: request.headers.get("CF-Connecting-IP"),
    userAgent: request.headers.get("User-Agent"),
    source: "oncall-sms-optin",
    disclosureVersion: "v1"
  };

  // 🔐 Save into your EXISTING KV
  await env.ONCALL_KV.put(
    `sms-optin:${normalizedPhone}`,
    JSON.stringify(record)
  );

  // Optional: mirror into user profile if it exists
  // await env.ONCALL_KV.put(`user:${normalizedPhone}:sms`, "true");

  // Redirect back to main app
  return Response.redirect("https://oncall.onenecklab.com", 302);
}

/**
 * POST /api/oncall/notify-department
 *
 * Public, unauthenticated IVR-safe endpoint.
 * Automatically emails the on-call engineer for a department.
 *
 * Query params:
 *  - department (collaboration | system_storage | enterprise_network)
 *  - pin
 *  - customerPhone
 *  - customerName
 */

export async function onRequest({ request, env }) {
  try {
    const url = new URL(request.url);

    // -----------------------------
    // Parse + normalize parameters
    // -----------------------------
    const department = url.searchParams
      .get("department")
      ?.trim()
      .toLowerCase();

    const pin = url.searchParams.get("pin")?.trim();
    const customerPhone = url.searchParams.get("customerPhone")?.trim();
    const customerName = url.searchParams.get("customerName")?.trim();

    if (!department || !pin || !customerPhone || !customerName) {
      return json(
        { ok: false, error: "missing_parameters" },
        400
      );
    }

    // -----------------------------
    // Load ONCALL:CURRENT
    // -----------------------------
    const raw = await env.ONCALL_KV.get("ONCALL:CURRENT");
    if (!raw) {
      return json(
        { ok: false, error: "oncall_not_found" },
        500
      );
    }

    let current;
    try {
      current = JSON.parse(raw);
    } catch {
      return json(
        { ok: false, error: "oncall_parse_error" },
        500
      );
    }

    const engineer = current?.departments?.[department];

    if (!engineer || !engineer.email) {
      return json(
        { ok: false, error: "engineer_not_found" },
        404
      );
    }

    // -----------------------------
    // Validate Brevo env
    // -----------------------------
    if (
      !env.BREVO_API_KEY ||
      !env.BREVO_SENDER_EMAIL ||
      !env.BREVO_SENDER_NAME
    ) {
      return json(
        { ok: false, error: "email_not_configured" },
        500
      );
    }

    // -----------------------------
    // Send email (minimal Brevo-safe)
    // -----------------------------
    const res = await fetch(
      "https://api.brevo.com/v3/smtp/email",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "api-key": env.BREVO_API_KEY
        },
        body: JSON.stringify({
          sender: {
            email: env.BREVO_SENDER_EMAIL,
            name: env.BREVO_SENDER_NAME
          },
          to: [
            {
              email: engineer.email,
              name: engineer.name || "On-Call Engineer"
            }
          ],
          subject: "OneAssist Support Call",
          htmlContent: `
            <p>
              You are receiving this email because
              <b>${customerName}</b> called the OneAssist support number.
            </p>

            <p><b>Department:</b> ${department}</p>
            <p><b>Customer PIN:</b> ${pin}</p>
            <p><b>Customer Phone:</b> ${customerPhone}</p>

            <p>
              Please ensure you reach out to the customer
              if you missed the call.
            </p>
          `
        })
      }
    );

    const body = await res.text();
    if (!res.ok) {
      throw new Error(`Brevo failed ${res.status}: ${body}`);
    }

    // -----------------------------
    // Success
    // -----------------------------
    return json({
      ok: true,
      notified: {
        department,
        name: engineer.name,
        email: engineer.email
      }
    });

  } catch (err) {
    console.error("[NOTIFY-DEPARTMENT ERROR]", err);
    return json(
      {
        ok: false,
        error: "internal_error",
        detail: err.message
      },
      500
    );
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}

export const onRequestPost = onRequest;

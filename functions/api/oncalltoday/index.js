/**
 * GET /api/oncalltoday?department=collaboration
 *
 * Public IVR-safe endpoint
 * Returns current on-call engineer for a department
 */

export async function onRequest({ request, env }) {
  try {
    const url = new URL(request.url);
    const dept = url.searchParams.get("department");

    if (!dept) {
      return json({ match: false });
    }

    // Pull authoritative current on-call record
    const raw = await env.ONCALL_KV.get("ONCALL:CURRENT");
    if (!raw) {
      console.warn("[ONCALLTODAY] ONCALL:CURRENT not found");
      return json({ match: false });
    }

    const current = JSON.parse(raw);
    const departments = current.departments || {};

    const engineer = departments[dept];
    if (!engineer) {
      return json({ match: false });
    }

    return json({
      match: true,
      department: dept,
      engineer: {
        name: engineer.name,
        email: engineer.email,
        phone: engineer.phone
      },
      oncall: {
        startISO: current.startISO,
        endISO: current.endISO
      }
    });

  } catch (err) {
    console.error("[ONCALLTODAY ERROR]", err);
    return json({ match: false });
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

export const onRequestGet = onRequest;

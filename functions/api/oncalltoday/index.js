/**
 * GET /api/oncalltoday?department=collaboration
 *
 * Public IVR-safe endpoint
 * Returns current on-call engineer for a department
 */

export async function onRequest({ request, env }) {
  try {
    const url = new URL(request.url);
    const dept =
      url.searchParams.get("department")?.trim().toLowerCase();

    if (!dept) {
      return json({ match: false });
    }

    const raw = await env.ONCALL_KV.get("ONCALL:CURRENT");
    if (!raw) {
      console.warn("[ONCALLTODAY] ONCALL:CURRENT missing");
      return json({ match: false });
    }

    const current = JSON.parse(raw);
    const engineer = current?.departments?.[dept];

    if (!engineer || !engineer.phone) {
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

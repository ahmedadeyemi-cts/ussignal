/**
 * GET /api/oncalltoday?department=collaboration
 *
 * Public endpoint to retrieve current on-call engineer
 * by department (enterprise_network | collaboration | system_storage)
 */

export async function onRequest({ request, env }) {
  try {
    if (!env.ONCALL_KV) {
      console.error("[oncalltoday] ONCALL_KV binding missing");
      return json({ ok: false, error: "kv_not_bound" }, 500);
    }

    const url = new URL(request.url);
    const department = url.searchParams.get("department");

    if (!department) {
      return json({ ok: false, error: "missing_department" }, 400);
    }

    const raw = await env.ONCALL_KV.get("ONCALL:CURRENT");
    if (!raw) {
      return json({ ok: false, error: "oncall_not_available" }, 404);
    }

    let current;
    try {
      current = JSON.parse(raw);
    } catch {
      return json({ ok: false, error: "invalid_kv_payload" }, 500);
    }

    const dept = current.departments?.[department];
    if (!dept) {
      return json({
        ok: false,
        error: "department_not_oncall",
        department
      }, 404);
    }

    return json({
      ok: true,
      department,
      oncall: {
        name: dept.name,
        email: dept.email,
        phone: dept.phone
      }
    });

  } catch (err) {
    console.error("[oncalltoday] fatal", err);
    return json({ ok: false, error: "internal_error" }, 500);
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

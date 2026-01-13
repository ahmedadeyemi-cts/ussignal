export async function onRequest({ request, env }) {
  try {
    auth(request);

    const rows = await request.json();
    const roster = {};

    for (const r of rows) {
      if (!r.team || !r.email || !r.phone) continue;

      const phone = r.phone.trim();
      if (!phone.startsWith("+")) {
        throw new Error(`Invalid phone format: ${phone}`);
      }

      roster[r.team] ||= [];
      roster[r.team].push({
        name: r.name || "",
        email: r.email.trim(),
        phone
      });
    }

    await env.ONCALL_KV.put("roster", JSON.stringify(roster));

    await audit(env, {
      action: "ROSTER_BULK_UPLOAD",
      totalUsers: Object.values(roster).flat().length
    });

    return json({ ok: true });

  } catch (e) {
    return json({ error: e.message }, 400);
  }
}

/* helpers */
function auth(req) {
  if (!req.headers.get("cf-access-jwt-assertion")) {
    throw new Error("Unauthorized");
  }
}

async function audit(env, data) {
  const raw = (await env.ONCALL_KV.get("ONCALL:AUDIT")) || "[]";
  const log = JSON.parse(raw);
  log.unshift({ ts: new Date().toISOString(), ...data });
  await env.ONCALL_KV.put("ONCALL:AUDIT", JSON.stringify(log.slice(0, 500)));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" }
  });
}

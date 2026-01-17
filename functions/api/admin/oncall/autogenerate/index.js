export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();

    const {
      startYMD,
      endYMD,
      seedIndex = 0
    } = body || {};

    if (!startYMD || !endYMD) {
      return json({ error: "startYMD and endYMD are required" }, 400);
    }

    /* =============================
     * Load roster
     * ============================= */
    const rosterRaw = await env.ONCALL_KV.get("ROSTER");
    if (!rosterRaw) {
      return json({ error: "Roster not found" }, 404);
    }

    const roster = JSON.parse(rosterRaw);

    /* =============================
     * Rotation state per department
     * ============================= */
    const rotationIndex = {};
    for (const dept of Object.keys(roster)) {
      rotationIndex[dept] = Number(seedIndex) || 0;
    }

    /* =============================
     * Build weekly entries
     * ============================= */
    const entries = [];
    let cursor = nextFriday(toDate(startYMD));
    const endLimit = toDate(endYMD);
    let entryId = 1;

    while (cursor <= endLimit) {
      const start = new Date(cursor);
      const end = endFriday(start);

      const departments = {};

      for (const [dept, users] of Object.entries(roster)) {
        if (!Array.isArray(users) || !users.length) continue;

        const idx = rotationIndex[dept] % users.length;
        const user = users[idx];

        departments[dept] = {
          name: user.name || "",
          email: user.email || "",
          phone: user.phone || ""
        };

        rotationIndex[dept]++; // advance per department
      }

      entries.push({
        id: crypto.randomUUID(),
        startISO: toISO(start),
        endISO: toISO(end),
        departments
      });

      cursor = addDays(cursor, 7);
    }

    /* =============================
     * Persist schedule
     * ============================= */
    const schedule = {
      version: 1,
      tz: "America/Chicago",
      updatedAt: new Date().toISOString(),
      updatedBy: "autogenerate",
      entries
    };

    await env.ONCALL_KV.put(
      "ONCALL:SCHEDULE",
      JSON.stringify(schedule)
    );

    /* =============================
     * Audit
     * ============================= */
    await env.ONCALL_KV.put(
      `AUDIT:${crypto.randomUUID()}`,
      JSON.stringify({
        ts: new Date().toISOString(),
        action: "AUTO_GENERATE",
        actor: "system",
        startYMD,
        endYMD,
        seedIndex,
        count: entries.length
      })
    );

    return json({
      ok: true,
      entriesGenerated: entries.length
    });

  } catch (err) {
    console.error("AUTOGENERATE ERROR:", err);
    return json({ error: err.message }, 500);
  }
}

/* =============================
 * Helpers
 * ============================= */

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function toDate(ymd) {
  return new Date(`${ymd}T00:00:00`);
}

function addDays(d, days) {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function nextFriday(d) {
  const copy = new Date(d);
  const diff = (5 - copy.getDay() + 7) % 7;
  copy.setDate(copy.getDate() + diff);
  copy.setHours(16, 0, 0, 0); // Fri 4:00 PM CST
  return copy;
}

function endFriday(start) {
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  end.setHours(7, 0, 0, 0); // Fri 7:00 AM CST
  return end;
}

function toISO(d) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

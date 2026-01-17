export async function onRequest({ env }) {
  const raw = (await env.ONCALL_KV.get("ONCALL:AUDIT")) || "[]";
  const audit = JSON.parse(raw);

  const cron = audit.filter(a =>
    String(a.actor).includes("system") ||
    String(a.action).startsWith("AUTO_")
  );

  const lastRuns = cron.slice(0, 10);

  return new Response(
    JSON.stringify({
      ok: true,
      lastRun: lastRuns[0]?.ts || null,
      runs: lastRuns.map(r => ({
        ts: r.ts,
        action: r.action,
        mode: r.mode,
        emailsSent: r.emailsSent || 0
      }))
    }),
    {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store"
      }
    }
  );
}

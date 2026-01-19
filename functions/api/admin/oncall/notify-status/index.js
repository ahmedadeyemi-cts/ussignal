export async function onRequest({ env }) {
  const PREFIX = "ONCALL:NOTIFY_STATE:";
  const status = {};

  let cursor = undefined;

  while (true) {
    const page = await env.ONCALL_KV.list({ prefix: PREFIX, cursor });
    const keys = page.keys || [];

    for (const k of keys) {
      // key format:
      // ONCALL:NOTIFY_STATE:<entryId>:<channel>:<type>
      const parts = String(k.name || "").split(":");
      const entryId = parts[2];
      const channel = parts[3]; // "email" | "sms"
      const type = parts[4];    // "UPCOMING" | "START_TODAY" (etc)

      if (!entryId || !channel) continue;
      if (channel !== "email" && channel !== "sms") continue;

      // Read the stored metadata so UI can display force/auto/etc.
      let meta = null;
      try {
        const raw = await env.ONCALL_KV.get(k.name);
        if (raw) meta = JSON.parse(raw);
      } catch {
        meta = null;
      }

      // Normalize shape: per-entry, per-channel
      status[entryId] ||= { email: null, sms: null };

      // Keep “latest” if multiple types exist (choose newest ts)
      const existing = status[entryId][channel];
      const existingTs = existing?.sentAt || existing?.ts || null;
      const incomingTs = meta?.sentAt || meta?.ts || null;

     const existingTime = Number.isFinite(Date.parse(existingTs))
  ? Date.parse(existingTs)
  : -1;

const incomingTime = Number.isFinite(Date.parse(incomingTs))
  ? Date.parse(incomingTs)
  : -1;


      if (!existing || incomingTime >= existingTime) {
        status[entryId][channel] = {
          sentAt: meta?.sentAt || meta?.ts || null,
          notifyType: meta?.notifyType || type || null,
          force: meta?.force === true,
          auto: meta?.auto === true,
          messageId: meta?.messageId || null
        };
      }
    }

    cursor = page.cursor;
    //if (!page.list_complete) break;
    if (page.list_complete) break;
  }

  return new Response(JSON.stringify(status), {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}

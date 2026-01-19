export async function onRequest({ env }) {
  const PREFIX = "ONCALL:NOTIFY_STATE:";
  const list = await env.ONCALL_KV.list({ prefix: PREFIX });

  const status = {};

  for (const key of list.keys) {
    // key format:
    // ONCALL:NOTIFY_STATE:<entryId>:<channel>:<type>
    const [, , entryId, channel] = key.name.split(":");

    status[entryId] ||= {
      email: null,
      sms: null
    };

    const raw = await env.ONCALL_KV.get(key.name);
    let meta = {};

    if (raw) {
      try {
        meta = JSON.parse(raw);
      } catch {}
    }

    status[entryId][channel] = {
      sentAt: meta.ts || null,
      force: meta.force === true,
      auto: meta.auto === true
    };
  }

  return new Response(JSON.stringify(status), {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}

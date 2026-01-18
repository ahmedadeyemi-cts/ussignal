export async function onRequest({ env }) {
  const PREFIX = "ONCALL:NOTIFY_STATE:";
  const list = await env.ONCALL_KV.list({ prefix: PREFIX });

  const status = {};

  for (const key of list.keys) {
    // key format:
    // ONCALL:NOTIFY_STATE:<entryId>:<channel>:<type>
    const [, , entryId, channel, type] = key.name.split(":");

    status[entryId] ||= { email: false, sms: false };
    status[entryId][channel] = true;
  }

  return new Response(JSON.stringify(status), {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}

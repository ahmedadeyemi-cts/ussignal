from pathlib import Path
import re

ROOT = Path.cwd()
PAY_FORM = "https://forms.cloud.microsoft/Pages/ResponsePage.aspx?id=2kFZU3Lai0qDeJg6VL7DQtvfUo2dqAlEkjfnG3izqQFUQ0NXTlQ5TEtERzE0RzNHN0tNMjJNWThWRSQlQCN0PWcu"
PUBLIC_SCHEDULE = "https://oncall.onenecklab.com/"


def read(path):
    return (ROOT / path).read_text(encoding="utf-8")


def write(path, content):
    (ROOT / path).write_text(content, encoding="utf-8")


def replace_once(path, old, new):
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected 1 match, found {count}: {old[:90]!r}")
    write(path, text.replace(old, new, 1))


def regex_once(path, pattern, replacement):
    text = read(path)
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f"{path}: expected 1 regex match, found {count}: {pattern[:90]!r}")
    write(path, updated)


# Public page: exact form label/link and no unauthenticated OneAssist tab.
replace_once(
    "index.html",
    '''href="https://forms.microsoft.com/Pages/ResponsePage.aspx?id=2kFZU3Lai0qDeJg6VL7DQmcodVUCw2tHgn0S1PzMbxpUQ0NXTlQ5TEtERzE0RzNHN0tNMjJNWThWRS4u"
target="_blank">
💼 On-Call Pay Request
''',
    f'''href="{PAY_FORM}"
target="_blank" rel="noopener noreferrer">
💼 OnCall Pay Form
'''
)
replace_once(
    "index.html",
    '<button class="tab" data-tab="psCustomersTab">OneAssist Customers</button>\n',
    ''
)
regex_once(
    "index.html",
    r'\n<section id="psCustomersTab" class="panel">.*?</section>\n',
    '\n'
)
replace_once(
    "index.html",
    '<script type="module" src="public.js?v=20260315"></script>',
    '<script type="module" src="public.js?v=20260815"></script>'
)

# Public JavaScript must never request or render OneAssist PIN data.
replace_once(
    "public.js",
    '''  oncall: "/api/oncall",
  current: "/api/oncall/current",
  ack: "/api/ack-status",
  psCustomers: "/api/ps-customers"
''',
    '''  oncall: "/api/oncall",
  current: "/api/oncall/current",
  ack: "/api/ack-status"
'''
)
replace_once("public.js", '  ackMap: {},\n  psCustomers: [],\n  loading: true\n', '  ackMap: {},\n  loading: true\n')
replace_once(
    "public.js",
    '''  await Promise.allSettled([
    loadSchedule(),
    loadCurrent(),
    loadPsCustomers()
  ]);
''',
    '''  await Promise.allSettled([
    loadSchedule(),
    loadCurrent()
  ]);
'''
)
replace_once("public.js", '  renderSchedule();   // <-- ADD THIS\n  renderPsCustomers();\n', '  renderSchedule();\n')
regex_once(
    "public.js",
    r'/\* =========================\n \* OneAssist\n \* ========================= \*/\nasync function loadPsCustomers\(\) \{.*?\n\}\n\n',
    ''
)
replace_once("public.js", '  safeRun("renderSchedule", () => renderSchedule());\n\n  safeRun("renderPsCustomers", () => renderPsCustomers());\n', '  safeRun("renderSchedule", () => renderSchedule());\n')
regex_once(
    "public.js",
    r'\nfunction renderPsCustomers\(\) \{.*?\n\}\n/\* =========================\n \* Filtering / Sorting',
    '\n/* =========================\n * Filtering / Sorting'
)

# The legacy public endpoint now fails closed with no PIN payload.
write(
    "functions/api/ps-customers/index.js",
    '''export async function onRequest() {
  return new Response(JSON.stringify({
    error: "authentication_required",
    message: "OneAssist PINs are available only after signing in to Pulse."
  }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff"
    }
  });
}
'''
)

# Reminder channels always include the stable no-auth schedule URL.
notify = "functions/api/admin/oncall/notify/index.js"
replace_once(
    notify,
    '''    /* =================================================
     * PARSE REQUEST
     * ================================================= */
''',
    f'''    const publicPortalUrl = String(env.PUBLIC_PORTAL_URL || "{PUBLIC_SCHEDULE}").trim();

    /* =================================================
     * PARSE REQUEST
     * ================================================= */
'''
)
text = read(notify)
count = text.count("env.PUBLIC_PORTAL_URL")
if count != 3:
    raise RuntimeError(f"{notify}: expected 3 PUBLIC_PORTAL_URL call-site matches, found {count}")
write(notify, text.replace("env.PUBLIC_PORTAL_URL", "publicPortalUrl"))
replace_once(
    notify,
    '''          message: `US Signal On-Call: Your on-call duty starts now and ends ${formatCstFromIso(
            entry.endISO,
            tz
          )}.`
''',
    '''          message: `US Signal On-Call: Your on-call duty starts now and ends ${formatCstFromIso(
            entry.endISO,
            tz
          )}. View schedule: ${publicPortalUrl}`
'''
)
replace_once(
    notify,
    '        await sendTeamsWebhook(env.TEAMS_WEBHOOK_URL, entry, notifyType);\n',
    '        await sendTeamsWebhook(env.TEAMS_WEBHOOK_URL, entry, notifyType, publicPortalUrl);\n'
)
replace_once(
    notify,
    '''async function sendTeamsWebhook(url, entry, type) {
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "On-Call Notification",
      text: `${type}: ${entry.startISO} → ${entry.endISO}`
    })
  });
}
''',
    '''async function sendTeamsWebhook(url, entry, type, publicPortalUrl) {
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "On-Call Notification",
      text: `${type}: ${entry.startISO} → ${entry.endISO}. View schedule: ${publicPortalUrl}`
    })
  });
}
'''
)

write(
    "PUBLIC-ACCESS-CONTRACT.md",
    f'''# Public On-Call Access Contract

- Direct no-auth schedule: `{PUBLIC_SCHEDULE}`
- Pay action label: **OnCall Pay Form**
- Pay form: `{PAY_FORM}`
- Public schedule content: on-call assignments only
- OneAssist customer names and PINs: excluded from the page, JavaScript, and public API
- OneAssist authenticated source: Pulse Module 072
- Reminder email, SMS, and Teams messages use the stable public schedule URL

This companion change is source-only and is linked to Pulse PR #698. It does not deploy the site.
'''
)

print("PUBLIC_ONCALL_ACCESS_PATCH=PASS")

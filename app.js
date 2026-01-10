// app.js
const API_BASE = "/api";

const DEPT_LABELS = {
  enterprise_network: "Enterprise Network",
  collaboration: "Collaboration",
  system_storage: "System & Storage"
};

const DEPT_KEYS = Object.keys(DEPT_LABELS);

// IMPORTANT:
// Worker stores times like "YYYY-MM-DDTHH:mm:ss" intended as America/Denver.
// You asked to DISPLAY in CST, and to label it CST.
// We will convert Denver-local wall time -> UTC epoch -> render in a fixed UTC-6 zone (Etc/GMT+6) to force CST year-round.

const SOURCE_TZ = "America/Denver";
const DISPLAY_TZ_FIXED_CST = "Etc/GMT+6"; // fixed UTC-6 (CST)

let APP_STATE = {
  admin: false,
  dept: "all",
  scheduleFull: null,   // full schedule (admin)
  schedulePublic: null, // public view
  draftSchedule: null,  // admin editable schedule
  editingEntryIds: new Set()
};

function initApp({ admin }) {
  APP_STATE.admin = !!admin;

  const filter = document.getElementById("deptFilter");
  const scheduleDiv = document.getElementById("schedule");
  const themeBtn = document.getElementById("themeToggle");

  themeBtn.onclick = toggleTheme;

  if (filter) {
    filter.onchange = () => {
      APP_STATE.dept = filter.value;
      if (APP_STATE.admin) renderScheduleAdmin(scheduleDiv);
      else loadSchedulePublic(scheduleDiv);
    };
  }

  // Tabs (admin only)
  if (APP_STATE.admin) wireTabs();

  // Admin buttons
  if (APP_STATE.admin) {
    byId("exportBtn").onclick = exportExcelAdmin;
    byId("notifyBtn").onclick = () => confirmModal(
      "Send Notifications",
      "Send notifications (start and end) to on-call engineers and admins now?",
      sendNotify
    );
    byId("revertBtn").onclick = () => confirmModal(
      "Revert Schedule",
      "Revert to the previously saved schedule? This will overwrite the current schedule.",
      revertSchedule
    );
    byId("saveAllBtn").onclick = () => confirmModal(
      "Save Schedule",
      "Save all pending edits? This will overwrite the current schedule.",
      saveAllChanges
    );

    // Roster UI
    byId("rosterAddUserBtn").onclick = () => rosterAddUserPrompt();
    byId("rosterSaveBtn").onclick = () => confirmModal(
      "Save Roster",
      "Save roster changes? This impacts auto-generation rotation.",
      saveRoster
    );
    byId("rosterReloadBtn").onclick = loadRoster;

    // Autogen UI
    byId("runAutogenBtn").onclick = () => confirmModal(
      "Auto-Generate Schedule",
      "Auto-generate will overwrite the current schedule. You can revert after. Proceed?",
      runAutogen
    );

    // Audit UI
    byId("auditRefreshBtn").onclick = loadAudit;

    // Modal close wiring
    wireModal();

    // Initial load admin data + roster + audit panel is lazy
    loadScheduleAdmin(scheduleDiv);
    loadRoster();
  } else {
    loadSchedulePublic(scheduleDiv);
  }
}

/* =========================
 * Helpers
 * ========================= */

function byId(id) {
  return document.getElementById(id);
}

function toast(msg, ms = 2200) {
  const el = byId("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), ms);
}

function toggleTheme() {
  document.body.classList.toggle("dark");
  document.body.classList.toggle("light");
}

function wireTabs() {
  const tabs = Array.from(document.querySelectorAll(".tab"));
  tabs.forEach(btn => {
    btn.onclick = () => {
      tabs.forEach(t => t.classList.remove("active"));
      btn.classList.add("active");

      const targetId = btn.getAttribute("data-tab");
      document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
      byId(targetId).classList.add("active");

      // Lazy loads
      if (targetId === "auditTab") loadAudit();
    };
  });
}

function wireModal() {
  const modal = byId("modal");
  const close = byId("modalClose");
  const cancel = byId("modalCancel");

  if (close) close.onclick = hideModal;
  if (cancel) cancel.onclick = hideModal;

  modal.addEventListener("click", (e) => {
    if (e.target === modal) hideModal();
  });
}

function confirmModal(title, body, onOk) {
  const modal = byId("modal");
  byId("modalTitle").textContent = title;
  byId("modalBody").innerHTML = `<div>${escapeHtml(body)}</div>`;
  byId("modalOk").onclick = async () => {
    hideModal();
    try {
      await onOk();
    } catch (e) {
      toast(`Error: ${e.message || e}`, 3500);
    }
  };
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
}

function hideModal() {
  const modal = byId("modal");
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"
  }[c]));
}

/* =========================
 * Time conversion:
 * - Interpret "YYYY-MM-DDTHH:mm:ss" as wall-clock in America/Denver
 * - Convert to UTC milliseconds
 * - Render in fixed CST (UTC-6) using "Etc/GMT+6"
 * ========================= */

function parseLocalIsoParts(localISO) {
  const m = String(localISO || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return {
    y: Number(m[1]),
    mo: Number(m[2]),
    d: Number(m[3]),
    h: Number(m[4]),
    mi: Number(m[5]),
    s: Number(m[6])
  };
}

function getTZParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false
  });
  const parts = fmt.formatToParts(date);
  const out = {};
  for (const p of parts) if (p.type !== "literal") out[p.type] = p.value;
  return {
    y: Number(out.year),
    mo: Number(out.month),
    d: Number(out.day),
    h: Number(out.hour),
    mi: Number(out.minute),
    s: Number(out.second)
  };
}

function diffMinutes(a, b) {
  // a and b are {y,mo,d,h,mi,s}; compute difference a - b in minutes (approx)
  const aUtc = Date.UTC(a.y, a.mo - 1, a.d, a.h, a.mi, a.s);
  const bUtc = Date.UTC(b.y, b.mo - 1, b.d, b.h, b.mi, b.s);
  return Math.round((aUtc - bUtc) / 60000);
}

function zonedWallTimeToUtcMs(localISO, timeZone) {
  const want = parseLocalIsoParts(localISO);
  if (!want) return null;

  // initial guess: treat wall time as UTC
  let guessMs = Date.UTC(want.y, want.mo - 1, want.d, want.h, want.mi, want.s);

  // Two-pass correction to handle DST edges
  for (let i = 0; i < 2; i++) {
    const got = getTZParts(new Date(guessMs), timeZone);
    const deltaMin = diffMinutes(want, got);
    guessMs = guessMs + deltaMin * 60000;
  }
  return guessMs;
}

function formatCSTFromDenverLocal(localISO) {
  const utcMs = zonedWallTimeToUtcMs(localISO, SOURCE_TZ);
  if (utcMs === null) return "";

  const d = new Date(utcMs);
  const s = d.toLocaleString("en-US", {
    timeZone: DISPLAY_TZ_FIXED_CST,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  });

  // You asked it should be displayed as CST
  return `${s} CST`;
}

// ADD — on-call window validation
function validateOnCallWindow(startISO, endISO) {
  const start = new Date(startISO);
  const end = new Date(endISO);

  if (isNaN(start) || isNaN(end)) return "Invalid date/time format.";
  if (start >= end) return "End must be after start.";

  // Friday = 5
  if (start.getDay() !== 5) return "Start must be on a Friday.";
  if (end.getDay() !== 5) return "End must be on a Friday.";

  if (start.getHours() !== 16 || start.getMinutes() !== 0)
    return "Start time must be 4:00 PM CST.";

  if (end.getHours() !== 7 || end.getMinutes() !== 0)
    return "End time must be 7:00 AM CST.";

  const diffDays = (end - start) / (1000 * 60 * 60 * 24);
  if (diffDays < 6.9 || diffDays > 7.1)
    return "On-call window must be exactly one week.";

  return null;
}
/* =========================
 * Public schedule
 * ========================= */

async function loadSchedulePublic(scheduleDiv) {
  const dept = (APP_STATE.dept || "all").toLowerCase();
  const res = await fetch(`${API_BASE}/oncall?department=${encodeURIComponent(dept)}`);
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  APP_STATE.schedulePublic = data;
  renderScheduleReadOnly(scheduleDiv, data.entries || []);
}

function renderScheduleReadOnly(scheduleDiv, entries) {
  scheduleDiv.innerHTML = "";

  entries.forEach(entry => {
    const card = document.createElement("div");
    card.className = "schedule-card";

    const startDisplay = formatCSTFromDenverLocal(entry.startISO);
    const endDisplay = formatCSTFromDenverLocal(entry.endISO);
    const startInput = entry.startISO?.slice(0,16);
    const endInput = entry.endISO?.slice(0,16);


    card.innerHTML = `
      <div class="card-head">
        <div>
          <div class="card-title">${escapeHtml(start)} → ${escapeHtml(end)}</div>
          <div class="small">Read-only · All departments</div>
        </div>
      </div>
      <div class="entry-grid">
        ${renderDeptBlocks(entry.departments || {}, false, entry.id)}
      </div>
    `;
    scheduleDiv.appendChild(card);
  });
}

function renderDeptBlocks(departments, editable, entryId) {
  const keys = Object.keys(departments || {});
  if (keys.length === 0) {
    return `<div class="entry"><h4>—</h4><div class="small">No assignment</div></div>`;
  }

  return keys.map(k => {
    const p = departments[k] || {};
    const label = DEPT_LABELS[k] || k;

    if (!editable) {
      return `
        <div class="entry">
          <h4>${escapeHtml(label)}</h4>
          <div class="kv">
            <div><b>${escapeHtml(p.name || "")}</b></div>
            <div>${escapeHtml(p.email || "")}</div>
            <div class="small">${escapeHtml(p.phone || "")}</div>
          </div>
        </div>
      `;
    }

    // inline inputs: name/email/phone
    return `
      <div class="entry">
        <h4>${escapeHtml(label)}</h4>
        <div class="kv">
          <div class="inline-row">
            <label>Name</label>
            <input data-entry="${escapeHtml(entryId)}" data-dept="${escapeHtml(k)}" data-field="name" value="${escapeHtml(p.name || "")}" />
          </div>
          <div class="inline-row">
            <label>Email</label>
            <input data-entry="${escapeHtml(entryId)}" data-dept="${escapeHtml(k)}" data-field="email" value="${escapeHtml(p.email || "")}" />
          </div>
          <div class="inline-row">
            <label>Phone</label>
            <input data-entry="${escapeHtml(entryId)}" data-dept="${escapeHtml(k)}" data-field="phone" value="${escapeHtml(p.phone || "")}" />
          </div>
        </div>
      </div>
    `;
  }).join("");
}

/* =========================
 * Admin schedule (editable)
 * ========================= */

async function loadScheduleAdmin(scheduleDiv) {
  const res = await fetch(`${API_BASE}/admin/oncall`);
  if (!res.ok) throw new Error(await res.text());
  const schedule = await res.json();

  APP_STATE.scheduleFull = schedule;
  APP_STATE.draftSchedule = deepClone(schedule);
  APP_STATE.editingEntryIds = new Set();

  renderScheduleAdmin(scheduleDiv);
}

function renderScheduleAdmin(scheduleDiv) {
  const deptFilter = (APP_STATE.dept || "all").toLowerCase();
  const schedule = APP_STATE.draftSchedule || { entries: [] };

  scheduleDiv.innerHTML = "";

  const entries = (schedule.entries || []).map(e => {
    if (deptFilter === "all") return e;

    // show entry but only include selected department in the display for clarity
    const only = e.departments?.[deptFilter];
    return {
      ...e,
      departments: only ? { [deptFilter]: only } : {}
    };
  });

  entries.forEach(entry => {
    const isEditing = APP_STATE.editingEntryIds.has(String(entry.id));
    const card = document.createElement("div");
    card.className = "schedule-card";

    const startDisplay = formatCSTFromDenverLocal(entry.startISO);
    const endDisplay = formatCSTFromDenverLocal(entry.endISO);
    const startInput = entry.startISO?.slice(0,16);
    const endInput = entry.endISO?.slice(0,16);


    card.innerHTML = `
      <div class="card-head">
        <div>
          <div class="card-title">${escapeHtml(start)} → ${escapeHtml(end)}</div>
          <div class="small">Entry ID: ${escapeHtml(String(entry.id))}</div>
        </div>
        <div class="card-actions">
          <button class="ghost" data-action="notifyEntry" data-id="${escapeHtml(String(entry.id))}">Notify This Week</button>
          ${isEditing
            ? `<button class="primary" data-action="doneEdit" data-id="${escapeHtml(String(entry.id))}">Done</button>`
            : `<button class="primary" data-action="edit" data-id="${escapeHtml(String(entry.id))}">Edit</button>`}
        </div>
      </div>

      <div class="entry-grid">
        ${renderDeptBlocks(entry.departments || {}, isEditing, entry.id)}
      </div>
    `;

    scheduleDiv.appendChild(card);
  });

  // wire card actions and inline input listeners
  scheduleDiv.querySelectorAll("button[data-action]").forEach(btn => {
    btn.onclick = async () => {
      const action = btn.getAttribute("data-action");
      const id = btn.getAttribute("data-id");

      if (action === "edit") {
        APP_STATE.editingEntryIds.add(String(id));
        renderScheduleAdmin(scheduleDiv);
        return;
      }

      if (action === "doneEdit") {
        APP_STATE.editingEntryIds.delete(String(id));
        renderScheduleAdmin(scheduleDiv);
        return;
      }

      if (action === "notifyEntry") {
        confirmModal(
          "Notify This Week",
          "Send start and end notifications for this schedule entry to on-call engineers and admins?",
          async () => {
            await fetch(`${API_BASE}/admin/oncall/notify`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ mode: "both", entryId: id })
            });
            toast("Notifications sent for entry.");
          }
        );
        return;
      }
    };
  });

  scheduleDiv.querySelectorAll("input[data-entry]").forEach(inp => {
    inp.oninput = () => {
      const entryId = inp.getAttribute("data-entry");
      const dept = inp.getAttribute("data-dept");
      const field = inp.getAttribute("data-field");
      const value = inp.value;

      // find the real entry in draftSchedule (not filtered copy)
      const real = (APP_STATE.draftSchedule.entries || []).find(e => String(e.id) === String(entryId));
      if (!real) return;

      if (!real.departments) real.departments = {};
      if (!real.departments[dept]) real.departments[dept] = {};
      real.departments[dept][field] = value;
    };
  });
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/* =========================
 * Admin actions
 * ========================= */

async function saveAllChanges() {
  const schedule = APP_STATE.draftSchedule;
  if (!schedule || !Array.isArray(schedule.entries)) throw new Error("Draft schedule is missing.");

  // optional: minimal validation
  for (const e of schedule.entries) {
    for (const k of Object.keys(e.departments || {})) {
      const p = e.departments[k] || {};
      if (p.email && !String(p.email).includes("@")) {
        throw new Error(`Invalid email in ${DEPT_LABELS[k]} for entry ${e.id}`);
      }
    }
  }

  const res = await fetch(`${API_BASE}/admin/oncall/save`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ schedule })
  });

  if (!res.ok) throw new Error(await res.text());
  toast("Schedule saved.");
  // reload schedule from server to ensure parity
  await loadScheduleAdmin(byId("schedule"));
}

async function exportExcelAdmin() {
  const dept = byId("deptFilter").value;
  window.location = `${API_BASE}/admin/oncall/export?department=${encodeURIComponent(dept)}`;
}

async function sendNotify() {
  const res = await fetch(`${API_BASE}/admin/oncall/notify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "both" })
  });
  if (!res.ok) throw new Error(await res.text());
  toast("Notifications sent.");
}

async function revertSchedule() {
  const res = await fetch(`${API_BASE}/admin/oncall/revert`, { method: "POST" });
  if (!res.ok) throw new Error(await res.text());
  toast("Reverted. Reloading...");
  await loadScheduleAdmin(byId("schedule"));
}

async function runAutogen() {
  const start = byId("autogenStart").value;
  const end = byId("autogenEnd").value;
  const seed = Number(byId("autogenSeed").value || 0);

  if (!start || !end) throw new Error("Start and end dates are required.");

  const res = await fetch(`${API_BASE}/admin/oncall/autogenerate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ startYMD: start, endYMD: end, seedIndex: seed })
  });

  if (!res.ok) throw new Error(await res.text());
  toast("Auto-generated schedule.");
  await loadScheduleAdmin(byId("schedule"));
}

/* =========================
 * Roster management UI
 * ========================= */

let ROSTER_STATE = null;

async function loadRoster() {
  const res = await fetch(`${API_BASE}/admin/roster`);
  if (!res.ok) throw new Error(await res.text());
  const roster = await res.json();
  ROSTER_STATE = roster;

  renderRoster();
}

function renderRoster() {
  const wrap = byId("roster");
  if (!wrap) return;

  wrap.innerHTML = `
    <div class="roster-wrap">
      ${DEPT_KEYS.map(k => renderRosterDept(k)).join("")}
    </div>
  `;

  // wire remove buttons and inline inputs
  wrap.querySelectorAll("button[data-roster-remove]").forEach(btn => {
    btn.onclick = () => {
      const dept = btn.getAttribute("data-dept");
      const idx = Number(btn.getAttribute("data-idx"));
      if (!confirm(`Remove this user from ${DEPT_LABELS[dept]} roster?`)) return;
      ROSTER_STATE[dept].splice(idx, 1);
      renderRoster();
    };
  });

  wrap.querySelectorAll("input[data-roster]").forEach(inp => {
    inp.oninput = () => {
      const dept = inp.getAttribute("data-dept");
      const idx = Number(inp.getAttribute("data-idx"));
      const field = inp.getAttribute("data-field");
      ROSTER_STATE[dept][idx][field] = inp.value;
    };
  });
}

function renderRosterDept(deptKey) {
  const label = DEPT_LABELS[deptKey];
  const list = (ROSTER_STATE && Array.isArray(ROSTER_STATE[deptKey])) ? ROSTER_STATE[deptKey] : [];

  return `
    <div class="roster-card">
      <h3>${escapeHtml(label)}</h3>
      <table class="roster-table">
        <thead>
          <tr>
            <th style="width:30%">Name</th>
            <th style="width:40%">Email</th>
            <th style="width:20%">Phone</th>
            <th style="width:10%"></th>
          </tr>
        </thead>
        <tbody>
          ${list.map((u, idx) => `
            <tr>
              <td>
                <input data-roster="1" data-dept="${escapeHtml(deptKey)}" data-idx="${idx}" data-field="name" value="${escapeHtml(u.name || "")}" />
              </td>
              <td>
                <input data-roster="1" data-dept="${escapeHtml(deptKey)}" data-idx="${idx}" data-field="email" value="${escapeHtml(u.email || "")}" />
              </td>
              <td>
                <input data-roster="1" data-dept="${escapeHtml(deptKey)}" data-idx="${idx}" data-field="phone" value="${escapeHtml(u.phone || "")}" />
              </td>
              <td>
                <button class="iconbtn" data-roster-remove="1" data-dept="${escapeHtml(deptKey)}" data-idx="${idx}" title="Remove">🗑</button>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      <div class="small subtle" style="margin-top:8px">
        Rotation uses this list order.
      </div>
    </div>
  `;
}

function rosterAddUserPrompt() {
  // lightweight prompt flow; you can replace with a nicer modal later
  const dept = prompt("Department key: enterprise_network, collaboration, or system_storage", "enterprise_network");
  const deptKey = String(dept || "").trim();
  if (!DEPT_KEYS.includes(deptKey)) {
    toast("Invalid department key.");
    return;
  }

  const name = prompt("Name:", "");
  const email = prompt("Email:", "");
  const phone = prompt("Phone (optional):", "");

  if (!ROSTER_STATE) ROSTER_STATE = { enterprise_network: [], collaboration: [], system_storage: [] };
  ROSTER_STATE[deptKey].push({ name: name || "", email: email || "", phone: phone || "" });

  renderRoster();
  toast("User added to roster (not saved yet).");
}

async function saveRoster() {
  if (!ROSTER_STATE) throw new Error("Roster is empty.");

  const res = await fetch(`${API_BASE}/admin/roster/save`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roster: ROSTER_STATE })
  });

  if (!res.ok) throw new Error(await res.text());
  toast("Roster saved.");
  await loadRoster();
}

/* =========================
 * Audit log viewer
 * ========================= */

async function loadAudit() {
  const el = byId("audit");
  if (!el) return;

  el.innerHTML = `<div class="subtle">Loading audit log…</div>`;

  const res = await fetch(`${API_BASE}/admin/audit`);
  if (!res.ok) {
    el.innerHTML = `<div class="subtle">Unable to load audit log.</div>`;
    return;
  }

  const data = await res.json();
  const items = data.entries || [];

  if (items.length === 0) {
    el.innerHTML = `<div class="subtle">No audit entries yet.</div>`;
    return;
  }

  el.innerHTML = items.map(a => {
    const ts = a.ts ? new Date(a.ts).toLocaleString("en-US") : "";
    return `
      <div class="audit-item">
        <div class="audit-top">
          <div><span class="badge">${escapeHtml(a.action || "")}</span></div>
          <div class="small">${escapeHtml(ts)}</div>
        </div>
        <div><b>${escapeHtml(a.actor || "")}</b></div>
        <div class="small">${escapeHtml(a.note || "")}</div>
      </div>
    `;
  }).join("");
}

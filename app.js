// ======================================================
// app.js — FULL, COMPREHENSIVE, PRODUCTION VERSION (RBAC + Timeline + ICS + Auto-Resolve)
// - Read-only public view (no auth)
// - Admin view (role-based permissions)
// - Inline editing (Fri-only snapping + fixed times)
// - Validation (Fri 4:00 PM → Fri 7:00 AM CST, 7 days)
// - Overlap detection + automatic conflict resolution (shift forward by 1 week)
// - Diff preview before save
// - Roster management (modal add user, inline edits, remove)
// - Auto-generate controls (calls worker endpoint)
// - Audit log viewer
// - Calendar timeline UI
// - ICS export (download .ics from worker endpoint)
//Adding Download and upload options update
// ======================================================

"use strict";
const THEME_KEY = "oncall-theme";
const ARCHIVE_STATE_KEY = "oncall-archive-open";

/* =========================
 * Global App State
 * ========================= */

let APP_STATE = {
  // identity / permissions
  isAuthenticated: false,
  admin: false,
  role: "viewer",
  email: "",
  allowedDepartments: [],

   // 🔴 ADD THIS
  publicMode: false,
    // notification state
  notifyStatus: {}, // entryId -> { sentAt, mode }


  // ui state
  dept: "all",
  scheduleFull: null,
  schedulePublic: null,
  draftSchedule: null,
  editingEntryIds: new Set(),

  // roster state
  roster: null,
  psCustomers: [],

  // timeline state
  timelineMode: "weeks"
};

// Cloudflare Worker Path (same-origin — required for Cloudflare Access cookie auth)
// SAME ORIGIN — required for Pages Functions + Access
const API_BASE = "";
let HAS_UNSAVED_CHANGES = false;

/* =========================
 * Departments
 * ========================= */

const DEPT_LABELS = {
  enterprise_network: "Enterprise Network",
  collaboration: "Collaboration",
  system_storage: "System & Storage"
};
const DEPT_KEYS = Object.keys(DEPT_LABELS);

/* =========================
 * Timezone Handling
 * =========================
 * Worker stores ISO wall time intended as America/Chicago.
 * UI displays in fixed CST (UTC-6) year-round and labels "CST".
 * NOTE: Using fixed UTC-6 means this does NOT become CDT in summer (per your requirement).
 */

const SOURCE_TZ = "America/Chicago";
const DISPLAY_TZ_FIXED_CST = "Etc/GMT+6";

/* =========================
 * SETTING HOLIDAYS
  ========================= */
const US_HOLIDAYS = {
  "01-01": "New Year’s Day",
  "07-04": "Independence Day",
  "11-11": "Veterans Day",
  "12-25": "Christmas Day"
};

// Dynamic holidays
function getDynamicUSHolidays(year) {
  return {
    [`${year}-01-3-Mon`]: "Martin Luther King Jr. Day",
    [`${year}-02-3-Mon`]: "Presidents’ Day",
    [`${year}-05-last-Mon`]: "Memorial Day",
    [`${year}-09-1-Mon`]: "Labor Day",
    [`${year}-11-4-Thu`]: "Thanksgiving"
  };
}

function getHolidayName(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");

  const fixed = US_HOLIDAYS[`${m}-${d}`];
  if (fixed) return fixed;

  const day = date.getDay();
  const week = Math.ceil(date.getDate() / 7);
  const isLast = date.getDate() + 7 > 31;

  const weekday = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][day];
  const dynKey = `${y}-${m}-${week}-${weekday}`;
  const lastKey = `${y}-${m}-last-${weekday}`;

  const dyn = getDynamicUSHolidays(y);
  return dyn[dynKey] || (isLast ? dyn[lastKey] : null);
}
/* =========================
 * End of Holiday Set above
 * ========================= */
 
/* =========================
 * Role-Based Access Control
 * =========================
 * Expect ctx from admin.html:
 *   { admin: true, role: "admin"|"editor"|"viewer", email: "...", departments: ["enterprise_network", ...] }
 */
//const isExplicitPublic = ctx?.publicMode === true || ctx?.public === true;
//const isExplicitAdmin  = ctx?.admin === true || ctx?.mode === "admin";

//APP_STATE.publicMode = isExplicitPublic || !isExplicitAdmin;

const ROLE_ORDER = ["viewer", "editor", "admin"];
function roleAtLeast(role, needed) {
  const a = ROLE_ORDER.indexOf(String(role || "viewer"));
  const b = ROLE_ORDER.indexOf(String(needed || "viewer"));
  return a >= b;
}
window.addEventListener("beforeunload", (e) => {
  if (!HAS_UNSAVED_CHANGES) return;
  e.preventDefault();
  e.returnValue = "";
});


/* =========================
 * Fetch helpers (same-origin + Access)
 * ========================= */

function apiUrl(path) {
  if (!path) return API_BASE;
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  if (!path.startsWith("/")) path = "/" + path;
  return `${API_BASE}${path}`;
}

// Use for protected endpoints that require Access cookie
async function fetchAuth(path, opts = {}) {
  const res = await fetch(apiUrl(path), {
    ...opts,
    credentials: "include"
  });
  return res;
}

async function loadCurrentOnCall() {
  try {
    const res = await fetchPublic("/api/oncall/current");
    if (!res.ok) return null;

    const data = await res.json();
    return data && data.startISO ? data : null;
  } catch {
    return null;
  }
}

// Use for public endpoints (no auth required)
async function fetchPublic(path, opts = {}) {
  const res = await fetch(apiUrl(path), { ...opts });
  return res;
}
function getAutoNotifyTime(entry) {
  if (!entry?.startISO) return null;

  const start = isoToDateLocalAssumed(entry.startISO);
  if (isNaN(start)) return null;

  // Notify 30 minutes before start
  start.setMinutes(start.getMinutes() - 30);
  return start;
}
async function openNotifyTimeline(entryId) {
  const res = await fetchAuth(`/api/admin/audit`, { method: "GET" });
  if (!res.ok) {
    toast("Unable to load notification timeline.");
    return;
  }

  const data = await res.json();
  const events = (data.entries || []).filter(e =>
    e.entryId === entryId &&
    String(e.action || "").includes("NOTIFY")
  );

  const body =
  events.length
    ? `<ul class="timeline-list">
        ${events.map(e => {
          const phones = (e.sms || []).map(s => s.phone).join(", ");
          const emails = e.emailsSent ? "Email sent" : "";


          return `
            <li>
              <b>${escapeHtml(e.action)}</b><br/>
              ${new Date(e.ts).toLocaleString("en-US")} ·
              ${escapeHtml(e.actor || "system")}<br/>

              ${emails
                ? `<div class="small">📧 ${escapeHtml(emails)}</div>`
                : ""}

              ${phones
                ? `<div class="small">📱 ${escapeHtml(phones)}</div>`
                : ""}
            </li>
          `;
        }).join("")}
      </ul>`
    : `<div class="subtle">No notifications sent for this entry.</div>`;


  showModal(
    "Notification Timeline",
    body,
    "Close",
    () => true,
    ""
  );
}

/* =========================
 * Init
 * ========================= */
async function initApp(ctx = {}) {

  // 🔐 Determine mode
  const isPublic =
    ctx.publicMode === true ||
    ctx.public === true ||
    (!ctx.admin && !ctx.email);

  APP_STATE.publicMode = isPublic;

  if (isPublic) {
    // 🔓 Public view
    APP_STATE.isAuthenticated = false;
    APP_STATE.admin = false;
    APP_STATE.role = "viewer";
    APP_STATE.email = "";
    APP_STATE.allowedDepartments = DEPT_KEYS.slice();
  } else {
    // 🔐 Admin view (Cloudflare Access)
    APP_STATE.isAuthenticated = true;
    APP_STATE.admin = ctx.role === "admin";
    APP_STATE.role = ctx.role || "viewer";
    APP_STATE.email = ctx.email || "";
    APP_STATE.allowedDepartments = Array.isArray(ctx.departments)
      ? ctx.departments
      : DEPT_KEYS.slice();
  }

  // continue with UI wiring...

   // =========================
  // Role Badge
  // =========================
  const badge = byId("roleBadge");
  if (badge) {
    badge.textContent = APP_STATE.role.toUpperCase();
    badge.className = `role-badge role-${APP_STATE.role}`;
  }

  // =========================
  // Theme Initialization
  // =========================
  const savedTheme = localStorage.getItem(THEME_KEY) || "light";
  applyTheme(savedTheme);

  const themeBtn = byId("themeToggle");
  if (themeBtn) {
    themeBtn.onclick = toggleTheme;
  }
  const filter = byId("deptFilter");
  if (filter) {
    filter.onchange = () => {
      APP_STATE.dept = filter.value || "all";
      reloadSchedule().catch(e => toast(e.message || String(e), 4000));
    };
  }

  wireTabs();
if (!APP_STATE.publicMode) {
  wireModal();
}


  // =========================
// Admin-only button wiring
// =========================
if (!APP_STATE.publicMode) {

  onClick("exportBtn", exportExcel);
  onClick("icsBtn", exportICS);

  onClick("notifyBtn", () => confirmModal(
    "Send Notifications",
    "Send start and end notifications now?",
    sendNotify
  ));

  onClick("revertBtn", () => confirmModal(
    "Revert Schedule",
    "Revert to last saved schedule?",
    revertSchedule
  ));

  onClick("saveAllBtn", saveAllChanges);
  onClick("addScheduleBtn", addScheduleEntryModal);

  onClick("rosterReloadBtn", loadRoster);
  onClick("rosterSaveBtn", () => confirmModal(
    "Save Roster",
    "Save roster changes? This impacts auto-generation rotation.",
    saveRoster
  ));

  onClick("runAutogenBtn", () => confirmModal(
    "Auto-Generate Schedule",
    "Auto-generate will overwrite the current schedule. Proceed?",
    runAutogen
  ));

  onClick("auditRefreshBtn", loadAudit);

  // Bulk upload / download (admin-only)
  wireRosterBulkUpload();
  wireScheduleBulkUpload();

  onClick("rosterDownloadBtn", downloadRosterCSV);
  onClick("scheduleDownloadBtn", downloadScheduleCSV);
}
    // ✅ PS Customers wiring
  onClick("psAddCustomerBtn", psAddCustomerModal);
  onClick("psSaveCustomersBtn", () => confirmModal(
    "Save PS Customers",
    "Save PS customer PIN changes?",
    savePsCustomers
  ));
  onClick("psReloadCustomersBtn", loadPsCustomers);


    // =========================
  // FINALIZE UI FIRST (SAFE)
  // =========================
  applyRBACToUI();

 // =========================
// LOAD DATA (ORDER MATTERS)
// =========================
const scheduleEl = byId("schedule");
if (!scheduleEl) {
  console.error("Schedule container (#schedule) not found");
} else {
  if (APP_STATE.publicMode) {
    await loadSchedulePublic(scheduleEl);
    startCurrentOnCallAutoRefresh();
  } else {
    // 🔑 LOAD PERSISTED NOTIFY STATE FIRST
    await loadNotifyStatus();

    // 🔑 THEN load & render schedule
    await loadScheduleAdmin(scheduleEl);
  }
}

if (byId("roster")) {
  try {
    await loadRoster();
    
  } catch (e) {
    console.error("Roster load failed:", e);
    toast("Unable to load roster.", 5000);
  }
}
} // ✅ END initApp
async function reloadSchedule() {
  const el = byId("schedule");
  if (!el) return;

  if (APP_STATE.publicMode) {
    await loadSchedulePublic(el);
    return;
  }

  if (APP_STATE.admin || roleAtLeast(APP_STATE.role, "editor")) {
    await loadScheduleAdmin(el);
  } else {
    await loadSchedulePublic(el);
  }
}

/* =========================
 * Disable Save button until dirty
 * ========================= */
function updateSaveState() {
  const btn = byId("saveAllBtn");
  if (!btn) return;
  btn.disabled = !HAS_UNSAVED_CHANGES;
}

/* =========================
 * DOM Helpers
 * ========================= */

function byId(id) {
  return document.getElementById(id);
}

function onClick(id, fn) {
  const el = byId(id);
  if (el) el.onclick = fn;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" }[c])
  );
}

function toast(msg, ms = 2500) {
  const el = byId("toast");
  if (!el) return;
  el.textContent = String(msg || "");
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), ms);
}

function applyTheme(theme) {
  document.body.classList.remove("light", "dark");
  document.body.classList.add(theme);
  localStorage.setItem(THEME_KEY, theme);
}

function toggleTheme() {
  const isDark = document.body.classList.contains("dark");
  applyTheme(isDark ? "light" : "dark");
}

function renderRosterSelect(entryId, dep, selectedEmail) {
  const users = APP_STATE.roster?.[dep] || [];

  return `
    <select
      data-entry="${escapeHtml(entryId)}"
      data-dept="${escapeHtml(dep)}"
      data-field="email"
      class="roster-select"
    >
      <option value="">— Select from roster —</option>
      ${users.map(u => `
        <option value="${escapeHtml(u.email)}"
          ${u.email === selectedEmail ? "selected" : ""}>
          ${escapeHtml(u.name)} (${escapeHtml(u.email)})
        </option>
      `).join("")}
    </select>
  `;
}
/* =========================
 * Modal Helpers
 * ========================= */

function wireModal() {
  const modal = byId("modal");
  if (!modal) return;

  const close = byId("modalClose");
  const cancel = byId("modalCancel");
  if (close) close.onclick = hideModal;
  if (cancel) cancel.onclick = hideModal;

  modal.addEventListener("mousedown", (e) => {
  if (e.target.id === "modal") hideModal();
});
}

function showModal(title, bodyHtml, okText = "OK", onOk = null, cancelText = "Cancel") {
  const modal = byId("modal");
  if (!modal) return;

  const titleEl = byId("modalTitle");
  const bodyEl = byId("modalBody");
  const okBtn = byId("modalOk");
  const cancelBtn = byId("modalCancel");
  const saveAddBtn = byId("modalSaveAddAnother");

if (saveAddBtn) {
  saveAddBtn.onclick = async () => {
    if (typeof onOk === "function") {
      try {
        const shouldClose = await onOk();
        if (shouldClose !== false) {
          // Reset modal body inputs instead of closing
          bodyEl?.querySelectorAll("input").forEach(i => i.value = "");
          bodyEl?.querySelector("select")?.focus();
        }
      } catch (e) {
        toast(e.message || String(e), 4500);
      }
    }
  };
}
  if (titleEl) titleEl.textContent = title || "";
  if (bodyEl) bodyEl.innerHTML = bodyHtml || "";
  if (okBtn) okBtn.textContent = okText || "OK";
  if (cancelBtn) cancelBtn.textContent = cancelText || "Cancel";

  if (okBtn) {
    okBtn.onclick = async () => {
      if (typeof onOk === "function") {
        try {
          const shouldClose = await onOk();
          if (shouldClose !== false) hideModal();
        } catch (e) {
          toast(e.message || String(e), 4500);
        }
      } else {
        hideModal();
      }
    };
  }

  modal.classList.remove("hidden");
  modal.classList.add("modal-open");
  modal.setAttribute("aria-hidden", "false");
  modal.focus();
}

function confirmModal(title, bodyText, onOk) {
  showModal(
    title,
    `<div>${escapeHtml(bodyText)}</div>`,
    "Confirm",
    async () => { await onOk(); return true; },
    "Cancel"
  );
}

function hideModal() {
  const modal = byId("modal");
  if (!modal) return;
  modal.classList.remove("modal-open");
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");

}
/* =========================
 * Schedule Creation (Manual)
 * ========================= */

function addScheduleEntryModal() {
  showModal(
    "Add Schedule Entry",
    `
      <div class="form-grid">
        <div class="field">
          <label>Start Date (Friday)</label>
          <input id="newScheduleStart" type="date" />
        </div>

        <div class="small subtle" style="margin-top:10px">
          Start will be set to <b>Friday 4:00 PM CST</b><br/>
          End will be automatically set to <b>Friday 7:00 AM CST (next week)</b><br/>
          Duration is fixed at exactly 7 days.
        </div>
      </div>
    `,
    "Add",
    async () => {
      const startYMD = byId("newScheduleStart")?.value;
      if (!startYMD) {
         throw new Error("Start date is required.");
            }

      const { startISO, endISO } = buildOnCallWindowFromStart(startYMD);

      const err = validateOnCallWindow(startISO, endISO);
      if (err) throw new Error(err);

      if (!APP_STATE.draftSchedule) {
        APP_STATE.draftSchedule = { entries: [] };
      }

      const newEntry = {
        id: crypto.randomUUID(),
        startISO,
        endISO,
        departments: Object.fromEntries(
          DEPT_KEYS.map(dep => [
            dep,
            { name: "", email: "", phone: "" }
          ])
        )
      };

      APP_STATE.draftSchedule.entries.push(newEntry);
      HAS_UNSAVED_CHANGES = true;

      const scheduleEl = byId("schedule");
        if (scheduleEl) renderScheduleAdmin(scheduleEl);
      refreshTimeline();
      updateSaveState();

      toast("Schedule entry added (not saved yet).");
      return true;
    },
    "Cancel"
  );
}

/* =========================
 * Tabs (Admin)
 * ========================= */

function wireTabs() {
  const tabs = Array.from(document.querySelectorAll(".tab"));
  if (!tabs.length) return;

  tabs.forEach(tab => {
    tab.onclick = () => {
      const required = tab.dataset.requires;
      const allowed =
        !required || roleAtLeast(APP_STATE.role, required);

      tabs.forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".panel")
        .forEach(p => p.classList.remove("active"));

      tab.classList.add("active");

      if (!allowed) {
        byId("accessDeniedTab")?.classList.add("active");
        return;
      }
     const target = tab.dataset.tab;

     if (target === "currentTab") {
  startCurrentOnCallAutoRefresh();
} else {
  stopCurrentOnCallAutoRefresh();
}

      byId(target)?.classList.add("active");

      if (target === "auditTab") loadAudit().catch(() => {});
      if (target === "timelineTab") refreshTimeline();
      if (target === "historyTab") loadHistory().catch(() => {});
      if (target === "psCustomersTab") loadPsCustomers().catch(() => {});


    };
  });
}

/* =========================
 * RBAC UI Guards
 * ========================= */
function applyRBACToUI() {
  if (APP_STATE.publicMode) {
    [
      "saveAllBtn",
      "addScheduleBtn",
      "revertBtn",
      "notifyBtn",
      "exportBtn",
      "rosterTabBtn",
      "autogenTabBtn",
      "auditTabBtn"
    ].forEach(id => setHidden(id, true));
    return;
  }

  const canEdit = roleAtLeast(APP_STATE.role, "editor");
  const isAdmin = roleAtLeast(APP_STATE.role, "admin");

  setHidden("saveAllBtn", !canEdit);
  setHidden("addScheduleBtn", !canEdit);
  setHidden("revertBtn", !isAdmin);
  setHidden("notifyBtn", !isAdmin);
  setHidden("exportBtn", !isAdmin);

  setHidden("rosterTabBtn", !isAdmin);
  setHidden("autogenTabBtn", !isAdmin);
  setHidden("auditTabBtn", !isAdmin);
}

function setHidden(id, hidden) {
  const el = byId(id);
  if (!el) return;
  el.style.display = hidden ? "none" : "";
}

/* =========================
 * Time Utilities
 * ========================= */
function parseLocalIsoParts(localISO) {
  // Accept:
  //  - YYYY-MM-DDTHH:mm
  //  - YYYY-MM-DDTHH:mm:ss
  //  - optionally with .sss (ignored)
  const m = String(localISO || "").match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?/
  );
  if (!m) return null;
  return {
    y: Number(m[1]),
    mo: Number(m[2]),
    d: Number(m[3]),
    h: Number(m[4]),
    mi: Number(m[5]),
    s: Number(m[6] || "0")
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
    y: Number(out.year), mo: Number(out.month), d: Number(out.day),
    h: Number(out.hour), mi: Number(out.minute), s: Number(out.second)
  };
}

function diffMinutes(a, b) {
  const aUtc = Date.UTC(a.y, a.mo - 1, a.d, a.h, a.mi, a.s);
  const bUtc = Date.UTC(b.y, b.mo - 1, b.d, b.h, b.mi, b.s);
  return Math.round((aUtc - bUtc) / 60000);
}

function zonedWallTimeToUtcMs(localISO, timeZone) {
  const want = parseLocalIsoParts(localISO);
  if (!want) return null;

  let guessMs = Date.UTC(want.y, want.mo - 1, want.d, want.h, want.mi, want.s);

  for (let i = 0; i < 2; i++) {
    const got = getTZParts(new Date(guessMs), timeZone);
    const deltaMin = diffMinutes(want, got);
    guessMs = guessMs + deltaMin * 60000;
  }
  return guessMs;
}

function formatCSTFromChicagoLocal(localISO) {
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
  return `${s} CST`;
}

function isFriday(d) { return d.getDay() === 5; }

function snapToFridayForward(d) {
  const copy = new Date(d);
  const diff = (5 - copy.getDay() + 7) % 7;
  copy.setDate(copy.getDate() + diff);
  return copy;
}

function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function isoToDateLocalAssumed(iso) {
  const parts = parseLocalIsoParts(iso);
  if (!parts) return new Date(NaN);
  return new Date(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi, parts.s, 0);
}
/* =========================
 * TIME HELPER
 * ========================= */
function buildOnCallWindowFromStart(startYMD) {
  const start = new Date(`${startYMD}T16:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  end.setHours(7, 0, 0, 0);

  return {
    startISO: toLocalInput(start) + ":00",
    endISO: toLocalInput(end) + ":00"
  };
}
/* =========================
 * Helper: get current on-call entry
 * ========================= */
function getCurrentOnCallEntry(entries) {
  const now = new Date();
  return (entries || []).find(e => {
    const s = isoToDateLocalAssumed(e.startISO);
    const en = isoToDateLocalAssumed(e.endISO);
    return now >= s && now < en;
  }) || null;
}

/* =========================
 * Validation
 * ========================= */

function validateOnCallWindow(startISO, endISO) {
  const s = isoToDateLocalAssumed(startISO);
  const e = isoToDateLocalAssumed(endISO);

  if (isNaN(s) || isNaN(e)) return "Invalid date/time format.";
  if (s >= e) return "End must be after start.";
  if (s.getDay() !== 5) return "Start must be on a Friday.";
  if (e.getDay() !== 5) return "End must be on a Friday.";
  if (s.getHours() !== 16 || s.getMinutes() !== 0) return "Start time must be 4:00 PM CST.";
  if (e.getHours() !== 7 || e.getMinutes() !== 0) return "End time must be 7:00 AM CST.";

  const diffMs = e - s;
const expectedMs =
  (6 * 24 * 60 * 60 * 1000) +  // 6 days
  (15 * 60 * 60 * 1000);     // + 15 hours

if (Math.abs(diffMs - expectedMs) > 60_000) {
  return "On-call window must be Friday 4:00 PM → Friday 7:00 AM CST.";
}


  return null;
}
/* =========================
 * CURRENT ONCALL
 * ========================= */
function isCurrentOnCall(entry) {
  const now = new Date();
  const start = isoToDateLocalAssumed(entry.startISO);
  const end = isoToDateLocalAssumed(entry.endISO);
  return now >= start && now < end;
}
function isPastOnCall(entry) {
  const now = new Date();
  const end = isoToDateLocalAssumed(entry.endISO);
  return now >= end;
}
/* =========================
 * Overlap Detection + Auto Conflict Resolution
 * ========================= */

function detectOverlaps(entries) {
  const sorted = [...entries].sort((a, b) => isoToDateLocalAssumed(a.startISO) - isoToDateLocalAssumed(b.startISO));
  const overlaps = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const prevEnd = isoToDateLocalAssumed(prev.endISO);
    const curStart = isoToDateLocalAssumed(cur.startISO);
    if (curStart < prevEnd) {
      overlaps.push({
        prevId: prev.id,
        currId: cur.id,
        message: `Entry ${cur.id} overlaps entry ${prev.id}`
      });
    }
  }
  return overlaps;
}

function autoResolveConflicts(entries) {
  const clone = deepClone(entries);
  clone.sort((a, b) => isoToDateLocalAssumed(a.startISO) - isoToDateLocalAssumed(b.startISO));

  const changes = [];

  for (let i = 1; i < clone.length; i++) {
    const prev = clone[i - 1];
    const cur = clone[i];

    const prevEnd = isoToDateLocalAssumed(prev.endISO);
    const curStart = isoToDateLocalAssumed(cur.startISO);

    if (curStart < prevEnd) {
      const originalStart = cur.startISO;
      const originalEnd = cur.endISO;

      let newStart = snapToFridayForward(prevEnd);
      newStart.setHours(16, 0, 0, 0);

      while (newStart < prevEnd) {
        newStart.setDate(newStart.getDate() + 7);
      }

      const newEnd = new Date(newStart);
      newEnd.setDate(newEnd.getDate() + 7);
      newEnd.setHours(7, 0, 0, 0);

      cur.startISO = toLocalInput(newStart) + ":00";
      cur.endISO = toLocalInput(newEnd) + ":00";
      cur._autoResolved = true;

      changes.push({
        id: cur.id,
        fromStart: originalStart, fromEnd: originalEnd,
        toStart: cur.startISO, toEnd: cur.endISO
      });
    }
  }

  return { resolvedEntries: clone, changes };
}

/* =========================
 * Diff Preview
 * ========================= */

function diffSchedules(original, draft) {
  const diffs = [];
  const origById = new Map((original.entries || []).map(e => [String(e.id), e]));
  const draftById = new Map((draft.entries || []).map(e => [String(e.id), e]));

  for (const [id, d] of draftById.entries()) {
    const o = origById.get(id);
    if (!o) {
      diffs.push(`Entry ${id}: added`);
      continue;
    }

    if ((o.startISO || "") !== (d.startISO || "") || (o.endISO || "") !== (d.endISO || "")) {
      diffs.push(`Entry ${id}: on-call window changed`);
    }

    const oDepts = o.departments || {};
    const dDepts = d.departments || {};
    const deptKeys = new Set([...Object.keys(oDepts), ...Object.keys(dDepts)]);

    for (const dep of deptKeys) {
      const op = oDepts[dep] || {};
      const dp = dDepts[dep] || {};
      for (const f of ["name", "email", "phone"]) {
        if (String(op[f] || "") !== String(dp[f] || "")) {
          diffs.push(`Entry ${id} (${DEPT_LABELS[dep] || dep}): ${f} changed`);
        }
      }
    }
  }

  for (const [id] of origById.entries()) {
    if (!draftById.has(id)) diffs.push(`Entry ${id}: removed`);
  }

  return diffs;
}

/* =========================
 * Public Schedule (Read-only)
 * ========================= */

async function loadSchedulePublic(el) {
  const res = await fetchPublic(`/api/oncall`);
  if (!res.ok) throw new Error(await res.text());

  const data = await res.json();

  // Normalize public payload
  const normalized = normalizeScheduleResponse(data);

APP_STATE.schedulePublic = {
  entries: normalized.entries || []
};


  renderScheduleReadOnly(el, APP_STATE.schedulePublic.entries);
  refreshTimeline();
}


function renderScheduleReadOnly(el, entries) {
  el.innerHTML = "";

  entries.forEach(e => {
    el.innerHTML += `
      <div class="schedule-card">
        <div class="card-head">
          <div class="card-title">
            ${escapeHtml(formatCSTFromChicagoLocal(e.startISO))} → ${escapeHtml(formatCSTFromChicagoLocal(e.endISO))}
          </div>
          <div class="small subtle">Read-only · CST</div>
        </div>
        <div class="entry-grid">
          ${renderDeptBlocks(e.departments, false, e.id, false)}
        </div>
      </div>
    `;
  });
}

async function renderCurrentOnCall() {
  const el = byId("currentOnCall");
  if (!el) return;

  // 1️⃣ Authoritative source
  let entry = await loadCurrentOnCall();

  // 2️⃣ Fallback (legacy / safety)
  if (!entry) {
    const source =
      (APP_STATE.draftSchedule?.entries?.length && APP_STATE.draftSchedule) ||
      (APP_STATE.scheduleFull?.entries?.length && APP_STATE.scheduleFull) ||
      APP_STATE.schedulePublic;

    const entries = source?.entries || [];
    entry = getCurrentOnCallEntry(entries);
  }

  if (!entry) {
    el.innerHTML = `<div class="subtle">No one is currently on call.</div>`;
    return;
  }

  el.innerHTML = `
    <div class="schedule-card current-oncall">
      <div class="card-head">
        <div class="card-title">
          ${escapeHtml(formatCSTFromChicagoLocal(entry.startISO))}
          →
          ${escapeHtml(formatCSTFromChicagoLocal(entry.endISO))}
        </div>
        <div class="small subtle">Live · CST</div>
      </div>

      <div class="entry-grid">
        ${renderDeptBlocks(
          entry.departments,
          roleAtLeast(APP_STATE.role, "editor"),
          entry.id,
          false
        )}
      </div>
    </div>
  `;
}


/* =========================
 * Shared Dept Renderer
 * ========================= */

function renderDeptBlocks(depts, editable, entryId, restrictToAllowedDepts) {
  const deptKeys = Object.keys(depts || {});
  if (!deptKeys.length) {
    return `<div class="entry"><h4>—</h4><div class="small">No assignment</div></div>`;
  }

  const allowed = new Set(APP_STATE.allowedDepartments || []);

  return deptKeys
    .filter(dep => !restrictToAllowedDepts || allowed.has(dep) || roleAtLeast(APP_STATE.role, "admin"))
    .map(dep => {
      const p = (depts || {})[dep] || {};
      const label = DEPT_LABELS[dep] || dep;

      if (!editable) {
        return `
          <div class="entry">
            <h4>${escapeHtml(label)}</h4>
            <div><b>${escapeHtml(p.name || "")}</b></div>
            <div>${escapeHtml(p.email || "")}</div>
            <div class="small">${escapeHtml(p.phone || "")}</div>
          </div>
        `;
      }

     return `
  <div class="entry">
    <h4>${escapeHtml(label)}</h4>

    <div class="inline-row">
      <label>User</label>
      ${renderRosterSelect(entryId, dep, p.email)}
    </div>

    <div class="small subtle">
      Name & phone auto-filled from roster
    </div>

    <div class="small">
      <b>${escapeHtml(p.name || "")}</b><br/>
      ${escapeHtml(p.phone || "")}
    </div>
  </div>
`;
    })
    .join("");
}
/* =========================
 * Normalized Schedule
 * ========================= */
function normalizeScheduleResponse(raw) {
  // 1) If the whole response is a string, parse it
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { raw = {}; }
  }

  // 2) Unwrap common containers
  let container =
    raw?.schedule ??
    raw?.data ??
    raw?.value ??   // NOTE: KV wrappers often use .value as STRING
    raw;

  // 3) If the container itself is a string, parse it (THIS IS THE KEY FIX)
  if (typeof container === "string") {
    try { container = JSON.parse(container); } catch { container = {}; }
  }

  // 4) Pull entries from common shapes
  let entries =
    container?.entries ??
    container?.items ??
    container?.schedule?.entries ??
    container?.value ??   // sometimes nested again
    [];

  // 5) If entries is a string, parse it
  if (typeof entries === "string") {
    try { entries = JSON.parse(entries); } catch { entries = []; }
  }

  // 6) Convert object map → array
  if (entries && !Array.isArray(entries) && typeof entries === "object") {
    entries = Object.values(entries);
  }

  if (!Array.isArray(entries)) entries = [];

  return { entries };
}
/* =========================
 * Client-Side Normalization (Bulk Upload Input)
 * ========================= */

function normalizeScheduleEntriesFromBulk(rows) {
  const map = new Map();

  for (const r of rows || []) {
    if (!r.startISO || !r.endISO || !r.team) continue;

    const key = `${r.startISO}::${r.endISO}`;

    if (!map.has(key)) {
      map.set(key, {
        id: crypto.randomUUID(),
        startISO: r.startISO,
        endISO: r.endISO,
        departments: {}
      });
    }

    const entry = map.get(key);

    entry.departments[r.team] = {
      name: (r.name || "").trim(),
      email: (r.email || "").trim(),
      phone: (r.phone || "").trim()
    };
  }

  return Array.from(map.values());
}
function wireScheduleBulkUpload() {
  const input = byId("scheduleUploadInput");
  if (!input) return;

  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;

    const rows = await parseSpreadsheet(file);
    const incoming = normalizeScheduleEntriesFromBulk(rows);

    const preview = [];
    const warnings = [];
   const draft = deepClone(
  APP_STATE.draftSchedule || { entries: [] }
);


    incoming.forEach(ne => {
      const conflict = detectOverlaps([...draft.entries, ne]);
      if (conflict.length) {
        warnings.push(`Conflict detected for ${ne.startISO}`);
      }

      const existing = draft.entries.find(e =>
        e.startISO === ne.startISO && e.endISO === ne.endISO
      );

      if (existing) {
        preview.push(`UPDATE ${ne.startISO}`);
        Object.assign(existing.departments, ne.departments);
      } else {
        preview.push(`ADD ${ne.startISO}`);
        draft.entries.push(ne);
      }
    });

    showModal(
      "Schedule Upload Preview (Dry-Run)",
      `
        <div class="small"><b>Changes:</b></div>
        <ul>${preview.map(p => `<li>${escapeHtml(p)}</li>`).join("")}</ul>
        ${warnings.length ? `<div class="small" style="color:#ef4444"><b>Conflicts:</b><ul>${warnings.map(w => `<li>${escapeHtml(w)}</li>`).join("")}</ul></div>` : ""}
        <div class="small subtle">No data has been saved yet.</div>
      `,
      "Apply",
      async () => {
        APP_STATE.draftSchedule = draft;
        renderScheduleAdmin(byId("schedule"));
        refreshTimeline();
        HAS_UNSAVED_CHANGES = true;
        updateSaveState();
        toast("Schedule changes applied (not saved).");
        return true;
      },
      "Cancel"
    );

    input.value = "";
  };
}

/* =========================
 * Admin Schedule (Editor/Admin)
 * ========================= */

async function loadScheduleAdmin(el) {
  const res = await fetchAuth(`/api/admin/oncall`, { method: "GET" });
  if (!res.ok) throw new Error(await res.text());

  const raw = await res.json();
  console.log("[oncall] raw admin/oncall response:", raw);

  const data = normalizeScheduleResponse(raw);
  console.log(
    "[oncall] normalized entries count:",
    data.entries?.length,
    data
  );

  APP_STATE.scheduleFull = data;
  APP_STATE.draftSchedule = deepClone(data);
  APP_STATE.editingEntryIds.clear();

(data.entries || []).forEach(e => {
  if (e.notification) {
    APP_STATE.notifyStatus[e.id] = e.notification;
    return;
  }

  // backward compatibility
  if (e.notifiedAt || Array.isArray(e.smsStatus)) {
  APP_STATE.notifyStatus[e.id] = {
    email: e.notifiedAt ? { sentAt: e.notifiedAt } : null,
    sms: Array.isArray(e.smsStatus) ? e.smsStatus : [],
    by: e.notifiedBy || "admin"
  };
}
});


  renderScheduleAdmin(el);
  refreshTimeline();
  applyRBACToUI();
}

function renderScheduleAdmin(el) {
  const canEdit = roleAtLeast(APP_STATE.role, "editor");
  const isAdmin = roleAtLeast(APP_STATE.role, "admin");

  el.innerHTML = "";
  if (!Array.isArray(APP_STATE.draftSchedule?.entries)) {
  el.innerHTML = `
    <div class="subtle" style="padding:12px">
      Schedule data is unavailable.
    </div>
  `;
  return;
}


  const deptFilter = String(APP_STATE.dept || "all").toLowerCase();
  const restrictToAllowedDepts = roleAtLeast(APP_STATE.role, "admin") ? false : true;

 const allEntries = (APP_STATE.draftSchedule?.entries || []).map(e => ({
  ...e,
  departments: e.departments || Object.fromEntries(
    DEPT_KEYS.map(dep => [dep, { name: "", email: "", phone: "" }])
  )
}));
// ===============================
// SPLIT ACTIVE vs ARCHIVED ENTRIES
// ===============================
const activeEntries = [];
const archivedEntries = [];

allEntries.forEach(e => {
  if (isPastOnCall(e)) {
    archivedEntries.push(e);
  } else {
    activeEntries.push(e);
  }
});

// ===============================
// ACTIVE / CURRENT SCHEDULES
// ===============================
activeEntries.forEach(e => {
  const editing =
    APP_STATE.editingEntryIds.has(String(e.id));

  const startDisplay = formatCSTFromChicagoLocal(e.startISO);
  const endDisplay = formatCSTFromChicagoLocal(e.endISO);

  const startInput = (e.startISO || "").slice(0, 16);
  const endInput = (e.endISO || "").slice(0, 16);

  el.innerHTML += `
    <div class="schedule-card
      ${e._autoResolved ? "resolved" : ""}
      ${isCurrentOnCall(e) ? "current-oncall" : ""}">

      <div class="card-head">
        <div>
          ${
            editing && canEdit
              ? `
                <div class="inline-row">
                  <label>Start (Fri only)</label>
                  <input type="datetime-local"
                         data-time="start"
                         data-id="${escapeHtml(String(e.id))}"
                         value="${escapeHtml(startInput)}"
                         step="60" />
                </div>

                <div class="inline-row">
                  <label>End (Auto-aligned to Fri 7:00 AM)</label>
                  <input type="datetime-local"
                         data-time="end"
                         data-id="${escapeHtml(String(e.id))}"
                         value="${escapeHtml(endInput)}"
                         step="60" />
                </div>

                <div class="small subtle">
                  CST · Fri 4:00 PM → Fri 7:00 AM
                </div>
              `
              : `
                <div class="card-title">
                  ${escapeHtml(startDisplay)} → ${escapeHtml(endDisplay)}
                  ${
                    (() => {
                      const h = getHolidayName(isoToDateLocalAssumed(e.startISO));
                      return h
                        ? `<span class="holiday-badge">${escapeHtml(h)}</span>`
                        : "";
                    })()
                  }
                </div>

                ${
                  (() => {
  const n = APP_STATE.notifyStatus[e.id] || {};
  const hasEmail = !!n.email;
  const hasSMS = Array.isArray(n.sms) && n.sms.length > 0;

  if (!hasEmail && !hasSMS) {
    return `<span class="notify-badge pending">⏳ Pending</span>`;
  }

  return `
    <div class="notify-badges">
      ${hasEmail ? `<span class="notify-badge email">📧 Email</span>` : ""}
      ${hasSMS ? `<span class="notify-badge sms">📱 SMS</span>` : ""}
      ${hasEmail && hasSMS ? `<span class="notify-badge both">✅ Both</span>` : ""}
      <button class="ghost small"
        data-action="notifyTimeline"
        data-id="${escapeHtml(String(e.id))}">
        🕒 Timeline
      </button>
    </div>
  `;
})()
                }

                <div class="small subtle">CST</div>
              `
          }
          <div class="small">Entry ID: ${escapeHtml(String(e.id))}</div>
        </div>

        <div class="card-actions">
          ${
            isAdmin
              ? `
                <button class="ghost"
                  data-action="notifyEntry"
                  data-id="${escapeHtml(String(e.id))}">
                  Notify (Email + SMS)
                </button>

                <button class="ghost"
                  data-action="notifySMS"
                  data-id="${escapeHtml(String(e.id))}">
                  Send SMS Only
                </button>
                
                <button class="ghost"
                  data-action="notifyEmail"
                  data-id="${escapeHtml(String(e.id))}">
                  Send Email Only
                </button>
              `
              : ""
          }

          ${
            canEdit
              ? `
                <button class="primary"
                  data-action="${editing ? "done" : "edit"}"
                  data-id="${escapeHtml(String(e.id))}">
                  ${editing ? "Done" : "Edit"}
                </button>
              `
              : ""
          }
        </div>
      </div>

      <div class="entry-grid">
        ${renderDeptBlocks(
          e.departments,
          editing && canEdit,
          e.id,
          restrictToAllowedDepts
        )}
      </div>
    </div>
  `;
});
// ===============================
// VISUAL DIVIDER — ACTIVE → ARCHIVED
// ===============================
if (archivedEntries.length && activeEntries.length) {
  el.innerHTML += `
    <div class="schedule-divider">
      <span>Archived Schedules</span>
    </div>
  `;
}

// ===============================
// ARCHIVED (COLLAPSIBLE — PERSISTED)
// ===============================
if (archivedEntries.length) {
  const isOpen = localStorage.getItem(ARCHIVE_STATE_KEY) === "true";

  el.innerHTML += `
    <details class="archived-wrapper" ${isOpen ? "open" : ""}>
      <summary id="archivedSummary">
        Archived Schedules (${archivedEntries.length})
      </summary>

      <div class="archived-list">
        ${archivedEntries.map(e => {
          const startDisplay = formatCSTFromChicagoLocal(e.startISO);
          const endDisplay = formatCSTFromChicagoLocal(e.endISO);

          return `
            <div class="schedule-card past-week archived">
              <div class="card-head">
                <div class="card-title">
                  ${escapeHtml(startDisplay)} → ${escapeHtml(endDisplay)}
                  <span class="archived-badge">Archived</span>
                </div>
                <div class="small subtle">Read-only · CST</div>
                <div class="small">
                  Entry ID: ${escapeHtml(String(e.id))}
                </div>
              </div>

              <div class="entry-grid">
                ${renderDeptBlocks(e.departments, false, e.id, false)}
              </div>
            </div>
          `;
        }).join("")}
      </div>
    </details>
  `;

  // Persist open/close state
  const details = el.querySelector(".archived-wrapper");
  if (details) {
    details.addEventListener("toggle", () => {
      localStorage.setItem(ARCHIVE_STATE_KEY, details.open ? "true" : "false");
    });
  }
}
  el.querySelectorAll("button[data-action]").forEach(btn => {
    btn.onclick = async () => {
      const action = btn.getAttribute("data-action");
      const id = btn.getAttribute("data-id");
      if (action === "notifyEmail") {
  const entry = APP_STATE.scheduleFull?.entries?.find(
    e => String(e.id) === String(id)
  );

  if (!entry || isPastOnCall(entry)) {
    toast("Cannot send email for past on-call weeks.");
    return;
  }

  confirmModal(
    "Send Email Notification",
    "Send email notification to the on-call user(s) for this week?",
    async () => {
      const res = await fetchAuth(`/api/admin/oncall/notify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "email",
          entryId: id,
          auto: false
        })
      });

      if (!res.ok) throw new Error(await res.text());

      // ✅ Persist UI state safely
      await loadNotifyStatus();
      renderScheduleAdmin(el);

      toast("Email notification sent.");
    }
  );
  return;
}
      if (action === "notifyTimeline") {
  await openNotifyTimeline(id);
  return;
}


     if (action === "edit") {
  const entry = APP_STATE.draftSchedule?.entries?.find(e => String(e.id) === String(id));
  if (!entry || isPastOnCall(entry)) {
    toast("Past on-call weeks cannot be edited.");
    return;
  }
  APP_STATE.editingEntryIds.add(String(id));
  renderScheduleAdmin(el);
  return;
}

if (action === "done") {
  APP_STATE.editingEntryIds.delete(String(id));
  renderScheduleAdmin(el);
  return;
}

if (action === "notifyEntry") {
  const entry = APP_STATE.scheduleFull?.entries?.find(e => String(e.id) === String(id));
  if (!entry || isPastOnCall(entry)) {
    toast("Cannot notify for past on-call weeks.");
    return;
  }

  const already = APP_STATE.notifyStatus[id];

  confirmModal(
    already ? "Resend Notification?" : "Notify This Week",
    already
      ? "Notifications were already sent. Resend them now?"
      : "Send start and end notifications for this entry?",
    async () => {
      const res = await fetchAuth(`/api/admin/oncall/notify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "both",
          entryId: id,
          retry: !!already
        })
      });

      if (!res.ok) throw new Error(await res.text());

      APP_STATE.notifyStatus[id] = {
  email: { sentAt: new Date().toISOString() },
  sms: Array.isArray(APP_STATE.notifyStatus[id]?.sms)
    ? APP_STATE.notifyStatus[id].sms
    : [],
  by: "admin",
  auto: false
};


      renderScheduleAdmin(el);
      toast(already ? "Notifications resent." : "Notifications sent.");
    }
  );
  return;
}
if (action === "notifySMS") {
  const entry = APP_STATE.scheduleFull?.entries?.find(e => String(e.id) === String(id));
  if (!entry || isPastOnCall(entry)) {
    toast("Cannot send SMS for past on-call weeks.");
    return;
  }

  confirmModal(
    "Send SMS Notification",
    "Send SMS notification to the on-call user(s) for this week?",
    async () => {
      const res = await fetchAuth(`/api/admin/oncall/notify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "sms",
          entryId: id
        })
      });

      if (!res.ok) throw new Error(await res.text());

      // 🔑 Re-sync from KV (authoritative)
await loadNotifyStatus();

// 🔑 Re-render with persisted state
renderScheduleAdmin(el);

toast("Email notification sent.");
    }
  );
  return;
}
    };
  });
  el.querySelectorAll("input[data-time]").forEach(inp => {
    inp.onchange = () => {
      HAS_UNSAVED_CHANGES = true;
      const id = inp.getAttribute("data-id");
      const which = inp.getAttribute("data-time");

      const entry = (APP_STATE.draftSchedule?.entries || []).find(x => String(x.id) === String(id));
      if (!entry) return;

      let d = new Date(inp.value);
      if (isNaN(d)) return;

      if (!isFriday(d)) d = snapToFridayForward(d);

      if (which === "start") d.setHours(16, 0, 0, 0);
      else d.setHours(7, 0, 0, 0);

      const fixed = toLocalInput(d);
      inp.value = fixed;

      const newISO = fixed + ":00";
      if (which === "start") entry.startISO = newISO;
      else entry.endISO = newISO;

      const err = validateOnCallWindow(entry.startISO, entry.endISO);
      if (err) toast(`Entry ${entry.id}: ${err}`, 3200);

      refreshTimeline();
    };
  });
el.querySelectorAll("select[data-field='email']").forEach(sel => {
  sel.onchange = () => {
    HAS_UNSAVED_CHANGES = true;

    const entryId = sel.getAttribute("data-entry");
    const dep = sel.getAttribute("data-dept");
    const email = sel.value;

    const user = APP_STATE.roster?.[dep]?.find(u => u.email === email);
    if (!user) return;

    const entry = (APP_STATE.draftSchedule?.entries || [])
      .find(e => String(e.id) === String(entryId));
    if (!entry) return;

    entry.departments[dep] = {
      name: user.name,
      email: user.email,
      phone: user.phone || ""
    };

    refreshTimeline();
    updateSaveState();
  };
});
  
  el.querySelectorAll("input[data-entry]").forEach(inp => {
    inp.oninput = () => {
      HAS_UNSAVED_CHANGES = true;
      const entryId = inp.getAttribute("data-entry");
      const dept = inp.getAttribute("data-dept");
      const field = inp.getAttribute("data-field");
      const value = inp.value;

      const entry = (APP_STATE.draftSchedule?.entries || []).find(x => String(x.id) === String(entryId));
      if (!entry) return;

      if (!entry.departments) entry.departments = {};
      if (!entry.departments[dept]) entry.departments[dept] = {};
      entry.departments[dept][field] = value;

      refreshTimeline();
    };
  });
}
/* =========================
 * PS Customers (Professional Services)
 * ========================= */

async function loadPsCustomers() {
  const el = byId("psCustomers");
  if (!el) return;

  el.innerHTML = `<div class="subtle">Loading PS customers…</div>`;

  const res = await fetchAuth(`/api/admin/ps-customers`, { method: "GET" });
  if (!res.ok) {
    el.innerHTML = `<div class="subtle">Unable to load PS customers.</div>`;
    return;
  }

  const data = await res.json();
  APP_STATE.psCustomers = Array.isArray(data.customers) ? data.customers : [];

  renderPsCustomers();
}

function renderPsCustomers() {
  const el = byId("psCustomers");
  if (!el) return;

  const list = APP_STATE.psCustomers || [];

  el.innerHTML = `
    <table class="roster-table">
      <thead>
        <tr>
          <th style="width:50%">Customer Name</th>
          <th style="width:20%">PIN</th>
          <th style="width:20%">Customer ID</th>
          <th style="width:10%"></th>
        </tr>
      </thead>
      <tbody>
        ${list.map((c, idx) => `
          <tr>
            <td>
              <input
                data-ps="1"
                data-idx="${idx}"
                data-field="name"
                value="${escapeHtml(c.name || "")}"
              />
            </td>
            <td>
              <input
                data-ps="1"
                data-idx="${idx}"
                data-field="pin"
                maxlength="5"
                pattern="\\d{5}"
                value="${escapeHtml(c.pin || "")}"
              />
            </td>
            <td class="small subtle">
              ${escapeHtml(c.id)}
            </td>
            <td>
              <button
                class="iconbtn"
                data-ps-remove="1"
                data-idx="${idx}"
                title="Remove"
              >🗑</button>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>

    <div class="small subtle" style="margin-top:8px">
      PINs must be exactly 5 digits.
    </div>
  `;

  // inline edits
  el.querySelectorAll("input[data-ps]").forEach(inp => {
    inp.oninput = () => {
      HAS_UNSAVED_CHANGES = true;

      const idx = Number(inp.getAttribute("data-idx"));
      const field = inp.getAttribute("data-field");
      if (!APP_STATE.psCustomers?.[idx]) return;

      APP_STATE.psCustomers[idx][field] = inp.value.trim();
    };
  });

  // remove
  el.querySelectorAll("button[data-ps-remove]").forEach(btn => {
    btn.onclick = () => {
      const idx = Number(btn.getAttribute("data-idx"));
      if (!APP_STATE.psCustomers?.[idx]) return;

      showModal(
        "Remove PS Customer",
        "Remove this customer and PIN?",
        "Remove",
        async () => {
          APP_STATE.psCustomers.splice(idx, 1);
          renderPsCustomers();
          toast("Customer removed (not saved).");
          return true;
        },
        "Cancel"
      );
    };
  });
}

function psAddCustomerModal() {
  showModal(
    "Add PS Customer",
    `
      <div class="form-grid">
        <div class="field">
          <label>Customer Name</label>
          <input id="psNewName" placeholder="City of West Des Moines" />
        </div>
        <div class="field">
          <label>5-Digit PIN</label>
          <input id="psNewPin" maxlength="5" placeholder="12345" />
        </div>
      </div>
    `,
    "Add",
    async () => {
      const name = byId("psNewName")?.value.trim();
      const pin = byId("psNewPin")?.value.trim();

      if (!name) throw new Error("Customer name is required.");
      if (!/^\d{5}$/.test(pin)) throw new Error("PIN must be exactly 5 digits.");

      APP_STATE.psCustomers ||= [];
      APP_STATE.psCustomers.push({
        id: crypto.randomUUID(),
        name,
        pin
      });

      renderPsCustomers();
      HAS_UNSAVED_CHANGES = true;
      toast("Customer added (not saved).");
      return true;
    },
    "Cancel"
  );
}

async function savePsCustomers() {
  const list = APP_STATE.psCustomers || [];

  for (const c of list) {
    if (!c.name || !/^\d{5}$/.test(c.pin)) {
      toast("All customers must have a name and a valid 5-digit PIN.");
      return;
    }
  }

  const res = await fetchAuth(`/api/admin/ps-customers/save`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      customers: list
    })
  });

  if (!res.ok) throw new Error(await res.text());

  toast("PS customers saved.");
  HAS_UNSAVED_CHANGES = false;
  updateSaveState?.();
  await loadPsCustomers();
}

/* =========================
 * Notify Status Normalizer (FIX for SMS unshift undefined)
 * ========================= */
function ensureNotifyBucket(entryId, { by = "admin", auto = false } = {}) {
  const id = String(entryId || "");
  if (!id) return null;

  if (!APP_STATE.notifyStatus || typeof APP_STATE.notifyStatus !== "object") {
    APP_STATE.notifyStatus = {};
  }

  // Create the entry bucket if missing
  if (!APP_STATE.notifyStatus[id] || typeof APP_STATE.notifyStatus[id] !== "object") {
    APP_STATE.notifyStatus[id] = {
      email: null,
      sms: [],
      by,
      auto
    };
  }

  // Guarantee sms is always an array
  if (!Array.isArray(APP_STATE.notifyStatus[id].sms)) {
    APP_STATE.notifyStatus[id].sms = [];
  }

  // Guarantee email key exists (can be null)
  if (!("email" in APP_STATE.notifyStatus[id])) {
    APP_STATE.notifyStatus[id].email = null;
  }

  // Update actor flags if provided
  APP_STATE.notifyStatus[id].by = APP_STATE.notifyStatus[id].by || by;
  APP_STATE.notifyStatus[id].auto = typeof APP_STATE.notifyStatus[id].auto === "boolean"
    ? APP_STATE.notifyStatus[id].auto
    : auto;

  return APP_STATE.notifyStatus[id];
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}
/* =========================
 * Bulk Upload Helpers
 * ========================= */

function normalizeEmail(e) {
  return String(e || "").trim().toLowerCase();
}

async function parseSpreadsheet(file) {
  const name = file.name.toLowerCase();

  if (name.endsWith(".csv")) {
    const text = await file.text();
    const [header, ...lines] = text.split(/\r?\n/).filter(Boolean);
    const headers = header.split(",").map(h => h.trim().toLowerCase());

    return lines.map(line => {
      const cols = line.split(",");
      const row = {};
      headers.forEach((h, i) => row[h] = (cols[i] || "").trim());
      return row;
    });
  }

  if (name.endsWith(".xlsx")) {
    if (!window.XLSX) {
      throw new Error("XLSX library not loaded.");
    }
    const data = await file.arrayBuffer();
    const wb = XLSX.read(data);
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, { defval: "" });
  }

  throw new Error("Unsupported file type.");
}

function downloadCSV(filename, rows) {
  if (!rows.length) {
    toast("Nothing to download.");
    return;
  }

  const headers = Object.keys(rows[0]);
  const csv = [
    headers.join(","),
    ...rows.map(r =>
      headers.map(h =>
        `"${String(r[h] ?? "").replace(/"/g, '""')}"`
      ).join(",")
    )
  ].join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* =========================
 * Save / Notify / Export / ICS
 * ========================= */

async function saveAllChanges() {
  const canEdit = roleAtLeast(APP_STATE.role, "editor");
  const isAdmin = roleAtLeast(APP_STATE.role, "admin");
  for (const e of (APP_STATE.draftSchedule.entries || [])) {
  const original = APP_STATE.scheduleFull?.entries?.find(o => String(o.id) === String(e.id));
  if (original && isPastOnCall(original)) {
    if (JSON.stringify(original) !== JSON.stringify(e)) {
      toast(`Entry ${e.id} is in the past and cannot be modified.`, 5000);
      return;
    }
  }
}

  if (!canEdit) {
    toast("You do not have permission to save changes.");
    return;
  }

  if (!APP_STATE.scheduleFull || !APP_STATE.draftSchedule) {
    toast("Schedule not loaded.");
    return;
  }

  const draft = APP_STATE.draftSchedule;

  for (const e of (draft.entries || [])) {
    const err = validateOnCallWindow(e.startISO, e.endISO);
    if (err) {
      toast(`Entry ${e.id}: ${err}`, 4500);
      return;
    }
  }

  const overlaps = detectOverlaps(draft.entries || []);
  if (overlaps.length) {
    if (!isAdmin) {
      toast(overlaps.map(o => o.message).join("; "), 5000);
      return;
    }

    const { resolvedEntries, changes } = autoResolveConflicts(draft.entries || []);
    const still = detectOverlaps(resolvedEntries);

    if (still.length) {
      toast("Conflicts detected but could not be auto-resolved. Please adjust manually.", 5000);
      return;
    }

    const changesHtml = changes.length
      ? `<ul>${changes.map(c => `
          <li>
            Entry ${escapeHtml(String(c.id))} shifted:<br/>
            <span class="small subtle">
              ${escapeHtml(formatCSTFromChicagoLocal(c.fromStart))} → ${escapeHtml(formatCSTFromChicagoLocal(c.fromEnd))}
              <br/>
              to
              <br/>
              ${escapeHtml(formatCSTFromChicagoLocal(c.toStart))} → ${escapeHtml(formatCSTFromChicagoLocal(c.toEnd))}
            </span>
          </li>
        `).join("")}</ul>`
      : `<div class="small subtle">No shifts needed.</div>`;

    showModal(
      "Overlaps Detected — Auto-Resolved",
      `
        <div class="small">Overlaps were detected and the system shifted entries forward by 1+ week(s) to remove conflicts.</div>
        <div style="margin-top:10px">${changesHtml}</div>
        <div class="small subtle" style="margin-top:10px">Proceed to diff preview and save?</div>
      `,
      "Continue",
      async () => {
        draft.entries = resolvedEntries;
        refreshTimeline();
        await showDiffAndSave();
        return true;
      },
      "Cancel"
    );

    return;
  }

  await showDiffAndSave();
}

async function showDiffAndSave() {
  const original = APP_STATE.scheduleFull;
  const draft = APP_STATE.draftSchedule;

  const diffs = diffSchedules(original, draft);
  if (!diffs.length) {
    toast("No changes detected.");
    return;
  }

  showModal(
    "Diff Preview",
    `
      <div class="small">Review changes before saving:</div>
      <ul style="margin-top:10px">
        ${diffs.map(d => `<li>${escapeHtml(d)}</li>`).join("")}
      </ul>
      <div class="small subtle" style="margin-top:10px">This will overwrite the current schedule.</div>
    `,
    "Save",
    async () => {
      const res = await fetchAuth(`/api/admin/oncall/save`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schedule: draft })
      });
      if (!res.ok) throw new Error(await res.text());

      toast("Schedule saved.");
      HAS_UNSAVED_CHANGES = false;      // ✅ ADD THIS
      updateSaveState?.();              // ✅ OPTIONAL but recommended
      await loadScheduleAdmin(byId("schedule"));
      return true;
    },
    "Cancel"
  );
}
function downloadRosterCSV() {
  const rows = [];
  Object.entries(APP_STATE.roster || {}).forEach(([dep, users]) => {
    users.forEach(u => rows.push({
      department: dep,
      name: u.name,
      email: u.email,
      phone: u.phone
    }));
  });
  downloadCSV("roster.csv", rows);
}

function downloadScheduleCSV() {
  const rows = [];
  (APP_STATE.scheduleFull?.entries || []).forEach(e => {
    Object.entries(e.departments || {}).forEach(([dep, p]) => {
      rows.push({
        startISO: e.startISO,
        endISO: e.endISO,
        team: dep,
        name: p.name,
        email: p.email,
        phone: p.phone
      });
    });
  });
  downloadCSV("schedule.csv", rows);
}

async function exportExcel() {
  const dept = String(APP_STATE.dept || "all");
  // Use same-origin download so Access can authorize it
  window.location = apiUrl(`/api/oncall/export?department=${encodeURIComponent(dept)}`);
}

async function exportICS() {
  const dept = String(APP_STATE.dept || "all").toLowerCase();
  // Keep it same-origin. Worker decides whether this is public or requires Access.
  window.location = apiUrl(`/oncall/ics?department=${encodeURIComponent(dept)}`);
}

async function sendNotify() {
  const entries = APP_STATE.scheduleFull?.entries || [];
  const now = new Date();

  // Find active entry explicitly
  const active = entries.find(e => {
    const s = isoToDateLocalAssumed(e.startISO);
    const en = isoToDateLocalAssumed(e.endISO);
    return now >= s && now < en;
  });

  if (!active) {
    toast("No active on-call entry to notify.");
    return;
  }

  const res = await fetchAuth(`/api/admin/oncall/notify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "both",
      entryId: active.id
    })
  });

  if (!res.ok) throw new Error(await res.text());

  APP_STATE.notifyStatus[active.id] = {
    email: { sentAt: new Date().toISOString() },
    sms: [],
    by: "admin"
  };

  renderScheduleAdmin(byId("schedule"));
  toast("Notifications sent.");
}


async function revertSchedule() {
  const res = await fetchAuth(`/api/admin/oncall/revert`, { method: "POST" });
  if (!res.ok) throw new Error(await res.text());
  toast("Reverted.");
  await loadScheduleAdmin(byId("schedule"));
}

/* =========================
 * Auto-Generate
 * ========================= */

async function runAutogen() {
  const startEl = byId("autogenStart");
  const endEl = byId("autogenEnd");
  const seedEl = byId("autogenSeed");

  const start = startEl ? startEl.value : "";
  const end = endEl ? endEl.value : "";
  const seed = seedEl ? Number(seedEl.value || 0) : 0;

  if (!start || !end) throw new Error("Start and end dates are required.");

  const res = await fetchAuth(`/api/admin/oncall/autogenerate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ startYMD: start, endYMD: end, seedIndex: seed })
  });
  if (!res.ok) throw new Error(await res.text());

  toast("Auto-generated schedule.");
  await loadScheduleAdmin(byId("schedule"));
}

/* =========================
 * Roster Management
 * ========================= */

async function loadRoster() {
  const res = await fetchAuth(`/api/admin/roster`, { method: "GET" });
  if (!res.ok) throw new Error(await res.text());
  const roster = await res.json();
  APP_STATE.roster = roster;
  renderRoster();
}

function renderRoster() {
  const el = byId("roster");
  if (!el) return;

  const roster = APP_STATE.roster || {};
  el.innerHTML = `
    <div class="roster-wrap">
      ${DEPT_KEYS.map(dep => renderRosterDept(dep, roster[dep] || [])).join("")}
    </div>
  `;

  // existing input handlers...
  el.querySelectorAll("input[data-roster]").forEach(inp => {
    inp.oninput = () => {
      HAS_UNSAVED_CHANGES = true;
      const dept = inp.getAttribute("data-dept");
      const idx = Number(inp.getAttribute("data-idx"));
      const field = inp.getAttribute("data-field");
      if (!APP_STATE.roster?.[dept]?.[idx]) return;
      APP_STATE.roster[dept][idx][field] = inp.value;
    };
  });

  // existing remove handlers...
  el.querySelectorAll("button[data-roster-remove]").forEach(btn => {
    btn.onclick = () => {
      const dept = btn.getAttribute("data-dept");
      const idx = Number(btn.getAttribute("data-idx"));
      if (!APP_STATE.roster?.[dept]) return;

      showModal(
        "Remove User",
        `<div>Remove this user from <b>${escapeHtml(DEPT_LABELS[dept])}</b> roster?</div>`,
        "Remove",
        async () => {
          APP_STATE.roster[dept].splice(idx, 1);
          renderRoster();
          toast("Removed (not saved yet).");
          return true;
        },
        "Cancel"
      );
    };
  });

  // ✅ ADD USER BUTTON FIX (THIS IS THE KEY)
  const addBtn = byId("rosterAddUserBtn");
  if (addBtn) {
    addBtn.onclick = rosterAddUserModal;
  }
}

function renderRosterDept(deptKey, list) {
  return `
    <div class="roster-card">
      <div class="roster-head">
        <h3>${escapeHtml(DEPT_LABELS[deptKey] || deptKey)}</h3>
      </div>
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
          ${(list || []).map((u, idx) => `
            <tr>
              <td><input data-roster="1" data-dept="${escapeHtml(deptKey)}" data-idx="${idx}" data-field="name" value="${escapeHtml(u.name || "")}"></td>
              <td><input data-roster="1" data-dept="${escapeHtml(deptKey)}" data-idx="${idx}" data-field="email" value="${escapeHtml(u.email || "")}"></td>
              <td><input data-roster="1" data-dept="${escapeHtml(deptKey)}" data-idx="${idx}" data-field="phone" value="${escapeHtml(u.phone || "")}"></td>
              <td><button class="iconbtn" data-roster-remove="1" data-dept="${escapeHtml(deptKey)}" data-idx="${idx}" title="Remove">🗑</button></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      <div class="small subtle" style="margin-top:8px">Rotation uses this list order.</div>
    </div>
  `;
}

function rosterAddUserModal() {
  if (!APP_STATE.roster) APP_STATE.roster = { enterprise_network: [], collaboration: [], system_storage: [] };

  showModal(
    "Add Roster User",
    `
      <div class="form-grid">
        <div class="field">
          <label>Department</label>
          <select id="newUserDept">
            ${DEPT_KEYS.map(k => `<option value="${escapeHtml(k)}">${escapeHtml(DEPT_LABELS[k])}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label>Name</label>
          <input id="newUserName" placeholder="Jane Doe" />
        </div>
        <div class="field">
          <label>Email</label>
          <input id="newUserEmail" placeholder="jane.doe@company.com" />
        </div>
        <div class="field">
          <label>Phone</label>
          <input id="newUserPhone" placeholder="Optional" />
        </div>
      </div>
      <div class="small subtle" style="margin-top:10px">Tip: Name + Email required.</div>
    `,
    "Add",
    async () => {
      const dept = (byId("newUserDept")?.value || "").trim();
      const name = (byId("newUserName")?.value || "").trim();
      const email = (byId("newUserEmail")?.value || "").trim();
      const phone = (byId("newUserPhone")?.value || "").trim();

      if (!dept || !DEPT_KEYS.includes(dept)) throw new Error("Invalid department.");
      if (!name || !email) throw new Error("Name and email are required.");
      if (!email.includes("@")) throw new Error("Email looks invalid.");

      APP_STATE.roster[dept] = APP_STATE.roster[dept] || [];
      APP_STATE.roster[dept].push({ name, email, phone });

      renderRoster();
      toast("User added (not saved yet).");
      return true;
    },
    "Cancel"
  );
}

async function saveRoster() {
  if (!APP_STATE.roster) throw new Error("Roster is empty.");

  const res = await fetchAuth(`/api/admin/roster/save`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roster: APP_STATE.roster })
  });

  if (!res.ok) throw new Error(await res.text());
  toast("Roster saved.");
  HAS_UNSAVED_CHANGES = false;      // ✅ ADD THIS
  updateSaveState?.();              // ✅ OPTIONAL but recommended
  await loadRoster();
}
function wireRosterBulkUpload() {
  const input = byId("rosterUploadInput");
  if (!input) return;

  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;

    const rows = await parseSpreadsheet(file);
    const preview = [];
    const warnings = [];

    const draft = deepClone(APP_STATE.roster || {});

    rows.forEach((r, i) => {
      const dept = r.department || r.dept;
      if (!DEPT_KEYS.includes(dept)) {
        warnings.push(`Row ${i + 1}: invalid department`);
        return;
      }

      const email = normalizeEmail(r.email);
      if (!email) {
        warnings.push(`Row ${i + 1}: missing email`);
        return;
      }

      draft[dept] ||= [];
      const existing = draft[dept].find(u => normalizeEmail(u.email) === email);

      if (existing) {
        preview.push(`UPDATE ${email} (${dept})`);
        existing.name = r.name || existing.name;
        existing.phone = r.phone || existing.phone;
      } else {
        preview.push(`ADD ${email} (${dept})`);
        draft[dept].push({
          name: r.name || "",
          email,
          phone: r.phone || ""
        });
      }
    });

    showModal(
      "Roster Upload Preview (Dry-Run)",
      `
        <div class="small"><b>Changes:</b></div>
        <ul>${preview.map(p => `<li>${escapeHtml(p)}</li>`).join("")}</ul>
        ${warnings.length ? `<div class="small" style="color:#f59e0b"><b>Warnings:</b><ul>${warnings.map(w => `<li>${escapeHtml(w)}</li>`).join("")}</ul></div>` : ""}
        <div class="small subtle">No data has been saved yet.</div>
      `,
      "Apply",
      async () => {
        APP_STATE.roster = draft;
        renderRoster();
        HAS_UNSAVED_CHANGES = true;
        updateSaveState();
        toast("Roster changes applied (not saved).");
        return true;
      },
      "Cancel"
    );

    input.value = "";
  };
}
async function loadNotifyStatus() {
  try {
    const res = await fetch("/api/admin/oncall/notify-status", {
      cache: "no-store"
    });
    if (!res.ok) return;

    APP_STATE.notifyStatus = await res.json();
  } catch (e) {
    console.warn("notify-status load failed", e);
  }
}

/* =========================
 * Audit Log
 * ========================= */

async function loadAudit() {
  const el = byId("audit");
  if (!el) return;

  el.innerHTML = `<div class="subtle">Loading audit log…</div>`;

  const res = await fetchAuth(`/api/admin/audit`, { method: "GET" });
  if (!res.ok) {
    el.innerHTML = `<div class="subtle">Unable to load audit log.</div>`;
    return;
  }

  const data = await res.json();
  const items = data.entries || [];

  if (!items.length) {
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
/* =========================
 * History (Archived Schedules)
 * ========================= */

async function loadHistory() {
  const el = byId("history");
  if (!el) return;

  el.innerHTML = `<div class="subtle">Loading history…</div>`;

  const res = await fetchAuth(`/api/admin/oncall/history`, { method: "GET" });
  if (!res.ok) {
    el.innerHTML = `<div class="subtle">Unable to load history.</div>`;
    return;
  }

  const raw = await res.json();
  const data = normalizeScheduleResponse(raw);
  const entries = data.entries || [];

  if (!entries.length) {
    el.innerHTML = `<div class="subtle">No archived schedules.</div>`;
    return;
  }

  renderHistory(el, entries);
}
function renderHistory(el, entries) {
  el.innerHTML = "";

  const sorted = [...entries].sort(
    (a, b) =>
      isoToDateLocalAssumed(b.startISO) -
      isoToDateLocalAssumed(a.startISO)
  );

  sorted.forEach(e => {
    el.innerHTML += `
      <div class="schedule-card past-week">
        <div class="card-head">
          <div class="card-title">
            ${escapeHtml(formatCSTFromChicagoLocal(e.startISO))}
            →
            ${escapeHtml(formatCSTFromChicagoLocal(e.endISO))}
          </div>
          <div class="small subtle">Archived · Read-only</div>
          <div class="small">Entry ID: ${escapeHtml(String(e.id))}</div>
        </div>

        <div class="entry-grid">
          ${renderDeptBlocks(e.departments, false, e.id, false)}
        </div>
      </div>
    `;
  });
}

/* =========================
 * Timeline UI (Calendar-like)
 * ========================= */

function deptColor(dep) {
  switch (dep) {
    case "enterprise_network": return "rgba(59,130,246,0.35)";
    case "collaboration": return "rgba(34,197,94,0.35)";
    case "system_storage": return "rgba(234,179,8,0.35)";
    default: return "rgba(148,163,184,0.35)";
  }
}

function refreshTimeline() {
  const timeline = byId("timeline");
  if (!timeline) return;
let entries = [];
if (APP_STATE.publicMode) {
  entries = APP_STATE.schedulePublic?.entries || [];
} else if (APP_STATE.draftSchedule?.entries) {
  entries = APP_STATE.draftSchedule.entries;
} else if (APP_STATE.scheduleFull?.entries) {
  entries = APP_STATE.scheduleFull.entries;
}


if (APP_STATE.dept !== "all" && DEPT_KEYS.includes(APP_STATE.dept)) {
  entries = entries.map(e => ({
    ...e,
    departments: e.departments?.[APP_STATE.dept]
      ? { [APP_STATE.dept]: e.departments[APP_STATE.dept] }
      : {}
  }));
}

  renderTimeline(timeline, entries);
}

function renderTimeline(el, entries) {
  el.innerHTML = "";

  if (!entries.length) {
    el.innerHTML = `<div class="subtle">No schedule entries.</div>`;
    return;
  }

  const sorted = [...entries].sort((a, b) => isoToDateLocalAssumed(a.startISO) - isoToDateLocalAssumed(b.startISO));

  sorted.forEach(e => {
    const startLabel = formatWeekLabel(e.startISO);
    const startDisp = formatCSTFromChicagoLocal(e.startISO);
    const endDisp = formatCSTFromChicagoLocal(e.endISO);

    const row = document.createElement("div");
  const past = isPastOnCall(e);
const holidayName = getHolidayName(isoToDateLocalAssumed(e.startISO));

row.className =
  "timeline-row-wrap" +
  (holidayName ? " holiday-week" : "") +
  (past ? " timeline-past" : "");


    row.innerHTML = `
      <div class="timeline-left">
        <div class="week-label">${escapeHtml(startLabel)}</div>
        <div class="small subtle">${escapeHtml(startDisp)} → ${escapeHtml(endDisp)}</div>
      </div>
      <div class="timeline-track">
        ${renderTimelineBlocks(e)}
      </div>
    `;

    el.appendChild(row);
  });
}
/* =========================
 * Auto-refresh (live updates)
 * ========================= */
let CURRENT_ONCALL_TIMER = null;

function startCurrentOnCallAutoRefresh() {
  if (CURRENT_ONCALL_TIMER) return;

  renderCurrentOnCall();

  CURRENT_ONCALL_TIMER = setInterval(() => {
    renderCurrentOnCall();
  }, 60_000); // every minute
}

function stopCurrentOnCallAutoRefresh() {
  if (CURRENT_ONCALL_TIMER) {
    clearInterval(CURRENT_ONCALL_TIMER);
    CURRENT_ONCALL_TIMER = null;
  }
}


function renderTimelineBlocks(entry) {
  const depts = entry.departments || {};
  const keys = Object.keys(depts);

  if (!keys.length) {
    return `<div class="timeline-empty small subtle">No assignments</div>`;
  }

  const width = Math.max(1, Math.floor(100 / keys.length));
  return keys.map((dep, i) => {
    const p = depts[dep] || {};
    const label = DEPT_LABELS[dep] || dep;

   return `
  <div class="timeline-block"
       style="left:${i * width}%;width:${width}%;background:${deptColor(dep)}"
       title="${escapeHtml(label)} — ${escapeHtml(p.name || "")} — ${escapeHtml(p.phone || "")}">
    <div class="timeline-block-title">${escapeHtml(label)}</div>
    <div class="timeline-block-name">${escapeHtml(p.name || "")}</div>
    <div class="small">${escapeHtml(p.phone || "")}</div>
  </div>
    `;
  }).join("");
}

function formatWeekLabel(startISO) {
  const d = isoToDateLocalAssumed(startISO);
  if (isNaN(d)) return "Week";
  return d.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });
}
setInterval(async () => {
  if (APP_STATE.publicMode) return;

  const entries = APP_STATE.scheduleFull?.entries || [];
  const now = Date.now();

  for (const e of entries) {
    if (e.notifiedAt || APP_STATE.notifyStatus[e.id]) continue;

    const t = getAutoNotifyTime(e);
    if (!t) continue;

    if (Math.abs(t.getTime() - now) < 60_000) {
      try {
        await fetchAuth(`/api/admin/oncall/notify`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: "both",
            entryId: e.id,
            auto: true
          })
        });

        APP_STATE.notifyStatus[e.id] = {
  email: { sentAt: new Date().toISOString() },
  sms: [],
  by: "system",
  auto: true
};


        renderScheduleAdmin(byId("schedule"));
      } catch (err) {
        console.error("Auto-notify failed", err);
      }
    }
  }
}, 60_000);

// =========================
// BOOTSTRAP (MODULE SAFE)
// =========================

document.addEventListener("DOMContentLoaded", () => {
  initApp(window.__APP_CTX__ || {}).catch(err => {
    console.error("App init failed:", err);
  });
});



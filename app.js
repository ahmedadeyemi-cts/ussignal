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
// ======================================================

"use strict";

const API_BASE = "https://ussignal.ahmedadeyemi.workers.dev/";

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
 * Worker stores ISO wall time intended as America/Denver.
 * UI displays in fixed CST (UTC-6) year-round and labels "CST".
 * NOTE: Using fixed UTC-6 means this does NOT become CDT in summer (per your requirement).
 */
const SOURCE_TZ = "America/Denver";
const DISPLAY_TZ_FIXED_CST = "Etc/GMT+6";

/* =========================
 * Role-Based Access Control
 * =========================
 * Expect worker to return something like:
 *   { admin: true, role: "admin"|"editor"|"viewer", email: "...", departments: ["enterprise_network", ...] }
 *
 * - viewer: read-only (even if authenticated)
 * - editor: can edit entries (time + person fields) but NOT roster/autogen/save? (you can choose)
 * - admin: full access (save, roster, autogen, audit, notify, export)
 */
const ROLE_ORDER = ["viewer", "editor", "admin"];
function roleAtLeast(role, needed) {
  const a = ROLE_ORDER.indexOf(String(role || "viewer"));
  const b = ROLE_ORDER.indexOf(String(needed || "viewer"));
  return a >= b;
}

/* =========================
 * Global App State
 * ========================= */

let APP_STATE = {
  // identity / permissions
  isAuthenticated: false, // if you’re showing admin.html behind Access
  admin: false,           // legacy flag
  role: "viewer",
  email: "",
  allowedDepartments: [],

  // ui state
  dept: "all",
  scheduleFull: null,
  schedulePublic: null,
  draftSchedule: null,
  editingEntryIds: new Set(),

  // roster state
  roster: null,

  // timeline state
  timelineMode: "weeks" // future expansion
};

/* =========================
 * Init
 * ========================= */

function initApp(ctx = {}) {
  // ctx can be { admin, role, email, departments } (admin page)
  // or { } (public page)
  APP_STATE.admin = !!ctx.admin;
  APP_STATE.isAuthenticated = !!ctx.admin; // for your setup, admin implies authenticated
  APP_STATE.role = ctx.role || (APP_STATE.admin ? "admin" : "viewer");
  APP_STATE.email = ctx.email || "";
  APP_STATE.allowedDepartments = Array.isArray(ctx.departments) ? ctx.departments : [];

  // basic wiring
  const themeBtn = byId("themeToggle");
  if (themeBtn) themeBtn.onclick = toggleTheme;

  const filter = byId("deptFilter");
  if (filter) {
    filter.onchange = () => {
      APP_STATE.dept = filter.value || "all";
      refreshMainView();
    };
  }

  // wire tabs + modal (admin UI typically)
  wireModal();
  wireTabs();

  // Wire buttons (safe even if elements not present)
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

  // Save button: shows diff preview + auto-resolve conflicts
  onClick("saveAllBtn", saveAllChanges);

  // Roster controls
  onClick("rosterAddUserBtn", rosterAddUserModal);
  onClick("rosterReloadBtn", loadRoster);
  onClick("rosterSaveBtn", () => confirmModal(
    "Save Roster",
    "Save roster changes? This impacts auto-generation rotation.",
    saveRoster
  ));

  // Auto-gen controls
  onClick("runAutogenBtn", () => confirmModal(
    "Auto-Generate Schedule",
    "Auto-generate will overwrite the current schedule. Proceed?",
    runAutogen
  ));

  // Audit refresh
  onClick("auditRefreshBtn", loadAudit);

  // Role-based UI guards (hide admin-only panels/buttons)
  applyRBACToUI();

  // Initial load
  refreshMainView();

  // If admin/editor, load roster lazily if roster panel exists
  if (roleAtLeast(APP_STATE.role, "admin")) {
    if (byId("roster")) loadRoster().catch(e => toast(e.message || String(e), 4000));
    // audit can be lazy (loads when tab opened) but safe to do once:
    // loadAudit().catch(()=>{});
  }
}

function refreshMainView() {
  const scheduleDiv = byId("schedule");
  if (!scheduleDiv) return;

  if (APP_STATE.admin || roleAtLeast(APP_STATE.role, "editor")) {
    loadScheduleAdmin(scheduleDiv).catch(e => toast(e.message || String(e), 4000));
  } else {
    loadSchedulePublic(scheduleDiv).catch(e => toast(e.message || String(e), 4000));
  }
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

function toggleTheme() {
  document.body.classList.toggle("dark");
  document.body.classList.toggle("light");
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

  modal.onclick = (e) => {
    if (e.target === modal) hideModal();
  };
}

function showModal(title, bodyHtml, okText = "OK", onOk = null, cancelText = "Cancel") {
  const modal = byId("modal");
  if (!modal) return;

  const titleEl = byId("modalTitle");
  const bodyEl = byId("modalBody");
  const okBtn = byId("modalOk");
  const cancelBtn = byId("modalCancel");

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
  modal.setAttribute("aria-hidden", "false");
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
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
}

/* =========================
 * Tabs (Admin)
 * ========================= */

function wireTabs() {
  const tabs = Array.from(document.querySelectorAll(".tab"));
  if (!tabs.length) return;

  tabs.forEach(tab => {
    tab.onclick = () => {
      tabs.forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));

      tab.classList.add("active");
      const target = tab.dataset.tab;
      const panel = byId(target);
      if (panel) panel.classList.add("active");

      // Lazy-load
      if (target === "auditTab") loadAudit().catch(() => {});
      if (target === "timelineTab") refreshTimeline().catch(() => {});
    };
  });
}

/* =========================
 * RBAC UI Guards
 * ========================= */

function applyRBACToUI() {
  // If not editor+, hide editing controls if they exist
  const canEdit = roleAtLeast(APP_STATE.role, "editor");
  const isAdmin = roleAtLeast(APP_STATE.role, "admin");

  // Buttons
  setHidden("saveAllBtn", !canEdit);
  setHidden("revertBtn", !isAdmin);
  setHidden("notifyBtn", !isAdmin);
  setHidden("exportBtn", !isAdmin);
  // ICS export is useful for everyone; keep visible if exists
  // setHidden("icsBtn", false);

  // Tabs/panels
  setHidden("rosterTabBtn", !isAdmin); // if your tab button has this id
  setHidden("autogenTabBtn", !isAdmin);
  setHidden("auditTabBtn", !isAdmin);

  // Panels themselves (if you prefer hard-hide)
  setHidden("rosterTab", !isAdmin);
  setHidden("autogenTab", !isAdmin);
  setHidden("auditTab", !isAdmin);
}

function setHidden(id, hidden) {
  const el = byId(id);
  if (!el) return;
  el.style.display = hidden ? "none" : "";
}

/* =========================
 * Time Utilities
 * =========================
 * Convert: interpret "YYYY-MM-DDTHH:mm:ss" as America/Denver wall time,
 * then render in fixed CST (UTC-6) and append "CST".
 */

function parseLocalIsoParts(localISO) {
  const m = String(localISO || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return {
    y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]),
    h: Number(m[4]), mi: Number(m[5]), s: Number(m[6])
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

  // initial guess: treat wall time as UTC
  let guessMs = Date.UTC(want.y, want.mo - 1, want.d, want.h, want.mi, want.s);

  // Two-pass correction handles DST edges robustly
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
  return `${s} CST`;
}

// Helpers for Friday-only snapping + input formatting
function isFriday(d) { return d.getDay() === 5; }

// nearest Friday forward (including same day)
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

// For validation we treat ISO string as local-like string. Safer to parse components.
function isoToDateLocalAssumed(iso) {
  // Treat "YYYY-MM-DDTHH:mm:ss" as local time string (no timezone shift)
  const parts = parseLocalIsoParts(iso);
  if (!parts) return new Date(NaN);
  return new Date(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi, parts.s, 0);
}

/* =========================
 * Validation
 * =========================
 * Window: Fri 4:00 PM → Fri 7:00 AM, 7 days apart.
 * Note: This enforces fixed wall-clock times as entered in ISO strings.
 */

function validateOnCallWindow(startISO, endISO) {
  const s = isoToDateLocalAssumed(startISO);
  const e = isoToDateLocalAssumed(endISO);

  if (isNaN(s) || isNaN(e)) return "Invalid date/time format.";
  if (s >= e) return "End must be after start.";
  if (s.getDay() !== 5) return "Start must be on a Friday.";
  if (e.getDay() !== 5) return "End must be on a Friday.";
  if (s.getHours() !== 16 || s.getMinutes() !== 0) return "Start time must be 4:00 PM CST.";
  if (e.getHours() !== 7 || e.getMinutes() !== 0) return "End time must be 7:00 AM CST.";

  const diffDays = (e - s) / 86400000;
  if (diffDays < 6.99 || diffDays > 7.01) return "On-call window must be exactly 7 days.";

  return null;
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

/**
 * Auto-resolve conflicts by shifting the CURRENT entry forward to start at previous end,
 * then re-applying Fri times. Since your window must always be Fri 4 PM → Fri 7 AM,
 * we shift by whole weeks until no overlap.
 */
function autoResolveConflicts(entries) {
  const clone = deepClone(entries);

  // Sort by start time (local-assumed)
  clone.sort((a, b) => isoToDateLocalAssumed(a.startISO) - isoToDateLocalAssumed(b.startISO));

  const changes = [];

  for (let i = 1; i < clone.length; i++) {
    const prev = clone[i - 1];
    const cur = clone[i];

    let prevEnd = isoToDateLocalAssumed(prev.endISO);
    let curStart = isoToDateLocalAssumed(cur.startISO);

    if (curStart < prevEnd) {
      const originalStart = cur.startISO;
      const originalEnd = cur.endISO;

      // Move cur forward by whole weeks until it starts >= prevEnd
      // Step 1: pick a Friday on/after prevEnd
      let newStart = snapToFridayForward(prevEnd);
      // enforce Fri 4 PM
      newStart.setHours(16, 0, 0, 0);

      // If that newStart is still < prevEnd (e.g., prevEnd Fri 7AM, newStart Fri 4PM same day is > so ok)
      // but keep while for safety
      while (newStart < prevEnd) {
        newStart.setDate(newStart.getDate() + 7);
      }

      // newEnd = next Friday 7 AM
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

      // Now continue; ensure chain resolution works
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

  // Optional: detect deletions (if your UI ever supports removing entries)
  for (const [id] of origById.entries()) {
    if (!draftById.has(id)) diffs.push(`Entry ${id}: removed`);
  }

  return diffs;
}

/* =========================
 * Public Schedule (Read-only)
 * ========================= */

async function loadSchedulePublic(el) {
  const dept = String(APP_STATE.dept || "all").toLowerCase();
  const res = await fetch(`${API_BASE}/oncall?department=${encodeURIComponent(dept)}`);
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  APP_STATE.schedulePublic = data;

  renderScheduleReadOnly(el, data.entries || []);
  refreshTimeline(); // if timeline panel exists
}

function renderScheduleReadOnly(el, entries) {
  el.innerHTML = "";

  entries.forEach(e => {
    el.innerHTML += `
      <div class="schedule-card">
        <div class="card-head">
          <div class="card-title">
            ${escapeHtml(formatCSTFromDenverLocal(e.startISO))} → ${escapeHtml(formatCSTFromDenverLocal(e.endISO))}
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
            <label>Name</label>
            <input data-entry="${escapeHtml(entryId)}" data-dept="${escapeHtml(dep)}" data-field="name"
                   value="${escapeHtml(p.name || "")}" />
          </div>

          <div class="inline-row">
            <label>Email</label>
            <input data-entry="${escapeHtml(entryId)}" data-dept="${escapeHtml(dep)}" data-field="email"
                   value="${escapeHtml(p.email || "")}" />
          </div>

          <div class="inline-row">
            <label>Phone</label>
            <input data-entry="${escapeHtml(entryId)}" data-dept="${escapeHtml(dep)}" data-field="phone"
                   value="${escapeHtml(p.phone || "")}" />
          </div>
        </div>
      `;
    })
    .join("");
}

/* =========================
 * Admin Schedule (Editor/Admin)
 * ========================= */

async function loadScheduleAdmin(el) {
  // Admin endpoint should enforce auth and role server-side as well.
  const res = await fetch(`${API_BASE}/admin/oncall`);
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();

  APP_STATE.scheduleFull = data;
  APP_STATE.draftSchedule = deepClone(data);
  APP_STATE.editingEntryIds.clear();

  renderScheduleAdmin(el);
  refreshTimeline();
}

function renderScheduleAdmin(el) {
  const canEdit = roleAtLeast(APP_STATE.role, "editor");
  const isAdmin = roleAtLeast(APP_STATE.role, "admin");

  el.innerHTML = "";

  const deptFilter = String(APP_STATE.dept || "all").toLowerCase();

  // For editors: optionally restrict to allowed depts
  const restrictToAllowedDepts = roleAtLeast(APP_STATE.role, "admin") ? false : true;

  const entries = (APP_STATE.draftSchedule?.entries || []).map(e => {
    if (deptFilter === "all") return e;

    const only = e.departments?.[deptFilter];
    return { ...e, departments: only ? { [deptFilter]: only } : {} };
  });

  entries.forEach(e => {
    const editing = APP_STATE.editingEntryIds.has(String(e.id));

    const startDisplay = formatCSTFromDenverLocal(e.startISO);
    const endDisplay = formatCSTFromDenverLocal(e.endISO);

    const startInput = (e.startISO || "").slice(0, 16);
    const endInput = (e.endISO || "").slice(0, 16);

    el.innerHTML += `
      <div class="schedule-card ${e._autoResolved ? "resolved" : ""}">
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
                    <label>End (Fri only)</label>
                    <input type="datetime-local"
                           data-time="end"
                           data-id="${escapeHtml(String(e.id))}"
                           value="${escapeHtml(endInput)}"
                           step="60" />
                  </div>
                  <div class="small subtle">CST · Fri 4:00 PM → Fri 7:00 AM</div>
                `
                : `
                  <div class="card-title">
                    ${escapeHtml(startDisplay)} → ${escapeHtml(endDisplay)}
                  </div>
                  <div class="small subtle">CST</div>
                `
            }
            <div class="small">Entry ID: ${escapeHtml(String(e.id))}</div>
          </div>

          <div class="card-actions">
            ${isAdmin ? `<button class="ghost" data-action="notifyEntry" data-id="${escapeHtml(String(e.id))}">Notify</button>` : ``}
            ${
              canEdit
                ? `<button class="primary" data-action="${editing ? "done" : "edit"}" data-id="${escapeHtml(String(e.id))}">
                    ${editing ? "Done" : "Edit"}
                  </button>`
                : ``
            }
          </div>
        </div>

        <div class="entry-grid">
          ${renderDeptBlocks(e.departments, editing && canEdit, e.id, restrictToAllowedDepts)}
        </div>
      </div>
    `;
  });

  // Wire actions
  el.querySelectorAll("button[data-action]").forEach(btn => {
    btn.onclick = async () => {
      const action = btn.getAttribute("data-action");
      const id = btn.getAttribute("data-id");

      if (action === "edit") {
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
        confirmModal(
          "Notify This Week",
          "Send start and end notifications for this entry?",
          async () => {
            const res = await fetch(`${API_BASE}/admin/oncall/notify`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ mode: "both", entryId: id })
            });
            if (!res.ok) throw new Error(await res.text());
            toast("Notifications sent.");
          }
        );
        return;
      }
    };
  });

  // Wire time editors (Friday-only date pickers behavior)
  el.querySelectorAll("input[data-time]").forEach(inp => {
    inp.onchange = () => {
      const id = inp.getAttribute("data-id");
      const which = inp.getAttribute("data-time"); // start/end

      const entry = (APP_STATE.draftSchedule?.entries || []).find(x => String(x.id) === String(id));
      if (!entry) return;

      // Parse input as local date
      let d = new Date(inp.value);
      if (isNaN(d)) return;

      // Snap to Friday forward
      if (!isFriday(d)) d = snapToFridayForward(d);

      // Enforce fixed times
      if (which === "start") d.setHours(16, 0, 0, 0);
      else d.setHours(7, 0, 0, 0);

      const fixed = toLocalInput(d);
      inp.value = fixed; // keep UI snapped

      // Update entry ISO (seconds)
      const newISO = fixed + ":00";
      if (which === "start") entry.startISO = newISO;
      else entry.endISO = newISO;

      // Optional immediate validation hint
      const err = validateOnCallWindow(entry.startISO, entry.endISO);
      if (err) toast(`Entry ${entry.id}: ${err}`, 3200);

      refreshTimeline();
    };
  });

  // Wire inline dept inputs
  el.querySelectorAll("input[data-entry]").forEach(inp => {
    inp.oninput = () => {
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

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/* =========================
 * Save / Notify / Export / ICS
 * ========================= */

async function saveAllChanges() {
  const canEdit = roleAtLeast(APP_STATE.role, "editor");
  const isAdmin = roleAtLeast(APP_STATE.role, "admin");

  if (!canEdit) {
    toast("You do not have permission to save changes.");
    return;
  }

  if (!APP_STATE.scheduleFull || !APP_STATE.draftSchedule) {
    toast("Schedule not loaded.");
    return;
  }

  const draft = APP_STATE.draftSchedule;

  // 1) Validate windows
  for (const e of (draft.entries || [])) {
    const err = validateOnCallWindow(e.startISO, e.endISO);
    if (err) {
      toast(`Entry ${e.id}: ${err}`, 4500);
      return;
    }
  }

  // 2) Overlap detection
  const overlaps = detectOverlaps(draft.entries || []);
  if (overlaps.length) {
    // Auto-resolution only for admins (safer); editors can be blocked or allowed—your choice.
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

    // Preview auto-resolve changes
    const changesHtml = changes.length
      ? `<ul>${changes.map(c => `
          <li>
            Entry ${escapeHtml(String(c.id))} shifted:<br/>
            <span class="small subtle">
              ${escapeHtml(formatCSTFromDenverLocal(c.fromStart))} → ${escapeHtml(formatCSTFromDenverLocal(c.fromEnd))}
              <br/>
              to
              <br/>
              ${escapeHtml(formatCSTFromDenverLocal(c.toStart))} → ${escapeHtml(formatCSTFromDenverLocal(c.toEnd))}
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
        // apply resolved schedule
        draft.entries = resolvedEntries;
        refreshTimeline();

        // now show diff + save confirmation
        await showDiffAndSave();
        return true;
      },
      "Cancel"
    );

    return; // stop here; save continues via modal
  }

  // No overlaps -> go to diff preview + save
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
      const res = await fetch(`${API_BASE}/admin/oncall/save`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schedule: draft })
      });
      if (!res.ok) throw new Error(await res.text());

      toast("Schedule saved.");
      // reload authoritative copy
      await loadScheduleAdmin(byId("schedule"));
      return true;
    },
    "Cancel"
  );
}

async function exportExcel() {
  // keep admin-only in UI guard, but safe anyway
  const dept = String(APP_STATE.dept || "all");
  window.location = `${API_BASE}/admin/oncall/export?department=${encodeURIComponent(dept)}`;
}

async function exportICS() {
  // allow both public and admin: choose endpoint if you have both
  // Recommended:
  //  - Public: /oncall/ics?department=all (no auth)
  //  - Admin:  /admin/oncall/ics?department=all (auth)
  const dept = String(APP_STATE.dept || "all").toLowerCase();
  const endpoint = roleAtLeast(APP_STATE.role, "editor")
    ? `${API_BASE}/admin/oncall/ics?department=${encodeURIComponent(dept)}`
    : `${API_BASE}/oncall/ics?department=${encodeURIComponent(dept)}`;

  window.location = endpoint;
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
 * Roster Management
 * ========================= */

async function loadRoster() {
  const res = await fetch(`${API_BASE}/admin/roster`);
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

  // wire inline edits
  el.querySelectorAll("input[data-roster]").forEach(inp => {
    inp.oninput = () => {
      const dept = inp.getAttribute("data-dept");
      const idx = Number(inp.getAttribute("data-idx"));
      const field = inp.getAttribute("data-field");
      const roster2 = APP_STATE.roster || {};
      if (!roster2[dept] || !roster2[dept][idx]) return;
      roster2[dept][idx][field] = inp.value;
    };
  });

  // wire remove
  el.querySelectorAll("button[data-roster-remove]").forEach(btn => {
    btn.onclick = () => {
      const dept = btn.getAttribute("data-dept");
      const idx = Number(btn.getAttribute("data-idx"));
      if (!APP_STATE.roster || !APP_STATE.roster[dept]) return;

      showModal(
        "Remove User",
        `<div>Remove this user from <b>${escapeHtml(DEPT_LABELS[dept] || dept)}</b> roster?</div>`,
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

  const res = await fetch(`${API_BASE}/admin/roster/save`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roster: APP_STATE.roster })
  });

  if (!res.ok) throw new Error(await res.text());
  toast("Roster saved.");
  await loadRoster();
}

/* =========================
 * Audit Log
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
 * Timeline UI (Calendar-like)
 * =========================
 * Uses a simple week-by-week track. Each entry is one week.
 * For each week, show dept assignments as colored blocks.
 */

function deptColor(dep) {
  // stable distinct colors without needing CSS variables
  switch (dep) {
    case "enterprise_network": return "rgba(59,130,246,0.35)"; // blue
    case "collaboration": return "rgba(34,197,94,0.35)";       // green
    case "system_storage": return "rgba(234,179,8,0.35)";       // amber
    default: return "rgba(148,163,184,0.35)";                   // slate
  }
}

function refreshTimeline() {
  const timeline = byId("timeline");
  if (!timeline) return;

  // Prefer draft schedule (admin/editor) else public
  const entries =
    (APP_STATE.draftSchedule && APP_STATE.draftSchedule.entries) ||
    (APP_STATE.schedulePublic && APP_STATE.schedulePublic.entries) ||
    [];

  renderTimeline(timeline, entries);
}

function renderTimeline(el, entries) {
  el.innerHTML = "";

  if (!entries.length) {
    el.innerHTML = `<div class="subtle">No schedule entries.</div>`;
    return;
  }

  // Sort by start
  const sorted = [...entries].sort((a, b) => isoToDateLocalAssumed(a.startISO) - isoToDateLocalAssumed(b.startISO));

  sorted.forEach(e => {
    const startLabel = formatWeekLabel(e.startISO);
    const startDisp = formatCSTFromDenverLocal(e.startISO);
    const endDisp = formatCSTFromDenverLocal(e.endISO);

    const row = document.createElement("div");
    row.className = "timeline-row-wrap";

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

function renderTimelineBlocks(entry) {
  const depts = entry.departments || {};
  const keys = Object.keys(depts);

  if (!keys.length) {
    return `<div class="timeline-empty small subtle">No assignments</div>`;
  }

  // Side-by-side blocks for departments
  const width = Math.max(1, Math.floor(100 / keys.length));
  return keys.map((dep, i) => {
    const p = depts[dep] || {};
    const label = DEPT_LABELS[dep] || dep;

    return `
      <div class="timeline-block"
           style="left:${i * width}%;width:${width}%;background:${deptColor(dep)}"
           title="${escapeHtml(label)} — ${escapeHtml(p.name || "")}">
        <div class="timeline-block-title">${escapeHtml(label)}</div>
        <div class="timeline-block-name">${escapeHtml(p.name || "")}</div>
      </div>
    `;
  }).join("");
}

function formatWeekLabel(startISO) {
  const d = isoToDateLocalAssumed(startISO);
  if (isNaN(d)) return "Week";
  return d.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });
}

/* =========================
 * Optional: expose init globally
 * ========================= */
window.initApp = initApp;
window.exportICS = exportICS;
window.refreshTimeline = refreshTimeline;

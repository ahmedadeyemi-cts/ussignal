// ======================================================
// app.js — FULL, COMPREHENSIVE, PRODUCTION VERSION
// ======================================================

const API_BASE = "/api";

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
 * ========================= */

// Worker stores ISO wall time intended as America/Denver
// UI displays in fixed CST (UTC-6) year-round
const SOURCE_TZ = "America/Denver";
const DISPLAY_TZ_FIXED_CST = "Etc/GMT+6";

/* =========================
 * Global App State
 * ========================= */

let APP_STATE = {
  admin: false,
  dept: "all",
  scheduleFull: null,
  schedulePublic: null,
  draftSchedule: null,
  editingEntryIds: new Set()
};

/* =========================
 * App Init
 * ========================= */

function initApp({ admin }) {
  APP_STATE.admin = !!admin;

  const filter = byId("deptFilter");
  const scheduleDiv = byId("schedule");
  const themeBtn = byId("themeToggle");

  if (themeBtn) themeBtn.onclick = toggleTheme;

  if (filter) {
    filter.onchange = () => {
      APP_STATE.dept = filter.value;
      APP_STATE.admin
        ? renderScheduleAdmin(scheduleDiv)
        : loadSchedulePublic(scheduleDiv);
    };
  }

  if (APP_STATE.admin) {
    wireTabs();
    wireModal();

    byId("exportBtn").onclick = exportExcelAdmin;
    byId("notifyBtn").onclick = () =>
      confirmModal("Send Notifications",
        "Send start and end notifications now?",
        sendNotify
      );

    byId("saveAllBtn").onclick = saveAllChanges;
    byId("revertBtn").onclick = () =>
      confirmModal("Revert Schedule",
        "Revert to last saved schedule?",
        revertSchedule
      );

    byId("rosterAddUserBtn").onclick = rosterAddUserPrompt;
    byId("rosterSaveBtn").onclick = () =>
      confirmModal("Save Roster",
        "Save roster changes?",
        saveRoster
      );
    byId("rosterReloadBtn").onclick = loadRoster;

    byId("runAutogenBtn").onclick = () =>
      confirmModal("Auto-Generate",
        "Overwrite current schedule?",
        runAutogen
      );

    byId("auditRefreshBtn").onclick = loadAudit;

    loadScheduleAdmin(scheduleDiv);
    loadRoster();
  } else {
    loadSchedulePublic(scheduleDiv);
  }
}

/* =========================
 * Generic Helpers
 * ========================= */

function byId(id) {
  return document.getElementById(id);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" }[c])
  );
}

function toast(msg, ms = 2500) {
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

/* =========================
 * Modal Helpers
 * ========================= */

function wireModal() {
  const modal = byId("modal");
  if (!modal) return;
  byId("modalClose").onclick = hideModal;
  byId("modalCancel").onclick = hideModal;
  modal.onclick = e => e.target === modal && hideModal();
}

function confirmModal(title, body, onOk) {
  byId("modalTitle").textContent = title;
  byId("modalBody").innerHTML = body;
  byId("modalOk").onclick = async () => {
    hideModal();
    try { await onOk(); }
    catch (e) { toast(e.message || String(e), 4000); }
  };
  byId("modal").classList.remove("hidden");
}

function hideModal() {
  byId("modal").classList.add("hidden");
}

/* =========================
 * Tabs (Admin)
 * ========================= */

function wireTabs() {
  document.querySelectorAll(".tab").forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
      tab.classList.add("active");
      byId(tab.dataset.tab).classList.add("active");
      if (tab.dataset.tab === "auditTab") loadAudit();
    };
  });
}

/* =========================
 * Time Utilities
 * ========================= */

function formatCSTFromDenverLocal(localISO) {
  const d = new Date(localISO + "Z");
  return (
    d.toLocaleString("en-US", {
      timeZone: DISPLAY_TZ_FIXED_CST,
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true
    }) + " CST"
  );
}

function isFriday(d) { return d.getDay() === 5; }

function snapToFriday(d) {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + ((5 - copy.getDay() + 7) % 7));
  return copy;
}

function toLocalInput(d) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* =========================
 * Validation & Guards
 * ========================= */

function validateOnCallWindow(startISO, endISO) {
  const s = new Date(startISO);
  const e = new Date(endISO);
  if (!isFriday(s) || !isFriday(e))
    return "Start and end must be Fridays.";
  if (s.getHours() !== 16 || e.getHours() !== 7)
    return "Must be Fri 4:00 PM → Fri 7:00 AM CST.";
  if ((e - s) / 86400000 !== 7)
    return "On-call window must be exactly 7 days.";
  return null;
}

function detectOverlaps(entries) {
  const sorted = [...entries].sort(
    (a,b) => new Date(a.startISO) - new Date(b.startISO)
  );
  for (let i=1;i<sorted.length;i++) {
    if (new Date(sorted[i].startISO) < new Date(sorted[i-1].endISO)) {
      return `Entry ${sorted[i].id} overlaps entry ${sorted[i-1].id}`;
    }
  }
  return null;
}

function diffSchedules(original, draft) {
  const diffs = [];
  original.entries.forEach((o,i) => {
    const d = draft.entries[i];
    if (!d) return;
    if (o.startISO !== d.startISO || o.endISO !== d.endISO)
      diffs.push(`Entry ${o.id}: time changed`);
    Object.keys(o.departments||{}).forEach(dep => {
      ["name","email","phone"].forEach(f => {
        if ((o.departments[dep][f]||"") !== (d.departments[dep][f]||""))
          diffs.push(`Entry ${o.id} (${DEPT_LABELS[dep]}): ${f} changed`);
      });
    });
  });
  return diffs;
}

/* =========================
 * Public Schedule (READ-ONLY)
 * ========================= */

async function loadSchedulePublic(el) {
  const dept = APP_STATE.dept.toLowerCase();
  const res = await fetch(`${API_BASE}/oncall?department=${dept}`);
  const data = await res.json();
  renderScheduleReadOnly(el, data.entries || []);
}

function renderScheduleReadOnly(el, entries) {
  el.innerHTML = "";
  entries.forEach(e => {
    el.innerHTML += `
      <div class="schedule-card">
        <div class="card-title">
          ${formatCSTFromDenverLocal(e.startISO)} →
          ${formatCSTFromDenverLocal(e.endISO)}
        </div>
        <div class="entry-grid">
          ${renderDeptBlocks(e.departments,false,e.id)}
        </div>
      </div>`;
  });
}

/* =========================
 * Shared Dept Renderer
 * ========================= */

function renderDeptBlocks(depts, editable, entryId) {
  return Object.keys(depts||{}).map(k => {
    const p = depts[k];
    return editable
      ? `
        <div class="entry">
          <h4>${DEPT_LABELS[k]}</h4>
          <input data-entry="${entryId}" data-dept="${k}" data-field="name" value="${escapeHtml(p.name||"")}"/>
          <input data-entry="${entryId}" data-dept="${k}" data-field="email" value="${escapeHtml(p.email||"")}"/>
          <input data-entry="${entryId}" data-dept="${k}" data-field="phone" value="${escapeHtml(p.phone||"")}"/>
        </div>`
      : `
        <div class="entry">
          <h4>${DEPT_LABELS[k]}</h4>
          <b>${escapeHtml(p.name||"")}</b>
          <div>${escapeHtml(p.email||"")}</div>
          <div class="small">${escapeHtml(p.phone||"")}</div>
        </div>`;
  }).join("");
}

/* =========================
 * Admin Schedule
 * ========================= */

async function loadScheduleAdmin(el) {
  const res = await fetch(`${API_BASE}/admin/oncall`);
  const data = await res.json();
  APP_STATE.scheduleFull = data;
  APP_STATE.draftSchedule = JSON.parse(JSON.stringify(data));
  APP_STATE.editingEntryIds.clear();
  renderScheduleAdmin(el);
}

function renderScheduleAdmin(el) {
  el.innerHTML = "";
  APP_STATE.draftSchedule.entries.forEach(e => {
    const editing = APP_STATE.editingEntryIds.has(e.id);
    el.innerHTML += `
      <div class="schedule-card">
        <div class="card-head">
          ${
            editing
              ? `
              <input type="datetime-local" value="${e.startISO.slice(0,16)}" data-time="start" data-id="${e.id}"/>
              <input type="datetime-local" value="${e.endISO.slice(0,16)}" data-time="end" data-id="${e.id}"/>
              <div class="small">Fri 4 PM → Fri 7 AM CST</div>`
              : `<div class="card-title">
                  ${formatCSTFromDenverLocal(e.startISO)} →
                  ${formatCSTFromDenverLocal(e.endISO)}
                </div>`
          }
          <button data-id="${e.id}" class="primary">${editing?"Done":"Edit"}</button>
        </div>
        <div class="entry-grid">
          ${renderDeptBlocks(e.departments,editing,e.id)}
        </div>
      </div>`;
  });

  el.querySelectorAll("button[data-id]").forEach(b=>{
    b.onclick=()=>{
      APP_STATE.editingEntryIds.has(b.dataset.id)
        ? APP_STATE.editingEntryIds.delete(b.dataset.id)
        : APP_STATE.editingEntryIds.add(b.dataset.id);
      renderScheduleAdmin(el);
    };
  });

  el.querySelectorAll("input[data-time]").forEach(inp=>{
    inp.onchange=()=>{
      const entry=APP_STATE.draftSchedule.entries.find(e=>String(e.id)===inp.dataset.id);
      let d=new Date(inp.value);
      if(!isFriday(d)) d=snapToFriday(d);
      if(inp.dataset.time==="start") d.setHours(16,0,0,0);
      else d.setHours(7,0,0,0);
      entry[inp.dataset.time+"ISO"]=toLocalInput(d)+":00";
      inp.value=toLocalInput(d);
    };
  });

  el.querySelectorAll("input[data-entry]").forEach(inp=>{
    inp.oninput=()=>{
      const e=APP_STATE.draftSchedule.entries.find(x=>String(x.id)===inp.dataset.entry);
      e.departments[inp.dataset.dept][inp.dataset.field]=inp.value;
    };
  });
}

/* =========================
 * Save / Notify / Export
 * ========================= */

async function saveAllChanges() {
  const overlapErr = detectOverlaps(APP_STATE.draftSchedule.entries);
  if (overlapErr) return toast(overlapErr);

  for (const e of APP_STATE.draftSchedule.entries) {
    const err = validateOnCallWindow(e.startISO, e.endISO);
    if (err) return toast(`Entry ${e.id}: ${err}`);
  }

  const diffs = diffSchedules(APP_STATE.scheduleFull, APP_STATE.draftSchedule);
  if (!diffs.length) return toast("No changes detected.");

  confirmModal("Confirm Save",
    `<ul>${diffs.map(d=>`<li>${escapeHtml(d)}</li>`).join("")}</ul>`,
    async()=>{
      await fetch(`${API_BASE}/admin/oncall/save`,{
        method:"POST",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({schedule:APP_STATE.draftSchedule})
      });
      toast("Schedule saved.");
      loadScheduleAdmin(byId("schedule"));
    }
  );
}

async function exportExcelAdmin() {
  window.location = `${API_BASE}/admin/oncall/export?department=${APP_STATE.dept}`;
}

async function sendNotify() {
  await fetch(`${API_BASE}/admin/oncall/notify`,{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({mode:"both"})
  });
  toast("Notifications sent.");
}

async function revertSchedule() {
  await fetch(`${API_BASE}/admin/oncall/revert`,{method:"POST"});
  toast("Reverted.");
  loadScheduleAdmin(byId("schedule"));
}

/* =========================
 * Roster Management
 * ========================= */

let ROSTER_STATE=null;

async function loadRoster() {
  const res=await fetch(`${API_BASE}/admin/roster`);
  ROSTER_STATE=await res.json();
  renderRoster();
}

function renderRoster() {
  const el=byId("roster");
  if(!el) return;
  el.innerHTML=DEPT_KEYS.map(k=>renderRosterDept(k)).join("");
}

function renderRosterDept(k) {
  return `
    <div class="roster-card">
      <h3>${DEPT_LABELS[k]}</h3>
      ${(ROSTER_STATE[k]||[]).map((u,i)=>`
        <input data-rdept="${k}" data-idx="${i}" data-field="name" value="${escapeHtml(u.name||"")}"/>
        <input data-rdept="${k}" data-idx="${i}" data-field="email" value="${escapeHtml(u.email||"")}"/>
        <input data-rdept="${k}" data-idx="${i}" data-field="phone" value="${escapeHtml(u.phone||"")}"/>
      `).join("")}
    </div>`;
}

function rosterAddUserPrompt() {
  confirmModal("Add User",
    `<input id="nuName" placeholder="Name"/>
     <input id="nuEmail" placeholder="Email"/>
     <select id="nuDept">${DEPT_KEYS.map(k=>`<option value="${k}">${DEPT_LABELS[k]}</option>`)}</select>`,
    ()=>{
      const k=byId("nuDept").value;
      ROSTER_STATE[k].push({name:byId("nuName").value,email:byId("nuEmail").value});
      renderRoster();
    }
  );
}

async function saveRoster() {
  await fetch(`${API_BASE}/admin/roster/save`,{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({roster:ROSTER_STATE})
  });
  toast("Roster saved.");
}

/* =========================
 * Audit Log
 * ========================= */

async function loadAudit() {
  const el=byId("audit");
  if(!el) return;
  const res=await fetch(`${API_BASE}/admin/audit`);
  const data=await res.json();
  el.innerHTML=(data.entries||[]).map(a=>`
    <div class="audit-item">
      <span class="badge">${escapeHtml(a.action||"")}</span>
      <div>${escapeHtml(a.actor||"")}</div>
      <div class="small">${escapeHtml(a.note||"")}</div>
    </div>`).join("");
}

// ======================================================
// public.js — PUBLIC READ-ONLY ON-CALL VIEW (ROBUST)
// - Handles KV/string wrappers and multiple payload shapes
// - Renders Timeline / Current / Full Schedule
// - Today highlight, click-to-call, skeleton loaders, last updated
// - Auto-refresh(s)
// ======================================================

"use strict";

console.log("[public] public.js loaded");

const REFRESH_MS = 60_000;
const ENDPOINTS = {
  oncall: "/api/oncall",
  current: "/api/oncall/current",
  psCustomers: "/api/ps-customers"
};

const DEPT_LABELS = {
  enterprise_network: "Enterprise Network",
  collaboration: "Collaboration",
  system_storage: "System & Storage"
};

let STATE = {
  dept: "all",
  entries: [],
  updatedAt: null,
  current: null,
  psCustomers: [],
  loading: true
};
/* =========================
 * RENDER / FETCH HASHES
 * ========================= */
let LAST_HASH = null;
let LAST_TIMELINE_HASH = null;

document.addEventListener("DOMContentLoaded", () => {
  wireUI();
  showSkeletons();
  loadAll().catch(err => console.error("[public] init loadAll failed:", err));
  setInterval(() => loadAll().catch(()=>{}), REFRESH_MS);
});

function $(id) { return document.getElementById(id); }

function wireUI() {
  const filter = $("deptFilter");
  if (filter) {
    filter.onchange = () => {
      STATE.dept = filter.value || "all";
      renderAll();
    };
  }

  const themeBtn = $("themeToggle");
  if (themeBtn) {
    themeBtn.onclick = () => {
      document.body.classList.toggle("dark");
      document.body.classList.toggle("light");
    };
  }
}

async function loadAll() {
  const before = LAST_HASH;

  await Promise.allSettled([
    loadSchedule(),
    loadCurrent(),
    loadPsCustomers()
  ]);

  STATE.loading = false;

  if (before !== LAST_HASH) {
    renderAll();
  } else {
    renderLastUpdated();
    renderCurrent();
    renderPsCustomers(); // ✅ ADD THIS LINE
  }
}
function isArchived(entry) {
  const end = parseLocalISO(entry.endISO);
  return !isNaN(end) && end < new Date();
}

function isCurrentWeek(entry) {
  const now = new Date();
  const s = parseLocalISO(entry.startISO);
  const e = parseLocalISO(entry.endISO);
  return now >= s && now <= e;
}

/* =========================
 * Fetch
 * ========================= */

async function loadSchedule() {
  const res = await fetch(ENDPOINTS.oncall, { cache: "no-store" });
  if (!res.ok) throw new Error(`oncall fetch failed: ${res.status}`);
  const raw = await res.json();

  // Normalize (matches your app.js logic style)
  const normalized = normalizeScheduleResponse(raw);

  const nextEntries = normalized.entries || [];
  const nextHash = hashEntries(nextEntries);

if (LAST_HASH === nextHash) {
  // No structural change, only update timestamp
  STATE.updatedAt = extractUpdatedAt(raw) || STATE.updatedAt;
  console.log("[public] schedule unchanged, skipping re-render");
  return;
}

LAST_HASH = nextHash;
STATE.entries = nextEntries;
STATE.updatedAt = extractUpdatedAt(raw) || new Date().toISOString();

console.log("[public] schedule changed, entries:", STATE.entries.length);

}

async function loadCurrent() {
  const res = await fetch(ENDPOINTS.current, { cache: "no-store" });
  if (!res.ok) return;

  const raw = await res.json();

  // /api/oncall/current may be:
  //  - { startISO, endISO, departments } OR
  //  - { entry: {...} } OR
  //  - { current: {...} }
  let entry = raw?.entry || raw?.current || raw;

  // Some implementations return null/empty
  if (!entry || !entry.startISO) {
    STATE.current = null;
    return;
  }

  // Ensure departments object exists
  entry.departments = entry.departments || {};
  STATE.current = entry;

  console.log("[public] current loaded:", !!STATE.current);
}
/* =========================
 * OneAssist
 * ========================= */
async function loadPsCustomers() {
  const res = await fetch(ENDPOINTS.psCustomers, { cache: "no-store" });
  if (!res.ok) {
    console.warn("[public] ps-customers fetch failed");
    STATE.psCustomers = [];
    return;
  }

  const raw = await res.json();

  // Normalize defensively
  let customers = [];

  if (Array.isArray(raw)) {
    customers = raw;
  } else if (Array.isArray(raw.customers)) {
    customers = raw.customers;
  }

  STATE.psCustomers = customers;

  console.log("[public] ps customers loaded:", customers.length);
}

/* =========================
 * Normalization (KEY FIX)
 * ========================= */

function normalizeScheduleResponse(raw) {
  // 1) If raw is string -> parse
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { raw = {}; }
  }

  // 2) Unwrap common containers
  let container =
    raw?.schedule ??
    raw?.data ??
    raw?.value ??
    raw;

  // 3) If container is string -> parse
  if (typeof container === "string") {
    try { container = JSON.parse(container); } catch { container = {}; }
  }

  // 4) Pull entries from common shapes
  let entries =
    container?.entries ??
    container?.items ??
    container?.schedule?.entries ??
    container?.value ?? // sometimes nested again
    [];

  // 5) If entries is string -> parse
  if (typeof entries === "string") {
    try { entries = JSON.parse(entries); } catch { entries = []; }
  }

  // 6) Convert map/object -> array
  if (entries && !Array.isArray(entries) && typeof entries === "object") {
    entries = Object.values(entries);
  }

  if (!Array.isArray(entries)) entries = [];

  // 7) Ensure shape safety
  entries = entries.map(e => ({
    id: e.id || e.entryId || cryptoIdFallback(e),
    startISO: e.startISO,
    endISO: e.endISO,
    departments: e.departments || {}
  })).filter(e => e.startISO && e.endISO);

  return { entries };
}

function extractUpdatedAt(raw) {
  // Try many possible places
  return (
    raw?.schedule?.updatedAt ||
    raw?.updatedAt ||
    raw?.schedule?.meta?.updatedAt ||
    null
  );
}

function cryptoIdFallback(e) {
  // deterministic-ish fallback (avoid breaking keys)
  return String(e.startISO || "") + "::" + String(e.endISO || "");
}

/* =========================
 * Rendering
 * ========================= */

function renderAll() {
  renderLastUpdated();
  ensureJumpButton();
  renderTimeline();
  renderCurrent();
  renderSchedule();
  renderPsCustomers();
}

function showSkeletons() {
  ["timeline", "schedule", "currentOnCall"].forEach(id => {
    const el = $(id);
    if (!el) return;
    el.innerHTML = `
      <div class="skeleton-card">
        <div class="skeleton-line w40"></div>
        <div class="skeleton-line w70"></div>
        <div class="skeleton-line w55"></div>
      </div>
    `;
  });
}

function renderLastUpdated() {
  const container = document.querySelector(".container");
  if (!container) return;

  let badge = $("lastUpdated");
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "lastUpdated";
    badge.className = "last-updated";
    container.prepend(badge);
  }

  const ts = STATE.updatedAt ? new Date(STATE.updatedAt) : null;
  badge.textContent = ts
    ? `Last updated: ${ts.toLocaleString("en-US")}`
    : "Last updated: —";
}

function ensureJumpButton() {
  let btn = $("jumpToCurrent");
  if (btn) return;

  btn = document.createElement("button");
  btn.id = "jumpToCurrent";
  btn.className = "ghost jump-btn";
  btn.textContent = "Jump to Current Week";

  btn.onclick = () => jumpToCurrentWeek();

  const container = document.querySelector(".container");
  if (container) {
    const badge = $("lastUpdated");
    badge ? badge.after(btn) : container.prepend(btn);
  }
}

function renderTimeline() {
  const el = $("timeline");
  if (!el) return;

  const entries = filteredEntriesSorted();
  const hash = hashEntries(entries);
  if (hash === LAST_TIMELINE_HASH) return;
  if (!entries.length) {
    el.innerHTML = `<div class="subtle">No schedule entries found.</div>`;
    return;
  }

  el.innerHTML = "";

  const now = new Date();

  entries.forEach(e => {
    const s = parseLocalISO(e.startISO);
    const en = parseLocalISO(e.endISO);
    const current = now >= s && now < en;

    const row = document.createElement("div");
    row.className = "timeline-row-wrap" + (current ? " current-week" : "");

    row.innerHTML = `
      <div class="timeline-left">
        <div class="week-label">${formatWeekLabel(e.startISO)}</div>
        <div class="small subtle">${formatDate(e.startISO)} → ${formatDate(e.endISO)}</div>
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

  return keys.map(dep => {
    const p = depts[dep] || {};
    const phone = (p.phone || "").trim();
    const tel = phone ? sanitizePhone(phone) : "";

    return `
      <div class="timeline-block">
        <div class="timeline-dept">${escapeHtml(prettyDept(dep))}</div>
        <div class="timeline-name">${escapeHtml(p.name || "—")}</div>
        <div class="timeline-email">${escapeHtml(p.email || "—")}</div>
        ${
          phone
            ? `<a class="timeline-phone" href="tel:${escapeHtml(tel)}">${escapeHtml(phone)}</a>`
            : `<div class="timeline-phone subtle">—</div>`
        }
      </div>
    `;
  }).join("");
}

function renderCurrent() {
  const el = $("currentOnCall");
  if (!el) return;

  // Prefer /current endpoint; fallback to computed current from entries
  let entry = STATE.current;
  if (!entry) {
    entry = STATE.entries.find(isCurrentFromEntries) || null;
  }

  if (!entry) {
    el.innerHTML = `<div class="subtle">No one is currently on call.</div>`;
    return;
  }

  el.innerHTML = `
    <div class="schedule-card current-oncall">
      <div class="card-head">
        <b>${formatDate(entry.startISO)} → ${formatDate(entry.endISO)}</b>
        <div class="small subtle">Live · CST</div>
      </div>
      <div class="entry-grid">
        ${renderEntryDepts(entry)}
      </div>
    </div>
  `;
}

function renderSchedule() {
  const el = $("schedule");
  if (!el) return;

  const all = filteredEntriesSorted();
  if (!all.length) {
    el.innerHTML = `<div class="subtle">No schedule available.</div>`;
    return;
  }

  const active = all.filter(e => !isArchived(e));
  const archived = all.filter(isArchived);

  el.innerHTML = "";

  /* ===== ACTIVE / UPCOMING ===== */
  active.forEach(e => {
    const current = isCurrentFromEntries(e);
    const currentWeek = isCurrentWeek(e);

    el.innerHTML += `
      <div class="schedule-card ${current ? "current-oncall" : ""}"
           ${currentWeek ? `data-current-week="true"` : ""}>
        <div class="card-head">
          <div class="card-title">
            ${escapeHtml(formatDate(e.startISO))} → ${escapeHtml(formatDate(e.endISO))}
          </div>
          <div class="small subtle">Read-only · CST</div>
        </div>
        <div class="entry-grid">
          ${renderEntryDepts(e)}
        </div>
      </div>
    `;
  });

  /* ===== ARCHIVED (COLLAPSIBLE) ===== */
  if (archived.length) {
    el.innerHTML += `
      <details class="archived-wrapper">
        <summary>
          Archived Schedules (${archived.length})
        </summary>
        <div class="archived-list">
          ${archived.map(e => `
            <div class="schedule-card archived">
              <div class="card-head">
                <div class="card-title">
                  ${escapeHtml(formatDate(e.startISO))} → ${escapeHtml(formatDate(e.endISO))}
                  <span class="archived-badge">Archived</span>
                </div>
                <div class="small subtle">Past</div>
              </div>
              <div class="entry-grid">
                ${renderEntryDepts(e)}
              </div>
            </div>
          `).join("")}
        </div>
      </details>
    `;
  }
}

function renderEntryDepts(entry) {
  const depts = entry.departments || {};
  const keys = Object.keys(depts);

  if (!keys.length) return `<div class="subtle">No assignments.</div>`;

  return keys.map(dep => {
    const p = depts[dep] || {};
    const phone = (p.phone || "").trim();
    const tel = phone ? sanitizePhone(phone) : "";

    return `
      <div class="entry">
        <h4>${escapeHtml(prettyDept(dep))}</h4>
        <div><b>${escapeHtml(p.name || "")}</b></div>
        <div class="small">${escapeHtml(p.email || "")}</div>
        ${
          phone
            ? `<a class="small tel-link" href="tel:${escapeHtml(tel)}">${escapeHtml(phone)}</a>`
            : `<div class="small subtle">—</div>`
        }
      </div>
    `;
  }).join("");
}
function hashEntries(entries) {
  try {
    return JSON.stringify(
      entries.map(e => ({
        id: e.id,
        start: e.startISO,
        end: e.endISO,
        d: Object.keys(e.departments || {})
      }))
    );
  } catch {
    return String(Math.random());
  }
}

function renderPsCustomers() {
  const el = document.getElementById("psCustomers");
  if (!el) return;

  const list = STATE.psCustomers || [];

  el.innerHTML = `
    <div class="ps-card">
      <div class="ps-card-head">
        <div>
          <h3>OneAssist Customers</h3>
          <div class="subtle">Read-only reference · Used for IVR and SMS authentication</div>
        </div>
        <input
          type="search"
          class="ps-search"
          placeholder="Search customers…"
          aria-label="Search PS customers"
        />
      </div>

      ${
        !list.length
          ? `<div class="subtle">No Professional Services customers available.</div>`
          : `
        <div class="ps-table-wrap">
          <table class="ps-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>PIN</th>
              </tr>
            </thead>
            <tbody>
              ${list.map(c => `
                <tr>
                  <td class="ps-name">${escapeHtml(c.name || "—")}</td>
                  <td>
                    <code class="ps-pin">${escapeHtml(c.pin || "—")}</code>
                  </td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      `}
    </div>
  `;

  // Client-side search
  const search = el.querySelector(".ps-search");
  if (search) {
    search.addEventListener("input", () => {
      const q = search.value.toLowerCase();
      el.querySelectorAll("tbody tr").forEach(row => {
        row.style.display =
          row.textContent.toLowerCase().includes(q) ? "" : "none";
      });
    });
  }
}
/* =========================
 * Filtering / Sorting
 * ========================= */

function filteredEntriesSorted() {
  let list = Array.isArray(STATE.entries) ? [...STATE.entries] : [];

  list.sort((a, b) => {
    const aArchived = isArchived(a);
    const bArchived = isArchived(b);

    // Active first, archived last
    if (aArchived !== bArchived) {
      return aArchived ? 1 : -1;
    }

    // Then by start date
    return parseLocalISO(a.startISO) - parseLocalISO(b.startISO);
  });

  // department filter
  if (STATE.dept !== "all") {
    list = list.map(e => ({
      ...e,
      departments: e.departments?.[STATE.dept]
        ? { [STATE.dept]: e.departments[STATE.dept] }
        : {}
    }));
  }

  return list;
}

/* =========================
 * Time / Format Utils
 * ========================= */

function parseLocalISO(iso) {
  if (!iso) return new Date(NaN);
  // supports: YYYY-MM-DDTHH:mm or YYYY-MM-DDTHH:mm:ss
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return new Date(NaN);
  return new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6] || 0)
  );
}

function formatDate(iso) {
  const d = parseLocalISO(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleString("en-US", {
    month: "short", day: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true
  }) + " CST";
}

function formatWeekLabel(startISO) {
  const d = parseLocalISO(startISO);
  if (isNaN(d)) return "Week";
  return d.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });
}

function isCurrentFromEntries(entry) {
  const now = new Date();
  const s = parseLocalISO(entry.startISO);
  const e = parseLocalISO(entry.endISO);
  return now >= s && now < e;
}

function prettyDept(dep) {
  return DEPT_LABELS[dep] || String(dep || "").replace(/_/g, " ");
}

function sanitizePhone(p) {
  return String(p || "").replace(/[^\d+]/g, "");
}
function jumpToCurrentWeek() {
  const target =
    document.querySelector('[data-current-week="true"]') ||
    document.querySelector(".current-week");

  if (!target) {
    console.warn("[public] No current week to jump to");
    return;
  }

  target.scrollIntoView({
    behavior: "smooth",
    block: "center"
  });

  target.classList.add("today-indicator");
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" }[c])
  );
// =========================
// SAFETY: Guard timeline observers (prevents JS crash)
// =========================
const timelineEl = document.getElementById("timeline");

if (timelineEl) {
const timeline = document.getElementById("timeline");
if (timeline) {
  const obs = new MutationObserver(() => {
    Array.from(timeline.children).forEach((r,i)=>{
      setTimeout(()=>r.classList.add("animate-in"),i*35);
    });
    const today =
      timeline.querySelector(".current-week") ||
      timeline.querySelector("[data-current-week='true']");
    if (today) {
      today.classList.add("today-indicator");
    }
  });
  obs.observe(timeline,{childList:true});
}

  let tsx = 0;
  timelineEl.addEventListener("touchstart", e => {
    tsx = e.touches[0].clientX;
  }, { passive: true });

  timelineEl.addEventListener("touchend", e => {
    const dx = e.changedTouches[0].clientX - tsx;
    if (Math.abs(dx) > 80) {
      timelineEl.dispatchEvent(
        new CustomEvent(dx < 0 ? "timeline:next" : "timeline:prev")
      );
    }
  });
}

}

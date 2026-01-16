// ======================================================
// public.js — PUBLIC READ-ONLY ON-CALL VIEW (ROBUST)
// - Handles KV/string wrappers and multiple payload shapes
// - Renders Timeline / Current / Full Schedule
// - Today highlight, click-to-call, skeleton loaders, last updated
// - Auto-refresh
// ======================================================

"use strict";

console.log("[public] public.js loaded");

const REFRESH_MS = 60_000;
const ENDPOINTS = {
  oncall: "/api/oncall",
  current: "/api/oncall/current"
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
  loading: true
};

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
  await Promise.allSettled([loadSchedule(), loadCurrent()]);
  STATE.loading = false;
  renderAll();
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

  STATE.entries = normalized.entries || [];
  STATE.updatedAt = extractUpdatedAt(raw) || new Date().toISOString();

  console.log("[public] schedule entries:", STATE.entries.length, "updatedAt:", STATE.updatedAt);
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
  renderTimeline();
  renderCurrent();
  renderSchedule();
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

function renderTimeline() {
  const el = $("timeline");
  if (!el) return;

  const entries = filteredEntriesSorted();
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

    if (current) {
      row.scrollIntoView({ behavior: "smooth", block: "center" });
    }
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
      <div class="timeline-block" title="${escapeHtml(prettyDept(dep))} — ${escapeHtml(p.name||"")} — ${escapeHtml(phone)}">
        <div class="timeline-block-title">${escapeHtml(prettyDept(dep))}</div>
        <div class="timeline-block-name">${escapeHtml(p.name || "")}</div>
        ${
          phone
            ? `<a class="small tel-link" href="tel:${escapeHtml(tel)}">${escapeHtml(phone)}</a>`
            : `<div class="small subtle">—</div>`
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

  const entries = filteredEntriesSorted();
  if (!entries.length) {
    el.innerHTML = `<div class="subtle">No schedule available.</div>`;
    return;
  }

  el.innerHTML = "";

  entries.forEach(e => {
    const current = isCurrentFromEntries(e);
    el.innerHTML += `
      <div class="schedule-card ${current ? "current-oncall" : ""}">
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

/* =========================
 * Filtering / Sorting
 * ========================= */

function filteredEntriesSorted() {
  let list = Array.isArray(STATE.entries) ? [...STATE.entries] : [];

  // sort by start
  list.sort((a, b) => parseLocalISO(a.startISO) - parseLocalISO(b.startISO));

  // dept filter
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

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" }[c])
  );
}

// ======================================================
// public.js — PUBLIC READ-ONLY ON-CALL VIEW
// - No authentication
// - Uses /api/oncall only
// - Timeline + Current + Full Schedule
// - Phone numbers included
// ======================================================

"use strict";

/* =========================
 * Global State
 * ========================= */

const STATE = {
  dept: "all",
  schedule: { entries: [] },
  timer: null
};

const DEPT_LABELS = {
  enterprise_network: "Enterprise Network",
  collaboration: "Collaboration",
  system_storage: "System & Storage"
};

const DEPT_KEYS = Object.keys(DEPT_LABELS);

/* =========================
 * Utilities
 * ========================= */

const byId = (id) => document.getElementById(id);

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" }[c])
  );
}

function isoToDateLocalAssumed(iso) {
  if (!iso) return new Date(NaN);
  const m = iso.match(/^(\d+)-(\d+)-(\d+)T(\d+):(\d+):?(\d+)?/);
  if (!m) return new Date(NaN);
  return new Date(m[1], m[2] - 1, m[3], m[4], m[5], m[6] || 0);
}

function formatCST(iso) {
  const d = isoToDateLocalAssumed(iso);
  if (isNaN(d)) return "";
  return d.toLocaleString("en-US", {
    timeZone: "Etc/GMT+6",
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  }) + " CST";
}

/* =========================
 * Fetch
 * ========================= */

async function loadSchedule() {
  const res = await fetch("/api/oncall");
  if (!res.ok) throw new Error("Failed to load schedule");
  const data = await res.json();
  STATE.schedule = normalizeSchedule(data);
}

/* =========================
 * Normalization
 * ========================= */

function normalizeSchedule(raw) {
  let container = raw?.schedule ?? raw;
  if (typeof container === "string") {
    try { container = JSON.parse(container); } catch { container = {}; }
  }

  let entries = container?.entries ?? [];
  if (typeof entries === "string") {
    try { entries = JSON.parse(entries); } catch { entries = []; }
  }

  if (!Array.isArray(entries)) entries = [];
  return { entries };
}

/* =========================
 * Rendering
 * ========================= */

function renderTimeline() {
  const el = byId("timeline");
  if (!el) return;
  el.innerHTML = "";

  let entries = [...STATE.schedule.entries];

  if (STATE.dept !== "all") {
    entries = entries.map(e => ({
      ...e,
      departments: e.departments?.[STATE.dept]
        ? { [STATE.dept]: e.departments[STATE.dept] }
        : {}
    }));
  }

  if (!entries.length) {
    el.innerHTML = `<div class="subtle">No schedule entries.</div>`;
    return;
  }

  entries
    .sort((a, b) => isoToDateLocalAssumed(a.startISO) - isoToDateLocalAssumed(b.startISO))
    .forEach(e => {
      const row = document.createElement("div");
      row.className = "timeline-row-wrap";

      row.innerHTML = `
        <div class="timeline-left">
          <div class="week-label">${escapeHtml(formatCST(e.startISO))}</div>
          <div class="small subtle">
            ${escapeHtml(formatCST(e.startISO))} → ${escapeHtml(formatCST(e.endISO))}
          </div>
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
  if (!keys.length) return `<div class="small subtle">No assignments</div>`;

  const width = Math.floor(100 / keys.length);

  return keys.map((dep, i) => {
    const p = depts[dep] || {};
    return `
      <div class="timeline-block"
           style="left:${i * width}%;width:${width}%;">
        <div class="timeline-block-title">${escapeHtml(DEPT_LABELS[dep])}</div>
        <div class="timeline-block-name">${escapeHtml(p.name || "")}</div>
        <div class="small">${escapeHtml(p.phone || "")}</div>
      </div>
    `;
  }).join("");
}

function renderSchedule() {
  const el = byId("schedule");
  if (!el) return;
  el.innerHTML = "";

  STATE.schedule.entries.forEach(e => {
    el.innerHTML += `
      <div class="schedule-card">
        <div class="card-head">
          <div class="card-title">
            ${escapeHtml(formatCST(e.startISO))} → ${escapeHtml(formatCST(e.endISO))}
          </div>
          <div class="small subtle">Read-only · CST</div>
        </div>
        <div class="entry-grid">
          ${renderScheduleDepts(e.departments)}
        </div>
      </div>
    `;
  });
}

function renderScheduleDepts(depts = {}) {
  return Object.keys(depts).map(dep => {
    const p = depts[dep] || {};
    return `
      <div class="entry">
        <h4>${escapeHtml(DEPT_LABELS[dep])}</h4>
        <div><b>${escapeHtml(p.name || "")}</b></div>
        <div>${escapeHtml(p.email || "")}</div>
        <div class="small">${escapeHtml(p.phone || "")}</div>
      </div>
    `;
  }).join("");
}

function renderCurrentOnCall() {
  const el = byId("currentOnCall");
  if (!el) return;

  const now = new Date();
  const entry = STATE.schedule.entries.find(e => {
    const s = isoToDateLocalAssumed(e.startISO);
    const en = isoToDateLocalAssumed(e.endISO);
    return now >= s && now < en;
  });

  if (!entry) {
    el.innerHTML = `<div class="subtle">No one is currently on call.</div>`;
    return;
  }

  el.innerHTML = `
    <div class="schedule-card current-oncall">
      <div class="card-head">
        <div class="card-title">
          ${escapeHtml(formatCST(entry.startISO))} → ${escapeHtml(formatCST(entry.endISO))}
        </div>
        <div class="small subtle">Live · CST</div>
      </div>
      <div class="entry-grid">
        ${renderScheduleDepts(entry.departments)}
      </div>
    </div>
  `;
}

/* =========================
 * Theme
 * ========================= */

const THEME_KEY = "oncall-theme";

function applyTheme(theme) {
  document.body.classList.remove("light", "dark");
  document.body.classList.add(theme);
  localStorage.setItem(THEME_KEY, theme);
}

function toggleTheme() {
  applyTheme(document.body.classList.contains("dark") ? "light" : "dark");
}

/* =========================
 * Init
 * ========================= */

async function init() {
  applyTheme(localStorage.getItem(THEME_KEY) || "light");

  byId("themeToggle")?.addEventListener("click", toggleTheme);
  byId("deptFilter")?.addEventListener("change", e => {
    STATE.dept = e.target.value;
    renderTimeline();
  });

  await loadSchedule();
  renderTimeline();
  renderSchedule();
  renderCurrentOnCall();

  STATE.timer = setInterval(renderCurrentOnCall, 60_000);
}

document.addEventListener("DOMContentLoaded", () => {
  init().catch(err => {
    console.error("Public init failed:", err);
  });
});

// ======================================================
// public.js — PUBLIC READ-ONLY ON-CALL VIEW
// ======================================================

"use strict";

const API = "/api/oncall";

/* =========================
 * DOM Helpers
 * ========================= */
const $ = (id) => document.getElementById(id);

/* =========================
 * Global State
 * ========================= */
let STATE = {
  entries: [],
  dept: "all"
};

/* =========================
 * Init
 * ========================= */
document.addEventListener("DOMContentLoaded", () => {
  wireUI();
  loadSchedule();
});

/* =========================
 * UI Wiring
 * ========================= */
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

/* =========================
 * Fetch + Normalize
 * ========================= */
async function loadSchedule() {
  const res = await fetch(API);
  if (!res.ok) {
    console.error("Failed to load public on-call schedule");
    return;
  }

  const raw = await res.json();

  // 🔑 THIS IS THE CRITICAL FIX
  const entries =
    raw?.schedule?.entries ||
    raw?.entries ||
    [];

  STATE.entries = Array.isArray(entries) ? entries : [];

  renderAll();
}

/* =========================
 * Rendering Orchestration
 * ========================= */
function renderAll() {
  renderTimeline();
  renderCurrent();
  renderSchedule();
}

/* =========================
 * Time Helpers
 * ========================= */
function parseLocalISO(iso) {
  if (!iso) return new Date(NaN);
  const [d, t] = iso.split("T");
  const [y, m, day] = d.split("-").map(Number);
  const [h, min] = t.split(":").map(Number);
  return new Date(y, m - 1, day, h, min || 0);
}

function formatDate(iso) {
  const d = parseLocalISO(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  }) + " CST";
}

function isCurrent(entry) {
  const now = new Date();
  return now >= parseLocalISO(entry.startISO) &&
         now <  parseLocalISO(entry.endISO);
}

/* =========================
 * Timeline
 * ========================= */
function renderTimeline() {
  const el = $("timeline");
  if (!el) return;

  el.innerHTML = "";

  const entries = filteredEntries();
  if (!entries.length) {
    el.innerHTML = `<div class="subtle">No schedule entries.</div>`;
    return;
  }

  entries.forEach(e => {
    const row = document.createElement("div");
    row.className = "timeline-row";

    row.innerHTML = `
      <div class="timeline-left">
        <b>${formatDate(e.startISO)}</b><br/>
        <span class="subtle">${formatDate(e.endISO)}</span>
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
  return Object.entries(depts).map(([dep, p]) => `
    <div class="timeline-block">
      <b>${dep.replace("_", " ")}</b><br/>
      ${p.name || ""}<br/>
      <span class="small">${p.phone || ""}</span>
    </div>
  `).join("");
}

/* =========================
 * Current On Call
 * ========================= */
function renderCurrent() {
  const el = $("currentOnCall");
  if (!el) return;

  const entry = STATE.entries.find(isCurrent);
  if (!entry) {
    el.innerHTML = `<div class="subtle">No one is currently on call.</div>`;
    return;
  }

  el.innerHTML = `
    <div>
      <b>${formatDate(entry.startISO)} → ${formatDate(entry.endISO)}</b>
      <div class="entry-grid">
        ${renderEntryDepts(entry)}
      </div>
    </div>
  `;
}

/* =========================
 * Full Schedule
 * ========================= */
function renderSchedule() {
  const el = $("schedule");
  if (!el) return;

  el.innerHTML = "";

  const entries = filteredEntries();
  if (!entries.length) {
    el.innerHTML = `<div class="subtle">No schedule available.</div>`;
    return;
  }

  entries.forEach(e => {
    el.innerHTML += `
      <div class="schedule-card">
        <div class="card-head">
          <b>${formatDate(e.startISO)} → ${formatDate(e.endISO)}</b>
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
  return Object.entries(depts).map(([dep, p]) => `
    <div class="entry">
      <b>${dep.replace("_", " ")}</b><br/>
      ${p.name || ""}<br/>
      ${p.email || ""}<br/>
      <span class="small">${p.phone || ""}</span>
    </div>
  `).join("");
}

/* =========================
 * Department Filter
 * ========================= */
function filteredEntries() {
  if (STATE.dept === "all") return STATE.entries;

  return STATE.entries.map(e => ({
    ...e,
    departments: e.departments?.[STATE.dept]
      ? { [STATE.dept]: e.departments[STATE.dept] }
      : {}
  }));
}

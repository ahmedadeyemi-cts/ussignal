// ======================================================
// public.js — PUBLIC READ-ONLY ON-CALL VIEW
// ======================================================

// Cloudflare Worker Path (same-origin — required for Cloudflare Access cookie auth)
// SAME ORIGIN — required for Pages Functions + Access

"use strict";
const API_BASE = "";
const API = "/api/oncall";
const REFRESH_MS = 60_000; // auto-refresh every minute

/* =========================
 * DOM Helpers
 * ========================= */
const $ = (id) => document.getElementById(id);

/* =========================
 * Global State
 * ========================= */
let STATE = {
  entries: [],
  dept: "all",
  updatedAt: null,
  loading: true
};

/* =========================
 * Init
 * ========================= */
document.addEventListener("DOMContentLoaded", () => {
  wireUI();
  showSkeletons();
  loadSchedule();
  setInterval(loadSchedule, REFRESH_MS);
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
  try {
    const res = await fetch(API, { cache: "no-store" });
    if (!res.ok) throw new Error("Fetch failed");

    const raw = await res.json();

    STATE.entries = Array.isArray(raw?.schedule?.entries)
      ? raw.schedule.entries
      : [];

    STATE.updatedAt = raw?.schedule?.updatedAt || new Date().toISOString();
    STATE.loading = false;

    renderAll();
  } catch (err) {
    console.error("Public on-call load failed:", err);
  }
}

/* =========================
 * Skeleton Loaders
 * ========================= */
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

/* =========================
 * Rendering Orchestration
 * ========================= */
function renderAll() {
  renderLastUpdated();
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
 * Last Updated Badge
 * ========================= */
function renderLastUpdated() {
  let badge = $("lastUpdated");
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "lastUpdated";
    badge.className = "last-updated";
    document.querySelector(".container")?.prepend(badge);
  }

  badge.textContent =
    "Last updated: " +
    new Date(STATE.updatedAt).toLocaleString("en-US");
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
    const current = isCurrent(e);

    const row = document.createElement("div");
    row.className =
      "timeline-row-wrap" +
      (current ? " current-week" : "");

    row.innerHTML = `
      <div class="timeline-left">
        <div class="week-label">${formatDate(e.startISO)}</div>
        <div class="small subtle">
          ${formatDate(e.startISO)} → ${formatDate(e.endISO)}
        </div>
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
  return Object.entries(depts).map(([dep, p]) => `
    <div class="timeline-block">
      <div class="timeline-block-title">${prettyDept(dep)}</div>
      <div class="timeline-block-name">${p.name || ""}</div>
      ${p.phone ? `<a href="tel:${sanitizePhone(p.phone)}" class="small tel-link">${p.phone}</a>` : ""}
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
    <div class="schedule-card current-oncall">
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
    const current = isCurrent(e);

    el.innerHTML += `
      <div class="schedule-card ${current ? "current-oncall" : ""}">
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
      <b>${prettyDept(dep)}</b><br/>
      ${p.name || ""}<br/>
      ${p.phone
        ? `<a href="tel:${sanitizePhone(p.phone)}" class="tel-link">${p.phone}</a>`
        : ""}
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

/* =========================
 * Utils
 * ========================= */
function prettyDept(dep) {
  return dep.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function sanitizePhone(p) {
  return p.replace(/[^\d+]/g, "");
}


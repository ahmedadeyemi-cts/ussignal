const API_BASE = "/api";

const DEPT_LABELS = {
  enterprise_network: "Enterprise Network",
  collaboration: "Collaboration",
  system_storage: "System & Storage"
};

function initApp({ admin }) {
  const filter = document.getElementById("deptFilter");
  const scheduleDiv = document.getElementById("schedule");
  const themeBtn = document.getElementById("themeToggle");

  themeBtn.onclick = toggleTheme;
  filter.onchange = loadSchedule;

  if (admin) {
    document.getElementById("exportBtn").onclick = exportExcel;
    document.getElementById("notifyBtn").onclick = sendNotify;
    document.getElementById("revertBtn").onclick = revertSchedule;
  }

  loadSchedule();

  async function loadSchedule() {
    const dept = filter.value;
    const res = await fetch(`${API_BASE}/oncall?department=${dept}`);
    const data = await res.json();
    renderSchedule(data.entries || []);
  }

  function renderSchedule(entries) {
    scheduleDiv.innerHTML = "";

    entries.forEach(entry => {
      const card = document.createElement("div");
      card.className = "schedule-card";

      const start = formatCST(entry.startISO);
      const end = formatCST(entry.endISO);

      card.innerHTML = `
        <strong>${start} → ${end}</strong>
        <div class="entry-grid">
          ${Object.entries(entry.departments || {}).map(([k, p]) => `
            <div class="entry">
              <h4>${DEPT_LABELS[k]}</h4>
              <div>${p.name}</div>
              <div>${p.email}</div>
            </div>
          `).join("")}
        </div>
      `;
      scheduleDiv.appendChild(card);
    });
  }
}

/* ===== Time Conversion =====
   Display explicitly in CST */
function formatCST(localISO) {
  if (!localISO) return "";
  const date = new Date(localISO + "Z");
  return date.toLocaleString("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  }) + " CST";
}

/* ===== Admin Actions ===== */

async function exportExcel() {
  const dept = document.getElementById("deptFilter").value;
  window.location = `/api/admin/oncall/export?department=${dept}`;
}

async function sendNotify() {
  if (!confirm("Send notifications to on-call users and admins?")) return;
  await fetch("/api/admin/oncall/notify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "both" })
  });
  alert("Notifications sent.");
}

async function revertSchedule() {
  if (!confirm("Revert to the previous on-call schedule?")) return;
  await fetch("/api/admin/oncall/revert", { method: "POST" });
  location.reload();
}

/* ===== Theme ===== */

function toggleTheme() {
  document.body.classList.toggle("dark");
  document.body.classList.toggle("light");
}

// Production Manager — phone-first weekly report + project view.
// The server is the source of truth for all math; this file mirrors the
// derived calculations only so the manager sees instant feedback while typing.

const MONEY_FIELDS = [
  "projectedJobSchedule",
  "completedJobsRevenue",
  "projectedLabor",
  "actualLaborRaw",
  "materialsGivenForWarranties",
  "projectedMaterials",
  "actualMaterials",
  "totalSundriesCost",
];
const COUNT_FIELDS = ["warrantiesOpenedThisWeek", "leadsThisWeek"];
const AUTO_FIELDS = ["projectedJobSchedule", "completedJobsRevenue", "projectedLabor"];

const state = {
  laborMultiplier: 1.2,
  autoSource: { projectedJobSchedule: 0, completedJobsRevenue: 0, projectedLabor: 0 },
  priorQtd: { warranties: 0, leads: 0 },
  weekStart: null,
  // Class this PM is reporting for ("All" = company-wide rollup).
  reportClass: localStorage.getItem("reportClass") || "All",
  classes: [],
};

const $ = (id) => document.getElementById(id);
const fmtMoney = (n) =>
  "$" +
  (Number(n) || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

function toast(message, kind = "") {
  const el = $("toast");
  el.textContent = message;
  el.className = "toast " + kind;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 3200);
}

function numVal(id) {
  const raw = $(id).value;
  if (raw === "" || raw === null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// ─────────────────────────── Live calculations ───────────────────────────
function recalc() {
  const completed = numVal("completedJobsRevenue");
  const actualLabor = numVal("actualLaborRaw") * state.laborMultiplier;
  const sundries = numVal("totalSundriesCost");
  const ratio = completed > 0 ? sundries / completed : 0;

  $("out-actualLabor").textContent = fmtMoney(actualLabor);
  $("out-installedRevenue").textContent = fmtMoney(completed);
  $("out-sundriesRatio").textContent = (ratio * 100).toFixed(1) + "%";
  $("out-totalWarrantiesQTD").textContent =
    state.priorQtd.warranties + numVal("warrantiesOpenedThisWeek");
  $("out-totalLeadsQTD").textContent =
    state.priorQtd.leads + numVal("leadsThisWeek");

  // Mark auto fields that the manager has overridden.
  for (const f of AUTO_FIELDS) {
    const field = document.querySelector(`.field[data-auto="${f}"]`);
    if (!field) continue;
    const changed = Math.abs(numVal(f) - (state.autoSource[f] ?? 0)) > 0.005;
    field.classList.toggle("edited", changed);
  }
}

// ─────────────────────────── Report load / save ───────────────────────────
function fillForm(report) {
  state.autoSource = report.autoSource;
  state.weekStart = report.weekStart;
  // Derive priorQtd from the difference the server already computed.
  state.priorQtd = {
    warranties: report.derived.totalWarrantiesQTD - report.manual.warrantiesOpenedThisWeek,
    leads: report.derived.totalLeadsQTD - report.manual.leadsThisWeek,
  };

  // Auto fields show the effective (override-applied) value.
  $("projectedJobSchedule").value = report.auto.projectedJobSchedule;
  $("completedJobsRevenue").value = report.auto.completedJobsRevenue;
  $("projectedLabor").value = report.auto.projectedLabor;

  // Manual fields.
  for (const f of [...MONEY_FIELDS, ...COUNT_FIELDS]) {
    if (AUTO_FIELDS.includes(f)) continue;
    if (report.manual[f] !== undefined) $(f).value = report.manual[f];
  }

  $("week-label").textContent = `Week of ${report.weekStart} – ${report.weekEnd} · ${report.quarter} · ${report.className}`;

  const pill = $("report-status");
  pill.hidden = false;
  pill.className = "status-pill " + report.status;
  pill.textContent =
    report.status === "submitted"
      ? `Submitted${report.submittedAt ? " · " + report.submittedAt.slice(0, 10) : ""}`
      : "Draft — not yet submitted";

  recalc();
}

function collectPayload(submit) {
  const manual = {
    actualLaborRaw: numVal("actualLaborRaw"),
    warrantiesOpenedThisWeek: Math.round(numVal("warrantiesOpenedThisWeek")),
    leadsThisWeek: Math.round(numVal("leadsThisWeek")),
    materialsGivenForWarranties: numVal("materialsGivenForWarranties"),
    projectedMaterials: numVal("projectedMaterials"),
    actualMaterials: numVal("actualMaterials"),
    totalSundriesCost: numVal("totalSundriesCost"),
  };
  // Only send overrides that actually differ from the auto-pulled source.
  const overrides = {};
  for (const f of AUTO_FIELDS) {
    if (Math.abs(numVal(f) - (state.autoSource[f] ?? 0)) > 0.005) {
      overrides[f] = numVal(f);
    }
  }
  return { manual, overrides, submit };
}

function renderReportChips() {
  const bar = $("report-class-chips");
  const chips = ["All", ...state.classes];
  if (!chips.includes(state.reportClass)) state.reportClass = "All";
  bar.innerHTML = chips
    .map(
      (c) => `
      <button type="button" class="chip-btn ${state.reportClass === c ? "active" : ""}" data-class="${escapeHtml(c)}">
        ${escapeHtml(c === "All" ? "All (company)" : c)}
      </button>`
    )
    .join("");
  bar.querySelectorAll(".chip-btn").forEach((b) =>
    b.addEventListener("click", () => {
      state.reportClass = b.dataset.class;
      localStorage.setItem("reportClass", state.reportClass);
      renderReportChips();
      loadReport();
    })
  );
}

async function loadReportClasses() {
  try {
    const { classes } = await (await fetch("/api/classes")).json();
    state.classes = classes || [];
  } catch {
    state.classes = [];
  }
  renderReportChips();
}

async function loadReportHistory() {
  const box = $("report-history");
  try {
    const res = await fetch("/api/reports");
    const list = await res.json();
    if (!Array.isArray(list) || !list.length) {
      box.innerHTML = `<div class="empty small">No reports saved yet.</div>`;
      return;
    }
    box.innerHTML = list
      .slice(0, 20)
      .map(
        (r) => `
        <div class="history-row">
          <span class="history-week">Week of ${escapeHtml(r.weekStart)}</span>
          <span class="history-class">${escapeHtml(r.className || "All")}</span>
          <span class="status-pill ${r.status}">${r.status === "submitted" ? "Submitted" : "Draft"}</span>
        </div>`
      )
      .join("");
  } catch {
    box.innerHTML = `<div class="empty small">Couldn't load history.</div>`;
  }
}

async function loadReport() {
  try {
    const res = await fetch(`/api/report?class=${encodeURIComponent(state.reportClass)}`);
    if (!res.ok) throw await res.json().catch(() => ({}));
    fillForm(await res.json());
  } catch (err) {
    toast(err.message || "Couldn't load the report.", "error");
  }
  loadReportHistory();
}

async function saveReport(submit) {
  const btn = submit ? $("btn-submit") : $("btn-save");
  btn.disabled = true;
  try {
    const res = await fetch(`/api/report?class=${encodeURIComponent(state.reportClass)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectPayload(submit)),
    });
    const data = await res.json();
    if (!res.ok) {
      const detail = data.issues?.[0]?.message || data.message;
      throw new Error(detail || "Save failed.");
    }
    fillForm(data);
    toast(submit ? "Report submitted ✓" : "Draft saved ✓", "success");
  } catch (err) {
    toast(err.message || "Save failed.", "error");
  } finally {
    btn.disabled = false;
  }
}

// ─────────────────────────── Projects ───────────────────────────
let allProjects = [];

function personLine(p) {
  if (!p) return "—";
  return p.email ? `${p.name}` : p.name;
}

function renderProjects() {
  const term = $("project-search").value.trim().toLowerCase();
  const list = $("projects-list");
  const filtered = allProjects.filter(
    (p) =>
      !term ||
      p.name.toLowerCase().includes(term) ||
      p.client.toLowerCase().includes(term) ||
      p.address.toLowerCase().includes(term)
  );

  if (!filtered.length) {
    list.innerHTML = `<div class="empty">No projects to show.</div>`;
    return;
  }

  list.innerHTML = filtered
    .map((p) => {
      const statusClass = p.isCancelled
        ? "cancelled"
        : p.isComplete
        ? "complete"
        : "";
      return `
      <article class="project">
        <div class="project-top">
          <h3>${escapeHtml(p.name)}</h3>
          <span class="value">${fmtMoney(p.estimatedValue)}</span>
        </div>
        <span class="status-tag ${statusClass}">${escapeHtml(p.status)}</span>
        <p class="meta">${escapeHtml(p.client)}${p.address ? " · " + escapeHtml(p.address) : ""}</p>
        <dl class="people">
          <dt>PM</dt><dd>${escapeHtml(personLine(p.assigned.projectManager))}</dd>
          <dt>Foreman</dt><dd>${escapeHtml(personLine(p.assigned.foreman))}</dd>
          <dt>Sales</dt><dd>${escapeHtml(personLine(p.assigned.salesPerson))}</dd>
        </dl>
      </article>`;
    })
    .join("");
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

async function loadProjects() {
  const list = $("projects-list");
  list.innerHTML = `<div class="loading">Loading projects…</div>`;
  try {
    const includeCancelled = $("include-cancelled").checked;
    const res = await fetch(
      `/api/projects?includeCancelled=${includeCancelled}`
    );
    if (!res.ok) throw await res.json().catch(() => ({}));
    const data = await res.json();
    allProjects = data.projects;
    renderProjects();
  } catch (err) {
    list.innerHTML = `<div class="empty">${escapeHtml(
      err.message || "Couldn't load projects."
    )}</div>`;
  }
}

// ─────────────────────────── Schedule ───────────────────────────
const schedule = {
  coverage: null,
  colorMap: new Map(),
  classes: [],
  activeClass: "all",
  /** ISO Sunday of the week being viewed (null until first load → current week). */
  weekStart: null,
};

// ── Week navigation (weeks run Sunday–Saturday) ──
function currentWeekStartIso() {
  const now = new Date();
  const sunday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
  const p = (n) => String(n).padStart(2, "0");
  return `${sunday.getFullYear()}-${p(sunday.getMonth() + 1)}-${p(sunday.getDate())}`;
}

function shiftWeekIso(iso, weeks) {
  const ms = Date.parse(`${iso}T00:00:00Z`) + weeks * 7 * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

function fmtWeekDay(iso) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function updateWeekBar(weekStart, weekEnd) {
  const isCurrent = weekStart === currentWeekStartIso();
  $("week-range").textContent = `${fmtWeekDay(weekStart)} – ${fmtWeekDay(weekEnd)}`;
  $("week-tag").hidden = !isCurrent;
  $("week-today").hidden = isCurrent;
  $("week-date").value = weekStart;
}

const NO_MATERIAL = ["warranty", "inspection", "sand & clear", "sand and clear"];
function normType(type) {
  return String(type || "").toLowerCase().replace(/\*+$/, "").trim();
}
function appliesMaterial(type) {
  if (!type) return true;
  return !NO_MATERIAL.includes(normType(type));
}
function isRubber(type) {
  return normType(type).includes("rubber");
}
function r2(n) {
  return Math.round(n * 100) / 100;
}

// Mirrors src/domain/materials.ts so edits recalculate instantly.
function computeMaterialClient(sqft, type, colorName) {
  const zero = {
    basecoatAGallons: 0, basecoatBGallons: 0, topcoatAGallons: 0, topcoatBGallons: 0,
    flakePounds: 0, flakeBoxes: 0, rubberBags: 0, binderBuckets: 0, primerBuckets: 0,
  };
  if (!appliesMaterial(type)) return { kind: "none", applies: false, flake: null, ...zero };

  const area = sqft > 0 ? sqft : 0;
  const per = (u) => (u > 0 ? r2(area / u) : 0);

  if (isRubber(type)) {
    const r = schedule.coverage?.rubber || {};
    return {
      kind: "rubber",
      applies: true,
      flake: colorName || null,
      ...zero,
      rubberBags: per(r.sqftPerBag),
      binderBuckets: per(r.sqftPerBinderBucket),
      primerBuckets: per(r.sqftPerPrimerBucket),
    };
  }

  const f = schedule.coverage?.flake || {};
  // Polyurea basecoat: total gallons split 2:1 A:B; polyaspartic: equal parts.
  const puTotal = f.polyureaSqftPerGallon > 0 ? area / f.polyureaSqftPerGallon : 0;
  const parts = (f.polyureaPartsA || 0) + (f.polyureaPartsB || 0);
  const paTotal = f.polyasparticSqftPerGallon > 0 ? area / f.polyasparticSqftPerGallon : 0;
  const flakePounds = r2(area * (f.flakeLbsPerSqft || 0));
  return {
    kind: "flake",
    applies: true,
    flake: colorName ? flakeFor(colorName) : null,
    ...zero,
    basecoatAGallons: parts > 0 ? r2((puTotal * (f.polyureaPartsA || 0)) / parts) : 0,
    basecoatBGallons: parts > 0 ? r2((puTotal * (f.polyureaPartsB || 0)) / parts) : 0,
    topcoatAGallons: r2(paTotal / 2),
    topcoatBGallons: r2(paTotal / 2),
    flakePounds,
    flakeBoxes: f.flakeBoxLbs > 0 ? r2(flakePounds / f.flakeBoxLbs) : 0,
  };
}

async function loadColors() {
  try {
    const { colors } = await (await fetch("/api/colors")).json();
    const dl = $("color-list");
    dl.innerHTML = colors
      .map((c) => `<option value="${escapeHtml(c.name)}"></option>`)
      .join("");
    schedule.colorMap = new Map(colors.map((c) => [c.name.toLowerCase(), c.flakeProduct]));
  } catch {
    /* non-fatal */
  }
}

function flakeFor(colorName) {
  if (!colorName) return null;
  return schedule.colorMap.get(colorName.toLowerCase()) || colorName;
}

const fmtN = (n, dp = 2) =>
  (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: dp });

function typeChipClass(projectType) {
  const t = (projectType || "").toLowerCase();
  if (t.includes("rubber")) return "type-rubber";
  if (t.includes("warranty") || t.includes("inspection")) return "type-warranty";
  return "type-flake";
}

// ── Class filter chips ──
function renderClassChips() {
  const bar = $("class-chips");
  const total = schedule.classes.reduce((n, g) => n + g.jobs.length, 0);
  const chips = [
    { key: "all", label: "All", count: total },
    ...schedule.classes.map((g) => ({ key: g.className, label: g.className, count: g.jobs.length })),
  ];
  if (!chips.find((c) => c.key === schedule.activeClass)) schedule.activeClass = "all";
  bar.innerHTML = chips
    .map(
      (c) => `
      <button type="button" class="chip-btn ${schedule.activeClass === c.key ? "active" : ""}" data-class="${escapeHtml(c.key)}">
        ${escapeHtml(c.label)} <span class="chip-count">${c.count}</span>
      </button>`
    )
    .join("");
  bar.querySelectorAll(".chip-btn").forEach((b) =>
    b.addEventListener("click", () => {
      schedule.activeClass = b.dataset.class;
      renderSchedule();
    })
  );
}

// Shared debounced save for a job's crew/color/sqft edits (used by both views).
// Saves against the week being viewed, so assignments stick to the right week.
function saveAssignment(id, payload, onOk) {
  debounce(id, async () => {
    try {
      const q = schedule.weekStart ? `?week=${schedule.weekStart}` : "";
      const res = await fetch(`/api/schedule/assign${q}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: id, ...payload }),
      });
      if (!res.ok) throw new Error("save failed");
      if (onOk) onOk();
    } catch {
      toast("Couldn't save that change.", "error");
    }
  });
}

// Table on wide screens, cards on phones. Re-render when crossing the breakpoint.
const desktopQuery = window.matchMedia("(min-width: 760px)");
const isDesktop = () => desktopQuery.matches;
desktopQuery.addEventListener("change", () => {
  if (schedule.classes.length && !$("screen-schedule").hidden) renderSchedule();
});

// ── Excel-style table (desktop) ──
// Material cell values in column order: Material, then flake columns, then rubber columns.
const MAT_KEYS = ["lbs", "box", "bca", "bcb", "tca", "tcb", "bags", "bind", "prim"];
function matValues(m) {
  const empty = Object.fromEntries(MAT_KEYS.map((k) => [k, null]));
  if (m.kind === "flake") {
    return {
      ...empty,
      lbs: m.flakePounds, box: m.flakeBoxes, bca: m.basecoatAGallons,
      bcb: m.basecoatBGallons, tca: m.topcoatAGallons, tcb: m.topcoatBGallons,
    };
  }
  if (m.kind === "rubber") {
    return { ...empty, bags: m.rubberBags, bind: m.binderBuckets, prim: m.primerBuckets };
  }
  return empty;
}

function matCells(job) {
  const m = job.material;
  const v = matValues(m);
  const name = m.applies ? escapeHtml(m.flake || "—") : "—";
  const cells = MAT_KEYS.map(
    (k) => `<td class="num c-${k}${v[k] === null ? " dim" : ""}">${v[k] === null ? "—" : fmtN(v[k])}</td>`
  ).join("");
  return `<td class="c-flake${m.applies ? "" : " dim"}">${name}</td>${cells}`;
}

const SLOT_NAMES = ["First", "Second", "Third"];
const WD3 = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CLOSED_STATUSES = ["complete", "completed", "paid", "canceled", "cancelled", "closed"];
const isClosedWo = (job) =>
  job.isWorkOrder && job.status && CLOSED_STATUSES.includes(String(job.status).toLowerCase());

function crewInputsHtml(job) {
  const members = job.crewMembers || [];
  const slots = Math.max(3, members.length);
  let html = "";
  for (let i = 0; i < slots; i++) {
    html += `<input class="js-crew" data-slot="${i}" list="roster-list-dl" type="text" placeholder="${SLOT_NAMES[i] || "More"}" value="${escapeHtml(members[i] || "")}" />`;
  }
  return html + `<button class="crew-add" type="button" title="Add another person">+ person</button>`;
}

function dayControlsHtml(job) {
  const opts = ['<option value="">—</option>']
    .concat(WD3.map((d, i) => `<option value="${i}"${job.dayIndex === i ? " selected" : ""}>${d}</option>`))
    .join("");
  return `
    <select class="js-day">${opts}</select>
    <span class="day-x">×</span>
    <input class="js-days" type="number" min="1" max="6" value="${job.days || 1}" title="How many days" />`;
}

function typeCellHtml(job) {
  let html = `<span class="chip ${typeChipClass(job.projectType)}">${escapeHtml(job.projectType)}</span>`;
  if (job.isWorkOrder) {
    if (job.status) html += `<span class="wo-status">${escapeHtml(job.status)}</span>`;
    if (!isClosedWo(job)) {
      const c = job.material.kind === "rubber" ? "rubber" : "flake";
      html += `<select class="js-coating" title="Coating type">
        <option value="flake"${c === "flake" ? " selected" : ""}>Flake</option>
        <option value="rubber"${c === "rubber" ? " selected" : ""}>Rubber</option>
      </select>`;
    }
  }
  return html;
}

function baseCellHtml(job) {
  if (job.material.kind === "rubber" || !job.material.applies) {
    return `<td class="c-base dim">—</td>`;
  }
  const warn = job.material.kind === "flake" && !job.baseColor ? " warn" : "";
  const opts = ['<option value="">—</option>']
    .concat(["Grey", "Tan", "Black"].map((b) => `<option${job.baseColor === b ? " selected" : ""}>${b}</option>`))
    .join("");
  return `<td class="cell-edit c-base"><select class="js-base${warn}">${opts}</select></td>`;
}

function rowHtml(job) {
  const hasCustomer = job.customer && job.customer !== "—";
  const label = hasCustomer ? job.customer : job.description || `Job #${job.jobNumber}`;
  const tooltip = job.description || label;
  const colorWarn = job.color && !job.colorRecognized ? " warn" : "";
  return `
    <tr class="jobrow${job.isWorkOrder ? " worow" : ""}" data-id="${escapeHtml(job.id)}">
      <td class="cell-edit c-day day-cell">${dayControlsHtml(job)}</td>
      <td class="c-jobno">${escapeHtml(job.jobNumber)}</td>
      <td class="c-name" title="${escapeHtml(tooltip)}">${escapeHtml(label)}</td>
      <td class="c-type">${typeCellHtml(job)}</td>
      <td class="cell-edit crew-cell">${crewInputsHtml(job)}</td>
      <td class="cell-edit num"><input class="js-sqft" type="number" inputmode="numeric" min="0" value="${job.sqft ?? ""}" placeholder="—" /></td>
      <td class="cell-edit"><input class="js-color${colorWarn}" list="color-list" type="text" value="${escapeHtml(job.color || "")}" placeholder="—" /></td>
      ${baseCellHtml(job)}
      ${matCells(job)}
    </tr>`;
}

function computeClassTotals(jobs) {
  // Keys derived from MAT_KEYS so adding a material column can't skew totals.
  const t = { sqft: 0 };
  for (const k of MAT_KEYS) t[k] = 0;
  for (const j of jobs) {
    t.sqft += j.sqft || 0;
    const v = matValues(j.material);
    for (const k of MAT_KEYS) t[k] += v[k] || 0;
  }
  return t;
}

function totalsRowHtml(label, jobs, className) {
  const t = computeClassTotals(jobs);
  return `
    <tr class="totals" data-class="${escapeHtml(className)}">
      <td colspan="5">${escapeHtml(label)}</td>
      <td class="num c-sqft">${fmtN(t.sqft, 0)}</td>
      <td></td>
      <td></td>
      <td></td>
      ${MAT_KEYS.map((k) => `<td class="num c-${k}">${fmtN(t[k])}</td>`).join("")}
    </tr>`;
}

function visibleGroups() {
  const term = $("schedule-search").value.trim().toLowerCase();
  return schedule.classes
    .filter((g) => schedule.activeClass === "all" || g.className === schedule.activeClass)
    .map((g) => ({
      className: g.className,
      jobs: g.jobs.filter(
        (j) =>
          !term ||
          (j.customer || "").toLowerCase().includes(term) ||
          (j.description || "").toLowerCase().includes(term) ||
          String(j.jobNumber).includes(term) ||
          (j.crew || "").toLowerCase().includes(term) ||
          (j.color || "").toLowerCase().includes(term)
      ),
    }))
    .filter((g) => g.jobs.length);
}

function renderSchedule() {
  renderClassChips();
  const list = $("schedule-list");
  const groups = visibleGroups();

  if (!groups.length) {
    list.innerHTML = `<div class="empty">No jobs match.</div>`;
    return;
  }

  if (isDesktop()) renderTable(list, groups);
  else renderCards(list, groups);
}

function renderTable(list, groups) {
  const showBands = schedule.activeClass === "all" && groups.length > 1;
  let body = "";
  for (const g of groups) {
    if (showBands) {
      body += `<tr class="group-band"><td colspan="18">${escapeHtml(g.className)} · ${g.jobs.length} job${g.jobs.length === 1 ? "" : "s"}</td></tr>`;
    }
    body += g.jobs.map(rowHtml).join("");
    body += totalsRowHtml(`${g.className} totals`, g.jobs, g.className);
  }
  if (showBands) {
    const all = groups.flatMap((g) => g.jobs);
    body += totalsRowHtml("Week totals", all, "__all__");
  }

  list.innerHTML = `
    <div class="table-wrap">
      <table class="sched">
        <thead>
          <tr>
            <th class="th-day">Day</th><th>Job #</th><th class="th-name">Customer / Job</th><th>Type</th>
            <th class="th-crew">Crew (1st / 2nd / 3rd)</th><th class="num">SQFT</th><th class="th-color">Color</th>
            <th>Base</th><th>Material</th><th class="num">Lbs</th><th class="num">Boxes 40#</th><th class="num">Base A</th><th class="num">Base B</th><th class="num">Top A</th><th class="num">Top B</th>
            <th class="num">Bags 50#</th><th class="num">Binder 5G</th><th class="num">Primer 5G</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;

  list.querySelectorAll("tr.jobrow").forEach(wireRow);
}

const debouncers = new Map();
function debounce(key, fn, ms = 600) {
  clearTimeout(debouncers.get(key));
  debouncers.set(key, setTimeout(fn, ms));
}

function updateRowMaterial(row, job) {
  const m = job.material;
  const v = matValues(m);
  const flakeCell = row.querySelector(".c-flake");
  if (flakeCell) {
    flakeCell.classList.toggle("dim", !m.applies);
    flakeCell.textContent = m.applies ? m.flake || "—" : "—";
  }
  for (const k of MAT_KEYS) {
    const cell = row.querySelector(`.c-${k}`);
    if (!cell) continue;
    cell.classList.toggle("dim", v[k] === null);
    cell.textContent = v[k] === null ? "—" : fmtN(v[k]);
  }
}

function fillTotalsRow(row, jobs) {
  const t = computeClassTotals(jobs);
  row.querySelector(".c-sqft").textContent = fmtN(t.sqft, 0);
  for (const k of MAT_KEYS) {
    const cell = row.querySelector(`.c-${k}`);
    if (cell) cell.textContent = fmtN(t[k]);
  }
}

function updateTotalsRows() {
  const groups = visibleGroups();
  for (const g of groups) {
    const row = document.querySelector(`tr.totals[data-class="${CSS.escape(g.className)}"]`);
    if (row) fillTotalsRow(row, g.jobs);
  }
  const grand = document.querySelector(`tr.totals[data-class="__all__"]`);
  if (grand) fillTotalsRow(grand, groups.flatMap((g) => g.jobs));
}

function effectiveType(job) {
  if (isClosedWo(job)) return "Warranty"; // closed WOs stage nothing
  if (job.coating === "rubber") return "Rubber";
  if (job.coating === "flake") return "Flake";
  if (job.isWorkOrder) return "Repair (flake)"; // WOs default to flake rates
  return job.projectType;
}

function collectCrew(container) {
  return [...container.querySelectorAll(".js-crew")].map((i) => i.value.trim());
}

function wireCrewInputs(container, id, flash) {
  container.querySelectorAll(".js-crew").forEach((input) =>
    input.addEventListener("input", () => {
      const members = collectCrew(container);
      const job = findJob(id);
      if (job) {
        job.crewMembers = members.filter(Boolean);
        job.crew = job.crewMembers.join(" / ");
      }
      saveAssignment(id, { crewMembers: members }, flash);
    })
  );
  const add = container.querySelector(".crew-add");
  if (add) {
    add.addEventListener("click", () => {
      const slot = container.querySelectorAll(".js-crew").length;
      const input = document.createElement("input");
      input.className = "js-crew";
      input.dataset.slot = String(slot);
      input.type = "text";
      input.placeholder = "More";
      container.insertBefore(input, add);
      input.addEventListener("input", () => {
        const members = collectCrew(container);
        saveAssignment(id, { crewMembers: members }, flash);
      });
      input.focus();
    });
  }
}

function wireRow(row) {
  const id = row.dataset.id;
  const sqft = row.querySelector(".js-sqft");
  const color = row.querySelector(".js-color");
  const daySel = row.querySelector(".js-day");
  const daysInput = row.querySelector(".js-days");
  const coatingSel = row.querySelector(".js-coating");
  const baseSel = row.querySelector(".js-base");

  const flash = () => {
    row.classList.add("saved-flash");
    setTimeout(() => row.classList.remove("saved-flash"), 900);
  };

  const recompute = () => {
    const job = findJob(id);
    if (!job) return;
    job.sqft = sqft.value === "" ? null : Number(sqft.value) || 0;
    job.color = color.value.trim() || null;
    job.material = computeMaterialClient(job.sqft || 0, effectiveType(job), job.color);
    color.classList.toggle("warn", Boolean(job.color) && !schedule.colorMap.has(job.color.toLowerCase()));
    updateRowMaterial(row, job);
    updateTotalsRows();
  };

  wireCrewInputs(row.querySelector(".crew-cell"), id, flash);

  sqft.addEventListener("input", () => {
    recompute();
    const v = Number(sqft.value);
    saveAssignment(id, { sqftOverride: Number.isFinite(v) && v >= 0 ? v : undefined }, flash);
  });
  color.addEventListener("input", () => {
    recompute();
    saveAssignment(id, { colorOverride: color.value.trim() || undefined }, flash);
  });
  if (daySel) {
    daySel.addEventListener("change", () => {
      const v = daySel.value === "" ? undefined : Number(daySel.value);
      const job = findJob(id);
      if (job && v !== undefined) job.dayIndex = v;
      if (v !== undefined) saveAssignment(id, { dayOverride: v }, flash);
    });
  }
  if (daysInput) {
    daysInput.addEventListener("input", () => {
      const v = Math.max(1, Math.min(6, Number(daysInput.value) || 1));
      const job = findJob(id);
      if (job) job.days = v;
      saveAssignment(id, { daysCount: v }, flash);
    });
  }
  if (coatingSel) {
    coatingSel.addEventListener("change", () => {
      const job = findJob(id);
      if (job) job.coating = coatingSel.value;
      recompute();
      saveAssignment(id, { coating: coatingSel.value }, flash);
    });
  }
  if (baseSel) {
    baseSel.addEventListener("change", () => {
      const job = findJob(id);
      if (job) job.baseColor = baseSel.value || null;
      baseSel.classList.toggle("warn", !baseSel.value);
      saveAssignment(id, { baseColor: baseSel.value }, flash);
      updateTotalsRows();
    });
  }
}

// ── Card view (phone) ──
function materialHtml(mat) {
  if (!mat.applies) {
    return `<div class="material none">No material needed (warranty / inspection).</div>`;
  }
  if (mat.kind === "rubber") {
    return `
    <div class="material">
      <h4>Material to use (rubber)</h4>
      <div class="flake-name">Rubber: ${escapeHtml(mat.flake || "—")} · <b>${fmtN(mat.rubberBags)} bags (50 lb)</b></div>
      <div class="mat-rows">
        <span>Binder <b>${fmtN(mat.binderBuckets)} × 5-gal</b></span>
        <span>Primer <b>${fmtN(mat.primerBuckets)} × 5-gal</b></span>
      </div>
    </div>`;
  }
  return `
    <div class="material">
      <h4>Material to use</h4>
      <div class="flake-name">Flake: ${escapeHtml(mat.flake || "—")} · <b>${fmtN(mat.flakePounds)} lbs (${fmtN(mat.flakeBoxes)} boxes)</b></div>
      <div class="mat-rows">
        <span>Basecoat A <b>${fmtN(mat.basecoatAGallons)} gal</b></span>
        <span>Basecoat B <b>${fmtN(mat.basecoatBGallons)} gal</b></span>
        <span>Topcoat A <b>${fmtN(mat.topcoatAGallons)} gal</b></span>
        <span>Topcoat B <b>${fmtN(mat.topcoatBGallons)} gal</b></span>
      </div>
    </div>`;
}

function jobCardHtml(job) {
  const hasCustomer = job.customer && job.customer !== "—";
  const title = hasCustomer ? job.customer : `Job #${job.jobNumber}`;
  return `
    <article class="job" data-id="${escapeHtml(job.id)}">
      <div class="job-head">
        <h3>${escapeHtml(title)}</h3>
        <span class="job-no">#${escapeHtml(job.jobNumber)}</span>
      </div>
      <div class="job-sub">
        <span class="chip ${typeChipClass(job.projectType)}">${escapeHtml(job.projectType)}</span>
        ${job.scheduledDay ? `<span>${escapeHtml(job.scheduledDay)}</span>` : ""}
        ${job.city ? `<span>${escapeHtml(job.city)}</span>` : ""}
      </div>
      ${job.description ? `<p class="job-desc">${escapeHtml(job.description)}</p>` : ""}
      <div class="job-grid">
        <div class="job-field full crew-cell card-crew">
          <label>Crew (First / Second / Third)</label>
          ${crewInputsHtml(job)}
        </div>
        <div class="job-field day-cell card-day">
          <label>Day × days</label>
          <div class="day-controls">${dayControlsHtml(job)}</div>
        </div>
        <div class="job-field">
          <label>SQFT</label>
          <input class="js-sqft" type="number" inputmode="numeric" min="0" value="${job.sqft ?? ""}" />
        </div>
        <div class="job-field">
          <label>Color</label>
          <input class="js-color${job.color && !job.colorRecognized ? " warn" : ""}" list="color-list" type="text" value="${escapeHtml(job.color || "")}" />
        </div>
        <div class="job-field">
          <label>Base (Grey/Tan/Black)</label>
          ${job.material.kind === "rubber" ? '<input type="text" value="—" disabled />' : `<select class="js-base${job.material.kind === "flake" && !job.baseColor ? " warn" : ""}"><option value="">—</option>${["Grey","Tan","Black"].map((b)=>`<option${job.baseColor===b?" selected":""}>${b}</option>`).join("")}</select>`}
        </div>
        ${job.isWorkOrder && !isClosedWo(job) ? `<div class="job-field full"><label>Coating</label><select class="js-coating"><option value="flake"${job.material.kind!=="rubber"?" selected":""}>Flake</option><option value="rubber"${job.material.kind==="rubber"?" selected":""}>Rubber</option></select></div>` : ""}
      </div>
      <div class="js-material">${materialHtml(job.material)}</div>
      <span class="save-tick js-tick">saved ✓</span>
    </article>`;
}

function renderCards(list, groups) {
  const showHeaders = schedule.activeClass === "all" && groups.length > 1;
  list.innerHTML = groups
    .map(
      (g) => `
      <section class="class-group">
        ${showHeaders ? `<h2>${escapeHtml(g.className)} <span class="count">${g.jobs.length}</span></h2>` : ""}
        ${g.jobs.map(jobCardHtml).join("")}
      </section>`
    )
    .join("");
  list.querySelectorAll(".job").forEach(wireCard);
}

function wireCard(el) {
  const id = el.dataset.id;
  const sqft = el.querySelector(".js-sqft");
  const color = el.querySelector(".js-color");
  const daySel = el.querySelector(".js-day");
  const daysInput = el.querySelector(".js-days");
  const coatingSel = el.querySelector(".js-coating");
  const baseSel = el.querySelector(".js-base");
  const matBox = el.querySelector(".js-material");
  const tick = el.querySelector(".js-tick");

  const flash = () => {
    tick.classList.add("show");
    setTimeout(() => tick.classList.remove("show"), 1400);
  };

  const recompute = () => {
    const job = findJob(id);
    if (!job) return;
    job.sqft = sqft.value === "" ? null : Number(sqft.value) || 0;
    job.color = color.value.trim() || null;
    job.material = computeMaterialClient(job.sqft || 0, effectiveType(job), job.color);
    color.classList.toggle("warn", Boolean(job.color) && !schedule.colorMap.has(job.color.toLowerCase()));
    matBox.innerHTML = materialHtml(job.material);
  };

  wireCrewInputs(el.querySelector(".crew-cell"), id, flash);
  sqft.addEventListener("input", () => {
    recompute();
    const v = Number(sqft.value);
    saveAssignment(id, { sqftOverride: Number.isFinite(v) && v >= 0 ? v : undefined }, flash);
  });
  color.addEventListener("input", () => {
    recompute();
    saveAssignment(id, { colorOverride: color.value.trim() || undefined }, flash);
  });
  if (daySel) {
    daySel.addEventListener("change", () => {
      const v = daySel.value === "" ? undefined : Number(daySel.value);
      if (v !== undefined) saveAssignment(id, { dayOverride: v }, flash);
    });
  }
  if (daysInput) {
    daysInput.addEventListener("input", () => {
      const v = Math.max(1, Math.min(6, Number(daysInput.value) || 1));
      saveAssignment(id, { daysCount: v }, flash);
    });
  }
  if (coatingSel) {
    coatingSel.addEventListener("change", () => {
      const job = findJob(id);
      if (job) job.coating = coatingSel.value;
      recompute();
      saveAssignment(id, { coating: coatingSel.value }, flash);
    });
  }
  if (baseSel) {
    baseSel.addEventListener("change", () => {
      const job = findJob(id);
      if (job) job.baseColor = baseSel.value || null;
      baseSel.classList.toggle("warn", !baseSel.value);
      saveAssignment(id, { baseColor: baseSel.value }, flash);
    });
  }
}

function findJob(id) {
  for (const g of schedule.classes) {
    const j = g.jobs.find((x) => x.id === id);
    if (j) return j;
  }
  return null;
}

async function loadSchedule() {
  const list = $("schedule-list");
  list.innerHTML = `<div class="loading">Loading schedule…</div>`;
  try {
    const q = schedule.weekStart ? `?week=${schedule.weekStart}` : "";
    const data = await (await fetch(`/api/schedule${q}`)).json();
    schedule.classes = data.classes;
    // The server snaps any date to its Sunday–Saturday week; keep the canonical start.
    schedule.weekStart = data.weekStart;
    updateWeekBar(data.weekStart, data.weekEnd);
    $("week-label").textContent = `Week of ${data.weekStart} – ${data.weekEnd} · ${data.jobCount} jobs`;
    renderSchedule();
  } catch (err) {
    list.innerHTML = `<div class="empty">Couldn't load the schedule.</div>`;
  }
}

function goToWeek(weekStart) {
  schedule.weekStart = weekStart;
  loadSchedule();
}

// ─────────────────────────── Export week to .xlsx ───────────────────────────
const EXPORT_HEAD = [
  "Day", "Job #", "Customer / Job", "Type", "Class", "First", "Second", "Third",
  "SQFT", "Color", "Base", "Material", "Flake lbs", "Flake boxes (40 lb)",
  "Base A gal", "Base B gal", "Top A gal", "Top B gal",
  "Rubber bags (50 lb)", "Binder (5-gal)", "Primer (5-gal)", "Notes",
];
const EXPORT_COLS = [
  { wch: 9 }, { wch: 9 }, { wch: 34 }, { wch: 15 }, { wch: 14 }, { wch: 14 },
  { wch: 14 }, { wch: 14 }, { wch: 7 }, { wch: 13 }, { wch: 7 }, { wch: 16 },
  { wch: 9 }, { wch: 11 }, { wch: 9 }, { wch: 9 }, { wch: 9 }, { wch: 9 },
  { wch: 14 }, { wch: 11 }, { wch: 11 }, { wch: 50 },
];

function exportJobRow(job) {
  const hasCustomer = job.customer && job.customer !== "—";
  const label = hasCustomer ? job.customer : job.description || `Job #${job.jobNumber}`;
  const v = matValues(job.material);
  const n = (x) => (x === null ? "" : x);
  const members = job.crewMembers || [];
  const third = [members[2], ...members.slice(3)].filter(Boolean).join(" / ");
  const typeLabel = job.projectType + (job.status ? ` (${job.status})` : "");
  return [
    job.dayLabel || "", job.jobNumber, label, typeLabel,
    job.className, members[0] || "", members[1] || "", third,
    job.sqft ?? "", job.color || "", job.baseColor || "",
    job.material.applies ? job.material.flake || "" : "",
    n(v.lbs), n(v.box), n(v.bca), n(v.bcb), n(v.tca), n(v.tcb), n(v.bags), n(v.bind), n(v.prim),
    job.description || "",
  ];
}

function exportTotalsRow(label, jobs) {
  const t = computeClassTotals(jobs);
  return [
    label, "", "", "", "", "", "", "", t.sqft, "", "", "",
    r2(t.lbs), r2(t.box), r2(t.bca), r2(t.bcb), r2(t.tca), r2(t.tcb),
    r2(t.bags), r2(t.bind), r2(t.prim), "",
  ];
}

// Per-color material rollup: the PM stages one pallet per crew, pulling
// colored flake boxes / rubber bags — so totals must be by color, not lumped.
function colorBreakdown(jobs) {
  const flake = new Map(); // color -> { lbs, boxes }
  const rubber = new Map(); // color -> bags
  const polyurea = new Map(); // base color (Grey/Tan/Black) -> { a, b }
  const liquids = { tca: 0, tcb: 0, bind: 0, prim: 0 };
  for (const j of jobs) {
    const m = j.material;
    if (m.kind === "flake") {
      const key = m.flake || "No color set";
      const e = flake.get(key) || { lbs: 0, boxes: 0 };
      e.lbs += m.flakePounds;
      e.boxes += m.flakeBoxes;
      flake.set(key, e);
      const base = j.baseColor || "No base set";
      const pu = polyurea.get(base) || { a: 0, b: 0 };
      pu.a += m.basecoatAGallons;
      pu.b += m.basecoatBGallons;
      polyurea.set(base, pu);
      liquids.tca += m.topcoatAGallons;
      liquids.tcb += m.topcoatBGallons;
    } else if (m.kind === "rubber") {
      const key = m.flake || "No color set";
      rubber.set(key, (rubber.get(key) || 0) + m.rubberBags);
      liquids.bind += m.binderBuckets;
      liquids.prim += m.primerBuckets;
    }
  }
  return { flake, rubber, polyurea, liquids };
}

function stagingRows(title, jobs) {
  const b = colorBreakdown(jobs);
  const rows = [[], [title]];
  if (b.flake.size) {
    rows.push(["FLAKE BY COLOR", "", "Lbs", "Boxes (40 lb)"]);
    for (const [color, e] of [...b.flake].sort((x, y) => x[0].localeCompare(y[0]))) {
      rows.push([color, "", r2(e.lbs), r2(e.boxes), e.lbs > 0 ? "" : "⚠ SQFT missing on job"]);
    }
  }
  if (b.rubber.size) {
    rows.push(["RUBBER BY COLOR", "", "Bags (50 lb)"]);
    for (const [color, bags] of [...b.rubber].sort((x, y) => x[0].localeCompare(y[0]))) {
      rows.push([color, "", r2(bags), "", bags > 0 ? "" : "⚠ SQFT missing on job"]);
    }
  }
  if (b.polyurea.size) {
    rows.push(["POLYUREA BASE BY COLOR", "", "Part A (gal)", "Part B (gal)"]);
    for (const [base, pu] of [...b.polyurea].sort((x, y) => x[0].localeCompare(y[0]))) {
      rows.push([base, "", r2(pu.a), r2(pu.b), base === "No base set" ? "⚠ pick Grey/Tan/Black" : ""]);
    }
  }
  const liquids = [
    ["Polyaspartic Top A (gal)", b.liquids.tca],
    ["Polyaspartic Top B (gal)", b.liquids.tcb],
    ["Binder (5-gal kits)", b.liquids.bind],
    ["Primer (5-gal kits)", b.liquids.prim],
  ].filter(([, v]) => v > 0);
  if (liquids.length) {
    rows.push(["LIQUIDS"]);
    for (const [label, v] of liquids) rows.push([label, "", r2(v)]);
  }
  return rows;
}

function sheetName(name, used) {
  let base = String(name || "Unassigned").replace(/[\\\/\?\*\[\]:]/g, " ").trim().slice(0, 28) || "Sheet";
  let candidate = base;
  let i = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${base} ${i++}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

function exportWeek() {
  if (typeof XLSX === "undefined") {
    toast("Spreadsheet writer didn't load — check your connection.", "error");
    return;
  }
  // Export follows the selected class chip: pick Dallas, export Dallas.
  const cls = schedule.activeClass;
  const groups = schedule.classes.filter(
    (g) => cls === "all" || g.className === cls
  );
  const allJobs = groups.flatMap((g) => g.jobs);
  if (!allJobs.length) {
    toast("Nothing to export for this selection.", "error");
    return;
  }
  const clsLabel = cls === "all" ? "" : ` — ${cls}`;
  const weekLabel = `Week of ${schedule.weekStart}`;
  const wb = XLSX.utils.book_new();
  const used = new Set();

  // Sheet 1 — schedule for the selection, with per-class per-color staging.
  const rows = [[`Weekly Schedule — ${weekLabel}${clsLabel}`], [], EXPORT_HEAD];
  for (const g of groups) {
    rows.push([`${g.className} — ${g.jobs.length} job${g.jobs.length === 1 ? "" : "s"}`]);
    for (const j of g.jobs) rows.push(exportJobRow(j));
    rows.push(exportTotalsRow(`${g.className} totals`, g.jobs));
    rows.push(...stagingRows(`${g.className} — material staging by color`, g.jobs));
    rows.push([]);
  }
  if (groups.length > 1) rows.push(exportTotalsRow("WEEK TOTALS", allJobs));
  const wsAll = XLSX.utils.aoa_to_sheet(rows);
  wsAll["!cols"] = EXPORT_COLS;
  XLSX.utils.book_append_sheet(wb, wsAll, sheetName("Schedule", used));

  // One printable sheet per crew.
  const byCrew = new Map();
  for (const j of allJobs) {
    const crew = (j.crewMembers && j.crewMembers[0]) || "Unassigned";
    if (!byCrew.has(crew)) byCrew.set(crew, []);
    byCrew.get(crew).push(j);
  }
  const crews = [...byCrew.keys()].sort((a, b) =>
    a === "Unassigned" ? 1 : b === "Unassigned" ? -1 : a.localeCompare(b)
  );
  for (const crew of crews) {
    const jobs = byCrew.get(crew).slice().sort((a, b) => (a.scheduledDate ?? 0) - (b.scheduledDate ?? 0));
    const crewRows = [
      [`Crew: ${crew}`],
      [`${weekLabel}${clsLabel} · ${jobs.length} job${jobs.length === 1 ? "" : "s"}`],
      ["Primer kit = 3.5 gal binder + 1.5 gal alcohol spirits (5-gal kit covers 700 sqft)"],
      [],
      EXPORT_HEAD,
      ...jobs.map(exportJobRow),
      [],
      exportTotalsRow("Crew totals", jobs),
      ...stagingRows("PALLET — stage this material by color", jobs),
    ];
    const ws = XLSX.utils.aoa_to_sheet(crewRows);
    ws["!cols"] = EXPORT_COLS;
    XLSX.utils.book_append_sheet(wb, ws, sheetName(crew, used));
  }

  const clsSlug = cls === "all" ? "" : "-" + cls.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  XLSX.writeFile(wb, `schedule-${schedule.weekStart}${clsSlug}.xlsx`);
  toast(cls === "all" ? "Exported all classes." : `Exported ${cls}.`, "success");
}

// ─────────────────────────── Work orders ───────────────────────────
async function refreshWoStatus() {
  try {
    const s = await (await fetch("/api/workorders")).json();
    const total = (s.count || 0) + (s.manualCount || 0);
    if (total > 0) {
      $("wo-status").innerHTML = `<strong>${total} work orders</strong>${
        s.uploadedAt ? " · uploaded " + fmtDate(s.uploadedAt) : ""
      }${s.manualCount ? ` · ${s.manualCount} added by hand` : ""}`;
      $("wo-clear").hidden = false;
      $("wo-upload-label").textContent = "Replace WOs";
    } else {
      $("wo-status").textContent = "No work orders loaded.";
      $("wo-clear").hidden = true;
      $("wo-upload-label").textContent = "Upload WOs";
    }
  } catch {
    /* non-fatal */
  }
}

async function handleWoFile(file) {
  if (!file) return;
  if (typeof XLSX === "undefined") {
    toast("Spreadsheet reader didn't load — check your connection.", "error");
    return;
  }
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array", cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, blankrows: false });
    const res = await fetch("/api/workorders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: file.name, rows }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || "Upload failed.");
    toast(`Loaded ${data.count} work orders ✓`, "success");
  } catch (err) {
    toast(err.message || "Couldn't read that file.", "error");
  } finally {
    $("wo-file").value = "";
    await refreshWoStatus();
    await loadSchedule();
  }
}

function openWoDialog() {
  const sel = $("wo-class");
  const classes = schedule.classes.map((g) => g.className);
  const all = classes.length ? classes : state.classes;
  sel.innerHTML = (all.length ? all : ["Unassigned"])
    .map((c) => `<option>${escapeHtml(c)}</option>`)
    .join("");
  $("wo-date").value = $("week-date").value || new Date().toISOString().slice(0, 10);
  $("wo-dialog").showModal();
}

async function submitWoDialog(e) {
  e.preventDefault();
  try {
    const res = await fetch("/api/workorders/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client: $("wo-client").value.trim(),
        className: $("wo-class").value,
        date: $("wo-date").value,
        type: $("wo-type").value,
        city: $("wo-city").value.trim() || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || "Couldn't add work order.");
    $("wo-dialog").close();
    $("wo-form").reset();
    toast("Work order added ✓", "success");
    await refreshWoStatus();
    await loadSchedule();
  } catch (err) {
    toast(err.message || "Couldn't add work order.", "error");
  }
}

async function clearWorkOrders() {
  if (!confirm("Remove all work orders (uploaded and added)?")) return;
  await fetch("/api/workorders", { method: "DELETE" });
  toast("Work orders cleared.", "success");
  await refreshWoStatus();
  await loadSchedule();
}

// ─────────────────────────── Pipeline upload ───────────────────────────
let dataSource = "sample";

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

async function refreshPipelineStatus() {
  const statusEl = $("pipeline-status");
  const clearBtn = $("pipeline-clear");
  try {
    const { pipeline } = await (await fetch("/api/pipeline")).json();
    if (pipeline) {
      dataSource = "pipeline";
      statusEl.innerHTML = `<strong>${pipeline.rowCount} jobs</strong> from uploaded pipeline${
        pipeline.uploadedAt ? " · " + fmtDate(pipeline.uploadedAt) : ""
      }`;
      clearBtn.hidden = false;
      $("upload-label").textContent = "Replace";
      $("sample-banner").hidden = true;
    } else {
      clearBtn.hidden = true;
      $("upload-label").textContent = "Upload pipeline";
      if (dataSource === "live") {
        statusEl.textContent = "Connected to Builder Prime.";
      } else {
        statusEl.innerHTML = "No pipeline uploaded — showing sample jobs.";
      }
    }
  } catch {
    statusEl.textContent = "";
  }
}

async function handlePipelineFile(file) {
  if (!file) return;
  const label = document.querySelector(".btn-upload");
  if (typeof XLSX === "undefined") {
    toast("Spreadsheet reader didn't load — check your connection.", "error");
    return;
  }
  label.classList.add("busy");
  $("upload-label").textContent = "Reading…";
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array", cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, blankrows: false });

    const res = await fetch("/api/pipeline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: file.name, rows }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || "Upload failed.");

    toast(`Loaded ${data.pipeline.rowCount} jobs ✓`, "success");
    await refreshPipelineStatus();
    await loadSchedule();
  } catch (err) {
    toast(err.message || "Couldn't read that file.", "error");
  } finally {
    label.classList.remove("busy");
    $("pipeline-file").value = "";
    await refreshPipelineStatus();
  }
}

async function clearPipeline() {
  if (!confirm("Remove the uploaded pipeline and go back to sample data?")) return;
  try {
    await fetch("/api/pipeline", { method: "DELETE" });
    dataSource = "sample";
    toast("Pipeline cleared.", "success");
    await refreshPipelineStatus();
    await loadSchedule();
  } catch {
    toast("Couldn't clear the pipeline.", "error");
  }
}

// ─────────────────────────── Roster ───────────────────────────
const ROLE_DEFAULT_HOURLY = { First: 24, Second: 22, Third: 20, Floater: 20 };
let rosterCache = [];

function fillRosterDatalist() {
  $("roster-list-dl").innerHTML = rosterCache
    .filter((r) => r.active)
    .map((r) => `<option value="${escapeHtml(r.name)}"></option>`)
    .join("");
}

async function loadRoster() {
  try {
    const { roster } = await (await fetch("/api/roster")).json();
    rosterCache = roster || [];
  } catch {
    rosterCache = [];
  }
  fillRosterDatalist();
  renderRoster();
}

function renderRoster() {
  const box = $("roster-list");
  if (!box) return;
  if (!rosterCache.length) {
    box.innerHTML = `<div class="empty">No reps yet — add your installers above.</div>`;
    return;
  }
  const byClass = new Map();
  for (const r of rosterCache) {
    if (!byClass.has(r.className)) byClass.set(r.className, []);
    byClass.get(r.className).push(r);
  }
  box.innerHTML = [...byClass.entries()]
    .map(
      ([cls, reps]) => `
      <div class="card">
        <h2 class="history-title">${escapeHtml(cls)} <span class="count">${reps.length}</span></h2>
        ${reps
          .map(
            (r) => `
          <div class="roster-row${r.active ? "" : " inactive"}" data-id="${escapeHtml(r.id)}">
            <span class="ros-name">${escapeHtml(r.name)}</span>
            <select class="ros-role">
              ${["First", "Second", "Third", "Floater"]
                .map((role) => `<option${r.role === role ? " selected" : ""}>${role}</option>`)
                .join("")}
            </select>
            <span class="ros-rate">$<input class="ros-hourly" type="number" min="0" step="0.5" value="${r.hourlyRate}" />/hr</span>
            <button class="ros-remove" type="button" title="Remove">✕</button>
          </div>`
          )
          .join("")}
      </div>`
    )
    .join("");

  box.querySelectorAll(".roster-row").forEach((row) => {
    const id = row.dataset.id;
    const rep = rosterCache.find((r) => r.id === id);
    const save = () =>
      fetch("/api/roster", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rep),
      }).then(fillRosterDatalist);
    row.querySelector(".ros-role").addEventListener("change", (e) => {
      rep.role = e.target.value;
      rep.hourlyRate = ROLE_DEFAULT_HOURLY[rep.role] ?? rep.hourlyRate;
      row.querySelector(".ros-hourly").value = rep.hourlyRate;
      save();
    });
    row.querySelector(".ros-hourly").addEventListener("input", (e) => {
      rep.hourlyRate = Number(e.target.value) || 0;
      debounce("ros-" + id, save);
    });
    row.querySelector(".ros-remove").addEventListener("click", async () => {
      if (!confirm(`Remove ${rep.name} from the roster?`)) return;
      await fetch(`/api/roster/${encodeURIComponent(id)}`, { method: "DELETE" });
      loadRoster();
    });
  });
}

function fillRosterClassSelect() {
  const sel = $("ros-class");
  const classes = state.classes.length
    ? state.classes
    : schedule.classes.map((g) => g.className);
  sel.innerHTML = (classes.length ? classes : ["Unassigned"])
    .map((c) => `<option>${escapeHtml(c)}</option>`)
    .join("");
}

async function submitRosterForm(e) {
  e.preventDefault();
  const role = $("ros-role").value;
  const hourlyRaw = $("ros-hourly").value;
  try {
    const res = await fetch("/api/roster", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: $("ros-name").value.trim(),
        className: $("ros-class").value,
        role,
        hourlyRate: hourlyRaw === "" ? undefined : Number(hourlyRaw),
      }),
    });
    if (!res.ok) throw new Error((await res.json()).message || "Couldn't add.");
    $("ros-name").value = "";
    $("ros-hourly").value = "";
    toast("Rep added ✓", "success");
    loadRoster();
  } catch (err) {
    toast(err.message || "Couldn't add rep.", "error");
  }
}

// ─────────────────────────── Performance pay ───────────────────────────
let payClass = localStorage.getItem("payClass") || "";
let payData = null;

function renderPayChips() {
  const bar = $("pay-class-chips");
  const classes = state.classes.length
    ? state.classes
    : schedule.classes.map((g) => g.className);
  if (!classes.includes(payClass)) payClass = classes[0] || "";
  bar.innerHTML = classes
    .map(
      (c) => `
      <button type="button" class="chip-btn ${payClass === c ? "active" : ""}" data-class="${escapeHtml(c)}">
        ${escapeHtml(c)}
      </button>`
    )
    .join("");
  bar.querySelectorAll(".chip-btn").forEach((b) =>
    b.addEventListener("click", () => {
      payClass = b.dataset.class;
      localStorage.setItem("payClass", payClass);
      renderPayChips();
      loadPay();
    })
  );
}

function payEmployeeRows(crew) {
  return crew.employees
    .map(
      (e) => `
      <tr>
        <td>${escapeHtml(e.name)}${e.onRoster ? "" : ' <span class="ros-warn" title="Not on roster — role guessed from slot">⚠</span>'}</td>
        <td>${escapeHtml(e.position)}</td>
        <td class="num">${(e.pct * 100).toFixed(0)}%</td>
        <td class="num">${e.bonus === null ? (e.role === "First" ? "—" : "N/A") : "$" + fmtN(e.bonus)}</td>
        <td class="num"><strong>$${fmtN(e.commission)}</strong></td>
      </tr>`
    )
    .join("");
}

function renderPay() {
  const box = $("pay-content");
  if (!payData) {
    box.innerHTML = `<div class="empty">No pay data.</div>`;
    return;
  }
  $("pay-week-range").textContent = `${fmtWeekDay(payData.weekStart)} – ${fmtWeekDay(payData.weekEnd)}`;
  const blocks = [];
  payData.crews.forEach((crew, i) => {
    blocks.push(`
      <div class="card pay-crew">
        <h2 class="history-title">Crew #${i + 1} — ${escapeHtml(crew.crewName)}</h2>
        <table class="pay-table">
          <thead><tr><th>Day</th><th>Job #</th><th>Customer</th><th class="num">Contracted</th><th class="num">Crews</th></tr></thead>
          <tbody>
            ${crew.jobs
              .map(
                (j) => `
              <tr>
                <td>${escapeHtml(j.dayLabel || "—")}</td>
                <td>${escapeHtml(j.jobNumber)}</td>
                <td class="pay-cust">${escapeHtml(j.customer)}</td>
                <td class="num">$${fmtN(j.amount)}</td>
                <td class="num">${j.crews}</td>
              </tr>`
              )
              .join("")}
            <tr class="pay-total"><td colspan="3">TOTAL CONTRACTED</td><td class="num">$${fmtN(crew.totalContracted)}</td><td></td></tr>
          </tbody>
        </table>
        <table class="pay-table pay-emps">
          <thead><tr><th>Employee</th><th>Position</th><th class="num">%</th><th class="num">Bonus</th><th class="num">Commission</th></tr></thead>
          <tbody>${payEmployeeRows(crew)}</tbody>
        </table>
      </div>`);
  });
  if (payData.unassigned.length) {
    blocks.push(`
      <div class="card pay-crew warn-card">
        <h2 class="history-title">⚠ Jobs with no crew assigned</h2>
        <p class="card-help">Assign crews on the Schedule tab so these count toward pay.</p>
        ${payData.unassigned
          .map((j) => `<div class="history-row"><span>${escapeHtml(j.dayLabel || "—")} · #${escapeHtml(j.jobNumber)}</span><span class="history-class">${escapeHtml(j.customer)}</span><strong>$${fmtN(j.amount)}</strong></div>`)
          .join("")}
      </div>`);
  }
  if (!blocks.length) {
    blocks.push(`<div class="empty">No payable jobs this week for ${escapeHtml(payClass)}.</div>`);
  }
  box.innerHTML = blocks.join("");
}

async function loadPay() {
  if (!payClass) {
    renderPayChips();
    if (!payClass) return;
  }
  const box = $("pay-content");
  box.innerHTML = `<div class="loading">Calculating…</div>`;
  try {
    const q = schedule.weekStart ? `week=${schedule.weekStart}&` : "";
    const res = await fetch(`/api/pay?${q}class=${encodeURIComponent(payClass)}`);
    if (!res.ok) throw new Error("load failed");
    payData = await res.json();
    schedule.weekStart = payData.weekStart;
    renderPay();
  } catch {
    box.innerHTML = `<div class="empty">Couldn't calculate pay.</div>`;
  }
}

// PFP worksheet export — matches the admin's Performance Pay Worksheet layout.
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function payDateFromWeekEnd(weekEnd) {
  const ms = Date.parse(`${weekEnd}T00:00:00Z`) + 6 * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

function pfpCrewBlock(crew, index, meta) {
  const rows = [];
  const metaCol = (label, value) => (index === 0 ? ["", label, value] : []);
  rows.push(["", `CREW #${index + 1}`, "", "", "", "", "", "", "", "", ...metaCol("Pay period start date:", meta.weekStart)]);
  rows.push(["", "", "Job Number", "Contracted Amount", "Notes", "", "Lead Daily Pay", "Tech 1 Daily Pay", "Tech 2 Daily Pay", "Rain outs/additonal pay", ...metaCol("Pay period end date:", meta.weekEnd)]);
  let metaRow = 0;
  const extraMeta = [["Pay Date:", meta.payDate], ["Employee phone:", ""], ["Employee Email:", ""]];
  for (let d = 0; d < 7; d++) {
    const dayJobs = crew.jobs.filter((j) => j.dayIndex === d);
    const tail = index === 0 && metaRow < extraMeta.length ? ["", ...extraMeta[metaRow++]] : [];
    if (!dayJobs.length) {
      rows.push(["", DAY_NAMES[d], "", "", "", "", 0, 0, 0, "", ...tail]);
    } else {
      dayJobs.forEach((j, k) => {
        const note = j.dayLabel && j.dayLabel.includes("–") ? `${j.dayLabel} job` : j.crews === 2 ? "2 crews" : "";
        const t = k === 0 ? tail : [];
        rows.push(["", k === 0 ? DAY_NAMES[d] : "", j.jobNumber, j.amount, note, "", j.leadDailyPay, j.tech1DailyPay, j.tech2DailyPay, "", ...t]);
      });
    }
  }
  const totals = crew.jobs.reduce(
    (t, j) => ({ lead: t.lead + j.leadDailyPay, t1: t.t1 + j.tech1DailyPay, t2: t.t2 + j.tech2DailyPay }),
    { lead: 0, t1: 0, t2: 0 }
  );
  rows.push(["", "TOTAL CONTRACTED:", "", crew.totalContracted, "Totals:", "", r2(totals.lead), r2(totals.t1), r2(totals.t2), ""]);
  rows.push([]);
  rows.push(["", "Employee Name", "Position", "Commission Percentage", "BONUS PAYOUT", "COMMISSION PAYOUT", "", "", "", "Notes"]);
  for (const e of crew.employees) {
    rows.push(["", e.name, e.position, e.pct, e.bonus === null ? (e.role === "First" ? "FALSE" : "N/A") : e.bonus, e.commission, "", "", "", e.onRoster ? "" : "Not on roster — verify role"]);
  }
  rows.push([]);
  rows.push([]);
  return rows;
}

function exportPay() {
  if (typeof XLSX === "undefined" || !payData) {
    toast("Nothing to export yet.", "error");
    return;
  }
  const meta = {
    weekStart: payData.weekStart,
    weekEnd: payData.weekEnd,
    payDate: payDateFromWeekEnd(payData.weekEnd),
  };
  const rows = [[]];
  payData.crews.forEach((crew, i) => rows.push(...pfpCrewBlock(crew, i, meta)));
  if (!payData.crews.length) rows.push(["", "No crews with payable jobs this week."]);
  if (payData.unassigned.length) {
    rows.push(["", "UNASSIGNED JOBS — assign crews before payroll:"]);
    for (const j of payData.unassigned) {
      rows.push(["", j.dayLabel || "", j.jobNumber, j.amount, j.customer]);
    }
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [
    { wch: 2 }, { wch: 20 }, { wch: 18 }, { wch: 20 }, { wch: 26 }, { wch: 18 },
    { wch: 14 }, { wch: 15 }, { wch: 15 }, { wch: 20 }, { wch: 2 }, { wch: 20 }, { wch: 14 },
  ];
  const wb = XLSX.utils.book_new();
  const md = (iso) => `${Number(iso.slice(5, 7))}${Number(iso.slice(8, 10))}`;
  const sheetTitle = `${payData.className} DG ${md(payData.weekStart)}-${md(payData.weekEnd)}`.slice(0, 31);
  XLSX.utils.book_append_sheet(wb, ws, sheetTitle);
  XLSX.writeFile(wb, `pfp-${payData.className.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${payData.weekStart}.xlsx`);
  toast("Pay sheet exported ✓", "success");
}

// ─────────────────────────── Friday Production Meeting ───────────────────────────
// Weekly checklist: past-due balances, work orders/warranties, pipeline health,
// labor rates, and the Reviews/Lytx/Ramp dashboard checks. Anyone (owner, PM,
// admin) can upload the exports and fill it out; sign-offs record who did.

const MEETING_SECTIONS = [
  { key: "pastdue", n: 1, title: "Past due balances" },
  { key: "workorders", n: 2, title: "Work orders & warranties" },
  { key: "pipeline", n: 3, title: "Production pipeline" },
  { key: "labor", n: 4, title: "Labor rates" },
  { key: "reviews", n: 5, title: "Reviews dashboard" },
  { key: "lytx", n: 6, title: "Lytx incidents" },
  { key: "ramp", n: 7, title: "Ramp spend" },
];

const meeting = {
  week: null,
  view: null,
  // Which <details> stay open across re-renders (sections, classes, items).
  open: new Set(["sec:pastdue"]),
  // Pending payroll-workbook upload awaiting a "use this sheet" pick.
  payroll: null,
};

const fmtMoney0 = (n) => "$" + Math.round(Number(n) || 0).toLocaleString();
const fmtDay = (iso) =>
  new Date(iso + "T12:00:00Z").toLocaleDateString(undefined, {
    weekday: "short",
    month: "numeric",
    day: "numeric",
    timeZone: "UTC",
  });
const fmtMsDate = (ms) =>
  ms ? new Date(ms).toLocaleDateString(undefined, { month: "numeric", day: "numeric", year: "2-digit" }) : "—";

function meetingUser() {
  return $("meeting-user").value.trim();
}

async function meetingApi(path, method, body) {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || "Request failed.");
  return data;
}

async function loadMeeting(week) {
  try {
    const target = week || meeting.week;
    const data = await meetingApi(
      `/api/meeting${target ? `?week=${target}` : ""}`,
      "GET"
    );
    meeting.view = data;
    meeting.week = data.week.weekStart;
    renderMeeting();
  } catch (err) {
    $("meeting-sections").innerHTML = `<div class="empty">${escapeHtml(
      err.message || "Couldn't load the meeting."
    )}</div>`;
  }
}

function renderMeeting() {
  const v = meeting.view;
  if (!v) return;
  $("meeting-week-range").textContent = `${fmtDay(v.week.weekStart)} – ${fmtDay(v.week.weekEnd)}`;
  $("meeting-progress-label").textContent = `${v.doneCount} of ${v.sectionCount} done`;
  $("meeting-progress-fill").style.width =
    Math.round((v.doneCount / v.sectionCount) * 100) + "%";

  const progress = Object.fromEntries(v.sections.map((s) => [s.key, s]));
  const bodies = {
    pastdue: renderPastDueSection(v),
    workorders: renderWorkOrdersSection(v),
    pipeline: renderPipelineSection(v),
    labor: renderLaborSection(v),
    reviews: renderCheckSection(v, "reviews"),
    lytx: renderCheckSection(v, "lytx"),
    ramp: renderCheckSection(v, "ramp"),
  };
  const subs = {
    pastdue: pastDueSubtitle(v.pastDue),
    workorders: `${v.workOrders.totalOpen} open · ${v.workOrders.totalCompleted} done`,
    pipeline: v.pipeline.available
      ? `${v.pipeline.noStartDate.length} no date · ${v.pipeline.noCrew.length} no crew`
      : "no pipeline loaded",
    labor: v.labor.rows.length
      ? v.labor.rows
          .filter((r) => r.rate !== null)
          .map((r) => `${r.className.slice(0, 3)} ${r.rate.toFixed(1)}×`)
          .join(" · ") || "enter payroll"
      : "upload completed jobs",
    reviews: v.checks.reviews.status === "done" ? "reviewed" : "needs review",
    lytx: v.checks.lytx.status === "done" ? "reviewed" : "needs review",
    ramp: v.checks.ramp.status === "done" ? "reviewed" : "needs review",
  };

  $("meeting-sections").innerHTML = MEETING_SECTIONS.map((s) => {
    const p = progress[s.key] ?? { done: false, manual: null };
    const openKey = `sec:${s.key}`;
    return `
    <details class="card mtg-section${p.done ? " done" : ""}" data-open="${openKey}" ${
      meeting.open.has(openKey) ? "open" : ""
    }>
      <summary>
        <span class="mtg-num${p.done ? " ok" : ""}">${p.done ? "✓" : s.n}</span>
        <span class="mtg-head">
          <span class="mtg-title">${escapeHtml(s.title)}</span>
          <span class="mtg-sub">${escapeHtml(subs[s.key] || "")}</span>
        </span>
        <span class="mtg-chev">▾</span>
      </summary>
      <div class="mtg-body">
        ${bodies[s.key]}
        ${renderSignOff(s.key, p)}
      </div>
    </details>`;
  }).join("");
}

function renderSignOff(key, p) {
  const who = p.manual?.by ? ` by ${escapeHtml(p.manual.by)}` : "";
  const when = p.manual?.at ? ` · ${fmtDate(p.manual.at)}` : "";
  return `
  <label class="mtg-signoff${p.manual?.done ? " signed" : ""}">
    <input type="checkbox" data-sec="${key}" ${p.manual?.done ? "checked" : ""} />
    <span>${
      p.manual?.done
        ? `Section signed off${who}${when}`
        : p.autoDone
        ? "Looks complete — tap to sign off"
        : "Mark this section done"
    }</span>
  </label>`;
}

// ── §1 Past due ──
function pastDueSubtitle(pd) {
  if (!pd.meta) return "upload the export";
  const bits = [`${pd.openCount} open`];
  if (pd.carryoverCount) bits.push(`${pd.carryoverCount} carried over`);
  if (pd.needsInfoCount) bits.push(`${pd.needsInfoCount} need reason/owner`);
  return bits.join(" · ");
}

function renderPastDueSection(v) {
  const pd = v.pastDue;
  let html = `
  <div class="pipeline-bar">
    <div class="pipeline-status">${
      pd.meta
        ? `<strong>${escapeHtml(pd.meta.sourceLabel || pd.meta.filename || "Unpaid invoices")}</strong> · uploaded ${fmtDate(pd.meta.uploadedAt)}`
        : "Upload the Builder Prime <strong>Unpaid Invoices</strong> export to start."
    }</div>
    <div class="pipeline-actions">
      <label class="btn-upload"><span>Upload past due</span>
        <input type="file" accept=".xlsx,.xls" data-upload="pastdue" hidden />
      </label>
    </div>
  </div>
  <p class="card-help">Every open balance needs a <b>reason</b> and an <b>owner</b>.
  Carried-over items need this week's update. Set an install/action date to put
  it on the owner's Google Calendar.</p>`;

  if (pd.likelyResolved.length) {
    html += `<div class="mtg-resolved-hint">
      <b>${pd.likelyResolved.length} item${pd.likelyResolved.length === 1 ? "" : "s"} no longer in the latest export</b> — probably paid. Confirm:
      ${pd.likelyResolved
        .map(
          (f) => `<div class="mtg-resolve-row">
            <span>${escapeHtml(f.client)} · ${fmtMoney0(f.balance)}</span>
            <button type="button" class="btn-export" data-act="fu-resolve" data-fu="${escapeHtml(f.invoiceNumber)}">Mark resolved ✓</button>
          </div>`
        )
        .join("")}
    </div>`;
  }

  if (!pd.classes.length) {
    html += `<div class="empty small">No past-due follow-ups yet.</div>`;
    return html;
  }

  for (const group of pd.classes) {
    const openKey = `pdc:${group.className}`;
    const openItems = group.items.filter((i) => i.status === "open");
    html += `
    <details class="mtg-class" data-open="${openKey}" ${meeting.open.has(openKey) ? "open" : ""}>
      <summary>
        <span class="mtg-class-name">${escapeHtml(group.className)}</span>
        <span class="mtg-class-info">${openItems.length} open · ${fmtMoney0(group.totalBalance)}</span>
      </summary>
      ${group.items.map((f) => renderFollowUp(f, v.week.weekStart)).join("")}
    </details>`;
  }
  return html;
}

function renderFollowUp(f, weekStart) {
  const openKey = `fu:${f.invoiceNumber}`;
  const badges = [];
  if (f.status === "resolved") badges.push(`<span class="mtg-badge ok">resolved</span>`);
  else {
    if (f.firstSeenWeek === weekStart) badges.push(`<span class="mtg-badge new">new</span>`);
    if (f.carriedOver)
      badges.push(
        `<span class="mtg-badge ${f.updatedThisWeek ? "ok" : "warn"}">carryover${
          f.updatedThisWeek ? " ✓" : " — needs update"
        }</span>`
      );
    if (!f.reason || !f.owner) badges.push(`<span class="mtg-badge warn">needs reason/owner</span>`);
  }
  const inv = escapeHtml(f.invoiceNumber);
  const updates = f.updates
    .slice()
    .reverse()
    .slice(0, 6)
    .map(
      (u) =>
        `<div class="mtg-update"><span class="mtg-update-week">${escapeHtml(u.week)}</span> ${escapeHtml(u.note)}${
          u.by ? ` <i>— ${escapeHtml(u.by)}</i>` : ""
        }</div>`
    )
    .join("");

  return `
  <details class="fu-item${f.status === "resolved" ? " resolved" : ""}" data-open="${openKey}" ${
    meeting.open.has(openKey) ? "open" : ""
  }>
    <summary>
      <span class="fu-client">${escapeHtml(f.client)}</span>
      <span class="fu-badges">${badges.join("")}</span>
      <span class="fu-balance">${fmtMoney0(f.balance)}</span>
    </summary>
    <div class="fu-body">
      <p class="fu-meta">
        Inv #${inv}${f.projectName ? " · " + escapeHtml(f.projectName) : ""}
        ${f.projectStatus ? `<br/>Status: ${escapeHtml(f.projectStatus)}` : ""}
        · Due ${fmtMsDate(f.dueDate)}${f.age !== null ? ` · ${f.age} days past` : ""}
      </p>
      <label class="dlg-field">Why is it past due?
        <input type="text" maxlength="500" value="${escapeHtml(f.reason)}" placeholder="e.g. waiting on financing, install not scheduled…" data-fu="${inv}" data-field="reason" />
      </label>
      <div class="fu-grid">
        <label class="dlg-field">Owner
          <input type="text" maxlength="120" list="roster-list-dl" value="${escapeHtml(f.owner)}" placeholder="Who owns this?" data-fu="${inv}" data-field="owner" />
        </label>
        <label class="dlg-field">Owner email (for calendar)
          <input type="email" maxlength="200" value="${escapeHtml(f.ownerEmail)}" placeholder="name@company.com" data-fu="${inv}" data-field="ownerEmail" />
        </label>
      </div>
      <div class="fu-grid">
        <label class="dlg-field">Action / install date
          <input type="date" value="${escapeHtml(f.actionDate || "")}" data-fu="${inv}" data-field="actionDate" />
        </label>
        <div class="fu-cal">${
          f.actionDate
            ? `<a class="btn-export" target="_blank" rel="noopener" href="${gcalUrl(f)}">📅 Add to owner's calendar</a>`
            : `<span class="hint">Set a date to create a calendar event.</span>`
        }</div>
      </div>
      <div class="fu-note-row">
        <input type="text" maxlength="1000" placeholder="This week's update…" data-note-for="${inv}" />
        <button type="button" class="btn-export" data-act="fu-note" data-fu="${inv}">Add update</button>
      </div>
      ${updates ? `<div class="mtg-updates">${updates}</div>` : ""}
      <div class="fu-actions">
        ${
          f.status === "open"
            ? `<button type="button" class="btn btn-primary" data-act="fu-resolve" data-fu="${inv}">Resolved — collected/closed ✓</button>`
            : `<button type="button" class="btn btn-secondary" data-act="fu-reopen" data-fu="${inv}">Reopen</button>`
        }
      </div>
    </div>
  </details>`;
}

/** Google Calendar event link for a follow-up's action date (all-day). */
function gcalUrl(f) {
  const start = f.actionDate.replace(/-/g, "");
  const endDate = new Date(f.actionDate + "T00:00:00Z");
  endDate.setUTCDate(endDate.getUTCDate() + 1);
  const end = endDate.toISOString().slice(0, 10).replace(/-/g, "");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: `Past due: ${f.client} — ${fmtMoney0(f.balance)} (Inv #${f.invoiceNumber})`,
    dates: `${start}/${end}`,
    details:
      `${f.projectName || ""}\nReason past due: ${f.reason || "—"}\nOwner: ${f.owner || "—"}` +
      `\nClass: ${f.className}\n\nFrom the Friday Production Meeting checklist.`,
  });
  if (f.ownerEmail) params.set("add", f.ownerEmail);
  return "https://calendar.google.com/calendar/render?" + params.toString();
}

// ── §2 Work orders ──
function renderWorkOrdersSection(v) {
  const wo = v.workOrders;
  let html = `
  <p class="card-help">Work orders come from the <b>Export data</b> upload on the
  Schedule tab${wo.uploadedAt ? ` (last upload ${fmtDate(wo.uploadedAt)})` : ""}.
  Tag each open warranty with the <b>lead</b> whose crew caused it and <b>why</b>.</p>
  <div class="pipeline-bar">
    <div class="pipeline-status">${
      wo.uploadedAt
        ? `<strong>${wo.totalOpen + wo.totalCompleted} work orders</strong> loaded`
        : "No work orders loaded yet."
    }</div>
    <div class="pipeline-actions">
      <label class="btn-upload wo-btn"><span>Upload WOs</span>
        <input type="file" accept=".xlsx,.xls" data-upload="workorders" hidden />
      </label>
    </div>
  </div>`;

  if (wo.classes.length) {
    html += `<table class="mtg-table"><thead><tr><th>Location</th><th>Open</th><th>Open warranty</th><th>Completed</th></tr></thead><tbody>`;
    for (const c of wo.classes) {
      html += `<tr><td>${escapeHtml(c.className)}</td><td>${c.open}</td><td>${
        c.openWarranties
      }</td><td>${c.completed}</td></tr>`;
    }
    html += `</tbody></table>`;
  }

  if (wo.byLead.length) {
    html += `<h3 class="mtg-h3">Warranties by lead</h3>`;
    for (const l of wo.byLead) {
      html += `<div class="mtg-lead-row"><b>${escapeHtml(l.lead)}</b><span class="mtg-lead-count">${
        l.count
      }</span><span class="mtg-lead-causes">${escapeHtml(l.causes.join(" · "))}</span></div>`;
    }
  }
  if (wo.untaggedWarranties > 0) {
    html += `<p class="hint">${wo.untaggedWarranties} warranty WO${
      wo.untaggedWarranties === 1 ? "" : "s"
    } not yet tagged with a lead.</p>`;
  }

  const open = wo.warranties.filter((w) => w.open);
  const closed = wo.warranties.filter((w) => !w.open).slice(0, 30);
  if (open.length) {
    html += `<h3 class="mtg-h3">Open warranty / callback work orders</h3>`;
    html += open.map(renderWarrantyRow).join("");
  } else if (wo.uploadedAt) {
    html += `<div class="empty small">No open warranty work orders. 🎉</div>`;
  }
  if (closed.length) {
    const openKey = "wo:closed";
    html += `
    <details class="mtg-class" data-open="${openKey}" ${meeting.open.has(openKey) ? "open" : ""}>
      <summary><span class="mtg-class-name">Recently completed warranties</span>
        <span class="mtg-class-info">last ${closed.length}</span></summary>
      ${closed.map(renderWarrantyRow).join("")}
    </details>`;
  }
  return html;
}

function renderWarrantyRow(w) {
  const id = escapeHtml(w.id);
  return `
  <div class="mtg-wo${w.open ? "" : " closed"}">
    <div class="mtg-wo-top">
      <span class="mtg-wo-who">#${escapeHtml(w.woNumber)} · ${escapeHtml(w.client)}${
        w.city ? " · " + escapeHtml(w.city) : ""
      }</span>
      <span class="mtg-wo-meta">${escapeHtml(w.className)} · ${escapeHtml(w.type)} · ${escapeHtml(
        w.status || "OPEN"
      )} · ${fmtMsDate(w.createdDate)}</span>
    </div>
    <div class="mtg-wo-tag">
      <input type="text" maxlength="120" list="roster-list-dl" placeholder="Lead responsible" value="${escapeHtml(
        w.lead
      )}" data-wo="${id}" data-field="lead" />
      <input type="text" maxlength="500" placeholder="Why did this happen?" value="${escapeHtml(
        w.cause
      )}" data-wo="${id}" data-field="cause" />
    </div>
  </div>`;
}

// ── §3 Pipeline ──
function renderPipelineSection(v) {
  const p = v.pipeline;
  if (!p.available) {
    return `<p class="card-help">Upload the <b>Production Pipeline Report</b> on the
      Schedule tab to check start dates, labor assignment, and how full the week is.</p>`;
  }
  let html = `<p class="card-help">Checks: jobs with <b>no start date</b>, scheduled
  jobs with <b>no crew assigned</b>, and whether each day this week is under- or
  over-scheduled.</p>`;

  if (p.week.length) {
    html += `<h3 class="mtg-h3">This week's schedule load</h3>`;
    for (const cls of p.week) {
      html += `<div class="mtg-load">
        <div class="mtg-load-head"><b>${escapeHtml(cls.className)}</b>
          <span>${cls.jobsThisWeek} jobs · ${fmtMoney0(cls.totalThisWeek)}</span></div>
        <div class="mtg-days">
          ${cls.days
            .map(
              (d) => `<span class="mtg-day load-${d.load}" title="${escapeHtml(d.date)}">
                <i>${fmtDay(d.date).split(" ")[0]}</i>${d.jobs ? `${d.jobs} · ${fmtMoney0(d.total)}` : "—"}
              </span>`
            )
            .join("")}
        </div>
      </div>`;
    }
  } else {
    html += `<div class="empty small">Nothing scheduled to start this week.</div>`;
  }

  const urgentNoCrew = p.noCrew.filter((j) => j.thisWeek);
  html += renderPipelineList(
    "nocrew",
    `No labor assigned (${p.noCrew.length})`,
    urgentNoCrew.length ? `${urgentNoCrew.length} starting THIS week` : "",
    p.noCrew,
    (j) =>
      `${j.thisWeek ? "🔴 " : ""}#${escapeHtml(j.jobNumber)} · ${escapeHtml(
        j.className
      )} · ${fmtMoney0(j.soldAmount)} · starts ${fmtMsDate(j.startDate)}`
  );
  html += renderPipelineList(
    "nostart",
    `No start date (${p.noStartDate.length})`,
    "",
    p.noStartDate,
    (j) =>
      `#${escapeHtml(j.jobNumber)} · ${escapeHtml(j.className)} · ${fmtMoney0(
        j.soldAmount
      )}${j.salesPerson ? " · " + escapeHtml(j.salesPerson) : ""}`
  );
  return html;
}

function renderPipelineList(key, title, warn, jobs, line) {
  if (!jobs.length) return `<div class="empty small">${escapeHtml(title)}: none 🎉</div>`;
  const openKey = `pl:${key}`;
  const MAX = 60;
  return `
  <details class="mtg-class" data-open="${openKey}" ${meeting.open.has(openKey) ? "open" : ""}>
    <summary><span class="mtg-class-name">${escapeHtml(title)}</span>
      <span class="mtg-class-info warn">${escapeHtml(warn)}</span></summary>
    ${jobs
      .slice(0, MAX)
      .map((j) => `<div class="mtg-line">${line(j)}${j.description ? `<span class="mtg-line-desc">${escapeHtml(j.description)}</span>` : ""}</div>`)
      .join("")}
    ${jobs.length > MAX ? `<div class="hint">…and ${jobs.length - MAX} more.</div>` : ""}
  </details>`;
}

// ── §4 Labor rates ──
function renderLaborSection(v) {
  const lab = v.labor;
  let html = `
  <p class="card-help">Labor rate for <b>last week (${fmtDay(lab.weekStart)} – ${fmtDay(
    lab.weekEnd
  )})</b> = <b>completed revenue ÷ (production payroll × ${lab.multiplier})</b>.
  Upload the <b>Completed Projects</b> report, then enter (or pull from the
  payroll workbook) each location's production payroll for that pay period.</p>
  <div class="pipeline-bar">
    <div class="pipeline-status">${
      lab.uploadedAt
        ? `<strong>${escapeHtml(lab.sourceLabel || "Completed projects")}</strong> · uploaded ${fmtDate(lab.uploadedAt)}`
        : "No completed-projects report uploaded."
    }</div>
    <div class="pipeline-actions">
      <label class="btn-upload"><span>Upload completed</span>
        <input type="file" accept=".xlsx,.xls" data-upload="completed" hidden />
      </label>
      <label class="btn-upload wo-btn"><span>Upload payroll</span>
        <input type="file" accept=".xlsx,.xlsm,.xls" data-upload="payroll" hidden />
      </label>
    </div>
  </div>`;

  if (meeting.payroll) {
    html += `<div class="mtg-payroll-pick">
      <b>Payroll workbook read.</b> Pick the location and the pay-period sheet:
      <select id="mtg-payroll-class">${(v.labor.rows.length
        ? v.labor.rows.map((r) => r.className)
        : ["Austin", "Corpus Christi", "Dallas", "Houston", "San Antonio"]
      )
        .map((c) => `<option>${escapeHtml(c)}</option>`)
        .join("")}</select>
      ${meeting.payroll.sheets
        .slice(0, 8)
        .map(
          (s, i) => `<div class="mtg-resolve-row">
          <span><b>${escapeHtml(s.sheetName)}</b>${
            s.periodStart ? ` · ${escapeHtml(s.periodStart)} → ${escapeHtml(s.periodEnd || "?")}` : ""
          } · ${fmtMoney0(s.productionTotal)} production (${s.employeeCount} ppl)</span>
          <button type="button" class="btn-export" data-act="payroll-use" data-idx="${i}">Use</button>
        </div>`
        )
        .join("")}
      <button type="button" class="btn-clear" data-act="payroll-cancel">Cancel</button>
    </div>`;
  }

  if (!lab.rows.length) {
    html += `<div class="empty small">Upload the completed-projects report to see revenue per location.</div>`;
    return html;
  }

  html += `<div class="mtg-labor">`;
  for (const r of lab.rows) {
    const cls = escapeHtml(r.className);
    const rateHtml =
      r.rate === null
        ? `<span class="hint">enter payroll</span>`
        : `<b class="mtg-rate ${r.rate >= 4 ? "good" : r.rate >= 2.5 ? "mid" : "bad"}">${r.rate.toFixed(2)}×</b>
           <span class="mtg-rate-pct">labor ${(100 / r.rate).toFixed(0)}% of revenue</span>`;
    html += `
    <div class="mtg-labor-row">
      <div class="mtg-labor-head"><b>${cls}</b>${rateHtml}</div>
      <div class="fu-grid">
        <label class="dlg-field">Completed revenue (${r.completedJobs} jobs)
          <input type="number" min="0" step="0.01" inputmode="decimal"
            placeholder="${r.completedRevenue}" value="${r.revenueOverride ?? ""}"
            data-labor="${cls}" data-field="revenueOverride" />
        </label>
        <label class="dlg-field">Production payroll${r.sheetName ? ` <i>(${escapeHtml(r.sheetName)})</i>` : ""}
          <input type="number" min="0" step="0.01" inputmode="decimal"
            placeholder="from payroll sheet" value="${r.productionPayroll ?? ""}"
            data-labor="${cls}" data-field="productionPayroll" />
        </label>
      </div>
    </div>`;
  }
  html += `</div>`;
  return html;
}

// ── §5–7 Dashboard checks ──
const CHECK_COPY = {
  reviews: {
    help: "Log in to the review dashboard and check this week's new reviews.",
    link: "Open review dashboard",
  },
  lytx: {
    help: "Log in to Lytx and review this week's driving incidents.",
    link: "Open Lytx",
  },
  ramp: {
    help: "Log in to Ramp and review this week's spend incidents / flagged transactions.",
    link: "Open Ramp",
  },
};

function renderCheckSection(v, key) {
  const check = v.checks[key];
  const url = v.links[key];
  const copy = CHECK_COPY[key];
  return `
  <p class="card-help">${escapeHtml(copy.help)}</p>
  ${
    url
      ? `<a class="btn-export mtg-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">🔗 ${escapeHtml(copy.link)}</a>`
      : `<p class="hint">Set the dashboard URL in the environment (see README) to get a one-tap link.</p>`
  }
  <label class="dlg-field">What did you find? (incidents, counts, actions)
    <textarea rows="3" maxlength="2000" data-check-notes="${key}" placeholder="e.g. 2 hard-braking events — coached both drivers.">${escapeHtml(
      check.notes
    )}</textarea>
  </label>
  <div class="fu-actions">
    ${
      check.status === "done"
        ? `<button type="button" class="btn btn-secondary" data-act="check-toggle" data-check="${key}">Reviewed ✓ ${
            check.by ? "by " + escapeHtml(check.by) : ""
          } — undo</button>`
        : `<button type="button" class="btn btn-primary" data-act="check-toggle" data-check="${key}">Mark reviewed ✓</button>`
    }
  </div>`;
}

// ── Event handling ──
function meetingToggle(e) {
  const key = e.target?.dataset?.open;
  if (!key) return;
  if (e.target.open) meeting.open.add(key);
  else meeting.open.delete(key);
}

async function meetingChange(e) {
  const t = e.target;
  try {
    if (t.dataset.upload) {
      await handleMeetingUpload(t.dataset.upload, t.files[0]);
      t.value = "";
      return;
    }
    if (t.dataset.fu && t.dataset.field) {
      await meetingApi(`/api/meeting/followups/${encodeURIComponent(t.dataset.fu)}`, "PATCH", {
        week: meeting.week,
        [t.dataset.field]: t.dataset.field === "actionDate" ? t.value || null : t.value,
        by: meetingUser() || undefined,
      });
      await loadMeeting();
      return;
    }
    if (t.dataset.wo && t.dataset.field) {
      const row = t.closest(".mtg-wo");
      const lead = row.querySelector('[data-field="lead"]').value.trim();
      const cause = row.querySelector('[data-field="cause"]').value.trim();
      await meetingApi("/api/meeting/wonote", "PATCH", {
        woId: t.dataset.wo,
        lead,
        cause,
        by: meetingUser() || null,
      });
      await loadMeeting();
      return;
    }
    if (t.dataset.labor && t.dataset.field) {
      const value = t.value === "" ? null : Number(t.value);
      await meetingApi("/api/meeting/labor", "PATCH", {
        week: meeting.week,
        className: t.dataset.labor,
        [t.dataset.field]: value,
        by: meetingUser() || null,
      });
      await loadMeeting();
      return;
    }
    if (t.dataset.checkNotes) {
      await meetingApi("/api/meeting/check", "PATCH", {
        week: meeting.week,
        key: t.dataset.checkNotes,
        notes: t.value,
        by: meetingUser() || undefined,
      });
      return; // no re-render needed for notes
    }
    if (t.dataset.sec) {
      await meetingApi("/api/meeting/section", "PATCH", {
        week: meeting.week,
        key: t.dataset.sec,
        done: t.checked,
        by: meetingUser() || null,
      });
      await loadMeeting();
      return;
    }
  } catch (err) {
    toast(err.message || "Couldn't save.", "error");
  }
}

async function meetingClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  try {
    if (act === "fu-resolve" || act === "fu-reopen") {
      await meetingApi(`/api/meeting/followups/${encodeURIComponent(btn.dataset.fu)}`, "PATCH", {
        week: meeting.week,
        status: act === "fu-resolve" ? "resolved" : "open",
        by: meetingUser() || undefined,
      });
      toast(act === "fu-resolve" ? "Marked resolved ✓" : "Reopened.", "success");
      await loadMeeting();
    } else if (act === "fu-note") {
      const input = document.querySelector(`[data-note-for="${CSS.escape(btn.dataset.fu)}"]`);
      const note = input?.value.trim();
      if (!note) return toast("Type the update first.", "error");
      await meetingApi(`/api/meeting/followups/${encodeURIComponent(btn.dataset.fu)}`, "PATCH", {
        week: meeting.week,
        note,
        by: meetingUser() || undefined,
      });
      toast("Update added ✓", "success");
      await loadMeeting();
    } else if (act === "check-toggle") {
      const key = btn.dataset.check;
      const current = meeting.view.checks[key].status;
      await meetingApi("/api/meeting/check", "PATCH", {
        week: meeting.week,
        key,
        status: current === "done" ? "pending" : "done",
        by: meetingUser() || undefined,
      });
      await loadMeeting();
    } else if (act === "payroll-use") {
      const sheet = meeting.payroll.sheets[Number(btn.dataset.idx)];
      const className = $("mtg-payroll-class").value;
      await meetingApi("/api/meeting/labor", "PATCH", {
        week: meeting.week,
        className,
        productionPayroll: sheet.productionTotal,
        sheetName: sheet.sheetName,
        by: meetingUser() || null,
      });
      meeting.payroll = null;
      toast(`Payroll set for ${className} ✓`, "success");
      await loadMeeting();
    } else if (act === "payroll-cancel") {
      meeting.payroll = null;
      renderMeeting();
    }
  } catch (err) {
    toast(err.message || "Couldn't save.", "error");
  }
}

async function handleMeetingUpload(kind, file) {
  if (!file) return;
  if (typeof XLSX === "undefined") {
    toast("Spreadsheet reader didn't load — check your connection.", "error");
    return;
  }
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  const firstRows = () =>
    XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {
      header: 1,
      raw: true,
      blankrows: false,
    });

  if (kind === "pastdue") {
    const data = await meetingApi("/api/meeting/pastdue", "POST", {
      filename: file.name,
      week: meeting.week,
      rows: firstRows(),
    });
    toast(
      `${data.count} invoices loaded · ${data.newCount} new${
        data.missingCount ? ` · ${data.missingCount} likely paid` : ""
      } ✓`,
      "success"
    );
  } else if (kind === "completed") {
    const data = await meetingApi("/api/meeting/completed", "POST", {
      filename: file.name,
      rows: firstRows(),
    });
    toast(`${data.count} completed jobs loaded ✓`, "success");
  } else if (kind === "workorders") {
    const data = await meetingApi("/api/workorders", "POST", {
      filename: file.name,
      rows: firstRows(),
    });
    toast(`${data.count} work orders loaded ✓`, "success");
  } else if (kind === "payroll") {
    // Payroll workbooks have one sheet per pay period — send them all and let
    // the user pick the right week.
    const sheets = wb.SheetNames.map((name) => ({
      name,
      rows: XLSX.utils.sheet_to_json(wb.Sheets[name], {
        header: 1,
        raw: true,
        blankrows: false,
      }),
    }));
    const data = await meetingApi("/api/meeting/payroll", "POST", {
      week: meeting.week,
      sheets,
    });
    meeting.payroll = { sheets: data.sheets };
    meeting.open.add("sec:labor");
  }
  await loadMeeting();
}

// ─────────────────────────── Navigation ───────────────────────────
const TITLES = {
  schedule: "Weekly Schedule",
  meeting: "Friday Meeting",
  report: "Weekly Report",
  pay: "Performance Pay",
  roster: "Roster",
  projects: "Projects",
};
let reportLoaded = false;

function showScreen(name) {
  for (const s of ["schedule", "meeting", "report", "pay", "roster", "projects"]) {
    $(`screen-${s}`).hidden = s !== name;
  }
  $("screen-title").textContent = TITLES[name];
  $("save-bar").classList.toggle("hidden", name !== "report");
  $("week-label").hidden = name !== "schedule" && name !== "report";
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.screen === name)
  );
  if (name === "projects" && !allProjects.length) loadProjects();
  if (name === "meeting") loadMeeting();
  if (name === "report") {
    if (!reportLoaded) {
      reportLoaded = true;
      loadReportClasses().then(loadReport);
    } else {
      loadReport();
    }
  }
  if (name === "schedule") loadSchedule();
  if (name === "pay") {
    loadReportClasses().then(() => {
      renderPayChips();
      loadPay();
    });
  }
  if (name === "roster") {
    loadReportClasses().then(fillRosterClassSelect);
    loadRoster();
  }
}

// ─────────────────────────── Init ───────────────────────────
async function init() {
  try {
    const cfg = await (await fetch("/api/config")).json();
    state.laborMultiplier = cfg.laborMultiplier ?? 1.2;
    schedule.coverage = cfg.coverage ?? null;
    dataSource = cfg.source ?? "sample";
    $("mult-label").textContent = state.laborMultiplier + "×";
    if (cfg.usingSampleData) $("sample-banner").hidden = false;
    if (cfg.ephemeralStorage) $("storage-warning").hidden = false;
  } catch {
    /* non-fatal */
  }

  $("pipeline-file").addEventListener("change", (e) =>
    handlePipelineFile(e.target.files[0])
  );
  $("pipeline-clear").addEventListener("click", clearPipeline);
  $("wo-file").addEventListener("change", (e) => handleWoFile(e.target.files[0]));
  $("wo-add").addEventListener("click", openWoDialog);
  $("wo-cancel").addEventListener("click", () => $("wo-dialog").close());
  $("wo-form").addEventListener("submit", submitWoDialog);
  $("wo-clear").addEventListener("click", clearWorkOrders);
  await refreshPipelineStatus();
  refreshWoStatus();

  // Live recalc on every report input.
  document.getElementById("report-form").addEventListener("input", recalc);

  $("btn-save").addEventListener("click", () => saveReport(false));
  $("btn-submit").addEventListener("click", () => saveReport(true));

  document.querySelectorAll(".tab").forEach((tab) =>
    tab.addEventListener("click", () => showScreen(tab.dataset.screen))
  );
  $("project-search").addEventListener("input", renderProjects);
  $("include-cancelled").addEventListener("change", loadProjects);
  $("schedule-search").addEventListener("input", renderSchedule);
  $("export-week").addEventListener("click", exportWeek);

  // Pay + roster controls.
  $("pay-prev").addEventListener("click", () => {
    schedule.weekStart = shiftWeekIso(schedule.weekStart || currentWeekStartIso(), -1);
    loadPay();
  });
  $("pay-next").addEventListener("click", () => {
    schedule.weekStart = shiftWeekIso(schedule.weekStart || currentWeekStartIso(), 1);
    loadPay();
  });
  $("pay-export").addEventListener("click", exportPay);
  $("roster-form").addEventListener("submit", submitRosterForm);

  // Friday meeting.
  $("meeting-prev").addEventListener("click", () =>
    loadMeeting(shiftWeekIso(meeting.week || currentWeekStartIso(), -1))
  );
  $("meeting-next").addEventListener("click", () =>
    loadMeeting(shiftWeekIso(meeting.week || currentWeekStartIso(), 1))
  );
  $("meeting-today").addEventListener("click", () => loadMeeting(currentWeekStartIso()));
  $("meeting-user").value = localStorage.getItem("meetingUser") || "";
  $("meeting-user").addEventListener("change", () =>
    localStorage.setItem("meetingUser", meetingUser())
  );
  const meetingRoot = $("meeting-sections");
  meetingRoot.addEventListener("change", meetingChange);
  meetingRoot.addEventListener("click", meetingClick);
  // "toggle" doesn't bubble — listen in the capture phase.
  meetingRoot.addEventListener("toggle", meetingToggle, true);
  loadRoster(); // also fills crew-name suggestions on the schedule

  // Week navigation.
  $("week-prev").addEventListener("click", () =>
    goToWeek(shiftWeekIso(schedule.weekStart || currentWeekStartIso(), -1))
  );
  $("week-next").addEventListener("click", () =>
    goToWeek(shiftWeekIso(schedule.weekStart || currentWeekStartIso(), 1))
  );
  $("week-today").addEventListener("click", () => goToWeek(currentWeekStartIso()));
  $("week-date").addEventListener("change", (e) => {
    if (e.target.value) goToWeek(e.target.value); // server snaps to that week's Sunday
  });

  // Schedule is the default screen.
  await loadColors();
  showScreen("schedule");
}

init();

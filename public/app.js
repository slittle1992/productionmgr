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

  $("week-label").textContent = `Week of ${report.weekStart} – ${report.weekEnd} · ${report.quarter}`;

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

async function loadReport() {
  try {
    const res = await fetch("/api/report");
    if (!res.ok) throw await res.json().catch(() => ({}));
    fillForm(await res.json());
  } catch (err) {
    toast(err.message || "Couldn't load the report.", "error");
  }
}

async function saveReport(submit) {
  const btn = submit ? $("btn-submit") : $("btn-save");
  btn.disabled = true;
  try {
    const res = await fetch("/api/report", {
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

function rowHtml(job) {
  const hasCustomer = job.customer && job.customer !== "—";
  const label = hasCustomer ? job.customer : job.description || `Job #${job.jobNumber}`;
  const tooltip = job.description || label;
  const colorWarn = job.color && !job.colorRecognized ? " warn" : "";
  return `
    <tr class="jobrow" data-id="${escapeHtml(job.id)}">
      <td class="c-day">${escapeHtml((job.scheduledDay || "—").slice(0, 3))}</td>
      <td class="c-jobno">${escapeHtml(job.jobNumber)}</td>
      <td class="c-name" title="${escapeHtml(tooltip)}">${escapeHtml(label)}</td>
      <td class="c-type"><span class="chip ${typeChipClass(job.projectType)}">${escapeHtml(job.projectType)}</span></td>
      <td class="cell-edit"><input class="js-crew" type="text" placeholder="—" value="${escapeHtml(job.crew || "")}" /></td>
      <td class="cell-edit num"><input class="js-sqft" type="number" inputmode="numeric" min="0" value="${job.sqft ?? ""}" placeholder="—" /></td>
      <td class="cell-edit"><input class="js-color${colorWarn}" list="color-list" type="text" value="${escapeHtml(job.color || "")}" placeholder="—" /></td>
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
      body += `<tr class="group-band"><td colspan="17">${escapeHtml(g.className)} · ${g.jobs.length} job${g.jobs.length === 1 ? "" : "s"}</td></tr>`;
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
            <th>Day</th><th>Job #</th><th class="th-name">Customer / Job</th><th>Type</th>
            <th class="th-crew">Crew</th><th class="num">SQFT</th><th class="th-color">Color</th>
            <th>Material</th><th class="num">Lbs</th><th class="num">Boxes 40#</th><th class="num">Base A</th><th class="num">Base B</th><th class="num">Top A</th><th class="num">Top B</th>
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

function wireRow(row) {
  const id = row.dataset.id;
  const crew = row.querySelector(".js-crew");
  const sqft = row.querySelector(".js-sqft");
  const color = row.querySelector(".js-color");

  const flash = () => {
    row.classList.add("saved-flash");
    setTimeout(() => row.classList.remove("saved-flash"), 900);
  };

  const recompute = () => {
    const job = findJob(id);
    if (!job) return;
    job.sqft = sqft.value === "" ? null : Number(sqft.value) || 0;
    job.color = color.value.trim() || null;
    job.material = computeMaterialClient(job.sqft || 0, job.projectType, job.color);
    color.classList.toggle("warn", Boolean(job.color) && !schedule.colorMap.has(job.color.toLowerCase()));
    updateRowMaterial(row, job);
    updateTotalsRows();
  };

  crew.addEventListener("input", () => {
    const job = findJob(id);
    if (job) job.crew = crew.value.trim();
    saveAssignment(id, { crew: crew.value.trim() }, flash);
  });
  sqft.addEventListener("input", () => {
    recompute();
    const v = Number(sqft.value);
    saveAssignment(id, { sqftOverride: Number.isFinite(v) && v >= 0 ? v : undefined }, flash);
  });
  color.addEventListener("input", () => {
    recompute();
    saveAssignment(id, { colorOverride: color.value.trim() || undefined }, flash);
  });
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
        <div class="job-field">
          <label>Crew</label>
          <input class="js-crew" type="text" placeholder="Assign crew…" value="${escapeHtml(job.crew || "")}" />
        </div>
        <div class="job-field">
          <label>SQFT</label>
          <input class="js-sqft" type="number" inputmode="numeric" min="0" value="${job.sqft ?? ""}" />
        </div>
        <div class="job-field full">
          <label>Color</label>
          <input class="js-color${job.color && !job.colorRecognized ? " warn" : ""}" list="color-list" type="text" value="${escapeHtml(job.color || "")}" />
        </div>
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
  const crew = el.querySelector(".js-crew");
  const sqft = el.querySelector(".js-sqft");
  const color = el.querySelector(".js-color");
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
    job.material = computeMaterialClient(job.sqft || 0, job.projectType, job.color);
    color.classList.toggle("warn", Boolean(job.color) && !schedule.colorMap.has(job.color.toLowerCase()));
    matBox.innerHTML = materialHtml(job.material);
  };

  crew.addEventListener("input", () => {
    const job = findJob(id);
    if (job) job.crew = crew.value.trim();
    saveAssignment(id, { crew: crew.value.trim() }, flash);
  });
  sqft.addEventListener("input", () => {
    recompute();
    const v = Number(sqft.value);
    saveAssignment(id, { sqftOverride: Number.isFinite(v) && v >= 0 ? v : undefined }, flash);
  });
  color.addEventListener("input", () => {
    recompute();
    saveAssignment(id, { colorOverride: color.value.trim() || undefined }, flash);
  });
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
  "Day", "Job #", "Customer / Job", "Type", "Class", "Crew", "SQFT", "Color",
  "Material", "Flake lbs", "Flake boxes (40 lb)", "Base A gal", "Base B gal",
  "Top A gal", "Top B gal", "Rubber bags (50 lb)", "Binder (5-gal)", "Primer (5-gal)", "Notes",
];
const EXPORT_COLS = [
  { wch: 5 }, { wch: 8 }, { wch: 34 }, { wch: 14 }, { wch: 14 }, { wch: 18 },
  { wch: 7 }, { wch: 13 }, { wch: 16 }, { wch: 9 }, { wch: 11 }, { wch: 9 },
  { wch: 9 }, { wch: 9 }, { wch: 9 }, { wch: 14 }, { wch: 11 }, { wch: 11 }, { wch: 50 },
];

function exportJobRow(job) {
  const hasCustomer = job.customer && job.customer !== "—";
  const label = hasCustomer ? job.customer : job.description || `Job #${job.jobNumber}`;
  const v = matValues(job.material);
  const n = (x) => (x === null ? "" : x);
  return [
    (job.scheduledDay || "").slice(0, 3), job.jobNumber, label, job.projectType,
    job.className, job.crew || "", job.sqft ?? "", job.color || "",
    job.material.applies ? job.material.flake || "" : "",
    n(v.lbs), n(v.box), n(v.bca), n(v.bcb), n(v.tca), n(v.tcb), n(v.bags), n(v.bind), n(v.prim),
    job.description || "",
  ];
}

function exportTotalsRow(label, jobs) {
  const t = computeClassTotals(jobs);
  return [
    label, "", "", "", "", "", t.sqft, "", "",
    r2(t.lbs), r2(t.box), r2(t.bca), r2(t.bcb), r2(t.tca), r2(t.tcb),
    r2(t.bags), r2(t.bind), r2(t.prim), "",
  ];
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
  const allJobs = schedule.classes.flatMap((g) => g.jobs);
  if (!allJobs.length) {
    toast("Nothing to export for this week.", "error");
    return;
  }
  const weekLabel = `Week of ${schedule.weekStart}`;
  const wb = XLSX.utils.book_new();
  const used = new Set();

  // Sheet 1 — full schedule grouped by class, with totals.
  const rows = [[`Weekly Schedule — ${weekLabel}`], [], EXPORT_HEAD];
  for (const g of schedule.classes) {
    rows.push([`${g.className} — ${g.jobs.length} job${g.jobs.length === 1 ? "" : "s"}`]);
    for (const j of g.jobs) rows.push(exportJobRow(j));
    rows.push(exportTotalsRow(`${g.className} totals`, g.jobs));
    rows.push([]);
  }
  rows.push(exportTotalsRow("WEEK TOTALS", allJobs));
  const wsAll = XLSX.utils.aoa_to_sheet(rows);
  wsAll["!cols"] = EXPORT_COLS;
  XLSX.utils.book_append_sheet(wb, wsAll, sheetName("Schedule", used));

  // One printable sheet per crew.
  const byCrew = new Map();
  for (const j of allJobs) {
    const crew = (j.crew || "").trim() || "Unassigned";
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
      [`${weekLabel} · ${jobs.length} job${jobs.length === 1 ? "" : "s"}`],
      ["Primer kit = 3.5 gal binder + 1.5 gal alcohol spirits (5-gal kit covers 700 sqft)"],
      [],
      EXPORT_HEAD,
      ...jobs.map(exportJobRow),
      [],
      exportTotalsRow("Crew totals", jobs),
    ];
    const ws = XLSX.utils.aoa_to_sheet(crewRows);
    ws["!cols"] = EXPORT_COLS;
    XLSX.utils.book_append_sheet(wb, ws, sheetName(crew, used));
  }

  XLSX.writeFile(wb, `schedule-${schedule.weekStart}.xlsx`);
  toast("Exported — check your downloads.", "success");
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

// ─────────────────────────── Navigation ───────────────────────────
const TITLES = { schedule: "Weekly Schedule", report: "Weekly Report", projects: "Projects" };
let reportLoaded = false;

function showScreen(name) {
  for (const s of ["schedule", "report", "projects"]) {
    $(`screen-${s}`).hidden = s !== name;
  }
  $("screen-title").textContent = TITLES[name];
  $("save-bar").classList.toggle("hidden", name !== "report");
  $("week-label").hidden = name === "projects";
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.screen === name)
  );
  if (name === "projects" && !allProjects.length) loadProjects();
  if (name === "report" && !reportLoaded) {
    reportLoaded = true;
    loadReport();
  }
  if (name === "schedule") loadSchedule();
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
  } catch {
    /* non-fatal */
  }

  $("pipeline-file").addEventListener("change", (e) =>
    handlePipelineFile(e.target.files[0])
  );
  $("pipeline-clear").addEventListener("click", clearPipeline);
  await refreshPipelineStatus();

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

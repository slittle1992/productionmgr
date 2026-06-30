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
const schedule = { coverage: null, colorMap: new Map(), weekLabel: "", classes: [] };

const NO_MATERIAL = ["warranty", "inspection", "sand & clear", "sand and clear"];
function appliesMaterial(type) {
  if (!type) return true;
  return !NO_MATERIAL.includes(String(type).toLowerCase().replace(/\*+$/, "").trim());
}
function r2(n) {
  return Math.round(n * 100) / 100;
}

function computeMaterialClient(sqft, type, flake) {
  const cov = schedule.coverage;
  const applies = appliesMaterial(type);
  const area = applies && sqft > 0 ? sqft : 0;
  const div = (d) => (cov && d > 0 ? r2(area / d) : 0);
  return {
    applies,
    flake: applies ? flake : null,
    basecoatAGallons: div(cov?.basecoatADivisor),
    basecoatBGallons: div(cov?.basecoatBDivisor),
    topcoatAGallons: div(cov?.topcoatADivisor),
    topcoatBGallons: div(cov?.topcoatBDivisor),
    flakePounds: r2(area * (cov?.flakeLbsPerSqft ?? 0)),
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

function materialHtml(mat) {
  if (!mat.applies) {
    return `<div class="material none">No material needed (warranty / inspection).</div>`;
  }
  return `
    <div class="material">
      <h4>Material to use</h4>
      <div class="flake-name">Flake: ${escapeHtml(mat.flake || "—")} · <b>${mat.flakePounds} lbs</b></div>
      <div class="mat-rows">
        <span>Basecoat A <b>${mat.basecoatAGallons} gal</b></span>
        <span>Basecoat B <b>${mat.basecoatBGallons} gal</b></span>
        <span>Topcoat A <b>${mat.topcoatAGallons} gal</b></span>
        <span>Topcoat B <b>${mat.topcoatBGallons} gal</b></span>
      </div>
    </div>`;
}

function jobHtml(job) {
  const t = (job.projectType || "").toLowerCase();
  const typeClass = t.includes("rubber")
    ? "type-rubber"
    : t.includes("warranty") || t.includes("inspection")
    ? "type-warranty"
    : "type-flake";
  const hasCustomer = job.customer && job.customer !== "—";
  const title = hasCustomer ? job.customer : `Job #${job.jobNumber}`;
  return `
    <article class="job" data-id="${escapeHtml(job.id)}">
      <div class="job-head">
        <h3>${escapeHtml(title)}</h3>
        <span class="job-no">#${escapeHtml(job.jobNumber)}</span>
      </div>
      <div class="job-sub">
        <span class="chip ${typeClass}">${escapeHtml(job.projectType)}</span>
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
          <input class="js-sqft ${job.edited.sqft ? "edited" : ""}" type="number" inputmode="numeric" min="0" value="${job.sqft ?? ""}" />
        </div>
        <div class="job-field full">
          <label>Color ${job.edited.color ? "· edited" : ""}</label>
          <input class="js-color ${job.edited.color ? "edited" : ""}" list="color-list" type="text" value="${escapeHtml(job.color || "")}" />
          ${job.color && !job.colorRecognized ? `<div class="color-warn">Not in catalog — pick a standard color.</div>` : ""}
        </div>
      </div>
      <div class="js-material">${materialHtml(job.material)}</div>
      <span class="save-tick js-tick">saved ✓</span>
    </article>`;
}

function renderSchedule() {
  const term = $("schedule-search").value.trim().toLowerCase();
  const list = $("schedule-list");
  const groups = schedule.classes
    .map((g) => ({
      className: g.className,
      jobs: g.jobs.filter(
        (j) =>
          !term ||
          j.customer.toLowerCase().includes(term) ||
          String(j.jobNumber).includes(term) ||
          (j.crew || "").toLowerCase().includes(term)
      ),
    }))
    .filter((g) => g.jobs.length);

  if (!groups.length) {
    list.innerHTML = `<div class="empty">No jobs scheduled this week.</div>`;
    return;
  }
  list.innerHTML = groups
    .map(
      (g) => `
      <section class="class-group">
        <h2>${escapeHtml(g.className)} <span class="count">${g.jobs.length}</span></h2>
        ${g.jobs.map(jobHtml).join("")}
      </section>`
    )
    .join("");

  list.querySelectorAll(".job").forEach(wireJob);
}

const debouncers = new Map();
function debounce(key, fn, ms = 600) {
  clearTimeout(debouncers.get(key));
  debouncers.set(key, setTimeout(fn, ms));
}

function wireJob(el) {
  const id = el.dataset.id;
  const crew = el.querySelector(".js-crew");
  const sqft = el.querySelector(".js-sqft");
  const color = el.querySelector(".js-color");
  const matBox = el.querySelector(".js-material");
  const tick = el.querySelector(".js-tick");

  const refreshMaterial = () => {
    const job = findJob(id);
    if (!job) return;
    const type = job.projectType;
    const mat = computeMaterialClient(
      Number(sqft.value) || 0,
      type,
      flakeFor(color.value.trim())
    );
    matBox.innerHTML = materialHtml(mat);
  };

  const save = (payload) => {
    debounce(id, async () => {
      try {
        const res = await fetch("/api/schedule/assign", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId: id, ...payload }),
        });
        if (!res.ok) throw new Error("save failed");
        tick.classList.add("show");
        setTimeout(() => tick.classList.remove("show"), 1400);
      } catch {
        toast("Couldn't save that change.", "error");
      }
    });
  };

  crew.addEventListener("input", () => save({ crew: crew.value.trim() }));
  sqft.addEventListener("input", () => {
    refreshMaterial();
    const v = Number(sqft.value);
    save({ sqftOverride: Number.isFinite(v) && v >= 0 ? v : undefined });
  });
  color.addEventListener("input", () => {
    refreshMaterial();
    save({ colorOverride: color.value.trim() || undefined });
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
    const data = await (await fetch("/api/schedule")).json();
    schedule.classes = data.classes;
    $("week-label").textContent = `Week of ${data.weekStart} – ${data.weekEnd} · ${data.jobCount} jobs`;
    renderSchedule();
  } catch (err) {
    list.innerHTML = `<div class="empty">Couldn't load the schedule.</div>`;
  }
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

  // Schedule is the default screen.
  await loadColors();
  showScreen("schedule");
}

init();

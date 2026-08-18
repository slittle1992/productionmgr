// Production Manager — phone-first weekly report + project view.
// The server is the source of truth for all math; this file mirrors the
// derived calculations only so the manager sees instant feedback while typing.

const state = {
  laborMultiplier: 1.2,
  // Class list shared by the pay + roster screens (from /api/classes).
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

/** Load the class list used by the pay + roster screens. */
async function loadReportClasses() {
  try {
    const { classes } = await (await fetch("/api/classes")).json();
    state.classes = classes || [];
  } catch {
    state.classes = [];
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
  { key: "materials", n: 5, title: "Inventory counts & material cost" },
  { key: "reviews", n: 6, title: "Reviews dashboard" },
  { key: "lytx", n: 7, title: "Lytx incidents" },
  { key: "ramp", n: 8, title: "Ramp spend" },
  { key: "vip", n: 9, title: "VIP Lead — To-Dos & Crews" },
];

const meeting = {
  week: null,
  view: null,
  // Which <details> stay open across re-renders (sections, classes, items).
  open: new Set(["sec:pastdue"]),
  // Pending payroll-workbook uploads awaiting a "use this sheet" pick,
  // keyed by class — each market uploads its own payroll workbook.
  payroll: {},
};

// Sales Management tab state: leads-by-area analysis + the weekly
// appointments (Meetings export) rollups. Shares meeting.open for <details>.
const sales = {
  meta: null, // leads upload meta from GET /api/leads
  days: 28,
  analysis: null, // leads-by-area view
  sales: null, // weekly flow / rep scorecard / area sold $
  appts: null, // { weeks: [...] } appointments + cancellations
  daily: null, // daily rubber/flake lead flow + goal pacing
  goals: null, // per-location goals + (unused) type goals
  dailyTasks: null, // today's checks, recent contracts, rehash list
  chartClass: null, // daily lead chart market filter (null = all markets)
  apptClass: null, // appointments chart market filter
  apptRep: null, // appointments chart rep filter (overrides market)
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
  if (!res.ok) {
    throw new Error(
      data.message ||
        (res.status === 413
          ? "That file is too big for one upload — refresh the app (it now chunks big files) or export a shorter date range."
          : "Request failed.")
    );
  }
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

/** "What you'll need" checklist at the top of the meeting, with live status. */
/** Per-location scoreboard: the week's key numbers side by side. */
function renderMeetingScore(v) {
  const el = $("meeting-score");
  const inv = invCountsFresh() ? invCounts : null;
  const expected = Object.fromEntries(
    (v.materialsExpected || []).map((r) => [r.className, r])
  );
  const names = new Set([
    ...v.labor.rows.map((r) => r.className),
    ...(inv ? inv.classes.map((c) => c.className) : []),
    ...Object.keys(expected),
  ]);
  if (!names.size) {
    el.hidden = true;
    return;
  }
  const rows = [...names].sort().map((name) => {
    const lab = v.labor.rows.find((r) => r.className === name);
    const c = inv ? inv.classes.find((x) => x.className === name) : null;
    const exp = expected[name];
    const revenue = lab ? lab.revenueOverride ?? lab.completedRevenue : null;
    const actual = c ? c.materialCost ?? c.usage.totalCost : null;
    const matPct =
      revenue && revenue > 0 && actual !== null ? (actual / revenue) * 100 : null;
    const specCost = exp && exp.jobsWithSqft ? exp.expectedCost : null;
    const usageX =
      specCost && specCost > 0 && actual !== null ? actual / specCost : null;
    return { name, revenue, laborRate: lab?.rate ?? null, actual, matPct, specCost, usageX, exp };
  });
  const money0 = (n) => (n === null ? "—" : fmtMoney0(n));
  const usageCell = (x) => {
    if (x === null) return "—";
    const cls = x <= 1.3 ? "good" : x <= 1.8 ? "warn" : "bad";
    return `<span class="score-x ${cls}">${x.toFixed(1)}×</span>`;
  };
  el.hidden = false;
  el.innerHTML = `
  <div class="score-head">
    <span class="prep-title">Scoreboard — week of ${fmtDay(v.labor.weekStart)}</span>
    <span class="inv-dim score-note">labor & revenue from §4 · material from §5 · spec = completed sqft × coverage math at PO prices</span>
  </div>
  <div class="table-wrap score-wrap">
    <table class="inv-table score-table">
      <thead><tr>
        <th>Location</th><th class="num">Completed rev</th><th class="num">Labor rate</th>
        <th class="num">Material $</th><th class="num">Mat %</th>
        <th class="num">Spec $</th><th class="num">Usage</th>
      </tr></thead>
      <tbody>
        ${rows
          .map(
            (r) => `
          <tr>
            <td><b>${escapeHtml(r.name)}</b></td>
            <td class="num">${money0(r.revenue)}</td>
            <td class="num">${r.laborRate !== null ? r.laborRate.toFixed(1) + "×" : "—"}</td>
            <td class="num">${money0(r.actual)}</td>
            <td class="num">${r.matPct !== null ? r.matPct.toFixed(1) + "%" : "—"}</td>
            <td class="num">${money0(r.specCost)}${r.exp && r.exp.completedJobs > r.exp.jobsWithSqft ? `<span class="inv-dim score-part"> ${r.exp.jobsWithSqft}/${r.exp.completedJobs} jobs</span>` : ""}</td>
            <td class="num">${usageCell(r.usageX)}</td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>
  </div>`;
}

function renderMeetingPrep(v) {
  const payrollDone =
    v.labor.rows.length > 0 &&
    v.labor.rows
      .filter((r) => r.completedRevenue > 0 || r.revenueOverride !== null)
      .every((r) => r.productionPayroll !== null);
  const counts = invCountsFresh() ? invCounts.classes.length : 0;
  const spendDone =
    invCountsFresh() &&
    counts > 0 &&
    invCounts.totals.missingPurchases.length === 0;
  const items = [
    { sec: "pastdue", icon: "💰", label: "Unpaid Invoices export", done: Boolean(v.pastDue.meta) },
    { sec: "workorders", icon: "🛠", label: "Work orders export", done: Boolean(v.workOrders.uploadedAt) },
    { sec: "pipeline", icon: "📊", label: "Production Pipeline report", done: v.pipeline.available },
    { sec: "labor", icon: "✅", label: "Completed Projects report", done: Boolean(v.labor.uploadedAt) },
    { sec: "labor", icon: "🧾", label: "Payroll per location", done: payrollDone },
    { sec: "materials", icon: "📦", label: "Inventory counts (all locations)", done: counts > 0, note: counts ? `${counts} in` : "" },
    { sec: "materials", icon: "💵", label: "Material spend $ per location", done: spendDone },
  ];
  const ready = items.filter((i) => i.done).length;
  const el = $("meeting-prep");
  el.hidden = false;
  el.innerHTML = `
    <div class="prep-head">
      <span class="prep-title">What you'll need</span>
      <span class="prep-count${ready === items.length ? " all" : ""}">${ready}/${items.length} ready</span>
    </div>
    <div class="prep-chips">
      ${items
        .map(
          (i) => `
        <button class="prep-chip${i.done ? " done" : ""}" type="button" data-goto="${i.sec}">
          <span class="prep-ic">${i.done ? "✓" : i.icon}</span>
          <span>${i.label}${i.note ? ` <b>· ${i.note}</b>` : ""}</span>
        </button>`
        )
        .join("")}
    </div>`;
}

function renderMeeting() {
  const v = meeting.view;
  if (!v) return;
  renderMeetingPrep(v);
  renderMeetingScore(v);
  $("meeting-week-range").innerHTML =
    `${fmtDay(v.week.weekStart)} – ${fmtDay(v.week.weekEnd)}` +
    `<span class="week-reviewing">reviewing ${fmtDay(v.labor.weekStart)} – ${fmtDay(v.labor.weekEnd)}</span>`;
  $("meeting-progress-label").textContent = `${v.doneCount} of ${v.sectionCount} done`;
  $("meeting-progress-fill").style.width =
    Math.round((v.doneCount / v.sectionCount) * 100) + "%";

  const progress = Object.fromEntries(v.sections.map((s) => [s.key, s]));
  const bodies = {
    pastdue: renderPastDueSection(v),
    workorders: renderWorkOrdersSection(v),
    pipeline: renderPipelineSection(v),
    labor: renderLaborSection(v),
    materials: renderMaterialsSection(v),
    reviews: renderCheckSection(v, "reviews"),
    lytx: renderCheckSection(v, "lytx"),
    ramp: renderCheckSection(v, "ramp"),
    vip: renderCheckSection(v, "vip"),
  };
  const subs = {
    pastdue: pastDueSubtitle(v.pastDue),
    workorders: `${v.workOrders.totalOpen} open${
      v.workOrders.attention?.length ? ` · ${v.workOrders.attention.length} need scheduling` : ""
    } · ${v.workOrders.totalCompleted} done`,
    pipeline: v.pipeline.available
      ? `${v.pipeline.unscheduled.length} missing dates · ${v.pipeline.noCrew.length} no crew`
      : "no pipeline loaded",
    labor: v.labor.rows.length
      ? v.labor.rows
          .filter((r) => r.rate !== null)
          .map((r) => `${r.className.slice(0, 3)} ${r.rate.toFixed(1)}×`)
          .join(" · ") || "enter payroll"
      : "upload completed jobs",
    materials: invCountsSubtitle(),
    reviews: v.checks.reviews.status === "done" ? "reviewed" : "needs review",
    lytx: v.checks.lytx.status === "done" ? "reviewed" : "needs review",
    ramp: v.checks.ramp.status === "done" ? "reviewed" : "needs review",
    vip: v.checks.vip.status === "done" ? "reviewed" : "needs review",
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
            <span><b>${escapeHtml(f.className)}</b> · ${escapeHtml(f.client)} · ${fmtMoney0(f.balance)}</span>
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
    html += `<table class="mtg-table"><thead><tr><th>Location</th><th>Open</th><th>Open warranty</th><th>⚠ Attention</th><th>Completed</th></tr></thead><tbody>`;
    for (const c of wo.classes) {
      html += `<tr><td>${escapeHtml(c.className)}</td><td>${c.open}</td><td>${
        c.openWarranties
      }</td><td>${
        c.needsAttention ? `<b class="wo-attn">${c.needsAttention}</b>` : "0"
      }</td><td>${c.completed}</td></tr>`;
    }
    html += `</tbody></table>`;
  }

  // Pinned to the top: open WOs that were never scheduled, or whose date
  // already passed without being closed out.
  if (wo.attention.length) {
    html += `<h3 class="mtg-h3 wo-attn">⚠ Needs scheduling — unscheduled or past date, still open (${wo.attention.length})</h3>`;
    const byClass = new Map();
    for (const a of wo.attention) {
      if (!byClass.has(a.className)) byClass.set(a.className, []);
      byClass.get(a.className).push(a);
    }
    html += [...byClass.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([cls, rows]) => {
        const openKey = `woattn:${cls}`;
        const unsched = rows.filter((a) => a.reason === "unscheduled").length;
        return `
        <details class="mtg-class attn" data-open="${openKey}" ${
          meeting.open.has(openKey) ? "open" : ""
        }>
          <summary>
            <span class="mtg-class-name">${escapeHtml(cls)}</span>
            <span class="mtg-class-info warn">${rows.length} WO${
              rows.length === 1 ? "" : "s"
            } · ${unsched} unscheduled · ${rows.length - unsched} past date</span>
          </summary>
          ${rows
            .map(
              (a) => `<div class="mtg-line attn-line">
                <span class="mtg-badge warn">${
                  a.reason === "unscheduled" ? "unscheduled" : "past " + fmtMsDate(a.startDate)
                }</span>
                #${escapeHtml(a.woNumber)} · ${escapeHtml(a.client)}${
                  a.city ? " · " + escapeHtml(a.city) : ""
                }
                <span class="mtg-line-desc">${escapeHtml(a.type)} · ${escapeHtml(
                  a.status || "OPEN"
                )}</span>
              </div>`
            )
            .join("")}
        </details>`;
      })
      .join("");
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
  const closed = wo.warranties.filter((w) => !w.open);
  if (open.length) {
    html += `<h3 class="mtg-h3">Open warranty / callback work orders</h3>`;
    html += renderWarrantyGroups("woopen", open, Infinity);
  } else if (wo.uploadedAt) {
    html += `<div class="empty small">No open warranty work orders. 🎉</div>`;
  }
  if (closed.length) {
    html += `<h3 class="mtg-h3">Recently completed warranties</h3>`;
    html += renderWarrantyGroups("wodone", closed, 15);
  }
  return html;
}

/** Warranty WOs grouped by class/location, mirroring the past-due groups. */
function renderWarrantyGroups(prefix, warranties, maxPerClass) {
  const byClass = new Map();
  for (const w of warranties) {
    const cls = w.className || "Unassigned";
    if (!byClass.has(cls)) byClass.set(cls, []);
    byClass.get(cls).push(w);
  }
  return [...byClass.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([cls, rows]) => {
      const openKey = `${prefix}:${cls}`;
      const shown = rows.slice(0, maxPerClass);
      const untagged = rows.filter((w) => !w.lead || !w.cause).length;
      return `
      <details class="mtg-class" data-open="${openKey}" ${meeting.open.has(openKey) ? "open" : ""}>
        <summary>
          <span class="mtg-class-name">${escapeHtml(cls)}</span>
          <span class="mtg-class-info${untagged && prefix === "woopen" ? " warn" : ""}">${rows.length} WO${
            rows.length === 1 ? "" : "s"
          }${untagged && prefix === "woopen" ? ` · ${untagged} untagged` : ""}</span>
        </summary>
        ${shown.map(renderWarrantyRow).join("")}
        ${rows.length > shown.length ? `<div class="hint">…and ${rows.length - shown.length} more.</div>` : ""}
      </details>`;
    })
    .join("");
}

function renderWarrantyRow(w) {
  const id = escapeHtml(w.id);
  return `
  <div class="mtg-wo${w.open ? "" : " closed"}">
    <div class="mtg-wo-top">
      <span class="mtg-wo-who">#${escapeHtml(w.woNumber)} · ${escapeHtml(w.client)}${
        w.city ? " · " + escapeHtml(w.city) : ""
      }</span>
      <span class="mtg-wo-meta">${escapeHtml(w.type)} · ${escapeHtml(
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
  const uploadBar = `
  <div class="pipeline-bar">
    <div class="pipeline-status">${
      p.available
        ? `<strong>${p.totalJobs} jobs</strong> in the pipeline`
        : "Upload the Builder Prime <strong>Production Pipeline Report</strong> to run these checks."
    }</div>
    <div class="pipeline-actions">
      <label class="btn-upload"><span>Upload pipeline</span>
        <input type="file" accept=".xlsx,.xls" data-upload="pipeline" hidden />
      </label>
    </div>
  </div>`;
  if (!p.available) return uploadBar;
  let html = `${uploadBar}
  <p class="card-help">Looking <b>ahead</b>: are the next two weeks full and evenly
  scheduled? Plus jobs with <b>no start date</b> and scheduled jobs with
  <b>no crew assigned</b>.</p>`;

  for (const wk of p.weeks) {
    html += `<h3 class="mtg-h3">Week of ${fmtDay(wk.weekStart)} – ${fmtDay(wk.weekEnd)} · ${
      wk.jobCount
    } jobs</h3>`;
    if (!wk.classes.length) {
      html += `<div class="empty small">Nothing scheduled to start this week yet.</div>`;
      continue;
    }
    for (const cls of wk.classes) {
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
  }

  html += renderPipelineList(
    "nocrew",
    `No labor assigned (${p.noCrew.length})`,
    p.noCrew,
    (j) =>
      `${j.startsSoon ? "🔴 " : ""}#${escapeHtml(j.jobNumber)} · ${fmtMoney0(
        j.soldAmount
      )} · starts ${fmtMsDate(j.startDate)}`
  );
  html += renderPipelineList(
    "nostart",
    `Missing start / finish date (${p.unscheduled.length})`,
    p.unscheduled,
    (j) => {
      const missing =
        j.missingStart && j.missingFinish
          ? "no start + finish"
          : j.missingStart
          ? "no start"
          : "no finish";
      return `<span class="mtg-badge warn">${missing}</span> #${escapeHtml(
        j.jobNumber
      )} · ${fmtMoney0(j.soldAmount)}${
        j.startDate ? ` · starts ${fmtMsDate(j.startDate)}` : ""
      }${j.salesPerson ? " · " + escapeHtml(j.salesPerson) : ""}`;
    }
  );
  return html;
}

/** A pipeline flag list, grouped by location like every other meeting list. */
function renderPipelineList(key, title, jobs, line) {
  if (!jobs.length)
    return `<div class="empty small">${escapeHtml(title)}: none 🎉</div>`;
  let html = `<h3 class="mtg-h3">${escapeHtml(title)}</h3>`;
  const byClass = new Map();
  for (const j of jobs) {
    const cls = j.className || "Unassigned";
    if (!byClass.has(cls)) byClass.set(cls, []);
    byClass.get(cls).push(j);
  }
  const MAX = 40;
  html += [...byClass.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([cls, rows]) => {
      const openKey = `pl:${key}:${cls}`;
      const urgent = rows.filter((j) => j.startsSoon).length;
      const total = rows.reduce((s, j) => s + (j.soldAmount || 0), 0);
      const shown = rows.slice(0, MAX);
      return `
      <details class="mtg-class" data-open="${openKey}" ${meeting.open.has(openKey) ? "open" : ""}>
        <summary>
          <span class="mtg-class-name">${escapeHtml(cls)}</span>
          <span class="mtg-class-info${urgent ? " warn" : ""}">${rows.length} job${
            rows.length === 1 ? "" : "s"
          } · ${fmtMoney0(total)}${urgent ? ` · ${urgent} next week` : ""}</span>
        </summary>
        ${shown
          .map(
            (j) =>
              `<div class="mtg-line">${line(j)}${
                j.description
                  ? `<span class="mtg-line-desc">${escapeHtml(j.description)}</span>`
                  : ""
              }</div>`
          )
          .join("")}
        ${rows.length > shown.length ? `<div class="hint">…and ${rows.length - shown.length} more.</div>` : ""}
      </details>`;
    })
    .join("");
  return html;
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
    </div>
  </div>`;

  if (!lab.rows.length) {
    html += `<div class="empty small">Upload the completed-projects report to see revenue
      per location, then upload each market's payroll workbook on its row.</div>`;
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
    const pending = meeting.payroll[r.className];
    html += `
    <div class="mtg-labor-row">
      <div class="mtg-labor-head"><b>${cls}</b>${rateHtml}
        <label class="btn-upload wo-btn mtg-payroll-btn"><span>⬆ Payroll</span>
          <input type="file" accept=".xlsx,.xlsm,.xls" data-upload="payroll" data-class="${cls}" hidden />
        </label>
      </div>
      ${
        pending
          ? `<div class="mtg-payroll-pick">
              <b>${cls} payroll read.</b> Pick the pay-period sheet:
              ${pending.sheets
                .slice(0, 8)
                .map(
                  (s, i) => `<div class="mtg-resolve-row">
                  <span><b>${escapeHtml(s.sheetName)}</b>${
                    s.periodStart
                      ? ` · ${escapeHtml(s.periodStart)} → ${escapeHtml(s.periodEnd || "?")}`
                      : ""
                  } · ${fmtMoney0(s.productionTotal)} production (${s.employeeCount} ppl)</span>
                  <button type="button" class="btn-export" data-act="payroll-use" data-class="${cls}" data-idx="${i}">Use</button>
                </div>`
                )
                .join("")}
              <button type="button" class="btn-clear" data-act="payroll-cancel" data-class="${cls}">Cancel</button>
            </div>`
          : ""
      }
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
          ${r.productionPayroll ? `<span class="inv-dim">fully burdened ×${v.labor.multiplier}: ${fmtMoney(r.productionPayroll * v.labor.multiplier)} — used in the rate</span>` : `<span class="inv-dim">pure payroll — the rate adds the ×${v.labor.multiplier} taxes/benefits burden automatically</span>`}
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
  vip: {
    help:
      "Open VIP Lead: clear the Production To-Do bucket (nothing unclaimed or stale), " +
      "then check each VIP Crew channel against the roster — right people in the " +
      "right crew channels, and the crews posting on the expected cadence " +
      "(daily job updates, photos, end-of-day numbers).",
    link: "Open VIP Lead",
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

// ── §8 Leads by area ──
const LEAD_WINDOWS = [
  { days: 7, label: "Last week" },
  { days: 28, label: "Last 4 weeks" },
  { days: 91, label: "Last quarter" },
];

function renderLeadsStep() {
  const meta = sales.meta;
  let html = `
  <p class="card-help">Where leads come from, per location — clustered by ZIP
  prefix (761 = Fort Worth, 752 = Dallas…). <b>Share shift</b> compares this
  window against the equal window before it, so you can see leads moving
  toward or away from an area. Zips with volume but <b>zero sales ever</b> are
  flagged.</p>
  <div class="pipeline-bar">
    <div class="pipeline-status">${
      meta
        ? `<strong>${escapeHtml(meta.sourceLabel || meta.filename || "Clients list")}</strong> · ${meta.count.toLocaleString()} leads · uploaded ${fmtDate(meta.uploadedAt)}`
        : "Upload the Builder Prime <strong>Clients List</strong> export."
    }</div>
    <div class="pipeline-actions">
      <label class="btn-upload"><span>Upload leads</span>
        <input type="file" accept=".xlsx,.xls" data-upload="leads" hidden />
      </label>
    </div>
  </div>`;
  if (!meta) return html;

  html += `<div class="class-chips leads-windows">${LEAD_WINDOWS.map(
    (w) => `<button type="button" class="chip-btn ${
      sales.days === w.days ? "active" : ""
    }" data-act="leads-window" data-days="${w.days}">${w.label}</button>`
  ).join("")}<button type="button" class="chip-btn map-open-btn" data-act="open-map">🗺 Heat map + all zips</button></div>`;

  const a = sales.analysis;
  if (!a) {
    return html + `<div class="loading">Crunching ${meta.count.toLocaleString()} leads…</div>`;
  }

  html += `<p class="hint">Window: ${escapeHtml(a.from)} → ${escapeHtml(a.to)} vs the ${a.windowDays} days before.</p>`;
  html += renderLeadsFlowTable(sales.sales);

  const areaSales = sales.sales?.byCluster || null;
  for (const cls of a.classes) {
    const openKey = `leads:${cls.className}`;
    const trend =
      cls.previous > 0
        ? Math.round(((cls.current - cls.previous) / cls.previous) * 100)
        : null;
    const moveChips = [
      ...cls.gaining.map(
        (c) => `<span class="lead-move up">▲ ${escapeHtml(clusterLabel(c))} +${c.shareShiftPts}pts</span>`
      ),
      ...cls.fading.map(
        (c) => `<span class="lead-move down">▼ ${escapeHtml(clusterLabel(c))} ${c.shareShiftPts}pts</span>`
      ),
    ].join("");

    html += `
    <details class="mtg-class" data-open="${openKey}" ${meeting.open.has(openKey) ? "open" : ""}>
      <summary>
        <span class="mtg-class-name">${escapeHtml(cls.className)}</span>
        <span class="mtg-class-info">${cls.current} leads${
          trend !== null ? ` · ${trend >= 0 ? "▲" : "▼"}${Math.abs(trend)}% vs prior` : ""
        } · ${cls.soldCurrentCohort} sold</span>
      </summary>
      ${moveChips ? `<div class="lead-moves">${moveChips}</div>` : ""}
      ${
        cls.neverSells.length
          ? `<div class="stg-warn">🕳 Leads but <b>zero sales ever</b>: ${cls.neverSells
              .map(
                (z) => `${escapeHtml(z.zip)}${z.city ? " " + escapeHtml(z.city) : ""} (${z.allTime})`
              )
              .join(" · ")}</div>`
          : ""
      }
      <table class="mtg-table leads-table">
        <thead><tr><th>Area</th><th>Leads</th><th>Prior</th><th>Shift</th><th>Conv.</th>${areaSales ? "<th>Sold $</th><th>$/lead</th>" : ""}</tr></thead>
        <tbody>
        ${cls.clusters
          .map(
            (c) => `<tr>
              <td>${escapeHtml(clusterLabel(c))}</td>
              <td><b>${c.current}</b></td>
              <td>${c.previous}</td>
              <td class="${c.shareShiftPts > 0.5 ? "lead-up" : c.shareShiftPts < -0.5 ? "lead-down" : ""}">${
                c.shareShiftPts > 0 ? "+" : ""
              }${c.shareShiftPts}pts</td>
              <td>${c.allTime >= 10 ? Math.round(c.conversion * 100) + "%" : "—"}</td>
              ${areaSales ? (() => {
                const sale = areaSales[`${cls.className}|${c.cluster}`];
                const nsli = sale && c.current > 0 ? sale.net / c.current : null;
                return `<td>${sale ? fmtMoney0(sale.net) : "—"}</td><td>${nsli !== null ? fmtMoney0(nsli) : "—"}</td>`;
              })() : ""}
            </tr>
            ${c.zips
              .filter((z) => z.current > 0)
              .slice(0, 5)
              .map(
                (z) => `<tr class="leads-ziprow">
                  <td>· ${escapeHtml(z.zip)}${z.city ? " " + escapeHtml(z.city) : ""}</td>
                  <td>${z.current}</td><td>${z.previous}</td><td></td>
                  <td>${z.allTime >= 10 ? Math.round((z.soldAllTime / z.allTime) * 100) + "%" : "—"}</td>
                  ${areaSales ? "<td></td><td></td>" : ""}
                </tr>`
              )
              .join("")}`
          )
          .join("")}
        </tbody>
      </table>
    </details>`;
  }
  return html;
}

/** Weekly LEADS flow per market — step 1's week-to-week view. */
function renderLeadsFlowTable(sd) {
  const wf = sd?.weeklyFlow || [];
  if (!wf.length) return "";
  // Market columns: the busiest markets across the window.
  const totals = {};
  for (const w of wf) {
    for (const [cls, n] of Object.entries(w.byClass || {})) {
      totals[cls] = (totals[cls] || 0) + n;
    }
  }
  const markets = Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([cls]) => cls);
  return `
  <details class="mtg-class" data-open="leads:flow" ${meeting.open.has("leads:flow") ? "open" : ""}>
    <summary><span class="mtg-class-name">Weekly lead flow</span>
      <span class="mtg-class-info">per market, vs last year</span>
    </summary>
    <div class="table-wrap">
    <table class="mtg-table leads-table">
      <thead><tr><th>Week</th><th>Leads</th><th>Last yr</th><th>Δ</th>${markets
        .map((m) => `<th>${escapeHtml(m.slice(0, 3))}</th>`)
        .join("")}</tr></thead>
      <tbody>
        ${wf
          .map((w) => {
            const delta =
              w.leadsLastYear > 0
                ? Math.round(((w.leads - w.leadsLastYear) / w.leadsLastYear) * 100)
                : null;
            return `<tr>
              <td>${fmtDay(w.weekStart)}</td>
              <td><b>${w.leads}</b></td>
              <td>${w.leadsLastYear || "—"}</td>
              <td class="${delta !== null && delta >= 0 ? "lead-up" : delta !== null ? "lead-down" : ""}">${delta !== null ? (delta >= 0 ? "+" : "") + delta + "%" : "—"}</td>
              ${markets.map((m) => `<td>${w.byClass?.[m] || ""}</td>`).join("")}
            </tr>`;
          })
          .join("")}
      </tbody>
    </table>
    </div>
  </details>`;
}

/** Weekly step 3 — Sales: sold $ per market + week, and the rep scorecard. */
function renderSalesStep() {
  const sd = sales.sales;
  let html = `
  <p class="card-help">Sold $ week to week with the rubber/flake mix, sold $
  per market this month, and each rep's close rate (<b>jobs sold ÷ leads
  issued</b>) and NSLI (<b>net $ ÷ leads issued</b>).</p>
  <div class="pipeline-bar">
    <div class="pipeline-status">${
      sd?.soldMeta
        ? `<strong>${escapeHtml(sd.soldMeta.sourceLabel || sd.soldMeta.filename || "Sold contracts")}</strong> · ${sd.soldMeta.count.toLocaleString()} contracts${sd.perfMeta ? ` · perf: ${sd.perfMeta.reps} reps` : ""}`
        : "Upload the <strong>Total Sales (Contracts)</strong> and <strong>Lead Performance</strong> (by Sales Person) exports."
    }</div>
    <div class="pipeline-actions">
      <label class="btn-upload"><span>Sold contracts</span>
        <input type="file" accept=".xlsx,.xls" data-upload="sold" hidden />
      </label>
      <label class="btn-upload"><span>Lead perf.</span>
        <input type="file" accept=".xlsx,.xls" data-upload="perf" hidden />
      </label>
    </div>
  </div>`;
  if (!sd) return html;

  if (sd.leadsNeedReupload) {
    html += `<p class="hint">⚠ Re-upload the Clients List once — the stored copy
      predates name matching, so sold contracts can't be tied to markets yet.</p>`;
  }

  const wf = (sd.weeklyFlow || []).filter(() => Boolean(sd.soldMeta));
  if (wf.length) {
    html += `
    <details class="mtg-class" data-open="sales:flow" ${meeting.open.has("sales:flow") ? "open" : ""}>
      <summary><span class="mtg-class-name">Weekly sold $</span>
        <span class="mtg-class-info">with the rubber vs flake mix</span>
      </summary>
      <table class="mtg-table leads-table">
        <thead><tr><th>Week</th><th>Sold</th><th>Sold $</th><th>Flake $</th><th>Rubber $</th></tr></thead>
        <tbody>
          ${wf
            .map(
              (w) => `<tr>
              <td>${fmtDay(w.weekStart)}</td>
              <td>${w.soldCount || "—"}</td>
              <td><b>${w.soldNet ? fmtMoney0(w.soldNet) : "—"}</b></td>
              <td>${w.flakeNet ? fmtMoney0(w.flakeNet) : "—"}</td>
              <td>${w.rubberNet ? fmtMoney0(w.rubberNet) : "—"}</td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </details>`;
  } else {
    html += `<p class="hint">Upload the <b>Sold Contracts</b> detail export for
      the weekly sold $ and the market/rep views.</p>`;
  }

  // Per-market sold $ MTD comes from the Daily card's By-location table —
  // point there instead of duplicating it.
  if (sd.repScorecard) {
    const rangeLabel = sd.perfMeta?.sourceLabel || "";
    html += `
    <details class="mtg-class" data-open="leads:reps" ${meeting.open.has("leads:reps") ? "open" : ""}>
      <summary><span class="mtg-class-name">Rep scorecard</span>
        <span class="mtg-class-info">close rate = sold ÷ issued · NSLI = net $ ÷ issued</span>
      </summary>
      ${rangeLabel ? `<p class="hint">${escapeHtml(rangeLabel)}${sd.soldMeta ? "" : " — upload the Sold Contracts export for NSLI dollars"}</p>` : ""}
      <table class="mtg-table leads-table">
        <thead><tr><th>Rep</th><th>Issued</th><th>Demos</th><th>Sold</th><th>Close</th><th>Net $</th><th>NSLI</th></tr></thead>
        <tbody>
          ${sd.repScorecard
            .map((r) => {
              const close = r.closeRate !== null ? Math.round(r.closeRate * 100) : null;
              return `<tr>
                <td>${escapeHtml(r.rep)}</td>
                <td>${r.issued}</td>
                <td>${r.demos}</td>
                <td><b>${r.sold}</b></td>
                <td class="${close !== null && close >= 25 ? "lead-up" : close !== null && close < 15 ? "lead-down" : ""}">${close !== null ? close + "%" : "—"}</td>
                <td>${r.net ? fmtMoney0(r.net) : "—"}</td>
                <td><b>${r.nsli !== null ? fmtMoney0(r.nsli) : "—"}</b></td>
              </tr>`;
            })
            .join("")}
          ${(() => {
            const t = sd.repScorecard.reduce(
              (acc, r) => ({
                issued: acc.issued + r.issued,
                demos: acc.demos + r.demos,
                sold: acc.sold + r.sold,
                net: acc.net + r.net,
              }),
              { issued: 0, demos: 0, sold: 0, net: 0 }
            );
            const close = t.issued > 0 ? Math.round((t.sold / t.issued) * 100) : null;
            const nsli = t.issued > 0 ? t.net / t.issued : null;
            return `<tr class="score-footer">
              <td><b>Company</b></td><td><b>${t.issued}</b></td><td><b>${t.demos}</b></td><td><b>${t.sold}</b></td>
              <td><b>${close !== null ? close + "%" : "—"}</b></td>
              <td><b>${fmtMoney0(t.net)}</b></td><td><b>${nsli !== null ? fmtMoney0(nsli) : "—"}</b></td>
            </tr>`;
          })()}
        </tbody>
      </table>
    </details>`;
  } else if (sd.soldMeta) {
    html += `<p class="hint">Upload the <b>Lead Performance Summary</b> (by Sales Person) to add close rate and NSLI per rep.</p>`;
  }

  if (sd.joinInfo && sd.joinInfo.total > 0) {
    const pct = Math.round((sd.joinInfo.joined / sd.joinInfo.total) * 100);
    html += `<p class="hint">Market joins: ${sd.joinInfo.joined}/${sd.joinInfo.total} contracts (${pct}%) matched to a market by client name. Per-market sold $ MTD lives in the Daily card's By-location table.</p>`;
  }
  return html;
}

function clusterLabel(c) {
  const cities = c.cities?.length ? ` ${c.cities.join("/")}` : "";
  return c.cluster === "?" ? "No zip" : `${c.cluster}xx${cities}`;
}

// ─────────────────────────── Sales Management tab ───────────────────────────
// The sales manager's own workflow: a Daily section (coming) and the Weekly
// steps — 1) upload the leads reports, 2) upload the Meetings export for
// appointments per rep + the cancellation rate, saved week over week.

async function loadSales() {
  if (loadSales._busy) return;
  loadSales._busy = true;
  try {
    const data = await meetingApi(`/api/leads?days=${sales.days}`, "GET");
    sales.meta = data.meta;
    sales.analysis = data.analysis;
    sales.sales = data.sales;
    sales.appts = data.appointments;
    sales.daily = data.daily;
    sales.goals = data.goals;
    sales.dailyTasks = data.dailyTasks;
    renderSales();
  } catch (err) {
    toast(err.message || "Couldn't load the sales data.", "error");
  } finally {
    loadSales._busy = false;
  }
}

const pct1 = (x) => (x === null || x === undefined ? "—" : (x * 100).toFixed(1) + "%");

function renderApptsStep() {
  const weeks = sales.appts?.weeks || [];
  const latest = weeks[0] || null;
  let html = `
  <p class="card-help">Export the Builder Prime <b>Meetings</b> report for one
  week (Sun–Sat) — the title pins which week it saves to, so you can backfill
  past weeks too. Appointments are rows with a client; <b>Cancelled</b> comes
  from the Meeting Status column. Re-uploading a week replaces it.</p>
  <div class="pipeline-bar">
    <div class="pipeline-status">${
      latest
        ? `<strong>Week of ${fmtDay(latest.weekStart)}</strong> · ${latest.total} appointments · ${latest.cancelled} cancelled · uploaded ${fmtDate(latest.uploadedAt)}`
        : "Upload the weekly <strong>Meetings</strong> export to start."
    }</div>
    <div class="pipeline-actions">
      <label class="btn-upload"><span>Upload meetings</span>
        <input type="file" accept=".xlsx,.xls" data-upload="meetings" hidden />
      </label>
    </div>
  </div>`;
  if (!weeks.length) return html;

  html += `<p class="hint">The <b>appointments-per-day chart</b> (by market and
  by rep) lives in the Daily section up top — this step keeps the weekly
  rollups.</p>`;

  // Week-over-week cancellation trend.
  html += `
  <table class="mtg-table leads-table">
    <thead><tr><th>Week</th><th>Appts</th><th>Cancelled</th><th>Cancel %</th><th>Δ vs prior</th></tr></thead>
    <tbody>
      ${weeks
        .map((w, i) => {
          const prior = weeks[i + 1];
          const delta =
            prior && w.cancelRate !== null && prior.cancelRate !== null
              ? (w.cancelRate - prior.cancelRate) * 100
              : null;
          return `<tr>
            <td>${fmtDay(w.weekStart)}</td>
            <td><b>${w.total}</b></td>
            <td>${w.cancelled}</td>
            <td><b>${pct1(w.cancelRate)}</b></td>
            <td class="${delta !== null && delta > 0.5 ? "lead-down" : delta !== null && delta < -0.5 ? "lead-up" : ""}">${
              delta !== null ? (delta > 0 ? "+" : "") + delta.toFixed(1) + " pts" : "—"
            }</td>
          </tr>`;
        })
        .join("")}
    </tbody>
  </table>`;

  // Per-market appointments for the latest week (zips joined via the leads).
  if (latest?.byClass?.length) {
    const prior = weeks[1] || null;
    const priorByCls = new Map((prior?.byClass || []).map((c) => [c.className, c]));
    html += `
    <details class="mtg-class" data-open="appts:markets" ${meeting.open.has("appts:markets") ? "open" : ""}>
      <summary><span class="mtg-class-name">By market — week of ${fmtDay(latest.weekStart)}</span>
        <span class="mtg-class-info">${latest.byClass.length} markets${prior ? ` · vs ${fmtDay(prior.weekStart)}` : ""}</span>
      </summary>
      <table class="mtg-table leads-table">
        <thead><tr><th>Market</th><th>Appts</th>${prior ? "<th>Prior wk</th>" : ""}<th>Cancelled</th><th>Cancel %</th></tr></thead>
        <tbody>
          ${latest.byClass
            .map((c) => {
              const p = priorByCls.get(c.className);
              const rate = c.total > 0 ? c.cancelled / c.total : null;
              return `<tr>
                <td>${escapeHtml(c.className)}</td>
                <td><b>${c.total}</b></td>
                ${prior ? `<td>${p ? p.total : "—"}</td>` : ""}
                <td>${c.cancelled || ""}</td>
                <td class="${rate !== null && rate >= 0.3 ? "lead-down" : ""}">${rate !== null && c.cancelled ? pct1(rate) : "—"}</td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    </details>`;
  } else if (latest) {
    html += `<p class="hint">Re-upload this week's Meetings export to see the
      market split (older uploads didn't store the appointment zips).</p>`;
  }

  // Per-rep appointments for the latest week, with the prior week alongside.
  if (latest?.byRep?.length) {
    const prior = weeks[1] || null;
    const priorByRep = new Map((prior?.byRep || []).map((r) => [r.rep, r]));
    const openKey = "appts:reps";
    html += `
    <details class="mtg-class" data-open="${openKey}" ${meeting.open.has(openKey) ? "open" : ""}>
      <summary><span class="mtg-class-name">Appointments per rep — week of ${fmtDay(latest.weekStart)}</span>
        <span class="mtg-class-info">${latest.byRep.length} reps${prior ? ` · vs ${fmtDay(prior.weekStart)}` : ""}</span>
      </summary>
      <table class="mtg-table leads-table">
        <thead><tr><th>Rep</th><th>Appts</th>${prior ? "<th>Prior wk</th>" : ""}<th>Cancelled</th><th>Cancel %</th></tr></thead>
        <tbody>
          ${latest.byRep
            .map((r) => {
              const p = priorByRep.get(r.rep);
              const rate = r.total > 0 ? r.cancelled / r.total : null;
              return `<tr>
                <td>${escapeHtml(r.rep)}</td>
                <td><b>${r.total}</b></td>
                ${prior ? `<td>${p ? p.total : "—"}</td>` : ""}
                <td>${r.cancelled || ""}</td>
                <td class="${rate !== null && rate >= 0.3 ? "lead-down" : ""}">${rate !== null && r.cancelled ? pct1(rate) : "—"}</td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    </details>`;
  }
  return html;
}

function renderDailyStep() {
  const d = sales.daily;
  if (!sales.meta || !d) {
    return `<p class="card-help">Powered by the leads report — upload the
    <b>Clients List</b> in Weekly step 1 and the daily flow shows up here.</p>`;
  }
  const g = sales.goals || {};
  let html = "";

  // Freshness: the daily view is only as good as the last upload.
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (d.dataThroughMs !== null && d.dataThroughMs < todayUtc) {
    html += `<div class="stg-warn">⏱ Counts run through <b>${fmtMsDate(d.dataThroughMs)}</b> —
      upload today's Clients List (step 1) to see today's leads.</div>`;
  }

  // Rubber vs flake mix — no goals per type, but the ticket gap (~$13.8k
  // rubber vs ~$5.2k flake) means a flake-heavy month misses the $ quota
  // even at full lead volume. Surface the mix as the diagnostic.
  const mx = d.mix;
  if (mx && d.hasType) {
    const sharePct = (v) => (v === null ? "—" : Math.round(v * 100) + "%");
    html += `
    <div class="pace-row${mx.mixWarning ? " off" : ""}">
      <span class="pace-type">Mix</span>
      <span class="pace-mtd">MTD: <b>${mx.flakeMtd}</b> flake · <b>${mx.rubberMtd}</b> rubber
        (rubber ${sharePct(mx.rubberShareMtd)}${mx.rubberSharePrev !== null ? `, last mo ${sharePct(mx.rubberSharePrev)}` : ""})</span>
      ${
        mx.flakeAvgTicket !== null || mx.rubberAvgTicket !== null
          ? `<span class="pace-note">avg ticket: flake ${mx.flakeAvgTicket !== null ? fmtMoney0(mx.flakeAvgTicket) : "—"} · rubber ${mx.rubberAvgTicket !== null ? fmtMoney0(mx.rubberAvgTicket) : "—"}</span>`
          : ""
      }
    </div>`;
    if (mx.mixWarning) {
      html += `<div class="stg-warn">⚠ $ is behind pace while lead volume isn't —
        rubber share fell from ${Math.round(mx.rubberSharePrev * 100)}% to
        ${Math.round(mx.rubberShareMtd * 100)}%. The miss is the <b>mix</b>
        (rubber tickets run ~2.5× flake), not the lead count.</div>`;
    }
  }

  if (!d.hasType) {
    html += `<p class="hint">⚠ The stored leads have no project type — add the
      <b>Project Type</b> column to the Clients List export and re-upload to
      split rubber vs flake (totals work meanwhile).</p>`;
  }

  // Per-location month-to-date vs goals (leads exact; $ joined by client name).
  if (d.byClass?.length) {
    const dRow = (v) =>
      v === null
        ? "—"
        : `<span class="${v >= 0 ? "lead-up" : "lead-down"}">${v >= 0 ? "+" : ""}${Math.round(v)}</span>`;
    const dMoney = (v) =>
      v === null
        ? "—"
        : `<span class="${v >= 0 ? "lead-up" : "lead-down"}">${v >= 0 ? "+" : "−"}${fmtMoney0(Math.abs(v))}</span>`;
    html += `
    <div class="prep-head" style="margin-top:14px"><span class="prep-title">By location — ${escapeHtml(d.month.label)} MTD vs goal</span></div>
    <div class="table-wrap">
    <table class="mtg-table leads-table goal-table">
      <thead><tr><th>Location</th><th>Leads</th><th>Goal</th><th>Δ pace</th><th>Sold $</th><th>$ Goal</th><th>Δ pace</th></tr></thead>
      <tbody>
        ${d.byClass
          .map((c) => {
            const isCo = c.className === "Company";
            const cls = escapeHtml(c.className);
            return `<tr${isCo ? ' class="score-footer"' : ""}>
              <td><b>${cls}</b></td>
              <td><b>${c.leadsMtd}</b></td>
              <td>${
                isCo
                  ? c.leadsGoal ?? "—"
                  : `<input class="goal-cell" type="number" min="0" step="1" inputmode="numeric" data-goal-class="${cls}" data-goal-field="leads" value="${c.leadsGoal ?? ""}" placeholder="—" />`
              }</td>
              <td>${dRow(c.leadsDelta)}${
                !isCo && c.leadsNeededPerDay ? `<span class="inv-dim"> · ${c.leadsNeededPerDay.toFixed(1)}/d</span>` : ""
              }</td>
              <td>${c.volMtd ? fmtMoney0(c.volMtd) : "—"}</td>
              <td>${
                isCo
                  ? c.volGoal ? fmtMoney0(c.volGoal) : "—"
                  : `<input class="goal-cell wide" type="number" min="0" step="1000" inputmode="numeric" data-goal-class="${cls}" data-goal-field="volume" value="${c.volGoal ?? ""}" placeholder="—" />`
              }</td>
              <td>${dMoney(c.volDelta)}</td>
            </tr>`;
          })
          .join("")}
      </tbody>
    </table>
    </div>
    <p class="hint">Goals seeded from the <b>Quick Pacing</b> tracker (Aug 2026) —
      edit any cell when the month's goals change. Sold $ needs the Sold Contracts
      upload${d.volJoin.total ? ` (per-location $ joined by client name: ${d.volJoin.joined}/${d.volJoin.total} this month; the Company row is exact)` : ""}.</p>`;
  }

  html += renderLeadBarChart(d);
  return html;
}

/**
 * Daily lead volume, last ~3 months — stacked columns (flake / rubber /
 * untyped) in an inline SVG, with a tap/hover readout and a table view.
 */
function renderLeadBarChart(d) {
  const allDays = [...d.days].reverse(); // oldest → newest, left → right
  // Market filter: chips for every market seen in the window.
  const marketSet = new Set();
  for (const day of allDays) {
    for (const cls of Object.keys(day.byClass || {})) marketSet.add(cls);
  }
  const markets = [...marketSet].sort();
  if (sales.chartClass && !marketSet.has(sales.chartClass)) sales.chartClass = null;
  const sel = sales.chartClass;
  const zero = { flake: 0, rubber: 0, other: 0, total: 0 };
  const days = allDays.map((day) => ({
    date: day.date,
    ...(sel ? day.byClass?.[sel] ?? zero : day),
  }));
  const n = days.length;
  const showOther = d.hasType && days.some((day) => day.other > 0);
  const stacked = d.hasType;

  const SLOT = 5;
  const PAD_L = 30;
  const PAD_T = 8;
  const PAD_B = 18;
  const H = 150;
  const W = PAD_L + n * SLOT + 6;
  const plotH = H - PAD_T - PAD_B;
  const max = Math.max(1, ...days.map((day) => day.total));
  // Clean axis ceiling: 1/2/5 × 10^k above the max.
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  const yMax = [1, 2, 5, 10].map((m) => m * pow).find((v) => v >= max) || max;
  const y = (v) => PAD_T + plotH * (1 - v / yMax);
  const GAP = 1.5; // surface gap between stacked segments
  const BW = 3.4;

  let bars = "";
  let months = "";
  let hits = "";
  for (let i = 0; i < n; i++) {
    const day = days[i];
    const x = (PAD_L + i * SLOT).toFixed(1);
    // Segments bottom-up: flake, rubber, untyped (single hue when untyped-only).
    const segs = stacked
      ? [
          ["lb-flake", day.flake],
          ["lb-rubber", day.rubber],
          ["lb-other", day.other],
        ]
      : [["lb-flake", day.total]];
    let base = 0;
    for (const [cls, v] of segs) {
      if (!v) continue;
      const top = y(base + v);
      const bottom = y(base) - (base > 0 ? GAP : 0);
      const h = Math.max(0.8, bottom - top);
      bars += `<rect class="${cls}" x="${x}" width="${BW}" y="${top.toFixed(1)}" height="${h.toFixed(1)}" rx="1.2"/>`;
      base += v;
    }
    const dt = new Date(day.date + "T12:00:00Z");
    if (dt.getUTCDate() === 1 || i === 0) {
      months += `<line class="lb-grid" x1="${x}" x2="${x}" y1="${PAD_T}" y2="${H - PAD_B + 3}"/>
        <text class="lb-txt" x="${Number(x) + 2}" y="${H - 5}">${dt.toLocaleDateString(undefined, { month: "short", timeZone: "UTC" })}</text>`;
    }
    const label = `${sel ? sel + " — " : ""}${fmtDay(day.date)}: ${day.total} lead${day.total === 1 ? "" : "s"}${
      stacked ? ` — ${day.flake} flake · ${day.rubber} rubber${day.other ? ` · ${day.other} untyped` : ""}` : ""
    }`;
    hits += `<rect class="lb-hit js-bar-hit" data-capfor="lead-chart-cap" data-cap="${escapeHtml(label)}" x="${(PAD_L + i * SLOT - (SLOT - BW) / 2).toFixed(1)}" width="${SLOT}" y="0" height="${H}"><title>${escapeHtml(label)}</title></rect>`;
  }

  const gridVals = [yMax / 2, yMax];
  const latest = days[n - 1];
  const defaultCap = latest
    ? `${sel ? sel + " — " : ""}${fmtDay(latest.date)}: ${latest.total} leads${stacked ? ` — ${latest.flake} flake · ${latest.rubber} rubber` : ""}`
    : "";

  return `
  <div class="prep-head" style="margin-top:14px">
    <span class="prep-title">Daily leads — last 3 months${sel ? ` · ${escapeHtml(sel)}` : ""}</span>
    ${
      stacked
        ? `<span class="lb-legend"><i class="lb-sw lb-flake"></i>Flake <i class="lb-sw lb-rubber"></i>Rubber${showOther ? `<i class="lb-sw lb-other"></i>Untyped` : ""}</span>`
        : ""
    }
  </div>
  ${
    markets.length > 1
      ? `<div class="class-chips lb-chips">
          <button type="button" class="chip-btn ${sel === null ? "active" : ""}" data-act="chart-class">All markets</button>
          ${markets
            .map(
              (m) => `<button type="button" class="chip-btn ${sel === m ? "active" : ""}" data-act="chart-class" data-cls="${escapeHtml(m)}">${escapeHtml(m)}</button>`
            )
            .join("")}
        </div>`
      : ""
  }
  <div class="lb-cap" id="lead-chart-cap">${escapeHtml(defaultCap)}</div>
  <div class="lb-wrap">
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Daily lead volume, last 3 months">
      ${gridVals
        .map(
          (v) => `<line class="lb-grid" x1="${PAD_L - 3}" x2="${W}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>
        <text class="lb-txt" x="${PAD_L - 6}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${v}</text>`
        )
        .join("")}
      <line class="lb-grid" x1="${PAD_L - 3}" x2="${W}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>
      ${months}${bars}${hits}
    </svg>
  </div>
  <details class="mtg-class" data-open="daily:table" ${meeting.open.has("daily:table") ? "open" : ""}>
    <summary><span class="mtg-class-name">Daily table</span>
      <span class="mtg-class-info">${n} days</span>
    </summary>
    <div class="table-wrap lb-tablewrap">
    <table class="mtg-table leads-table">
      <thead><tr><th>Day</th>${stacked ? `<th>Flake</th><th>Rubber</th>${showOther ? "<th>?</th>" : ""}` : ""}<th>Total</th></tr></thead>
      <tbody>
        ${[...days]
          .reverse()
          .map(
            (day) => `<tr>
          <td>${fmtDay(day.date)}</td>
          ${stacked ? `<td>${day.flake || ""}</td><td>${day.rubber || ""}</td>${showOther ? `<td>${day.other || ""}</td>` : ""}` : ""}
          <td><b>${day.total || ""}</b></td>
        </tr>`
          )
          .join("")}
      </tbody>
    </table>
    </div>
  </details>`;
}

/**
 * Appointments per day — stacked flake/rubber/untyped columns across every
 * stored Meetings week, filterable by market (chips) or by rep (select).
 */
function renderApptDayChart() {
  const days = sales.appts?.days || [];
  if (!days.length) {
    return `<p class="hint">${
      sales.appts?.weeks?.length
        ? "Re-upload the weekly Meetings exports (Weekly step 2) — older uploads didn't store the day-by-day counts."
        : "Upload the weekly Meetings export in Weekly step 2 to build the per-day chart."
    }</p>`;
  }

  const clsSet = new Set();
  const repTotals = new Map();
  for (const d of days) {
    for (const c of Object.keys(d.byClass || {})) {
      if (c !== "Unassigned") clsSet.add(c);
    }
    for (const [r, v] of Object.entries(d.byRep || {})) {
      repTotals.set(r, (repTotals.get(r) || 0) + v.t);
    }
  }
  const markets = [...clsSet].sort();
  const reps = [...repTotals.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r);
  if (sales.apptClass && !clsSet.has(sales.apptClass)) sales.apptClass = null;
  if (sales.apptRep && !repTotals.has(sales.apptRep)) sales.apptRep = null;
  const selCls = sales.apptClass;
  const selRep = sales.apptRep;
  const selLabel = selRep || selCls || "";

  // Continuous date range (gap-filled) from first to last stored day.
  const byDate = new Map(days.map((d) => [d.date, d]));
  const first = Date.parse(days[0].date + "T12:00:00Z");
  const last = Date.parse(days[days.length - 1].date + "T12:00:00Z");
  const zero = { t: 0, c: 0, f: 0, r: 0 };
  const series = [];
  for (let ms = first; ms <= last; ms += 86400000) {
    const iso = new Date(ms).toISOString().slice(0, 10);
    const d = byDate.get(iso);
    const v = !d
      ? zero
      : selRep
      ? d.byRep[selRep] ?? zero
      : selCls
      ? d.byClass[selCls] ?? zero
      : d;
    series.push({ date: iso, t: v.t, c: v.c, f: v.f, r: v.r });
  }

  const n = series.length;
  const PAD_L = 30;
  const PAD_T = 8;
  const PAD_B = 18;
  const H = 140;
  // Adapt the slot so few days don't blow up the uniform SVG scale.
  const SLOT = Math.max(3, Math.min(28, Math.floor(424 / n)));
  const BW = Math.min(24, Math.max(2.4, SLOT * 0.7));
  const W = PAD_L + n * SLOT + 6;
  const plotH = H - PAD_T - PAD_B;
  const max = Math.max(1, ...series.map((d) => d.t));
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  const yMax = [1, 2, 5, 10].map((m) => m * pow).find((v) => v >= max) || max;
  const y = (v) => PAD_T + plotH * (1 - v / yMax);
  const GAP = 1.5;

  let bars = "";
  let months = "";
  let hits = "";
  let lastMonth = -1;
  for (let i = 0; i < n; i++) {
    const d = series[i];
    const x = (PAD_L + i * SLOT).toFixed(1);
    const untyped = Math.max(0, d.t - d.f - d.r);
    let base = 0;
    for (const [cls, v] of [
      ["lb-flake", d.f],
      ["lb-rubber", d.r],
      ["lb-other", untyped],
    ]) {
      if (!v) continue;
      const top = y(base + v);
      const bottom = y(base) - (base > 0 ? GAP : 0);
      bars += `<rect class="${cls}" x="${x}" width="${BW.toFixed(1)}" y="${top.toFixed(1)}" height="${Math.max(0.8, bottom - top).toFixed(1)}" rx="1.2"/>`;
      base += v;
    }
    const dt = new Date(d.date + "T12:00:00Z");
    if (dt.getUTCMonth() !== lastMonth) {
      lastMonth = dt.getUTCMonth();
      months += `<line class="lb-grid" x1="${x}" x2="${x}" y1="${PAD_T}" y2="${H - PAD_B + 3}"/>
        <text class="lb-txt" x="${Number(x) + 2}" y="${H - 5}">${dt.toLocaleDateString(undefined, { month: "short", timeZone: "UTC" })}</text>`;
    }
    const label = `${selLabel ? selLabel + " — " : ""}${fmtDay(d.date)}: ${d.t} appt${d.t === 1 ? "" : "s"}${
      d.t ? ` — ${d.f} flake · ${d.r} rubber${untyped ? ` · ${untyped} untyped` : ""}${d.c ? ` · ${d.c} cancelled` : ""}` : ""
    }`;
    hits += `<rect class="lb-hit js-bar-hit" data-capfor="appt-chart-cap" data-cap="${escapeHtml(label)}" x="${(PAD_L + i * SLOT - (SLOT - BW) / 2).toFixed(1)}" width="${SLOT}" y="0" height="${H}"><title>${escapeHtml(label)}</title></rect>`;
  }

  const latest = series[n - 1];
  const defaultCap = latest
    ? `${selLabel ? selLabel + " — " : ""}${fmtDay(latest.date)}: ${latest.t} appts${latest.c ? ` · ${latest.c} cancelled` : ""}`
    : "";

  return `
  <div class="prep-head" style="margin-top:12px">
    <span class="prep-title">Appointments per day${selLabel ? ` · ${escapeHtml(selLabel)}` : ""}</span>
    <span class="lb-legend"><i class="lb-sw lb-flake"></i>Flake <i class="lb-sw lb-rubber"></i>Rubber <i class="lb-sw lb-other"></i>Untyped</span>
  </div>
  <div class="class-chips lb-chips">
    <button type="button" class="chip-btn ${!selCls && !selRep ? "active" : ""}" data-act="appt-class">All markets</button>
    ${markets
      .map(
        (m) => `<button type="button" class="chip-btn ${selCls === m ? "active" : ""}" data-act="appt-class" data-cls="${escapeHtml(m)}">${escapeHtml(m)}</button>`
      )
      .join("")}
    <select class="ab-select ${selRep ? "active" : ""}" data-appt-rep aria-label="Filter by sales rep">
      <option value="">Rep…</option>
      ${reps
        .map(
          (r) => `<option value="${escapeHtml(r)}" ${selRep === r ? "selected" : ""}>${escapeHtml(r)}</option>`
        )
        .join("")}
    </select>
  </div>
  <div class="lb-cap" id="appt-chart-cap">${escapeHtml(defaultCap)}</div>
  <div class="lb-wrap">
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Appointments per day">
      ${[yMax / 2, yMax]
        .map(
          (v) => `<line class="lb-grid" x1="${PAD_L - 3}" x2="${W}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>
        <text class="lb-txt" x="${PAD_L - 6}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${v}</text>`
        )
        .join("")}
      <line class="lb-grid" x1="${PAD_L - 3}" x2="${W}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>
      ${months}${bars}${hits}
    </svg>
  </div>
  <p class="hint">Zips from each meeting's title map appointments to markets via
  the leads upload; the rep filter overrides the market chips. Cancelled counts
  show in the readout when you tap a day.</p>`;
}

function renderSales() {
  const weeks = sales.appts?.weeks || [];
  const latest = weeks[0] || null;
  const step = (n, key, title, sub, done, body) => `
    <details class="card mtg-section${done ? " done" : ""}" data-open="${key}" ${
    meeting.open.has(key) ? "open" : ""
  }>
      <summary>
        <span class="mtg-num${done ? " ok" : ""}">${done ? "✓" : n}</span>
        <span class="mtg-head">
          <span class="mtg-title">${escapeHtml(title)}</span>
          <span class="mtg-sub">${escapeHtml(sub)}</span>
        </span>
        <span class="mtg-chev">▾</span>
      </summary>
      <div class="mtg-body">${body}</div>
    </details>`;

  const leadsSub = sales.meta
    ? `${sales.meta.count.toLocaleString()} leads loaded`
    : "upload the clients export";
  const apptsSub = latest
    ? `wk ${fmtDay(latest.weekStart)}: ${latest.total} appts · ${pct1(latest.cancelRate)} cancelled`
    : "upload the weekly meetings export";
  const salesSub = sales.sales?.soldMeta
    ? `${sales.sales.soldMeta.count.toLocaleString()} contracts${sales.sales.perfMeta ? ` · ${sales.sales.perfMeta.reps} reps` : ""}`
    : "upload the sold + lead performance exports";

  // Daily card subtitle: the Company pace row is the health signal.
  const co = (sales.daily?.byClass || []).find((c) => c.className === "Company");
  const dailySub = !sales.meta
    ? "needs the leads report (Weekly step 1)"
    : co && (co.leadsDelta !== null || co.volDelta !== null)
    ? [
        co.leadsDelta !== null
          ? `leads ${co.leadsDelta >= 0 ? "+" : ""}${Math.round(co.leadsDelta)} vs pace`
          : null,
        co.volDelta !== null
          ? `$ ${co.volDelta >= 0 ? "+" : "−"}${Math.round(Math.abs(co.volDelta) / 1000)}k vs pace`
          : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "set the monthly goals";

  const checks = sales.dailyTasks?.checks || {};
  const dailyDone = (key) => Boolean(checks[key]?.done);
  const checkRow = (key, label) => `
    <label class="mtg-signoff${dailyDone(key) ? " signed" : ""}">
      <input type="checkbox" data-daily="${key}" ${dailyDone(key) ? "checked" : ""} />
      <span>${dailyDone(key) ? `${label} — done today ✓` : label}</span>
    </label>`;

  const onPace =
    Boolean(sales.meta) && co && (co.leadsDelta ?? 0) >= 0 && (co.volDelta ?? 0) >= 0;

  const apptDays = sales.appts?.days || [];
  const lastApptDay = apptDays[apptDays.length - 1] || null;
  const apptDaySub = lastApptDay
    ? `${fmtDay(lastApptDay.date)}: ${lastApptDay.t} appts${lastApptDay.c ? ` · ${lastApptDay.c} cancelled` : ""}`
    : "needs the meetings export (Weekly step 2)";

  $("sales-sections").innerHTML = `
    <div class="sales-group">Daily</div>
    ${step(1, "ssec:daily", "Lead flow vs goal — rubber & flake", dailySub, onPace, renderDailyStep())}
    ${step(
      2,
      "ssec:apptday",
      "Appointments per day",
      apptDaySub,
      Boolean(apptDays.length),
      renderApptDayChart()
    )}
    ${step(
      3,
      "ssec:contracts",
      "Review sold contracts",
      sales.dailyTasks?.recentSold?.length
        ? `${sales.dailyTasks.recentSold.length} in the last 3 days`
        : "needs a fresh sold-contracts upload",
      dailyDone("contracts"),
      renderContractsReviewStep() + checkRow("contracts", "Contracts reviewed")
    )}
    ${step(
      4,
      "ssec:rilla",
      "Listen to Rilla recordings",
      dailyDone("rilla") ? "done today" : "pick 2–3 reps' calls",
      dailyDone("rilla"),
      renderRillaStep() + checkRow("rilla", "Rilla recordings reviewed")
    )}
    ${step(
      5,
      "ssec:rehash",
      "Call the no-sales (rehash)",
      sales.dailyTasks?.rehash?.length
        ? `${sales.dailyTasks.rehash.length} demos didn't close — call them`
        : "needs this week's meetings export",
      dailyDone("rehash"),
      renderRehashStep() + checkRow("rehash", "Rehash calls made")
    )}
    <div class="sales-group">Weekly</div>
    ${step(1, "ssec:leads", "Leads — by market", leadsSub, Boolean(sales.meta), renderLeadsStep())}
    ${step(
      2,
      "ssec:appts",
      "Meetings — appointments & cancellations",
      apptsSub,
      Boolean(latest),
      renderApptsStep()
    )}
    ${step(
      3,
      "ssec:sales",
      "Sales — markets & reps",
      salesSub,
      Boolean(sales.sales?.soldMeta && sales.sales?.perfMeta),
      renderSalesStep()
    )}`;
}

/** Daily 2 — eyeball yesterday's contracts: right price, right product. */
function renderContractsReviewStep() {
  const t = sales.dailyTasks || {};
  let html = `
  <p class="card-help">Check every new contract: sale amount vs the average
  ticket, right project type, discounts in line. Needs a fresh <b>Sold
  Contracts</b> upload (Weekly step 3) — the list shows the last 3 days.</p>`;
  if (!t.recentSold?.length) {
    html += `<p class="hint">${
      t.soldUploadedAt
        ? `No contracts in the last 3 days of the stored upload (from ${fmtDate(t.soldUploadedAt)}) — upload today's export to review today's sales.`
        : "Upload the Sold Contracts export to see the contracts to review."
    }</p>`;
    return html;
  }
  html += `
  <table class="mtg-table leads-table">
    <thead><tr><th>Date</th><th>Rep</th><th>Client</th><th>Type</th><th>Sale $</th></tr></thead>
    <tbody>
      ${t.recentSold
        .map(
          (s) => `<tr>
        <td>${fmtMsDate(s.saleMs)}</td>
        <td>${escapeHtml(s.rep || "—")}</td>
        <td>${escapeHtml(s.client || "—")}</td>
        <td>${/rubber/i.test(s.projectType || "") ? "Rubber" : "Flake"}</td>
        <td><b>${fmtMoney0(s.saleAmount)}</b></td>
      </tr>`
        )
        .join("")}
    </tbody>
  </table>`;
  return html;
}

/** Daily 3 — Rilla call recordings. */
function renderRillaStep() {
  const url = sales.dailyTasks?.rillaUrl;
  return `
  <p class="card-help">Listen to a few of yesterday's sales conversations —
  rotate through the reps so everyone gets heard each week. Note coaching
  points for the weekly one-on-ones.</p>
  ${
    url
      ? `<a class="btn-upload" href="${escapeHtml(url)}" target="_blank" rel="noopener"><span>Open Rilla ↗</span></a>`
      : `<p class="hint">Set the <code>RILLA_URL</code> environment variable to get a one-tap link here.</p>`
  }`;
}

/** Daily 4 — rehash: demos that didn't close, with phone numbers. */
function renderRehashStep() {
  const t = sales.dailyTasks || {};
  let html = `
  <p class="card-help">Every demo that didn't close is a warm call — try to
  save it or book a second look. Built from the latest <b>Meetings</b> upload
  (statuses DEMO NO SALE / STILL INTERESTED).</p>`;
  if (!t.rehash?.length) {
    html += `<p class="hint">${
      t.rehashWeek
        ? "Re-upload this week's Meetings export — the stored week predates the call list."
        : "Upload the weekly Meetings export (Weekly step 2) to build the call list."
    }</p>`;
    return html;
  }
  html += `<p class="hint">Week of ${fmtDay(t.rehashWeek)} — ${t.rehash.length} to call.</p>
  <table class="mtg-table leads-table">
    <thead><tr><th>Client</th><th>Phone</th><th>Rep</th><th>Status</th></tr></thead>
    <tbody>
      ${t.rehash
        .map(
          (r) => `<tr>
        <td>${escapeHtml(r.client)}</td>
        <td>${r.phone ? `<a href="tel:${escapeHtml(r.phone.replace(/[^0-9+]/g, ""))}">${escapeHtml(r.phone)}</a>` : "—"}</td>
        <td>${escapeHtml(r.rep || "—")}</td>
        <td>${escapeHtml(r.status)}</td>
      </tr>`
        )
        .join("")}
    </tbody>
  </table>`;
  return html;
}

async function handleSalesUpload(kind, file) {
  if (!file) return;
  if (typeof XLSX === "undefined") {
    toast("Spreadsheet reader didn't load — check your connection.", "error");
    return;
  }
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {
    header: 1,
    raw: true,
    blankrows: false,
  });

  if (kind === "leads") {
    const data = await uploadLeadsChunked(file.name, rows);
    toast(`${data.count.toLocaleString()} leads loaded ✓`, "success");
    sales.analysis = null;
    meeting.open.add("ssec:leads");
  } else if (kind === "sold") {
    const data = await uploadSoldChunked(file.name, rows);
    toast(`${data.count.toLocaleString()} sold contracts loaded ✓`, "success");
  } else if (kind === "perf") {
    const data = await meetingApi("/api/leads/perf", "POST", { filename: file.name, rows });
    toast(`Lead performance loaded — ${data.reps} reps ✓`, "success");
  } else if (kind === "meetings") {
    const data = await meetingApi("/api/leads/meetings", "POST", { filename: file.name, rows });
    toast(
      `Week of ${fmtDay(data.weekStart)} saved — ${data.total} appointments, ${data.cancelled} cancelled ✓`,
      "success"
    );
    meeting.open.add("ssec:appts");
  }
  await loadSales();
}

async function salesChange(e) {
  const t = e.target;
  try {
    if (t.dataset.apptRep !== undefined) {
      sales.apptRep = t.value || null;
      if (sales.apptRep) sales.apptClass = null;
      renderSales();
      return;
    }
    if (t.dataset.daily) {
      await meetingApi("/api/leads/daily-check", "POST", {
        key: t.dataset.daily,
        done: t.checked,
      });
      await loadSales();
      return;
    }
    if (t.dataset.goalClass && t.dataset.goalField) {
      await meetingApi("/api/leads/goals", "POST", {
        className: t.dataset.goalClass,
        [t.dataset.goalField]: t.value === "" ? null : Number(t.value),
      });
      toast(`${t.dataset.goalClass} goal saved ✓`, "success");
      await loadSales();
      return;
    }
    if (t.dataset.goal) {
      await meetingApi("/api/leads/goals", "POST", {
        [t.dataset.goal]: t.value === "" ? null : Number(t.value),
      });
      toast("Goal saved ✓", "success");
      await loadSales();
      return;
    }
    if (!t.dataset.upload) return;
    await handleSalesUpload(t.dataset.upload, t.files[0]);
    t.value = "";
  } catch (err) {
    toast(err.message || "Couldn't save.", "error");
    if (t.dataset.upload) t.value = "";
  }
}

async function salesClick(e) {
  const hit = e.target.closest?.(".js-bar-hit");
  if (hit) {
    const cap = $(hit.dataset.capfor || "lead-chart-cap");
    if (cap) cap.textContent = hit.dataset.cap;
    return;
  }
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  try {
    if (btn.dataset.act === "chart-class") {
      sales.chartClass = btn.dataset.cls || null;
      renderSales();
      return;
    }
    if (btn.dataset.act === "appt-class") {
      sales.apptClass = btn.dataset.cls || null;
      sales.apptRep = null;
      renderSales();
      return;
    }
    if (btn.dataset.act === "leads-window") {
      sales.days = Number(btn.dataset.days);
      sales.analysis = null;
      renderSales(); // shows the loading state
      await loadSales();
    } else if (btn.dataset.act === "open-map") {
      await openLeadMap();
    }
  } catch (err) {
    toast(err.message || "Couldn't load.", "error");
  }
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
      await handleMeetingUpload(t.dataset.upload, t.files[0], t.dataset.class);
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
      const className = btn.dataset.class;
      const sheet = meeting.payroll[className].sheets[Number(btn.dataset.idx)];
      await meetingApi("/api/meeting/labor", "PATCH", {
        week: meeting.week,
        className,
        productionPayroll: sheet.productionTotal,
        sheetName: sheet.sheetName,
        by: meetingUser() || null,
      });
      delete meeting.payroll[className];
      toast(`Payroll set for ${className} ✓`, "success");
      await loadMeeting();
    } else if (act === "payroll-cancel") {
      delete meeting.payroll[btn.dataset.class];
      renderMeeting();
    }
  } catch (err) {
    toast(err.message || "Couldn't save.", "error");
  }
}

async function handleMeetingUpload(kind, file, className) {
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
  } else if (kind === "pipeline") {
    const data = await meetingApi("/api/pipeline", "POST", {
      filename: file.name,
      rows: firstRows(),
    });
    toast(`Loaded ${data.pipeline.rowCount} pipeline jobs ✓`, "success");
    refreshPipelineStatus(); // keep the Schedule tab's status bar in sync
  } else if (kind === "payroll") {
    // One payroll workbook per market. Each has one sheet per pay period —
    // send them all and let the user pick the right week on that market's row.
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
    meeting.payroll[className] = { sheets: data.sheets };
    meeting.open.add("sec:labor");
  }
  await loadMeeting();
}

// ─────────────────────────── Staging lists ───────────────────────────
// What material each location pulls and sets out ahead of a week's installs.
// Defaults to NEXT week: you stage this week for next week's jobs.

const staging = { week: null, view: null };
const inventory = { week: null, view: null };

function nextWeekStartIso() {
  return shiftWeekIso(currentWeekStartIso(), 1);
}

async function loadStaging(week) {
  staging.week = week || staging.week || nextWeekStartIso();
  try {
    const res = await fetch(`/api/staging?week=${staging.week}`);
    if (!res.ok) throw new Error("Couldn't load staging.");
    staging.view = await res.json();
    staging.week = staging.view.weekStart;
    renderStaging();
  } catch (err) {
    $("staging-list").innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
  }
}

function stagingJobQty(j) {
  const m = j.material;
  if (m.kind === "flake") return `${fmtN(m.flakeBoxes)} bx · ${fmtN(m.flakePounds)} lb`;
  if (m.kind === "rubber") return `${fmtN(m.rubberBags)} bags`;
  return "—";
}

function renderStaging() {
  const v = staging.view;
  $("staging-week-range").textContent = `${fmtDay(v.weekStart)} – ${fmtDay(v.weekEnd)}`;
  if (!v.classes.length) {
    $("staging-list").innerHTML = `<div class="empty">Nothing scheduled for this week yet.
      Upload the pipeline (Meeting or Schedule tab) and set SQFT + color per job.</div>`;
    return;
  }
  $("staging-list").innerHTML = v.classes
    .map((cls) => {
      const t = cls.totals;
      const coatRows = [
        ["Polyurea basecoat A", t.basecoatAGallons, "gal"],
        ["Polyurea basecoat B", t.basecoatBGallons, "gal"],
        ["Polyaspartic topcoat A", t.topcoatAGallons, "gal"],
        ["Polyaspartic topcoat B", t.topcoatBGallons, "gal"],
        ["Rubber binder", t.binderBuckets, "buckets"],
        ["Rubber primer", t.primerBuckets, "buckets"],
      ].filter(([, qty]) => qty > 0);

      return `
      <div class="card stg-card">
        <div class="stg-head">
          <h2>${escapeHtml(cls.className)}</h2>
          <span class="stg-meta">${cls.jobs.length} jobs · ${fmtN(
            t.sqftFlake + t.sqftRubber,
            0
          )} sqft</span>
        </div>
        ${
          cls.missingInfoCount
            ? `<div class="stg-warn">⚠ ${cls.missingInfoCount} job${
                cls.missingInfoCount === 1 ? "" : "s"
              } missing SQFT or color — set them on the Schedule tab to stage material.</div>`
            : ""
        }
        ${
          cls.colors.length
            ? `<table class="mtg-table stg-table">
                <thead><tr><th>Pull</th><th>Jobs</th><th>Sqft</th><th>Qty</th></tr></thead>
                <tbody>${cls.colors
                  .map(
                    (c) => `<tr>
                      <td>${c.kind === "flake" ? "🎨" : "⬛"} ${escapeHtml(c.product)}</td>
                      <td>${c.jobs}</td>
                      <td>${fmtN(c.sqft, 0)}</td>
                      <td><b>${
                        c.kind === "flake"
                          ? `${fmtN(c.flakeBoxes)} boxes (${fmtN(c.flakePounds)} lb)`
                          : `${fmtN(c.rubberBags)} bags`
                      }</b></td>
                    </tr>`
                  )
                  .join("")}</tbody>
              </table>`
            : `<div class="empty small">No material to stage (no coating jobs).</div>`
        }
        ${
          coatRows.length
            ? `<div class="stg-coats">${coatRows
                .map(([label, qty, unit]) => `<span>${label}: <b>${fmtN(qty)} ${unit}</b></span>`)
                .join("")}</div>`
            : ""
        }
        <details class="mtg-class stg-jobs">
          <summary><span class="mtg-class-name">Jobs</span>
            <span class="mtg-class-info">${cls.jobs.length}</span></summary>
          ${cls.jobs
            .map(
              (j) => `<div class="mtg-line${j.missingInfo ? " stg-missing" : ""}">
                ${j.dayLabel ? `<b>${escapeHtml(j.dayLabel)}</b> · ` : ""}#${escapeHtml(
                  j.jobNumber
                )} · ${escapeHtml(j.customer)}${j.crew ? ` · ${escapeHtml(j.crew)}` : ""}
                <span class="mtg-line-desc">${escapeHtml(j.projectType)} · ${
                  j.sqft ? fmtN(j.sqft, 0) + " sqft" : "no sqft"
                } · ${escapeHtml(j.color || "no color")} · ${stagingJobQty(j)}${
                  j.missingInfo ? " · ⚠ missing info" : ""
                }</span>
              </div>`
            )
            .join("")}
        </details>
      </div>`;
    })
    .join("");
}

// ─────────────────────────── Inventory ───────────────────────────
async function loadInventory(week) {
  inventory.week = week || inventory.week || nextWeekStartIso();
  try {
    const res = await fetch(`/api/inventory?week=${inventory.week}`);
    if (!res.ok) throw new Error("Couldn't load inventory.");
    inventory.view = await res.json();
    inventory.week = inventory.view.weekStart;
    renderInventory();
  } catch (err) {
    $("inventory-list").innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
  }
}

function renderInventory() {
  const v = inventory.view;
  $("inv-week-range").textContent = `${fmtDay(v.weekStart)} – ${fmtDay(v.weekEnd)}`;
  if (!v.classes.length) {
    $("inventory-list").innerHTML = `<div class="empty">No locations yet — upload a
      pipeline so staging needs show up, then record what's on hand.</div>`;
    return;
  }
  $("inventory-list").innerHTML = v.classes
    .map((cls) => {
      const shortCount = cls.items.filter((i) => i.short > 0).length;
      return `
      <div class="card stg-card">
        <div class="stg-head">
          <h2>${escapeHtml(cls.className)}</h2>
          <span class="stg-meta${shortCount ? " short" : ""}">${
            shortCount ? `${shortCount} short` : "covered ✓"
          }</span>
        </div>
        ${
          cls.items.length
            ? `<table class="mtg-table inv-table">
                <thead><tr><th>Material</th><th>Need</th><th>On hand</th><th></th></tr></thead>
                <tbody>${cls.items
                  .map(
                    (i) => `<tr>
                      <td>${escapeHtml(i.label)}<span class="inv-unit">${escapeHtml(i.unit)}</span></td>
                      <td>${i.needed ? fmtN(i.needed) : "—"}</td>
                      <td><input type="number" min="0" step="0.5" inputmode="decimal"
                        value="${i.onHand || ""}" placeholder="0"
                        data-inv-class="${escapeHtml(cls.className)}" data-inv-key="${escapeHtml(i.key)}" /></td>
                      <td>${
                        i.short > 0
                          ? `<span class="mtg-badge warn">short ${fmtN(i.short)}</span>`
                          : i.needed
                          ? `<span class="mtg-badge ok">ok</span>`
                          : ""
                      }</td>
                    </tr>`
                  )
                  .join("")}</tbody>
              </table>`
            : `<div class="empty small">Nothing needed this week and nothing recorded.</div>`
        }
        ${
          cls.updatedAt
            ? `<p class="hint">Last counted ${fmtDate(cls.updatedAt)}${cls.by ? " by " + escapeHtml(cls.by) : ""}</p>`
            : ""
        }
      </div>`;
    })
    .join("");
}

async function inventoryChange(e) {
  const t = e.target;
  if (!t.dataset.invClass || !t.dataset.invKey) return;
  try {
    const res = await fetch("/api/inventory", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        className: t.dataset.invClass,
        key: t.dataset.invKey,
        qty: Number(t.value) || 0,
        by: localStorage.getItem("meetingUser") || null,
      }),
    });
    if (!res.ok) throw new Error("Couldn't save.");
    await loadInventory();
  } catch (err) {
    toast(err.message || "Couldn't save.", "error");
  }
}

// ─────────────────────────── Xlsx exports (meeting + staging) ───────────────────────────
function sheetFromRows(wb, name, rows, colWidths) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  if (colWidths) ws["!cols"] = colWidths.map((wch) => ({ wch }));
  XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
}

function exportStaging() {
  if (!staging.view || typeof XLSX === "undefined") {
    toast("Load the staging list first.", "error");
    return;
  }
  buildStagingXlsx(staging.view);
}

/** Build + download the staging workbook from a staging view (live or snapshot). */
function buildStagingXlsx(v) {
  const wb = XLSX.utils.book_new();

  // Summary sheet: every location's pull list on one page.
  const summary = [
    [`Staging — week of ${v.weekStart} to ${v.weekEnd}`],
    [],
    ["Location", "Product", "Type", "Jobs", "Sqft", "Boxes", "Pounds", "Bags"],
  ];
  for (const cls of v.classes) {
    for (const c of cls.colors) {
      summary.push([
        cls.className,
        c.product,
        c.kind,
        c.jobs,
        c.sqft,
        c.kind === "flake" ? c.flakeBoxes : "",
        c.kind === "flake" ? c.flakePounds : "",
        c.kind === "rubber" ? c.rubberBags : "",
      ]);
    }
  }
  sheetFromRows(wb, "All locations", summary, [16, 22, 8, 6, 8, 8, 9, 8]);

  for (const cls of v.classes) {
    const t = cls.totals;
    const rows = [
      [`${cls.className} — staging for ${v.weekStart} to ${v.weekEnd}`],
      [],
      ["PULL LIST"],
      ["Product", "Type", "Jobs", "Sqft", "Quantity"],
      ...cls.colors.map((c) => [
        c.product,
        c.kind,
        c.jobs,
        c.sqft,
        c.kind === "flake"
          ? `${c.flakeBoxes} boxes (${c.flakePounds} lb)`
          : `${c.rubberBags} bags`,
      ]),
      [],
      ["COATS & KITS"],
      ["Polyurea basecoat A (gal)", t.basecoatAGallons],
      ["Polyurea basecoat B (gal)", t.basecoatBGallons],
      ["Polyaspartic topcoat A (gal)", t.topcoatAGallons],
      ["Polyaspartic topcoat B (gal)", t.topcoatBGallons],
      ["Rubber binder (buckets)", t.binderBuckets],
      ["Rubber primer (buckets)", t.primerBuckets],
      [],
      ["JOBS"],
      ["Day", "Job #", "Customer", "Crew", "Type", "Sqft", "Color", "Material", "Notes"],
      ...cls.jobs.map((j) => [
        j.dayLabel || "",
        j.jobNumber,
        j.customer,
        j.crew,
        j.projectType,
        j.sqft ?? "",
        j.color || "",
        stagingJobQty(j),
        j.missingInfo ? "MISSING SQFT/COLOR" : "",
      ]),
    ];
    sheetFromRows(wb, cls.className, rows, [12, 10, 22, 18, 16, 7, 16, 22, 20]);
  }

  XLSX.writeFile(wb, `staging-${v.weekStart}.xlsx`);
  toast("Staging list exported ✓", "success");
}

function exportMeeting() {
  if (!meeting.view || typeof XLSX === "undefined") {
    toast("Load the meeting first.", "error");
    return;
  }
  buildMeetingXlsx(meeting.view);
}

/** Build + download the meeting workbook from a meeting view (live or snapshot). */
function buildMeetingXlsx(v, leadsView) {
  const wb = XLSX.utils.book_new();
  const secTitle = Object.fromEntries(MEETING_SECTIONS.map((s) => [s.key, s.title]));

  // Summary: progress, sign-offs, dashboard checks, labor rates.
  const summary = [
    [`Friday Production Meeting — week of ${v.week.weekStart} to ${v.week.weekEnd}`],
    [`${v.doneCount} of ${v.sectionCount} sections done`],
    [],
    ["#", "Section", "Done", "Signed off by", "When"],
    ...v.sections.map((s, i) => [
      i + 1,
      secTitle[s.key] || s.key,
      s.done ? "YES" : "no",
      s.manual?.by || "",
      s.manual?.at ? s.manual.at.slice(0, 10) : "",
    ]),
    [],
    ["DASHBOARD CHECKS"],
    ["Check", "Status", "By", "Notes"],
    ...["reviews", "lytx", "ramp", "vip"].map((k) => [
      secTitle[k],
      v.checks[k].status === "done" ? "Reviewed" : "Pending",
      v.checks[k].by || "",
      v.checks[k].notes || "",
    ]),
    [],
    [`LABOR RATES — week of ${v.labor.weekStart} to ${v.labor.weekEnd} (revenue ÷ payroll × ${v.labor.multiplier})`],
    ["Location", "Completed revenue", "Jobs", "Production payroll", "Rate", "Labor % of revenue"],
    ...v.labor.rows.map((r) => [
      r.className,
      r.revenueOverride ?? r.completedRevenue,
      r.completedJobs,
      r.productionPayroll ?? "",
      r.rate !== null ? Number(r.rate.toFixed(2)) : "",
      r.rate ? Number((100 / r.rate).toFixed(1)) / 100 : "",
    ]),
    ...(invCounts && invCounts.week.weekStart === v.week.weekStart &&
    invCounts.classes.length
      ? [
          [],
          [`MATERIAL COST — purchases + trailer stock change (weekly counts)`],
          ["Location", "Purchases", "Stock begin", "Stock end", "Material cost", "Material % of revenue"],
          ...invCounts.classes.map((c) => {
            const rev = invRevenueFor(v, c.className);
            const cost = c.materialCost ?? "";
            return [
              c.className,
              c.purchases ?? "",
              c.beginValue ?? "",
              c.endValue,
              cost,
              rev && rev > 0 && cost !== "" ? Number(((cost / rev) * 100).toFixed(1)) / 100 : "",
            ];
          }),
          [
            "TOTAL",
            invCounts.totals.purchases,
            invCounts.totals.beginValue,
            invCounts.totals.endValue,
            invCounts.totals.materialCost,
            "",
          ],
        ]
      : []),
  ];
  sheetFromRows(wb, "Summary", summary, [10, 26, 10, 16, 14, 16]);

  // Past due, one block per location.
  const pd = [
    [`Past due balances — ${v.pastDue.openCount} open`],
    v.pastDue.meta?.sourceLabel ? [v.pastDue.meta.sourceLabel] : [],
    [],
    ["Location", "Client", "Inv #", "Balance", "Status", "Reason past due", "Owner", "Action date", "First seen", "Latest update"],
  ];
  for (const cls of v.pastDue.classes) {
    for (const f of cls.items) {
      pd.push([
        cls.className,
        f.client,
        f.invoiceNumber,
        f.balance ?? "",
        f.status === "resolved" ? "RESOLVED" : f.carriedOver ? "carryover" : "open",
        f.reason,
        f.owner,
        f.actionDate || "",
        f.firstSeenWeek,
        f.updates.length ? f.updates[f.updates.length - 1].note : "",
      ]);
    }
  }
  sheetFromRows(wb, "Past due", pd, [14, 20, 9, 11, 10, 30, 14, 11, 11, 34]);

  // Warranties: rollup by lead, then every tagged/open WO by location.
  const wo = [
    [`Warranties — ${v.workOrders.totalOpen} open work orders`],
    [],
    ["NEEDS SCHEDULING — UNSCHEDULED OR PAST DATE, STILL OPEN"],
    ["Location", "WO #", "Client", "Type", "Status", "Why", "Scheduled"],
    ...(v.workOrders.attention || [])
      .slice()
      .sort((a, b) => a.className.localeCompare(b.className))
      .map((a) => [
        a.className,
        a.woNumber,
        a.client,
        a.type,
        a.status || "",
        a.reason === "unscheduled" ? "unscheduled" : "past date",
        a.startDate ? new Date(a.startDate).toISOString().slice(0, 10) : "",
      ]),
    [],
    ["WARRANTIES BY LEAD"],
    ["Lead", "Count", "Causes"],
    ...v.workOrders.byLead.map((l) => [l.lead, l.count, l.causes.join("; ")]),
    [],
    ["OPEN WARRANTY WORK ORDERS"],
    ["Location", "WO #", "Client", "Type", "Status", "Created", "Lead", "Cause"],
    ...v.workOrders.warranties
      .filter((w) => w.open)
      .map((w) => [
        w.className,
        w.woNumber,
        w.client,
        w.type,
        w.status || "",
        w.createdDate ? new Date(w.createdDate).toISOString().slice(0, 10) : "",
        w.lead,
        w.cause,
      ]),
  ];
  sheetFromRows(wb, "Warranties", wo, [14, 8, 20, 20, 12, 11, 14, 30]);

  // Pipeline: look-ahead weeks + flags.
  const pl = [["Pipeline look-ahead"], []];
  for (const wk of v.pipeline.weeks) {
    pl.push([`WEEK OF ${wk.weekStart} TO ${wk.weekEnd}`]);
    pl.push(["Location", "Jobs", "Total $", "Empty days"]);
    for (const cls of wk.classes) {
      pl.push([
        cls.className,
        cls.jobsThisWeek,
        cls.totalThisWeek,
        cls.days.filter((d) => d.load === "empty").map((d) => fmtDay(d.date)).join(", "),
      ]);
    }
    pl.push([]);
  }
  const byLocation = (a, b) =>
    a.className.localeCompare(b.className) || (b.soldAmount || 0) - (a.soldAmount || 0);
  pl.push(["NO LABOR ASSIGNED"]);
  pl.push(["Location", "Job #", "Sold $", "Starts", "Next week?", "Description"]);
  for (const j of [...v.pipeline.noCrew].sort(byLocation)) {
    pl.push([
      j.className,
      j.jobNumber,
      j.soldAmount,
      j.startDate ? new Date(j.startDate).toISOString().slice(0, 10) : "",
      j.startsSoon ? "YES" : "",
      j.description || "",
    ]);
  }
  pl.push([]);
  pl.push(["MISSING START / FINISH DATE"]);
  pl.push(["Location", "Job #", "Sold $", "Missing", "Starts", "Sales person", "Description"]);
  for (const j of [...v.pipeline.unscheduled].sort(byLocation)) {
    pl.push([
      j.className,
      j.jobNumber,
      j.soldAmount,
      j.missingStart && j.missingFinish ? "start + finish" : j.missingStart ? "start" : "finish",
      j.startDate ? new Date(j.startDate).toISOString().slice(0, 10) : "",
      j.salesPerson || "",
      j.description || "",
    ]);
  }
  sheetFromRows(wb, "Pipeline", pl, [16, 12, 11, 14, 12, 12, 34]);

  // Leads by area — only from a snapshot's frozen copy (leads now live on
  // the Sales tab; old snapshots keep their sheet).
  const leads = leadsView ?? null;
  if (leads) {
    const ld = [
      [`Leads by area — ${leads.from} to ${leads.to} (vs the ${leads.windowDays} days before)`],
      [],
    ];
    for (const cls of leads.classes) {
      ld.push([`${cls.className.toUpperCase()} — ${cls.current} leads (prior ${cls.previous}), ${cls.soldCurrentCohort} sold`]);
      ld.push(["Area", "Cities", "Leads", "Prior", "Share shift (pts)", "All-time leads", "All-time sold", "Conversion"]);
      for (const c of cls.clusters) {
        ld.push([
          c.cluster === "?" ? "No zip" : c.cluster + "xx",
          c.cities.join(" / "),
          c.current,
          c.previous,
          c.shareShiftPts,
          c.allTime,
          c.soldAllTime,
          c.allTime >= 10 ? Math.round(c.conversion * 100) / 100 : "",
        ]);
      }
      if (cls.neverSells.length) {
        ld.push(["Zero sales ever:", cls.neverSells.map((z) => `${z.zip} ${z.city || ""} (${z.allTime})`).join(", ")]);
      }
      ld.push([]);
    }
    sheetFromRows(wb, "Leads", ld, [12, 24, 8, 8, 14, 12, 12, 11]);
  }

  XLSX.writeFile(wb, `friday-meeting-${v.week.weekStart}.xlsx`);
  toast("Meeting exported ✓", "success");
}

/**
 * The clients export is ~35k rows — far past serverless request limits as one
 * JSON post (Vercel caps bodies at 4.5MB). Trim to the columns the analysis
 * needs and send in chunks; every chunk repeats the header so the server can
 * parse each piece independently.
 */
async function uploadLeadsChunked(filename, rows) {
  const NEEDED = {
    name: ["name", "client", "customer"],
    state: ["state"],
    city: ["city"],
    zip: ["zip", "zip code", "zipcode"],
    class: ["class"],
    created: ["created"],
    status: ["lead status", "status"],
    pt: ["project type", "opportunity type"],
  };
  const hdrIdx = rows.findIndex((r) =>
    (r || []).some((c) => {
      const t = String(c ?? "").trim().toLowerCase();
      return t === "lead status" || t === "zip";
    })
  );
  // No recognisable header — send as-is and let the server explain the format.
  if (hdrIdx < 0) return meetingApi("/api/leads", "POST", { filename, rows });

  const lower = rows[hdrIdx].map((c) => String(c ?? "").trim().toLowerCase());
  const cols = Object.values(NEEDED).map((names) =>
    lower.findIndex((c) => names.includes(c))
  );
  const pick = (row) => cols.map((i) => (i >= 0 ? row?.[i] ?? null : null));

  // Keep the tiny title rows (they carry the "Data as of…" label).
  const preamble = rows.slice(0, hdrIdx).map((r) => [r?.[0] ?? null, r?.[1] ?? null]);
  const header = pick(rows[hdrIdx]);
  const data = rows.slice(hdrIdx + 1).map(pick);

  const CHUNK = 6000;
  const chunks = Math.max(1, Math.ceil(data.length / CHUNK));
  const uploadId = `u${Date.now()}`;
  const label = document.querySelector('.mtg-section[data-open="ssec:leads"] .btn-upload span');
  let last;
  for (let i = 0; i < chunks; i++) {
    if (label && chunks > 1) label.textContent = `Uploading ${i + 1}/${chunks}…`;
    last = await meetingApi("/api/leads", "POST", {
      filename,
      uploadId,
      seq: i,
      chunks,
      rows: [...preamble, header, ...data.slice(i * CHUNK, (i + 1) * CHUNK)],
    });
  }
  if (label) label.textContent = "Upload leads";
  return last;
}

/**
 * A year-plus Sold Contracts export exceeds one request body (Vercel caps
 * ~4.5MB). Trim to the columns the parser uses and send in chunks, each
 * repeating the title + header rows so the server parses pieces independently.
 */
async function uploadSoldChunked(filename, rows) {
  const NEEDED = [
    "sales person", "contract #", "client", "project type",
    "job #", "project status", "sale date", "sale amount",
  ];
  const hdrIdx = rows.findIndex((r) =>
    (r || []).some((c) => String(c ?? "").trim().toLowerCase() === "sale amount")
  );
  // No recognisable header — send as-is and let the server explain the format.
  if (hdrIdx < 0) return meetingApi("/api/leads/sold", "POST", { filename, rows });

  const lower = rows[hdrIdx].map((c) => String(c ?? "").trim().toLowerCase());
  const cols = NEEDED.map((name) => lower.indexOf(name));
  const pick = (row) => cols.map((i) => (i >= 0 ? row?.[i] ?? null : null));

  const preamble = rows.slice(0, hdrIdx).map((r) => [r?.[0] ?? null]);
  const header = pick(rows[hdrIdx]);
  const data = rows.slice(hdrIdx + 1).map(pick);

  const CHUNK = 4000;
  const chunks = Math.max(1, Math.ceil(data.length / CHUNK));
  const uploadId = `s${Date.now()}`;
  const label = document.querySelector('[data-open="ssec:leads"] .btn-upload:nth-child(2) span');
  let last;
  for (let i = 0; i < chunks; i++) {
    if (label && chunks > 1) label.textContent = `Uploading ${i + 1}/${chunks}…`;
    last = await meetingApi("/api/leads/sold", "POST", {
      filename,
      uploadId,
      seq: i,
      chunks,
      rows: [...preamble, header, ...data.slice(i * CHUNK, (i + 1) * CHUNK)],
    });
  }
  if (label) label.textContent = "Sold contracts";
  return last;
}

// ─────────────────────────── Lead heat map (zip choropleth) ───────────────────────────
// A dedicated screen: every zip colored by lead volume (or jobs), with the
// full per-zip table underneath. Zip polygons are Census ZCTA boundaries,
// vendored at /vendor/tx-zips.json and loaded only when the map opens.

const leadmap = {
  days: 28,
  mode: "leads", // "leads" (window) | "jobs" (sold, all-time)
  className: null,
  table: null, // /api/leads/zips payload for current days
  tableKey: null,
  geo: null, // zip → rings
  centroids: null, // zip → [x, y]
  sort: { col: "current", dir: -1 },
  search: "",
  selected: null,
};

// Sequential ramps (light → dark), one hue per measure.
const MAP_RAMPS = {
  leads: ["#dbe6f6", "#b3c9e9", "#7fa3d6", "#4a77b8", "#15396b"],
  jobs: ["#d9f2e3", "#a9e0bf", "#6fc493", "#3aa268", "#1f8a4c"],
};
const MAP_ZERO = "#f0f1f4";

const MAP_MODES = [
  { key: "leads", label: "Leads (window)" },
  { key: "jobs", label: "Jobs (all-time)" },
];
const MAP_WINDOWS = [
  { days: 7, label: "Week" },
  { days: 28, label: "4 weeks" },
  { days: 91, label: "Quarter" },
  { days: 3650, label: "All time" },
];

async function openLeadMap() {
  showScreen("leadsmap");
  try {
    if (!leadmap.geo) {
      $("map-holder").innerHTML = `<div class="loading">Loading zip boundaries…</div>`;
      const res = await fetch("/vendor/tx-zips.json");
      if (!res.ok) throw new Error("Couldn't load zip boundaries.");
      leadmap.geo = await res.json();
      leadmap.centroids = {};
      for (const [zip, rings] of Object.entries(leadmap.geo)) {
        const r = rings[0];
        let sx = 0;
        let sy = 0;
        for (const [x, y] of r) {
          sx += x;
          sy += y;
        }
        leadmap.centroids[zip] = [sx / r.length, sy / r.length];
      }
    }
    await loadLeadZips();
  } catch (err) {
    $("map-holder").innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
  }
}

async function loadLeadZips() {
  const key = String(leadmap.days);
  if (leadmap.tableKey !== key) {
    const data = await meetingApi(`/api/leads/zips?days=${leadmap.days}`, "GET");
    if (!data.table) {
      $("map-holder").innerHTML = `<div class="empty">Upload the Clients List export
        on the Meeting tab first.</div>`;
      return;
    }
    leadmap.table = data.table;
    leadmap.tableKey = key;
  }
  const classes = leadmap.table.classes.map((c) => c.className);
  if (!leadmap.className || !classes.includes(leadmap.className)) {
    leadmap.className = classes[0] ?? null;
  }
  renderLeadMap();
}

function mapMeasure(row) {
  return leadmap.mode === "jobs" ? row.jobs : row.current;
}

function renderLeadMap() {
  const cls = leadmap.table?.classes.find((c) => c.className === leadmap.className);
  // Controls.
  $("map-class-chips").innerHTML = (leadmap.table?.classes ?? [])
    .map(
      (c) => `<button type="button" class="chip-btn ${
        c.className === leadmap.className ? "active" : ""
      }" data-map-class="${escapeHtml(c.className)}">${escapeHtml(c.className)}</button>`
    )
    .join("");
  $("map-mode-chips").innerHTML = MAP_MODES.map(
    (m) => `<button type="button" class="chip-btn ${
      leadmap.mode === m.key ? "active" : ""
    }" data-map-mode="${m.key}">${m.label}</button>`
  ).join("");
  $("map-window-chips").innerHTML = MAP_WINDOWS.map(
    (w) => `<button type="button" class="chip-btn ${
      leadmap.days === w.days ? "active" : ""
    }" data-map-days="${w.days}">${w.label}</button>`
  ).join("");
  if (!cls) return;

  drawLeadMapSvg(cls);
  renderLeadMapLegend(cls);
  renderLeadMapTable(cls);
  renderLeadMapInfo(cls);
}

function drawLeadMapSvg(cls) {
  const geo = leadmap.geo;
  const cent = leadmap.centroids;
  const byZip = new Map(cls.rows.map((r) => [r.zip, r]));

  // Service area = zips with any all-time leads that we have geometry for.
  const active = cls.rows.filter((r) => r.zip !== "?" && r.allTime > 0 && geo[r.zip]);
  if (!active.length) {
    $("map-holder").innerHTML = `<div class="empty">No mappable zips for ${escapeHtml(
      cls.className
    )}.</div>`;
    return;
  }
  // Trim outliers (remote one-off leads) with a 2–98 percentile bounding box.
  const xs = active.map((r) => cent[r.zip][0]).sort((a, b) => a - b);
  const ys = active.map((r) => cent[r.zip][1]).sort((a, b) => a - b);
  const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor((arr.length - 1) * p))];
  const pad = 0.15;
  let minX = pct(xs, 0.02);
  let maxX = pct(xs, 0.98);
  let minY = pct(ys, 0.02);
  let maxY = pct(ys, 0.98);
  const spanX = Math.max(maxX - minX, 0.2);
  const spanY = Math.max(maxY - minY, 0.2);
  minX -= spanX * pad;
  maxX += spanX * pad;
  minY -= spanY * pad;
  maxY += spanY * pad;

  const midLat = (minY + maxY) / 2;
  const cos = Math.cos((midLat * Math.PI) / 180);
  const W = 800;
  let k = W / ((maxX - minX) * cos);
  let H = (maxY - minY) * k;
  if (H > 900) {
    k *= 900 / H;
    H = 900;
  }
  const px = (x) => (x - minX) * cos * k;
  const py = (y) => (maxY - y) * k;
  const inView = (zip) => {
    const c = cent[zip];
    return c && c[0] >= minX && c[0] <= maxX && c[1] >= minY && c[1] <= maxY;
  };

  const max = Math.max(1, ...active.map((r) => mapMeasure(r)));
  const ramp = MAP_RAMPS[leadmap.mode];
  const bucket = (v) => {
    if (v <= 0) return -1;
    return Math.min(ramp.length - 1, Math.floor((v / max) * ramp.length));
  };

  let paths = "";
  for (const zip of Object.keys(geo)) {
    if (!inView(zip)) continue;
    const row = byZip.get(zip);
    const v = row ? mapMeasure(row) : 0;
    const b = bucket(v);
    const d = geo[zip]
      .map(
        (ring) =>
          "M" + ring.map(([x, y]) => `${px(x).toFixed(1)} ${py(y).toFixed(1)}`).join("L") + "Z"
      )
      .join("");
    const sel = leadmap.selected === zip;
    paths += `<path d="${d}" data-zip="${zip}" fill="${b < 0 ? MAP_ZERO : ramp[b]}"
      stroke="${sel ? "#c0392b" : "#ffffff"}" stroke-width="${sel ? 2.5 : 0.6}"
      ${sel ? 'class="map-selected"' : ""}></path>`;
  }

  // Label the biggest cities (by window leads) for orientation.
  const cityBest = new Map();
  for (const r of active) {
    if (!r.city || !inView(r.zip)) continue;
    const cur = cityBest.get(r.city);
    const score = r.current + r.allTime / 100;
    if (!cur || score > cur.score) cityBest.set(r.city, { zip: r.zip, score });
  }
  // Place up to 6 city labels, skipping any that would collide with one
  // already placed (they'd be unreadable at phone scale).
  const placed = [];
  const labels = [...cityBest.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 12)
    .map(([city, { zip }]) => {
      if (placed.length >= 6) return "";
      const [cx, cy] = cent[zip];
      const x = px(cx);
      const y = py(cy);
      if (placed.some(([ox, oy]) => Math.abs(ox - x) < 170 && Math.abs(oy - y) < 40)) {
        return "";
      }
      placed.push([x, y]);
      return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" class="map-city">${escapeHtml(city)}</text>`;
    })
    .join("");

  $("map-holder").innerHTML = `
    <svg id="map-svg" viewBox="0 0 ${W} ${Math.round(H)}" role="img"
      aria-label="Lead heat map for ${escapeHtml(cls.className)}">${paths}${labels}</svg>`;
}

function renderLeadMapLegend(cls) {
  const active = cls.rows.filter((r) => r.zip !== "?" && r.allTime > 0);
  const max = Math.max(1, ...active.map((r) => mapMeasure(r)));
  const ramp = MAP_RAMPS[leadmap.mode];
  const step = max / ramp.length;
  const label = leadmap.mode === "jobs" ? "jobs (all-time)" : "leads in window";
  $("map-legend").innerHTML =
    `<span class="map-legend-title">${label}:</span>` +
    `<span class="map-swatch" style="background:${MAP_ZERO}"></span><span class="map-range">0</span>` +
    ramp
      .map((c, i) => {
        const lo = Math.floor(i * step) + 1;
        const hi = Math.floor((i + 1) * step);
        return `<span class="map-swatch" style="background:${c}"></span><span class="map-range">${
          i === ramp.length - 1 ? `${lo}+` : `${lo}–${Math.max(hi, lo)}`
        }</span>`;
      })
      .join("");
}

function renderLeadMapInfo(cls) {
  if (!leadmap.selected) {
    $("map-info").textContent =
      `${cls.className}: ${cls.totals.current} leads in window · ` +
      `${cls.totals.jobs} jobs all-time. Tap a zip for details.`;
    return;
  }
  const r = cls.rows.find((x) => x.zip === leadmap.selected);
  if (!r) {
    $("map-info").textContent = `${leadmap.selected}: no leads recorded.`;
    return;
  }
  $("map-info").innerHTML = `<b>${escapeHtml(r.zip)}${
    r.city ? " " + escapeHtml(r.city) : ""
  }</b> — ${r.current} leads (prior ${r.previous}) · ${r.allTime} all-time · ${r.jobs} job${
    r.jobs === 1 ? "" : "s"
  } · ${r.conversion !== null ? Math.round(r.conversion * 100) + "% conv." : "not enough data"}`;
}

const MAP_COLS = [
  { col: "zip", label: "Zip" },
  { col: "city", label: "City" },
  { col: "current", label: "Leads" },
  { col: "previous", label: "Prior" },
  { col: "allTime", label: "All-time" },
  { col: "jobs", label: "Jobs" },
  { col: "conversion", label: "Conv." },
];

function renderLeadMapTable(cls) {
  const q = leadmap.search.trim().toLowerCase();
  let rows = cls.rows;
  if (q) {
    rows = rows.filter(
      (r) => r.zip.includes(q) || (r.city ?? "").toLowerCase().includes(q)
    );
  }
  const { col, dir } = leadmap.sort;
  rows = [...rows].sort((a, b) => {
    const av = a[col];
    const bv = b[col];
    if (typeof av === "string" || typeof bv === "string") {
      return String(av ?? "").localeCompare(String(bv ?? "")) * dir;
    }
    return ((av ?? -1) - (bv ?? -1)) * dir;
  });

  $("map-table").innerHTML = `
  <table class="mtg-table zip-table">
    <thead><tr>${MAP_COLS.map(
      (c) => `<th data-sort="${c.col}" class="${
        col === c.col ? "sorted" : ""
      }">${c.label}${col === c.col ? (dir < 0 ? " ↓" : " ↑") : ""}</th>`
    ).join("")}</tr></thead>
    <tbody>
      ${rows
        .map(
          (r) => `<tr data-zip="${escapeHtml(r.zip)}" class="${
            leadmap.selected === r.zip ? "zip-selected" : ""
          }${r.allTime >= 10 && r.jobs === 0 ? " zip-never" : ""}">
          <td>${escapeHtml(r.zip)}</td>
          <td>${escapeHtml(r.city ?? "—")}</td>
          <td><b>${r.current}</b></td>
          <td>${r.previous}</td>
          <td>${r.allTime}</td>
          <td>${r.jobs}</td>
          <td>${r.conversion !== null ? Math.round(r.conversion * 100) + "%" : "—"}</td>
        </tr>`
        )
        .join("")}
    </tbody>
  </table>
  <p class="hint">${rows.length} zips · red rows = 10+ leads, zero jobs ever.</p>`;
}

function exportLeadMapTable() {
  const cls = leadmap.table?.classes.find((c) => c.className === leadmap.className);
  if (!cls || typeof XLSX === "undefined") {
    toast("Load the map first.", "error");
    return;
  }
  const t = leadmap.table;
  const wb = XLSX.utils.book_new();
  for (const c of t.classes) {
    const rows = [
      [`${c.className} — leads by zip, ${t.from} to ${t.to} (window ${t.windowDays}d)`],
      [],
      ["Zip", "City", "Leads (window)", "Prior window", "All-time leads", "Jobs (all-time)", "Conversion"],
      ...c.rows.map((r) => [
        r.zip,
        r.city ?? "",
        r.current,
        r.previous,
        r.allTime,
        r.jobs,
        r.conversion !== null ? Math.round(r.conversion * 1000) / 1000 : "",
      ]),
      [],
      ["Totals", "", c.totals.current, c.totals.previous, c.totals.allTime, c.totals.jobs, ""],
    ];
    sheetFromRows(wb, c.className, rows, [8, 20, 13, 12, 13, 12, 11]);
  }
  XLSX.writeFile(wb, `leads-by-zip-${t.to}.xlsx`);
  toast("Zip table exported ✓", "success");
}

function initLeadMapEvents() {
  $("map-back").addEventListener("click", () => showScreen("sales"));
  $("map-export").addEventListener("click", exportLeadMapTable);
  $("map-search").addEventListener("input", (e) => {
    leadmap.search = e.target.value;
    const cls = leadmap.table?.classes.find((c) => c.className === leadmap.className);
    if (cls) renderLeadMapTable(cls);
  });
  $("screen-leadsmap").addEventListener("click", async (e) => {
    const cls = e.target.closest("[data-map-class]");
    const mode = e.target.closest("[data-map-mode]");
    const days = e.target.closest("[data-map-days]");
    const path = e.target.closest("path[data-zip]");
    const rowEl = e.target.closest("tr[data-zip]");
    const th = e.target.closest("th[data-sort]");
    if (cls) {
      leadmap.className = cls.dataset.mapClass;
      leadmap.selected = null;
      renderLeadMap();
    } else if (mode) {
      leadmap.mode = mode.dataset.mapMode;
      renderLeadMap();
    } else if (days) {
      leadmap.days = Number(days.dataset.mapDays);
      try {
        await loadLeadZips();
      } catch (err) {
        toast(err.message || "Couldn't load.", "error");
      }
    } else if (path || rowEl) {
      leadmap.selected = (path ?? rowEl).dataset.zip;
      renderLeadMap();
    } else if (th) {
      const col = th.dataset.sort;
      if (leadmap.sort.col === col) leadmap.sort.dir *= -1;
      else leadmap.sort = { col, dir: col === "zip" || col === "city" ? 1 : -1 };
      const c = leadmap.table?.classes.find((x) => x.className === leadmap.className);
      if (c) renderLeadMapTable(c);
    }
  });
}

// ─────────────────────────── Weekly snapshots ───────────────────────────
// "Save snapshot" freezes the computed meeting, next week's staging list, and
// the inventory position server-side, so the week's record survives the next
// round of uploads. Saved weeks list under the meeting and re-export anytime.

async function saveSnapshot() {
  const btn = $("meeting-snapshot");
  btn.disabled = true;
  try {
    const data = await meetingApi("/api/snapshots", "POST", {
      week: meeting.week,
      by: meetingUser() || null,
    });
    toast(`Week of ${data.snapshot.weekStart} saved ✓`, "success");
    await loadSnapshots();
  } catch (err) {
    toast(err.message || "Couldn't save the snapshot.", "error");
  } finally {
    btn.disabled = false;
  }
}

async function loadSnapshots() {
  const box = $("meeting-snapshots");
  try {
    const { snapshots } = await meetingApi("/api/snapshots", "GET");
    if (!snapshots.length) {
      box.innerHTML = `<div class="empty small">No weeks saved yet — tap
        <b>📸 Save snapshot</b> at the end of the Friday meeting.</div>`;
      return;
    }
    box.innerHTML = snapshots
      .map(
        (s) => `
        <div class="history-row snap-row">
          <span class="history-week">Week of ${escapeHtml(s.weekStart)}</span>
          <span class="history-class">saved ${fmtDate(s.savedAt)}${
            s.by ? " by " + escapeHtml(s.by) : ""
          }</span>
          <span class="snap-actions">
            <button type="button" class="btn-export" data-snap="${escapeHtml(s.weekStart)}" data-kind="meeting">Meeting ⬇</button>
            <button type="button" class="btn-export" data-snap="${escapeHtml(s.weekStart)}" data-kind="staging">Staging ⬇</button>
          </span>
        </div>`
      )
      .join("");
  } catch {
    box.innerHTML = `<div class="empty small">Couldn't load saved weeks.</div>`;
  }
}

async function snapshotClick(e) {
  const btn = e.target.closest("[data-snap]");
  if (!btn) return;
  btn.disabled = true;
  try {
    const snap = await meetingApi(
      `/api/snapshots/${encodeURIComponent(btn.dataset.snap)}`,
      "GET"
    );
    if (btn.dataset.kind === "staging") buildStagingXlsx(snap.staging);
    else buildMeetingXlsx(snap.meeting, snap.leads ?? null);
  } catch (err) {
    toast(err.message || "Couldn't download that snapshot.", "error");
  } finally {
    btn.disabled = false;
  }
}

// ─────────────────────────── Navigation ───────────────────────────

// ──────── Inventory counts & material cost (meeting §5) ────────
// Each location uploads its weekly Material Tracker count (PDF, xlsx/csv, or
// pasted text). Usage = last week's count − this week's, priced from the PO
// catalog, and compared against §4's completed revenue per location.
let invCounts = null; // GET /api/inventory-counts for the meeting week
let invCountsLoadedWeek;

async function loadInvCounts() {
  invCountsLoadedWeek = meeting.week;
  if (!state.classes.length) await loadReportClasses();
  try {
    const q = meeting.week ? `?week=${meeting.week}` : "";
    const res = await fetch(`/api/inventory-counts${q}`);
    if (!res.ok) throw new Error();
    invCounts = await res.json();
  } catch {
    invCounts = null;
  }
  if (meeting.view) renderMeeting();
}

const invCountsFresh = () =>
  invCounts && (!meeting.week || invCounts.week.weekStart === meeting.week);

function invCountsSubtitle() {
  if (!invCountsFresh() || !invCounts.classes.length)
    return "upload the weekly counts";
  const n = invCounts.classes.length;
  const t = invCounts.totals;
  return (
    `${fmtMoney0(t.materialCost)} material · ${n} location${n === 1 ? "" : "s"}` +
    (t.missingPurchases.length ? ` · purchases missing ×${t.missingPurchases.length}` : "")
  );
}

/** Completed revenue for a location, from the labor-rates section's data. */
function invRevenueFor(v, className) {
  const row = (v.labor?.rows || []).find((r) => r.className === className);
  if (!row) return null;
  return row.revenueOverride ?? row.completedRevenue ?? null;
}

function invClassOptions() {
  const known = new Set(state.classes);
  if (invCountsFresh())
    invCounts.classes.forEach((c) => known.add(c.className));
  return (
    `<option value="">Location: auto-detect</option>` +
    [...known]
      .sort()
      .map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`)
      .join("")
  );
}

function renderMaterialsSection(v) {
  if (!invCountsFresh()) {
    if (invCountsLoadedWeek !== meeting.week) loadInvCounts();
    return `<div class="loading">Loading inventory counts…</div>`;
  }
  const pos = invCounts.pos || { pending: [], received: [] };

  const controls = `
  <div class="mtg-upload">
    <span class="inv-lede"><b>Material cost = purchases + what came off the trailers.</b>
      <span class="inv-dim">Drop count sheets and vendor POs together — several files at
      once; location and week are read from each PDF.</span></span>
    <span class="mtg-upload-actions">
      <select id="inv-class" class="inv-class-select">${invClassOptions()}</select>
      <label class="btn-upload"><span>⬆ Upload</span>
        <input id="inv-file" type="file" accept=".xlsx,.xls,.csv,.pdf" multiple hidden />
      </label>
      <button id="inv-paste" class="btn-export" type="button">Paste counts</button>
    </span>
  </div>`;

  // POs whose ship-to wasn't recognised need a human to pick the location.
  const unassigned = pos.pending.filter((p) => !p.className);
  const unassignedBlock = unassigned.length
    ? `<p class="po-head warn-head">⚠ Pick a location for these POs</p>` +
      unassigned.map((p) => poCardHtml(p, false)).join("")
    : "";

  // One block per location — union of this week's counts and any POs.
  const classNames = new Set(invCounts.classes.map((c) => c.className));
  for (const p of [...pos.pending, ...pos.received]) {
    if (p.className) classNames.add(p.className);
  }
  if (!classNames.size) {
    return (
      controls +
      unassignedBlock +
      `<p class="hint">Nothing for the week of ${fmtDay(invCounts.week.weekStart)} yet — upload each location's count sheet (and any vendor POs).</p>`
    );
  }

  const t = invCounts.totals;
  let revTotal = 0;
  let revKnown = false;

  const blocks = [...classNames]
    .sort()
    .map((className) => {
      const c = invCounts.classes.find((x) => x.className === className) || null;
      const myPending = pos.pending.filter((p) => p.className === className);
      const myReceived = pos.received.filter((p) => p.className === className);
      const rev = invRevenueFor(v, className);
      const headline = c ? c.materialCost ?? c.usage.totalCost : null;
      if (c && rev && rev > 0) {
        revTotal += rev;
        revKnown = true;
      }
      const pct = c && rev && rev > 0 && headline !== null ? (headline / rev) * 100 : null;
      const openKey = `inv:${className}`;

      const summaryMeta = c
        ? `${c.current.itemCount} items · ${c.previous ? `vs ${fmtDay(c.previous.weekStart)}` : "first count"}`
        : `no count this week`;
      const pctHtml =
        pct !== null
          ? `<span class="mtg-rate-pct">material ${pct.toFixed(1)}%</span>`
          : "";
      const poBadge = myPending.length
        ? `<span class="po-badge">${myPending.length} PO in transit</span>`
        : "";

      return `
      <details class="mtg-class inv-loc" data-open="${openKey}" ${meeting.open.has(openKey) ? "open" : ""}>
        <summary>
          <b>${escapeHtml(className)}</b>
          <span class="inv-loc-sub">${summaryMeta}</span>
          ${poBadge}
          ${pctHtml}
          <span class="inv-loc-cost">${headline === null ? "—" : fmtMoney(headline)}</span>
        </summary>
        ${c ? invMathHtml(c) : `<p class="hint">${myReceived.length ? `<b>${fmtMoney(myReceived.reduce((n, p) => n + (p.total || 0), 0))}</b> received this week — ` : ""}no inventory count uploaded for ${escapeHtml(className)} this week; drop the tracker sheet in to compute material cost.</p>`}
        ${invPoListHtml(myPending, myReceived)}
        ${c ? invMovementHtml(c) : ""}
        ${c ? `<p class="hint inv-loc-meta">${c.current.sourceLabel ? escapeHtml(c.current.sourceLabel) + " · " : ""}<button class="btn-clear inv-del" type="button" data-invdel="${escapeHtml(className)}">Remove count</button></p>` : ""}
      </details>`;
    })
    .join("");

  const totalPct =
    revKnown && revTotal > 0 && t.materialCost
      ? (t.materialCost / revTotal) * 100
      : null;
  const totals = invCounts.classes.length
    ? `
  <div class="mtg-labor-row inv-totals">
    <div class="mtg-labor-head"><b>All locations</b>
      ${totalPct !== null ? `<span class="mtg-rate-pct">material ${totalPct.toFixed(1)}% of revenue</span>` : ""}
    </div>
    <div class="derived-row"><span>Purchases</span><strong>${fmtMoney(t.purchases)}</strong></div>
    <div class="derived-row"><span>Trailer stock value</span><strong>${fmtMoney(t.beginValue)} → ${fmtMoney(t.endValue)}</strong></div>
    <div class="derived-row inv-headline"><span><b>Material cost this week</b></span><strong>${fmtMoney(t.materialCost)}</strong></div>
    ${t.missingPurchases.length ? `<p class="hint">⚠ No purchases for ${t.missingPurchases.map(escapeHtml).join(", ")} — drawdown only there.</p>` : ""}
    ${t.orphanPoTotal ? `<p class="hint">⚠ ${fmtMoney(t.orphanPoTotal)} of received POs (${t.orphanPoClasses.map(escapeHtml).join(", ")}) isn't in these totals yet — upload those locations' counts.</p>` : ""}
    ${t.missingPrevious.length ? `<p class="hint">${t.missingPrevious.map(escapeHtml).join(", ")}: first count on record — in next week's math.</p>` : ""}
    ${t.unpricedItems.length ? `<p class="hint">${t.unpricedItems.length} item${t.unpricedItems.length === 1 ? "" : "s"} still unpriced.</p>` : ""}
  </div>`
    : "";

  return controls + unassignedBlock + blocks + totals;
}

/** The purchases + stock-change math for one location. */
function invMathHtml(c) {
  const deltaValue = c.beginValue !== null ? c.beginValue - c.endValue : null;
  const arrivals = c.usage.lines.reduce(
    (n, l) =>
      n +
      (l.prevCount !== null && l.count > l.prevCount && l.unitCost !== null
        ? (l.count - l.prevCount) * l.unitCost
        : 0),
    0
  );
  const arrivalsR = Math.round(arrivals * 100) / 100;
  // Offer the counts-based arrivals figure when nothing is entered, OR when
  // recorded purchases clearly under-cover what the counts say landed
  // (deliveries from POs that never made it into the app).
  const underCovered =
    c.purchases !== null && arrivalsR > c.purchases + Math.max(500, c.purchases * 0.25);
  const suggest =
    arrivalsR > 0 && ((c.purchases === null && c.purchasesSource === null) || underCovered)
      ? `<button class="inv-use" type="button" data-invuse="${escapeHtml(c.className)}" data-amount="${arrivalsR}">counts show ≥ ${fmtMoney(arrivalsR)} landed — use</button>`
      : "";
  return `
  <div class="inv-math">
    <div class="derived-row">
      <span>Purchases this week
        ${c.purchasesSource === "pos" ? `<span class="po-auto">auto · ${c.poCount} PO${c.poCount === 1 ? "" : "s"} received</span>` : `<span class="inv-dim">(material received)</span>`}
        ${suggest}</span>
      <span class="money-inline">$ <input class="js-purchase" data-class="${escapeHtml(c.className)}"
        type="number" min="0" step="0.01" inputmode="decimal"
        value="${c.purchasesSource === "manual" ? c.purchases : ""}" placeholder="${c.purchasesSource === "pos" ? c.purchases : "0"}" /></span>
    </div>
    <div class="derived-row">
      <span>Trailer stock value</span>
      <span>${c.beginValue === null ? "—" : fmtMoney(c.beginValue)} → ${fmtMoney(c.endValue)}
        ${deltaValue === null ? "" : `<span class="inv-dim">(${deltaValue >= 0 ? "−" : "+"}${fmtMoney(Math.abs(deltaValue)).slice(1)})</span>`}</span>
    </div>
    <div class="derived-row inv-headline">
      <span><b>Material cost this week</b></span>
      <strong>${c.materialCost === null ? "—" : fmtMoney(c.materialCost)}</strong>
    </div>
    ${c.purchasesSource === "manual" && c.poCount > 0 && c.poTotal !== c.purchases ? `<p class="hint">⚠ The typed amount ${fmtMoney(c.purchases)} overrides ${c.poCount} received PO${c.poCount === 1 ? "" : "s"} totalling ${fmtMoney(c.poTotal)} — clear the purchases box to use the PO total.</p>` : ""}
    ${c.materialCost !== null && c.purchases === null ? `<p class="hint">⚠ No purchases yet — drawdown only. Tap Received on a PO or enter the spend.</p>` : ""}
    ${c.materialCost !== null && c.materialCost < 0 ? `<p class="hint">⚠ Negative cost: stock grew by more than the recorded purchases — usually a delivery from a PO that isn't in the app yet. Drop the missing PO in, or tap the counts-based figure above.</p>` : ""}
    ${c.valueUnpricedCount ? `<p class="hint">${c.valueUnpricedCount} counted item${c.valueUnpricedCount === 1 ? "" : "s"} lack a unit cost (not in stock value).</p>` : ""}
  </div>`;
}

/** Item movement detail (counts that went down) for one location. */
function invMovementHtml(c) {
  if (!c.previous) {
    return `<p class="hint">First count on record for ${escapeHtml(c.className)} —
      drop <b>last week's</b> sheet from the tracker's History page in too and
      usage appears (its Submitted date files it under last week).</p>`;
  }
  const used = c.usage.lines.filter((l) => (l.used ?? 0) > 0);
  const restocked = c.usage.lines.filter((l) => l.restocked).length;
  const openKey = `invd:${c.className}`;
  return `
  <details class="mtg-class inv-detail" data-open="${openKey}" ${meeting.open.has(openKey) ? "open" : ""}>
    <summary>Item movement — counts that went down (${used.length})</summary>
    ${
      !used.length
        ? `<p class="hint">No counts went down this week.</p>`
        : `
    <div class="table-wrap inv-table-wrap">
      <table class="inv-table">
        <thead><tr>
          <th>Item</th><th class="num">Last wk</th><th class="num">Now</th>
          <th class="num">Down</th><th class="num">Unit cost $</th><th class="num">Value</th>
        </tr></thead>
        <tbody>
          ${used
            .map(
              (l) => `
            <tr>
              <td class="inv-item">${escapeHtml(l.item)}${l.category ? `<span class="inv-cat"> · ${escapeHtml(l.category)}</span>` : ""}</td>
              <td class="num">${fmtN(l.prevCount)}</td>
              <td class="num">${fmtN(l.count)}</td>
              <td class="num"><strong>${fmtN(l.used)}</strong></td>
              <td class="num"><input class="js-price" data-item="${escapeHtml(l.item)}" type="number" min="0" step="0.01" inputmode="decimal" value="${l.unitCost ?? ""}" placeholder="—" /></td>
              <td class="num">${l.cost === null ? "—" : fmtMoney(l.cost)}</td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`
    }
    ${restocked ? `<p class="hint">${restocked} item${restocked === 1 ? "" : "s"} went up (deliveries) — handled by the purchases math.</p>` : ""}
    ${c.usage.unpricedItems.length ? `<p class="hint">⚠ ${c.usage.unpricedItems.length} moved item${c.usage.unpricedItems.length === 1 ? " has" : "s have"} no unit cost.</p>` : ""}
  </details>`;
}

/** A location's POs: in transit first, then received this week. */
function invPoListHtml(pending, received) {
  if (!pending.length && !received.length) return "";
  return `
  <div class="po-block">
    ${pending.length ? `<p class="po-head">In transit — tap <b>Received</b> when it lands</p>` : ""}
    ${pending.map((p) => poCardHtml(p, false)).join("")}
    ${received.length ? `<p class="po-head">Received this week</p>` : ""}
    ${received.map((p) => poCardHtml(p, true)).join("")}
  </div>`;
}

/** One PO as an expandable card: summary row + line-item table inside. */
function poCardHtml(po, received) {
  const openKey = `po:${po.id}`;
  const items = po.items || [];
  const body = items.length
    ? `
    <div class="table-wrap inv-table-wrap">
      <table class="inv-table">
        <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit $</th><th class="num">Subtotal</th></tr></thead>
        <tbody>
          ${items
            .map(
              (it) => `
            <tr>
              <td class="inv-item">${escapeHtml(it.description)}</td>
              <td class="num">${fmtN(it.qty, 0)}</td>
              <td class="num">${fmtMoney(it.unitPrice)}</td>
              <td class="num">${fmtMoney(it.subtotal)}</td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`
    : `<p class="hint">No line detail stored for this PO — re-drop the PDF to add it.</p>`;
  return `
  <details class="po-card${received ? " received" : ""}" data-open="${openKey}" ${meeting.open.has(openKey) ? "open" : ""}>
    <summary class="po-summary">
      <span class="po-main">
        <b>${escapeHtml(po.poNumber || po.filename || "PO")}</b>
        <span class="inv-dim">${escapeHtml(po.supplier || "")}${po.orderMs ? ` · ordered ${fmtDay(new Date(po.orderMs).toISOString().slice(0, 10))}` : ""}${items.length ? ` · ${items.length} line${items.length === 1 ? "" : "s"}` : ""}</span>
        ${
          po.className
            ? ""
            : `<select class="inv-class-select js-po-class" data-po="${po.id}">
                 <option value="">Location?</option>
                 ${state.classes.map((c) => `<option>${escapeHtml(c)}</option>`).join("")}
               </select>`
        }
        <span class="po-total">${po.total !== null ? fmtMoney(po.total) : "$?"}</span>
      </span>
      <span class="po-actions">
        ${
          received
            ? `<span class="po-received-tag">✓ ${po.receivedAt ? fmtDay(po.receivedAt.slice(0, 10)) : "received"}</span>
               <button class="btn-clear" type="button" data-po-unreceive="${po.id}">undo</button>`
            : `<button class="po-receive" type="button" data-po-receive="${po.id}" ${po.className ? "" : "disabled title='Pick the location first'"}>📦 Received</button>`
        }
        <button class="btn-clear" type="button" data-po-del="${po.id}">✕</button>
      </span>
    </summary>
    ${body}
  </details>`;
}

async function poAction(id, body) {
  try {
    const q = meeting.week ? `?week=${meeting.week}` : "";
    const res = await fetch(`/api/inventory-counts/pos/${encodeURIComponent(id)}${q}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error();
    invCounts = await res.json();
    if (meeting.view) renderMeeting();
    return true;
  } catch {
    toast("Couldn't update that PO.", "error");
    return false;
  }
}

async function postInvCounts(payload) {
  const q = meeting.week ? `?week=${meeting.week}` : "";
  const res = await fetch(`/api/inventory-counts${q}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || "Upload failed.");
  if (data.kind === "po") {
    return `PO ${data.po.poNumber || ""} (${data.po.className || "pick location"}, ${data.po.total !== null ? fmtMoney(data.po.total) : "$?"}) — pending until Received`;
  }
  // The sheet may belong to a different week (its Submitted date decides),
  // so refresh the meeting week's view instead of trusting this response.
  return `${data.className} · week of ${fmtDay(data.week.weekStart)}`;
}

function invSelectedClass() {
  const sel = document.getElementById("inv-class");
  return sel && sel.value ? { className: sel.value } : {};
}

async function handleInvCountsFiles(files) {
  const list = [...(files || [])];
  if (!list.length) return;
  const saved = [];
  const failed = [];
  for (const file of list) {
    try {
      if (/\.pdf$/i.test(file.name)) {
        const b64 = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(",")[1] || "");
          r.onerror = reject;
          r.readAsDataURL(file);
        });
        saved.push(
          await postInvCounts({ filename: file.name, pdfBase64: b64, ...invSelectedClass() })
        );
        continue;
      }
      if (typeof XLSX === "undefined") {
        throw new Error("Spreadsheet reader didn't load — check your connection.");
      }
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, blankrows: false });
      saved.push(
        await postInvCounts({ filename: file.name, rows, ...invSelectedClass() })
      );
    } catch (err) {
      failed.push(`${file.name}: ${err.message || "couldn't read it"}`);
    }
  }
  await loadInvCounts();
  if (saved.length) toast(`Saved ${saved.join(", ")} ✓`, failed.length ? "" : "success");
  if (failed.length) toast(failed.join(" · "), "error");
}

/** Pasted counts → rows: the trailing number on each line is the count. */
function invCountsTextToRows(textVal) {
  return String(textVal || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(.*?)[\s ]+(-?\d[\d,]*(?:\.\d+)?)$/);
      return m ? [m[1], m[2]] : [line];
    });
}

async function deleteInvCounts(className) {
  if (!confirm(`Remove the ${className} count for this week?`)) return;
  const q = `?week=${meeting.week || ""}&class=${encodeURIComponent(className)}`;
  try {
    await fetch(`/api/inventory-counts${q}`, { method: "DELETE" });
  } catch {
    /* reload below shows the real state */
  }
  await loadInvCounts();
}

function saveInvPurchases(input) {
  const className = input.dataset.class;
  const amount = input.value === "" ? null : Number(input.value);
  debounce(`purch:${className}`, async () => {
    try {
      const q = meeting.week ? `?week=${meeting.week}` : "";
      const res = await fetch(`/api/inventory-counts/purchases${q}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          className,
          amount: amount !== null && Number.isFinite(amount) ? amount : null,
        }),
      });
      if (!res.ok) throw new Error();
      await loadInvCounts();
      toast(`Purchases saved for ${className} ✓`, "success");
    } catch {
      toast("Couldn't save the purchases amount.", "error");
    }
  }, 500);
}

function saveInvPrice(input) {
  const item = input.dataset.item;
  const value = input.value === "" ? 0 : Number(input.value);
  debounce(`price:${item}`, async () => {
    try {
      const res = await fetch("/api/inventory-counts/prices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prices: { [item]: Number.isFinite(value) && value > 0 ? value : 0 },
        }),
      });
      if (!res.ok) throw new Error();
      await loadInvCounts();
      toast("Unit cost saved ✓", "success");
    } catch {
      toast("Couldn't save that unit cost.", "error");
    }
  }, 400);
}

function initMeetingPrep() {
  $("meeting-prep").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-goto]");
    if (!chip) return;
    const sec = document.querySelector(`[data-open="sec:${chip.dataset.goto}"]`);
    if (!sec) return;
    sec.open = true;
    meeting.open.add(`sec:${chip.dataset.goto}`);
    sec.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function initInvCounts() {
  const root = $("meeting-sections");
  // The section re-renders often, so everything is event-delegated.
  root.addEventListener("change", (e) => {
    const t = e.target;
    if (t.id === "inv-file") {
      // Copy first — clearing the input empties the live FileList.
      const files = [...t.files];
      t.value = "";
      handleInvCountsFiles(files);
    } else if (t.classList && t.classList.contains("js-price")) {
      saveInvPrice(t);
    } else if (t.classList && t.classList.contains("js-purchase")) {
      saveInvPurchases(t);
    } else if (t.classList && t.classList.contains("js-po-class")) {
      if (t.value) poAction(t.dataset.po, { className: t.value });
    }
  });
  root.addEventListener("click", (e) => {
    // Selects/inputs inside a <summary> must not toggle the card open/shut.
    if (e.target.closest("summary") && e.target.closest("select, input, button")) {
      e.preventDefault();
    }
    const del = e.target.closest("[data-invdel]");
    if (del) {
      e.preventDefault();
      deleteInvCounts(del.dataset.invdel);
      return;
    }
    const rec = e.target.closest("[data-po-receive]");
    if (rec) {
      e.preventDefault();
      poAction(rec.dataset.poReceive, { received: true }).then(
        (ok) => ok && toast("Booked into this week's purchases ✓", "success")
      );
      return;
    }
    const unrec = e.target.closest("[data-po-unreceive]");
    if (unrec) {
      e.preventDefault();
      poAction(unrec.dataset.poUnreceive, { received: false });
      return;
    }
    const podel = e.target.closest("[data-po-del]");
    if (podel) {
      e.preventDefault();
      if (confirm("Remove this purchase order?")) {
        fetch(`/api/inventory-counts/pos/${encodeURIComponent(podel.dataset.poDel)}`, { method: "DELETE" })
          .then(() => loadInvCounts());
      }
      return;
    }
    const use = e.target.closest("[data-invuse]");
    if (use) {
      e.preventDefault();
      saveInvPurchases({
        dataset: { class: use.dataset.invuse },
        value: use.dataset.amount,
      });
      return;
    }
    if (e.target.closest("#inv-paste")) {
      $("inv-text").value = "";
      $("inv-dialog").showModal();
    }
  });
  $("inv-cancel").addEventListener("click", () => $("inv-dialog").close());
  $("inv-form").addEventListener("submit", async (e) => {
    const rows = invCountsTextToRows($("inv-text").value);
    if (rows.length < 3) {
      e.preventDefault();
      toast("Paste the counts first.", "error");
      return;
    }
    try {
      const saved = await postInvCounts({ rows, ...invSelectedClass() });
      await loadInvCounts();
      toast(`Saved ${saved} ✓`, "success");
    } catch (err) {
      toast(err.message || "Couldn't read those counts.", "error");
    }
  });
}

const TITLES = {
  meeting: "Production Management",
  sales: "Sales Management",
  schedule: "Weekly Schedule",
  staging: "Staging Lists",
  inventory: "Inventory",
  pay: "Performance Pay",
  roster: "Roster",
  projects: "Projects",
  leadsmap: "Lead Heat Map",
};

function showScreen(name) {
  for (const s of ["meeting", "sales", "schedule", "staging", "inventory", "pay", "roster", "projects", "leadsmap"]) {
    $(`screen-${s}`).hidden = s !== name;
  }
  $("screen-title").textContent = TITLES[name];
  $("week-label").hidden = name !== "schedule";
  document.querySelectorAll(".tab").forEach((t) =>
    // The map is a drill-down from the sales tab; keep that tab lit.
    t.classList.toggle(
      "active",
      t.dataset.screen === (name === "leadsmap" ? "sales" : name)
    )
  );
  if (name === "projects" && !allProjects.length) loadProjects();
  if (name === "meeting") {
    loadMeeting();
    loadSnapshots();
    loadInvCounts();
  }
  if (name === "sales") loadSales();
  if (name === "staging") loadStaging();
  if (name === "inventory") loadInventory();
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
  $("meeting-export").addEventListener("click", exportMeeting);
  $("meeting-snapshot").addEventListener("click", saveSnapshot);
  $("meeting-snapshots").addEventListener("click", snapshotClick);

  // Sales Management tab.
  const salesRoot = $("sales-sections");
  salesRoot.addEventListener("change", salesChange);
  salesRoot.addEventListener("click", salesClick);
  salesRoot.addEventListener("toggle", meetingToggle, true);
  // Hover readout for the daily lead chart (tap is handled in salesClick).
  salesRoot.addEventListener("mouseover", (e) => {
    const hit = e.target.closest?.(".js-bar-hit");
    if (!hit) return;
    const cap = $(hit.dataset.capfor || "lead-chart-cap");
    if (cap) cap.textContent = hit.dataset.cap;
  });

  // Staging + inventory.
  $("staging-prev").addEventListener("click", () => loadStaging(shiftWeekIso(staging.week, -1)));
  $("staging-next").addEventListener("click", () => loadStaging(shiftWeekIso(staging.week, 1)));
  $("staging-nextweek").addEventListener("click", () => loadStaging(nextWeekStartIso()));
  $("staging-export").addEventListener("click", exportStaging);
  $("inv-prev").addEventListener("click", () => loadInventory(shiftWeekIso(inventory.week, -1)));
  $("inv-next").addEventListener("click", () => loadInventory(shiftWeekIso(inventory.week, 1)));
  $("inv-nextweek").addEventListener("click", () => loadInventory(nextWeekStartIso()));
  $("inventory-list").addEventListener("change", inventoryChange);
  initLeadMapEvents();
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

  initInvCounts();
  initMeetingPrep();

  // Production Management (the meeting) is the default screen; the Schedule,
  // Staging, Inventory, Pay and Roster tabs are hidden but stay wired up.
  await loadColors();
  showScreen("meeting");
}

init();

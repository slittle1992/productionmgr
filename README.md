# Production Manager — Weekly Report App

A phone-first web app that replaces the weekly production-report spreadsheet.
It pulls everything Builder Prime can supply, does all the math, and leaves the
manager with only the handful of fields a human actually has to enter.

This repo implements **Phase 1** of the requirements: a read-only weekly report
(auto-pull + manual entry + automated math + save/submit + QTD rollups) and a
view-only project list.

---

## Quick start

```bash
npm install
npm test          # 48 tests
npm start         # http://localhost:3000
```

With **no Builder Prime credentials**, the app boots in **sample-data mode** so
you can click through the whole UI and see the math work. To connect live data,
copy `.env.example` to `.env` and fill in:

```bash
BUILDER_PRIME_SUBDOMAIN=johnsfloors      # from johnsfloors.builderprime.com
BUILDER_PRIME_API_KEY=<key with projects.read scope>
```

Then `npm start` again — the banner disappears and real projects load.

---

## What the manager sees

Three tabs, all built for a thumb:

- **Schedule** *(default)* — the weekly production schedule that replaces the
  spreadsheet. Jobs are pulled from Builder Prime, grouped by **class**, each
  showing Customer, Job #, project type, scheduled day, SQFT, and Color — and
  the **material to use auto-populates from SQFT and color**. Assign a crew and
  fix any color/sqft inline; it saves as you type.
- **Report** — the weekly report. Builder Prime fields arrive pre-filled and
  badged `auto`; every derived value (×1.2 labor, sundries ratio, installed
  revenue, QTD rollups) updates live as you type. Save a draft or submit.
- **Projects** — active projects with client, address, value, status, and who's
  assigned (PM / foreman / salesperson). Search and a "show cancelled" toggle.

No report names, no formulas, no Builder Prime login — the app does that work.

---

## Weekly Schedule (replaces the spreadsheet)

The old workbook was 359 sheets of week-by-week snapshots, grouped by
day → region, with material columns computed by hand. The Schedule tab
reproduces the useful part and drops the manual work.

**Where each column comes from**

| Column | Source |
|---|---|
| Customer Name | Builder Prime (client name / company) |
| Job Number | Builder Prime (`Job Number` custom field, else project id) |
| Class (grouping) | Builder Prime `className` |
| Project Type | Builder Prime (`Project Type` custom field) |
| SQFT | Builder Prime (`SQFT` custom field) — correctable inline |
| Color | Builder Prime (`Flake Color` custom field) — canonical dropdown |
| Crew | **Assigned on the schedule** (not in Builder Prime), saved per week |
| Material to use | **Computed** from SQFT × coverage rates; color names the flake |

**Material math** (from the spreadsheet's Job-Costing sheet; all configurable):

```
Basecoat A = SQFT ÷ 315 gal     Topcoat A = SQFT ÷ 330 gal
Basecoat B = SQFT ÷ 630 gal     Topcoat B = SQFT ÷ 330 gal
Flake      = SQFT × 0.125 lbs   Flake blend = the job's color
```

Warranty / inspection / sand-&-clear jobs show **no material**, matching how
those rows were left blank in the sheet.

**Colors** are a fixed dropdown (`src/data/colors.ts`) seeded from the Flake
Inventory and the colors used on recent schedules. Builder Prime's stored value
is normalised against the catalog and its aliases, so historical typos
("Caspian/Caspain", "Tidal wave/Tidal Wave", "Galcier") all resolve to one
canonical name. Unknown colors are flagged so the manager can pick a standard one.

**Builder Prime custom-field names** are configurable — set `BP_FIELD_SQFT`,
`BP_FIELD_COLOR`, `BP_FIELD_PROJECT_TYPE`, `BP_FIELD_JOB_NUMBER` (comma-separated
alternates) to match how your BP instance labels them. Coverage rates are
configurable via `COVERAGE_*` vars.

---

## Field source map (spec §4 → implementation)

| Field | Source | Where it's handled |
|---|---|---|
| Projected Job Schedule | auto: Σ `estimatedValue` for projects starting in the week | `computeAutoFromProjects` |
| Completed Jobs Revenue | auto: Σ value for projects completed in the week | `computeAutoFromProjects` |
| Projected Labor | auto: Σ `laborCost` for projected projects | `computeAutoFromProjects` |
| Actual Labor | manual raw → app applies **×1.2** | `computeDerived` (`LABOR_MULTIPLIER`) |
| Warranties Opened This Week | manual (v1 — see open questions) | manual field |
| Total Warranties QTD | calculated from stored weekly history | `ReportService.priorQtd` + `computeDerived` |
| Total Leads QTD | manual this week → QTD rollup | manual field + `computeDerived` |
| Materials Given for Warranties | manual | manual field |
| Installed Revenue | = Completed Jobs Revenue (mirror) | `computeDerived` |
| Projected Materials | manual cost (Option A, §6) | manual field |
| Actual Materials | manual (inventory count) | manual field |
| Total Sundries Cost | manual (PO list) | manual field |
| Sundries Ratio | sundries ÷ completed revenue | `computeDerived` |

Auto fields are **overridable**: an edited value is sent as an override and the
original Builder Prime value is preserved (shown as `auto · edited`).

---

## Deploy to Vercel

The app ships ready for Vercel — `api/index.ts` exports the Express app as a
serverless function and `vercel.json` routes `/api/*` to it while Vercel serves
the `public/` UI from its CDN.

```bash
npm i -g vercel      # if needed
vercel               # preview deploy
vercel --prod        # production
```

…or import the repo in the Vercel dashboard (no build settings needed).

**Set these environment variables in Vercel** (Project → Settings → Environment
Variables) for live data — leave them unset to deploy with sample data so you
can click through the UI immediately:

| Variable | Needed | Notes |
|---|---|---|
| `BUILDER_PRIME_SUBDOMAIN` | live data | e.g. `johnsfloors` |
| `BUILDER_PRIME_API_KEY` | live data | `projects.read` scope |
| `BP_FIELD_*`, `COVERAGE_*` | optional | match your BP fields / coverage rates |
| `PRODUCTION_MANAGER_ID` | optional | scope to one PM |

> ⚠️ **Storage caveat.** Vercel's filesystem is read-only except `/tmp`, which is
> ephemeral and per-instance. Viewing the schedule, materials, and report
> pre-fill all work fully, but **saved crew assignments and submitted reports
> won't persist durably** there. For production, back the two repository
> interfaces (`ReportRepository`, `ScheduleStore`) with a durable store —
> Vercel KV/Postgres or any DB. This is a drop-in swap; say the word and I'll
> wire it up. A platform with a persistent disk (Railway, Render, Fly) also
> works with the existing JSON store and no code changes.

---

## Architecture

```
Browser (public/)  ──fetch──►  Express API (src/routes)
   mobile SPA                     │
                                  ├─ services/   report + projects logic
                                  ├─ domain/     week math + pure calculations
                                  ├─ builderPrime/  API client + sample provider
                                  └─ storage/    JSON-file report store (swappable)
```

- **The Builder Prime key never leaves the server** (§10). The browser only ever
  talks to this app's own API; `/api/config` deliberately omits the key.
- **Calculations are pure** (`src/domain/calculations.ts`) and unit-tested, so
  "the app does the math" is verifiable, not incidental.
- **Storage is behind an interface** (`ReportRepository`). The default
  `JsonReportRepository` writes one file per week under `DATA_DIR`; swap in a
  real database by implementing the same interface.
- **Errors are sanitised** (`errorMiddleware`): validation → 400 with field
  detail; Builder Prime failures → a friendly message, never the raw error (§7.5).

### Builder Prime integration

`BuilderPrimeClient` calls `GET /api/projects/v1` with the `x-api-key` header,
**paginates** (max 100/page) until a short page returns, and maps
`API_UNAUTHORIZED` and network errors to safe user messages. When credentials
are absent, `SampleProjectProvider` supplies deterministic projects so the app
is fully usable offline.

---

## Decisions on the spec's open questions (§8)

These are the v1 defaults; all are configurable or easy to revisit.

1. **Warranties / work orders** — kept **manual** in v1. The public Projects API
   doesn't expose work orders as a distinct object, so warranty counts are a
   manual field that still rolls up to QTD automatically.
2. **Reporting week** — **Sunday–Saturday** by default, configurable via
   `REPORTING_WEEK_START_DAY`. The snapshot is "now" each time the report opens;
   submitting freezes the Builder Prime values for that week.
3. **Write access** — **view-only** (FR-9). The app's key needs only
   `projects.read`. Assignment editing (FR-10) is deferred to Phase 2.
4. **Multiple managers** — set `PRODUCTION_MANAGER_ID` to scope the report and
   project list to one PM's projects; leave blank to see all.
5. **Weekly history** — stored in the app's own backing store (`DATA_DIR`), which
   is what makes QTD rollups automatic.
6. **Hosting & auth** — the key lives server-side. App-level login is **not**
   implemented in Phase 1; deploy behind your existing auth (SSO / reverse proxy)
   before exposing it. This is the main thing to add before production use.

---

## Configuration (`.env`)

| Var | Default | Purpose |
|---|---|---|
| `BUILDER_PRIME_SUBDOMAIN` | — | Builder Prime subdomain |
| `BUILDER_PRIME_API_KEY` | — | Open API key (`projects.read` for v1) |
| `PRODUCTION_MANAGER_ID` | — | Scope to one PM (optional) |
| `REPORTING_WEEK_START_DAY` | `0` | 0 = Sunday |
| `LABOR_MULTIPLIER` | `1.2` | Actual-labor multiplier |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | Where weekly reports persist |
| `ALLOW_SAMPLE_DATA` | `true` | Serve sample data when no key is set |

---

## Tests

```bash
npm test         # vitest, run once
npm run typecheck
```

Coverage spans the reporting-week math, the pure calculation engine, auto-field
derivation from Builder Prime records, the report service (QTD rollups,
override persistence, submit snapshotting), the schedule service (class
grouping, custom-field reads, crew/color/sqft overrides), the material
calculator, color normalisation, and the HTTP API end-to-end.

---

## Not in scope (Phase 2+)

Material-catalog calculator (§6 Option B), warranty/work-order automation,
assignment editing, app-level auth, and reminders/notifications.
```

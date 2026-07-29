# Production Manager — Weekly Report App

A phone-first web app that replaces the weekly production-report spreadsheet.
It pulls everything Builder Prime can supply, does all the math, and leaves the
manager with only the handful of fields a human actually has to enter.

It has three screens: a **Weekly Schedule** (the primary screen — pulls jobs
from Builder Prime, groups them by class, and auto-populates the material to
use), the **Weekly Report** (auto-pull + manual entry + automated math +
save/submit + QTD rollups), and a view-only **Projects** list.

---

## Quick start

```bash
npm install
npm test          # 68 tests
npm start         # http://localhost:3000
```

With **no Builder Prime credentials**, the app boots in **sample-data mode** so
you can click through the whole UI and see the math work.

### Easiest: upload the Production Pipeline export

Instead of wiring up the API, export the **Production Pipeline Report** from
Builder Prime (the .xlsx) and tap **Upload pipeline** on the Schedule screen.
The app reads the file in the browser, parses it server-side, and drives the
whole schedule from it — grouped by class, with crew (the trailer/PM column),
SqFt, color (pulled from the job description), and material all populated. Tap
**Replace** to upload a newer export or **Clear** to go back. The uploaded
pipeline is stored, so it persists (durably when KV is configured — see below).

### Or connect the live API

Copy `.env.example` to `.env` and fill in:

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

Jobs come from one of two sources — an **uploaded Production Pipeline export**
(easiest) or the **live Builder Prime API**. Either way they flow through the
same schedule engine.

**Where each column comes from**

| Column | Pipeline upload | Builder Prime API |
|---|---|---|
| Job Number | `Job #` column | `Job Number` custom field, else project id |
| Class (grouping) | `Class` column (region cleaned) | `className` |
| Project Type | `Type` column | `Project Type` custom field |
| SQFT | `Project Sq Ft` column | `SQFT` custom field |
| Color | parsed from `Description` | `Flake Color` custom field |
| Crew | three named slots (First/Second/Third, "+ person" for more); trailer from the `Project Manager` column seeds the First slot | manual on the schedule |
| Scheduled day | `Start` column | `estimatedStartDate` |
| Material to use | **Computed** from SQFT × coverage rates; color names the flake | same |

Crew, color, base color (Grey/Tan/Black polyurea), sqft, day, and duration are
all editable inline and saved per week. Jobs can be moved to another weekday
and stretched over multiple days (shown as e.g. "Tue–Wed").

**Work orders** (warranty/paid repairs) ride alongside pipeline jobs: upload
the Builder Prime work-order export (WO#, Client, Type, Start, Class, Status)
or add one-off work orders in the app. Open WOs appear on the schedule in
their week and class; once the PM sets SQFT + color (and flake/rubber
coating), material auto-computes into the crew staging lists. Closed WOs
(COMPLETE/PAID) stage nothing.

**Material math** (all rates configurable) — rubber uses different products
and ratios than flake/concrete:

```
Flake / concrete coating:
  Flake                    = SQFT × 0.15 lbs, in 40 lb boxes
  Polyurea basecoat        = 1 total gal per 200 sqft, mixed 2:1 →
                             Base A = SQFT ÷ 300 gal, Base B = SQFT ÷ 600 gal
  Polyaspartic topcoat     = 1 total gal per 130 sqft, equal parts →
                             Top A = Top B = SQFT ÷ 260 gal
  Flake blend              = the job's color

Rubber coating:
  Rubber bags (50 lb)      = SQFT ÷ 30
  Binder (5-gal kit)       = SQFT ÷ 160
  Primer (5-gal kit)       = SQFT ÷ 700
                             (primer kit = 3.5 gal binder + 1.5 gal alcohol spirits)
  Granule blend            = the job's color
```

Warranty / inspection / sand-&-clear jobs show **no material**, matching how
those rows were left blank in the sheet.

**Export**: the Export .xlsx button downloads the viewed week as a workbook —
a full Schedule sheet grouped by class with per-class and week totals, plus
**one printable sheet per crew** (title, week, that crew's jobs by day, and
crew material totals) for handing out. SheetJS is vendored locally
(`public/vendor/`), so upload and export work without any external CDN.

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

## Roster & Performance Pay

- **Roster tab** (admins): each rep with their class, fixed position
  (First / Second / Third / Floater), and hourly rate (defaults $24/$22/$20/$20).
  Positions never shift day-to-day, per the PFP plan — promotions are edited
  here. Roster names auto-suggest in the schedule's crew slots.
- **Pay tab** (admins): pick a class + week and the app computes performance
  pay from the schedule's contract amounts and crew assignments:
  First 5% / Second 4% / Third 3% of contract; more than 3 non-floater
  installers on a job = two-crew rates (2.5/2/1.5), even for a partial second
  crew; floaters earn no commission; the Lead earns +1% of the week's total
  commissionable revenue when the crew completes over $30,000. Jobs with no
  crew are flagged so nothing silently drops out of payroll.
- **Export sheet** downloads the week in the admin's Performance Pay Worksheet
  layout — CREW blocks with Sunday–Saturday day rows (Job #, Contracted
  Amount, Lead/Tech 1/Tech 2 daily pay, rain-out column), totals, pay-period
  dates with Pay Date (end + 6 days), and the employee table (name, position,
  %, bonus payout, commission payout) — ready to hand to payroll.

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

The app deploys via Vercel's **Build Output API**: `npm run build`
(`scripts/build-vercel.mjs`) emits `.vercel/output/` containing a single
self-contained CommonJS function (the whole Express app bundled by esbuild,
with its own `{"type":"commonjs"}` package.json) plus the static UI on the CDN
and explicit routes. Vercel runs the function exactly as built — no runtime
module transformation, which is what previously caused
`FUNCTION_INVOCATION_FAILED` crashes with an ESM entry in `api/`.

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

### Durable storage — Neon Postgres (required for multi-user)

The app stores everything (pipeline uploads, work orders, schedule edits,
reports, and the installer roster) in **Neon Postgres** when `DATABASE_URL`
is set. Two tiny key-value tables are created automatically on first use —
no migrations to run.

1. In Vercel: **Storage → Create Database → Neon (Postgres)** and connect it
   to the project (this injects `DATABASE_URL`), or create a database at
   neon.tech and add `DATABASE_URL` yourself.
2. Redeploy. `GET /api/config` reports `"durableStorage": true` and the red
   warning banner disappears.

### Alternative: Redis (Vercel KV / Upstash)

Vercel's filesystem is read-only except `/tmp`, which is ephemeral and
per-instance — so the default JSON-file store won't persist saved crew
assignments or submitted reports there. The app ships with a **durable
KV-backed store** (Redis, via Vercel KV / Upstash) that turns on automatically
when its env vars are present:

1. In the Vercel dashboard: **Storage → Create → KV** (Upstash Redis) and
   connect it to the project. Vercel injects `KV_REST_API_URL` and
   `KV_REST_API_TOKEN` for you.
2. Redeploy. The app detects them and switches from JSON files to KV — no code
   change. `GET /api/config` reports `"durableStorage": true`, and the startup
   log says `Storage: durable KV`.

It also accepts Upstash's native names (`UPSTASH_REDIS_REST_URL` /
`UPSTASH_REDIS_REST_TOKEN`) if you provision Upstash directly. With neither set,
storage falls back to JSON files (durable locally, ephemeral on Vercel).

> A platform with a persistent disk (Railway, Render, Fly) also works with the
> JSON store and no extra setup.

---

## Architecture

```
Browser (public/)  ──fetch──►  Express API (src/routes)
   mobile SPA                     │
                                  ├─ services/   report + projects logic
                                  ├─ domain/     week math + pure calculations
                                  ├─ builderPrime/  API client + sample provider
                                  └─ storage/    JSON files or durable KV (swappable)
```

- **The Builder Prime key never leaves the server** (§10). The browser only ever
  talks to this app's own API; `/api/config` deliberately omits the key.
- **Calculations are pure** (`src/domain/calculations.ts`) and unit-tested, so
  "the app does the math" is verifiable, not incidental.
- **Storage is behind interfaces** (`ReportRepository`, `ScheduleStore`). Two
  implementations ship: JSON files (`JsonReportRepository`/`JsonScheduleStore`,
  the local default) and durable KV (`KvReportRepository`/`KvScheduleStore` over
  Redis / Vercel KV, auto-selected when configured). Any other database is just
  another implementation of the same interfaces.
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
calculator, color normalisation, the durable KV repositories, the pipeline parser, and the HTTP API (incl. upload) end-to-end.

---

## Not in scope (Phase 2+)

Material-catalog calculator (§6 Option B), warranty/work-order automation,
assignment editing, app-level auth, and reminders/notifications.
```

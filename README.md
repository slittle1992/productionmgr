# Production Manager — Weekly Report App

A phone-first web app that replaces the weekly production-report spreadsheet.
It pulls everything Builder Prime can supply, does all the math, and leaves the
manager with only the handful of fields a human actually has to enter.

Two visible tabs, one per workflow: **Production** — the Friday meeting
checklist with the scoreboard, labor rates, and the weekly inventory-count →
material-cost section — and **Sales** — the sales manager's own cadence
(leads reports, appointments & cancellations). The Schedule, Staging,
Inventory, Pay, Roster, and Projects screens are built and fully wired but
hidden from the tab bar for now (remove `hidden` from a button in
`public/index.html` to bring one back).

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

Two visible tabs — **Production** (the meeting, the default screen) and
**Sales** (the sales manager's workflow). The Schedule, Staging, Inventory,
Pay, Roster, and Projects tabs are hidden for now: their code is intact,
remove `hidden` from a button in `public/index.html` to bring one back. All
built for a thumb:

- **Production** *(default screen)* — the Friday Production
  Meeting checklist (below). The pipeline uploaded here feeds the Schedule.
  Checklist item №5 is **Inventory counts & material cost** — see the
  meeting section below.
- **Sales** — the sales manager's step-by-step cadence: a Daily section
  (steps coming) and the Weekly steps — leads reports and the Meetings
  export (appointments per rep + cancellation rate, saved week over week).
  See **Sales Management** below.
- **Schedule** *(hidden)* — the weekly production schedule that
  replaces the spreadsheet. Jobs are pulled from Builder Prime, grouped by
  **class**, each showing Customer, Job #, project type, scheduled day, SQFT,
  and Color — and the **material to use auto-populates from SQFT and color**.
  Assign a crew and fix any color/sqft inline; it saves as you type.
- **Staging** *(hidden)* — per-location pull lists: what material to set out **this week**
  for the selected week's installs (defaults to next week). Aggregated from the
  schedule per flake blend / rubber color, plus basecoat, topcoat, binder, and
  primer totals; jobs missing SQFT or color are flagged. Exports to .xlsx.
- **Inventory** *(hidden)* — on-hand counts per location vs the selected week's staging
  needs; anything short is flagged so you can order before staging day.
- **Projects** *(hidden)* — active projects with client, address, value, status,
  and who's assigned (PM / foreman / salesperson). Search and a "show
  cancelled" toggle.

(The old Weekly Report tab was replaced by the Staging list; the report API
endpoints still exist server-side.)

---

## Friday Production Meeting (Meeting tab)

A 9-item weekly checklist that the owner, production manager, or an admin can
run from a phone or desktop. A **"What you'll need"** strip at the top lists
every input the meeting takes (exports, payroll, counts, material spend) with
a live ✓ as each one lands — tap a chip to jump to its section. Below it, a
**Scoreboard** shows each location's week side by side: completed revenue,
labor rate, material $ and %, **spec material $** (completed jobs joined to
their pipeline SQFT and run through the coverage math at PO prices), and the
**usage multiple** (actual ÷ spec — 1.0× means crews used exactly what the
spec calls for), color-coded. Each section shows a progress ring; the header
tracks "N of 9 done". Enter your name once at the top — it's stamped on every
sign-off, note, and update so next week you know who owns what.

1. **Past due balances** — upload the Builder Prime **Unpaid Invoices** export.
   Invoices group by class/location. Each one gets a **reason** it's past due
   and an **owner**; open items **carry over automatically** to next week's
   meeting, where they're badged *carryover — needs update* until the owner
   records an update or resolves them. Items that disappear from a fresh upload
   are flagged "probably paid — confirm" for one-tap resolution. Setting an
   **action/install date** produces an *Add to owner's calendar* button — a
   Google Calendar event pre-filled with the client, balance, reason, and the
   owner invited by email.
2. **Work orders & warranties** — uses the **Export data** (work orders)
   upload, shared with the Schedule tab. Open vs completed counts per
   location, and every warranty/callback/redo WO can be tagged with the
   **lead responsible** and **why it happened** — the "Warranties by lead"
   rollup shows who is causing warranties and the causes.
3. **Production pipeline** — upload the **Production Pipeline Report** here or
   on the Schedule tab (same store). The meeting looks **ahead**: per-day load
   (Mon–Sat) per location for the **next two weeks** (on Fri 7/31 that's
   8/2–8/8 and 8/9–8/15), so you can spot under- and over-scheduled days
   before they happen. Also flags jobs with **no start date** and scheduled
   jobs with **no crew/labor assigned** (next-week starts are marked 🔴).
4. **Labor rates** — for the **previous week** (whose pay date lands on the
   meeting Friday): `completed revenue ÷ (production payroll × 1.2)`, per
   location. Upload the **Completed Projects** report for the revenue side.
   For payroll, every market has its own workbook — each location's row has
   its own **⬆ Payroll** upload; the app reads every sheet, totals the
   **Production** department, and suggests the sheet whose pay period matches
   the week. Or just type the number.
5. **Inventory counts & material cost** — the headline is the P&L identity
   **material cost = purchases + (beginning − ending trailer stock value)**,
   per location and overall, compared with §4's completed revenue as
   *material % of revenue*. Two inputs per location per week: the ReVamp
   Material Tracker count (printed **PDF**, .xlsx/.csv, or pasted straight
   off the page — **several files at once**; each sheet's location comes
   from its title and its week from its Submitted date) and one typed
   number, the week's **material spend** (from POs/Ramp). Stock values are
   counts × the PO-derived unit-cost catalog. Because a delivery raises
   stock and purchases equally, big PO weeks don't spike the number — and
   a negative cost means the purchases entry is too low, which the section
   flags rather than hides. The section is organised per location — each
   location is a collapsible block holding its math, its purchase orders
   (expandable to the PO's full line items), and its item movement.
   Purchases fill themselves three ways, best
   first: **drop the vendor PO PDF in** (same upload button — the app tells
   POs and count sheets apart, reads the PO number, supplier, total, and
   the ship-to location, and holds it as *in transit* until a PM taps
   **📦 Received**, which books the dollars into that location's week; PO
   totals rightly include sundries — squeegees and the like are never
   counted, so their dollars expense in the week received, exactly like
   the P&L). Or type the amount by hand (manual always overrides). Or, as
   a floor, tap "arrivals detected ≈ $X — use" (counts that rose, valued
   at PO prices). `scripts/po-email-forwarder.gs` is a ready-made Google
   Apps Script that auto-sends PO PDFs from Gmail (or the Drive PO folder)
   into the app, making ingestion zero-touch — Received stays the one
   human tap. Item movement (counts that went down) stays as
   a collapsible detail per location, with unit costs from
   `src/data/materialPrices.ts` editable inline. Included in the meeting
   export.
6. **Reviews** · 7. **Lytx** · 8. **Ramp** — one-tap links to each dashboard
   (configurable via `REVIEWS_DASHBOARD_URL`, `LYTX_DASHBOARD_URL`,
   `RAMP_DASHBOARD_URL`), a notes box for what you found (incidents, counts,
   actions taken), and a *Mark reviewed* sign-off.
9. **VIP Lead — To-Dos & Crews** — the closing check: open VIP Lead
   (one-tap link via `VIP_LEAD_URL`), clear the Production To-Do bucket
   (nothing unclaimed or stale), and check each VIP Crew channel against
   the roster — right people in the right crew channels, posting on the
   expected cadence. Notes box + *Mark reviewed* sign-off, like the other
   dashboard checks.

Every section also has a manual **sign-off** row recording who completed it
and when. Follow-ups, tags, and per-week state persist in the shared database,
so the meeting history builds week over week.

**Exports:** the meeting (⬇ Export .xlsx in the header — Summary, Past due,
Warranties, Pipeline sheets) and the staging lists (one sheet per location plus
an all-locations pull list) both export to spreadsheets for printing/sharing.

**Snapshots:** tap **📸 Save snapshot** at the end of the meeting to freeze the
whole week server-side — the computed meeting, next week's staging list, and
the inventory position. Later uploads can't change a saved week; the "Saved
weeks" list under the meeting re-downloads any archived week's meeting or
staging workbook.

---

## Sales Management (Sales tab)

The sales manager's own workflow, separate from the production meeting.
The weekly review reads market-first — **Leads → Meetings → Sales** — and
the daily cadence is four tasks, each with a per-day check that resets
tomorrow.

**Daily**

1. **Lead flow vs goal — rubber & flake**, powered by the latest Clients
   List upload. A **By location** table paces each market's month against
   its **monthly leads goal and sold-$ quota** (`src/data/defaultGoals.ts`
   seeds the numbers from the company's Quick Pacing tracker; edit any
   cell inline when the month's goals change — edits persist and win).
   Leads per location are exact; per-location sold $ joins contracts to
   leads by client name (the Company row is exact regardless). No goals
   are set per project type, but the **mix is the diagnostic**: rubber
   tickets run ~2.5× flake, so the card shows the MTD rubber share vs
   last month and the avg ticket per type, and warns when **$ is behind
   pace while lead volume isn't and rubber share fell** — the miss is the
   mix, not the volume. Below it, a **daily lead-volume bar chart of the
   last 3 months** — stacked columns (flake / rubber), month markers, a
   tap/hover readout per day, and a collapsible day-by-day table. The
   split needs the **Project Type** column in the Clients List export
   (the card says so if it's missing; totals chart regardless), and a
   freshness note nudges "upload today's Clients List" whenever the
   newest lead is older than today — making the upload itself part of
   the daily habit.
2. **Review sold contracts** — the last 3 days of contracts (date, rep,
   client, type, sale $) from the Sold Contracts upload, to catch
   mispriced or mistyped deals while they're fresh.
3. **Listen to Rilla recordings** — one-tap link (set `RILLA_URL`), with
   a note to rotate through the reps.
4. **Call the no-sales (rehash)** — every DEMO NO SALE / STILL INTERESTED
   appointment from the latest Meetings upload, with tap-to-call phone
   numbers and the rep who ran the demo.

**Weekly** steps:

1. **Leads — by market** — upload the **Clients List** export. A
   **weekly lead flow** table (total vs last year, plus a column per
   market) leads into the by-location ZIP-cluster analysis: pick a
   window (last week / 4 weeks / quarter); each cluster shows leads vs
   the prior equal window and its **share shift** in points, with ▲/▼
   movement chips per location. Zips with 10+ all-time leads and **zero
   sales ever** are flagged. The **🗺 Heat map + all zips** button opens
   a full-screen choropleth — every zip shaded by lead volume (or jobs,
   all-time), tap a zip for its numbers — above a sortable, searchable
   table of **every zip** with its own .xlsx export. Zip boundaries are
   vendored US Census ZCTA polygons (`public/vendor/tx-zips.json`,
   public-domain TIGER/Line data, simplified).
2. **Meetings — appointments & cancellations** — upload the weekly
   **Meetings** export ("Meetings Between 08/09/2026 and 08/15/2026"; the
   title pins which week it saves to, so past weeks can be backfilled).
   Rows with a client count as appointments; OFF / UNAVAILABLE / TRAINING
   blockers are skipped; **Cancelled** comes from the Meeting Status
   column. Each upload replaces its week. The step shows the
   **cancellation rate week over week** (with the points-change vs the
   prior week), the split **by market** (each appointment's zip comes
   from the meeting title and joins to a market via the leads upload),
   and **appointments per rep** alongside the prior week's count, high
   per-rep cancel rates flagged.
3. **Sales — markets & reps** — upload the **Total Sales (Contracts)**
   detail and the **Lead Performance Summary by Sales Person** exports.
   Together they power:
   - **Weekly sold $** with the **rubber vs flake mix** from each
     contract's Project Type.
   - **Rep scorecard** — close rate (**jobs sold ÷ leads issued**,
     Builder Prime's true funnel, not per-appointment) and **NSLI**
     (net sold $ ÷ leads issued) per rep over the performance report's
     range, with a computed company footer row.
   - **Area sales** — sold $ and NSLI-per-lead per zip cluster in step
     1's tables, joined from contracts to leads by client name (the
     exports carry no zip). By-area close rate is per-lead conversion —
     Builder Prime doesn't report issued-by-zip. Cancelled contracts are
     excluded everywhere.

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

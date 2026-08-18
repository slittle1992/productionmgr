import { Router } from "express";
import { z } from "zod";
import {
  buildLeadsAnalysis,
  buildZipTable,
  parseClientsExport,
} from "../domain/leads.js";
import { parseMeetingsExport } from "../domain/appointments.js";
import { DEFAULT_CLASS_GOALS } from "../data/defaultGoals.js";
import { PipelineFormatError } from "../domain/pipeline.js";
import { getReportingWeek } from "../domain/week.js";
import type { LeadsStore } from "../storage/leadsStore.js";
import {
  computeDailyLeadFlow,
  computeRepScorecard,
  computeWeeklyFlow,
  parseLeadPerformance,
  parseSoldContracts,
  salesByCluster,
} from "../domain/sales.js";
import { asyncHandler } from "./asyncHandler.js";

/** Upload + analyse the Clients List (leads) export by location and zip cluster. */
export function leadsRouter(
  store: LeadsStore,
  now: () => number = () => Date.now(),
  weekStartDay = 0
): Router {
  const router = Router();

  const uploadBody = z.object({
    filename: z.string().max(260).optional(),
    rows: z.array(z.array(z.unknown())).min(1, "The file looks empty."),
    // Chunked upload: the full export exceeds serverless request limits, so
    // the browser sends it in pieces. Every chunk repeats the header row.
    uploadId: z.string().max(60).optional(),
    seq: z.number().int().min(0).optional(),
    chunks: z.number().int().min(1).max(500).optional(),
  });

  // POST /api/leads — replace the stored leads (single-shot or chunked).
  router.post(
    "/leads",
    asyncHandler(async (req, res) => {
      const body = uploadBody.parse(req.body);
      let parsed;
      try {
        parsed = parseClientsExport(body.rows);
      } catch (err) {
        if (err instanceof PipelineFormatError) {
          res.status(400).json({ error: "invalid_leads", message: err.message });
          return;
        }
        throw err;
      }

      const meta = {
        uploadedAt: new Date(now()).toISOString(),
        filename: body.filename ?? null,
        sourceLabel: parsed.sourceLabel,
      };
      const chunked = body.uploadId && body.chunks && body.chunks > 1;

      if (!chunked) {
        if (!parsed.leads.length) {
          res.status(400).json({
            error: "empty_leads",
            message: "No leads found in that file. Is it the Clients List export?",
          });
          return;
        }
        await store.set(parsed.leads, { ...meta, count: parsed.leads.length });
        res.json({ ok: true, count: parsed.leads.length, done: true });
        return;
      }

      const id = body.uploadId!;
      const seq = body.seq ?? 0;
      if (seq === 0) {
        await store.beginUpload(id, parsed.leads);
      } else if (!(await store.appendUpload(id, parsed.leads))) {
        res.status(409).json({
          error: "upload_conflict",
          message: "Another leads upload replaced this one — try again.",
        });
        return;
      }

      if (seq === body.chunks! - 1) {
        const count = await store.finalizeUpload(id, meta);
        if (count === null) {
          res.status(409).json({
            error: "upload_conflict",
            message: "Another leads upload replaced this one — try again.",
          });
          return;
        }
        if (count === 0) {
          res.status(400).json({
            error: "empty_leads",
            message: "No leads found in that file. Is it the Clients List export?",
          });
          return;
        }
        res.json({ ok: true, count, done: true });
      } else {
        res.json({ ok: true, seq, done: false });
      }
    })
  );

  const gridBody = z.object({
    filename: z.string().max(260).optional(),
    rows: z.array(z.array(z.unknown())).min(2),
  });

  // POST /api/leads/sold — the Total Sales (Contracts) detail export. Long
  // date ranges exceed one request body, so the browser can send it in
  // chunks (each repeating the header rows), same as the leads upload.
  const soldBody = gridBody.extend({
    uploadId: z.string().max(60).optional(),
    seq: z.number().int().min(0).optional(),
    chunks: z.number().int().min(1).max(500).optional(),
  });
  router.post(
    "/leads/sold",
    asyncHandler(async (req, res) => {
      const body = soldBody.parse(req.body);
      let parsed;
      try {
        parsed = parseSoldContracts(body.rows);
      } catch (err) {
        if (err instanceof PipelineFormatError) {
          res.status(400).json({ error: "invalid_sold", message: err.message });
          return;
        }
        throw err;
      }
      const meta = {
        uploadedAt: new Date(now()).toISOString(),
        filename: body.filename ?? null,
        sourceLabel: parsed.sourceLabel,
      };
      const chunked = body.uploadId && body.chunks && body.chunks > 1;
      if (!chunked) {
        await store.setSold({ ...meta, rows: parsed.rows });
        res.json({ ok: true, count: parsed.rows.length, done: true });
        return;
      }

      const id = body.uploadId!;
      const seq = body.seq ?? 0;
      if (seq === 0) {
        await store.beginSoldUpload(id, parsed.rows);
      } else if (!(await store.appendSoldUpload(id, parsed.rows))) {
        res.status(409).json({
          error: "upload_conflict",
          message: "Another sold-contracts upload replaced this one — try again.",
        });
        return;
      }
      if (seq === body.chunks! - 1) {
        const count = await store.finalizeSoldUpload(id, meta);
        if (count === null) {
          res.status(409).json({
            error: "upload_conflict",
            message: "Another sold-contracts upload replaced this one — try again.",
          });
          return;
        }
        res.json({ ok: true, count, done: true });
      } else {
        res.json({ ok: true, seq, done: false });
      }
    })
  );

  // POST /api/leads/perf — the Lead Performance Summary (by Sales Person).
  router.post(
    "/leads/perf",
    asyncHandler(async (req, res) => {
      const body = gridBody.parse(req.body);
      try {
        const parsed = parseLeadPerformance(body.rows);
        await store.setPerf({
          ...parsed,
          uploadedAt: new Date(now()).toISOString(),
          filename: body.filename ?? null,
        });
        res.json({ ok: true, reps: parsed.byRep.length });
      } catch (err) {
        if (err instanceof PipelineFormatError) {
          res.status(400).json({ error: "invalid_perf", message: err.message });
          return;
        }
        throw err;
      }
    })
  );

  // POST /api/leads/meetings — the weekly Meetings export (appointments +
  // cancellations). The report title pins the week; each upload replaces it.
  router.post(
    "/leads/meetings",
    asyncHandler(async (req, res) => {
      const body = gridBody.parse(req.body);
      try {
        const parsed = parseMeetingsExport(body.rows);
        if (parsed.fromMs === null) {
          res.status(400).json({
            error: "invalid_meetings",
            message:
              'Couldn\'t find the week in the title ("Meetings Between …") — ' +
              "export the report for one week so results save to the right week.",
          });
          return;
        }
        const week = getReportingWeek(parsed.fromMs, weekStartDay);
        await store.setApptsWeek({
          weekStart: week.weekStart,
          total: parsed.total,
          cancelled: parsed.cancelled,
          byRep: parsed.byRep,
          byZip3: parsed.byZip3,
          noSales: parsed.noSales,
          uploadedAt: new Date(now()).toISOString(),
          filename: body.filename ?? null,
          sourceLabel: parsed.sourceLabel,
        });
        res.json({
          ok: true,
          weekStart: week.weekStart,
          total: parsed.total,
          cancelled: parsed.cancelled,
        });
      } catch (err) {
        if (err instanceof PipelineFormatError) {
          res.status(400).json({ error: "invalid_meetings", message: err.message });
          return;
        }
        throw err;
      }
    })
  );

  // POST /api/leads/goals — the monthly goals for the Daily pacing view:
  // company-wide flake/rubber lead goals, and per-location leads + sold-$
  // quota (which start from the seeded pacing-tracker defaults).
  const goalsBody = z.object({
    flakeMonthly: z.number().int().min(0).max(100000).nullable().optional(),
    rubberMonthly: z.number().int().min(0).max(100000).nullable().optional(),
    className: z.string().max(60).optional(),
    leads: z.number().int().min(0).max(100000).nullable().optional(),
    volume: z.number().min(0).max(100000000).nullable().optional(),
  });
  router.post(
    "/leads/goals",
    asyncHandler(async (req, res) => {
      const body = goalsBody.parse(req.body);
      const current = await store.getGoals();
      const classGoals = { ...(current.classGoals ?? {}) };
      if (body.className) {
        const base =
          classGoals[body.className] ??
          DEFAULT_CLASS_GOALS[body.className] ?? { leads: null, volume: null };
        classGoals[body.className] = {
          leads: body.leads !== undefined ? body.leads : base.leads,
          volume: body.volume !== undefined ? body.volume : base.volume,
        };
      }
      const next = {
        flakeMonthly:
          body.flakeMonthly !== undefined ? body.flakeMonthly : current.flakeMonthly,
        rubberMonthly:
          body.rubberMonthly !== undefined
            ? body.rubberMonthly
            : current.rubberMonthly,
        classGoals,
      };
      await store.setGoals(next);
      res.json({ ok: true, goals: next });
    })
  );

  // POST /api/leads/daily-check — tick/untick one of the daily tasks.
  const dailyBody = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    key: z.enum(["contracts", "rilla", "rehash"]),
    done: z.boolean(),
  });
  router.post(
    "/leads/daily-check",
    asyncHandler(async (req, res) => {
      const body = dailyBody.parse(req.body);
      const at = new Date(now()).toISOString();
      const date = body.date ?? at.slice(0, 10);
      await store.setDailyCheck(date, body.key, body.done, at);
      res.json({ ok: true, date });
    })
  );

  // GET /api/leads?days=7|28|91 — analysis by location → zip cluster.
  router.get(
    "/leads",
    asyncHandler(async (req, res) => {
      const days = z.coerce
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .parse(req.query.days || undefined) ?? 28;
      const [meta, leads, sold, perf, appts, storedGoals, dailyChecks] =
        await Promise.all([
          store.getMeta(),
          store.getLeads(),
          store.getSold(),
          store.getPerf(),
          store.getAppts(),
          store.getGoals(),
          store.getDailyChecks(),
        ]);
      const nowMs = now();
      const soldRows = sold?.rows ?? [];
      // Seeded per-location goals show until an edit stores an override.
      const goals = {
        ...storedGoals,
        classGoals: { ...DEFAULT_CLASS_GOALS, ...(storedGoals.classGoals ?? {}) },
      };

      // zip3 → market, by majority of all-time leads — joins the meetings
      // export's appointment zips to locations.
      const zip3Class = new Map<string, Map<string, number>>();
      for (const l of leads) {
        if (l.zip === "?") continue;
        const z3 = l.zip.slice(0, 3);
        const m = zip3Class.get(z3) ?? new Map<string, number>();
        m.set(l.className, (m.get(l.className) ?? 0) + 1);
        zip3Class.set(z3, m);
      }
      const classOfZip3 = (z3: string): string => {
        const m = zip3Class.get(z3);
        if (!m) return "Unassigned";
        return [...m.entries()].sort((a, b) => b[1] - a[1])[0]![0];
      };
      const appointments = {
        weeks: Object.values(appts)
          .sort((a, b) => b.weekStart.localeCompare(a.weekStart))
          .slice(0, 12)
          .map((w) => {
            let byClass: { className: string; total: number; cancelled: number }[] | null =
              null;
            if (w.byZip3) {
              const acc = new Map<string, { total: number; cancelled: number }>();
              for (const [z3, v] of Object.entries(w.byZip3)) {
                const cls = z3 === "?" ? "Unassigned" : classOfZip3(z3);
                const slot = acc.get(cls) ?? { total: 0, cancelled: 0 };
                slot.total += v.t;
                slot.cancelled += v.c;
                acc.set(cls, slot);
              }
              byClass = [...acc.entries()]
                .map(([className, v]) => ({ className, ...v }))
                .sort((a, b) => b.total - a.total);
            }
            return {
              ...w,
              byClass,
              cancelRate: w.total > 0 ? w.cancelled / w.total : null,
            };
          }),
      };

      // The daily tasks: today's ticks, the recent contracts to eyeball, and
      // the rehash call list from the latest meetings upload.
      const todayIso = new Date(nowMs).toISOString().slice(0, 10);
      const latestAppts = appointments.weeks[0] ?? null;
      const threeDaysAgo = nowMs - 3 * 86400000;
      const dailyTasks = {
        today: todayIso,
        checks: dailyChecks[todayIso] ?? {},
        rillaUrl: process.env.RILLA_URL ?? null,
        recentSold: soldRows
          .filter(
            (s) =>
              s.saleMs !== null &&
              s.saleMs >= threeDaysAgo &&
              !(s.status && /cancel/i.test(s.status))
          )
          .sort((a, b) => (b.saleMs ?? 0) - (a.saleMs ?? 0))
          .slice(0, 30),
        soldUploadedAt: sold?.uploadedAt ?? null,
        rehash: latestAppts?.noSales ?? null,
        rehashWeek: latestAppts?.weekStart ?? null,
      };

      if (!meta) {
        res.json({
          meta: null,
          analysis: null,
          sales: null,
          appointments,
          daily: null,
          dailyTasks,
          goals,
        });
        return;
      }
      const named = leads.filter((l) => l.name).length;
      const area = sold
        ? salesByCluster(leads, soldRows, nowMs - days * 86400000, nowMs)
        : null;
      res.json({
        meta,
        appointments,
        goals,
        dailyTasks,
        daily: computeDailyLeadFlow(leads, goals, nowMs, soldRows),
        analysis: buildLeadsAnalysis(leads, nowMs, days),
        sales: {
          soldMeta: sold
            ? {
                uploadedAt: sold.uploadedAt,
                filename: sold.filename,
                sourceLabel: sold.sourceLabel,
                count: sold.rows.length,
              }
            : null,
          perfMeta: perf
            ? {
                uploadedAt: perf.uploadedAt,
                filename: perf.filename,
                sourceLabel: perf.sourceLabel,
                reps: perf.byRep.length,
              }
            : null,
          weeklyFlow: computeWeeklyFlow(leads, soldRows, weekStartDay, nowMs),
          repScorecard: perf ? computeRepScorecard(perf, soldRows) : null,
          byCluster: area?.clusters ?? null,
          joinInfo: area ? { joined: area.joined, total: area.total } : null,
          /** True when the stored leads predate the name field (re-upload). */
          leadsNeedReupload: leads.length > 0 && named === 0,
        },
      });
    })
  );

  // GET /api/leads/zips?days= — every zip per location (heat map + table).
  router.get(
    "/leads/zips",
    asyncHandler(async (req, res) => {
      const days = z.coerce
        .number()
        .int()
        .min(1)
        .max(3650)
        .optional()
        .parse(req.query.days || undefined) ?? 28;
      const [meta, leads] = await Promise.all([store.getMeta(), store.getLeads()]);
      if (!meta) {
        res.json({ meta: null, table: null });
        return;
      }
      res.json({ meta, table: buildZipTable(leads, now(), days) });
    })
  );

  return router;
}

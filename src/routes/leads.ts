import { Router } from "express";
import { z } from "zod";
import {
  buildLeadsAnalysis,
  buildZipTable,
  parseClientsExport,
} from "../domain/leads.js";
import { parseMeetingsExport } from "../domain/appointments.js";
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

  // POST /api/leads/goals — the monthly lead goals for the Daily pacing view.
  const goalsBody = z.object({
    flakeMonthly: z.number().int().min(0).max(100000).nullable().optional(),
    rubberMonthly: z.number().int().min(0).max(100000).nullable().optional(),
  });
  router.post(
    "/leads/goals",
    asyncHandler(async (req, res) => {
      const body = goalsBody.parse(req.body);
      const current = await store.getGoals();
      const next = {
        flakeMonthly:
          body.flakeMonthly !== undefined ? body.flakeMonthly : current.flakeMonthly,
        rubberMonthly:
          body.rubberMonthly !== undefined
            ? body.rubberMonthly
            : current.rubberMonthly,
      };
      await store.setGoals(next);
      res.json({ ok: true, goals: next });
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
      const [meta, leads, sold, perf, appts, goals] = await Promise.all([
        store.getMeta(),
        store.getLeads(),
        store.getSold(),
        store.getPerf(),
        store.getAppts(),
        store.getGoals(),
      ]);
      const appointments = {
        weeks: Object.values(appts)
          .sort((a, b) => b.weekStart.localeCompare(a.weekStart))
          .slice(0, 12)
          .map((w) => ({
            ...w,
            cancelRate: w.total > 0 ? w.cancelled / w.total : null,
          })),
      };
      if (!meta) {
        res.json({
          meta: null,
          analysis: null,
          sales: null,
          appointments,
          daily: null,
          goals,
        });
        return;
      }
      const nowMs = now();
      const soldRows = sold?.rows ?? [];
      const named = leads.filter((l) => l.name).length;
      const area = sold
        ? salesByCluster(leads, soldRows, nowMs - days * 86400000, nowMs)
        : null;
      res.json({
        meta,
        appointments,
        goals,
        daily: computeDailyLeadFlow(leads, goals, nowMs),
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

import { Router } from "express";
import { z } from "zod";
import type { ReportService } from "../services/reportService.js";
import { saveReportSchema, weekStartSchema } from "./validation.js";
import { asyncHandler } from "./asyncHandler.js";

/**
 * Routes for the weekly report (FR-1 .. FR-5). Reports are per class — each
 * production manager submits their own class's report; `class=All` is the
 * company-wide rollup and the default when omitted.
 */
export function reportsRouter(service: ReportService): Router {
  const router = Router();

  const reportQuery = z.object({
    week: weekStartSchema.optional(),
    class: z.string().trim().min(1).max(60).default("All"),
  });

  // GET /api/report?week=YYYY-MM-DD&class=Austin
  router.get(
    "/report",
    asyncHandler(async (req, res) => {
      const q = reportQuery.parse(req.query);
      const report = await service.getReport(q.week, q.class);
      res.json(report);
    })
  );

  // POST /api/report?week=YYYY-MM-DD&class=Austin — save draft or submit
  router.post(
    "/report",
    asyncHandler(async (req, res) => {
      const q = reportQuery.parse(req.query);
      const body = saveReportSchema.parse(req.body);
      const report = await service.saveReport(
        q.week,
        q.class,
        { overrides: body.overrides, manual: body.manual },
        body.submit
      );
      res.json(report);
    })
  );

  // GET /api/reports — history/archive list (all classes)
  router.get(
    "/reports",
    asyncHandler(async (_req, res) => {
      res.json(await service.listHistory());
    })
  );

  return router;
}

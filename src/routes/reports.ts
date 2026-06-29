import { Router } from "express";
import { z } from "zod";
import type { ReportService } from "../services/reportService.js";
import { saveReportSchema, weekStartSchema } from "./validation.js";
import { asyncHandler } from "./asyncHandler.js";

/** Routes for the weekly report (FR-1 .. FR-5). */
export function reportsRouter(service: ReportService): Router {
  const router = Router();

  const weekQuery = z.object({ week: weekStartSchema.optional() });

  // GET /api/report?week=YYYY-MM-DD  (defaults to the current reporting week)
  router.get(
    "/report",
    asyncHandler(async (req, res) => {
      const { week } = weekQuery.parse(req.query);
      const report = await service.getReport(week);
      res.json(report);
    })
  );

  // POST /api/report?week=YYYY-MM-DD  — save draft or submit
  router.post(
    "/report",
    asyncHandler(async (req, res) => {
      const { week } = weekQuery.parse(req.query);
      const body = saveReportSchema.parse(req.body);
      const report = await service.saveReport(
        week,
        { overrides: body.overrides, manual: body.manual },
        body.submit
      );
      res.json(report);
    })
  );

  // GET /api/reports — history/archive list
  router.get(
    "/reports",
    asyncHandler(async (_req, res) => {
      res.json(await service.listHistory());
    })
  );

  return router;
}

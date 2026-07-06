import { Router } from "express";
import { z } from "zod";
import type { ScheduleService } from "../services/scheduleService.js";
import { colorOptions } from "../domain/colors.js";
import { asyncHandler } from "./asyncHandler.js";
import { weekStartSchema } from "./validation.js";

/** Routes for the weekly production schedule (jobs grouped by class). */
export function scheduleRouter(service: ScheduleService): Router {
  const router = Router();

  const weekQuery = z.object({ week: weekStartSchema.optional() });

  const assignBody = z.object({
    jobId: z.string().min(1),
    crew: z.string().max(200).optional(),
    crewMembers: z.array(z.string().max(60)).max(12).optional(),
    colorOverride: z.string().max(60).optional(),
    sqftOverride: z.number().finite().min(0).max(1_000_000).optional(),
    dayOverride: z.number().int().min(0).max(6).optional(),
    daysCount: z.number().int().min(1).max(6).optional(),
    coating: z.enum(["flake", "rubber", ""]).optional(),
    baseColor: z.enum(["Grey", "Tan", "Black", ""]).optional(),
  });

  // GET /api/schedule?week=YYYY-MM-DD
  router.get(
    "/schedule",
    asyncHandler(async (req, res) => {
      const { week } = weekQuery.parse(req.query);
      res.json(await service.getSchedule(week));
    })
  );

  // POST /api/schedule/assign?week=YYYY-MM-DD
  router.post(
    "/schedule/assign",
    asyncHandler(async (req, res) => {
      const { week } = weekQuery.parse(req.query);
      const body = assignBody.parse(req.body);
      const saved = await service.assignJob(week, body.jobId, {
        crew: body.crew,
        crewMembers: body.crewMembers,
        colorOverride: body.colorOverride,
        sqftOverride: body.sqftOverride,
        dayOverride: body.dayOverride,
        daysCount: body.daysCount,
        coating: body.coating,
        baseColor: body.baseColor,
      });
      res.json({ jobId: body.jobId, assignment: saved });
    })
  );

  // GET /api/colors — canonical dropdown options
  router.get("/colors", (_req, res) => {
    res.json({ colors: colorOptions() });
  });

  return router;
}

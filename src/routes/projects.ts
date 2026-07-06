import { Router } from "express";
import { z } from "zod";
import type { ProjectsService } from "../services/projectsService.js";
import { asyncHandler } from "./asyncHandler.js";

/** Routes for the project list / view (FR-6 .. FR-9). */
export function projectsRouter(service: ProjectsService): Router {
  const router = Router();

  const query = z.object({
    status: z.string().min(1).optional(),
    // ISO date; projects modified on/after this date (within API's 1-year limit).
    modifiedSince: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    includeCancelled: z
      .enum(["true", "false"])
      .optional()
      .transform((v) => v === "true"),
  });

  // Distinct class names (for the schedule/report class chips).
  router.get(
    "/classes",
    asyncHandler(async (_req, res) => {
      res.json({ classes: await service.listClasses() });
    })
  );

  router.get(
    "/projects",
    asyncHandler(async (req, res) => {
      const q = query.parse(req.query);
      const lastModifiedSince = q.modifiedSince
        ? Date.parse(`${q.modifiedSince}T00:00:00.000Z`)
        : undefined;
      const projects = await service.listProjects({
        status: q.status,
        lastModifiedSince,
        includeCancelled: q.includeCancelled,
      });
      res.json({ usingSampleData: service.usingSampleData, projects });
    })
  );

  return router;
}

import { Router } from "express";
import { z } from "zod";
import { buildInventoryView, buildStaging } from "../domain/staging.js";
import type { ScheduleService } from "../services/scheduleService.js";
import type { InventoryStore } from "../storage/inventoryStore.js";
import { asyncHandler } from "./asyncHandler.js";

/**
 * Staging lists (material to set out per location for a week) and the
 * inventory that covers them.
 */
export function stagingRouter(
  scheduleService: ScheduleService,
  inventoryStore: InventoryStore,
  now: () => number = () => Date.now()
): Router {
  const router = Router();
  const isoWeek = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

  // GET /api/staging?week= — per-class staging lists for the week.
  router.get(
    "/staging",
    asyncHandler(async (req, res) => {
      const week = isoWeek.optional().parse(req.query.week || undefined);
      const schedule = await scheduleService.getSchedule(week);
      res.json(buildStaging(schedule));
    })
  );

  // GET /api/inventory?week= — on-hand vs needed (for that week's staging).
  router.get(
    "/inventory",
    asyncHandler(async (req, res) => {
      const week = isoWeek.optional().parse(req.query.week || undefined);
      const [schedule, inventory] = await Promise.all([
        scheduleService.getSchedule(week),
        inventoryStore.getAll(),
      ]);
      res.json(buildInventoryView(buildStaging(schedule), inventory));
    })
  );

  // PATCH /api/inventory — set one item's on-hand count for a class.
  const patchBody = z.object({
    className: z.string().trim().min(1).max(80),
    key: z.string().trim().min(1).max(120),
    qty: z.number().min(0).max(1_000_000),
    by: z.string().trim().max(120).nullable().optional(),
  });
  router.patch(
    "/inventory",
    asyncHandler(async (req, res) => {
      const body = patchBody.parse(req.body);
      await inventoryStore.setItem(
        body.className,
        body.key,
        body.qty,
        body.by ?? null,
        new Date(now()).toISOString()
      );
      res.json({ ok: true });
    })
  );

  return router;
}

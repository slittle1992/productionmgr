import { Router } from "express";
import { z } from "zod";
import { buildStaging, itemLabel, neededByItem } from "../domain/staging.js";
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
      const staging = buildStaging(schedule);

      const classNames = new Set<string>([
        ...staging.classes.map((c) => c.className),
        ...Object.keys(inventory),
      ]);
      const classes = [...classNames].sort().map((className) => {
        const list = staging.classes.find((c) => c.className === className);
        const need = list ? neededByItem(list) : {};
        const onHand = inventory[className]?.items ?? {};
        const keys = new Set([...Object.keys(need), ...Object.keys(onHand)]);
        const items = [...keys]
          .sort()
          .map((key) => {
            const needed = need[key] ?? 0;
            const have = onHand[key] ?? 0;
            return {
              key,
              ...itemLabel(key),
              onHand: have,
              needed,
              short: Math.max(0, Math.round((needed - have) * 100) / 100),
            };
          });
        return {
          className,
          items,
          updatedAt: inventory[className]?.updatedAt ?? null,
          by: inventory[className]?.by ?? null,
        };
      });

      res.json({ weekStart: staging.weekStart, weekEnd: staging.weekEnd, classes });
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

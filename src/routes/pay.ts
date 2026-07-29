import { Router } from "express";
import { z } from "zod";
import { computeWeekPay, type PayJobInput } from "../domain/performancePay.js";
import type { ScheduleService } from "../services/scheduleService.js";
import type { RosterStore } from "../storage/rosterStore.js";
import { asyncHandler } from "./asyncHandler.js";
import { weekStartSchema } from "./validation.js";

/**
 * Performance-pay computation for a class + week: pulls the week's schedule
 * (jobs + crew assignments), applies the PFP rules against the roster, and
 * returns crews → jobs → employee payouts ready to render/export.
 */
export function payRouter(
  scheduleService: ScheduleService,
  rosterStore: RosterStore
): Router {
  const router = Router();

  const query = z.object({
    week: weekStartSchema.optional(),
    class: z.string().trim().min(1).max(60),
  });

  router.get(
    "/pay",
    asyncHandler(async (req, res) => {
      const q = query.parse(req.query);
      const [schedule, roster] = await Promise.all([
        scheduleService.getSchedule(q.week),
        rosterStore.list(),
      ]);

      const group = schedule.classes.find((c) => c.className === q.class);
      const jobs: PayJobInput[] = (group?.jobs ?? []).map((j) => ({
        jobNumber: j.jobNumber,
        customer: j.customer,
        amount: j.contractValue ?? 0,
        dayIndex: j.dayIndex,
        dayLabel: j.dayLabel,
        crewMembers: j.crewMembers,
        isWorkOrder: j.isWorkOrder,
      }));

      const pay = computeWeekPay(jobs, roster.filter((r) => r.active));
      res.json({
        weekStart: schedule.weekStart,
        weekEnd: schedule.weekEnd,
        className: q.class,
        ...pay,
      });
    })
  );

  return router;
}

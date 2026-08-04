import { Router } from "express";
import { z } from "zod";
import { buildInventoryView, buildStaging } from "../domain/staging.js";
import { buildLeadsAnalysis } from "../domain/leads.js";
import type { MeetingService } from "../services/meetingService.js";
import type { ScheduleService } from "../services/scheduleService.js";
import type { InventoryStore } from "../storage/inventoryStore.js";
import type { LeadsStore } from "../storage/leadsStore.js";
import type { SnapshotStore, WeeklySnapshot } from "../storage/snapshotStore.js";
import { asyncHandler } from "./asyncHandler.js";

/**
 * Weekly snapshots: freeze the computed meeting, next week's staging list,
 * and the inventory position, so the week's record survives the next round
 * of uploads replacing the "current" data.
 */
export function snapshotRouter(
  meetingService: MeetingService,
  scheduleService: ScheduleService,
  inventoryStore: InventoryStore,
  store: SnapshotStore,
  now: () => number = () => Date.now(),
  leadsStore?: LeadsStore
): Router {
  const router = Router();
  const isoWeek = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

  // POST /api/snapshots — save (or overwrite) the snapshot for a week.
  const saveBody = z.object({
    week: isoWeek.optional(),
    by: z.string().trim().max(120).nullable().optional(),
  });
  router.post(
    "/snapshots",
    asyncHandler(async (req, res) => {
      const body = saveBody.parse(req.body ?? {});
      const meeting = await meetingService.getMeeting(body.week);

      // Staging is what the meeting stages: the FOLLOWING week's installs.
      const week = meetingService.resolveWeek(meeting.week.weekStart);
      const nextWeekStart = new Date(week.startMs + 7 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const [schedule, inventory] = await Promise.all([
        scheduleService.getSchedule(nextWeekStart),
        inventoryStore.getAll(),
      ]);
      const staging = buildStaging(schedule);

      // Freeze the leads-by-area analysis too (4-week window), when uploaded.
      let leads: unknown = null;
      if (leadsStore && (await leadsStore.getMeta())) {
        leads = buildLeadsAnalysis(await leadsStore.getLeads(), now(), 28);
      }

      const snapshot: WeeklySnapshot = {
        weekStart: meeting.week.weekStart,
        weekEnd: meeting.week.weekEnd,
        savedAt: new Date(now()).toISOString(),
        by: body.by ?? null,
        meeting,
        staging,
        inventory: buildInventoryView(staging, inventory),
        leads,
      };
      await store.save(snapshot);
      res.json({
        ok: true,
        snapshot: {
          weekStart: snapshot.weekStart,
          weekEnd: snapshot.weekEnd,
          savedAt: snapshot.savedAt,
          by: snapshot.by,
        },
      });
    })
  );

  // GET /api/snapshots — saved weeks, newest first.
  router.get(
    "/snapshots",
    asyncHandler(async (_req, res) => {
      res.json({ snapshots: await store.list() });
    })
  );

  // GET /api/snapshots/:week — one full frozen snapshot.
  router.get(
    "/snapshots/:week",
    asyncHandler(async (req, res) => {
      const week = isoWeek.parse(req.params.week);
      const snapshot = await store.get(week);
      if (!snapshot) {
        res.status(404).json({
          error: "not_found",
          message: "No snapshot saved for that week.",
        });
        return;
      }
      res.json(snapshot);
    })
  );

  return router;
}

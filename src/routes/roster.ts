import { Router } from "express";
import { z } from "zod";
import { defaultHourlyRate, type Installer } from "../domain/roster.js";
import type { RosterStore } from "../storage/rosterStore.js";
import { asyncHandler } from "./asyncHandler.js";

/** Admin roster: reps with their class, fixed position, and hourly rate. */
export function rosterRouter(
  store: RosterStore,
  now: () => number = () => Date.now()
): Router {
  const router = Router();

  const upsertBody = z.object({
    id: z.string().max(60).optional(),
    name: z.string().trim().min(1).max(80),
    className: z.string().trim().min(1).max(60),
    role: z.enum(["First", "Second", "Third", "Floater"]),
    hourlyRate: z.number().finite().min(0).max(500).optional(),
    active: z.boolean().default(true),
  });

  router.get(
    "/roster",
    asyncHandler(async (_req, res) => {
      const list = await store.list();
      list.sort(
        (a, b) => a.className.localeCompare(b.className) || a.name.localeCompare(b.name)
      );
      res.json({ roster: list });
    })
  );

  router.post(
    "/roster",
    asyncHandler(async (req, res) => {
      const body = upsertBody.parse(req.body);
      const installer: Installer = {
        id: body.id ?? `rep-${now()}`,
        name: body.name,
        className: body.className,
        role: body.role,
        hourlyRate: body.hourlyRate ?? defaultHourlyRate(body.role),
        active: body.active,
      };
      await store.upsert(installer);
      res.json({ ok: true, installer });
    })
  );

  router.delete(
    "/roster/:id",
    asyncHandler(async (req, res) => {
      await store.remove(String(req.params.id));
      res.json({ ok: true });
    })
  );

  return router;
}

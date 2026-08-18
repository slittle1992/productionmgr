import { Router } from "express";
import { z } from "zod";
import {
  computeInventoryUsage,
  itemKey,
  parseInventory,
  type InventoryUsage,
} from "../domain/inventory.js";
import { PipelineFormatError } from "../domain/pipeline.js";
import { getReportingWeek, getReportingWeekFromStart } from "../domain/week.js";
import type {
  InventoryStore,
  StoredInventoryWeek,
} from "../storage/inventoryStore.js";
import { asyncHandler } from "./asyncHandler.js";

/**
 * Weekly inventory counts + the unit-cost catalog that turns week-over-week
 * usage into a material cost for the Production Management report.
 */
export function inventoryRouter(
  store: InventoryStore,
  weekStartDay: number,
  now: () => number = () => Date.now()
): Router {
  const router = Router();

  const weekParam = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional();

  function resolveWeek(raw: unknown) {
    const parsed = weekParam.parse(raw === undefined ? undefined : String(raw));
    return parsed
      ? getReportingWeekFromStart(parsed, weekStartDay)
      : getReportingWeek(now(), weekStartDay);
  }

  /** The most recent stored count BEFORE `weekStart` (tolerates missed weeks). */
  async function previousWeek(
    weekStart: string
  ): Promise<StoredInventoryWeek | null> {
    const starts = (await store.listWeekStarts()).filter((s) => s < weekStart);
    const last = starts[starts.length - 1];
    return last ? store.getWeek(last) : null;
  }

  interface Summary {
    week: { weekStart: string; weekEnd: string };
    current: {
      uploadedAt: string;
      filename: string | null;
      sourceLabel: string | null;
      itemCount: number;
    } | null;
    previous: { weekStart: string; itemCount: number } | null;
    usage: InventoryUsage | null;
  }

  async function summarize(weekStart: string, weekEnd: string): Promise<Summary> {
    const current = await store.getWeek(weekStart);
    if (!current) {
      return { week: { weekStart, weekEnd }, current: null, previous: null, usage: null };
    }
    const prev = await previousWeek(weekStart);
    const prices = await store.getPrices();
    return {
      week: { weekStart, weekEnd },
      current: {
        uploadedAt: current.uploadedAt,
        filename: current.filename,
        sourceLabel: current.sourceLabel,
        itemCount: current.lines.length,
      },
      previous: prev ? { weekStart: prev.weekStart, itemCount: prev.lines.length } : null,
      usage: computeInventoryUsage(prev?.lines ?? null, current.lines, prices),
    };
  }

  const uploadBody = z.object({
    filename: z.string().max(260).optional(),
    rows: z.array(z.array(z.unknown())).min(1, "The file looks empty."),
  });

  // POST /api/inventory?week= — store this week's count (replaces any prior upload).
  router.post(
    "/inventory",
    asyncHandler(async (req, res) => {
      const week = resolveWeek(req.query.week);
      const body = uploadBody.parse(req.body);
      let parsed;
      try {
        parsed = parseInventory(body.rows);
      } catch (err) {
        if (err instanceof PipelineFormatError) {
          res.status(400).json({ error: "invalid_inventory", message: err.message });
          return;
        }
        throw err;
      }
      await store.setWeek({
        weekStart: week.weekStart,
        uploadedAt: new Date(now()).toISOString(),
        filename: body.filename ?? null,
        sourceLabel: parsed.sourceLabel,
        lines: parsed.lines,
      });
      res.json({ ok: true, ...(await summarize(week.weekStart, week.weekEnd)) });
    })
  );

  // GET /api/inventory?week= — count status + usage + cost for the week.
  router.get(
    "/inventory",
    asyncHandler(async (req, res) => {
      const week = resolveWeek(req.query.week);
      res.json(await summarize(week.weekStart, week.weekEnd));
    })
  );

  // DELETE /api/inventory?week= — remove a mistaken upload.
  router.delete(
    "/inventory",
    asyncHandler(async (req, res) => {
      const week = resolveWeek(req.query.week);
      await store.deleteWeek(week.weekStart);
      res.json({ ok: true });
    })
  );

  // GET /api/inventory/prices — the unit-cost catalog (item key → $/unit).
  router.get(
    "/inventory/prices",
    asyncHandler(async (_req, res) => {
      res.json({ prices: await store.getPrices() });
    })
  );

  const pricesBody = z.object({
    // Item name (any casing) → dollars per unit; 0/negative removes the price.
    prices: z.record(z.string().min(1).max(160), z.number().min(0).max(1_000_000)),
  });

  // POST /api/inventory/prices — merge unit-cost updates.
  router.post(
    "/inventory/prices",
    asyncHandler(async (req, res) => {
      const body = pricesBody.parse(req.body);
      const normalized = Object.fromEntries(
        Object.entries(body.prices).map(([k, v]) => [itemKey(k), v])
      );
      res.json({ ok: true, prices: await store.setPrices(normalized) });
    })
  );

  return router;
}

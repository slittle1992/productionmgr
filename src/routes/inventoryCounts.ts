import { Router } from "express";
import { z } from "zod";
import {
  computeInventoryUsage,
  inventoryValue,
  itemKey,
  parseInventory,
  textLinesToGrid,
  type InventoryUsage,
} from "../domain/inventory.js";
import { pdfToTextLines } from "../domain/inventoryPdf.js";
import {
  isPurchaseOrderGrid,
  parsePurchaseOrder,
} from "../domain/purchaseOrders.js";
import { PipelineFormatError } from "../domain/pipeline.js";
import { getReportingWeek, getReportingWeekFromStart } from "../domain/week.js";
import { DEFAULT_UNIT_COSTS } from "../data/materialPrices.js";
import type {
  InventoryCountsStore,
  StoredInventoryWeek,
  StoredPo,
} from "../storage/inventoryCountsStore.js";
import { classSlug } from "../storage/repository.js";
import { asyncHandler } from "./asyncHandler.js";

/**
 * Weekly inventory counts per location (uploaded from the ReVamp Material
 * Tracker as xlsx/csv, pasted text, or the printed PDF) plus the unit-cost
 * catalog that turns week-over-week usage into a material cost.
 */
export function inventoryCountsRouter(
  store: InventoryCountsStore,
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

  /** A location's most recent count BEFORE `weekStart` (tolerates missed weeks). */
  async function previousFor(
    weekStart: string,
    className: string
  ): Promise<StoredInventoryWeek | null> {
    const starts = (await store.listWeekStarts())
      .filter((s) => s < weekStart)
      .reverse();
    for (const start of starts) {
      const match = (await store.getWeek(start)).find(
        (w) => classSlug(w.className) === classSlug(className)
      );
      if (match) return match;
    }
    return null;
  }

  interface ClassSummary {
    className: string;
    current: {
      uploadedAt: string;
      filename: string | null;
      sourceLabel: string | null;
      itemCount: number;
    };
    previous: { weekStart: string; itemCount: number } | null;
    usage: InventoryUsage;
    /** Trailer stock value at the start of the week (prior count × prices). */
    beginValue: number | null;
    /** Trailer stock value at the end of the week (this count × prices). */
    endValue: number;
    /** Counted items with no unit cost (value is understated by these). */
    valueUnpricedCount: number;
    /** Dollars spent on material this week (manual entry or received POs). */
    purchases: number | null;
    /** Where the purchases figure came from. */
    purchasesSource: "manual" | "pos" | null;
    /** POs received into this location this week. */
    poCount: number;
    /** Their summed totals (shown even when a manual entry overrides). */
    poTotal: number;
    /**
     * The headline: purchases + (begin − end) — the P&L material number.
     * Null until there's a prior count to give a beginning value.
     */
    materialCost: number | null;
  }

  interface Summary {
    week: { weekStart: string; weekEnd: string };
    classes: ClassSummary[];
    /** POs still in transit + those received this week. */
    pos: { pending: StoredPo[]; received: StoredPo[] };
    totals: {
      /** Σ materialCost over classes where it's computable. */
      materialCost: number;
      purchases: number;
      beginValue: number;
      endValue: number;
      usedCount: number;
      unpricedItems: string[];
      /** Locations counted but with no purchases entered (cost is drawdown-only). */
      missingPurchases: string[];
      /** Locations with no prior count yet (excluded from materialCost). */
      missingPrevious: string[];
      /** Received-PO dollars for locations with no count this week. */
      orphanPoTotal: number;
      orphanPoClasses: string[];
    };
  }

  const r2 = (n: number) => Math.round(n * 100) / 100;

  async function summarize(weekStart: string, weekEnd: string): Promise<Summary> {
    const stored = await store.getWeek(weekStart);
    const prices = { ...DEFAULT_UNIT_COSTS, ...(await store.getPrices()) };
    const purchasesMap = await store.getPurchases(weekStart);
    const allPos = await store.listPos();
    const pending = allPos.filter((p) => p.receivedWeek === null);
    const received = allPos.filter((p) => p.receivedWeek === weekStart);
    const poTotals = new Map<string, { total: number; count: number }>();
    for (const po of received) {
      if (!po.className || po.total === null) continue;
      const key = classSlug(po.className);
      const cur = poTotals.get(key) ?? { total: 0, count: 0 };
      cur.total += po.total;
      cur.count++;
      poTotals.set(key, cur);
    }
    const classes: ClassSummary[] = [];
    for (const current of stored) {
      const prev = await previousFor(weekStart, current.className);
      const end = inventoryValue(current.lines, prices);
      const begin = prev ? inventoryValue(prev.lines, prices) : null;
      const manual = purchasesMap[classSlug(current.className)] ?? null;
      const fromPos = poTotals.get(classSlug(current.className));
      // Manual entry wins; otherwise the received POs' totals; else nothing.
      const purchases = manual ?? (fromPos ? r2(fromPos.total) : null);
      const purchasesSource: "manual" | "pos" | null =
        manual !== null ? "manual" : fromPos ? "pos" : null;
      // The P&L identity: material cost = purchases + beginning − ending
      // inventory. With purchases missing it degrades to pure drawdown.
      const materialCost =
        begin === null ? null : r2((purchases ?? 0) + begin.value - end.value);
      classes.push({
        className: current.className,
        current: {
          uploadedAt: current.uploadedAt,
          filename: current.filename,
          sourceLabel: current.sourceLabel,
          itemCount: current.lines.length,
        },
        previous: prev
          ? { weekStart: prev.weekStart, itemCount: prev.lines.length }
          : null,
        usage: computeInventoryUsage(prev?.lines ?? null, current.lines, prices),
        beginValue: begin?.value ?? null,
        endValue: end.value,
        valueUnpricedCount: end.unpricedCount,
        purchases,
        purchasesSource,
        poCount: fromPos?.count ?? 0,
        poTotal: fromPos ? r2(fromPos.total) : 0,
        materialCost,
      });
    }
    const unpriced = new Set<string>();
    for (const c of classes) c.usage.unpricedItems.forEach((i) => unpriced.add(i));
    const counted = new Set(classes.map((c) => classSlug(c.className)));
    const orphanPos = received.filter(
      (p) => p.className && !counted.has(classSlug(p.className))
    );
    return {
      week: { weekStart, weekEnd },
      classes,
      pos: { pending, received },
      totals: {
        materialCost: r2(
          classes.reduce((n, c) => n + (c.materialCost ?? 0), 0)
        ),
        purchases: r2(classes.reduce((n, c) => n + (c.purchases ?? 0), 0)),
        beginValue: r2(classes.reduce((n, c) => n + (c.beginValue ?? 0), 0)),
        endValue: r2(classes.reduce((n, c) => n + c.endValue, 0)),
        usedCount: classes.reduce((n, c) => n + c.usage.usedCount, 0),
        unpricedItems: [...unpriced],
        missingPurchases: classes
          .filter((c) => c.purchases === null)
          .map((c) => c.className),
        missingPrevious: classes
          .filter((c) => c.previous === null)
          .map((c) => c.className),
        // Received-PO dollars waiting on a count upload to enter the math.
        orphanPoTotal: r2(
          orphanPos.reduce((n, p) => n + (p.total ?? 0), 0)
        ),
        orphanPoClasses: [...new Set(orphanPos.map((p) => p.className!))],
      },
    };
  }

  const uploadBody = z
    .object({
      filename: z.string().max(260).optional(),
      /** Spreadsheet grid or pre-split pasted lines. */
      rows: z.array(z.array(z.unknown())).min(1).optional(),
      /** The tracker's printed PDF, base64-encoded (no data: prefix). */
      pdfBase64: z.string().max(24_000_000).optional(),
      /** Overrides the location parsed from the sheet title. */
      className: z.string().trim().min(1).max(80).optional(),
    })
    .refine((b) => b.rows || b.pdfBase64, {
      message: "Send rows or pdfBase64.",
    });

  // POST /api/inventory-counts?week= — store one location's count for the week.
  router.post(
    "/inventory-counts",
    asyncHandler(async (req, res) => {
      const body = uploadBody.parse(req.body);
      let parsed;
      try {
        const grid = body.rows
          ? body.rows
          : textLinesToGrid(
              await pdfToTextLines(
                new Uint8Array(Buffer.from(body.pdfBase64!, "base64"))
              )
            );
        // Vendor POs dropped in from the email land as pending until a PM
        // taps Received (which books the dollars to that location + week).
        if (isPurchaseOrderGrid(grid)) {
          const po = parsePurchaseOrder(grid);
          const stored: StoredPo = {
            id: `po-${now()}-${Math.abs((po.poNumber ?? "x").split("").reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % 10000}`,
            ...po,
            filename: body.filename ?? null,
            uploadedAt: new Date(now()).toISOString(),
            receivedWeek: null,
            receivedAt: null,
          };
          await store.addPo(stored);
          const week = resolveWeek(req.query.week);
          res.json({
            ok: true,
            kind: "po",
            po: stored,
            ...(await summarize(week.weekStart, week.weekEnd)),
          });
          return;
        }
        parsed = parseInventory(grid);
      } catch (err) {
        if (err instanceof PipelineFormatError) {
          res.status(400).json({ error: "invalid_inventory", message: err.message });
          return;
        }
        throw err;
      }
      // The sheet's own Submitted date pins the count to its week — so last
      // week's and this week's History pages can be uploaded in one batch —
      // falling back to the requested (or current) week.
      const week =
        parsed.submittedMs !== null
          ? getReportingWeek(parsed.submittedMs, weekStartDay)
          : resolveWeek(req.query.week);
      const className = body.className?.trim() || parsed.className;
      if (!className) {
        res.status(400).json({
          error: "needs_class",
          message:
            "Couldn't tell which location this count is for — pick the " +
            "location and upload again.",
        });
        return;
      }
      await store.setWeek({
        weekStart: week.weekStart,
        className,
        uploadedAt: new Date(now()).toISOString(),
        filename: body.filename ?? null,
        sourceLabel: parsed.sourceLabel,
        lines: parsed.lines,
      });
      res.json({
        ok: true,
        className,
        itemCount: parsed.itemCount,
        ...(await summarize(week.weekStart, week.weekEnd)),
      });
    })
  );

  // GET /api/inventory-counts?week= — all locations' usage + cost for the week.
  router.get(
    "/inventory-counts",
    asyncHandler(async (req, res) => {
      const week = resolveWeek(req.query.week);
      res.json(await summarize(week.weekStart, week.weekEnd));
    })
  );

  // DELETE /api/inventory-counts?week=&class= — remove one location's upload
  // (or the whole week without `class`).
  router.delete(
    "/inventory-counts",
    asyncHandler(async (req, res) => {
      const week = resolveWeek(req.query.week);
      const className =
        typeof req.query.class === "string" && req.query.class.trim()
          ? req.query.class.trim()
          : undefined;
      await store.deleteWeek(week.weekStart, className);
      res.json({ ok: true });
    })
  );

  // GET /api/inventory-counts/prices — the unit-cost catalog (item key → $/unit).
  router.get(
    "/inventory-counts/prices",
    asyncHandler(async (_req, res) => {
      res.json({
        prices: { ...DEFAULT_UNIT_COSTS, ...(await store.getPrices()) },
        defaults: DEFAULT_UNIT_COSTS,
      });
    })
  );

  const poBody = z.object({
    className: z.string().trim().min(1).max(80).optional(),
    /** true = received this week (?week=); false = back to in-transit. */
    received: z.boolean().optional(),
  });

  // POST /api/inventory-counts/pos/:id?week= — assign a location and/or mark
  // received (books the PO total into that week's purchases).
  router.post(
    "/inventory-counts/pos/:id",
    asyncHandler(async (req, res) => {
      const week = resolveWeek(req.query.week);
      const body = poBody.parse(req.body);
      const patch: Partial<StoredPo> = {};
      if (body.className !== undefined) patch.className = body.className;
      if (body.received !== undefined) {
        patch.receivedWeek = body.received ? week.weekStart : null;
        patch.receivedAt = body.received ? new Date(now()).toISOString() : null;
      }
      const po = await store.updatePo(String(req.params.id), patch);
      if (!po) {
        res.status(404).json({ error: "unknown_po" });
        return;
      }
      res.json({ ok: true, po, ...(await summarize(week.weekStart, week.weekEnd)) });
    })
  );

  // DELETE /api/inventory-counts/pos/:id — remove a mistaken PO upload.
  router.delete(
    "/inventory-counts/pos/:id",
    asyncHandler(async (req, res) => {
      await store.deletePo(String(req.params.id));
      res.json({ ok: true });
    })
  );

  const purchasesBody = z.object({
    className: z.string().trim().min(1).max(80),
    /** Dollars spent on material this week; null clears the entry. */
    amount: z.number().min(0).max(10_000_000).nullable(),
  });

  // POST /api/inventory-counts/purchases?week= — record a location's material
  // spend for the week (the missing piece that makes the cost P&L-true).
  router.post(
    "/inventory-counts/purchases",
    asyncHandler(async (req, res) => {
      const week = resolveWeek(req.query.week);
      const body = purchasesBody.parse(req.body);
      await store.setPurchases(week.weekStart, body.className, body.amount);
      res.json({ ok: true, ...(await summarize(week.weekStart, week.weekEnd)) });
    })
  );

  const pricesBody = z.object({
    // Item name (any casing) → dollars per unit; 0/negative removes the price.
    prices: z.record(z.string().min(1).max(160), z.number().min(0).max(1_000_000)),
  });

  // POST /api/inventory-counts/prices — merge unit-cost updates.
  router.post(
    "/inventory-counts/prices",
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

import { Router } from "express";
import { z } from "zod";
import { PipelineFormatError, toMs } from "../domain/pipeline.js";
import { parseWorkOrders, type WorkOrder } from "../domain/workOrders.js";
import type { WorkOrderStore } from "../storage/workOrderStore.js";
import { asyncHandler } from "./asyncHandler.js";

/** Upload / list / add work orders (warranty + paid repairs). */
export function workOrdersRouter(
  store: WorkOrderStore,
  now: () => number = () => Date.now()
): Router {
  const router = Router();

  const uploadBody = z.object({
    filename: z.string().max(260).optional(),
    rows: z.array(z.array(z.unknown())).min(1, "The file looks empty."),
  });

  // POST /api/workorders — replace uploaded work orders with a new export.
  router.post(
    "/workorders",
    asyncHandler(async (req, res) => {
      const body = uploadBody.parse(req.body);
      let parsed;
      try {
        parsed = parseWorkOrders(body.rows);
      } catch (err) {
        if (err instanceof PipelineFormatError) {
          res.status(400).json({ error: "invalid_workorders", message: err.message });
          return;
        }
        throw err;
      }
      if (!parsed.workOrders.length) {
        res.status(400).json({
          error: "empty_workorders",
          message: "No work orders found in that file. Is it the work-orders export?",
        });
        return;
      }
      await store.setUploaded(parsed.workOrders, {
        uploadedAt: new Date(now()).toISOString(),
        filename: body.filename ?? null,
        sourceLabel: parsed.sourceLabel,
      });
      const s = await store.get();
      res.json({
        ok: true,
        count: s.uploaded.length,
        manualCount: s.manual.length,
        uploadedAt: s.uploadedAt,
      });
    })
  );

  const addBody = z.object({
    client: z.string().trim().min(1).max(120),
    className: z.string().trim().min(1).max(60),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    type: z.string().trim().min(1).max(60).default("Warranty Repair"),
    address: z.string().trim().max(200).optional(),
    city: z.string().trim().max(80).optional(),
  });

  // POST /api/workorders/add — PM adds a one-off work order.
  router.post(
    "/workorders/add",
    asyncHandler(async (req, res) => {
      const body = addBody.parse(req.body);
      const wo: WorkOrder = {
        id: `wo-m${now()}`,
        woNumber: `M-${String(now()).slice(-6)}`,
        client: body.client,
        address: body.address ?? null,
        city: body.city ?? null,
        type: body.type,
        startDate: toMs(`${body.date}T07:30:00Z`) ?? null,
        className: body.className,
        urgency: "NORMAL",
        status: "OPEN",
        createdDate: now(),
        manual: true,
      };
      await store.addManual(wo);
      res.json({ ok: true, workOrder: wo });
    })
  );

  // GET /api/workorders — summary for the status bar.
  router.get(
    "/workorders",
    asyncHandler(async (_req, res) => {
      const s = await store.get();
      res.json({
        count: s.uploaded.length,
        manualCount: s.manual.length,
        uploadedAt: s.uploadedAt,
        sourceLabel: s.sourceLabel,
      });
    })
  );

  // DELETE /api/workorders — remove uploaded + manual work orders.
  router.delete(
    "/workorders",
    asyncHandler(async (_req, res) => {
      await store.clear();
      res.json({ ok: true });
    })
  );

  return router;
}

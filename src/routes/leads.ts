import { Router } from "express";
import { z } from "zod";
import { buildLeadsAnalysis, parseClientsExport } from "../domain/leads.js";
import { PipelineFormatError } from "../domain/pipeline.js";
import type { LeadsStore } from "../storage/leadsStore.js";
import { asyncHandler } from "./asyncHandler.js";

/** Upload + analyse the Clients List (leads) export by location and zip cluster. */
export function leadsRouter(
  store: LeadsStore,
  now: () => number = () => Date.now()
): Router {
  const router = Router();

  const uploadBody = z.object({
    filename: z.string().max(260).optional(),
    rows: z.array(z.array(z.unknown())).min(1, "The file looks empty."),
  });

  // POST /api/leads — replace the stored leads with a fresh export.
  router.post(
    "/leads",
    asyncHandler(async (req, res) => {
      const body = uploadBody.parse(req.body);
      let parsed;
      try {
        parsed = parseClientsExport(body.rows);
      } catch (err) {
        if (err instanceof PipelineFormatError) {
          res.status(400).json({ error: "invalid_leads", message: err.message });
          return;
        }
        throw err;
      }
      if (!parsed.leads.length) {
        res.status(400).json({
          error: "empty_leads",
          message: "No leads found in that file. Is it the Clients List export?",
        });
        return;
      }
      await store.set(parsed.leads, {
        uploadedAt: new Date(now()).toISOString(),
        filename: body.filename ?? null,
        sourceLabel: parsed.sourceLabel,
        count: parsed.leads.length,
      });
      res.json({ ok: true, count: parsed.leads.length });
    })
  );

  // GET /api/leads?days=7|28|91 — analysis by location → zip cluster.
  router.get(
    "/leads",
    asyncHandler(async (req, res) => {
      const days = z.coerce
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .parse(req.query.days || undefined) ?? 28;
      const [meta, leads] = await Promise.all([store.getMeta(), store.getLeads()]);
      if (!meta) {
        res.json({ meta: null, analysis: null });
        return;
      }
      res.json({ meta, analysis: buildLeadsAnalysis(leads, now(), days) });
    })
  );

  return router;
}

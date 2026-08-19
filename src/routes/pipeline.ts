import { Router } from "express";
import { z } from "zod";
import { extractJobFacts } from "../domain/expectedMaterials.js";
import { parsePipeline, PipelineFormatError } from "../domain/pipeline.js";
import { toMeta, type PipelineStore, type StoredPipeline } from "../storage/pipelineStore.js";
import type { CustomFieldNames } from "../config.js";
import { asyncHandler } from "./asyncHandler.js";

/** Routes for uploading and inspecting the production-pipeline export. */
export function pipelineRouter(
  store: PipelineStore,
  now: () => number = () => Date.now(),
  customFields?: CustomFieldNames
): Router {
  const router = Router();

  const uploadBody = z.object({
    filename: z.string().max(260).optional(),
    // Grid of raw rows (array-of-arrays) parsed from the .xlsx in the browser.
    rows: z.array(z.array(z.unknown())).min(1, "The file looks empty."),
  });

  // POST /api/pipeline — replace the current pipeline with an uploaded export.
  router.post(
    "/pipeline",
    asyncHandler(async (req, res) => {
      const body = uploadBody.parse(req.body);
      let parsed;
      try {
        parsed = parsePipeline(body.rows);
      } catch (err) {
        if (err instanceof PipelineFormatError) {
          res.status(400).json({ error: "invalid_pipeline", message: err.message });
          return;
        }
        throw err;
      }
      if (parsed.rowCount === 0) {
        res.status(400).json({
          error: "empty_pipeline",
          message: "No jobs were found in that file. Is it the Production Pipeline export?",
        });
        return;
      }
      const stored: StoredPipeline = {
        projects: parsed.projects,
        uploadedAt: new Date(now()).toISOString(),
        filename: body.filename ?? null,
        rowCount: parsed.rowCount,
        classes: parsed.classes,
        sourceLabel: parsed.sourceLabel,
      };
      await store.set(stored);
      res.json({ ok: true, pipeline: toMeta(stored) });
    })
  );

  // POST /api/pipeline/backfill — merge a historical pipeline export's Job #
  // → sqft/color into the permanent job history WITHOUT touching the live
  // pipeline. Fixes thin $/ft² coverage for weeks whose jobs predate the
  // stored history: export the pipeline report over the old date range and
  // upload it here.
  router.post(
    "/pipeline/backfill",
    asyncHandler(async (req, res) => {
      const body = uploadBody.parse(req.body);
      let parsed;
      try {
        parsed = parsePipeline(body.rows);
      } catch (err) {
        if (err instanceof PipelineFormatError) {
          res.status(400).json({ error: "invalid_pipeline", message: err.message });
          return;
        }
        throw err;
      }
      if (parsed.rowCount === 0) {
        res.status(400).json({
          error: "empty_pipeline",
          message:
            "No jobs were found in that file. Is it the Production Pipeline export?",
        });
        return;
      }
      const facts = customFields
        ? extractJobFacts(parsed.projects, customFields)
        : {};
      const withSqft = Object.values(facts).filter((f) => f.sqft).length;
      await store.mergeJobFacts(facts);
      res.json({ ok: true, jobs: Object.keys(facts).length, withSqft });
    })
  );

  // GET /api/pipeline — current pipeline metadata (or null).
  router.get(
    "/pipeline",
    asyncHandler(async (_req, res) => {
      const current = await store.get();
      res.json({ pipeline: current ? toMeta(current) : null });
    })
  );

  // DELETE /api/pipeline — revert to sample/live data.
  router.delete(
    "/pipeline",
    asyncHandler(async (_req, res) => {
      await store.clear();
      res.json({ ok: true });
    })
  );

  return router;
}

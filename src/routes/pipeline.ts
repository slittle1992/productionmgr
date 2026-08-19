import { Router } from "express";
import { z } from "zod";
import { extractJobFacts, parseSqftBackfill } from "../domain/expectedMaterials.js";
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

  // POST /api/pipeline/backfill — merge historical jobs' Job # → sqft into
  // the permanent job history WITHOUT touching the live pipeline. Accepts
  // ANY export with Job # and SQFT columns — the Completed Projects report
  // (with SQFT added via the column picker) covers old jobs the
  // forward-looking pipeline report can't. Fixes thin $/ft² coverage for
  // weeks whose jobs predate the stored history.
  router.post(
    "/pipeline/backfill",
    asyncHandler(async (req, res) => {
      const body = uploadBody.parse(req.body);
      // A pipeline export gets the full parse (keeps colors); anything else
      // falls back to the lenient Job # + SQFT reader.
      try {
        const parsed = parsePipeline(body.rows);
        if (parsed.rowCount > 0 && customFields) {
          const facts = extractJobFacts(parsed.projects, customFields);
          const withSqft = Object.values(facts).filter((f) => f.sqft).length;
          if (withSqft > 0) {
            await store.mergeJobFacts(facts);
            res.json({ ok: true, jobs: Object.keys(facts).length, withSqft });
            return;
          }
        }
      } catch {
        /* not a pipeline export — try the lenient reader */
      }
      try {
        const { facts, rows } = parseSqftBackfill(body.rows);
        const withSqft = Object.keys(facts).length;
        if (withSqft === 0) {
          res.status(400).json({
            error: "no_sqft",
            message: `Found ${rows} jobs but none had a usable SQFT value.`,
          });
          return;
        }
        await store.mergeJobFacts(facts);
        res.json({ ok: true, jobs: rows, withSqft });
      } catch (err) {
        res.status(400).json({
          error: "invalid_backfill",
          message: (err as Error).message,
        });
      }
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

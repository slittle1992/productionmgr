import { Router } from "express";
import { z } from "zod";
import { PipelineFormatError } from "../domain/pipeline.js";
import type { MeetingService } from "../services/meetingService.js";
import { asyncHandler } from "./asyncHandler.js";

/** Friday Production Meeting: uploads, follow-up edits, checks, sign-offs. */
export function meetingRouter(service: MeetingService): Router {
  const router = Router();

  const isoWeek = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  const gridBody = z.object({
    filename: z.string().max(260).optional(),
    week: isoWeek.optional(),
    rows: z.array(z.array(z.unknown())).min(1, "The file looks empty."),
  });

  // GET /api/meeting?week=YYYY-MM-DD — the whole meeting for a week.
  router.get(
    "/meeting",
    asyncHandler(async (req, res) => {
      const week = isoWeek.optional().parse(req.query.week || undefined);
      res.json(await service.getMeeting(week));
    })
  );

  // POST /api/meeting/pastdue — upload the Unpaid Invoices export.
  router.post(
    "/meeting/pastdue",
    asyncHandler(async (req, res) => {
      const body = gridBody.parse(req.body);
      try {
        const result = await service.uploadPastDue(
          body.rows,
          body.filename ?? null,
          body.week
        );
        res.json({ ok: true, ...result });
      } catch (err) {
        if (err instanceof PipelineFormatError) {
          res.status(400).json({ error: "invalid_pastdue", message: err.message });
          return;
        }
        throw err;
      }
    })
  );

  // PATCH /api/meeting/followups/:invoiceNumber — reason / owner / status / note.
  const followUpBody = z.object({
    week: isoWeek.optional(),
    reason: z.string().trim().max(500).optional(),
    owner: z.string().trim().max(120).optional(),
    ownerEmail: z.string().trim().max(200).optional(),
    actionDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    status: z.enum(["open", "resolved"]).optional(),
    note: z.string().trim().max(1000).optional(),
    by: z.string().trim().max(120).optional(),
  });
  router.patch(
    "/meeting/followups/:invoiceNumber",
    asyncHandler(async (req, res) => {
      const body = followUpBody.parse(req.body);
      const updated = await service.updateFollowUp(
        String(req.params.invoiceNumber),
        body,
        body.week
      );
      if (!updated) {
        res.status(404).json({
          error: "not_found",
          message: "No follow-up with that invoice number. Upload the export first.",
        });
        return;
      }
      res.json({ ok: true, followUp: updated });
    })
  );

  // POST /api/meeting/completed — upload the Completed Projects report.
  router.post(
    "/meeting/completed",
    asyncHandler(async (req, res) => {
      const body = gridBody.parse(req.body);
      try {
        const result = await service.uploadCompleted(body.rows, body.filename ?? null);
        res.json({ ok: true, ...result });
      } catch (err) {
        if (err instanceof PipelineFormatError) {
          res.status(400).json({ error: "invalid_completed", message: err.message });
          return;
        }
        throw err;
      }
    })
  );

  router.delete(
    "/meeting/completed",
    asyncHandler(async (_req, res) => {
      await service.clearCompleted();
      res.json({ ok: true });
    })
  );

  // POST /api/meeting/payroll — summarise a payroll workbook's sheets so the
  // meeting can pick the Production total for the right pay period.
  const payrollBody = z.object({
    week: isoWeek.optional(),
    sheets: z
      .array(
        z.object({
          name: z.string().max(120),
          rows: z.array(z.array(z.unknown())),
        })
      )
      .min(1, "The workbook looks empty."),
  });
  router.post(
    "/meeting/payroll",
    asyncHandler(async (req, res) => {
      const body = payrollBody.parse(req.body);
      const sheets = service.summarisePayroll(body.sheets, body.week);
      if (!sheets.length) {
        res.status(400).json({
          error: "invalid_payroll",
          message:
            "Couldn't find a payroll table (Department + Total Gross Pay columns) " +
            "in any sheet. Is this the weekly payroll workbook?",
        });
        return;
      }
      res.json({ ok: true, sheets });
    })
  );

  // PATCH /api/meeting/labor — save payroll / revenue for a class + week.
  const laborBody = z.object({
    week: isoWeek,
    className: z.string().trim().min(1).max(80),
    productionPayroll: z.number().min(0).nullable().optional(),
    revenueOverride: z.number().min(0).nullable().optional(),
    sheetName: z.string().max(120).nullable().optional(),
    by: z.string().trim().max(120).nullable().optional(),
  });
  router.patch(
    "/meeting/labor",
    asyncHandler(async (req, res) => {
      const body = laborBody.parse(req.body);
      await service.setLabor(body.week, body.className, body);
      res.json({ ok: true });
    })
  );

  // PATCH /api/meeting/check — Reviews / Lytx / Ramp dashboard sign-off.
  const checkBody = z.object({
    week: isoWeek,
    key: z.enum(["reviews", "lytx", "ramp"]),
    status: z.enum(["pending", "done"]).optional(),
    notes: z.string().max(2000).optional(),
    by: z.string().trim().max(120).optional(),
  });
  router.patch(
    "/meeting/check",
    asyncHandler(async (req, res) => {
      const body = checkBody.parse(req.body);
      const check = await service.setCheck(body.week, body.key, body);
      res.json({ ok: true, check });
    })
  );

  // PATCH /api/meeting/wonote — tag a warranty WO with the lead + cause.
  const woNoteBody = z.object({
    woId: z.string().min(1).max(80),
    lead: z.string().trim().max(120),
    cause: z.string().trim().max(500),
    by: z.string().trim().max(120).nullable().optional(),
  });
  router.patch(
    "/meeting/wonote",
    asyncHandler(async (req, res) => {
      const body = woNoteBody.parse(req.body);
      const note = await service.setWoNote(
        body.woId,
        body.lead,
        body.cause,
        body.by ?? null
      );
      res.json({ ok: true, note });
    })
  );

  // PATCH /api/meeting/section — manual per-section sign-off.
  const sectionBody = z.object({
    week: isoWeek,
    key: z.enum(["pastdue", "workorders", "pipeline", "labor", "reviews", "lytx", "ramp", "leads"]),
    done: z.boolean(),
    by: z.string().trim().max(120).nullable().optional(),
  });
  router.patch(
    "/meeting/section",
    asyncHandler(async (req, res) => {
      const body = sectionBody.parse(req.body);
      await service.setSection(body.week, body.key, body.done, body.by ?? null);
      res.json({ ok: true });
    })
  );

  return router;
}

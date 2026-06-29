import { z } from "zod";

const money = z
  .number({ invalid_type_error: "Must be a number" })
  .finite()
  .min(0, "Cannot be negative");

const count = z.number().int("Must be a whole number").min(0);

export const manualFieldsSchema = z.object({
  actualLaborRaw: money,
  warrantiesOpenedThisWeek: count,
  leadsThisWeek: count,
  materialsGivenForWarranties: money,
  projectedMaterials: money,
  actualMaterials: money,
  totalSundriesCost: money,
});

export const overridesSchema = z
  .object({
    projectedJobSchedule: money.optional(),
    completedJobsRevenue: money.optional(),
    projectedLabor: money.optional(),
  })
  .strict();

export const saveReportSchema = z.object({
  overrides: overridesSchema.default({}),
  manual: manualFieldsSchema,
  submit: z.boolean().default(false),
});

export const weekStartSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Week must be an ISO date (YYYY-MM-DD)");

export type SaveReportBody = z.infer<typeof saveReportSchema>;

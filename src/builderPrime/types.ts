/**
 * Subset of the Builder Prime "List Projects" record (GET /api/projects/v1)
 * that this app relies on. The live API returns more fields; we keep the ones
 * called out in §7.1 of the requirements.
 *
 * All fields are optional because the Open API does not guarantee every field
 * is populated on every record, and the app must degrade gracefully (§7.5).
 */
export interface BuilderPrimeProject {
  projectId?: number | string;
  opportunityId?: number | string;
  projectName?: string;
  description?: string;

  estimatedValue?: number;
  laborCost?: number;
  materialCost?: number;
  equipmentCost?: number;
  subcontractorCost?: number;

  // Dates are epoch milliseconds in the Builder Prime API.
  estimatedStartDate?: number;
  estimatedFinishDate?: number;
  completionDateTime?: number;
  lastModifiedDateTime?: number;

  /** Builder Prime "class" — used to group the schedule (e.g. region). */
  className?: string;

  projectStatusDescription?: string;
  projectStatusCategoryDescription?: string;
  projectStatusIsComplete?: boolean;
  projectStatusIsCancelled?: boolean;

  // Work-site address.
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  zip?: string;

  // Client.
  clientFirstName?: string;
  clientLastName?: string;
  clientCompanyName?: string;

  // Assigned people.
  projectManagerId?: number | string;
  projectManagerFirstName?: string;
  projectManagerLastName?: string;
  projectManagerEmailAddress?: string;

  foremanId?: number | string;
  foremanFirstName?: string;
  foremanLastName?: string;
  foremanEmailAddress?: string;

  salesPersonId?: number | string;
  salesPersonFirstName?: string;
  salesPersonLastName?: string;
  salesPersonEmailAddress?: string;

  /** A native job number, if Builder Prime exposes one. */
  jobNumber?: number | string;

  /**
   * Custom fields. Builder Prime may return these as an object map or as an
   * array of { name/label, value } entries; the reader handles both.
   */
  customFields?:
    | Record<string, unknown>
    | Array<{ name?: string; label?: string; value?: unknown }>;
}

/** Read a custom field by trying several possible names (case-insensitive). */
export function readCustomField(
  project: BuilderPrimeProject,
  names: string[]
): unknown {
  const cf = project.customFields;
  if (!cf) return undefined;
  const wanted = names.map((n) => n.toLowerCase().trim());

  if (Array.isArray(cf)) {
    for (const item of cf) {
      const label = (item.name ?? item.label ?? "").toLowerCase().trim();
      if (label && wanted.includes(label)) return item.value;
    }
    return undefined;
  }

  for (const [k, v] of Object.entries(cf)) {
    if (wanted.includes(k.toLowerCase().trim())) return v;
  }
  return undefined;
}

export interface ListProjectsParams {
  opportunityId?: string;
  lastModifiedSince?: number; // ms since epoch, within the past year
  projectStatus?: string;
  limit?: number; // max 100
  page?: number; // starts at 0
}

export interface BuilderPrimeErrorBody {
  success: false;
  errors: Array<{ code: string; message: string }>;
}

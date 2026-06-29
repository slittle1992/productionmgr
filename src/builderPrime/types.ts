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

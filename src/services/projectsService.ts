import type { ProjectProvider } from "../builderPrime/provider.js";
import type { BuilderPrimeProject } from "../builderPrime/types.js";

/** Clean, phone-friendly projection of a Builder Prime project (FR-7). */
export interface ProjectView {
  id: string;
  name: string;
  status: string;
  statusCategory: string;
  isComplete: boolean;
  isCancelled: boolean;
  estimatedValue: number;
  client: string;
  address: string;
  estimatedStartDate: number | null;
  estimatedFinishDate: number | null;
  completionDate: number | null;
  assigned: {
    projectManager: AssignedPerson | null;
    foreman: AssignedPerson | null;
    salesPerson: AssignedPerson | null;
  };
}

export interface AssignedPerson {
  id: string | null;
  name: string;
  email: string | null;
}

function person(
  id: number | string | undefined,
  first: string | undefined,
  last: string | undefined,
  email: string | undefined
): AssignedPerson | null {
  const name = [first, last].filter(Boolean).join(" ").trim();
  if (!name && id === undefined) return null;
  return { id: id === undefined ? null : String(id), name: name || "—", email: email ?? null };
}

function clientName(p: BuilderPrimeProject): string {
  const personName = [p.clientFirstName, p.clientLastName].filter(Boolean).join(" ").trim();
  return p.clientCompanyName || personName || "—";
}

function address(p: BuilderPrimeProject): string {
  const parts = [p.addressLine1, p.addressLine2, p.city, p.state, p.zip].filter(Boolean);
  return parts.join(", ");
}

export function toProjectView(p: BuilderPrimeProject, index: number): ProjectView {
  return {
    id: String(p.projectId ?? p.opportunityId ?? `idx-${index}`),
    name: p.projectName || "Untitled project",
    status: p.projectStatusDescription || "—",
    statusCategory: p.projectStatusCategoryDescription || "—",
    isComplete: Boolean(p.projectStatusIsComplete),
    isCancelled: Boolean(p.projectStatusIsCancelled),
    estimatedValue: p.estimatedValue ?? 0,
    client: clientName(p),
    address: address(p),
    estimatedStartDate: p.estimatedStartDate ?? null,
    estimatedFinishDate: p.estimatedFinishDate ?? null,
    completionDate: p.completionDateTime ?? null,
    assigned: {
      projectManager: person(
        p.projectManagerId,
        p.projectManagerFirstName,
        p.projectManagerLastName,
        p.projectManagerEmailAddress
      ),
      foreman: person(p.foremanId, p.foremanFirstName, p.foremanLastName, p.foremanEmailAddress),
      salesPerson: person(
        p.salesPersonId,
        p.salesPersonFirstName,
        p.salesPersonLastName,
        p.salesPersonEmailAddress
      ),
    },
  };
}

export interface ListProjectsOptions {
  status?: string;
  /** Only projects modified on/after this instant (ms). */
  lastModifiedSince?: number;
  includeCancelled?: boolean;
}

export class ProjectsService {
  constructor(
    private readonly provider: ProjectProvider,
    private readonly productionManagerId: string | null
  ) {}

  get usingSampleData(): boolean {
    return this.provider.isSample;
  }

  /** Fetch and normalise projects, applying the configured PM scope (§8.4). */
  async listProjects(options: ListProjectsOptions = {}): Promise<ProjectView[]> {
    const raw = await this.provider.listAllProjects({
      projectStatus: options.status,
      lastModifiedSince: options.lastModifiedSince,
    });

    let views = raw.map(toProjectView);

    if (this.productionManagerId) {
      views = views.filter(
        (v) => v.assigned.projectManager?.id === this.productionManagerId
      );
    }
    if (!options.includeCancelled) {
      views = views.filter((v) => !v.isCancelled);
    }
    if (options.status) {
      const wanted = options.status.toLowerCase();
      views = views.filter((v) => v.status.toLowerCase() === wanted);
    }

    return views.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Raw provider access for the report service (avoids a second normalise
   * pass). Optionally scoped to one class — how each PM's per-class weekly
   * report pulls only that class's jobs.
   */
  async fetchRawProjects(className?: string): Promise<BuilderPrimeProject[]> {
    let raw = await this.provider.listAllProjects({});
    if (this.productionManagerId) {
      raw = raw.filter(
        (p) =>
          p.projectManagerId !== undefined &&
          String(p.projectManagerId) === this.productionManagerId
      );
    }
    if (className) {
      raw = raw.filter(
        (p) => (p.className?.trim() || "Unassigned") === className
      );
    }
    return raw;
  }

  /** Distinct class names across the provider's projects (for filter chips). */
  async listClasses(): Promise<string[]> {
    const raw = await this.provider.listAllProjects({});
    const classes = new Set<string>();
    for (const p of raw) {
      if (p.projectStatusIsCancelled) continue;
      classes.add(p.className?.trim() || "Unassigned");
    }
    return [...classes].sort((a, b) => a.localeCompare(b));
  }
}

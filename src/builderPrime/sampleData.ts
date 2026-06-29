import type { ProjectProvider } from "./provider.js";
import type { BuilderPrimeProject } from "./types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Deterministic sample projects spread across the weeks around an anchor date.
 * Lets the whole app (UI + math) be exercised without live Builder Prime
 * credentials. Real credentials always take precedence (see ProductionApp wiring).
 */
export class SampleProjectProvider implements ProjectProvider {
  readonly isSample = true;
  private readonly anchorMs: number;

  constructor(anchorMs: number) {
    // Normalise to start of UTC day for stable, repeatable dates.
    const d = new Date(anchorMs);
    this.anchorMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async listAllProjects(): Promise<BuilderPrimeProject[]> {
    return this.buildProjects();
  }

  private day(offsetDays: number): number {
    return this.anchorMs + offsetDays * MS_PER_DAY;
  }

  private buildProjects(): BuilderPrimeProject[] {
    const pm = {
      projectManagerId: 101,
      projectManagerFirstName: "Sample",
      projectManagerLastName: "Manager",
      projectManagerEmailAddress: "pm@example.com",
    };
    const foreman = {
      foremanId: 201,
      foremanFirstName: "Frank",
      foremanLastName: "Foreman",
      foremanEmailAddress: "frank@example.com",
    };
    const sales = {
      salesPersonId: 301,
      salesPersonFirstName: "Sara",
      salesPersonLastName: "Sales",
      salesPersonEmailAddress: "sara@example.com",
    };

    return [
      // --- Starting this week (feeds Projected Schedule + Projected Labor) ---
      {
        projectId: 1,
        projectName: "Maple St. Kitchen Remodel",
        description: "Full kitchen tear-out and reinstall",
        estimatedValue: 42000,
        laborCost: 12000,
        materialCost: 9000,
        estimatedStartDate: this.day(1),
        estimatedFinishDate: this.day(12),
        projectStatusDescription: "Scheduled",
        projectStatusCategoryDescription: "PRODUCTION",
        projectStatusIsComplete: false,
        projectStatusIsCancelled: false,
        addressLine1: "14 Maple St",
        city: "Springfield",
        state: "MA",
        zip: "01103",
        clientFirstName: "Dana",
        clientLastName: "Reyes",
        ...pm,
        ...foreman,
        ...sales,
      },
      {
        projectId: 2,
        projectName: "Oak Ave. Bathroom",
        estimatedValue: 18500,
        laborCost: 6000,
        materialCost: 4000,
        estimatedStartDate: this.day(3),
        estimatedFinishDate: this.day(9),
        projectStatusDescription: "Scheduled",
        projectStatusCategoryDescription: "PRODUCTION",
        projectStatusIsComplete: false,
        projectStatusIsCancelled: false,
        addressLine1: "88 Oak Ave",
        city: "Springfield",
        state: "MA",
        zip: "01104",
        clientCompanyName: "Oak Ave Holdings",
        ...pm,
        ...foreman,
      },
      // --- Completed this week (feeds Completed Revenue + Installed Revenue) ---
      {
        projectId: 3,
        projectName: "Birch Rd. Flooring",
        estimatedValue: 27000,
        laborCost: 8000,
        materialCost: 11000,
        estimatedStartDate: this.day(-10),
        estimatedFinishDate: this.day(-1),
        completionDateTime: this.day(-1),
        projectStatusDescription: "Complete",
        projectStatusCategoryDescription: "PRODUCTION",
        projectStatusIsComplete: true,
        projectStatusIsCancelled: false,
        addressLine1: "5 Birch Rd",
        city: "Chicopee",
        state: "MA",
        zip: "01020",
        clientFirstName: "Pat",
        clientLastName: "Nguyen",
        ...pm,
        ...foreman,
        ...sales,
      },
      {
        projectId: 4,
        projectName: "Cedar Ct. Deck",
        estimatedValue: 15500,
        laborCost: 5000,
        materialCost: 7000,
        estimatedStartDate: this.day(-8),
        completionDateTime: this.day(-2),
        projectStatusDescription: "Complete",
        projectStatusCategoryDescription: "PRODUCTION",
        projectStatusIsComplete: true,
        projectStatusIsCancelled: false,
        addressLine1: "3 Cedar Ct",
        city: "Holyoke",
        state: "MA",
        zip: "01040",
        clientFirstName: "Lee",
        clientLastName: "Owens",
        ...pm,
      },
      // --- Out of this week (should be excluded from weekly totals) ---
      {
        projectId: 5,
        projectName: "Elm St. Addition",
        estimatedValue: 95000,
        laborCost: 30000,
        materialCost: 22000,
        estimatedStartDate: this.day(20),
        estimatedFinishDate: this.day(60),
        projectStatusDescription: "Sold",
        projectStatusCategoryDescription: "PRODUCTION",
        projectStatusIsComplete: false,
        projectStatusIsCancelled: false,
        addressLine1: "200 Elm St",
        city: "Springfield",
        state: "MA",
        zip: "01105",
        clientFirstName: "Morgan",
        clientLastName: "Diaz",
        ...pm,
        ...sales,
      },
      // --- Cancelled (should never count) ---
      {
        projectId: 6,
        projectName: "Pine Way (cancelled)",
        estimatedValue: 30000,
        laborCost: 9000,
        estimatedStartDate: this.day(2),
        projectStatusDescription: "Cancelled",
        projectStatusCategoryDescription: "PRODUCTION",
        projectStatusIsComplete: false,
        projectStatusIsCancelled: true,
        addressLine1: "9 Pine Way",
        city: "Springfield",
        state: "MA",
        zip: "01108",
        clientFirstName: "Sam",
        clientLastName: "Cole",
        ...pm,
      },
    ];
  }
}

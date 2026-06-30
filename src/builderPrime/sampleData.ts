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
        jobNumber: 236297,
        projectName: "Maple St. Kitchen Remodel",
        description: "Full kitchen tear-out and reinstall",
        className: "Austin",
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
        city: "Killeen",
        state: "TX",
        zip: "76542",
        clientFirstName: "Dana",
        clientLastName: "Reyes",
        customFields: { "SQFT": 549, "Flake Color": "Wombat", "Project Type": "Flake" },
        ...pm,
        ...foreman,
        ...sales,
      },
      {
        projectId: 2,
        jobNumber: 210539,
        projectName: "Oak Ave. Bathroom",
        className: "Austin",
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
        city: "Spicewood",
        state: "TX",
        zip: "78669",
        clientCompanyName: "Oak Ave Holdings",
        // Intentionally messy color + alternate field name to exercise normalisation.
        customFields: { "Square Footage": 665, "Color": "Caspain", "Job Type": "Rubber" },
        ...pm,
        ...foreman,
      },
      // --- More jobs starting this week, across classes (drive the schedule) ---
      {
        projectId: 7,
        jobNumber: 215844,
        projectName: "Fair Oaks Garage",
        className: "San Antonio",
        estimatedStartDate: this.day(1),
        projectStatusDescription: "Scheduled",
        projectStatusIsComplete: false,
        projectStatusIsCancelled: false,
        city: "Fair Oaks Ranch",
        state: "TX",
        clientFirstName: "John",
        clientLastName: "Francis",
        customFields: { "SQFT": 518, "Flake Color": "Gray", "Project Type": "Flake" },
        ...pm,
      },
      {
        projectId: 8,
        jobNumber: 211381,
        projectName: "Boerne Pool Deck",
        className: "San Antonio",
        estimatedStartDate: this.day(2),
        projectStatusDescription: "Scheduled",
        projectStatusIsComplete: false,
        projectStatusIsCancelled: false,
        city: "Boerne",
        state: "TX",
        clientFirstName: "George",
        clientLastName: "Joy",
        customFields: { "SQFT": 456, "Flake Color": "Platinum", "Project Type": "Rubber" },
        ...pm,
      },
      {
        projectId: 9,
        jobNumber: 212651,
        projectName: "Dallas Pool Deck",
        className: "Dallas",
        estimatedStartDate: this.day(2),
        projectStatusDescription: "Scheduled",
        projectStatusIsComplete: false,
        projectStatusIsCancelled: false,
        city: "Dallas",
        state: "TX",
        clientFirstName: "Thomas",
        clientLastName: "Morris",
        customFields: { "SQFT": 685, "Flake Color": "Sandalwood", "Project Type": "Rubber" },
        ...pm,
      },
      {
        projectId: 10,
        jobNumber: 34732,
        projectName: "Carport Warranty",
        className: "Austin",
        estimatedStartDate: this.day(4),
        projectStatusDescription: "Warranty",
        projectStatusIsComplete: false,
        projectStatusIsCancelled: false,
        city: "Austin",
        state: "TX",
        clientFirstName: "Zella",
        clientLastName: "Frey",
        // Warranty → no material, even with sqft present.
        customFields: { "SQFT": 300, "Flake Color": "Eggshell", "Project Type": "Warranty" },
        ...pm,
      },
      {
        projectId: 11,
        jobNumber: 222339,
        projectName: "Weslaco Patio",
        className: "Corpus",
        estimatedStartDate: this.day(3),
        projectStatusDescription: "Scheduled",
        projectStatusIsComplete: false,
        projectStatusIsCancelled: false,
        city: "Weslaco",
        state: "TX",
        clientFirstName: "Oraldo",
        clientLastName: "Cardoza",
        customFields: { "SQFT": 900, "Flake Color": "Glacier", "Project Type": "Flake" },
        ...pm,
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

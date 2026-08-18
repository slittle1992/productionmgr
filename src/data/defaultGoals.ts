import type { ClassGoal } from "../domain/sales.js";

/**
 * Seed goals per location — monthly leads (inquiries) goal and sold-$ volume
 * quota, taken from the company's "Quick Pacing Coatings Tracking" sheet
 * (Deluxe Garages brand rows, August 2026; the sheet updates goals monthly).
 * Cross-checked against its Total Brand row: 3,131 leads / $2,075,000.
 * The app shows these until the sales manager edits a goal inline — edits
 * are stored and win over these defaults.
 */
export const DEFAULT_CLASS_GOALS: Record<string, ClassGoal> = {
  Austin: { leads: 651, volume: 450000 },
  "Corpus Christi": { leads: 363, volume: 275000 },
  Dallas: { leads: 664, volume: 600000 },
  Houston: { leads: 833, volume: 375000 },
  "San Antonio": { leads: 620, volume: 375000 },
};

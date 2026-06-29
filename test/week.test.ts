import { describe, expect, it } from "vitest";
import {
  getReportingWeek,
  getReportingWeekFromStart,
  isWithinWeek,
  quarterWeekStarts,
} from "../src/domain/week.js";

const ms = (iso: string) => Date.parse(iso);

describe("getReportingWeek", () => {
  it("returns Sunday–Saturday week for a midweek date (default start day 0)", () => {
    // 2026-06-29 is a Monday.
    const week = getReportingWeek(ms("2026-06-29T15:00:00Z"));
    expect(week.weekStart).toBe("2026-06-28"); // Sunday
    expect(week.weekEnd).toBe("2026-07-04"); // Saturday
    expect(week.quarter).toBe("2026-Q2");
  });

  it("treats the start day itself as the first day of the week", () => {
    const week = getReportingWeek(ms("2026-06-28T00:00:00Z"));
    expect(week.weekStart).toBe("2026-06-28");
  });

  it("supports a Monday-start week", () => {
    const week = getReportingWeek(ms("2026-06-29T00:00:00Z"), 1);
    expect(week.weekStart).toBe("2026-06-29"); // Monday
    expect(week.weekEnd).toBe("2026-07-05");
  });
});

describe("isWithinWeek", () => {
  const week = getReportingWeekFromStart("2026-06-28");

  it("includes the start instant and excludes the next week's start", () => {
    expect(isWithinWeek(week.startMs, week)).toBe(true);
    expect(isWithinWeek(week.endMsExclusive, week)).toBe(false);
    expect(isWithinWeek(week.endMsExclusive - 1, week)).toBe(true);
  });

  it("returns false for undefined or non-finite", () => {
    expect(isWithinWeek(undefined, week)).toBe(false);
    expect(isWithinWeek(NaN, week)).toBe(false);
  });
});

describe("quarterWeekStarts", () => {
  it("lists weeks from the quarter start up to the target week", () => {
    const week = getReportingWeekFromStart("2026-06-28");
    const starts = quarterWeekStarts(week);
    expect(starts[0]).toBe("2026-03-29"); // week containing Apr 1
    expect(starts.at(-1)).toBe("2026-06-28");
    // Strictly increasing, 7 days apart.
    for (let i = 1; i < starts.length; i++) {
      const diff = Date.parse(starts[i]!) - Date.parse(starts[i - 1]!);
      expect(diff).toBe(7 * 24 * 3600 * 1000);
    }
  });
});

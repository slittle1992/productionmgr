import { describe, expect, it } from "vitest";
import { computeWeekPay, type PayJobInput } from "../src/domain/performancePay.js";
import { commissionPct } from "../src/domain/roster.js";
import type { Installer } from "../src/domain/roster.js";

const roster: Installer[] = [
  { id: "1", name: "Derek Perez", className: "Dallas", role: "First", hourlyRate: 24, active: true },
  { id: "2", name: "Caitlyn Tabor", className: "Dallas", role: "Second", hourlyRate: 22, active: true },
  { id: "3", name: "Giovanni Jimenez", className: "Dallas", role: "Third", hourlyRate: 20, active: true },
  { id: "4", name: "Eliaz Flores", className: "Dallas", role: "Second", hourlyRate: 22, active: true },
  { id: "5", name: "Floater Fred", className: "Dallas", role: "Floater", hourlyRate: 20, active: true },
];

function job(overrides: Partial<PayJobInput>): PayJobInput {
  return {
    jobNumber: "100",
    customer: "Test",
    amount: 10000,
    dayIndex: 1,
    dayLabel: "Mon",
    crewMembers: ["Derek Perez", "Caitlyn Tabor", "Giovanni Jimenez"],
    isWorkOrder: false,
    ...overrides,
  };
}

describe("commissionPct", () => {
  it("matches the PFP plan rates", () => {
    expect(commissionPct("First", 1)).toBe(0.05);
    expect(commissionPct("Second", 1)).toBe(0.04);
    expect(commissionPct("Third", 1)).toBe(0.03);
    expect(commissionPct("First", 2)).toBe(0.025);
    expect(commissionPct("Second", 2)).toBe(0.02);
    expect(commissionPct("Third", 2)).toBe(0.015);
    expect(commissionPct("Floater", 1)).toBe(0);
  });
});

describe("computeWeekPay", () => {
  it("pays 5/4/3% on a single-crew job (MASTER sheet example: $36,500 week)", () => {
    const pay = computeWeekPay(
      [job({ jobNumber: "210928", amount: 23000 }), job({ jobNumber: "211525", amount: 13500, dayIndex: 4 })],
      roster
    );
    expect(pay.crews).toHaveLength(1);
    const crew = pay.crews[0]!;
    expect(crew.totalContracted).toBe(36500);
    const [lead, second, third] = crew.employees;
    expect(lead!.commission).toBe(1825); // 5%
    expect(second!.commission).toBe(1460); // 4%
    expect(third!.commission).toBe(1095); // 3%
    // Lead bonus: > $30k → 1% of total.
    expect(lead!.bonus).toBe(365);
    expect(second!.bonus).toBeNull();
  });

  it("gives no bonus at or under $30k", () => {
    const pay = computeWeekPay([job({ amount: 30000 })], roster);
    expect(pay.crews[0]!.employees[0]!.bonus).toBeNull();
  });

  it("halves rates when more than 3 non-floater installers are on a job", () => {
    const pay = computeWeekPay(
      [job({ amount: 10000, crewMembers: ["Derek Perez", "Caitlyn Tabor", "Eliaz Flores", "Giovanni Jimenez"] })],
      roster
    );
    const crew = pay.crews[0]!;
    expect(crew.jobs[0]!.crews).toBe(2);
    const byName = Object.fromEntries(crew.employees.map((e) => [e.name, e]));
    expect(byName["Derek Perez"]!.commission).toBe(250); // 2.5%
    expect(byName["Caitlyn Tabor"]!.commission).toBe(200); // 2%
    expect(byName["Eliaz Flores"]!.commission).toBe(200); // partial second crew still 2%
    expect(byName["Giovanni Jimenez"]!.commission).toBe(150); // 1.5%
  });

  it("keeps single-crew rates when the 4th member is a trainee floater", () => {
    const pay = computeWeekPay(
      [job({ amount: 10000, crewMembers: ["Derek Perez", "Caitlyn Tabor", "Giovanni Jimenez", "Floater Fred"] })],
      roster
    );
    const crew = pay.crews[0]!;
    expect(crew.jobs[0]!.crews).toBe(1);
    const byName = Object.fromEntries(crew.employees.map((e) => [e.name, e]));
    expect(byName["Derek Perez"]!.commission).toBe(500); // full 5%
    expect(byName["Floater Fred"]!.commission).toBe(0); // hourly, no commission
    expect(byName["Floater Fred"]!.position).toBe("Floater (hourly)");
  });

  it("call-out: remaining members keep their fixed roles (no one moves up)", () => {
    const pay = computeWeekPay(
      [job({ amount: 10000, crewMembers: ["Derek Perez", "", "Giovanni Jimenez"] })],
      roster
    );
    const crew = pay.crews[0]!;
    const byName = Object.fromEntries(crew.employees.map((e) => [e.name, e]));
    expect(byName["Derek Perez"]!.commission).toBe(500); // 5%
    expect(byName["Giovanni Jimenez"]!.commission).toBe(300); // still Third at 3%
    expect(crew.employees).toHaveLength(2);
  });

  it("falls back to slot position for names not on the roster", () => {
    const pay = computeWeekPay(
      [job({ amount: 10000, crewMembers: ["Unknown Lead", "Unknown Two"] })],
      roster
    );
    const byName = Object.fromEntries(pay.crews[0]!.employees.map((e) => [e.name, e]));
    expect(byName["Unknown Lead"]!.role).toBe("First");
    expect(byName["Unknown Lead"]!.commission).toBe(500);
    expect(byName["Unknown Lead"]!.onRoster).toBe(false);
    expect(byName["Unknown Two"]!.role).toBe("Second");
  });

  it("routes crew-less jobs to unassigned and computes daily-pay columns", () => {
    const pay = computeWeekPay([job({ crewMembers: [], amount: 5003 })], roster);
    expect(pay.crews).toHaveLength(0);
    expect(pay.unassigned).toHaveLength(1);
    // Worksheet example: $5,003 Monday → 250.15 / 200.12 / 150.09.
    expect(pay.unassigned[0]!.leadDailyPay).toBe(250.15);
    expect(pay.unassigned[0]!.tech1DailyPay).toBe(200.12);
    expect(pay.unassigned[0]!.tech2DailyPay).toBe(150.09);
  });

  it("skips zero-amount jobs (work orders without contract value)", () => {
    const pay = computeWeekPay([job({ amount: 0 })], roster);
    expect(pay.crews).toHaveLength(0);
    expect(pay.totalContracted).toBe(0);
  });
});

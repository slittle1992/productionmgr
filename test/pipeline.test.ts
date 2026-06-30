import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cleanClassName, parsePipeline, toMs } from "../src/domain/pipeline.js";
import { readCustomField } from "../src/builderPrime/types.js";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/pipelineSample.json", import.meta.url)), "utf8")
) as unknown[][];

describe("cleanClassName", () => {
  it("strips the 'Deluxe Garages -' prefix and state suffix", () => {
    expect(cleanClassName("Deluxe Garages - Austin, TX")).toBe("Austin");
    expect(cleanClassName("Deluxe Garages - Corpus Christi, TX")).toBe("Corpus Christi");
    expect(cleanClassName(null)).toBe("Unassigned");
  });
});

describe("toMs", () => {
  it("parses ISO and 'YYYY-MM-DD HH:mm' strings", () => {
    expect(toMs("2026-08-13T07:30:00")).toBe(Date.parse("2026-08-13T07:30:00"));
    expect(toMs("2026-08-13 07:30")).toBe(Date.parse("2026-08-13T07:30"));
  });
  it("converts Excel serial numbers", () => {
    // 46235 ≈ 2026-08-13
    const ms = toMs(46235)!;
    expect(new Date(ms).getUTCFullYear()).toBe(2026);
  });
  it("returns undefined for blanks", () => {
    expect(toMs(null)).toBeUndefined();
    expect(toMs("")).toBeUndefined();
  });
});

describe("parsePipeline (real export fixture)", () => {
  it("finds the header row and maps job rows", () => {
    const result = parsePipeline(fixture);
    expect(result.rowCount).toBeGreaterThan(0);
    expect(result.sourceLabel).toContain("Data as of");
  });

  it("maps the first job's fields and custom fields", () => {
    const { projects } = parsePipeline(fixture);
    const job = projects.find((p) => p.jobNumber === "156407")!;
    expect(job).toBeTruthy();
    expect(job.className).toBe("Austin"); // cleaned from "Deluxe Garages - Austin, TX"
    expect(job.estimatedValue).toBe(3000); // Sold Amount
    expect(readCustomField(job, ["SQFT"])).toBe(255);
    expect(readCustomField(job, ["Project Type"])).toBe("Concrete Coating");
    // Color extracted from the description "...- Claystone"
    expect(readCustomField(job, ["Flake Color"])).toBe("Claystone");
  });

  it("uses the Project Manager column as the crew hint", () => {
    const { projects } = parsePipeline(fixture);
    const dallas = projects.find((p) => p.className === "Dallas");
    expect(dallas).toBeTruthy();
    expect(readCustomField(dallas!, ["Crew"])).toMatch(/Trailer/i);
  });

  it("groups counts by cleaned class name", () => {
    const { classes } = parsePipeline(fixture);
    expect(Object.values(classes).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it("throws a helpful error when the header is missing", () => {
    expect(() => parsePipeline([["nonsense"], ["a", "b"]])).toThrow(/header row/i);
  });
});

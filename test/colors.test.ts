import { describe, expect, it } from "vitest";
import { colorOptions, normalizeColor } from "../src/domain/colors.js";

describe("normalizeColor", () => {
  it("maps known typos to the canonical name", () => {
    expect(normalizeColor("Caspain")?.name).toBe("Caspian");
    expect(normalizeColor("Galcier")?.name).toBe("Glacier");
    expect(normalizeColor("nickle")?.name).toBe("Nickel");
    expect(normalizeColor("feather gray")?.name).toBe("Feather Grey");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(normalizeColor("  WOMBAT ")?.name).toBe("Wombat");
    expect(normalizeColor("wombat")?.recognized).toBe(true);
  });

  it("resolves the flake product for mapped colors", () => {
    expect(normalizeColor("Orbit")?.flakeProduct).toBe("Voodoo / Orbit");
    expect(normalizeColor("Shoreline")?.flakeProduct).toBe("Tucson/Shoreline");
  });

  it("takes the first part of a slash combo", () => {
    expect(normalizeColor("Wombat/Domino")?.name).toBe("Wombat");
  });

  it("keeps unrecognised colors but flags them", () => {
    const c = normalizeColor("Some New Color");
    expect(c?.name).toBe("Some New Color");
    expect(c?.recognized).toBe(false);
  });

  it("returns null for empty input", () => {
    expect(normalizeColor("")).toBeNull();
    expect(normalizeColor(null)).toBeNull();
    expect(normalizeColor(undefined)).toBeNull();
  });
});

describe("colorOptions", () => {
  it("exposes a non-empty canonical list with flake products", () => {
    const opts = colorOptions();
    expect(opts.length).toBeGreaterThan(30);
    expect(opts.every((o) => o.name && o.flakeProduct)).toBe(true);
  });
});

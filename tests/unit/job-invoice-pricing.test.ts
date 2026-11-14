import { describe, expect, it } from "vitest";
import { estimateTravelDistanceKm, serviceCodeFromCategory } from "@/lib/job-invoice-pricing";

describe("shared fixed-rate invoice mapping", () => {
  it.each([
    ["periodic maintenance", "periodic"],
    ["electrical wiring", "electrical"],
    ["ترمز و تعلیق", "brakes"],
    ["hydraulic system", "hydraulic"],
    ["major engine repair", "engine_major"],
    ["minor engine repair", "engine_minor"],
    ["transmission gearbox", "transmission"],
    ["diagnostic inspection", "diagnostic"],
  ])("maps %s to the explicit rate code", (category, expected) => {
    expect(serviceCodeFromCategory(category)).toBe(expected);
  });

  it("does not guess a generic engine repair level or unknown service", () => {
    expect(serviceCodeFromCategory("engine repair")).toBeNull();
    expect(serviceCodeFromCategory("custom unlisted service")).toBeNull();
  });

  it("returns zero when no valid customer destination is available", () => {
    expect(estimateTravelDistanceKm({ lat: 35.7, lng: 51.4 }, { lat: null, lng: null })).toBe(0);
  });

  it("returns a non-negative integer estimate from the earliest dispatch point", () => {
    const distance = estimateTravelDistanceKm(
      { lat: 35.6892, lng: 51.3890 },
      { lat: 36.2605, lng: 50.0040 },
    );
    expect(Number.isSafeInteger(distance)).toBe(true);
    expect(distance).toBeGreaterThan(0);
  });
});

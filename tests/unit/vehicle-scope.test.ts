import { describe, expect, it } from "vitest";
import { getMakesForMode } from "@/lib/vehicle-db";
import { vehicleCreateSchema, vehicleUpdateSchema } from "@/lib/schemas/vehicle";
import { isVehicleInSupportedScope } from "@/lib/vehicle-scope";

describe("MEKANIX vehicle service scope", () => {
  it("keeps Kerman, Modiran, Farda and foreign passenger makes in the catalog", () => {
    const makes = getMakesForMode("passenger").map((entry) => entry.make);
    expect(makes).toContain("کرمان موتور");
    expect(makes).toContain("مدیران خودرو");
    expect(makes).toContain("فردا موتور");
    expect(makes).toContain("Toyota");
    expect(makes).toContain("Peugeot");
  });

  it("removes Iran Khodro, Saipa and Pars Khodro from the passenger catalog", () => {
    const makes = getMakesForMode("passenger").map((entry) => entry.make);
    expect(makes).not.toContain("ایران خودرو");
    expect(makes).not.toContain("سایپا");
    expect(makes).not.toContain("پارس خودرو");
  });

  it("rejects excluded passenger makes in create and update schemas", () => {
    const base = { type: "CAR", model: "Test", year: 2024 };
    expect(vehicleCreateSchema.safeParse({ ...base, make: "ایران خودرو" }).success).toBe(false);
    expect(vehicleCreateSchema.safeParse({ ...base, make: "Saipa" }).success).toBe(false);
    expect(vehicleCreateSchema.safeParse({ ...base, make: "پارس خودرو" }).success).toBe(false);
    expect(vehicleUpdateSchema.safeParse({ type: "CAR", make: "Iran Khodro (IKCO)" }).success).toBe(false);
  });

  it("keeps supported assemblers and all heavy machinery types eligible", () => {
    expect(vehicleCreateSchema.safeParse({
      type: "CAR", make: "کرمان موتور", model: "KMC J7", year: 2024,
    }).success).toBe(true);
    expect(isVehicleInSupportedScope("TRUCK", "سایپا")).toBe(true);
    expect(isVehicleInSupportedScope("EXCAVATOR", "Iran Khodro")).toBe(true);
  });
});

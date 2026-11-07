import { describe, expect, it } from "vitest";
import { careBookingSchema } from "@/lib/schemas/care";

const validBooking = {
  vehicleId: "vehicle-123",
  location: "Tehran",
  expectedPricingVersion: "rate-card-1",
};

describe("CARE booking pricing contract", () => {
  it("defaults omitted service type to periodic maintenance", () => {
    const parsed = careBookingSchema.parse(validBooking);
    expect(parsed.serviceType).toBe("periodic");
  });

  it("rejects unsupported service types instead of silently pricing them as diagnostics", () => {
    expect(careBookingSchema.safeParse({
      ...validBooking,
      serviceType: "emergency",
    }).success).toBe(false);
  });

  it("requires a quote version before a booking can be created", () => {
    expect(careBookingSchema.safeParse({
      vehicleId: validBooking.vehicleId,
      location: validBooking.location,
    }).success).toBe(false);
  });

  it("accepts the rate-card version returned by the quote endpoint", () => {
    const parsed = careBookingSchema.parse({
      ...validBooking,
      expectedPricingVersion: "rate-card-12",
    });
    expect(parsed.expectedPricingVersion).toBe("rate-card-12");
  });

  it("rejects malformed or oversized rate-card version tokens", () => {
    expect(careBookingSchema.safeParse({
      ...validBooking,
      expectedPricingVersion: "",
    }).success).toBe(false);
    expect(careBookingSchema.safeParse({
      ...validBooking,
      expectedPricingVersion: "v".repeat(65),
    }).success).toBe(false);
  });
});

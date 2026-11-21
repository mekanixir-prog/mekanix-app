import { describe, expect, it } from "vitest";
import { serviceRequestCreateSchema } from "@/lib/schemas/service";

const validRequest = {
  category: "diagnostic",
  title: "Engine warning light",
  address: "Tehran",
  lat: 35.7,
  lng: 51.4,
};

describe("service request creation schema", () => {
  it("requires a registered vehicle", () => {
    expect(serviceRequestCreateSchema.safeParse(validRequest).success).toBe(false);
  });

  it("accepts a request linked to a registered vehicle", () => {
    expect(serviceRequestCreateSchema.safeParse({
      ...validRequest,
      vehicleId: "vehicle-registered-1",
    }).success).toBe(true);
  });
});

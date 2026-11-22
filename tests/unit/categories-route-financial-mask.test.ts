import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/categories/route";

describe("public category financial provenance", () => {
  it("does not expose unit-ambiguous legacy base prices as trusted money", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const categories = await response.json();
    expect(categories.length).toBeGreaterThan(0);
    for (const category of categories) {
      expect(category.basePrice).toBeNull();
      expect(category.financialUnitStatus).toBe("UNVERIFIED");
    }
  });
});

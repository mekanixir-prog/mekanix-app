import { describe, expect, it } from "vitest";
import { fmtMoney } from "@/lib/format";

describe("fmtMoney currency handling", () => {
  it("does not label an unknown currency as USD", () => {
    const formatted = fmtMoney(125000, "XYZ", "en");

    expect(formatted).toBe("Unknown currency");
    expect(formatted).not.toContain("$");
    expect(formatted).not.toContain("USD");
  });

  it("uses a Persian unavailable label for an unknown currency", () => {
    expect(fmtMoney(125000, "XYZ", "fa")).toBe("واحد نامشخص");
  });

  it("continues to format explicitly supported currencies", () => {
    expect(fmtMoney(125000, "USD", "en")).toBe("$125,000");
    expect(fmtMoney(125000, "IRR", "en")).toBe("﷼125,000");
  });

  it("does not coerce fractional IRR values", () => {
    expect(fmtMoney(125000.5, "IRR", "en")).toBe("—");
  });
});

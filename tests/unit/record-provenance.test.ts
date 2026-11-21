import { describe, expect, it } from "vitest";
import { isVerifiedIrrRecord } from "@/lib/money/record-provenance";

describe("record-level financial unit provenance", () => {
  it("fails closed for missing, unknown, and quarantined status", () => {
    expect(isVerifiedIrrRecord(undefined)).toBe(false);
    expect(isVerifiedIrrRecord("UNVERIFIED")).toBe(false);
    expect(isVerifiedIrrRecord("QUARANTINED")).toBe(false);
    expect(isVerifiedIrrRecord("VERIFIED_USD")).toBe(false);
  });

  it("requires explicit VERIFIED_IRR attestation", () => {
    expect(isVerifiedIrrRecord("VERIFIED_IRR")).toBe(true);
    expect(isVerifiedIrrRecord("VERIFIED_IRR", "IRR")).toBe(true);
  });

  it("does not let IRR attestation override conflicting currency metadata", () => {
    expect(isVerifiedIrrRecord("VERIFIED_IRR", "USD")).toBe(false);
    expect(isVerifiedIrrRecord("VERIFIED_IRR", "EUR")).toBe(false);
    expect(isVerifiedIrrRecord("VERIFIED_IRR", null)).toBe(false);
  });
});

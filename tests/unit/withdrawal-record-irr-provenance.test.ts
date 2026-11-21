import { describe, expect, it } from "vitest";
import { getWithdrawalRecordIrrError } from "@/lib/money/withdrawal-record-provenance";

describe("historical withdrawal IRR provenance gate", () => {
  it("blocks production admin transitions until historical units are reconciled", () => {
    expect(getWithdrawalRecordIrrError(500000, {
      NODE_ENV: "production",
    })).toBe("WITHDRAWAL_IRR_PROVENANCE_UNVERIFIED");
  });

  it("rejects fractional, unsafe and non-positive amounts after attestation", () => {
    const env = {
      NODE_ENV: "production",
      MEKANIX_WITHDRAWAL_IRR_PROVENANCE_VERIFIED: "true",
    };
    expect(getWithdrawalRecordIrrError(1000.5, env)).toBe("WITHDRAWAL_AMOUNT_NOT_INTEGER_IRR");
    expect(getWithdrawalRecordIrrError(Number.MAX_SAFE_INTEGER + 1, env)).toBe("WITHDRAWAL_AMOUNT_NOT_INTEGER_IRR");
    expect(getWithdrawalRecordIrrError(0, env)).toBe("WITHDRAWAL_AMOUNT_NOT_INTEGER_IRR");
    expect(getWithdrawalRecordIrrError(1000, env)).toBeNull();
  });

  it("does not block non-production demo workflows", () => {
    expect(getWithdrawalRecordIrrError(1000.5, {
      NODE_ENV: "development",
    })).toBeNull();
  });
});
